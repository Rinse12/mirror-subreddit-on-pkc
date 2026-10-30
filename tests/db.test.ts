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
            arcticCursor: 0
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
