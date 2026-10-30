import { describe, expect, it } from "vitest";
import { archiveNote, formatDuration, mirroredAuthor, mirroredContent, removalNote, statusFlair } from "../src/content.js";

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

    it("formats durations", () => {
        expect(formatDuration(45)).toBe("1 min");
        expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3 h 12 min");
        expect(formatDuration(2 * 86400 + 3600)).toBe("2 d 1 h");
    });
});
