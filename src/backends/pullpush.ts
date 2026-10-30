import { fetchJson, HostThrottle } from "./http.js";
import { type Observed, parseThing } from "../reddit.js";

export const IDS_BATCH = 100;

// PullPush archive API. It saves items within seconds and never re-checks them, so it is only a fallback source
// of text for items that vanished before we or Arctic Shift saved them; it can't say who removed them.
export class PullPushBackend {
    // 15 requests/min, PullPush's soft limit as its homepage used to state
    constructor(
        private readonly baseUrl: string,
        private readonly throttle = new HostThrottle(4_000)
    ) {}

    async fetchByIds(ids: string[]): Promise<Observed[]> {
        const results: Observed[] = [];
        for (const [kind, path] of [
            ["t3", "submission"],
            ["t1", "comment"]
        ] as const) {
            const batch = ids.filter((id) => id.startsWith(`${kind}_`)).map((id) => id.slice(3));
            for (let i = 0; i < batch.length; i += IDS_BATCH) {
                const body = (await fetchJson(`${this.baseUrl}/reddit/search/${path}/?ids=${batch.slice(i, i + IDS_BATCH).join(",")}`, {
                    throttle: this.throttle
                })) as {
                    data?: unknown;
                };
                if (!Array.isArray(body?.data)) throw new Error(`PullPush ${path}: ${JSON.stringify(body).slice(0, 200)}`);
                results.push(...body.data.map((d: Record<string, unknown>) => parseThing({ kind, data: d })));
            }
        }
        return results;
    }
}
