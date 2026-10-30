import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcticShiftBackend, parseArchived } from "../src/backends/arctic-shift.js";
import { PullPushBackend } from "../src/backends/pullpush.js";
import { FetchError, fetchJson, HostThrottle } from "../src/backends/http.js";
import { RedditJsonBackend } from "../src/backends/reddit-json.js";
import { SourcePool } from "../src/backends/source-pool.js";
import { parseThing } from "../src/reddit.js";

// Field names as Reddit and Arctic Shift serve them; values made up
const post = (data: Record<string, unknown> = {}) => ({
    kind: "t3",
    data: {
        id: "1xiqxin",
        name: "t3_1xiqxin",
        author: "asker",
        created_utc: 1793296045,
        title: "Were there wars that...",
        selftext: "Body text",
        is_self: true,
        url: "https://www.reddit.com/r/AskHistorians/comments/1xiqxin/were_there_wars/",
        permalink: "/r/AskHistorians/comments/1xiqxin/were_there_wars/",
        score: 12,
        num_comments: 3,
        locked: false,
        removed_by_category: null,
        ...data
    }
});

const comment = (data: Record<string, unknown> = {}) => ({
    kind: "t1",
    data: {
        id: "19ruaxxv34o4j",
        name: "t1_19ruaxxv34o4j",
        parent_id: "t3_1xiqxin",
        link_id: "t3_1xiqxin",
        author: "answerer",
        created_utc: 1793296100,
        body: "An answer",
        permalink: "/r/AskHistorians/comments/1xiqxin/were_there_wars/19ruaxxv34o4j/",
        score: 4,
        ...data
    }
});

const listing = (...children: unknown[]) => ({ kind: "Listing", data: { children } });

const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe("parseThing", () => {
    it("parses a self post", () => {
        expect(parseThing(post())).toMatchObject({
            redditId: "t3_1xiqxin",
            kind: "post",
            postId: "t3_1xiqxin",
            parentId: null,
            body: "Body text",
            link: null,
            status: "up",
            removedBy: null
        });
    });

    it("keeps a link post's url and marks it locked", () => {
        const observed = parseThing(post({ is_self: false, selftext: "", url: "https://i.redd.it/x.jpg", locked: true }));
        expect(observed).toMatchObject({ link: "https://i.redd.it/x.jpg", body: "", status: "locked" });
    });

    it("takes the remover from removed_by_category", () => {
        expect(parseThing(post({ removed_by_category: "moderator", selftext: "[removed]" }))).toMatchObject({
            status: "removed",
            removedBy: "moderator",
            body: null
        });
        expect(parseThing(post({ removed_by_category: "deleted", selftext: "[deleted]" }))).toMatchObject({ status: "deleted" });
    });

    it("tells removed and deleted comments apart by their placeholder", () => {
        expect(parseThing(comment({ body: "[removed]", author: "[deleted]" }))).toMatchObject({ status: "removed", body: null });
        expect(parseThing(comment({ body: "[deleted]", author: "[deleted]" }))).toMatchObject({ status: "deleted", body: null });
        expect(parseThing(comment())).toMatchObject({ status: "up", postId: "t3_1xiqxin", parentId: "t3_1xiqxin" });
    });

    it("rejects things without an id or time", () => {
        expect(() => parseThing({ kind: "t1", data: { body: "x" } })).toThrow(/Malformed/);
    });
});

describe("fetchJson", () => {
    it("classifies Reddit's login wall as blocked", async () => {
        vi.stubGlobal("fetch", async () => respond("", 302, { location: "https://old.reddit.com/login/?reason=lor2" }));
        await expect(fetchJson("https://old.reddit.com/x.json")).rejects.toMatchObject({ failure: "blocked" });
    });

    it("classifies 429 and Arctic Shift's 422 as throttled", async () => {
        vi.stubGlobal("fetch", async () => respond({ error: "Timeout. Maybe slow down a bit" }, 422));
        await expect(fetchJson("https://a/x")).rejects.toMatchObject({ failure: "throttled" });
    });

    it("treats an HTML page as unavailable", async () => {
        vi.stubGlobal("fetch", async () => respond("<html>"));
        await expect(fetchJson("https://a/x")).rejects.toMatchObject({ failure: "unavailable" });
    });
});

