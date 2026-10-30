// Reddit's "thing" JSON (t1 comment, t3 post), as served by Reddit's .json endpoints and stored by Arctic Shift

export type ObservedStatus = "up" | "removed" | "deleted" | "locked";

// One sighting of a post or comment by a fetch backend
export interface Observed {
    redditId: string;
    kind: "post" | "comment";
    postId: string;
    // null for a post, and for a comment whose parent the source didn't show (Redlib hides deleted comments' ids)
    parentId: string | null;
    author: string;
    createdUtc: number;
    title: string | null;
    // null when the sighting shows a placeholder ([removed], [deleted]) instead of the text
    body: string | null;
    link: string | null;
    permalink: string;
    // null when the source hides it (Redlib shows "Hidden" for new comments in some subreddits)
    score: number | null;
    numComments: number | null;
    status: ObservedStatus;
    // removed_by_category when Reddit gave one, else "removed" or "deleted"
    removedBy: string | null;
}

export interface RedditThing {
    kind: string;
    data: Record<string, unknown>;
}

const PLACEHOLDERS = new Set(["[removed]", "[deleted]", "[ Removed by Reddit ]", "[ Removed by moderator ]"]);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function parseThing(thing: RedditThing): Observed {
    const d = thing.data;
    const id = str(d.name) ?? `${thing.kind}_${str(d.id)}`;
    const createdUtc = num(d.created_utc);
    const permalink = str(d.permalink);
    if (!str(d.id) || createdUtc === null || !permalink)
        throw new Error(`Malformed Reddit ${thing.kind}: ${JSON.stringify(d).slice(0, 200)}`);

    if (thing.kind === "t3") {
        const selftext = str(d.selftext) ?? "";
        const removedByCategory = str(d.removed_by_category);
        let status: ObservedStatus = d.locked === true ? "locked" : "up";
        let removedBy: string | null = null;
        if (removedByCategory) {
            status = removedByCategory === "deleted" ? "deleted" : "removed";
            removedBy = removedByCategory;
        } else if (selftext === "[removed]" || selftext === "[deleted]") {
            status = selftext === "[removed]" ? "removed" : "deleted";
            removedBy = status;
        }
        return {
            redditId: id,
            kind: "post",
            postId: id,
            parentId: null,
            author: str(d.author) ?? "[deleted]",
            createdUtc,
            title: str(d.title),
            body: PLACEHOLDERS.has(selftext) ? null : selftext,
            link: d.is_self === true ? null : str(d.url),
            permalink,
            score: num(d.score) ?? 0,
            numComments: num(d.num_comments),
            status,
            removedBy
        };
    }

    if (thing.kind === "t1") {
        const body = str(d.body) ?? "";
        // Comments carry no removed_by_category: [removed] is mods, AutoMod or admins, [deleted] is the author
        const status: ObservedStatus = body === "[removed]" ? "removed" : body === "[deleted]" ? "deleted" : "up";
        return {
            redditId: id,
            kind: "comment",
            postId: str(d.link_id) ?? "",
            parentId: str(d.parent_id),
            author: str(d.author) ?? "[deleted]",
            createdUtc,
            title: null,
            body: PLACEHOLDERS.has(body) ? null : body,
            link: null,
            permalink,
            score: num(d.score) ?? 0,
            numComments: null,
            status,
            removedBy: status === "up" ? null : status
        };
    }

    throw new Error(`Unsupported Reddit kind ${thing.kind}`);
}

// Reddit listings wrap things as { kind: "Listing", data: { children: [...] } }; "more" stubs are skipped
export function listingThings(listing: unknown): RedditThing[] {
    const children = (listing as { data?: { children?: unknown } })?.data?.children;
    if (!Array.isArray(children)) throw new Error("Not a Reddit listing");
    return children.filter((child): child is RedditThing => child?.kind === "t1" || child?.kind === "t3");
}

// A well-formed fullname; anything else must never reach an archive's id lookup
export const isRedditId = (id: string) => /^t[13]_[a-z0-9]+$/.test(id);
