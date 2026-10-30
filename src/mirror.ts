import type { LiveSource } from "./backends/live.js";
import type { SourcePool } from "./backends/source-pool.js";
import type { MirrorConfig } from "./config.js";
import { authorDeletedContent, MIRROR_AUTHOR_FLAIR, mirroredAuthor, mirroredContent, mirroredTitle, removalNote, statusFlair } from "./content.js";
import { type Item, labelOf, type StateDb } from "./db.js";
import type { Moderation, NewComment } from "./pkc.js";
import { PublishRejected } from "./pkc.js";
import { isRedditId, type Observed } from "./reddit.js";
import { nextCheckAt } from "./schedule.js";

const HOUR = 3600;
const THREAD_RETRY = 600;
// Arctic Shift re-checks once, ~36 h after posting; ask a little later
const ARCTIC_RECHECK_AGE = 40 * HOUR;
const MAX_TEXT_LOOKUPS = 3;
// Arctic Shift re-checks a comment once, so its answer rarely changes: ask up to 3 times, a day apart, in case it
// was behind or its removal data was broken (arctic_shift#90)
const MAX_LABEL_LOOKUPS = 3;
const LABEL_LOOKUP_SPACING = 24 * HOUR;
const OVER_CAP = "over maxCommentsPerPost";

export interface Archives {
    arcticComments(subreddit: string, after: number): Promise<Observed[]>;
    arcticByIds(ids: string[]): Promise<Observed[]>;
    arcticLabels(commentIds: string[]): Promise<Map<string, "removed" | "deleted">>;
    pullpushByIds(ids: string[]): Promise<Observed[]>;
}

// The bot's publications to the mirror's community
export interface Publisher {
    comment(comment: NewComment): Promise<string>;
    edit(commentCid: string, content: string): Promise<void>;
    moderate(commentCid: string, moderation: Moderation): Promise<void>;
}

// How sure a removedBy is: a later, vaguer sighting never replaces a more precise one
const precision = (removedBy: string | null) =>
    removedBy === null ? 0 : removedBy === "gone" ? 1 : removedBy === "removed" || removedBy === "deleted" ? 2 : 3;

const isGone = (status: Item["status"]) => status === "removed" || status === "deleted";

export class Mirror {
    readonly subreddit: string;

    constructor(
        private readonly db: StateDb,
        private readonly config: MirrorConfig,
        private readonly live: SourcePool<LiveSource>,
        private readonly archives: Archives,
        private readonly publisher: Publisher,
        private readonly now: () => number = () => Math.floor(Date.now() / 1000),
        private readonly log: (message: string) => void = (message) => console.log(`[r/${config.subreddit}] ${message}`)
    ) {
        this.subreddit = config.subreddit;
    }

    private skips(author: string): boolean {
        return this.config.skipAuthors.some((skipped) => skipped.toLowerCase() === author.toLowerCase());
    }

    private newItem(observed: Observed, now: number): Item {
        const gone = isGone(observed.status);
        return {
            subreddit: this.subreddit,
            ...observed,
            // Already gone when first seen: all we know is that it was up when it was made
            lastSeenUpAt: gone ? observed.createdUtc : now,
            goneSeenAt: gone ? now : null,
            nextCheckAt: observed.kind === "post" ? now : null,
            textLookups: 0,
            labelLookups: 0,
            labelCheckedAt: null,
            cid: null,
            publishStatus: observed.kind === "comment" && this.skips(observed.author) ? "skipped" : "pending",
            publishError: null,
            publishedLabel: null
        };
    }

    // Folds one sighting into what we know. Text and title are only ever filled in, never overwritten with a gap.
    private observe(item: Item, observed: Observed, now: number): void {
        const changes: Partial<Item> = {
            score: observed.score ?? item.score,
            numComments: observed.numComments ?? item.numComments
        };
        if (item.body === null && observed.body !== null) {
            changes.body = observed.body;
            // Published with a placeholder: have the label step publish the text
            if (item.publishStatus === "published") changes.publishedLabel = null;
        }
        if (item.title === null && observed.title) changes.title = observed.title;
        if (isGone(observed.status)) {
            if (!isGone(item.status)) {
                changes.status = observed.status;
                changes.goneSeenAt = item.goneSeenAt ?? now;
                changes.removedBy = observed.removedBy;
                if (item.publishError === OVER_CAP) Object.assign(changes, { publishStatus: "pending", publishError: null });
            } else if (precision(observed.removedBy) > precision(item.removedBy)) {
                changes.status = observed.status;
                changes.removedBy = observed.removedBy;
            }
        } else {
            Object.assign(changes, { status: observed.status, removedBy: null, goneSeenAt: null, lastSeenUpAt: now });
        }
        this.db.update(this.subreddit, item.redditId, changes);
    }