describe("SourcePool", () => {
    it("falls through to the next source and cools the failed one down, doubling", async () => {
        let now = 0;
        const pool = new SourcePool(["a", "b"], () => now);
        const tried: string[] = [];
        const task = async (source: string) => {
            tried.push(source);
            if (source === "a") throw new FetchError("throttled", "a throttled");
            return source;
        };
        expect(await pool.run(task)).toBe("b");
        now = 30_000;
        expect(await pool.run(task)).toBe("b"); // a still cooling down
        now = 61_000;
        expect(await pool.run(task)).toBe("b"); // a tried again, fails, now 2 min
        now = 61_000 + 90_000;
        await pool.run(task);
        expect(tried).toEqual(["a", "b", "b", "a", "b", "b"]);
    });

    it("rethrows bugs instead of cooling down", async () => {
        const pool = new SourcePool(["a", "b"]);
        await expect(pool.run(async () => Promise.reject(new TypeError("bug")))).rejects.toThrow(TypeError);
    });

    it("reports every failure when all sources fail", async () => {
        const pool = new SourcePool(["a", "b"]);
        await expect(pool.run(async (s) => Promise.reject(new FetchError("blocked", `${s} blocked`)))).rejects.toThrow(
            /a blocked[\s\S]*b blocked/
        );
    });
});

describe("RedditJsonBackend", () => {
    it("lists new comments and batches id checks", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            urls.push(url);
            return respond(listing(comment(), { kind: "more", data: {} }));
        });
        const backend = new RedditJsonBackend("test/1", "https://r", new HostThrottle(0));
        expect(await backend.listNewComments("AskHistorians")).toHaveLength(1);
        await backend.checkIds(["t1_a", "t3_b"]);
        expect(urls).toEqual([
            "https://r/r/AskHistorians/comments.json?limit=100&raw_json=1",
            "https://r/api/info.json?id=t1_a,t3_b&raw_json=1"
        ]);
        await expect(backend.checkIds(Array.from({ length: 101 }, (_, i) => `t1_${i}`))).rejects.toThrow(/at most 100/);
    });
});

describe("ArcticShiftBackend", () => {
    it("looks posts and comments up by id without their prefix", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            urls.push(url);
            return respond({ data: url.includes("/posts/") ? [post().data] : [comment().data] });
        });
        const found = await new ArcticShiftBackend("https://as", new HostThrottle(0)).fetchByIds(["t3_1xiqxin", "t1_19ruaxxv34o4j"]);
        expect(found.map((o) => o.redditId)).toEqual(["t3_1xiqxin", "t1_19ruaxxv34o4j"]);
        expect(urls).toEqual(["https://as/api/posts/ids?ids=1xiqxin", "https://as/api/comments/ids?ids=19ruaxxv34o4j"]);
    });

    it("searches new comments oldest first", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            urls.push(url);
            return respond({ data: [comment().data] });
        });
        expect(await new ArcticShiftBackend("https://as", new HostThrottle(0)).listNewComments("AskHistorians", 1793296000)).toHaveLength(
            1
        );
        expect(urls).toEqual(["https://as/api/comments/search?subreddit=AskHistorians&after=1793296000&sort=asc&limit=100"]);
    });

    it("surfaces its error message", async () => {
        vi.stubGlobal("fetch", async () => respond({ data: null, error: "'limit' must be between 1 and 100" }));
        await expect(new ArcticShiftBackend("https://as", new HostThrottle(0)).listNewComments("x", 0)).rejects.toThrow(/'limit' must be/);
    });
});

describe("parseArchived", () => {
    it("takes the fate of an item from the archive's re-check, keeping the text its first read saved", () => {
        const removedLater = parseArchived("t1", {
            ...comment().data,
            retrieved_on: 1793296200,
            _meta: { removal_type: "removed", retrieved_2nd_on: 1793425800, was_deleted_later: true }
        });
        expect(removedLater).toMatchObject({
            status: "removed",
            removedBy: "removed",
            body: "An answer",
            retrievedOn: 1793296200,
            recheckedOn: 1793425800
        });
        expect(parseArchived("t1", { ...comment().data, _meta: { removal_type: "deleted", retrieved_2nd_on: 1 } })).toMatchObject({
            status: "deleted",
            removedBy: "deleted"
        });
        expect(parseArchived("t3", { ...post().data, _meta: { removal_type: "reddit", retrieved_2nd_on: 1 } })).toMatchObject({
            status: "removed",
            removedBy: "reddit"
        });
        // Already gone at the first read: the text is lost, and nothing says when
        expect(parseArchived("t1", { ...comment().data, body: "[removed]", retrieved_on: 5, _meta: null })).toMatchObject({
            status: "removed",
            body: null,
            retrievedOn: 5,
            recheckedOn: null
        });
        // Reddit's own category on a post wins over the archive's coarser label
        expect(parseArchived("t3", { ...post().data, removed_by_category: "moderator", _meta: { removal_type: "removed" } })).toMatchObject(
            { removedBy: "moderator" }
        );
        expect(parseArchived("t1", { ...comment().data, _meta: { retrieved_2nd_on: 1 } })).toMatchObject({
            status: "up",
            removedBy: null,
            recheckedOn: 1
        });
    });
});

