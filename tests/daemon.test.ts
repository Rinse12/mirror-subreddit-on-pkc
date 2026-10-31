import { describe, expect, it } from "vitest";
import type { LiveSource } from "../src/backends/live.js";
import { SourcePool } from "../src/backends/source-pool.js";
import { parseConfig } from "../src/config.js";
import { runBackground, runTasks, type Scheduled, tasksOf } from "../src/daemon.js";
import { StateDb } from "../src/db.js";
import { type Archives, Mirror, type Publisher } from "../src/mirror.js";
import type { NodeFiles } from "../src/node-files.js";
import { rpcLost } from "../src/pkc.js";

// What pkc-js throws once the RPC server went away under a running client (the node's bitsocial service restarted)
const rpcError = Object.assign(new Error("Failed to open connection to RPC"), { code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" });

const scheduled = (run: () => Promise<unknown>, everyMs = 0): Scheduled => ({
    label: "r/x t",
    task: { name: "t", everyMs, run },
    nextAt: 0
});

describe("rpcLost", () => {
    it("recognises the lost RPC connection and nothing else", () => {
        expect(rpcLost(rpcError)).toBe(true);
        expect(rpcLost(new Error("Failed to open connection to RPC"))).toBe(false);
        expect(rpcLost(new Error("HTTP 503"))).toBe(false);
        expect(rpcLost(null)).toBe(false);
    });
});

describe("runTasks", () => {
    it("logs an ordinary failure and goes on, and ends with a fatal reason once the RPC connection is lost", async () => {
        let runs = 0;
        let ticks = 0;
        const fatal: string[] = [];
        const logged: string[] = [];
        await runTasks(
            [
                scheduled(async () => {
                    runs++;
                    if (runs === 1) throw new Error("HTTP 503");
                    if (runs === 3) throw rpcError;
                })
            ],
            {
                stopped: () => ticks >= 10,
                sleep: async () => void ticks++,
                onFatal: (reason) => fatal.push(reason),
                log: (message) => logged.push(message)
            }
        );
        expect(runs).toBe(3);
        expect(logged).toEqual(["r/x t failed: HTTP 503"]);
        expect(fatal).toEqual(["r/x t: the RPC connection is lost (Failed to open connection to RPC)"]);
    });
});

describe("runBackground", () => {
    it("runs a task back to back while it reports work, waits a period when it reports none, and dies with the RPC", async () => {
        let calls = 0;
        const sleeps: number[] = [];
        await runBackground(
            scheduled(async () => {
                calls++;
                return calls < 3 ? 1 : 0;
            }, 15_000),
            { stopped: () => sleeps.length >= 2, sleep: async (ms) => void sleeps.push(ms), onFatal: () => {}, log: () => {} }
        );
        expect(calls).toBe(4);
        expect(sleeps).toEqual([15_000, 15_000]);

        const fatal: string[] = [];
        const logged: string[] = [];
        let failures = 0;
        await runBackground(
            scheduled(async () => {
                failures++;
                throw failures === 1 ? new Error("Arctic Shift: HTTP 503") : rpcError;
            }, 15_000),
            { stopped: () => false, sleep: async () => {}, onFatal: (reason) => fatal.push(reason), log: (message) => logged.push(message) }
        );
        expect(failures).toBe(2);
        expect(logged).toEqual(["r/x t failed: Arctic Shift: HTTP 503"]);
        expect(fatal).toEqual(["r/x t: the RPC connection is lost (Failed to open connection to RPC)"]);
    });
});

describe("tasksOf", () => {
    const nodeFiles: NodeFiles = {
        sortsDir: "/sorts",
        sortDataFile: (address) => `/sort-data/${address}.json`,
        pushSorts: async () => {},
        pushSortData: async () => {}
    };
    const archives: Archives = {
        arcticComments: async () => [],
        arcticPosts: async () => [],
        arcticThread: async () => [],
        arcticByIds: async () => [],
        arcticLabels: async () => new Map(),
        pullpushByIds: async () => []
    };
    const publisher: Publisher = {
        comment: async () => "Qm1",
        edit: async () => {},
        moderate: async () => {},
        url: (cid) => cid
    };
    const tasks = (mirrorConfig: Record<string, unknown>) => {
        const config = parseConfig({ mirrors: [{ subreddit: "AskHistorians", signerPath: "s.json", ...mirrorConfig }] });
        const db = new StateDb(":memory:");
        const mirror = new Mirror(db, config.mirrors[0], new SourcePool<LiveSource>([]), archives, publisher);
        return tasksOf(mirror, config.mirrors[0], db, config, nodeFiles);
    };

    it("runs the backfill walk in the background, beside the live tasks, only when backfillSince is set", () => {
        const backfill = tasks({ backfillSince: "2023-07-01T00:00:00Z" }).find((task) => task.name === "backfill");
        expect(backfill).toMatchObject({ background: true });
        expect(backfill!.everyMs).toBeGreaterThan(0);
        expect(tasks({}).find((task) => task.name === "backfill")).toBeUndefined();
        expect(tasks({}).filter((task) => task.background)).toEqual([]);
    });
});
