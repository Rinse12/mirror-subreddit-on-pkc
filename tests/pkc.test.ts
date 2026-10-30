import { describe, expect, it } from "vitest";
import { communityEdit, pageSettings } from "../src/pkc.js";

const BOT = "12D3KooWBot";
const FILE = "/srv/mirror/data/sort-data/c.json";
const question = { name: "question", options: { answer: "secret" } };

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
    it("preloads mirrored-reddit-hot and keeps the data path private", () => {
        const pages = pageSettings(FILE);
        expect(pages.posts.map((p) => [p.path.split("/").pop(), p.preloaded])).toEqual([
            ["mirrored-reddit-hot.js", true],
            ["mirrored-reddit-new.js", false],
            ["removed-first.js", false]
        ]);
        expect(pages.replies[0].path).toMatch(/sorts\/mirrored-reddit-best\.js$/);
        expect(pages.posts.every((p) => p.privateOptions.includes("sortDataPath") && p.options.sortDataPath === FILE)).toBe(true);
    });
});

describe("pageSettings on a remote node", () => {
    it("points every sort at the node's copy of the sort files", () => {
        const pages = pageSettings("/root/subreddit-mirror/sort-data/c.json", "/root/subreddit-mirror/sorts");
        expect([...pages.posts, ...pages.replies].map((p) => p.path)).toEqual([
            "/root/subreddit-mirror/sorts/mirrored-reddit-hot.js",
            "/root/subreddit-mirror/sorts/mirrored-reddit-new.js",
            "/root/subreddit-mirror/sorts/removed-first.js",
            "/root/subreddit-mirror/sorts/mirrored-reddit-best.js"
        ]);
    });
});
