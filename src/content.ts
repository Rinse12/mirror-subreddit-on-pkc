import type { Item } from "./db.js";

export const MIRROR_AUTHOR_FLAIR = { text: "Reddit mirror" };

const pad = (n: number) => String(n).padStart(2, "0");
const utcDate = (t: number) => {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const utcTime = (t: number) => {
    const d = new Date(t * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export function formatDuration(seconds: number): string {
    const minutes = Math.max(0, Math.round(seconds / 60));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days) return hours ? `${days} d ${hours} h` : `${days} d`;
    if (hours) return mins ? `${hours} h ${mins} min` : `${hours} h`;
    return `${mins} min`;
}

// Shown as the author's name next to every mirrored post and reply; the signer is still the bot's
export const mirroredAuthor = (item: Pick<Item, "author">) => ({ displayName: `u/${item.author}` });

export const mirroredContent = (item: Pick<Item, "body">) => item.body ?? "*[text not captured before it was removed]*";

export const mirroredTitle = (item: Pick<Item, "title">) => item.title ?? "[title removed on Reddit]";

export const authorDeletedContent = () => "*[deleted by author on Reddit]*";

// Who removed it, in words, from the most precise source we had (see README, Removal detection)
export function removerPhrase(item: Pick<Item, "status" | "removedBy" | "kind">): string {
    if (item.status === "locked") return "Locked on Reddit";
    if (item.status === "deleted") return "Deleted by its author on Reddit";
    switch (item.removedBy) {
        case "moderator":
        case "automod_filtered":
            return "Removed by moderators on Reddit";
        case "reddit":
        case "anti_evil_ops":
        case "copyright_takedown":
        case "content_takedown":
            return "Removed by Reddit admins";
        case "gone":
            return "Removed or deleted on Reddit";
        default:
            return "Removed on Reddit";
    }
}

export function statusFlair(item: Pick<Item, "status" | "removedBy" | "kind">): { text: string } | null {
    if (item.status === "up" || item.status === "missing") return null;
    if (item.status === "deleted") return { text: "Deleted by author on Reddit" };
    const phrase = removerPhrase(item);
    return { text: phrase === "Removed by moderators on Reddit" ? "Removed by mods on Reddit" : phrase };
}

export const ARCHIVE_NOTE = "Mirrored from the Arctic Shift archive";

// The line the bot appends to an item it backfilled from the archive and didn't see removed
export const archiveNote = () => `\n\n---\n\n*${ARCHIVE_NOTE}.*`;

// The line the bot appends to a removed item: who, the time window, how long after posting, the last numbers seen.
// For a backfilled item the window is the archive's two reads, about 36 h apart, and the line says where it came from.
export function removalNote(
    item: Pick<Item, "status" | "removedBy" | "kind" | "createdUtc" | "lastSeenUpAt" | "goneSeenAt" | "score" | "numComments" | "origin">
): string {
    const parts = [item.origin === "archive" ? `${ARCHIVE_NOTE}. ${removerPhrase(item)}` : removerPhrase(item)];
    if (item.goneSeenAt) {
        const sameDay = utcDate(item.lastSeenUpAt) === utcDate(item.goneSeenAt);
        const from = `${utcDate(item.lastSeenUpAt)} ${utcTime(item.lastSeenUpAt)}`;
        const to = sameDay ? utcTime(item.goneSeenAt) : `${utcDate(item.goneSeenAt)} ${utcTime(item.goneSeenAt)}`;
        parts[0] += ` between ${from} and ${to} UTC`;
        // Never seen up (already gone at the first sighting): all we know is that it was up when it was made
        parts[0] +=
            item.lastSeenUpAt <= item.createdUtc
                ? `, within ${formatDuration(Math.max(item.goneSeenAt - item.createdUtc, 60))} of posting`
                : `, ${formatDuration(item.lastSeenUpAt - item.createdUtc)} to ${formatDuration(item.goneSeenAt - item.createdUtc)} after posting`;
    }
    const numbers = [
        item.score !== null ? `score ${item.score}` : null,
        item.kind === "post" && item.numComments !== null ? `${item.numComments} comments` : null
    ].filter(Boolean);
    if (numbers.length) parts.push(`Last seen with ${numbers.join(", ")}.`);
    return `\n\n---\n\n*${parts[0]}.${parts.length > 1 ? ` ${parts[1]}` : ""}*`;
}