    private record(observed: Observed, now: number): Item {
        const item = this.db.get(this.subreddit, observed.redditId);
        if (item) this.observe(item, observed, now);
        else this.db.insert(this.newItem(observed, now));
        return this.db.get(this.subreddit, observed.redditId)!;
    }

    async discoverPosts(): Promise<number> {
        const posts = await this.live.run((source) => source.listNewPosts(this.subreddit));
        const now = this.now();
        let added = 0;
        this.db.transaction(() => {
            for (const post of posts) {
                const known = this.db.get(this.subreddit, post.redditId);
                if (!known && post.score !== null && post.score < this.config.minScore) continue;
                if (!known) added++;
                this.record(post, now);
            }
        });
        if (added) this.log(`found ${added} new posts`);
        return added;
    }

    // A thread no source can load is retried in 10 min, without holding up the other due threads
    async checkDuePosts(limit: number): Promise<void> {
        for (const post of this.db.duePosts(this.subreddit, this.now(), limit)) {
            try {
                await this.checkThread(post);
            } catch (error) {
                this.log(`${post.redditId}: thread check failed: ${error instanceof Error ? error.message : error}`);
                this.db.update(this.subreddit, post.redditId, { nextCheckAt: this.now() + THREAD_RETRY });
            }
        }
    }

    // Re-reads a thread: refreshes the post and every comment shown, finds new comments, and confirms the ones
    // that disappeared through their own permalink
    async checkThread(post: Item): Promise<void> {
        const thread = await this.live.run((source) => source.fetchThread(post.permalink));
        await this.resolveParents(thread.comments);
        const now = this.now();
        const seen = new Set<string>();
        this.db.transaction(() => {
            this.record(thread.post, now);
            for (const comment of thread.comments) {
                seen.add(comment.redditId);
                this.record(comment, now);
            }
            this.db.update(this.subreddit, post.redditId, {
                nextCheckAt: nextCheckAt(post.createdUtc, now, this.config.commentUpdateDays)
            });
        });
        const vanished = this.db.commentsOf(this.subreddit, post.redditId).filter((c) => !seen.has(c.redditId) && !isGone(c.status) && c.publishStatus !== "skipped");
        for (const comment of vanished) {
            if (comment.status !== "missing") this.db.update(this.subreddit, comment.redditId, { status: "missing", goneSeenAt: now });
            const current = await this.live.run((source) => source.checkComment(comment.permalink, comment.redditId));
            const fresh = this.db.get(this.subreddit, comment.redditId)!;
            if (current) this.observe(fresh, current, this.now());
            else
                this.db.update(this.subreddit, comment.redditId, {
                    status: "removed",
                    removedBy: "gone",
                    // Held back by the cap, but a removed reply is always worth publishing
                    ...(fresh.publishError === OVER_CAP ? { publishStatus: "pending" as const, publishError: null } : {})
                });
        }
        if (vanished.length) this.log(`${post.redditId}: ${vanished.length} comments no longer shown`);
    }

    // New comments whose parent the source didn't show (a deleted comment, on Redlib) get it from Arctic Shift, or
    // hang under the post when it doesn't know it or we never captured that parent. Known comments keep the parent they were first seen with.
    private async resolveParents(comments: Observed[]): Promise<void> {
        const orphans = comments.filter((c) => c.parentId === null && !this.db.get(this.subreddit, c.redditId));
        if (!orphans.length) return;
        const parents = new Map<string, string | null>();
        try {
            for (const o of await this.archives.arcticByIds(orphans.map((c) => c.redditId).filter(isRedditId)))
                parents.set(o.redditId, o.parentId);
        } catch (error) {
            this.log(`could not look up parents in Arctic Shift: ${(error as Error).message}`);
        }
        // A parent we never captured can't be published, so the reply hangs under the post instead
        for (const c of orphans) {
            const parent = parents.get(c.redditId);
            c.parentId = parent && this.db.get(this.subreddit, parent) ? parent : c.postId;
        }
    }

