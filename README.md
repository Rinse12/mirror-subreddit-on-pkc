# pkc_community_mirroring_subreddit

## Running

```bash
npm install
cp config.example.json config.json   # edit: subreddit, Redlib instances
npm run create-signer                # one bot key per mirror, in data/signers/
npm run dry-run                      # fetches and records into data/dry-run.sqlite, logs what it would publish
npm start                            # the real thing: needs the community node's RPC at rpcUrl
npm run republish                    # daemon stopped: purges every mirrored post and queues it again, after a format change
```

A mirror with `backfillSince` set also mirrors the subreddit's history from Arctic Shift, inside the same daemon (see [Backfill](#backfill)).

As a service on the community node's machine (`loginctl enable-linger $USER` keeps it running while logged out):

```bash
cp deploy/subreddit-mirror.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now subreddit-mirror
journalctl --user -u subreddit-mirror -f
```

The service assumes the repo is at `~/pkc_community_mirroring_subreddit` and node comes from nvm; adjust `WorkingDirectory` and `PATH` if not. The daemon exits when its ssh tunnel to the node dies (it has, on a server-side ssh restart), so the service's `Restart=always` is what keeps a mirror running unattended.

Mirrors subreddits onto Bitsocial communities. One daemon, one config file, any number of `subreddit → community` pairs. It copies posts and their comment trees, keeps them up to date, and notices when Reddit removes something. The Bitsocial copy stays up and records who removed it and roughly when.

A community can also open on **what Reddit removed**: with `hotSort: "removed-only"` its default page lists only the posts that were removed or have a removed reply, busiest first, and every thread has a flat page of just its removed replies. The r/AskHistorians entry in `config.example.json` is set up that way, with a backfill of the year's removals. It is a view over an ordinary full mirror, done with page sorts that filter on the removal flairs: the same community still has every post under `new`, and the removed items sit in their threads, flaired and annotated, next to what survived. A community that should hold _only_ the removed items (and the posts and parent comments they sat under) is a **removed-only mirror**, `publish: "removed-only"`, see [Publish modes](#publish-modes). A **banned subreddit** is mirrored from the archive alone with `archiveOnly`, see [Backfill](#backfill).

## Config

`config.json`, validated with zod at startup.

```json
{
    "rpcSshHost": "my-node",
    "nodeDir": "/root/subreddit-mirror",
    "mirrors": [
        {
            "subreddit": "AskScience",
            "signerPath": "data/signers/askscience.json",
            "commentUpdateDays": 7,
            "minScore": 0,
            "authorDeleted": "hide",
            "maxCommentsPerPost": null,
            "skipAuthors": ["AutoModerator"]
        },
        {
            "subreddit": "AskHistorians",
            "signerPath": "data/signers/askhistorians.json",
            "hotSort": "removed-only",
            "backfillSince": "2026-01-01T00:00:00Z",
            "backfillOnly": "removed"
        },
        {
            "subreddit": "NoNewNormal",
            "signerPath": "data/signers/nonewnormal.json",
            "archiveOnly": true,
            "backfillSince": "2021-01-01T00:00:00Z",
            "backfillOnly": "removed",
            "publish": "removed-only",
            "hotSort": "removed-only"
        }
    ],
    "clientUrl": "https://seedit.app",
    "backends": {
        "redlib": { "instances": ["http://localhost:8080"] },
        "reddit-json": { "userAgent": "pkc-mirror/0.1" },
        "arctic-shift": { "baseUrl": "https://arctic-shift.photon-reddit.com" },
        "pullpush": { "baseUrl": "https://api.pullpush.io" }
    }
}
```

