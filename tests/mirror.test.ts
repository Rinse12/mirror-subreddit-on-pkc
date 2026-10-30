import { beforeEach, describe, expect, it } from "vitest";
import type { Archived } from "../src/backends/arctic-shift.js";
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
    arcticPosts: async () => [],
    arcticThread: async () => [],
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

    describe("backfill", () => {
        const DAY = 86400;
        const SINCE = "2026-10-01T00:00:00Z";
        const sinceUtc = Date.parse(SINCE) / 1000;
        // An archived item: read once shortly after posting, once more ~36 h later
        const archived = (o: Observed, extra: Partial<Archived> = {}): Archived => ({
            ...o,
            retrievedOn: o.createdUtc + 300,
            recheckedOn: o.createdUtc + 36 * 3600,
            ...extra
        });
        const newer = archived(
            post({ redditId: "t3_newer", postId: "t3_newer", createdUtc: T0 - 10 * DAY, permalink: "/r/AskHistorians/comments/newer/" })
        );
        const older = archived(
            post({ redditId: "t3_older", postId: "t3_older", createdUtc: T0 - 20 * DAY, permalink: "/r/AskHistorians/comments/older/" })
        );
        const threads: Record<string, Archived[]> = {
            t3_newer: [
                archived(
                    comment("t1_kept", "t3_newer", {
                        postId: "t3_newer",
                        createdUtc: T0 - 10 * DAY + 60,
                        status: "removed",
                        removedBy: "removed"
                    })
                ),
                archived(
                    comment("t1_lost", "t3_newer", {
                        postId: "t3_newer",
                        createdUtc: T0 - 10 * DAY + 120,
                        body: null,
                        status: "removed",
                        removedBy: "removed"
                    })
                ),
                archived(comment("t1_reply_to_lost", "t1_lost", { postId: "t3_newer", createdUtc: T0 - 10 * DAY + 180 })),
                archived(comment("t1_up", "t3_newer", { postId: "t3_newer", createdUtc: T0 - 10 * DAY + 240 }))
            ],
            t3_older: [archived(comment("t1_old_up", "t3_older", { postId: "t3_older", createdUtc: T0 - 20 * DAY + 60 }))]
        };
        const archive = (posts = [newer, older]) =>
            archives({
                arcticPosts: async (_sub, after, before) => posts.filter((p) => p.createdUtc > after && p.createdUtc < before),
                arcticThread: async (postId) => threads[postId] ?? []
            });

        it("mirrors archived threads newest first, with the archive's reads as the removal window, and skips text it lost", async () => {
            const m = mirror(archive(), { backfillSince: SINCE });
            now = T0;
            expect(await m.backfill(1)).toBe(1);
            expect(db.get(SUB, "t3_newer")).toMatchObject({ origin: "archive", nextCheckAt: null, lastSeenUpAt: newer.recheckedOn });
            expect(db.get(SUB, "t3_older")).toBeUndefined();
            expect(db.get(SUB, "t1_kept")).toMatchObject({
                status: "removed",
                removedBy: "removed",
                lastSeenUpAt: T0 - 10 * DAY + 60 + 300,
                goneSeenAt: T0 - 10 * DAY + 60 + 36 * 3600,
                publishStatus: "pending"
            });
            expect(db.get(SUB, "t1_lost")).toMatchObject({ publishStatus: "skipped", body: null });
            expect(db.mirror(SUB).backfillCursor).toBe(newer.createdUtc);

            await m.publishPending(50);
            await m.publishLabels(50);
            const comments = publisher
                .of("comment")
                .map((c) => c[1] as { content: string; parentCid?: string; author: { displayName: string } });
            expect(comments[0].content).toBe("Question text\n\n---\n\n*Mirrored from the Arctic Shift archive.*");
            // The reply to the lost comment hangs under the post, like a reply to a skipped author
            expect(comments.find((c) => c.author.displayName === "u/author_t1_reply_to_lost")!.parentCid).toBe("Qm1");
            expect(publisher.of("moderate").at(-1)![2]).toEqual({ flairs: [{ text: "Removed on Reddit" }] });
            expect(publisher.of("edit")[0][2]).toMatch(
                /^text of t1_kept\n\n---\n\n\*Mirrored from the Arctic Shift archive\. Removed on Reddit between 2026-10-19 12:06 and 2026-10-21 00:01 UTC, 5 min to 1 d 12 h after posting\. Last seen with score 3\.\*$/
            );

            // The next call takes the next post; the page after that is empty, so the backfill is done
            expect(await m.backfill(5)).toBe(1);
            expect(db.get(SUB, "t3_older")).toMatchObject({ origin: "archive" });
            expect(await m.backfill(5)).toBe(0);
            expect(db.mirror(SUB).backfillCursor).toBe(sinceUtc);
            expect(await m.backfill(5)).toBe(0);
        });

        it("with backfillOnly removed takes only threads where something with text was removed, and leaves live threads alone", async () => {
            const m = mirror(archive(), { backfillSince: SINCE, backfillOnly: "removed" });
            now = T0;
            await m.backfill(5);
            expect(db.get(SUB, "t3_newer")).toBeDefined();
            expect(db.get(SUB, "t3_older")).toBeUndefined();

            db.close();
            db = new StateDb(":memory:");
            source.posts = [post({ redditId: "t3_newer", postId: "t3_newer", createdUtc: T0 - 10 * DAY })];
            source.thread = { post: source.posts[0], comments: [] };
            const live = mirror(archive(), { backfillSince: SINCE });
            await live.discoverPosts();
            await live.backfill(5);
            expect(db.get(SUB, "t3_newer")).toMatchObject({ origin: "live" });
            expect(db.get(SUB, "t1_kept")).toBeUndefined();
        });

        it("hands a thread the archive hasn't re-read yet to the live checks, and respects minScore", async () => {
            const fresh = archived(post({ redditId: "t3_fresh", postId: "t3_fresh", createdUtc: T0 - 3600, score: 1 }), {
                recheckedOn: null
            });
            const m = mirror(archive([fresh]), { backfillSince: SINCE });
            now = T0;
            await m.backfill(5);
            expect(db.get(SUB, "t3_fresh")).toMatchObject({ origin: "archive", nextCheckAt: T0, lastSeenUpAt: fresh.retrievedOn });

            db.close();
            db = new StateDb(":memory:");
            await mirror(archive([fresh]), { backfillSince: SINCE, minScore: 5 }).backfill(5);
            expect(db.get(SUB, "t3_fresh")).toBeUndefined();
        });

        it("retries a thread whose fetch failed on the next call, without losing the rest of the page", async () => {
            let fail = true;
            const flaky = archives({
                arcticPosts: async (_sub, after, before) => [newer, older].filter((p) => p.createdUtc > after && p.createdUtc < before),
                arcticThread: async (postId) => {
                    if (fail && postId === "t3_newer") {
                        fail = false;
                        throw new Error("Arctic Shift: HTTP 503");
                    }
                    return threads[postId] ?? [];
                }
            });
            const m = mirror(flaky, { backfillSince: SINCE });
            now = T0;
            await expect(m.backfill(5)).rejects.toThrow(/503/);
            expect(db.get(SUB, "t3_newer")).toBeUndefined();
            expect(await m.backfill(5)).toBe(2);
            expect(db.get(SUB, "t3_newer")).toBeDefined();
            expect(db.get(SUB, "t3_older")).toBeDefined();
        });

        it("does nothing without backfillSince", async () => {
            let asked = 0;
            const m = mirror(archives({ arcticPosts: async () => (asked++, []) }));
            expect(await m.backfill(5)).toBe(0);
            expect(asked).toBe(0);
        });
    });
});