    // Arctic Shift's comment search, as a second feed for comments of posts we mirror
    async readArcticFeed(maxPages = 5): Promise<void> {
        let cursor = this.db.mirror(this.subreddit).arcticCursor || this.now() - HOUR;
        for (let page = 0; page < maxPages; page++) {
            const comments = await this.archives.arcticComments(this.subreddit, cursor);
            const now = this.now();
            this.db.transaction(() => {
                for (const comment of comments) {
                    if (!this.db.get(this.subreddit, comment.postId)) continue;
                    const known = this.db.get(this.subreddit, comment.redditId);
                    // Its snapshot is older than our own reads: it may only fill in text we lack
                    if (known) {
                        if (known.body === null && comment.body !== null)
                            this.db.update(this.subreddit, known.redditId, {
                                body: comment.body,
                                ...(known.publishStatus === "published" ? { publishedLabel: null } : {})
                            });
                    }
                    // Seen by Arctic Shift, not yet by us: it was up when made, the next thread read decides the rest
                    else this.db.insert({ ...this.newItem(comment, now), lastSeenUpAt: comment.createdUtc });
                }
            });
            if (comments.length) cursor = Math.max(cursor, ...comments.map((c) => c.createdUtc));
            this.db.updateMirror(this.subreddit, { arcticCursor: cursor });
            if (comments.length < 100) break;
        }
    }

    // Text for items that vanished before we saved it: Arctic Shift first, PullPush for what it lacks
    async fillMissingText(limit = 100): Promise<void> {
        const items = this.db.missingText(this.subreddit, MAX_TEXT_LOOKUPS, limit).filter((i) => isRedditId(i.redditId));
        if (!items.length) return;
        const ids = items.map((i) => i.redditId);
        const wanted = new Set(ids);
        const found = new Map<string, Observed>();
        const take = (results: Observed[]) => {
            for (const o of results) if (o.body !== null && wanted.has(o.redditId)) found.set(o.redditId, o);
        };
        take(await this.archives.arcticByIds(ids));
        const rest = ids.filter((id) => !found.has(id));
        if (rest.length) take(await this.archives.pullpushByIds(rest));
        this.db.transaction(() => {
            for (const item of items) {
                const o = found.get(item.redditId);
                const changes: Partial<Item> = { textLookups: item.textLookups + 1 };
                if (o) {
                    changes.body = o.body;
                    if (item.title === null && o.title) changes.title = o.title;
                    if (item.publishStatus === "published") changes.publishedLabel = null;
                }
                this.db.update(this.subreddit, item.redditId, changes);
            }
        });
        if (found.size) this.log(`recovered the text of ${found.size} removed items from archives`);
    }

    // Arctic Shift's removed-or-deleted label for comments that just vanished
    async labelGoneComments(limit = 500): Promise<void> {
        const now = this.now();
        const items = this.db
            .unlabelledGone(this.subreddit, now - ARCTIC_RECHECK_AGE, MAX_LABEL_LOOKUPS, now - LABEL_LOOKUP_SPACING, limit)
            .filter((i) => isRedditId(i.redditId));
        if (!items.length) return;
        const labels = await this.archives.arcticLabels(items.map((i) => i.redditId));
        this.db.transaction(() => {
            for (const item of items) {
                const label = labels.get(item.redditId);
                this.db.update(this.subreddit, item.redditId, {
                    labelLookups: item.labelLookups + 1,
                    labelCheckedAt: now,
                    ...(label === "deleted"
                        ? { status: "deleted" as const, removedBy: "deleted" }
                        : label === "removed"
                          ? { removedBy: "removed" }
                          : {})
                });
            }
        });
        if (labels.size) this.log(`Arctic Shift labelled ${labels.size} vanished comments`);
    }

    contentFor(item: Item): string {
        if (item.status === "up" || item.status === "missing") return mirroredContent(item);
        const base = item.status === "deleted" && this.config.authorDeleted === "hide" ? authorDeletedContent() : mirroredContent(item);
        return base + removalNote(item);
    }

