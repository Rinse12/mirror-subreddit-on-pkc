import { describe, expect, it } from "vitest";
import { formatDuration, mirroredAuthor, mirroredContent, removalNote, statusFlair } from "../src/content.js";

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
    numComments: 34 as number | null
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
