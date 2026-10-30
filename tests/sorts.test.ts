import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePageSortFileFactory } from "@pkcprotocol/pkc-js/page-sorts";
import { describe, expect, it } from "vitest";
import { DEFAULT_FLAIRS } from "../sorts/flair-filter.js";
import flairedHot from "../sorts/flaired-hot.js";
import flairedReplies from "../sorts/flaired-replies.js";
import flaired from "../sorts/flaired.js";
import hot from "../sorts/hot.js";
import mirroredRedditBest from "../sorts/mirrored-reddit-best.js";
import mirroredRedditHot from "../sorts/mirrored-reddit-hot.js";
import redditNew from "../sorts/new.js";
import removedFirst from "../sorts/removed-first.js";
import { redditHot } from "../sorts/sort-data.js";

const NOW = 1793296000;
const ALL = [hot, mirroredRedditHot, redditNew, removedFirst, flaired, flairedHot, mirroredRedditBest, flairedReplies];

// Each test gets its own file: sort-data.js caches one map per path
function sortDataFile(data: Record<string, unknown>) {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "sort-data-")), "c.json");
    writeFileSync(file, JSON.stringify(data));
    return file;
}

const args = (cid: string, timestamp: number, votes = 0, flairs?: string[]) => ({
    comment: { timestamp },
    commentUpdate: {
        cid,
        upvoteCount: Math.max(votes, 0),
        downvoteCount: Math.max(-votes, 0),
        ...(flairs ? { flairs: flairs.map((text) => ({ text })) } : {})
    },
    options: { nativeWeight: "1" } as Record<string, string>,
    baseTimestamp: NOW
});

const settings = (file: string, options: Record<string, string> = {}) => ({
    pageSortSettings: { path: "x", options: { sortDataPath: file, nativeWeight: "1", ...options } }
});

describe("page sort files", () => {
    it("pass pkc-js's own validation", () => {
        const file = sortDataFile({});
        for (const factory of ALL) {
            expect(() => validatePageSortFileFactory(factory as never, { name: "x" } as never)).not.toThrow();
            expect(() => factory(settings(file) as never).validatePageSortSettings!(settings(file) as never)).not.toThrow();
        }
    });

    it("publish under the names clients ask for", () => {
        const file = sortDataFile({});
        expect(ALL.map((factory) => factory(settings(file) as never).sortName)).toEqual([
            "hot",
            "mirrored-reddit-hot",
            "new",
            "removed-first",
            "flaired",
            "hot",
            "mirrored-reddit-best",
            "flaired"
        ]);
        expect(flairedReplies(settings(file) as never)).toMatchObject({ scope: "replies", flat: true });
        expect(flaired(settings(file) as never)).toMatchObject({ scope: "posts", requireReplies: true });
    });

    it("reject a missing data path or a non-numeric weight", () => {
        const sort = hot(settings(sortDataFile({})) as never);
        expect(() => sort.validatePageSortSettings!({ pageSortSettings: { options: {} } } as never)).toThrow(/sortDataPath/);
        expect(() =>
            sort.validatePageSortSettings!({ pageSortSettings: { options: { sortDataPath: "f", nativeWeight: "x" } } } as never)
        ).toThrow(/nativeWeight/);
    });
});

describe("hot", () => {
    it("ranks by Reddit score and Reddit time, and native posts by their own votes and time", () => {
        const file = sortDataFile({
            QmPopular: { score: 900, createdUtc: NOW - 3600, status: "up" },
            QmQuiet: { score: 2, createdUtc: NOW - 3600, status: "up" },
            QmOld: { score: 900, createdUtc: NOW - 5 * 86400, status: "up" }
        });
        const { score } = hot(settings(file) as never);
        const order = [args("QmQuiet", NOW), args("QmOld", NOW), args("QmPopular", NOW), args("QmNative", NOW - 60, 3)]
            .sort((a, b) => (score(b as never) as number) - (score(a as never) as number))
            .map((a) => a.commentUpdate.cid);
        expect(order).toEqual(["QmPopular", "QmNative", "QmQuiet", "QmOld"]);
        expect(score(args("QmNative", NOW, 9) as never)).toBeCloseTo(redditHot(9, NOW));
        expect(mirroredRedditHot(settings(file) as never).score(args("QmPopular", NOW) as never)).toBe(
            score(args("QmPopular", NOW) as never)
        );
    });
});

describe("new", () => {
    it("uses Reddit's creation time, not the publish time", () => {
        const { score } = redditNew(settings(sortDataFile({ QmA: { score: 1, createdUtc: NOW - 7200, status: "up" } })) as never);
        expect(score(args("QmA", NOW) as never)).toBe(NOW - 7200);
        expect(score(args("QmNative", NOW - 60) as never)).toBe(NOW - 60);
    });
});

describe("removed-first", () => {
    it("puts posts removed on Reddit first, even unpopular ones", () => {
        const { score } = removedFirst(
            settings(
                sortDataFile({
                    QmUp: { score: 5000, createdUtc: NOW, status: "up" },
                    QmRemoved: { score: 1, createdUtc: NOW - 86400, status: "removed", removedBy: "moderator" },
                    QmDeleted: { score: 1, createdUtc: NOW, status: "deleted", removedBy: "deleted" }
                })
            ) as never
        );
        const s = (cid: string) => score(args(cid, NOW) as never) as number;
        expect(s("QmRemoved")).toBeGreaterThan(s("QmUp"));
        expect(s("QmDeleted")).toBeLessThan(s("QmUp"));
    });
});

