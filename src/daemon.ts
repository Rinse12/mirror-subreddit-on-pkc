// The mirror daemon: one process for every mirror in config.json. DRY_RUN=1 fetches and records everything in a
// separate database but publishes nothing, logging what it would publish instead.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ArcticShiftBackend } from "./backends/arctic-shift.js";
import type { LiveSource } from "./backends/live.js";
import { PullPushBackend } from "./backends/pullpush.js";
import { RedditJsonBackend } from "./backends/reddit-json.js";
import { RedlibBackend } from "./backends/redlib.js";
import { SourcePool } from "./backends/source-pool.js";
import { type Config, loadConfig, type MirrorConfig } from "./config.js";
import { StateDb } from "./db.js";
import { type Archives, Mirror, mirrorLabel, type Publisher } from "./mirror.js";
import {
    createPkc,
    ensureCommunity,
    loadSigner,
    type PkcInstance,
    publishComment,
    publishEdit,
    publishModeration,
    rpcLost
} from "./pkc.js";
import { localNodeFiles, type NodeFiles, remoteNodeFiles } from "./node-files.js";
import { sortDataPath, writeSortData } from "./sort-data.js";
import { openRpcTunnel } from "./tunnel.js";

const MINUTE = 60_000;
const TICK_MS = 15_000;
// Archived threads per backfill call; the cursor is saved after each call
const BACKFILL_BATCH = 20;
const DRY_RUN = process.env.DRY_RUN === "1";

export interface Task {
    name: string;
    // How long after a run the next one is due; for a background task, how long it rests after a run that found no work
    everyMs: number;
    // A background task has its own loop beside the round of the others, and runs back to back while it returns work
    // done (a truthy value); the database is synchronous and the sources' throttles are shared, so the two loops
    // interleave only at network waits
    background?: boolean;
    run(): Promise<unknown>;
}

export interface Scheduled {
    label: string;
    task: Task;
    nextAt: number;
}

interface LoopOptions {
    stopped: () => boolean;
    sleep: (ms: number) => Promise<void>;
    // The process can't go on: the RPC connection is lost (the client never reconnects); exit and let systemd restart
    onFatal: (reason: string) => void;
    log: (message: string) => void;
}

// A task's failure: logged and retried at its next due time, unless it says the RPC is gone, which ends the loop
function failed(entry: Scheduled, error: unknown, options: LoopOptions): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (rpcLost(error)) {
        options.onFatal(`${entry.label}: the RPC connection is lost (${message})`);
        return true;
    }
    options.log(`${entry.label} failed: ${message}`);
    return false;
}

// The round of the ordinary tasks, one at a time, each when due
export async function runTasks(scheduled: Scheduled[], options: LoopOptions): Promise<void> {
    while (!options.stopped()) {
        for (const entry of scheduled) {
            if (options.stopped() || entry.nextAt > Date.now()) continue;
            try {
                await entry.task.run();
            } catch (error) {
                if (failed(entry, error, options)) return;
            }
            entry.nextAt = Date.now() + entry.task.everyMs;
        }
        await options.sleep(TICK_MS);
    }
}

// A background task's own loop: back to back while there is work, a rest of everyMs otherwise or after a failure
export async function runBackground(entry: Scheduled, options: LoopOptions): Promise<void> {
    while (!options.stopped()) {
        let rest = true;
        try {
            rest = !(await entry.task.run());
        } catch (error) {
            if (failed(entry, error, options)) return;
        }
        if (rest) await options.sleep(entry.task.everyMs);
    }
}

function liveSources(config: Config): SourcePool<LiveSource> {
    return new SourcePool<LiveSource>([
        ...config.backends.redlib.instances.map((url) => new RedlibBackend(url)),
        new RedditJsonBackend(config.backends["reddit-json"].userAgent)
    ]);
}

function archivesOf(config: Config): Archives {
    const arctic = new ArcticShiftBackend(config.backends["arctic-shift"].baseUrl);
    const pullpush = new PullPushBackend(config.backends.pullpush.baseUrl);
    return {
        arcticComments: (subreddit, after) => arctic.listNewComments(subreddit, after),
        arcticPosts: (subreddit, after, before) => arctic.listPosts(subreddit, after, before),
        arcticThread: (postId) => arctic.listThreadComments(postId),
        arcticByIds: (ids) => arctic.fetchByIds(ids),
        arcticLabels: (ids) => arctic.removalLabels(ids),
        pullpushByIds: (ids) => pullpush.fetchByIds(ids)
    };
}

function dryRunPublisher(mirror: MirrorConfig): Publisher {
    let n = 0;
    const log = (message: string) => console.log(`[${mirrorLabel(mirror)}] dry run: ${message}`);
    return {
        async comment(c) {
            log(`would publish ${c.parentCid ? `reply under ${c.parentCid}` : `post "${c.title}"`}: ${c.content.split("\n")[0]}`);
            return `dry-run-${++n}`;
        },
        async edit(cid, content) {
            log(`would edit ${cid}: ${content.split("\n").at(-1)}`);
        },
        async moderate(cid, moderation) {
            log(`would moderate ${cid}: ${JSON.stringify(moderation)}`);
        },
        url: (cid) => `dry-run://${cid}`
    };
}

// Where a client opens a comment of the community (Seedit's scheme, the base from `clientUrl`)
export const commentUrl = (clientUrl: string, communityAddress: string, cid: string) =>
    `${clientUrl.replace(/\/$/, "")}/#/p/${communityAddress}/c/${cid}`;

