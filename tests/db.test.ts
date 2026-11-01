import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Item, StateDb } from "../src/db.js";
import { nextCheckAt, recheckIntervalSeconds } from "../src/schedule.js";

const HOUR = 3600;
const DAY = 24 * HOUR;

const item = (overrides: Partial<Item> = {}): Item => ({
    mirror: "AskHistorians",
    redditId: "t3_1xfd707",
    kind: "post",
    postId: "t3_1xfd707",
    parentId: null,
    author: "someone",
    createdUtc: 1000,
    title: "A question",
    body: "text",
    link: null,
    permalink: "/r/AskHistorians/comments/1xfd707/a_question/",
    score: 1,
    numComments: 0,
    status: "up",
    removedBy: null,
    lastSeenUpAt: 1000,
    goneSeenAt: null,
    nextCheckAt: 1600,
    textLookups: 0,
    labelLookups: 0,
    labelCheckedAt: null,
    cid: null,
    publishStatus: "pending",
    publishError: null,
    publishedLabel: null,
    origin: "live",
    source: "redlib http://redlib.test",
    summaryCid: null,
    summaryText: null,
    ...overrides
});

const comment = (id: string, parentId: string, createdUtc: number) =>
    item({ redditId: id, kind: "comment", parentId, createdUtc, title: null, numComments: null, nextCheckAt: null });

let db: StateDb;
afterEach(() => db?.close());

