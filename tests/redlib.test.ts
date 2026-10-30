import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    originalUrl,
    parseListingPage,
    parsePermalinkPage,
    parseRedlibTime,
    parseThreadPage,
    RedlibBackend
} from "../src/backends/redlib.js";
import { HostThrottle } from "../src/backends/http.js";

// Real pages saved from Redlib 0.40.0
const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures/redlib-0.40.0", name), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("originalUrl", () => {
    it("maps Redlib's media proxies back to Reddit's hosts", () => {
        expect(originalUrl("/preview/pre/ck643bhwqdyh1.jpeg?width=4284&s=92f2")).toBe(
            "https://preview.redd.it/ck643bhwqdyh1.jpeg?width=4284&s=92f2"
        );
        expect(originalUrl("/img/abc.png")).toBe("https://i.redd.it/abc.png");
        expect(originalUrl("/vid/xyz123/720.mp4")).toBe("https://v.redd.it/xyz123");
        expect(originalUrl("/u/someone")).toBe("https://www.reddit.com/u/someone");
        expect(originalUrl("https://www.youtube.com/watch?v=1")).toBe("https://www.youtube.com/watch?v=1");
    });
});

describe("parseRedlibTime", () => {
    it("reads Redlib's UTC timestamps", () => {
        expect(parseRedlibTime("Oct 09 2026, 23:34:43 UTC")).toBe(Date.UTC(2026, 9, 9, 23, 34, 43) / 1000);
        expect(() => parseRedlibTime("19d ago")).toThrow(/Unexpected/);
    });
});

describe("parseListingPage", () => {
    it("reads every post and the next page", () => {
        const { posts, next } = parseListingPage(fixture("listing-new.html"));
        expect(posts).toHaveLength(25);
        expect(next).toBe("?sort=new&t=&after=t3_1xieka7");
        expect(posts[0]).toMatchObject({ redditId: "t3_1xijaum", author: "AutoModerator", numComments: 3, status: "up" });
        expect(posts[0].title).toBe("Seddoeiu Doeiusm & Eiusmodtemporin | Tempori 29, 2026");
        expect(posts.every((p) => p.permalink.startsWith("/r/AskHistorians/comments/"))).toBe(true);
    });
});

describe("parseThreadPage", () => {
    it("reads the post without its flair, and the comment tree", () => {
        const { post, comments, moreReplies } = parseThreadPage(fixture("thread-more-replies.html"));
        expect(post.title).toMatch(/^"A enima admin minimv veni quis n exer/);
        expect(post).toMatchObject({ redditId: "t3_1w45qsx", numComments: 15, score: 34 });
        expect(comments).toHaveLength(9);
        expect(comments[0]).toMatchObject({ redditId: "t1_p752f1q", parentId: "t3_1w45qsx", score: null });
        expect(comments[1].body).toMatch(/^\[\/u\/user49\]\(https:\/\/www\.reddit\.com\/u\/user49\),/);
        expect(moreReplies).toHaveLength(1);
    });

    it("nests replies under their parent", () => {
        const { comments } = parseThreadPage(fixture("thread-more-replies.html"));
        const ids = new Set(comments.map((c) => c.redditId));
        for (const c of comments) expect(c.parentId === "t3_1w45qsx" || ids.has(c.parentId!)).toBe(true);
    });

    it("leaves removed comments out entirely", () => {
        // Arctic Shift has 7 comments on this post, 3 of them removed; Redlib shows one
        const { comments } = parseThreadPage(fixture("thread-with-vanished-comments.html"));
        expect(comments.map((c) => c.redditId)).toEqual(["t1_pewbwug"]);
    });

    it("recognizes removed posts", () => {
        expect(parseThreadPage(fixture("post-removed-by-moderator.html")).post).toMatchObject({
            status: "removed",
            removedBy: "moderator",
            title: null,
            body: null
        });
        expect(parseThreadPage(fixture("post-removed.html")).post).toMatchObject({
            status: "removed",
            removedBy: "removed",
            title: "Eiusm / temporinc in utl Labore etd dolore (magnaal aliqua enimadmin)"
        });
    });

    it("keeps a link post's link and a gallery's images", () => {
        expect(parseThreadPage(fixture("post-link.html")).post.link).toBe("https://www.youtube.com/watch?v=PzIDvMSjo6w");
        const gallery = parseThreadPage(fixture("post-image.html")).post;
        expect(gallery.link).toMatch(/^https:\/\/preview\.redd\.it\/ck643bhwqdyh1\.jpeg/);
        expect(gallery.body?.split("\n\n")).toHaveLength(2);
    });

    it("rejects Redlib's error page", () => {
        expect(() => parseThreadPage("<html><head><title>Error: Failed to parse page JSON data</title></head></html>")).toThrow(
            /Not a Redlib thread page/
        );
    });
});

describe("parsePermalinkPage", () => {
    it("returns the comment when up and null when gone", () => {
        expect(parsePermalinkPage(fixture("permalink-visible-comment.html"), "t1_pewbwug")?.redditId).toBe("t1_pewbwug");
        expect(parsePermalinkPage(fixture("permalink-removed-comment.html"), "t1_pey92h4")).toBeNull();
        expect(parsePermalinkPage("<title>Error</title>", "t1_x")).toBeUndefined();
    });
});

describe("RedlibBackend.fetchThread", () => {
    it("follows More replies links and keeps the first sighting of each comment", async () => {
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (url: string) => {
            urls.push(url);
            const name = urls.length === 1 ? "thread-more-replies.html" : "permalink-visible-comment.html";
            return new Response(fixture(name));
        });
        const { comments } = await new RedlibBackend("http://redlib/", new HostThrottle(0)).fetchThread(
            "/r/AskHistorians/comments/1w45qsx/x/"
        );
        expect(urls[0]).toBe("http://redlib/r/AskHistorians/comments/1w45qsx/x/");
        expect(urls).toHaveLength(2);
        expect(comments.map((c) => c.redditId)).toContain("t1_pewbwug");
    });
});

describe("deleted comments with replies", () => {
    it("skips the id-less deleted comment and leaves its replies' parent unknown", () => {
        const { comments } = parseThreadPage(fixture("thread-with-deleted-parent.html"));
        expect(comments.every((c) => c.redditId !== "t1_")).toBe(true);
        expect(comments.find((c) => c.redditId === "t1_19rubhfz8eptu")).toMatchObject({ parentId: null });
    });
});
