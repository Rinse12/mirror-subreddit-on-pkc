import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

const mirror = { subreddit: "AskHistorians", communityAddress: "ah.bso", signerPath: "data/signers/ah.json" };

describe("parseConfig", () => {
    it("accepts config.example.json", () => {
        const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "../config.example.json"), "utf8"));
        const config = parseConfig(raw, "/srv/mirror");
        expect(config.mirrors[0].signerPath).toBe("/srv/mirror/data/signers/askscience.json");
        expect(config.mirrors[1]).toMatchObject({
            subreddit: "AskHistorians",
            hotSort: "removed-only",
            backfillOnly: "removed",
            backfillSince: "2026-01-01T00:00:00Z"
        });
        expect(config.mirrors[2]).toMatchObject({ subreddit: "NoNewNormal", archiveOnly: true, publish: "removed-only" });
    });

    it("fills in defaults", () => {
        const config = parseConfig({ mirrors: [mirror] }, "/srv/mirror");
        expect(config.rpcUrl).toBe("ws://localhost:9138");
        expect(config.dataDir).toBe("/srv/mirror/data");
        expect(config.clientUrl).toBe("https://seedit.app");
        expect(config.mirrors[0]).toMatchObject({
            name: "AskHistorians",
            communityAddress: "ah.bso",
            commentUpdateDays: 7,
            minScore: 0,
            authorDeleted: "hide",
            maxCommentsPerPost: null,
            hotSort: "reddit-hot",
            publish: "all",
            context: "ancestors",
            threadSummary: false,
            archiveOnly: false,
            backfillSince: null,
            backfillOnly: "all"
        });
        expect(config.backends.redlib.instances).toEqual([]);
        expect(config.backends["arctic-shift"].baseUrl).toBe("https://arctic-shift.photon-reddit.com");
    });

    it("rejects a subreddit given with r/", () => {
        expect(() => parseConfig({ mirrors: [{ ...mirror, subreddit: "r/AskHistorians" }] })).toThrow(/mirrors\.0\.subreddit/);
    });

    it("rejects two mirrors of the same name or community, and lets one subreddit be mirrored twice under different names", () => {
        const other = { subreddit: "askhistorians", communityAddress: "ah.bso", signerPath: "data/signers/other.json" };
        expect(() => parseConfig({ mirrors: [mirror, other] })).toThrow(/duplicate name[\s\S]*duplicate communityAddress/);
        const removed = { ...other, name: "askhistorians-removed", communityAddress: null, publish: "removed-only" };
        expect(parseConfig({ mirrors: [mirror, removed] }).mirrors.map((m) => m.name)).toEqual(["AskHistorians", "askhistorians-removed"]);
    });

    it("requires backfillSince with archiveOnly", () => {
        expect(() => parseConfig({ mirrors: [{ ...mirror, archiveOnly: true }] })).toThrow(
            /mirrors\.0\.backfillSince: required with archiveOnly/
        );
        expect(
            parseConfig({ mirrors: [{ ...mirror, archiveOnly: true, backfillSince: "2021-01-01T00:00:00Z" }] }).mirrors[0].archiveOnly
        ).toBe(true);
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

    it("takes backfillSince as an ISO datetime with a zone, not a bare date", () => {
        expect(parseConfig({ mirrors: [{ ...mirror, backfillSince: "2026-01-01T00:00:00+01:00" }] }).mirrors[0].backfillSince).toBe(
            "2026-01-01T00:00:00+01:00"
        );
        expect(() => parseConfig({ mirrors: [{ ...mirror, backfillSince: "2026-01-01" }] })).toThrow(/mirrors\.0\.backfillSince/);
        expect(() => parseConfig({ mirrors: [{ ...mirror, hotSort: "flaired" }] })).toThrow(/mirrors\.0\.hotSort/);
    });

    it("rejects unknown keys", () => {
        expect(() => parseConfig({ mirrors: [{ ...mirror, fetch: {} }] })).toThrow(/Invalid config/);
    });
});