describe("flaired (posts)", () => {
    const MODS = "Removed by mods on Reddit";
    const reply = (cid: string, flairs?: string[]) => ({
        comment: { timestamp: NOW },
        commentUpdate: args(cid, NOW, 0, flairs).commentUpdate
    });
    const file = () =>
        sortDataFile({
            QmPost: { score: 10, createdUtc: NOW - 86400, status: "up", flairedAt: null },
            QmGonePost: { score: 10, createdUtc: NOW - 3 * 86400, status: "removed", removedBy: "moderator", flairedAt: NOW - 2 * 86400 },
            QmGoneReply: { score: 3, createdUtc: NOW - 7200, status: "removed", removedBy: "gone", flairedAt: NOW - 3600 },
            QmOlderGoneReply: { score: 3, createdUtc: NOW - 7200, status: "removed", removedBy: "gone", flairedAt: NOW - 5 * 86400 }
        });

    it("declines posts that neither carry a flair nor have a flaired reply", () => {
        const { score } = flaired(settings(file()) as never);
        expect(score({ ...args("QmPost", NOW), replies: [reply("QmUp"), reply("QmOther", ["Something else"])] } as never)).toBeNull();
        expect(score({ ...args("QmNative", NOW), replies: [] } as never)).toBeNull();
    });

    it("keeps flaired posts and posts with a flaired reply, most recently flaired first", () => {
        const { score } = flaired(settings(file()) as never);
        const s = (a: unknown) => score(a as never) as number;
        // The reply's removal is the latest thing that happened to the thread
        expect(s({ ...args("QmPost", NOW), replies: [reply("QmUp"), reply("QmGoneReply", ["Removed or deleted on Reddit"])] })).toBe(
            NOW - 3600
        );
        expect(s({ ...args("QmGonePost", NOW, 0, [MODS]), replies: [reply("QmOlderGoneReply", ["Removed on Reddit"])] })).toBe(
            NOW - 2 * 86400
        );
        // A flaired native post has no sort data: its own time stands in
        expect(s({ ...args("QmNative", NOW - 10, 0, [MODS]), replies: [] })).toBe(NOW - 10);
    });

    it("takes the flairs to match and the order from its options", () => {
        const { score } = flaired(settings(file(), { flairs: "Removed by Reddit admins", order: "new" }) as never);
        expect(
            score({ ...args("QmGonePost", NOW, 0, [MODS]), options: { flairs: "Removed by Reddit admins" }, replies: [] } as never)
        ).toBeNull();
        expect(
            score({
                ...args("QmGonePost", NOW, 0, ["Removed by Reddit admins"]),
                options: { flairs: "Removed by Reddit admins", order: "new" },
                replies: []
            } as never)
        ).toBe(NOW - 3 * 86400);
        // Only a mod flair counts; the defaults leave author deletions and locks out
        expect(DEFAULT_FLAIRS).not.toContain("Deleted by author on Reddit");
        expect(score({ ...args("QmPost", NOW, 0, ["Deleted by author on Reddit"]), replies: [] } as never)).toBeNull();
    });

    it("is also published as hot, and rejects a bad order or an empty flair list", () => {
        const sort = flairedHot(settings(file()) as never);
        expect(sort.sortName).toBe("hot");
        expect(() => sort.validatePageSortSettings!({ pageSortSettings: { options: { order: "hot" } } } as never)).toThrow(/order/);
        expect(() => sort.validatePageSortSettings!({ pageSortSettings: { options: { flairs: " , " } } } as never)).toThrow(/flairs/);
        // No sort data at all is fine: a community that isn't a mirror can still filter by flair
        expect(() => sort.validatePageSortSettings!({ pageSortSettings: { options: {} } } as never)).not.toThrow();
    });
});

describe("flaired (replies)", () => {
    it("declines replies without one of the flairs and ranks the rest like mirrored-reddit-best", () => {
        const file = sortDataFile({
            QmA: { score: 10, createdUtc: NOW - 100, status: "removed", removedBy: "removed", flairedAt: NOW },
            QmB: { score: 10, createdUtc: NOW - 50, status: "removed", removedBy: "removed", flairedAt: NOW },
            QmUp: { score: 100, createdUtc: NOW - 50, status: "up", flairedAt: null }
        });
        const { score } = flairedReplies(settings(file) as never);
        const best = mirroredRedditBest(settings(file) as never).score;
        expect(score(args("QmUp", NOW) as never)).toBeNull();
        expect(score(args("QmA", NOW, 0, ["Removed on Reddit"]) as never)).toBe(best(args("QmA", NOW) as never));
        expect(score(args("QmA", NOW, 0, ["Removed on Reddit"]) as never) as number).toBeGreaterThan(
            score(args("QmB", NOW, 0, ["Removed on Reddit"]) as never) as number
        );
        expect(score(args("QmNative", NOW, 2, ["Removed by mods on Reddit"]) as never) as number).toBeCloseTo(2 - NOW / 1e10);
    });
});

describe("mirrored-reddit-best", () => {
    it("ranks replies by Reddit score plus native votes, older first on a tie", () => {
        const { score } = mirroredRedditBest(
            settings(
                sortDataFile({
                    QmA: { score: 10, createdUtc: NOW - 100, status: "up" },
                    QmB: { score: 10, createdUtc: NOW - 50, status: "up" },
                    QmC: { score: 9, createdUtc: NOW - 200, status: "up" }
                })
            ) as never
        );
        const s = (cid: string, votes = 0) => score(args(cid, NOW, votes) as never) as number;
        expect(s("QmA")).toBeGreaterThan(s("QmB"));
        expect(s("QmB")).toBeGreaterThan(s("QmC"));
        expect(s("QmC", 2)).toBeGreaterThan(s("QmA"));
    });
});