- `rpcSshHost` / `nodeDir`: the community node's ssh host and an absolute directory there for the sort files. Leave both out to run on the node's machine and use `rpcUrl` (default `ws://localhost:9138`).
- `name`: optional, the key of the mirror's state in `state.sqlite`, the subreddit by default. Two mirrors of one subreddit (a full one and a removed-only one, say) need distinct names, and each fetches the subreddit for itself. Renaming a mirror orphans its state.
- `communityAddress`: optional. Set it to mirror into a community already hosted on the RPC node. Leave it out and the daemon creates one on first run and keeps its address in `state.sqlite`.
- `authorDeleted`: `"hide"` (default) or `"keep"`, see [Removal detection](#removal-detection).
- `maxCommentsPerPost`: optional. Unset or `null` means no cap. When set, the highest-scored comments are published, plus every removed comment whose text was captured.
- `skipAuthors`: Reddit accounts whose comments aren't mirrored, case-insensitive. Default `["AutoModerator"]`; see [What gets mirrored](#what-gets-mirrored).
- `hotSort`: what the community serves as `hot`, the page clients open on. `"reddit-hot"` (default) is Reddit's hot order; `"removed-only"` is the `flaired` filter, only what Reddit removed, busiest threads first, see [Scores](#scores-custom-page-sorts-not-copied-numbers).
- `publish`: `"all"` (default) publishes everything captured; `"removed-only"` publishes only what Reddit removed and its context, see [Publish modes](#publish-modes). `context`: with `"removed-only"`, `"ancestors"` (default) also publishes the not-removed comments between the post and a removed reply, `"post"` only the post.
- `threadSummary`: `false` by default. `true` keeps one pinned bot reply per thread that lists the replies Reddit removed in it, see [Thread summary](#thread-summary).
- `backfillSince`: optional, an ISO 8601 instant with time and zone (`"2026-01-01T00:00:00Z"`). Set it to mirror the subreddit's history from Arctic Shift back to that instant, see [Backfill](#backfill). `backfillOnly`: `"all"` (default) or `"removed"`, only the threads where something was removed. `archiveOnly`: `true` for a subreddit that can't be read live (banned); needs `backfillSince`.
- `clientUrl` (top level): the web client that links in bot replies point at, as `<clientUrl>/#/p/<community>/c/<cid>`. Default `https://seedit.app`.

## Runtime layout

- One long-running daemon (`Type=simple` systemd user service, `Restart=always`) handles every mirror.
- It runs where Reddit can be reached (e.g. a machine next to a Redlib instance), not necessarily where the community node runs. With `rpcSshHost` set, it reaches the node's RPC through an ssh tunnel (as onlycats-poster does), pushes the page sort files to `<nodeDir>/sorts/` on that host at startup, and pushes each community's sort data to `<nodeDir>/sort-data/` after writing it (rsync over ssh). If the tunnel dies the daemon exits and systemd restarts it. Without `rpcSshHost` it connects to `rpcUrl` directly and the sorts read the local files.
- State lives in one `data/state.sqlite` (`better-sqlite3`, WAL mode) shared by all mirrors. Each row is keyed by its mirror's `name`, so two mirrors of one subreddit keep separate capture and publish state.
- The daemon exports `data/sort-data/<communityAddress>.json` for the page sorts, one file per community (copied to the node with `rpcSshHost`) (see [Scores](#scores-custom-page-sorts-not-copied-numbers)).
- Signers live in `data/signers/`, one per community.

## The community

The daemon **creates each community on first run** over RPC, owned by that mirror's bot signer, and keeps its settings in sync with the config:

- **Challenge**: the default challenge stays for native users. Every challenge gets `exclude: [{ publicKeys: [<bot key>] }]`, because pkc-js gives moderators and owners no automatic bypass and the bot publishes posts, replies, edits and moderations all the time.
- **Role**: the bot's address gets the `moderator` role, which lets it set flairs. `features.postFlairs` / `authorFlairs` stay off: flairs set by a moderator aren't checked against an allowed list, while enabling author-chosen flairs would let any native user pick `Reddit mirror`.
- **Page sorts**: `settings.pages` is set as described in [Scores](#scores-custom-page-sorts-not-copied-numbers).

## What gets mirrored

- **Posts**: title, selftext, and the link as is. Media is **not** re-uploaded. `i.redd.it`, `v.redd.it`, imgur and other links go into the post unchanged.
- **Comments**: the full tree, keeping the reply structure. Parents are published before children, oldest first. New comments are picked up for `commentUpdateDays` after a post is mirrored.
- **Author**: the Reddit username goes in `author.displayName` as `u/name`; the text is the Reddit text alone, with no header line. Each community has **one bot signer**, so every mirrored item has the bot's address and its `Reddit mirror` flair. No per-Reddit-user keys, so the mirror never looks like it is the real person.
- **Skipped authors**: comments by `skipAuthors` (default `["AutoModerator"]`) aren't mirrored, and replies to them go under the nearest mirrored ancestor. An author added later has their published comments purged, and the replies under them are published again.
- **Flair**: the bot sets its own author flair to `Reddit mirror` once, by a moderation on its first comment, so it shows next to the author of every mirrored post and reply. Native users can't fake it. Post flairs are left for the removal labels.
- **Backfilled items** (see [Backfill](#backfill)) look the same, with a `Mirrored from the Arctic Shift archive` line appended, so a reader knows the daemon never saw them live.

Bitsocial users reply **natively** next to the mirrored comments. When a Reddit thread gets locked or nuked, the conversation can continue here.

## Publish modes

`publish: "all"` (default) publishes every captured post and comment. `publish: "removed-only"` makes a community that holds **only what Reddit removed**, for a subreddit whose full mirror would be too much or isn't wanted:

- A post or comment is published once its status is `removed` (by mods, admins, or just gone), never when it is up, locked, or deleted by its author. A removed comment whose text was never captured is still published with its placeholder, as in a full mirror.
- Its **context** goes with it: the post it sits under is always published (a reply needs a post). With `context: "ancestors"` (default) so are the not-removed comments between the post and the removed reply, so it sits in its place in the thread; with `context: "post"` the removed reply hangs directly under the post. Context items look like any mirrored item, with no flair.
- Everything else is still captured and re-checked, and sits in the database: a comment removed later is published then, with the window the checks recorded.
- An item **Reddit restores** is an ordinary comment again and is handled as in a full mirror: the flair is cleared and the note dropped, and it stays on the community (purging it would take the native replies under it; the thread stays for its other removals).
- Both `hotSort` values work: `"removed-only"` lists the threads busiest first, `"reddit-hot"` puts them in Reddit's hot order.

Capture is the same in both modes. A full mirror and a removed-only mirror of the same subreddit are two entries with distinct `name`s, each with its own community, signer and state; they fetch the subreddit independently (sharing captures between mirrors is not done).

## Thread summary

Off by default (`threadSummary: true` turns it on): the bot keeps **one pinned reply per thread with removed replies**, published once and edited whenever what it would say changes (checked every 5 min). It is one line with the count (`14 of 230 comments removed on Reddit so far`, with a breakdown by remover when they differ, and a trailing count of author deletions), then one line per removed reply, most recently removed first: a link to the mirrored copy (`clientUrl`), who removed it and the window. At most 50 are listed, the rest counted. The reply is signed by the bot with the display name `r/<subreddit> mirror`, pinned by a moderation so reply sorts show it first, and has no removal flair, so it never appears on the `flaired` reply page. When every removal in a thread is restored it is edited to say so rather than purged. `npm run republish` purges it with the thread and a fresh one follows.

A publication that pkc-js _rejects_ (e.g. over its 40 kB publication limit) is marked `failed` in the database and logged, not retried. Network errors and timeouts are retried, and so is a _challenge_: the bot never answers one, and being challenged means the exclude isn't in effect for this session (seen once after a node restart, for the life of the daemon process), so the batch stops and the items stay queued. A thread that no live source can load (e.g. a Redlib 404) is retried 10 min later, without holding up the other threads due for a check.

## Scores: custom page sorts, not copied numbers

Reddit scores aren't copied into Bitsocial votes. Votes on the community stay native. Instead, the community runs custom page sorts (pkc-js `settings.pages`, the same mechanism as [@pkcprotocol/active-page-sort](../active-page-sort)).

Sorts published by each mirror community (`sorts/`, set through `settings.pages` by the daemon):

| Scope   | Wire name                           | File                                                         | Order                                                                                                                             |
| ------- | ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| posts   | `hot` (preloaded, the default view) | `hot.js`, or `flaired-hot.js` with `hotSort: "removed-only"` | Reddit's hot formula on `redditScore + nativeWeight × nativeVotes`, or the `flaired` filter below in its `hot` order              |
| posts   | `mirrored-reddit-hot`               | `mirrored-reddit-hot.js`                                     | Reddit's hot order, published only when `hot` is the filter                                                                       |
| posts   | `flaired`                           | `flaired.js`                                                 | **only** posts removed on Reddit or with a removed reply; most recently removed first                                             |
| posts   | `new`                               | `new.js`                                                     | Reddit creation time                                                                                                              |
| posts   | `removed-first`                     | `removed-first.js`                                           | posts removed on Reddit first, then Reddit's hot order                                                                            |
| posts   | `active`                            | pkc-js built-in                                              | last native reply, so a client's "active" tab isn't empty                                                                         |
| replies | `mirrored-reddit-best` (preloaded)  | `mirrored-reddit-best.js`                                    | Reddit score plus native votes                                                                                                    |
| replies | `flaired`                           | `flaired-replies.js`                                         | **only** the replies removed on Reddit, flat (a removed answer shows even when its parent is up), in `mirrored-reddit-best` order |

- `nativeWeight` is a public option, default `"1"`.
- Native Bitsocial posts have no Reddit data. They are scored with the same formulas from their native votes and Bitsocial timestamp, so they mix in instead of sinking.
- **The `flaired` filter is a flair filter, nothing Reddit-specific** (`sorts/flair-filter.js`). Its public option `flairs` lists the flair texts that count, default the four removal flairs (`Removed by mods on Reddit`, `Removed by Reddit admins`, `Removed on Reddit`, `Removed or deleted on Reddit`; author deletions and locks are left out). A comment without one of them gets `score() === null`, which pkc-js takes as "drop it from this sort's pages". The posts variant declares `requireReplies`, so it sees every descendant of a post and keeps the post when any reply is flaired; its `order` option is `"flaired"` (most recently removed first, from `flairedAt` in the sort data, falling back to the post's time), `"new"`, or `"hot"`: **busiest threads first**, the number of replies under the post, most recently removed first among equals. Votes and age play no part, so a big removed thread stays at the top until a bigger one comes along; `flaired` is the recency view. Every reply present on the community counts, mirrored (removed on Reddit or not) and native alike; replies the community removed, their author deleted, or that await approval don't. A removed-only community serves `hot` in that order and keeps the most-recently-removed order under `flaired`. Any community that flairs things can use the files; only the orders that read `flairedAt` need the daemon's data.
- **Why the built-in names.** The wire key of a sort is its file's `sortName`, and Seedit's sort menu is hard-coded to `hot`, `new`, `active` and `top`, opening on `hot` (`src/constants/sort-types.ts`); it never asks for a custom name. A community that publishes only custom names has nothing to serve a Seedit request once it outgrows one page. So the post sorts take the built-in names, and `hotSort: "removed-only"` is the one lever that makes a community _open_ on the removed view: the filter is published as `hot`. `top` is not served (nothing meaningful to put there yet).
- **What clients do with the order** (bitsocial-react-hooks 0.1.62, 2026-10-30; Seedit pins 0.1.57, same code): a post feed keeps the community's order for a path file, under a custom name or a built-in one (`isBuiltInPostSortType` is false for a `path:` entry, `src/lib/page-sorts.ts`), and for any name it has no sorter for. A _reply_ feed has no such check: a reply file published as `best` would be re-sorted by the client's own `best` (native votes only), which is why the reply sort keeps its own name. Seedit renders the preloaded reply page as the community ordered it, whatever its key, and offers no reply sort switch, so the flat `flaired` reply page is for clients that list `community.pageSorts`.

**Where the scores come from.** A page sort's `score()` is synchronous and gets no database access. So the daemon writes `data/sort-data/<communityAddress>.json`, `{ "<cid>": { "score", "createdUtc", "status", "removedBy", "flairedAt" } }` (`flairedAt`: when the daemon first saw the item gone, null while it is up), atomically (temp file + rename) whenever scores change. Each sort file holds a module-level `Map` that it refreshes from that file every 60 s _outside_ `score()`, and `score()` only looks the cid up. The file's path is a private option, so it isn't published in `community.pageSorts`. This assumes clients don't re-sort these pages themselves, and that the file reaches the community node's filesystem (directly, or pushed with `rpcSshHost`). Post pages are rebuilt at least every 15 min, so Reddit scores show up on the community with at most that much lag.

**Reply pages and update cost.** A comment's reply pages are part of its CommentUpdate, which pkc-js only recalculates when the comment is flagged. It is flagged by a new vote, edit, moderation or reply on it, by a change below it in the thread, and also whenever _any other comment by the same author_ is flagged, because CommentUpdates carry per-author aggregates. Every mirrored item has the bot as its author, so as long as the mirror publishes anything (a new reply, a label), every mirrored CommentUpdate is recalculated in that cycle, reply pages included, with the sort data current at that moment. Reply order therefore keeps up with Reddit scores while a subreddit is active. The cost is that each update cycle recalculates every mirrored item, so the node's work per cycle grows with the total number of items mirrored into the community. Changing `settings.pages` (which an upgrade that renames sorts does on the daemon's next start) regenerates every CommentUpdate once.

**Changed sort files need a restart of the node's daemon.** pkc-js imports a `path:` sort file with a plain dynamic `import()`, and Node keeps an ES module in memory for the life of the process, so the bitsocial daemon on the node runs the version of each sort file (and of every module it imports, `sort-data.js` included) it loaded first. A new file that imports a _new export_ of an old file fails to load (`ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY`, "does not provide an export named …"), and a file that once failed stays failed. After pushing changed sorts, restart the daemon on the node (`systemctl restart bitsocial` with bitsocial-cli's service) before the mirror daemon starts, or keep new code in new files (`reddit-best.js` exists for that reason).

## Removal detection

The core feature, and it applies to **mirrored replies as much as to mirrored posts**. A thread that stays up while moderators quietly remove half its comments is the common case.

**Capture first.** A removal is only worth showing if the text was saved before it went. Redlib has no subreddit-wide comment feed, so new comments are found by re-reading every active thread (posts younger than `commentUpdateDays`) on the re-check schedule below; the same read that confirms removals finds new comments. Arctic Shift's comment search is polled every few minutes as a second feed, to catch comments removed between two reads. Everything is saved locally on sight, separate from publishing it. Comments removed before either source saw them (AutoMod) are lost.

**The capture rate bounds everything on fast-moderated subreddits.** On r/AskHistorians most answers are removed within minutes of being posted. The thread re-read runs every 10 min at best, and Arctic Shift saves a comment about 2 h after posting (measured 2026-10-30; it was 1–2 days behind in mid-October). An answer removed in its first minutes is captured only when one of those reads happened to fall inside that window, so a removed-only view of such a subreddit shows a sample of the removals, not all of them, and the proportion depends on how fast the mods are. A removed comment nobody captured is still recorded (`body` null) and published as `[text not captured before it was removed]` with its flair and window, so the volume is visible even when the text isn't; the backfill skips those (see [Backfill](#backfill)).

**Re-checks.** Every mirrored post and reply is re-checked on a schedule that slows down with age: every 10 min for the first 6 h, hourly until day 2, then daily until `commentUpdateDays`.

- Re-checks use Reddit's batched lookup by ID (`/api/info`, 100 IDs per request) when it is reachable.
- Otherwise the thread is re-read through Redlib, following its "More replies" links. Redlib leaves a removed or author-deleted comment out entirely when nothing was posted under it, with no `[removed]` marker; one that still has replies stays in the tree as a tombstone (`[removed] — view removed comment`, author `u/[deleted]`), which the parser reads as removed or deleted. A reply gone from the thread page is recorded as **`missing`**, and its own permalink is then loaded: if the comment isn't there either, it is gone. A comment that is only collapsed is never flaired.

For each item it records:

- **Who removed it**, as precisely as the source allows:
    - `reddit-json` posts: Reddit's `removed_by_category` (`moderator`, `automod_filtered`, `reddit` / `anti_evil_ops` (admins), `copyright_takedown`, `deleted` (the author)).
    - `reddit-json` comments: `[removed]` (mods/admins) vs `[deleted]` (author).
    - Redlib posts: `[removed]`, and "moderator" when Reddit replaced the title with `[ Removed by moderator ]`.
    - Redlib comments: only that it is gone; removed and author-deleted look the same. If Arctic Shift's 36 h re-check later labels it `removed` or `deleted`, the precise label replaces the vague one.
        - Arctic Shift saves a comment within seconds and loads it once more about 36 h later; if it is gone then, `_meta.removal_type` says `removed` or `deleted`. A comment already `[removed]` when it was first saved was removed by AutoMod or a filter.
        - **Limits:** the label arrives about 36 h after posting (the re-check is at 36 h sharp, measured 2026-10-30), and a comment removed after that re-check is never labelled. Around 2026-10-15 Arctic Shift recorded no `removal_type` for a while; as of 2026-10-30 it does again, for posts as well as comments (`removed`, `deleted`, `reddit`), and comments from that gap keep `Removed or deleted on Reddit`.
        - The removal _time window_ never depends on Arctic Shift: it comes from the daemon's own checks (`lastSeenUpAt`, `goneSeenAt`). Only _who_ removed it comes later.
- **When**, as a window between the last check that saw it up and the first check that saw it gone: `removed by moderators between 14:00 and 14:10 UTC, 3 h 12 min after posting`. The window is as precise as the re-check schedule; the doc shown to users says it is a window. For a backfilled item the two checks are Arctic Shift's two reads, about 36 h apart.
- Whether it was **locked** instead of removed.

How it shows up on the community, for posts and replies alike:

1. A **flair** set by the bot as moderator, and cleared again if Reddit restores the item. Removal flairs: `Removed by mods on Reddit`, `Removed by Reddit admins`, `Removed on Reddit` (mods or admins, not which), `Removed or deleted on Reddit` (a comment that vanished from Redlib, until a precise label arrives), `Deleted by author on Reddit`, `Locked on Reddit`. pkc-js doesn't let moderators lock replies, so for a reply "locked" is only a flair.
2. A **removal note in the mirrored comment itself.** The bot signed the comment, so it publishes a CommentEdit that appends a line: who removed it, the time window, how long after posting, and the last score (plus, for a post, the comment count) seen before removal. Editing in place keeps a removed reply's note next to the reply instead of adding a bot reply under every removed comment.
3. Items **deleted by their author** are flagged but not highlighted. With `authorDeleted: "hide"` (default) the text is edited down to `[deleted by author on Reddit]`. With `"keep"` it stays. The author chose to delete, which is a different case from moderator removal. A comment only known as "removed or deleted" stays visible until a source says which.

## Fetch backends

Behind one interface (`listNew`, `fetchThread`, `checkIds`), so the rest of the daemon doesn't care where data comes from:

- **`redlib`**: an array of Redlib instances. Redlib has no JSON API: it renders Reddit's `.json` as HTML, which the daemon parses with cheerio (tested against snapshots of Redlib 0.40.0 in `tests/fixtures/`). Bodies come as rendered HTML and are converted back to markdown with turndown, with Redlib's proxied links (`/img/`, `/preview/pre/`, `/vid/`, …) mapped back to `i.redd.it`, `preview.redd.it`, `v.redd.it`, …. Markdown from Arctic Shift or `reddit-json` replaces the converted text when available. An instance that times out, returns 429 or an error page goes on a cooldown (1 min, doubling up to 1 h) and the next one is tried.
- **`reddit-json`**: the unauthenticated `.json` endpoints. The last resort for listings, and the preferred way to re-check by ID.
- **`arctic-shift`**: archive API. A second feed of new comments, a source of original markdown, of `removal_type` for comments Redlib can only call gone, and the source of the [backfill](#backfill). It saves items about 2 h after posting (measured 2026-10-30; 1–2 days behind in mid-October 2026) and re-reads each one once, 36 h after posting, so on its own it can only time a removal to that 36 h window. `/api/{posts,comments}/search` pages by 100 with exclusive `before` / `after` bounds on `created_utc`; `/api/{posts,comments}/ids` takes 500 ids.

- **`pullpush`**: archive API, a fallback source of text only, asked when a comment vanished and neither our reads nor Arctic Shift saved it. It saves items within seconds but never re-checks them, so it can't say who removed something.

**Repeat lookups.** The Arctic Shift comment feed keeps a cursor, so no comment is fetched twice. Text for an item we lack is looked up at most 3 times. Who removed a vanished comment is asked at most 3 times, a day apart: Arctic Shift re-checks each comment only once, so asking more often gains nothing.

**Rate limits.** Every host gets its own throttle: one request at a time, a minimum spacing, and a backoff when it pushes back (429, or Arctic Shift's 422 "Maybe slow down a bit"). The backoff lasts as long as the host's `X-RateLimit-Reset` / `Retry-After` says, else 1 min doubling up to 1 h, and requests during it fail at once so the caller can use another source.

| Host                  | Its limit                                                                         | Spacing | Expected use (one mirror)                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redlib (own instance) | none                                                                              | 1 s     | ~20 thread reads per 10 min at peak                                                                                                                   |
| `reddit-json`         | ~10/min unauthenticated                                                           | 6 s     | fallback only                                                                                                                                         |
| Arctic Shift          | dynamic; "a couple requests per second" is fine                                   | 2 s     | ~30–60/h: comment feed every 2–3 min, batched lookups of up to 500 ids; while backfilling, 1 request per archived post plus 1 per 100 of its comments |
| PullPush              | 15/min soft, 30/min hard, 1000/h (as its homepage used to state; not re-verified) | 4 s     | a few per hour, batched 100 ids                                                                                                                       |

Reddit's official API has paid tiers and terms that don't allow this use.

**Reddit is closing its public Data API** (no new access after Oct 31 2026, unregistered apps cut from Jan 12 2027, closed by March 2027). Redlib, `reddit-json` and Arctic Shift all depend on it. The backend interface is there so a new source (e.g. an `old.reddit.com` HTML scraper) can be added without touching the rest. Whatever happens to live fetching, the community keeps what was captured and its native discussion.

Reddit IDs are stored as strings with their `t1_` / `t3_` prefix and no assumed length (comment IDs became 13 characters in Oct 2026).

## Backfill

With `backfillSince` set, the daemon also mirrors the subreddit's history from Arctic Shift, so a new community is interesting on day one and the removals of the past months are there to browse. A `backfill` task runs between the live tasks, a few archived posts per tick, and the live path is never held up by it: live items are published before backfilled ones, and history is published newest first.

- **Walk**: `/api/posts/search` by subreddit, newest first, from now back to `backfillSince`, 100 posts a page, then every comment of each thread (`/api/comments/search?link_id=`). The position (`backfillCursor`, the `created_utc` the next page must be older than) is in the `mirrors` table, so a restart resumes and the backfill is done once the cursor reaches `backfillSince`. Lowering `backfillSince` later continues from where it stopped. A thread the live path already knows is left alone; `minScore`, `maxCommentsPerPost` and `skipAuthors` apply as they do live.
- **`backfillOnly: "removed"`**: only threads where the post was removed, or a comment whose text the archive kept was. Every thread still costs one comments request to find out, but only the threads with removals are published. The default `"all"` mirrors every thread in the window; a year of a large subreddit is a lot of items, and each one adds to the node's per-cycle cost (see [Scores](#scores-custom-page-sorts-not-copied-numbers)).
- **What was removed, and when**: taken from the archive alone, never from a live re-check (`/api/info` at 6 s per 100 ids is too slow for a year of comments, and Reddit's API is closing). Arctic Shift reads an item about 2 h after posting and again 36 h after; `_meta.removal_type` (`removed`, `deleted`, `reddit`) says what the second read found. A removed item whose first read kept the text is published with its removal flair and the note `Mirrored from the Arctic Shift archive. Removed on Reddit between <first read> and <second read> UTC, …`, the honest window. A removed comment already `[removed]` at the first read has no text and is recorded but **not published** (its replies hang under the nearest published ancestor, like replies to a skipped author). A removed post keeps its title, so it is published even when the archive only has `[removed]` for its text, with the window `within N min of posting`; on r/AskHistorians the question is the title, and a quickly removed question is the common case. Author deletions follow `authorDeleted`. Threads the archive hasn't re-read yet (younger than 36 h) go into the live re-check queue instead, so they get the daemon's own window.
- **Every backfilled item** carries the `Mirrored from the Arctic Shift archive` line, removed or not. It is not marked with pkc-js's `archived` moderation flag: that flag rejects every new publication under the post, and native replies under old threads are half the point.
- **Banned subreddits** (`archiveOnly: true`, with `backfillSince`): nothing in the walk touches Reddit, so a subreddit Reddit took down is mirrored from the archive alone. An archive-only mirror runs no post discovery, no thread re-checks and no Arctic Shift comment feed, and never puts a thread in the live re-check queue: a thread the archive hadn't re-read (younger than 36 h when archived, or banned before the second read) is published from the first read, with no removal window. Text lookups, removal labels, publishing and the sort data run as usual. The walk goes from the daemon's first start back to `backfillSince`, once; posts archived after that first start are never seen, which is fine for a banned subreddit and wrong for a live one you merely can't reach (see TODO).
- Not done: Pushshift dumps as a source.

## TODO / later

- **Forward walk for archive-only mirrors**: an archive-only mirror of a subreddit that still gets posts (quarantined, or unreachable live) would need the walk to also look for posts archived after its first start, e.g. a second cursor that moves forward from the start time whenever the backward walk is done.
- **Shared captures**: two mirrors of one subreddit fetch it twice; capture once per subreddit and publish per mirror.
- **Takedown command** for copyright or personal-data requests about a single mirrored item.
- **Claiming**: a Reddit user posts a code from their Reddit account and from then on gets a `verified u/name` flair on their native Bitsocial posts.
- Two-way: nothing is ever posted _back_ to Reddit. Keep it that way.
- Optional: posting removal events to a Telegram channel through the Bitsocial Telegram bots.
