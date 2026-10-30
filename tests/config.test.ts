import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const mirror = { subreddit: "AskHistorians", communityAddress: "ah.bso", signerPath: "data/signers/ah.json" };

describe("parseConfig", () => {
    it("accepts config.example.json", () => {
        const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "../config.example.json"), "utf8"));
        expect(parseConfig(raw, "/srv/mirror").mirrors[0].signerPath).toBe("/srv/mirror/data/signers/askscience.json");
    });

    it("fills in defaults", () => {
        const config = parseConfig({ mirrors: [mirror] }, "/srv/mirror");
        expect(config.rpcUrl).toBe("ws://localhost:9138");
        expect(config.dataDir).toBe("/srv/mirror/data");
        expect(config.mirrors[0]).toMatchObject({
            communityAddress: "ah.bso",
            commentUpdateDays: 7,
            minScore: 0,
            authorDeleted: "hide",
            maxCommentsPerPost: null
        });
        expect(config.backends.redlib.instances).toEqual([]);
        expect(config.backends["arctic-shift"].baseUrl).toBe("https://arctic-shift.photon-reddit.com");
    });

    it("rejects a subreddit given with r/", () => {
        expect(() => parseConfig({ mirrors: [{ ...mirror, subreddit: "r/AskHistorians" }] })).toThrow(/mirrors\.0\.subreddit/);
    });

    it("rejects two mirrors of the same subreddit or community", () => {
        const other = { subreddit: "askhistorians", communityAddress: "ah.bso", signerPath: "data/signers/other.json" };
        expect(() => parseConfig({ mirrors: [mirror, other] })).toThrow(/duplicate subreddit[\s\S]*duplicate communityAddress/);
    });

    it("lets the daemon create the community when no address is given", () => {
        const config = parseConfig({
            mirrors: [
                { subreddit: "aa", signerPath: "a.json" },
                { subreddit: "bb", signerPath: "b.json" }
            ]
        });
        expect(config.mirrors.map((m) => m.communityAddress)).toEqual([null, null]);
    });

    it("requires nodeDir with rpcSshHost", () => {
        expect(() => parseConfig({ rpcSshHost: "my-node", mirrors: [mirror] })).toThrow(/nodeDir: required with rpcSshHost/);
        expect(parseConfig({ rpcSshHost: "my-node", nodeDir: "/root/subreddit-mirror", mirrors: [mirror] }).rpcPort).toBe(9138);
    });

    it("rejects unknown keys", () => {
        expect(() => parseConfig({ mirrors: [{ ...mirror, fetch: {} }] })).toThrow(/Invalid config/);
    });
});
