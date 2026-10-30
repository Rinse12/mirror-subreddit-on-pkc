import { describe, expect, it } from "vitest";
import {
    archiveNote,
    formatDuration,
    mirroredAuthor,
    mirroredContent,
    removalNote,
    statusFlair,
    SUMMARY_LIST_LIMIT,
    threadSummary
} from "../src/content.js";

const T = Date.UTC(2026, 9, 29, 11, 0, 0) / 1000;
const item = {
    author: "someone",
    createdUtc: T,
    permalink: "/r/AskHistorians/comments/1xir51b/did_the_picts/",
    body: "Hi friends.",
    kind: "post" as const,
    status: "removed" as const,
    removedBy: "moderator",
    lastSeenUpAt: T + 3 * 3600,
    goneSeenAt: T + 3 * 3600 + 600,
    score: 12 as number | null,
    numComments: 34 as number | null,
    origin: "live" as const
};

describe("content", () => {
    it("is the Reddit text alone, with the Reddit user as display name", () => {
        expect(mirroredAuthor(item)).toEqual({ displayName: "u/someone" });
        expect(mirroredContent(item)).toBe("Hi friends.");
        expect(mirroredContent({ ...item, body: null })).toMatch(/text not captured/);
    });

    it("writes the removal window, the time since posting and the last numbers", () => {
        expect(removalNote(item)).toBe(
            "\n\n---\n\n*Removed by moderators on Reddit between 2026-10-29 14:00 and 14:10 UTC, 3 h to 3 h 10 min after posting. Last seen with score 12, 34 comments.*"
        );
    });

    it("says where a backfilled item came from, with the archive's two reads as its window", () => {
        expect(removalNote({ ...item, origin: "archive", lastSeenUpAt: T + 600, goneSeenAt: T + 36 * 3600 + 600 })).toBe(
            "\n\n---\n\n*Mirrored from the Arctic Shift archive. Removed by moderators on Reddit between 2026-10-29 11:10 and 2026-10-30 23:10 UTC, 10 min to 1 d 12 h after posting. Last seen with score 12, 34 comments.*"
        );
        expect(archiveNote()).toBe("\n\n---\n\n*Mirrored from the Arctic Shift archive.*");
    });

    it("says 'within' when the item was already gone at the first sighting", () => {
        expect(removalNote({ ...item, lastSeenUpAt: T, goneSeenAt: T + 20, numComments: null, score: null })).toBe(
            "\n\n---\n\n*Removed by moderators on Reddit between 2026-10-29 11:00 and 11:00 UTC, within 1 min of posting.*"
        );
        expect(removalNote({ ...item, lastSeenUpAt: T, goneSeenAt: T + 7200, numComments: null, score: null })).toMatch(
            /within 2 h of posting/
        );
    });

    it("words a vanished comment as removed or deleted", () => {
        const note = removalNote({ ...item, kind: "comment", removedBy: "gone", numComments: null, score: null });
        expect(note).toMatch(/^\n\n---\n\n\*Removed or deleted on Reddit between .* after posting\.\*$/);
    });

    it("picks the flair from the most precise label", () => {
        expect(statusFlair(item)).toEqual({ text: "Removed by mods on Reddit" });
        expect(statusFlair({ ...item, removedBy: "anti_evil_ops" })).toEqual({ text: "Removed by Reddit admins" });
        expect(statusFlair({ ...item, removedBy: "removed" })).toEqual({ text: "Removed on Reddit" });
        expect(statusFlair({ ...item, removedBy: "gone" })).toEqual({ text: "Removed or deleted on Reddit" });
        expect(statusFlair({ ...item, status: "deleted" })).toEqual({ text: "Deleted by author on Reddit" });
        expect(statusFlair({ ...item, status: "locked" })).toEqual({ text: "Locked on Reddit" });
        expect(statusFlair({ ...item, status: "missing" })).toBeNull();
    });

    describe("thread summary", () => {
        const url = (cid: string) => `https://seedit.app/#/p/c.bso/c/${cid}`;
        const reply = (author: string, o: Partial<Parameters<typeof threadSummary>[1][number]> = {}) => ({
            ...item,
            kind: "comment" as const,
            author,
            cid: `Qm_${author}`,
            ...o
        });

        it("counts the removed replies, says by whom, and links each mirrored copy, most recently removed first", () => {
            const text = threadSummary(
                { numComments: 230 },
                [
                    reply("first", { lastSeenUpAt: T + 1800, goneSeenAt: T + 3600, removedBy: "gone" }),
                    reply("second", { lastSeenUpAt: T + 3600, goneSeenAt: T + 7200 }),
                    reply("up", { status: "up", removedBy: null, goneSeenAt: null }),
                    reply("gone_author", { status: "deleted", removedBy: "deleted" }),
                    reply("lost", { cid: null, removedBy: "removed", lastSeenUpAt: T, goneSeenAt: T + 60 })
                ],
                url
            );
            expect(text).toBe(
                [
                    "**3 of 230 comments removed on Reddit so far** (1 by moderators, 1 removed or deleted, 1 by mods or admins). 1 more was deleted by their authors.",
                    "",
                    "- [u/second](https://seedit.app/#/p/c.bso/c/Qm_second): removed by moderators on Reddit between 2026-10-29 12:00 and 13:00 UTC, 1 h to 2 h after posting",
                    "- [u/first](https://seedit.app/#/p/c.bso/c/Qm_first): removed or deleted on Reddit between 2026-10-29 11:30 and 12:00 UTC, 30 min to 1 h after posting",
                    "- u/lost (not captured): removed on Reddit between 2026-10-29 11:00 and 11:01 UTC, within 1 min of posting"
                ].join("\n")
            );
        });

        it("names a single remover inline, counts what it doesn't list, and says when nothing is left", () => {
            const many = Array.from({ length: SUMMARY_LIST_LIMIT + 3 }, (_, i) => reply(`a${i}`));
            const text = threadSummary({ numComments: 10 }, many, url);
            expect(text).toMatch(/^\*\*53 of 53 comments removed on Reddit so far\*\* \(by moderators\)\.\n\n- /);
            expect(text.split("\n")).toHaveLength(2 + SUMMARY_LIST_LIMIT + 1);
            expect(text).toMatch(/\n- and 3 more$/);
            expect(threadSummary({ numComments: 5 }, [reply("up", { status: "up", removedBy: null })], url)).toBe(
                "*No comment of this thread is removed on Reddit any more.*"
            );
        });
    });

    it("formats durations", () => {
        expect(formatDuration(45)).toBe("1 min");
        expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3 h 12 min");
        expect(formatDuration(2 * 86400 + 3600)).toBe("2 d 1 h");
    });
});
