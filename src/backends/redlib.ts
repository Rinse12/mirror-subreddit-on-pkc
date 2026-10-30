import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import TurndownService from "turndown";
import { fetchText, FetchError, HostThrottle } from "./http.js";
import type { LiveSource } from "./live.js";
import type { Observed, ObservedStatus } from "../reddit.js";

// Parses Redlib's HTML pages (tested against Redlib 0.40.0, see tests/fixtures). Redlib has no JSON API, and
// shows removed and author-deleted comments by leaving them out, so a comment missing from a page is reported
// as missing, and only checkComment can confirm it is gone.

const REDDIT = "https://www.reddit.com";

// Redlib proxies Reddit's media under its own paths; links are mapped back to the original hosts
const MEDIA_PREFIXES: [string, string][] = [
    ["/preview/pre/", "https://preview.redd.it/"],
    ["/preview/external-pre/", "https://external-preview.redd.it/"],
    ["/img/", "https://i.redd.it/"],
    ["/vid/", "https://v.redd.it/"],
    ["/hls/", "https://v.redd.it/"],
    ["/thumb/a/", "https://a.thumbs.redditmedia.com/"],
    ["/thumb/b/", "https://b.thumbs.redditmedia.com/"],
    ["/emoji/", "https://emoji.redditmedia.com/"],
    ["/style/", "https://styles.redditmedia.com/"],
    ["/static/", "https://www.redditstatic.com/"]
];

export function originalUrl(href: string): string {
    if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return href;
    for (const [prefix, host] of MEDIA_PREFIXES) {
        if (!href.startsWith(prefix)) continue;
        let rest = href.slice(prefix.length);
        // /vid/<id>/<quality>.mp4 -> https://v.redd.it/<id>
        if (prefix === "/vid/" || prefix === "/hls/") rest = rest.split("/")[0];
        return host + rest;
    }
    return REDDIT + (href.startsWith("/") ? href : `/${href}`);
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "*", emDelimiter: "*" });
turndown.addRule("strikethrough", { filter: ["del", "s"], replacement: (content) => `~~${content}~~` });
turndown.addRule("superscript", { filter: ["sup"], replacement: (content) => `^(${content})` });
turndown.addRule("spoiler", {
    filter: (node) => node.nodeName === "SPAN" && (node as HTMLElement).className?.includes("md-spoiler-text"),
    replacement: (content) => `>!${content}!<`
});

