import { describe, expect, it } from "vitest";
import { communityEdit, hostedAddresses, pageSettings } from "../src/pkc.js";

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

    it("with hotSort removed-only serves the flaired filter as `hot` and moves Reddit's hot order to its own name", () => {
        const pages = pageSettings(FILE, undefined, "removed-only");
        expect(named(pages.posts)).toEqual([
            ["flaired-hot.js", true],
            ["mirrored-reddit-hot.js", false],
            ["new.js", false],
            ["removed-first.js", false],
            ["active", "built-in"]
        ]);
        expect(files(pages.posts)[0].options).toEqual({ sortDataPath: FILE, order: "flaired" });
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