    async publishPending(limit: number): Promise<number> {
        let published = 0;
        // Re-queried after each batch: a reply becomes publishable once its parent went out in the batch before
        for (
            let batch = this.db.publishable(this.subreddit, limit);
            batch.length && published < limit;
            batch = this.db.publishable(this.subreddit, limit - published)
        ) {
            const n = await this.publishBatch(batch);
            if (!n) break;
            published += n;
        }
        return published;
    }

    private async publishBatch(items: Item[]): Promise<number> {
        let published = 0;
        for (const item of items) {
            const cap = this.config.maxCommentsPerPost;
            if (
                item.kind === "comment" &&
                cap !== null &&
                !isGone(item.status) &&
                this.db.publishedCommentCount(this.subreddit, item.postId) >= cap
            ) {
                this.db.update(this.subreddit, item.redditId, { publishStatus: "failed", publishError: OVER_CAP });
                continue;
            }
            const comment: NewComment = { content: this.contentFor(item), author: mirroredAuthor(item) };
            if (item.kind === "post") {
                comment.title = mirroredTitle(item);
                if (item.link) comment.link = item.link;
            } else {
                const parent = this.publishedParent(item);
                if (!parent) continue;
                comment.parentCid = parent;
                comment.postCid = this.db.get(this.subreddit, item.postId)!.cid!;
            }
            try {
                const cid = await this.publisher.comment(comment);
                // An item that was already gone still needs its flair; the label step adds it
                this.db.update(this.subreddit, item.redditId, {
                    cid,
                    publishStatus: "published",
                    publishedLabel: item.status === "up" ? labelOf(item) : null
                });
                published++;
                await this.ensureAuthorFlair(cid);
            } catch (error) {
                if (!(error instanceof PublishRejected)) throw error;
                this.db.update(this.subreddit, item.redditId, { publishStatus: "failed", publishError: error.message });
                this.log(`${item.redditId} rejected: ${error.message}`);
            }
        }
        return published;
    }

    // The cid a reply goes under: its parent's, or with the parent skipped, the nearest mirrored ancestor's
    private publishedParent(item: Item): string | null {
        let parent = this.db.get(this.subreddit, item.parentId!)!;
        while (parent.publishStatus === "skipped") parent = this.db.get(this.subreddit, parent.parentId ?? parent.postId)!;
        return parent.cid;
    }

    // Marks the comments of skipAuthors skipped. One already published is purged from the community with its
    // reply tree, and the replies are published again under the nearest mirrored ancestor.
    async skipAuthors(): Promise<number> {
        let purged = 0;
        for (const item of this.db.unskipped(this.subreddit, this.config.skipAuthors)) {
            if (item.cid) {
                await this.publisher.moderate(item.cid, { purged: true, reason: `Comments by u/${item.author} aren't mirrored` });
                purged++;
            }
            this.db.transaction(() => {
                this.db.update(this.subreddit, item.redditId, { publishStatus: "skipped", cid: null, publishedLabel: null, publishError: null });
                if (item.cid)
                    for (const reply of this.db.replyTree(this.subreddit, item.redditId))
                        if (reply.publishStatus === "published")
                            this.db.update(this.subreddit, reply.redditId, { publishStatus: "pending", cid: null, publishedLabel: null });
            });
        }
        if (purged) this.log(`purged ${purged} comments by skipped authors`);
        return purged;
    }

    private async ensureAuthorFlair(cid: string): Promise<void> {
        if (this.db.mirror(this.subreddit).authorFlairSet) return;
        await this.publisher.moderate(cid, { author: { flairs: [MIRROR_AUTHOR_FLAIR] } });
        this.db.updateMirror(this.subreddit, { authorFlairSet: 1 });
    }

    // Brings each published item's flair and note in line with what the checks found
    async publishLabels(limit: number): Promise<number> {
        let done = 0;
        for (const item of this.db.labelsToPublish(this.subreddit, limit)) {
            const flair = statusFlair(item);
            try {
                if (item.publishedLabel === null || item.publishedLabel.split(":")[0] !== "up" || flair)
                    await this.publisher.moderate(item.cid!, { flairs: flair ? [flair] : [] });
                await this.publisher.edit(item.cid!, this.contentFor(item));
            } catch (error) {
                if (!(error instanceof PublishRejected)) throw error;
                this.log(`label of ${item.redditId} rejected: ${error.message}`);
            }
            this.db.update(this.subreddit, item.redditId, { publishedLabel: labelOf(item) });
            done++;
        }
        return done;
    }
}
