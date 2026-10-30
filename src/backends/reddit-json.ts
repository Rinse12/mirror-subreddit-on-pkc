import { fetchJson, HostThrottle } from "./http.js";
import type { LiveSource } from "./live.js";
import { listingThings, type Observed, parseThing } from "../reddit.js";

const BASE_URL = "https://www.reddit.com";
// /api/info takes up to 100 fullnames per request
export const INFO_BATCH = 100;

// Reddit's unauthenticated .json endpoints
export class RedditJsonBackend implements LiveSource {
    get name() {
        return "reddit-json";
    }

    constructor(
        private readonly userAgent: string,
        private readonly baseUrl = BASE_URL,
        // Unauthenticated clients get about 10 requests/min
        private readonly throttle = new HostThrottle(6_000)
    ) {}

    private get(pathAndQuery: string) {
        const separator = pathAndQuery.includes("?") ? "&" : "?";
        return fetchJson(`${this.baseUrl}${pathAndQuery}${separator}raw_json=1`, {
            headers: { "User-Agent": this.userAgent },
            throttle: this.throttle
        });
    }

    async listNewPosts(subreddit: string): Promise<Observed[]> {
        return listingThings(await this.get(`/r/${subreddit}/new.json?limit=100`)).map(parseThing);
    }

    async listNewComments(subreddit: string): Promise<Observed[]> {
        return listingThings(await this.get(`/r/${subreddit}/comments.json?limit=100`)).map(parseThing);
    }

    // A thread is [post listing, comment listing], replies nested under each comment's data.replies
    async fetchThread(permalink: string): Promise<{ post: Observed; comments: Observed[] }> {
        const body = await this.get(`${permalink.replace(/\/$/, "")}.json?limit=500`);
        if (!Array.isArray(body) || body.length < 2) throw new Error(`Unexpected thread JSON for ${permalink}`);
        const [post] = listingThings(body[0]).map(parseThing);
        const comments: Observed[] = [];
        const walk = (listing: unknown) => {
            for (const thing of listingThings(listing)) {
                comments.push(parseThing(thing));
                if (thing.data.replies && typeof thing.data.replies === "object") walk(thing.data.replies);
            }
        };
        walk(body[1]);
        return { post, comments };
    }

    // Unlike Redlib, Reddit shows a removed comment as [removed], so this returns it with that status
    async checkComment(_permalink: string, commentId: string): Promise<Observed | null> {
        return (await this.checkIds([commentId]))[0] ?? null;
    }

    // Current state of up to INFO_BATCH items. An id missing from the answer is not reported, never assumed removed.
    async checkIds(ids: string[]): Promise<Observed[]> {
        if (ids.length > INFO_BATCH) throw new Error(`checkIds takes at most ${INFO_BATCH} ids`);
        if (!ids.length) return [];
        return listingThings(await this.get(`/api/info.json?id=${ids.join(",")}`)).map(parseThing);
    }
}
