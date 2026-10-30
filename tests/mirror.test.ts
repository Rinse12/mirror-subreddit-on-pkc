import { beforeEach, describe, expect, it } from "vitest";
import type { LiveSource } from "../src/backends/live.js";
import { SourcePool } from "../src/backends/source-pool.js";
import { parseConfig } from "../src/config.js";
import { StateDb } from "../src/db.js";
import { type Archives, Mirror, type Publisher } from "../src/mirror.js";
import { PublishRejected } from "../src/pkc.js";
import type { Observed } from "../src/reddit.js";

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0) / 1000;
const SUB = "AskHistorians";
const POST = "t3_1xir51b";
const PERMALINK = "/r/AskHistorians/comments/1xir51b/did_the_picts/";

const post = (o: Partial<Observed> = {}): Observed => ({
    redditId: POST,
    kind: "post",
    postId: POST,
    parentId: null,
    author: "asker",
    createdUtc: T0,
    title: "Did the Picts paint themselves blue?",
    body: "Question text",
    link: null,
    permalink: PERMALINK,
    score: 5,
    numComments: 2,
    status: "up",
    removedBy: null,
    ...o
});

const comment = (id: string, parentId: string, o: Partial<Observed> = {}): Observed => ({
    redditId: id,
    kind: "comment",
    postId: POST,
    parentId,
    author: `author_${id}`,
    createdUtc: T0 + 60,
    title: null,
    body: `text of ${id}`,
    link: null,
    permalink: `${PERMALINK}${id.slice(3)}/`,
    score: 3,
    numComments: null,
    status: "up",
    removedBy: null,
    ...o
});

// What "Reddit" currently shows; tests change it between checks
class FakeSource implements LiveSource {
    name = "fake";
    posts: Observed[] = [];
    thread: { post: Observed; comments: Observed[] } = { post: post(), comments: [] };
    // What a comment's own permalink shows; absent means gone
    permalinks = new Map<string, Observed>();
    async listNewPosts() {
        return this.posts;
    }
    async fetchThread() {
        return this.thread;
    }
    async checkComment(_permalink: string, id: string) {
        return this.permalinks.get(id) ?? null;
    }
}

class FakePublisher implements Publisher {
    calls: [string, ...unknown[]][] = [];
    next = 0;
    rejectNext = false;
    async comment(c: unknown) {
        if (this.rejectNext) {
            this.rejectNext = false;
            throw new PublishRejected("over 40kb");
        }
        this.calls.push(["comment", c]);
        return `Qm${++this.next}`;
    }
    async edit(cid: string, content: string) {
        this.calls.push(["edit", cid, content]);
    }
    async moderate(cid: string, moderation: unknown) {
        this.calls.push(["moderate", cid, moderation]);
    }
    of(kind: string) {
        return this.calls.filter((c) => c[0] === kind);
    }
}

const archives = (o: Partial<Archives> = {}): Archives => ({
    arcticComments: async () => [],
    arcticByIds: async () => [],
    arcticLabels: async () => new Map(),
    pullpushByIds: async () => [],
    ...o
});

let db: StateDb;
let source: FakeSource;
let publisher: FakePublisher;
let now: number;

const mirror = (a: Archives = archives(), mirrorConfig: Record<string, unknown> = {}) =>
    new Mirror(
        db,
        parseConfig({ mirrors: [{ subreddit: SUB, signerPath: "s.json", ...mirrorConfig }] }).mirrors[0],
        new SourcePool<LiveSource>([source]),
        a,
        publisher,
        () => now,
        () => {}
    );

beforeEach(() => {
    db = new StateDb(":memory:");
    source = new FakeSource();
    publisher = new FakePublisher();
    now = T0 + 120;
});

async function mirrorThread(m: Mirror, comments: Observed[]) {
    source.posts = [post()];
    source.thread = { post: post(), comments };
    await m.discoverPosts();
    await m.checkDuePosts(10);
    await m.publishPending(50);
}