// Rendered Reddit markdown (a .md div) back to markdown, with Redlib's links pointed at the originals
export function htmlToMarkdown($: cheerio.CheerioAPI, md: cheerio.Cheerio<AnyNode>): string {
    const copy = md.clone();
    copy.find("a[href]").each((_, a) => void $(a).attr("href", originalUrl($(a).attr("href")!)));
    copy.find("img[src]").each((_, img) => void $(img).attr("src", originalUrl($(img).attr("src")!)));
    return turndown.turndown($.html(copy.contents()) ?? "").trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Oct 09 2026, 23:34:43 UTC" -> unix seconds
export function parseRedlibTime(title: string | undefined): number {
    const match = title?.match(/^(\w{3}) (\d{1,2}) (\d{4}), (\d{2}):(\d{2}):(\d{2}) UTC$/);
    const month = match ? MONTHS.indexOf(match[1]) : -1;
    if (!match || month < 0) throw new Error(`Unexpected Redlib time ${JSON.stringify(title)}`);
    return Date.UTC(+match[3], month, +match[2], +match[4], +match[5], +match[6]) / 1000;
}

const parseScore = (title: string | undefined): number | null => (title && /^-?\d+$/.test(title.trim()) ? Number(title.trim()) : null);
const authorName = (text: string) => text.trim().replace(/^u\//, "");
const stripQuery = (href: string) => href.split(/[?#]/)[0];
const postIdFromPath = (path: string) => {
    const match = path.match(/\/comments\/([a-z0-9]+)\//);
    if (!match) throw new Error(`Not a Reddit post path: ${path}`);
    return `t3_${match[1]}`;
};

function postStatus(body: string | null, title: string): { status: ObservedStatus; removedBy: string | null } {
    if (title === "[ Removed by moderator ]") return { status: "removed", removedBy: "moderator" };
    if (title === "[ Removed by Reddit ]") return { status: "removed", removedBy: "reddit" };
    if (body?.startsWith("[removed]")) return { status: "removed", removedBy: "removed" };
    if (body === "[deleted]") return { status: "deleted", removedBy: "deleted" };
    return { status: "up", removedBy: null };
}

// The highlighted post on a thread page, or one post of a listing
function parsePost($: cheerio.CheerioAPI, post: cheerio.Cheerio<Element>, permalink: string, numComments: number | null): Observed {
    // A listing links the title; a thread page doesn't. Either way the post flair sits in front of it.
    const titleEl = post.find(".post_title").first().clone();
    titleEl.find(".post_flair").remove();
    const title = titleEl.text().replace(/\s+/g, " ").trim();
    const md = post.find(".post_body > .md").first();
    const bodyText = md.length ? md.text().trim() : "";
    const { status, removedBy } = postStatus(bodyText || null, title);
    const mediaLinks = post
        .find("#post_url[href], .gallery figure > a[href], .post_media_image[src], video source[src]")
        .map((_, el) => originalUrl($(el).attr("href") ?? $(el).attr("src")!))
        .get();
    const author = authorName(post.find(".post_author").first().text());
    const id = postIdFromPath(permalink);
    return {
        redditId: id,
        kind: "post",
        postId: id,
        parentId: null,
        author: author || "[deleted]",
        createdUtc: parseRedlibTime(post.find(".post_header .created").attr("title")),
        title: title.startsWith("[ Removed by") ? null : title,
        // A gallery has no single link; its first image stands in, the rest are listed in the body
        body: status === "up" ? [md.length ? htmlToMarkdown($, md) : "", ...mediaLinks.slice(1)].filter(Boolean).join("\n\n") : null,
        link: mediaLinks[0] ?? null,
        permalink,
        score: parseScore(post.find(".post_score").attr("title")),
        numComments,
        status: post.find(".post_header .locked, .post_title .locked").length && status === "up" ? "locked" : status,
        removedBy
    };
}

function parseComment($: cheerio.CheerioAPI, el: Element, postId: string): Observed {
    const comment = $(el);
    const data = comment.find("> .comment_right > .comment_data");
    const permalink = stripQuery(data.find("a.created").attr("href") ?? "");
    const parentComment = comment.parent().closest("div.comment");
    const md = comment.find("> .comment_right > .comment_body > .md").first();
    const text = md.text().trim();
    // A removed or deleted comment that still has replies stays in the tree as a tombstone, rendered as
    // "[removed] — view removed comment" (an undelete link follows the placeholder); one without replies is left out
    const status: ObservedStatus = text.startsWith("[removed]") ? "removed" : text.startsWith("[deleted]") ? "deleted" : "up";
    return {
        redditId: `t1_${comment.attr("id")}`,
        kind: "comment",
        postId,
        // Redlib renders a deleted comment that still has replies without its id: its replies' parent is unknown
        parentId: !parentComment.length ? postId : parentComment.attr("id") ? `t1_${parentComment.attr("id")}` : null,
        author: authorName(data.find(".comment_author").first().text()) || "[deleted]",
        createdUtc: parseRedlibTime(data.find("a.created").attr("title")),
        title: null,
        body: status === "up" ? htmlToMarkdown($, md) : null,
        link: null,
        permalink,
        score: parseScore(comment.find("> .comment_left > .comment_score").attr("title")),
        numComments: null,
        status,
        removedBy: status === "up" ? null : status
    };
}

export interface ThreadPage {
    post: Observed;
    comments: Observed[];
    // Links to subtrees Redlib cut off ("More replies"), relative to the instance
    moreReplies: string[];
}

export function parseThreadPage(html: string): ThreadPage {
    const $ = cheerio.load(html);
    const post = $("div.post.highlighted").first();
    if (!post.length) throw new FetchError("unavailable", `Not a Redlib thread page: ${$("title").text().trim().slice(0, 120)}`);
    const permalink = stripQuery(post.find("#post_links a").first().attr("href") ?? "");
    const count = $("#comment_count")
        .text()
        .match(/^(\d+) comments?/);
    const observed = parsePost($, post, permalink, count ? Number(count[1]) : null);
    return {
        post: observed,
        comments: $("div.comment[id]")
            .filter((_, el) => Boolean($(el).attr("id")))
            .toArray()
            .map((el) => parseComment($, el, observed.postId)),
        moreReplies: $("a.deeper_replies[href]")
            .map((_, a) => $(a).attr("href")!)
            .get()
    };
}

export interface ListingPage {
    posts: Observed[];
    // The next page's query string, e.g. "?sort=new&t=&after=t3_1xieka7"
    next: string | null;
}

export function parseListingPage(html: string): ListingPage {
    const $ = cheerio.load(html);
    if (!$("div.post[id]").length && $("title").text().startsWith("Error"))
        throw new FetchError("unavailable", $("title").text().trim().slice(0, 120));
    const posts = $("div.post[id]")
        .toArray()
        .map((el) => {
            const post = $(el);
            const permalink = stripQuery(post.find(".post_title > a").not(".post_flair").last().attr("href") ?? "");
            const count = post
                .find(".post_comments")
                .attr("title")
                ?.match(/^(\d+) comments?/);
            return parsePost($, post, permalink, count ? Number(count[1]) : null);
        });
    const next = $("a[href*='after=']").last().attr("href") ?? null;
    return { posts, next };
}

// The comment's own page shows the comment if it is up, as a tombstone if it is gone but has replies, and not at all
// if it is gone without replies
export function parsePermalinkPage(html: string, commentId: string): Observed | null | undefined {
    const $ = cheerio.load(html);
    const post = $("div.post.highlighted").first();
    if (!post.length) return undefined;
    const el = $(`div.comment[id="${commentId.replace(/^t1_/, "")}"]`).get(0);
    return el ? parseComment($, el, postIdFromPath(stripQuery(post.find("#post_links a").first().attr("href") ?? ""))) : null;
}

const MAX_MORE_REPLIES_PAGES = 50;

export class RedlibBackend implements LiveSource {
    get name() {
        return `redlib ${this.instanceUrl}`;
    }

    constructor(
        private readonly instanceUrl: string,
        private readonly throttle = new HostThrottle(1_000)
    ) {}

    private get(path: string) {
        return fetchText(this.instanceUrl.replace(/\/$/, "") + path, { throttle: this.throttle });
    }

    async listNewPosts(subreddit: string): Promise<Observed[]> {
        return parseListingPage(await this.get(`/r/${subreddit}/new`)).posts;
    }

    // The post and every comment Redlib shows, following "More replies" links
    async fetchThread(permalink: string): Promise<{ post: Observed; comments: Observed[] }> {
        const first = parseThreadPage(await this.get(permalink));
        const comments = new Map(first.comments.map((c) => [c.redditId, c]));
        const queue = [...first.moreReplies];
        for (let pages = 0; queue.length && pages < MAX_MORE_REPLIES_PAGES; pages++) {
            const page = parseThreadPage(await this.get(queue.shift()!));
            for (const comment of page.comments) if (!comments.has(comment.redditId)) comments.set(comment.redditId, comment);
            queue.push(...page.moreReplies);
        }
        return { post: first.post, comments: [...comments.values()] };
    }

    // null: gone from Reddit (removed or deleted, Redlib can't tell which)
    async checkComment(permalink: string, commentId: string): Promise<Observed | null> {
        const result = parsePermalinkPage(await this.get(permalink), commentId);
        if (result === undefined) throw new FetchError("unavailable", `${permalink}: not a Redlib thread page`);
        return result;
    }
}