async function pkcPublisher(pkc: PkcInstance, db: StateDb, nodeFiles: NodeFiles, config: Config, mirror: MirrorConfig): Promise<Publisher> {
    const signer = await loadSigner(pkc, mirror.signerPath);
    const address = await ensureCommunity(pkc, {
        address: mirror.communityAddress ?? db.mirror(mirror.name).communityAddress,
        subreddit: mirror.subreddit,
        botAddress: signer.address,
        sortsDir: nodeFiles.sortsDir,
        sortDataFile: nodeFiles.sortDataFile,
        hotSort: mirror.hotSort,
        replySort: mirror.replySort,
        publish: mirror.publish
    });
    db.updateMirror(mirror.name, { communityAddress: address });
    console.log(`[${mirrorLabel(mirror)}] mirroring into ${address} as ${signer.address}`);
    return {
        comment: (c) => publishComment(pkc, signer, address, c),
        edit: (cid, content) => publishEdit(pkc, signer, address, cid, content),
        moderate: (cid, moderation) => publishModeration(pkc, signer, address, cid, moderation),
        url: (cid) => commentUrl(config.clientUrl, address, cid)
    };
}

// The tasks of one mirror. An archive-only mirror (a banned subreddit) asks no live source: no post discovery, no
// thread re-checks, no Arctic Shift comment feed; the backfill walk is its only source.
export function tasksOf(mirror: Mirror, mirrorConfig: MirrorConfig, db: StateDb, config: Config, nodeFiles: NodeFiles): Task[] {
    const label = mirrorLabel(mirrorConfig);
    const tasks: Task[] = [
        ...(mirrorConfig.archiveOnly
            ? []
            : [
                  { name: "discover posts", everyMs: 2 * MINUTE, run: () => mirror.discoverPosts() },
                  { name: "check threads", everyMs: MINUTE, run: () => mirror.checkDuePosts(30) },
                  { name: "Arctic Shift feed", everyMs: 3 * MINUTE, run: () => mirror.readArcticFeed() }
              ]),
        { name: "skip authors", everyMs: 10 * MINUTE, run: () => mirror.skipAuthors() },
        { name: "missing text", everyMs: 30 * MINUTE, run: () => mirror.fillMissingText() },
        { name: "removal labels", everyMs: 60 * MINUTE, run: () => mirror.labelGoneComments() },
        {
            name: "publish",
            everyMs: MINUTE,
            run: async () => {
                const n = await mirror.publishPending(100);
                if (n) console.log(`[${label}] published ${n} posts and replies`);
            }
        },
        {
            name: "labels",
            everyMs: MINUTE,
            run: async () => {
                const n = await mirror.publishLabels(100);
                if (n) console.log(`[${label}] updated the flair and note of ${n} items`);
            }
        }
    ];
    if (mirrorConfig.threadSummary) tasks.push({ name: "thread summaries", everyMs: 5 * MINUTE, run: () => mirror.updateSummaries() });
    // Its own loop beside the live tasks, paced by the Arctic Shift throttle alone; idle once the cursor reached backfillSince
    if (mirrorConfig.backfillSince)
        tasks.push({ name: "backfill", everyMs: TICK_MS, background: true, run: () => mirror.backfill(BACKFILL_BATCH) });
    const address = db.mirror(mirror.key).communityAddress;
    if (address && !DRY_RUN)
        tasks.push({
            name: "sort data",
            everyMs: 5 * MINUTE,
            run: async () => {
                const file = sortDataPath(config.dataDir, address);
                await writeSortData(db, mirror.key, file);
                await nodeFiles.pushSortData(file, address);
            }
        });
    return tasks;
}

async function main() {
    const config = loadConfig();
    const db = new StateDb(path.join(config.dataDir, DRY_RUN ? "dry-run.sqlite" : "state.sqlite"));
    // A dead tunnel can't be reopened under a running pkc instance: exit, and let systemd restart the daemon
    const die = (reason: string) => {
        console.error(reason);
        process.exit(1);
    };
    const tunnel = config.rpcSshHost && !DRY_RUN ? await openRpcTunnel(config.rpcSshHost, config.rpcPort, die) : undefined;
    const nodeFiles = config.rpcSshHost ? remoteNodeFiles(config.rpcSshHost, config.nodeDir!) : localNodeFiles(config.dataDir);
    if (!DRY_RUN) await nodeFiles.pushSorts();
    const pkc = DRY_RUN ? null : await createPkc(tunnel?.rpcUrl ?? config.rpcUrl, () => die("the RPC connection is lost"));
    const live = liveSources(config);
    const archives = archivesOf(config);

    const scheduled: Scheduled[] = [];
    for (const mirrorConfig of config.mirrors) {
        const publisher = pkc ? await pkcPublisher(pkc, db, nodeFiles, config, mirrorConfig) : dryRunPublisher(mirrorConfig);
        const mirror = new Mirror(db, mirrorConfig, live, archives, publisher);
        for (const task of tasksOf(mirror, mirrorConfig, db, config, nodeFiles))
            scheduled.push({ label: `${mirrorLabel(mirrorConfig)} ${task.name}`, task, nextAt: 0 });
    }

    let stopping = false;
    const stop = () => {
        stopping = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    console.log(`running ${config.mirrors.length} mirror(s)${DRY_RUN ? " in dry-run mode" : ""}`);

    const options: LoopOptions = {
        stopped: () => stopping,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onFatal: die,
        log: (message) => console.error(message)
    };
    // One ordinary task at a time, the background ones beside them
    await Promise.all([
        runTasks(
            scheduled.filter((entry) => !entry.task.background),
            options
        ),
        ...scheduled.filter((entry) => entry.task.background).map((entry) => runBackground(entry, options))
    ]);

    console.log("stopping");
    await pkc?.destroy();
    tunnel?.close();
    db.close();
}

// Run as the entry point only: the tests import this module for its pieces
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
