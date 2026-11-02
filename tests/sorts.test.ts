import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePageSortFileFactory } from "@pkcprotocol/pkc-js/page-sorts";
import { describe, expect, it } from "vitest";
import hot from "../sorts/hot.js";
import mirroredRedditBest from "../sorts/mirrored-reddit-best.js";
import mirroredRedditHot from "../sorts/mirrored-reddit-hot.js";
import redditNew from "../sorts/new.js";
import removedFirst from "../sorts/removed-first.js";
import { redditHot } from "../sorts/sort-data.js";
import { REMOVAL_FLAIRS, statusFlair } from "../src/content.js";
import flairPageSort, { FLAIRS_OPTION, validatePageSortSettings } from "@pkcprotocol/flair-page-sort";

const NOW = 1793296000;
const ALL = [hot, mirroredRedditHot, redditNew, removedFirst, mirroredRedditBest];

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
            "mirrored-reddit-best"
        ]);
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

describe("the flair filter pages", () => {
    it("are told every removal flair the mirror sets, and no other", () => {
        const removed = (["moderator", "automod_filtered", "reddit", "anti_evil_ops", "gone", "unknown"] as const).map(
            (removedBy) => statusFlair({ status: "removed", removedBy, kind: "comment" })!.text
        );
        expect(new Set(removed)).toEqual(new Set(REMOVAL_FLAIRS));
        expect(REMOVAL_FLAIRS).not.toContain(statusFlair({ status: "deleted", removedBy: null, kind: "comment" })!.text);
        expect(REMOVAL_FLAIRS).not.toContain(statusFlair({ status: "locked", removedBy: null, kind: "post" })!.text);
        // The package takes the list as its flairs option
        const options = { [FLAIRS_OPTION]: REMOVAL_FLAIRS.join(","), sortDataPath: sortDataFile({}) };
        expect(() => validatePageSortSettings({ pageSortSettings: { name: "x", options } })).not.toThrow();
        expect(flairPageSort({ pageSortSettings: { name: "x", options: { ...options, sortName: "hot" } } }).sortName).toBe("hot");
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