describe("StateDb", () => {
    it("only offers a reply once its parent is published, oldest first", () => {
        db = new StateDb(":memory:");
        db.insert(item());
        db.insert(comment("t1_19ru7in2lzy9v", "t3_1xfd707", 1200));
        db.insert(comment("t1_b", "t1_19ru7in2lzy9v", 1100));
        expect(db.publishable("AskHistorians", 10).map((i) => i.redditId)).toEqual(["t3_1xfd707"]);
        db.update("AskHistorians", "t3_1xfd707", { publishStatus: "published", cid: "Qm1" });
        expect(db.publishable("AskHistorians", 10).map((i) => i.redditId)).toEqual(["t1_19ru7in2lzy9v"]);
    });

    it("publishes live items before backfilled ones, and history newest first", () => {
        db = new StateDb(":memory:");
        db.insert(item({ redditId: "t3_old", postId: "t3_old", createdUtc: 100, origin: "archive" }));
        db.insert(item({ redditId: "t3_older", postId: "t3_older", createdUtc: 50, origin: "archive" }));
        db.insert(item({ redditId: "t3_live", postId: "t3_live", createdUtc: 5000 }));
        db.insert(item({ redditId: "t3_live_first", postId: "t3_live_first", createdUtc: 4000 }));
        expect(db.publishable("AskHistorians", 10).map((i) => i.redditId)).toEqual(["t3_live_first", "t3_live", "t3_old", "t3_older"]);
    });

    it("adds the columns a database from before backfill lacks, and keys old rows by the mirror's name", () => {
        const file = path.join(mkdtempSync(path.join(os.tmpdir(), "state-")), "state.sqlite");
        const old = new Database(file);
        old.exec(`CREATE TABLE items (subreddit TEXT NOT NULL, redditId TEXT NOT NULL, kind TEXT NOT NULL, postId TEXT NOT NULL, parentId TEXT,
            author TEXT NOT NULL, createdUtc INTEGER NOT NULL, title TEXT, body TEXT, link TEXT, permalink TEXT NOT NULL, score INTEGER,
            numComments INTEGER, status TEXT NOT NULL, removedBy TEXT, lastSeenUpAt INTEGER NOT NULL, goneSeenAt INTEGER, nextCheckAt INTEGER,
            textLookups INTEGER NOT NULL DEFAULT 0, labelLookups INTEGER NOT NULL DEFAULT 0, labelCheckedAt INTEGER, cid TEXT UNIQUE,
            publishStatus TEXT NOT NULL DEFAULT 'pending', publishError TEXT, publishedLabel TEXT, origin TEXT NOT NULL DEFAULT 'live',
            PRIMARY KEY (subreddit, redditId));
            CREATE TABLE mirrors (subreddit TEXT PRIMARY KEY, communityAddress TEXT, authorFlairSet INTEGER NOT NULL DEFAULT 0, arcticCursor INTEGER NOT NULL DEFAULT 0);
            INSERT INTO items (subreddit, redditId, kind, postId, author, createdUtc, permalink, status, lastSeenUpAt)
            VALUES ('AskHistorians', 't3_a', 'post', 't3_a', 'x', 1, '/r/a', 'up', 1);
            INSERT INTO items (subreddit, redditId, kind, postId, author, createdUtc, permalink, status, lastSeenUpAt, origin)
            VALUES ('AskHistorians', 't3_b', 'post', 't3_b', 'x', 1, '/r/b', 'up', 1, 'archive');`);
        old.close();
        db = new StateDb(file);
        expect(db.get("AskHistorians", "t3_a")).toMatchObject({ mirror: "AskHistorians", origin: "live", summaryCid: null });
        // Which live source saw an old row is unknown; an archived row can only have come from the backfill walk
        expect(db.get("AskHistorians", "t3_a")!.source).toBeNull();
        expect(db.get("AskHistorians", "t3_b")!.source).toBe("arctic-walk");
        expect(db.mirror("AskHistorians").backfillCursor).toBeNull();
        // Opening it again finds nothing left to migrate
        db.close();
        db = new StateDb(file);
        expect(db.get("AskHistorians", "t3_a")).toBeDefined();
    });

    describe("publishable on a removed-only mirror", () => {
        // post > a (up) > b (removed) > c (up) > d (removed); e (up) under the post; f (deleted by its author)
        const thread = () => {
            db = new StateDb(":memory:");
            db.insert(item());
            db.insert(comment("t1_a", "t3_1xfd707", 1100));
            db.insert({ ...comment("t1_b", "t1_a", 1200), status: "removed", removedBy: "gone" });
            db.insert(comment("t1_c", "t1_b", 1300));
            db.insert({ ...comment("t1_d", "t1_c", 1400), status: "removed", removedBy: "moderator" });
            db.insert(comment("t1_e", "t3_1xfd707", 1500));
            db.insert({ ...comment("t1_f", "t3_1xfd707", 1600), status: "deleted", removedBy: "deleted" });
        };
        const ids = (filter: Parameters<StateDb["publishable"]>[2]) => db.publishable("AskHistorians", 10, filter).map((i) => i.redditId);
        const published = (id: string) => db.update("AskHistorians", id, { publishStatus: "published", cid: `Qm_${id}` });

        it("offers the removed items and, with context ancestors, the chain of parents above them", () => {
            thread();
            expect(ids({ context: "ancestors" })).toEqual(["t3_1xfd707"]);
            published("t3_1xfd707");
            expect(ids({ context: "ancestors" })).toEqual(["t1_a"]);
            published("t1_a");
            expect(ids({ context: "ancestors" })).toEqual(["t1_b"]);
            published("t1_b");
            published("t1_c");
            expect(ids({ context: "ancestors" })).toEqual(["t1_d"]);
        });

        it("with context post offers a removed reply as soon as its post is out, skipping the parents", () => {
            thread();
            published("t3_1xfd707");
            expect(ids({ context: "post" })).toEqual(["t1_b", "t1_d"]);
        });

        it("offers a post without removals only on a full mirror", () => {
            db = new StateDb(":memory:");
            db.insert(item());
            db.insert({ ...comment("t1_f", "t3_1xfd707", 1600), status: "deleted", removedBy: "deleted" });
            expect(ids({ context: "ancestors" })).toEqual([]);
            expect(ids(null)).toEqual(["t3_1xfd707"]);
        });
    });

    it("lists the published posts that have a removed reply or a summary to retire", () => {
        db = new StateDb(":memory:");
        db.insert(item({ publishStatus: "published", cid: "Qm1" }));
        db.insert(item({ redditId: "t3_quiet", postId: "t3_quiet", publishStatus: "published", cid: "Qm2" }));
        db.insert(
            item({
                redditId: "t3_retired",
                postId: "t3_retired",
                publishStatus: "published",
                cid: "Qm3",
                summaryCid: "Qm4",
                summaryText: "x"
            })
        );
        db.insert({ ...comment("t1_a", "t3_1xfd707", 1100), status: "removed", removedBy: "gone" });
        expect(db.postsForSummary("AskHistorians").map((p) => p.redditId)).toEqual(["t3_1xfd707", "t3_retired"]);
        db.unpublishThread("AskHistorians", "t3_retired");
        expect(db.get("AskHistorians", "t3_retired")).toMatchObject({ publishStatus: "pending", summaryCid: null, summaryText: null });
    });

    it("lists labels not yet shown, skipping unconfirmed missing items", () => {
        db = new StateDb(":memory:");
        db.insert(item({ publishStatus: "published", cid: "Qm1", publishedLabel: "up:", status: "removed", removedBy: "moderator" }));
        db.insert({
            ...comment("t1_a", "t3_1xfd707", 1100),
            publishStatus: "published",
            cid: "Qm2",
            publishedLabel: "up:",
            status: "missing"
        });
        db.insert({
            ...comment("t1_b", "t3_1xfd707", 1100),
            publishStatus: "published",
            cid: "Qm3",
            publishedLabel: "removed:gone",
            status: "removed",
            removedBy: "gone"
        });
        expect(db.labelsToPublish("AskHistorians", 10).map((i) => i.redditId)).toEqual(["t3_1xfd707"]);
    });

    it("keeps one row of state per mirror", () => {
        db = new StateDb(":memory:");
        expect(db.mirror("AskHistorians")).toEqual({
            name: "AskHistorians",
            communityAddress: null,
            authorFlairSet: 0,
            arcticCursor: 0,
            backfillCursor: null
        });
        db.updateMirror("AskHistorians", { communityAddress: "12D3KooW", arcticCursor: 5 });
        expect(db.mirror("AskHistorians")).toMatchObject({ communityAddress: "12D3KooW", arcticCursor: 5 });
    });
});

describe("re-check schedule", () => {
    it("slows down with age", () => {
        expect(recheckIntervalSeconds(HOUR)).toBe(600);
        expect(recheckIntervalSeconds(DAY)).toBe(HOUR);
        expect(recheckIntervalSeconds(3 * DAY)).toBe(DAY);
    });

    it("stops after commentUpdateDays", () => {
        expect(nextCheckAt(0, 6 * DAY, 7)).toBe(7 * DAY);
        expect(nextCheckAt(0, 6.5 * DAY, 7)).toBeNull();
    });
});
