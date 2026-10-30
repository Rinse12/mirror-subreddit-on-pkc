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
    subreddit: "AskHistorians",
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

    it("adds the columns a database from before backfill lacks", () => {
        const file = path.join(mkdtempSync(path.join(os.tmpdir(), "state-")), "state.sqlite");
        const old = new Database(file);
        old.exec(`CREATE TABLE items (subreddit TEXT NOT NULL, redditId TEXT NOT NULL, kind TEXT NOT NULL, postId TEXT NOT NULL, parentId TEXT,
            author TEXT NOT NULL, createdUtc INTEGER NOT NULL, title TEXT, body TEXT, link TEXT, permalink TEXT NOT NULL, score INTEGER,
            numComments INTEGER, status TEXT NOT NULL, removedBy TEXT, lastSeenUpAt INTEGER NOT NULL, goneSeenAt INTEGER, nextCheckAt INTEGER,
            textLookups INTEGER NOT NULL DEFAULT 0, labelLookups INTEGER NOT NULL DEFAULT 0, labelCheckedAt INTEGER, cid TEXT UNIQUE,
            publishStatus TEXT NOT NULL DEFAULT 'pending', publishError TEXT, publishedLabel TEXT, PRIMARY KEY (subreddit, redditId));
            CREATE TABLE mirrors (subreddit TEXT PRIMARY KEY, communityAddress TEXT, authorFlairSet INTEGER NOT NULL DEFAULT 0, arcticCursor INTEGER NOT NULL DEFAULT 0);
            INSERT INTO items (subreddit, redditId, kind, postId, author, createdUtc, permalink, status, lastSeenUpAt)
            VALUES ('AskHistorians', 't3_a', 'post', 't3_a', 'x', 1, '/r/a', 'up', 1);`);
        old.close();
        db = new StateDb(file);
        expect(db.get("AskHistorians", "t3_a")).toMatchObject({ origin: "live" });
        expect(db.mirror("AskHistorians").backfillCursor).toBeNull();
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
            subreddit: "AskHistorians",
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
