// The mirror daemon: one process for every mirror in config.json. DRY_RUN=1 fetches and records everything in a
// separate database but publishes nothing, logging what it would publish instead.
import path from "node:path";
import { ArcticShiftBackend } from "./backends/arctic-shift.js";
import type { LiveSource } from "./backends/live.js";
import { PullPushBackend } from "./backends/pullpush.js";
import { RedditJsonBackend } from "./backends/reddit-json.js";
import { RedlibBackend } from "./backends/redlib.js";
import { SourcePool } from "./backends/source-pool.js";
import { type Config, loadConfig, type MirrorConfig } from "./config.js";
import { StateDb } from "./db.js";
import { type Archives, Mirror, type Publisher } from "./mirror.js";
import { createPkc, ensureCommunity, loadSigner, type PkcInstance, publishComment, publishEdit, publishModeration } from "./pkc.js";
import { localNodeFiles, type NodeFiles, remoteNodeFiles } from "./node-files.js";
import { sortDataPath, writeSortData } from "./sort-data.js";
import { openRpcTunnel } from "./tunnel.js";

const MINUTE = 60_000;
const TICK_MS = 15_000;
const DRY_RUN = process.env.DRY_RUN === "1";

interface Task {
    name: string;
    everyMs: number;
    run(): Promise<unknown>;
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

function dryRunPublisher(subreddit: string): Publisher {
    let n = 0;
    const log = (message: string) => console.log(`[r/${subreddit}] dry run: ${message}`);
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
        }
    };
}

async function pkcPublisher(pkc: PkcInstance, db: StateDb, nodeFiles: NodeFiles, mirror: MirrorConfig): Promise<Publisher> {
    const signer = await loadSigner(pkc, mirror.signerPath);
    const address = await ensureCommunity(pkc, {
        address: mirror.communityAddress ?? db.mirror(mirror.subreddit).communityAddress,
        subreddit: mirror.subreddit,
        botAddress: signer.address,
        sortsDir: nodeFiles.sortsDir,
        sortDataFile: nodeFiles.sortDataFile,
        hotSort: mirror.hotSort
    });
    db.updateMirror(mirror.subreddit, { communityAddress: address });
    console.log(`[r/${mirror.subreddit}] mirroring into ${address} as ${signer.address}`);
    return {
        comment: (c) => publishComment(pkc, signer, address, c),
        edit: (cid, content) => publishEdit(pkc, signer, address, cid, content),
        moderate: (cid, moderation) => publishModeration(pkc, signer, address, cid, moderation)
    };
}

function tasksOf(mirror: Mirror, mirrorConfig: MirrorConfig, db: StateDb, config: Config, nodeFiles: NodeFiles): Task[] {
    const tasks: Task[] = [
        { name: "discover posts", everyMs: 2 * MINUTE, run: () => mirror.discoverPosts() },
        { name: "check threads", everyMs: MINUTE, run: () => mirror.checkDuePosts(30) },
        { name: "Arctic Shift feed", everyMs: 3 * MINUTE, run: () => mirror.readArcticFeed() },
        { name: "skip authors", everyMs: 10 * MINUTE, run: () => mirror.skipAuthors() },
        { name: "missing text", everyMs: 30 * MINUTE, run: () => mirror.fillMissingText() },
        { name: "removal labels", everyMs: 60 * MINUTE, run: () => mirror.labelGoneComments() },
        {
            name: "publish",
            everyMs: MINUTE,
            run: async () => {
                const n = await mirror.publishPending(100);
                if (n) console.log(`[r/${mirror.subreddit}] published ${n} posts and replies`);
            }
        },
        {
            name: "labels",
            everyMs: MINUTE,
            run: async () => {
                const n = await mirror.publishLabels(100);
                if (n) console.log(`[r/${mirror.subreddit}] updated the flair and note of ${n} items`);
            }
        }
    ];
    // A few archived threads per tick, between the live tasks; a no-op once the cursor reached backfillSince
    if (mirrorConfig.backfillSince) tasks.push({ name: "backfill", everyMs: 0, run: () => mirror.backfill(5) });
    const address = db.mirror(mirror.subreddit).communityAddress;
    if (address && !DRY_RUN)
        tasks.push({
            name: "sort data",
            everyMs: 5 * MINUTE,
            run: async () => {
                const file = sortDataPath(config.dataDir, address);
                await writeSortData(db, mirror.subreddit, file);
                await nodeFiles.pushSortData(file, address);
            }
        });
    return tasks;
}

async function main() {
    const config = loadConfig();
    const db = new StateDb(path.join(config.dataDir, DRY_RUN ? "dry-run.sqlite" : "state.sqlite"));
    // A dead tunnel can't be reopened under a running pkc instance: exit, and let systemd restart the daemon
    const tunnel =
        config.rpcSshHost && !DRY_RUN
            ? await openRpcTunnel(config.rpcSshHost, config.rpcPort, (reason) => {
                  console.error(reason);
                  process.exit(1);
              })
            : undefined;
    const nodeFiles = config.rpcSshHost ? remoteNodeFiles(config.rpcSshHost, config.nodeDir!) : localNodeFiles(config.dataDir);
    if (!DRY_RUN) await nodeFiles.pushSorts();
    const pkc = DRY_RUN ? null : await createPkc(tunnel?.rpcUrl ?? config.rpcUrl);
    const live = liveSources(config);
    const archives = archivesOf(config);

    const scheduled: { label: string; task: Task; nextAt: number }[] = [];
    for (const mirrorConfig of config.mirrors) {
        const publisher = pkc ? await pkcPublisher(pkc, db, nodeFiles, mirrorConfig) : dryRunPublisher(mirrorConfig.subreddit);
        const mirror = new Mirror(db, mirrorConfig, live, archives, publisher);
        for (const task of tasksOf(mirror, mirrorConfig, db, config, nodeFiles))
            scheduled.push({ label: `r/${mirrorConfig.subreddit} ${task.name}`, task, nextAt: 0 });
    }

    let stopping = false;
    const stop = () => {
        stopping = true;
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    console.log(`running ${config.mirrors.length} mirror(s)${DRY_RUN ? " in dry-run mode" : ""}`);

    // One task at a time: the database and the sources' throttles are shared
    while (!stopping) {
        for (const entry of scheduled) {
            if (stopping || entry.nextAt > Date.now()) continue;
            try {
                await entry.task.run();
            } catch (error) {
                console.error(`${entry.label} failed:`, error instanceof Error ? error.message : error);
            }
            entry.nextAt = Date.now() + entry.task.everyMs;
        }
        await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    }

    console.log("stopping");
    await pkc?.destroy();
    tunnel?.close();
    db.close();
}

await main();
