import { fetchJson, HostThrottle } from "./http.js";
import { type Observed, parseThing } from "../reddit.js";

// /api/{posts,comments}/ids takes up to 500 ids per request
export const IDS_BATCH = 500;
// /api/{posts,comments}/search takes up to 100
export const SEARCH_LIMIT = 100;

// An archived item with what the archive knows about its fate: it reads each item shortly after posting (retrievedOn)
// and once more about 36 h later (recheckedOn), and records then whether it was removed or deleted (_meta.removal_type).
// The window between the two reads is the removal window of a backfilled item.
export interface Archived extends Observed {
    retrievedOn: number | null;
    recheckedOn: number | null;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

// Folds _meta into the parsed thing: removal_type says what the re-check found, and is more precise than a body
// still showing the text (removed after the first read) or a [removed] placeholder (removed before it)
export function parseArchived(kind: "t1" | "t3", d: Record<string, unknown>): Archived {
    const observed = parseThing({ kind, data: d });
    const meta = (d._meta ?? null) as { removal_type?: unknown; retrieved_2nd_on?: unknown } | null;
    const removalType = typeof meta?.removal_type === "string" ? meta.removal_type : null;
    if (removalType === "deleted") Object.assign(observed, { status: "deleted", removedBy: "deleted" });
    else if (removalType === "reddit" || removalType === "removed by reddit")
        Object.assign(observed, { status: "removed", removedBy: "reddit" });
    else if (removalType === "removed" && observed.status !== "removed")
        Object.assign(observed, { status: "removed", removedBy: "removed" });
    return { ...observed, retrievedOn: num(d.retrieved_on), recheckedOn: num(meta?.retrieved_2nd_on) };
}

// Arctic Shift archive API. It stores what it saw shortly after posting (and once more at ~36 h), so it is a
// source of text we missed, never of an item's current state.
export class ArcticShiftBackend {
    // Its README: "a couple requests per second" is fine; it once answered 422 to ~1/s paging, so stay well under
    constructor(
        private readonly baseUrl: string,
        private readonly throttle = new HostThrottle(2_000)
    ) {}

    private async get(pathAndQuery: string): Promise<Record<string, unknown>[]> {
        const body = (await fetchJson(`${this.baseUrl}${pathAndQuery}`, { throttle: this.throttle })) as {
            data?: unknown;
            error?: unknown;
        };
        if (!Array.isArray(body?.data))
            throw new Error(`Arctic Shift ${pathAndQuery}: ${JSON.stringify(body?.error ?? body).slice(0, 200)}`);
        return body.data;
    }

    // Comments it saved since `after` (unix seconds), oldest first, up to 100
    async listNewComments(subreddit: string, after: number): Promise<Observed[]> {
        const data = await this.get(`/api/comments/search?subreddit=${subreddit}&after=${after}&sort=asc&limit=${SEARCH_LIMIT}`);
        return data.map((d) => parseThing({ kind: "t1", data: d }));
    }

    // Archived posts made strictly between `after` and `before` (unix seconds), newest first, up to 100
    async listPosts(subreddit: string, after: number, before: number): Promise<Archived[]> {
        const data = await this.get(
            `/api/posts/search?subreddit=${subreddit}&after=${after}&before=${before}&sort=desc&limit=${SEARCH_LIMIT}`
        );
        return data.map((d) => parseArchived("t3", d));
    }

    // Every archived comment of a thread, oldest first, paged on created_utc (`after` is exclusive, so comments made in
    // the same second as a page's last one could be skipped; rare, and the live checks of a young thread catch them).
    // The API rejects small epochs as dates, so the first page has no lower bound.
    async listThreadComments(postId: string, maxPages = 50): Promise<Archived[]> {
        const comments: Archived[] = [];
        let after: number | null = null;
        for (let page = 0; page < maxPages; page++) {
            const bound = after === null ? "" : `&after=${after}`;
            const data = await this.get(`/api/comments/search?link_id=${postId}${bound}&sort=asc&limit=${SEARCH_LIMIT}`);
            comments.push(...data.map((d) => parseArchived("t1", d)));
            if (data.length < SEARCH_LIMIT) break;
            after = Math.max(after ?? 0, ...comments.map((c) => c.createdUtc));
        }
        return comments;
    }

    // Who made the given comments disappear, for those Arctic Shift can tell: its ~36 h re-check records
    // removal_type, and a comment already [removed] when first saved was removed by AutoMod or a filter
    async removalLabels(commentIds: string[]): Promise<Map<string, "removed" | "deleted">> {
        const labels = new Map<string, "removed" | "deleted">();
        for (let i = 0; i < commentIds.length; i += IDS_BATCH) {
            const shortIds = commentIds.slice(i, i + IDS_BATCH).map((id) => id.slice(3));
            for (const d of await this.get(`/api/comments/ids?ids=${shortIds.join(",")}`)) {
                const removalType = (d._meta as { removal_type?: unknown } | null)?.removal_type;
                const id = `t1_${d.id}`;
                if (removalType === "deleted") labels.set(id, "deleted");
                else if (removalType === "removed" || removalType === "removed by reddit" || d.body === "[removed]")
                    labels.set(id, "removed");
            }
        }
        return labels;
    }

    // Archived copies of the given items; items it never saw are left out
    async fetchByIds(ids: string[]): Promise<Observed[]> {
        const posts = ids.filter((id) => id.startsWith("t3_"));
        const comments = ids.filter((id) => id.startsWith("t1_"));
        const results: Observed[] = [];
        for (const [kind, batch] of [
            ["t3", posts],
            ["t1", comments]
        ] as const) {
            for (let i = 0; i < batch.length; i += IDS_BATCH) {
                const shortIds = batch.slice(i, i + IDS_BATCH).map((id) => id.slice(3));
                const path = kind === "t3" ? "posts" : "comments";
                const data = await this.get(`/api/${path}/ids?ids=${shortIds.join(",")}`);
                results.push(...data.map((d) => parseThing({ kind, data: d })));
            }
        }
        return results;
    }
}
