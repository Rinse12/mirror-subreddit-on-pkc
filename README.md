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

As a service on the community node's machine (`loginctl enable-linger $USER` keeps it running while logged out):

```bash
cp deploy/subreddit-mirror.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now subreddit-mirror
journalctl --user -u subreddit-mirror -f
```

The service assumes the repo is at `~/pkc_community_mirroring_subreddit` and node comes from nvm; adjust `WorkingDirectory` and `PATH` if not.

Mirrors subreddits onto Bitsocial communities. One daemon, one config file, any number of `subreddit → community` pairs. It copies posts and their comment trees, keeps them up to date, and notices when Reddit removes something. The Bitsocial copy stays up and records who removed it and roughly when.

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
        }
    ],
    "backends": {
        "redlib": { "instances": ["http://localhost:8080"] },
        "reddit-json": { "userAgent": "pkc-mirror/0.1" },
        "arctic-shift": { "baseUrl": "https://arctic-shift.photon-reddit.com" },
        "pullpush": { "baseUrl": "https://api.pullpush.io" }
    }
}
```

- `rpcSshHost` / `nodeDir`: the community node's ssh host and an absolute directory there for the sort files. Leave both out to run on the node's machine and use `rpcUrl` (default `ws://localhost:9138`).
- `communityAddress`: optional. Set it to mirror into a community already hosted on the RPC node. Leave it out and the daemon creates one on first run and keeps its address in `state.sqlite`.
- `authorDeleted`: `"hide"` (default) or `"keep"`, see [Removal detection](#removal-detection).
- `maxCommentsPerPost`: optional. Unset or `null` means no cap. When set, the highest-scored comments are published, plus every removed comment whose text was captured.
- `skipAuthors`: Reddit accounts whose comments aren't mirrored, case-insensitive. Default `["AutoModerator"]`; see [What gets mirrored](#what-gets-mirrored).

## Runtime layout

- One long-running daemon (`Type=simple` systemd user service, `Restart=always`) handles every mirror.
- It runs where Reddit can be reached (e.g. a machine next to a Redlib instance), not necessarily where the community node runs. With `rpcSshHost` set, it reaches the node's RPC through an ssh tunnel (as onlycats-poster does), pushes the page sort files to `<nodeDir>/sorts/` on that host at startup, and pushes each community's sort data to `<nodeDir>/sort-data/` after writing it (rsync over ssh). If the tunnel dies the daemon exits and systemd restarts it. Without `rpcSshHost` it connects to `rpcUrl` directly and the sorts read the local files.
- State lives in one `data/state.sqlite` (`better-sqlite3`, WAL mode) shared by all mirrors. Each row is tagged with its mirror.
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

Bitsocial users reply **natively** next to the mirrored comments. When a Reddit thread gets locked or nuked, the conversation can continue here.

A publication that pkc-js *rejects* (e.g. over its 40 kB publication limit) is marked `failed` in the database and logged, not retried. Network errors and timeouts are retried. A thread that no live source can load (e.g. a Redlib 404) is retried 10 min later, without holding up the other threads due for a check.

## Scores: custom page sorts, not copied numbers

Reddit scores aren't copied into Bitsocial votes. Votes on the community stay native. Instead, the community runs custom page sorts (pkc-js `settings.pages`, the same mechanism as [@pkcprotocol/active-page-sort](../active-page-sort)).

Sorts published by each mirror community:

| Scope | Sort | Order |
|---|---|---|
| posts | `mirrored-reddit-hot` (preloaded, the default view) | Reddit's hot formula on `redditScore + nativeWeight × nativeVotes` |
| posts | `mirrored-reddit-new` | Reddit creation time |
| posts | `removed-first` | posts removed on Reddit first, then `mirrored-reddit-hot` |
| replies | `mirrored-reddit-best` | Reddit score plus native votes |

- `nativeWeight` is a public option, default `"1"`.
- Native Bitsocial posts have no Reddit data. They are scored with the same formulas from their native votes and Bitsocial timestamp, so they mix in instead of sinking.
- Custom names keep the order on the client: bitsocial-react-hooks keeps a sort file's page order and only re-sorts built-in sorts (`src/lib/page-sorts.ts`, `isBuiltInPostSortType`).

**Where the scores come from.** A page sort's `score()` is synchronous and gets no database access. So the daemon writes `data/sort-data/<communityAddress>.json`, `{ "<cid>": { "score", "createdUtc", "removedBy"? } }`, atomically (temp file + rename) whenever scores change. Each sort file holds a module-level `Map` that it refreshes from that file every 60 s *outside* `score()`, and `score()` only looks the cid up. The file's path is a private option, so it isn't published in `community.pageSorts`. This assumes clients don't re-sort these pages themselves, and that the file reaches the community node's filesystem (directly, or pushed with `rpcSshHost`). Post pages are rebuilt at least every 15 min, so Reddit scores show up on the community with at most that much lag.

**Reply pages and update cost.** A comment's reply pages are part of its CommentUpdate, which pkc-js only recalculates when the comment is flagged. It is flagged by a new vote, edit, moderation or reply on it, by a change below it in the thread, and also whenever *any other comment by the same author* is flagged, because CommentUpdates carry per-author aggregates. Every mirrored item has the bot as its author, so as long as the mirror publishes anything (a new reply, a label), every mirrored CommentUpdate is recalculated in that cycle, reply pages included, with the sort data current at that moment. Reply order therefore keeps up with Reddit scores while a subreddit is active. The cost is that each update cycle recalculates every mirrored item, so the node's work per cycle grows with the total number of items mirrored into the community.

## Removal detection

The core feature, and it applies to **mirrored replies as much as to mirrored posts**. A thread that stays up while moderators quietly remove half its comments is the common case.

**Capture first.** A removal is only worth showing if the text was saved before it went. Redlib has no subreddit-wide comment feed, so new comments are found by re-reading every active thread (posts younger than `commentUpdateDays`) on the re-check schedule below; the same read that confirms removals finds new comments. Arctic Shift's comment search is polled every few minutes as a second feed, to catch comments removed between two reads. Everything is saved locally on sight, separate from publishing it. Comments removed before either source saw them (AutoMod) are lost.

**Re-checks.** Every mirrored post and reply is re-checked on a schedule that slows down with age: every 10 min for the first 6 h, hourly until day 2, then daily until `commentUpdateDays`.

- Re-checks use Reddit's batched lookup by ID (`/api/info`, 100 IDs per request) when it is reachable.
- Otherwise the thread is re-read through Redlib, following its "More replies" links. Redlib leaves removed and author-deleted comments out entirely, with no `[removed]` marker. A reply gone from the thread page is recorded as **`missing`**, and its own permalink is then loaded: if the comment isn't there either, it is gone. A comment that is only collapsed is never flaired.

For each item it records:

- **Who removed it**, as precisely as the source allows:
  - `reddit-json` posts: Reddit's `removed_by_category` (`moderator`, `automod_filtered`, `reddit` / `anti_evil_ops` (admins), `copyright_takedown`, `deleted` (the author)).
  - `reddit-json` comments: `[removed]` (mods/admins) vs `[deleted]` (author).
  - Redlib posts: `[removed]`, and "moderator" when Reddit replaced the title with `[ Removed by moderator ]`.
  - Redlib comments: only that it is gone; removed and author-deleted look the same. If Arctic Shift's 36 h re-check later labels it `removed` or `deleted`, the precise label replaces the vague one.
    - Arctic Shift saves a comment within seconds and loads it once more about 36 h later; if it is gone then, `_meta.removal_type` says `removed` or `deleted`. A comment already `[removed]` when it was first saved was removed by AutoMod or a filter.
    - **Limits:** the label arrives about 36 h after posting; a comment removed after that re-check is never labelled; and since about 2026-10-15 Arctic Shift records no `removal_type` at all ([arctic_shift#90](https://github.com/ArthurHeitmann/arctic_shift/issues/90)), so until it recovers, vanished comments keep `Removed or deleted on Reddit`.
    - The removal *time window* never depends on Arctic Shift: it comes from the daemon's own checks (`lastSeenUpAt`, `goneSeenAt`). Only *who* removed it comes later.
- **When**, as a window between the last check that saw it up and the first check that saw it gone: `removed by moderators between 14:00 and 14:10 UTC, 3 h 12 min after posting`. The window is as precise as the re-check schedule; the doc shown to users says it is a window.
- Whether it was **locked** instead of removed.

How it shows up on the community, for posts and replies alike:

1. A **flair** set by the bot as moderator, and cleared again if Reddit restores the item. Removal flairs: `Removed by mods on Reddit`, `Removed by Reddit admins`, `Removed on Reddit` (mods or admins, not which), `Removed or deleted on Reddit` (a comment that vanished from Redlib, until a precise label arrives), `Deleted by author on Reddit`, `Locked on Reddit`. pkc-js doesn't let moderators lock replies, so for a reply "locked" is only a flair.
2. A **removal note in the mirrored comment itself.** The bot signed the comment, so it publishes a CommentEdit that appends a line: who removed it, the time window, how long after posting, and the last score (plus, for a post, the comment count) seen before removal. Editing in place keeps a removed reply's note next to the reply instead of adding a bot reply under every removed comment.
3. Items **deleted by their author** are flagged but not highlighted. With `authorDeleted: "hide"` (default) the text is edited down to `[deleted by author on Reddit]`. With `"keep"` it stays. The author chose to delete, which is a different case from moderator removal. A comment only known as "removed or deleted" stays visible until a source says which.

## Fetch backends

Behind one interface (`listNew`, `fetchThread`, `checkIds`), so the rest of the daemon doesn't care where data comes from:

- **`redlib`**: an array of Redlib instances. Redlib has no JSON API: it renders Reddit's `.json` as HTML, which the daemon parses with cheerio (tested against snapshots of Redlib 0.40.0 in `tests/fixtures/`). Bodies come as rendered HTML and are converted back to markdown with turndown, with Redlib's proxied links (`/img/`, `/preview/pre/`, `/vid/`, …) mapped back to `i.redd.it`, `preview.redd.it`, `v.redd.it`, …. Markdown from Arctic Shift or `reddit-json` replaces the converted text when available. An instance that times out, returns 429 or an error page goes on a cooldown (1 min, doubling up to 1 h) and the next one is tried.
- **`reddit-json`**: the unauthenticated `.json` endpoints. The last resort for listings, and the preferred way to re-check by ID.
- **`arctic-shift`**: archive API. In v1 a second feed of new comments, a source of original markdown, and of `removal_type` for comments Redlib can only call gone. It saves items within seconds normally (1–2 days behind since mid-Oct 2026), and re-checks only once, at 36 h, so it can't time removals itself.

- **`pullpush`**: archive API, a fallback source of text only, asked when a comment vanished and neither our reads nor Arctic Shift saved it. It saves items within seconds but never re-checks them, so it can't say who removed something.

**Repeat lookups.** The Arctic Shift comment feed keeps a cursor, so no comment is fetched twice. Text for an item we lack is looked up at most 3 times. Who removed a vanished comment is asked at most 3 times, a day apart: Arctic Shift re-checks each comment only once, so asking more often gains nothing.

**Rate limits.** Every host gets its own throttle: one request at a time, a minimum spacing, and a backoff when it pushes back (429, or Arctic Shift's 422 "Maybe slow down a bit"). The backoff lasts as long as the host's `X-RateLimit-Reset` / `Retry-After` says, else 1 min doubling up to 1 h, and requests during it fail at once so the caller can use another source.

| Host | Its limit | Spacing | Expected use (one mirror) |
|---|---|---|---|
| Redlib (own instance) | none | 1 s | ~20 thread reads per 10 min at peak |
| `reddit-json` | ~10/min unauthenticated | 6 s | fallback only |
| Arctic Shift | dynamic; "a couple requests per second" is fine | 2 s | ~30–60/h: comment feed every 2–3 min, batched lookups of up to 500 ids |
| PullPush | 15/min soft, 30/min hard, 1000/h (as its homepage used to state; not re-verified) | 4 s | a few per hour, batched 100 ids |

Reddit's official API has paid tiers and terms that don't allow this use.

**Reddit is closing its public Data API** (no new access after Oct 31 2026, unregistered apps cut from Jan 12 2027, closed by March 2027). Redlib, `reddit-json` and Arctic Shift all depend on it. The backend interface is there so a new source (e.g. an `old.reddit.com` HTML scraper) can be added without touching the rest. Whatever happens to live fetching, the community keeps what was captured and its native discussion.

Reddit IDs are stored as strings with their `t1_` / `t3_` prefix and no assumed length (comment IDs became 13 characters in Oct 2026).

## TODO / later

- **Backfill**: archives (Arctic Shift, Pushshift dumps) let a new mirror start with the subreddit's history, and let it mirror **subreddits Reddit has banned**, which no live fetch can reach. Backfilled posts are marked `archived`. Where the archive kept the text the live site later removed, the removal flair applies the same way, with "time unknown" if the archive doesn't date it.
- **Thread summary**: when replies inside a thread are removed, the bot keeps one pinned reply on the post up to date (`14 of 230 comments removed by mods on Reddit so far`, with links to each).
- **Takedown command** for copyright or personal-data requests about a single mirrored item.
- **Claiming**: a Reddit user posts a code from their Reddit account and from then on gets a `verified u/name` flair on their native Bitsocial posts.
- Two-way: nothing is ever posted *back* to Reddit. Keep it that way.
- Optional: posting removal events to a Telegram channel through the Bitsocial Telegram bots.
