import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ItemKind = "post" | "comment";
// up: last check saw it. missing: gone from a thread page, not yet confirmed (see README, Removal detection)
export type ItemStatus = "up" | "missing" | "removed" | "deleted" | "locked";
// skipped: a comment by one of skipAuthors, or an archived comment whose text the archive lost: never published,
// replies to it go under the nearest mirrored ancestor
export type PublishStatus = "pending" | "published" | "failed" | "skipped";
// live: seen on Reddit by the daemon. archive: backfilled from Arctic Shift, so its removal window is the archive's
// two reads and its note says so
export type ItemOrigin = "live" | "archive";

export interface Item {
    subreddit: string;
    // With its t1_/t3_ prefix; no fixed length
    redditId: string;
    kind: ItemKind;
    // t3_ id of the post the item belongs to (itself for a post), and the t1_/t3_ id it replies to
    postId: string;
    parentId: string | null;
    author: string;
    createdUtc: number;
    title: string | null;
    // null when the text was never captured (removed before anyone saw it)
    body: string | null;
    link: string | null;
    permalink: string;
    // null until a source shows it (Redlib hides new comments' scores in some subreddits)
    score: number | null;
    numComments: number | null;
    status: ItemStatus;
    // removed_by_category when Reddit gave one; "removed" or "deleted" from a placeholder; "gone" when the
    // comment just vanished and nothing said who removed it
    removedBy: string | null;
    // The removal window: last check that saw it up, first check that saw it gone (unix seconds)
    lastSeenUpAt: number;
    goneSeenAt: number | null;
    // Posts only: when to re-read the thread (which re-checks the post and all its comments)
    nextCheckAt: number | null;
    // Archive lookups made for text we don't have
    textLookups: number;
    // Arctic Shift lookups for who removed a vanished comment, and when the last one was
    labelLookups: number;
    labelCheckedAt: number | null;
    cid: string | null;
    publishStatus: PublishStatus;
    publishError: string | null;
    // The label already shown on the community (flair and note), "<status>:<removedBy>", so changes go out once
    publishedLabel: string | null;
    origin: ItemOrigin;
}

export interface MirrorState {
    subreddit: string;
    communityAddress: string | null;
    // The bot's author flair is set by a moderation on one of its comments, once
    authorFlairSet: number;
    // Arctic Shift comment feed position (created_utc of the newest comment seen)
    arcticCursor: number;
    // Backfill position: the created_utc the next page of archived posts must be older than; null before the first
    // page. Done once it is at or below backfillSince.
    backfillCursor: number | null;
}

export const labelOf = (item: Pick<Item, "status" | "removedBy">) => `${item.status}:${item.removedBy ?? ""}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
    subreddit TEXT NOT NULL,
    redditId TEXT NOT NULL,
    kind TEXT NOT NULL,
    postId TEXT NOT NULL,
    parentId TEXT,
    author TEXT NOT NULL,
    createdUtc INTEGER NOT NULL,
    title TEXT,
    body TEXT,
    link TEXT,
    permalink TEXT NOT NULL,
    score INTEGER,
    numComments INTEGER,
    status TEXT NOT NULL,
    removedBy TEXT,
    lastSeenUpAt INTEGER NOT NULL,
    goneSeenAt INTEGER,
    nextCheckAt INTEGER,
    textLookups INTEGER NOT NULL DEFAULT 0,
    labelLookups INTEGER NOT NULL DEFAULT 0,
    labelCheckedAt INTEGER,
    cid TEXT UNIQUE,
    publishStatus TEXT NOT NULL DEFAULT 'pending',
    publishError TEXT,
    publishedLabel TEXT,
    origin TEXT NOT NULL DEFAULT 'live',
    PRIMARY KEY (subreddit, redditId)
);
CREATE INDEX IF NOT EXISTS items_next_check ON items (nextCheckAt) WHERE nextCheckAt IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_publish ON items (subreddit, publishStatus, createdUtc);
CREATE INDEX IF NOT EXISTS items_post ON items (subreddit, postId);
CREATE TABLE IF NOT EXISTS mirrors (
    subreddit TEXT PRIMARY KEY,
    communityAddress TEXT,
    authorFlairSet INTEGER NOT NULL DEFAULT 0,
    arcticCursor INTEGER NOT NULL DEFAULT 0,
    backfillCursor INTEGER
);
`;