describe("ArcticShiftBackend backfill", () => {
    it("lists archived posts newest first between two instants, and a thread's comments across pages", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            urls.push(url);
            if (url.includes("/posts/")) return respond({ data: [post().data] });
            // A full first page, then the rest
            const page = !url.includes("after=")
                ? Array.from({ length: 100 }, (_, i) => ({ ...comment().data, id: `c${i}`, name: `t1_c${i}`, created_utc: 1793296100 + i }))
                : [comment({ id: "last", name: "t1_last", created_utc: 1793296300 }).data];
            return respond({ data: page });
        });
        const backend = new ArcticShiftBackend("https://as", new HostThrottle(0));
        expect((await backend.listPosts("AskHistorians", 1767225600, 1793296045)).map((p) => p.redditId)).toEqual(["t3_1xiqxin"]);
        const thread = await backend.listThreadComments("t3_1xiqxin");
        expect(thread).toHaveLength(101);
        expect(thread.at(-1)!.redditId).toBe("t1_last");
        expect(urls).toEqual([
            "https://as/api/posts/search?subreddit=AskHistorians&after=1767225600&before=1793296045&sort=desc&limit=100",
            "https://as/api/comments/search?link_id=t3_1xiqxin&sort=asc&limit=100",
            "https://as/api/comments/search?link_id=t3_1xiqxin&after=1793296199&sort=asc&limit=100"
        ]);
    });
});

describe("ArcticShiftBackend.removalLabels", () => {
    it("labels comments from removal_type, and instantly removed ones as removed", async () => {
        vi.stubGlobal("fetch", async () =>
            respond({
                data: [
                    { id: "pex4jsr", body: "text", _meta: { removal_type: "removed" } },
                    { id: "pexlmar", body: "text", _meta: { removal_type: "deleted" } },
                    { id: "pey92h4", body: "[removed]", _meta: { retrieved_2nd_on: 1 } },
                    { id: "pewbwug", body: "still up", _meta: null }
                ]
            })
        );
        const labels = await new ArcticShiftBackend("https://as", new HostThrottle(0)).removalLabels([
            "t1_pex4jsr",
            "t1_pexlmar",
            "t1_pey92h4",
            "t1_pewbwug"
        ]);
        expect([...labels]).toEqual([
            ["t1_pex4jsr", "removed"],
            ["t1_pexlmar", "deleted"],
            ["t1_pey92h4", "removed"]
        ]);
    });
});

describe("PullPushBackend", () => {
    it("looks comments up by id", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            urls.push(url);
            return respond({ data: [comment().data] });
        });
        const found = await new PullPushBackend("https://pp", new HostThrottle(0)).fetchByIds(["t1_19ruaxxv34o4j"]);
        expect(found[0]).toMatchObject({ redditId: "t1_19ruaxxv34o4j", body: "An answer" });
        expect(urls).toEqual(["https://pp/reddit/search/comment/?ids=19ruaxxv34o4j"]);
    });
});

describe("HostThrottle", () => {
    const clock = () => {
        const c = { now: 0, slept: [] as number[] };
        return { c, now: () => c.now, sleep: async (ms: number) => void (c.slept.push(ms), (c.now += ms)) };
    };

    it("spaces requests at least minIntervalMs apart, one at a time", async () => {
        const { c, now, sleep } = clock();
        const throttle = new HostThrottle(2_000, now, sleep);
        const order: number[] = [];
        await Promise.all([1, 2, 3].map((n) => throttle.run(async () => void order.push(n))));
        expect(order).toEqual([1, 2, 3]);
        expect(c.slept).toEqual([2_000, 2_000]);
    });

    it("backs off for the host's X-RateLimit-Reset and fails fast meanwhile", async () => {
        const { c, now, sleep } = clock();
        const throttle = new HostThrottle(2_000, now, sleep);
        vi.stubGlobal("fetch", async () => respond("", 429, { "x-ratelimit-reset": "300" }));
        await expect(fetchJson("https://as/x", { throttle })).rejects.toMatchObject({ failure: "throttled", retryAfterMs: 300_000 });
        c.now += 100_000;
        const task = vi.fn(async () => "ok");
        await expect(throttle.run(task)).rejects.toMatchObject({ failure: "throttled" });
        expect(task).not.toHaveBeenCalled();
        c.now += 200_001;
        expect(await throttle.run(task)).toBe("ok");
    });

    it("backs off 1 min, doubling, when the host gives no reset time", async () => {
        const { c, now, sleep } = clock();
        const throttle = new HostThrottle(0, now, sleep);
        const throttled = () => throttle.run(async () => Promise.reject(new FetchError("throttled", "422")));
        await expect(throttled()).rejects.toThrow();
        c.now += 60_001;
        await expect(throttled()).rejects.toThrow();
        c.now += 60_001;
        await expect(throttle.run(async () => "ok")).rejects.toMatchObject({ failure: "throttled" }); // now 2 min
        c.now += 60_000;
        expect(await throttle.run(async () => "ok")).toBe("ok");
    });
});
