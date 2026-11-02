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

// The remover as a short phrase for the summary's breakdown
export function removerShort(item: Pick<Item, "status" | "removedBy" | "kind">): string {
    switch (removerPhrase(item)) {
        case "Removed by moderators on Reddit":
            return "by moderators";
        case "Removed by Reddit admins":
            return "by Reddit admins";
        case "Removed or deleted on Reddit":
            return "removed or deleted";
        default:
            return "by mods or admins";
    }
}

// The flair texts statusFlair gives removed items (author deletions and locks left out): what the flair filter pages match
export const REMOVAL_FLAIRS = [
    "Removed by mods on Reddit",
    "Removed by Reddit admins",
    "Removed on Reddit",
    "Removed or deleted on Reddit"
];

export function statusFlair(item: Pick<Item, "status" | "removedBy" | "kind">): { text: string } | null {
    if (item.status === "up" || item.status === "missing") return null;
    if (item.status === "deleted") return { text: "Deleted by author on Reddit" };
    const phrase = removerPhrase(item);
    return { text: phrase === "Removed by moderators on Reddit" ? "Removed by mods on Reddit" : phrase };
}

export const ARCHIVE_NOTE = "Mirrored from the Arctic Shift archive";

// The line the bot appends to an item it backfilled from the archive and didn't see removed
export const archiveNote = () => `\n\n---\n\n*${ARCHIVE_NOTE}.*`;

// The removal window in words: "between <up> and <gone> UTC, <age> to <age> after posting", or "within <age> of posting"
// when the item was already gone at its first sighting (all we know is that it was up when it was made)
export function removalWindow(item: Pick<Item, "createdUtc" | "lastSeenUpAt" | "goneSeenAt">): string {
    if (!item.goneSeenAt) return "";
    const sameDay = utcDate(item.lastSeenUpAt) === utcDate(item.goneSeenAt);
    const from = `${utcDate(item.lastSeenUpAt)} ${utcTime(item.lastSeenUpAt)}`;
    const to = sameDay ? utcTime(item.goneSeenAt) : `${utcDate(item.goneSeenAt)} ${utcTime(item.goneSeenAt)}`;
    const age =
        item.lastSeenUpAt <= item.createdUtc
            ? `within ${formatDuration(Math.max(item.goneSeenAt - item.createdUtc, 60))} of posting`
            : `${formatDuration(item.lastSeenUpAt - item.createdUtc)} to ${formatDuration(item.goneSeenAt - item.createdUtc)} after posting`;
    return ` between ${from} and ${to} UTC, ${age}`;
}

// The line the bot appends to a removed item: who, the time window, how long after posting, the last numbers seen.
// For a backfilled item the window is the archive's two reads, about 36 h apart, and the line says where it came from.
export function removalNote(
    item: Pick<Item, "status" | "removedBy" | "kind" | "createdUtc" | "lastSeenUpAt" | "goneSeenAt" | "score" | "numComments" | "origin">
): string {
    const parts = [(item.origin === "archive" ? `${ARCHIVE_NOTE}. ${removerPhrase(item)}` : removerPhrase(item)) + removalWindow(item)];
    const numbers = [
        item.score !== null ? `score ${item.score}` : null,
        item.kind === "post" && item.numComments !== null ? `${item.numComments} comments` : null
    ].filter(Boolean);
    if (numbers.length) parts.push(`Last seen with ${numbers.join(", ")}.`);
    return `\n\n---\n\n*${parts[0]}.${parts.length > 1 ? ` ${parts[1]}` : ""}*`;
}

// How many removed replies the summary lists one by one; the rest are counted (a comment is limited to 40 kB)
export const SUMMARY_LIST_LIMIT = 50;

// The bot's pinned reply on a thread with removed replies: how many of the thread's comments Reddit removed, by
// whom, and a link to each mirrored copy; a removed comment that was never published has no cid and no link.
export function threadSummary(
    post: Pick<Item, "numComments">,
    comments: Pick<Item, "author" | "status" | "removedBy" | "kind" | "createdUtc" | "lastSeenUpAt" | "goneSeenAt" | "cid">[],
    url: (cid: string) => string
): string {
    const removed = comments.filter((c) => c.status === "removed").sort((a, b) => (b.goneSeenAt ?? 0) - (a.goneSeenAt ?? 0));
    const deleted = comments.filter((c) => c.status === "deleted").length;
    const total = Math.max(post.numComments ?? 0, comments.length);
    if (!removed.length) return "*No comment of this thread is removed on Reddit any more.*";
    const byWhom = new Map<string, number>();
    for (const c of removed) byWhom.set(removerShort(c), (byWhom.get(removerShort(c)) ?? 0) + 1);
    const breakdown = byWhom.size > 1 ? [...byWhom].map(([who, n]) => `${n} ${who}`).join(", ") : [...byWhom.keys()][0];
    const lines = [
        `**${removed.length} of ${total} comments removed on Reddit so far** (${breakdown}).${deleted ? ` ${deleted} more ${deleted === 1 ? "was" : "were"} deleted by their authors.` : ""}`,
        "",
        ...removed.slice(0, SUMMARY_LIST_LIMIT).map((c) => {
            const name = c.cid ? `[u/${c.author}](${url(c.cid)})` : `u/${c.author} (not captured)`;
            const phrase = removerPhrase(c);
            return `- ${name}: ${phrase[0].toLowerCase()}${phrase.slice(1)}${removalWindow(c)}`;
        })
    ];
    if (removed.length > SUMMARY_LIST_LIMIT) lines.push(`- and ${removed.length - SUMMARY_LIST_LIMIT} more`);
    return lines.join("\n");
}