// Columns added after the first release, for databases created before them
const MIGRATIONS: [table: string, column: string, definition: string][] = [
    ["items", "origin", "TEXT NOT NULL DEFAULT 'live'"],
    ["mirrors", "backfillCursor", "INTEGER"]
];

const COLUMNS: (keyof Item)[] = [
    "subreddit",
    "redditId",
    "kind",
    "postId",
    "parentId",
    "author",
    "createdUtc",
    "title",
    "body",
    "link",
    "permalink",
    "score",
    "numComments",
    "status",
    "removedBy",
    "lastSeenUpAt",
    "goneSeenAt",
    "nextCheckAt",
    "textLookups",
    "labelLookups",
    "labelCheckedAt",
    "cid",
    "publishStatus",
    "publishError",
    "publishedLabel",
    "origin"
];

export class StateDb {
    readonly db: Database.Database;

    constructor(file: string) {
        if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new Database(file);
        // WAL lets the daemon keep writing while it is read
        this.db.pragma("journal_mode = WAL");
        this.db.exec(SCHEMA);
        for (const [table, column, definition] of MIGRATIONS) {
            const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
            if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    }

    close() {
        this.db.close();
    }

    get(subreddit: string, redditId: string): Item | undefined {
        return this.db.prepare("SELECT * FROM items WHERE subreddit = ? AND redditId = ?").get(subreddit, redditId) as Item | undefined;
    }

    insert(item: Item): void {
        this.db.prepare(`INSERT INTO items (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => "@" + c).join(", ")})`).run(item);
    }

    update(subreddit: string, redditId: string, changes: Partial<Omit<Item, "subreddit" | "redditId">>): void {
        const keys = Object.keys(changes);
        if (!keys.length) return;
        this.db
            .prepare(`UPDATE items SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE subreddit = @subreddit AND redditId = @redditId`)
            .run({ ...changes, subreddit, redditId });
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    duePosts(subreddit: string, now: number, limit: number): Item[] {
        return this.db
            .prepare("SELECT * FROM items WHERE subreddit = ? AND kind = 'post' AND nextCheckAt <= ? ORDER BY nextCheckAt LIMIT ?")
            .all(subreddit, now, limit) as Item[];
    }

    commentsOf(subreddit: string, postId: string): Item[] {
        return this.db
            .prepare("SELECT * FROM items WHERE subreddit = ? AND postId = ? AND kind = 'comment'")
            .all(subreddit, postId) as Item[];
    }

    // Pending items whose parent is already published (or that are posts). Live items oldest first, then backfilled ones
    // newest first, so what happens on Reddit now never waits behind history, and history fills in from the present back
    publishable(subreddit: string, limit: number): Item[] {
        return this.db
            .prepare(
                `SELECT i.* FROM items i
                 LEFT JOIN items p ON p.subreddit = i.subreddit AND p.redditId = i.parentId
                 WHERE i.subreddit = ? AND i.publishStatus = 'pending'
                   AND (i.kind = 'post' OR p.publishStatus IN ('published', 'skipped'))
                 ORDER BY i.origin = 'archive', CASE WHEN i.origin = 'archive' THEN -i.createdUtc ELSE i.createdUtc END LIMIT ?`
            )
            .all(subreddit, limit) as Item[];
    }

    // Comments by these authors that aren't marked skipped yet
    unskipped(subreddit: string, authors: string[]): Item[] {
        if (!authors.length) return [];
        return this.db
            .prepare(
                `SELECT * FROM items WHERE subreddit = ? AND kind = 'comment' AND publishStatus != 'skipped'
                   AND lower(author) IN (${authors.map(() => "?").join(", ")})`
            )
            .all(subreddit, ...authors.map((a) => a.toLowerCase())) as Item[];
    }

    // Every reply under an item, at any depth
    replyTree(subreddit: string, redditId: string): Item[] {
        return this.db
            .prepare(
                `WITH RECURSIVE tree(redditId) AS (
                     SELECT redditId FROM items WHERE subreddit = ? AND parentId = ?
                     UNION SELECT i.redditId FROM items i JOIN tree t ON i.parentId = t.redditId WHERE i.subreddit = ?
                 )
                 SELECT i.* FROM items i JOIN tree t ON i.redditId = t.redditId WHERE i.subreddit = ?`
            )
            .all(subreddit, redditId, subreddit, subreddit) as Item[];
    }

    publishedPosts(subreddit: string): Item[] {
        return this.db
            .prepare("SELECT * FROM items WHERE subreddit = ? AND kind = 'post' AND publishStatus = 'published' ORDER BY createdUtc")
            .all(subreddit) as Item[];
    }

    // Puts a post and every published reply in its thread back in the publish queue, as if never published
    unpublishThread(subreddit: string, postId: string): void {
        this.db
            .prepare(
                "UPDATE items SET publishStatus = 'pending', cid = NULL, publishedLabel = NULL WHERE subreddit = ? AND postId = ? AND publishStatus = 'published'"
            )
            .run(subreddit, postId);
    }

    publishedCommentCount(subreddit: string, postId: string): number {
        return (
            this.db
                .prepare(
                    "SELECT COUNT(*) AS n FROM items WHERE subreddit = ? AND postId = ? AND kind = 'comment' AND publishStatus = 'published'"
                )
                .get(subreddit, postId) as { n: number }
        ).n;
    }

    // Published items whose shown label lags behind what the checks found; an unconfirmed missing item waits
    labelsToPublish(subreddit: string, limit: number): Item[] {
        return this.db
            .prepare(
                `SELECT * FROM items WHERE subreddit = ? AND publishStatus = 'published' AND status != 'missing'
                   AND publishedLabel IS NOT (status || ':' || COALESCE(removedBy, '')) ORDER BY createdUtc LIMIT ?`
            )
            .all(subreddit, limit) as Item[];
    }

    // Comments that vanished without anyone saying who removed them, old enough for Arctic Shift's 36 h re-check,
    // asked about at most maxLookups times and not since checkedBefore
    unlabelledGone(subreddit: string, createdBefore: number, maxLookups: number, checkedBefore: number, limit: number): Item[] {
        return this.db
            .prepare(
                `SELECT * FROM items WHERE subreddit = ? AND kind = 'comment' AND status = 'removed' AND removedBy = 'gone'
                   AND createdUtc < ? AND labelLookups < ? AND (labelCheckedAt IS NULL OR labelCheckedAt < ?) LIMIT ?`
            )
            .all(subreddit, createdBefore, maxLookups, checkedBefore, limit) as Item[];
    }

    missingText(subreddit: string, maxLookups: number, limit: number): Item[] {
        return this.db
            .prepare(
                `SELECT * FROM items WHERE subreddit = ? AND body IS NULL AND status IN ('removed', 'deleted') AND textLookups < ?
                 ORDER BY createdUtc DESC LIMIT ?`
            )
            .all(subreddit, maxLookups, limit) as Item[];
    }

    publishedForSortData(subreddit: string): Pick<Item, "cid" | "score" | "createdUtc" | "status" | "removedBy" | "goneSeenAt">[] {
        return this.db
            .prepare("SELECT cid, score, createdUtc, status, removedBy, goneSeenAt FROM items WHERE subreddit = ? AND cid IS NOT NULL")
            .all(subreddit) as Pick<Item, "cid" | "score" | "createdUtc" | "status" | "removedBy" | "goneSeenAt">[];
    }

    mirror(subreddit: string): MirrorState {
        this.db.prepare("INSERT OR IGNORE INTO mirrors (subreddit) VALUES (?)").run(subreddit);
        return this.db.prepare("SELECT * FROM mirrors WHERE subreddit = ?").get(subreddit) as MirrorState;
    }

    updateMirror(subreddit: string, changes: Partial<Omit<MirrorState, "subreddit">>): void {
        this.mirror(subreddit);
        const keys = Object.keys(changes);
        if (!keys.length) return;
        this.db
            .prepare(`UPDATE mirrors SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE subreddit = @subreddit`)
            .run({ ...changes, subreddit });
    }
}