describe("Mirror", () => {
    it("doesn't mirror AutoModerator, and publishes replies to it under the nearest mirrored ancestor", async () => {
        const m = mirror();
        await mirrorThread(m, [comment("t1_auto", POST, { author: "AutoModerator" }), comment("t1_q", "t1_auto"), comment("t1_a", "t1_q")]);
        const comments = publisher.of("comment").map((c) => c[1] as Record<string, string>);
        expect(comments.map((c) => (c.author as unknown as { displayName: string }).displayName)).toEqual([
            "u/asker",
            "u/author_t1_q",
            "u/author_t1_a"
        ]);
        expect(comments.slice(1).map((c) => c.parentCid)).toEqual([db.get(SUB, POST)!.cid, db.get(SUB, "t1_q")!.cid]);
        expect(db.get(SUB, "t1_auto")!.publishStatus).toBe("skipped");
        // Gone from Reddit: no permalink check, nothing to label
        source.thread = { post: post(), comments: [comment("t1_q", "t1_auto"), comment("t1_a", "t1_q")] };
        await m.checkThread(db.get(SUB, POST)!);
        expect(db.get(SUB, "t1_auto")!.status).toBe("up");
    });

    it("purges an already published comment of a skipped author and republishes its reply tree", async () => {
        const m = mirror(archives(), { skipAuthors: [] });
        await mirrorThread(m, [comment("t1_auto", POST, { author: "AutoModerator" }), comment("t1_q", "t1_auto"), comment("t1_a", "t1_q")]);
        const autoCid = db.get(SUB, "t1_auto")!.cid;
        publisher.calls = [];

        const skipping = mirror();
        expect(await skipping.skipAuthors()).toBe(1);
        expect(publisher.of("moderate")).toEqual([["moderate", autoCid, expect.objectContaining({ purged: true })]]);
        expect(db.get(SUB, "t1_auto")).toMatchObject({ publishStatus: "skipped", cid: null });
        expect(await skipping.publishPending(50)).toBe(2);
        const comments = publisher.of("comment").map((c) => c[1] as Record<string, string>);
        expect(comments.map((c) => c.parentCid)).toEqual([db.get(SUB, POST)!.cid, db.get(SUB, "t1_q")!.cid]);
        expect(await skipping.skipAuthors()).toBe(0);
    });

    it("retries a thread that fails to load later, and still checks the other due threads", async () => {
        const m = mirror();
        const other = post({ redditId: "t3_other", postId: "t3_other", permalink: "/r/AskHistorians/comments/other/x/" });
        source.posts = [post(), other];
        await m.discoverPosts();
        const fetchThread = source.fetchThread.bind(source);
        source.fetchThread = async (permalink?: string) => {
            if (permalink === PERMALINK) throw new Error("HTTP 404");
            return { post: other, comments: [comment("t1_x", "t3_other", { postId: "t3_other" })] };
        };
        await m.checkDuePosts(10);
        expect(db.get(SUB, "t1_x")).toBeDefined();
        expect(db.get(SUB, POST)!.nextCheckAt).toBe(now + 600);
        source.fetchThread = fetchThread;
    });

    it("publishes the post, then replies under their parents, and sets the bot's author flair once", async () => {
        const m = mirror();
        await mirrorThread(m, [comment("t1_a", POST), comment("t1_b", "t1_a")]);
        const comments = publisher.of("comment").map((c) => c[1] as Record<string, string>);
        expect(comments[0]).toMatchObject({ title: "Did the Picts paint themselves blue?" });
        expect(comments[0].content).toBe("Question text");
        expect(comments[0].author).toEqual({ displayName: "u/asker" });
        expect(comments[1]).toMatchObject({ parentCid: "Qm1", postCid: "Qm1" });
        expect(comments[2]).toMatchObject({ parentCid: "Qm2", postCid: "Qm1" });
        expect(publisher.of("moderate")).toEqual([["moderate", "Qm1", { author: { flairs: [{ text: "Reddit mirror" }] } }]]);
    });

    it("confirms a vanished reply through its permalink, then flairs it and appends the removal window", async () => {
        const m = mirror();
        await mirrorThread(m, [comment("t1_a", POST)]);
        publisher.calls = [];
        now = T0 + 3 * 3600;
        source.thread = { post: post(), comments: [] };
        await m.checkThread(db.get(SUB, POST)!);
        expect(db.get(SUB, "t1_a")).toMatchObject({
            status: "removed",
            removedBy: "gone",
            lastSeenUpAt: T0 + 120,
            goneSeenAt: T0 + 3 * 3600
        });
        await m.publishLabels(10);
        expect(publisher.of("moderate")).toEqual([["moderate", "Qm2", { flairs: [{ text: "Removed or deleted on Reddit" }] }]]);
        expect(publisher.of("edit")[0][2]).toMatch(
            /text of t1_a\n\n---\n\n\*Removed or deleted on Reddit between 2026-10-29 12:02 and 15:00 UTC, 1 min to 2 h 59 min after posting\. Last seen with score 3\.\*$/
        );
        await m.publishLabels(10);
        expect(publisher.calls).toHaveLength(2);
    });

    it("keeps a reply that is only hidden from the thread page", async () => {
        const m = mirror();
        await mirrorThread(m, [comment("t1_a", POST)]);
        source.thread = { post: post(), comments: [] };
        source.permalinks.set("t1_a", comment("t1_a", POST, { score: 7 }));
        await m.checkThread(db.get(SUB, POST)!);
        expect(db.get(SUB, "t1_a")).toMatchObject({ status: "up", score: 7, goneSeenAt: null });
        expect(db.labelsToPublish(SUB, 10)).toHaveLength(0);
    });

    it("refines a vanished reply's flair once Arctic Shift labels it", async () => {
        const labels = new Map<string, "removed" | "deleted">([["t1_a", "removed"]]);
        const m = mirror(archives({ arcticLabels: async () => labels }));
        await mirrorThread(m, [comment("t1_a", POST)]);
        source.thread = { post: post(), comments: [] };
        await m.checkThread(db.get(SUB, POST)!);
        await m.publishLabels(10);
        publisher.calls = [];
        now = T0 + 41 * 3600;
        await m.labelGoneComments();
        await m.publishLabels(10);
        expect(publisher.of("moderate")).toEqual([["moderate", "Qm2", { flairs: [{ text: "Removed on Reddit" }] }]]);
    });

    it("asks Arctic Shift about a vanished reply at most 3 times, a day apart", async () => {
        let asked = 0;
        const m = mirror(archives({ arcticLabels: async () => (asked++, new Map()) }));
        await mirrorThread(m, [comment("t1_a", POST)]);
        source.thread = { post: post(), comments: [] };
        await m.checkThread(db.get(SUB, POST)!);
        for (let hour = 41; hour < 24 * 7; hour++) {
            now = T0 + hour * 3600;
            await m.labelGoneComments();
        }
        expect(asked).toBe(3);
    });

    it("hides the text of a reply its author deleted", async () => {
        const m = mirror(archives({ arcticLabels: async () => new Map([["t1_a", "deleted"]]) }));
        await mirrorThread(m, [comment("t1_a", POST)]);
        source.thread = { post: post(), comments: [] };
        await m.checkThread(db.get(SUB, POST)!);
        now = T0 + 41 * 3600;
        await m.labelGoneComments();
        await m.publishLabels(10);
        const edit = publisher.of("edit").at(-1)![2] as string;
        expect(edit).toMatch(/\[deleted by author on Reddit\]/);
        expect(edit).not.toMatch(/text of t1_a/);
        expect(publisher.of("moderate").at(-1)![2]).toEqual({ flairs: [{ text: "Deleted by author on Reddit" }] });
    });

    it("takes the remover of a post from Redlib's '[ Removed by moderator ]' title, and keeps the text it saved", async () => {
        const m = mirror();
        await mirrorThread(m, []);
        source.thread = { post: post({ title: null, body: null, status: "removed", removedBy: "moderator" }), comments: [] };
        await m.checkThread(db.get(SUB, POST)!);
        expect(db.get(SUB, POST)).toMatchObject({
            status: "removed",
            removedBy: "moderator",
            body: "Question text",
            title: "Did the Picts paint themselves blue?"
        });
        await m.publishLabels(10);
        expect(publisher.of("moderate").at(-1)![2]).toEqual({ flairs: [{ text: "Removed by mods on Reddit" }] });
        expect(publisher.of("edit")[0][2]).toMatch(/Question text\n\n---\n\n\*Removed by moderators on Reddit between/);
    });

    it("clears the flair when Reddit restores an item", async () => {
        const m = mirror();
        await mirrorThread(m, [comment("t1_a", POST)]);
        source.thread = { post: post(), comments: [] };
        await m.checkThread(db.get(SUB, POST)!);
        await m.publishLabels(10);
        publisher.calls = [];
        source.thread = { post: post(), comments: [comment("t1_a", POST)] };
        await m.checkThread(db.get(SUB, POST)!);
        await m.publishLabels(10);
        expect(publisher.of("moderate")).toEqual([["moderate", "Qm2", { flairs: [] }]]);
        expect(publisher.of("edit")[0][2]).toMatch(/text of t1_a$/);
    });

    it("captures replies from the Arctic Shift feed and recovers missing text from PullPush", async () => {
        const m = mirror(
            archives({
                arcticComments: async () => [
                    comment("t1_x", POST, { createdUtc: T0 + 100, body: "seen by Arctic Shift" }),
                    comment("t1_y", POST, { body: null, status: "removed", removedBy: "removed" })
                ],
                pullpushByIds: async (ids) => (ids.includes("t1_y") ? [comment("t1_y", POST, { body: "seen by PullPush" })] : [])
            })
        );
        await mirrorThread(m, []);
        await m.readArcticFeed();
        expect(db.get(SUB, "t1_x")).toMatchObject({ body: "seen by Arctic Shift", status: "up", lastSeenUpAt: T0 + 100 });
        await m.fillMissingText();
        expect(db.get(SUB, "t1_y")).toMatchObject({ body: "seen by PullPush", textLookups: 1 });
        // Not shown on Reddit any more: confirmed gone at the next read
        await m.checkThread(db.get(SUB, POST)!);
        expect(db.get(SUB, "t1_x")).toMatchObject({ status: "removed", removedBy: "gone" });
    });

    it("hangs a reply whose parent Redlib hid under its real parent, or under the post", async () => {
        const m = mirror(archives({ arcticByIds: async (ids) => ids.map((id) => comment(id, id === "t1_c" ? "t1_a" : "t1_neverseen")) }));
        await mirrorThread(m, [comment("t1_a", POST)]);
        source.thread = {
            post: post(),
            comments: [comment("t1_a", POST), comment("t1_c", POST, { parentId: null }), comment("t1_d", POST, { parentId: null })]
        };
        await m.checkThread(db.get(SUB, POST)!);
        expect(db.get(SUB, "t1_c")!.parentId).toBe("t1_a");
        expect(db.get(SUB, "t1_d")!.parentId).toBe(POST);
    });

    it("never sends a malformed id to the archives, and ignores answers it didn't ask for", async () => {
        const asked: string[][] = [];
        const m = mirror(
            archives({
                arcticByIds: async (ids) => (asked.push(ids), [comment("t1_unrelated", POST)]),
                pullpushByIds: async (ids) => (asked.push(ids), [])
            })
        );
        await mirrorThread(m, []);
        db.insert({
            ...db.get(SUB, POST)!,
            redditId: "t1_",
            kind: "comment",
            status: "deleted",
            body: null,
            cid: null,
            publishStatus: "pending"
        });
        db.insert({
            ...db.get(SUB, POST)!,
            redditId: "t1_z",
            kind: "comment",
            status: "removed",
            body: null,
            cid: null,
            publishStatus: "pending"
        });
        await m.fillMissingText();
        expect(asked).toEqual([["t1_z"], ["t1_z"]]);
        expect(db.get(SUB, "t1_z")!.body).toBeNull();
    });

    it("marks a rejected publication failed and moves on", async () => {
        const m = mirror();
        source.posts = [post()];
        source.thread = { post: post(), comments: [] };
        await m.discoverPosts();
        publisher.rejectNext = true;
        await m.publishPending(10);
        expect(db.get(SUB, POST)).toMatchObject({ publishStatus: "failed", publishError: "over 40kb" });
    });

    it("leaves replies over maxCommentsPerPost unpublished until Reddit removes them", async () => {
        const m = mirror(archives(), { maxCommentsPerPost: 1 });
        await mirrorThread(m, [comment("t1_a", POST), comment("t1_b", POST, { createdUtc: T0 + 90 })]);
        expect(db.get(SUB, "t1_b")).toMatchObject({ publishStatus: "failed", publishError: "over maxCommentsPerPost" });
        source.thread = { post: post(), comments: [comment("t1_a", POST)] };
        await m.checkThread(db.get(SUB, POST)!);
        await m.publishPending(10);
        expect(db.get(SUB, "t1_b")).toMatchObject({ publishStatus: "published" });
    });

    it("schedules the next read of the thread by the post's age", async () => {
        const m = mirror();
        await mirrorThread(m, []);
        expect(db.get(SUB, POST)!.nextCheckAt).toBe(now + 600);
    });
});
