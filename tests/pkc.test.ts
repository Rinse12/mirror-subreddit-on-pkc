import { describe, expect, it } from "vitest";
import { communityDescription, communityEdit, hostedAddresses, pageSettings, publishAndWait, PublishRejected } from "../src/pkc.js";

const BOT = "12D3KooWBot";
const FILE = "/srv/mirror/data/sort-data/c.json";
const question = { name: "question", options: { answer: "secret" } };

type Entry = ReturnType<typeof pageSettings>["posts"][number];
const isFile = (entry: Entry): entry is Exclude<Entry, { name: string }> => "path" in entry;
const files = (entries: Entry[]) => entries.filter(isFile);
const named = (entries: Entry[]) => entries.map((e) => (isFile(e) ? [e.path.split("/").pop(), e.preloaded] : [e.name, "built-in"]));

describe("communityEdit", () => {
    it("makes the bot a moderator, exempts it from every challenge and sets the sorts", () => {
        const edit = communityEdit(
            { roles: { "12D3KooWOwner": { role: "owner" } }, settings: { challenges: [question], fetchThumbnailUrls: true } },
            BOT,
            FILE
        );
        expect(edit?.roles).toEqual({ "12D3KooWOwner": { role: "owner" }, [BOT]: { role: "moderator" } });
        expect(edit?.settings?.challenges).toEqual([{ ...question, exclude: [{ publicKeys: [BOT] }] }]);
        expect(edit?.settings?.fetchThumbnailUrls).toBe(true);
        expect(edit?.settings?.pages).toEqual(pageSettings(FILE));
    });

    it("returns null once everything is in place, so the pages are not regenerated for nothing", () => {
        const first = communityEdit({ settings: { challenges: [question] } }, BOT, FILE)!;
        expect(communityEdit(first, BOT, FILE)).toBeNull();
    });

    it("returns null when the node hands the same settings back with its keys in another order", () => {
        const first = communityEdit({ settings: { challenges: [question] } }, BOT, FILE)!;
        const reorder = (o: object) => Object.fromEntries(Object.entries(o).reverse());
        const pages = first.settings!.pages as ReturnType<typeof pageSettings>;
        const fromNode = {
            ...first,
            settings: { ...first.settings, pages: { replies: pages.replies.map(reorder), posts: pages.posts.map(reorder) } }
        };
        expect(communityEdit(fromNode, BOT, FILE)).toBeNull();
    });

    it("keeps a role the owner gave the bot", () => {
        const edit = communityEdit({ roles: { [BOT]: { role: "admin" } }, settings: {} }, BOT, FILE);
        expect(edit?.roles).toEqual({ [BOT]: { role: "admin" } });
    });
});

describe("pageSettings", () => {
    it("serves Reddit's hot order as the preloaded `hot`, the built-in names Seedit asks for, and keeps the data path private", () => {
        const pages = pageSettings(FILE);
        expect(named(pages.posts)).toEqual([
            ["hot.js", true],
            ["flaired.js", false],
            ["new.js", false],
            ["removed-first.js", false],
            ["active", "built-in"]
        ]);
        expect(named(pages.replies)).toEqual([
            ["mirrored-reddit-best.js", true],
            ["flaired-replies.js", false]
        ]);
        expect(
            files([...pages.posts, ...pages.replies]).every(
                (p) => p.privateOptions.includes("sortDataPath") && p.options.sortDataPath === FILE
            )
        ).toBe(true);
    });

    it("with hotSort removed-only serves the flaired filter as `hot`, busiest first, keeps the recent order under `flaired` and moves Reddit's hot order to its own name", () => {
        const pages = pageSettings(FILE, undefined, "removed-only");
        expect(named(pages.posts)).toEqual([
            ["flaired-hot.js", true],
            ["flaired.js", false],
            ["mirrored-reddit-hot.js", false],
            ["new.js", false],
            ["removed-first.js", false],
            ["active", "built-in"]
        ]);
        expect(files(pages.posts)[0].options).toEqual({ sortDataPath: FILE, order: "hot" });
        expect(files(pages.posts)[1].options).toEqual({ sortDataPath: FILE, order: "flaired" });
        expect(communityEdit({ settings: { challenges: [] } }, BOT, FILE, undefined, "removed-only")?.settings?.pages).toEqual(pages);
    });
});

describe("pageSettings on a remote node", () => {
    it("points every sort at the node's copy of the sort files", () => {
        const pages = pageSettings("/root/subreddit-mirror/sort-data/c.json", "/root/subreddit-mirror/sorts");
        expect(files([...pages.posts, ...pages.replies]).map((p) => p.path)).toEqual([
            "/root/subreddit-mirror/sorts/hot.js",
            "/root/subreddit-mirror/sorts/flaired.js",
            "/root/subreddit-mirror/sorts/new.js",
            "/root/subreddit-mirror/sorts/removed-first.js",
            "/root/subreddit-mirror/sorts/mirrored-reddit-best.js",
            "/root/subreddit-mirror/sorts/flaired-replies.js"
        ]);
    });
});

describe("hostedAddresses", () => {
    it("reads the RPC's community list as strings or as the objects newer pkc-js sends", () => {
        expect(hostedAddresses(["12D3KooWA"])).toEqual(["12D3KooWA"]);
        expect(
            hostedAddresses([
                { publicKey: "12D3KooWB", started: true },
                { name: "memes.bso", publicKey: "12D3KooWC", started: false }
            ])
        ).toEqual(["12D3KooWB", "12D3KooWC", "memes.bso"]);
        expect(hostedAddresses(undefined)).toEqual([]);
    });
});

describe("communityDescription", () => {
    it("says what the front page is", () => {
        expect(communityDescription("AskHistorians", "removed-only")).toMatch(
            /^What Reddit removed from r\/AskHistorians\. The front page lists only .* busiest first;/
        );
        expect(communityDescription("AskScience", "reddit-hot")).toMatch(/^Posts and comments from r\/AskScience/);
        expect(communityDescription("NoNewNormal", "removed-only", "removed-only")).toMatch(
            /^What Reddit removed from r\/NoNewNormal: only the removed posts and comments, with the posts and parent comments they sat under for context\./
        );
    });
});

describe("publishAndWait", () => {
    type Listener = (...args: unknown[]) => void;
    const publication = (events: [string, unknown][]) => {
        const listeners = new Map<string, Listener>();
        return {
            on: (event: string, listener: Listener) => void listeners.set(event, listener),
            publish: async () => {
                for (const [event, arg] of events) listeners.get(event)?.(arg);
            },
            stop: async () => {}
        };
    };

    it("resolves with the cid once the community accepts", async () => {
        const accepted = publication([["challengeverification", { challengeSuccess: true, commentUpdate: { cid: "Qm1" } }]]);
        await expect(publishAndWait(accepted, "post", "c.bso")).resolves.toEqual({ cid: "Qm1" });
    });

    it("treats a failed verification as a rejection, but a challenge as a transient error to retry", async () => {
        const rejected = publication([["challengeverification", { challengeSuccess: false, reason: "over 40kb" }]]);
        await expect(publishAndWait(rejected, "post", "c.bso")).rejects.toBeInstanceOf(PublishRejected);
        // The bot never answers challenges; being challenged means the exclude isn't in effect right now, which a
        // later attempt (after a settings edit, a reconnect) can fix, so the item must stay in the queue
        const challenged = publication([["challenge", {}]]);
        const error = await publishAndWait(challenged, "reply", "c.bso").catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(PublishRejected);
        expect(String(error)).toMatch(/challenged the bot's reply/);
    });
});
