import { fetchJson, HostThrottle } from "./http.js";
import { type Observed, parseThing } from "../reddit.js";

// /api/{posts,comments}/ids takes up to 500 ids per request
export const IDS_BATCH = 500;

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
        const data = await this.get(`/api/comments/search?subreddit=${subreddit}&after=${after}&sort=asc&limit=100`);
        return data.map((d) => parseThing({ kind: "t1", data: d }));
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
