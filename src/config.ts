import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = "config.json";

const MirrorSchema = z
    .object({
        // Without the r/ prefix, e.g. "AskScience"
        subreddit: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9_]{2,21}$/, "a subreddit name without r/"),
        // The key of the mirror's state in state.sqlite, the subreddit by default. Two mirrors of one subreddit (a full
        // mirror and a removed-only one, say) need distinct names; renaming a mirror orphans its state.
        name: z.string().trim().min(1).optional(),
        // An existing community hosted on the RPC node; left out, the daemon creates one on first run and keeps its
        // address in state.sqlite
        communityAddress: z.string().min(1).nullable().default(null),
        // One bot signer per community, created with `npm run create-signer`
        signerPath: z.string().min(1),
        // New comments are picked up, and items re-checked for removal, for this long after a post is mirrored
        commentUpdateDays: z.number().positive().default(7),
        // Posts below this Reddit score are not mirrored
        minScore: z.number().int().default(0),
        // What happens to items their Reddit author deleted: "hide" edits the text down to a placeholder
        authorDeleted: z.enum(["hide", "keep"]).default("hide"),
        // Unset or null: no cap. Otherwise the highest-scored comments, plus every removed comment we have text for
        maxCommentsPerPost: z.number().int().positive().nullable().default(null),
        // Reddit accounts whose comments aren't mirrored (case-insensitive); replies to them go under the nearest
        // mirrored ancestor. Adding one later purges what was already published.
        skipAuthors: z.array(z.string()).default(["AutoModerator"]),
        // What the community serves as `hot`, the page Seedit opens on: Reddit's hot order, or only what Reddit removed
        // (the `flaired` filter), with Reddit's hot order moving to `mirrored-reddit-hot`
        hotSort: z.enum(["reddit-hot", "removed-only"]).default("reddit-hot"),
        // "all": every captured item is published. "removed-only": only items Reddit removed, plus their context (the
        // post, and with `context: "ancestors"` the comments between the post and a removed reply); the rest is
        // captured but stays in the database
        publish: z.enum(["all", "removed-only"]).default("all"),
        // With publish "removed-only": "ancestors" publishes the not-removed parents of a removed reply so it sits in
        // its place in the thread; "post" publishes only the post and hangs the removed reply directly under it
        context: z.enum(["ancestors", "post"]).default("ancestors"),
        // Keep one pinned bot reply per thread that lists the replies Reddit removed in it, with links to each; off by
        // default, people come for the removed content itself
        threadSummary: z.boolean().default(false),
        // The subreddit can't be read live (banned, quarantined, private): everything comes from the backfill walk,
        // which needs backfillSince, and no live source is asked
        archiveOnly: z.boolean().default(false),
        // Mirror the subreddit's history from Arctic Shift back to this instant (ISO 8601 with time and zone, e.g.
        // "2026-01-01T00:00:00Z"); unset: no backfill
        backfillSince: z.iso.datetime({ offset: true }).nullable().default(null),
        // "all": every archived thread back to backfillSince; "removed": only threads where the post, or a comment
        // whose text the archive kept, was removed
        backfillOnly: z.enum(["all", "removed"]).default("all")
    })
    .strict();

export const ConfigSchema = z
    .object({
        // pkc RPC of the bitsocial daemon that runs the communities, on this machine
        rpcUrl: z.string().min(1).default("ws://localhost:9138"),
        // The community node runs on another machine: its RPC is reached through an ssh tunnel to this host (only
        // rpcPort is used then), and the page sorts and their data are pushed to nodeDir there over ssh
        rpcSshHost: z.string().min(1).optional(),
        rpcPort: z.number().int().positive().default(9138),
        // Absolute, on the rpcSshHost machine
        nodeDir: z.string().startsWith("/").optional(),
        // Holds state.sqlite, the per-community sort data and the signers
        dataDir: z.string().min(1).default("data"),
        // The web client that links in bot replies point at, as <clientUrl>/#/p/<community>/c/<cid>
        clientUrl: z.url().default("https://seedit.app"),
        mirrors: z.array(MirrorSchema).min(1),
        backends: z
            .object({
                redlib: z
                    .object({
                        // Tried in order; one that times out, is throttled or errors goes on a cooldown
                        instances: z.array(z.url()).default([])
                    })
                    .strict()
                    .prefault({}),
                "reddit-json": z
                    .object({
                        userAgent: z.string().min(1).default("pkc-mirror/0.1")
                    })
                    .strict()
                    .prefault({}),
                "arctic-shift": z
                    .object({
                        baseUrl: z.url().default("https://arctic-shift.photon-reddit.com")
                    })
                    .strict()
                    .prefault({}),
                // Fallback source of text only, asked after Arctic Shift
                pullpush: z
                    .object({
                        baseUrl: z.url().default("https://api.pullpush.io")
                    })
                    .strict()
                    .prefault({})
            })
            .strict()
            .prefault({})
    })
    .strict()
    .superRefine((config, ctx) => {
        if (config.rpcSshHost && !config.nodeDir)
            ctx.addIssue({
                code: "custom",
                path: ["nodeDir"],
                message: "required with rpcSshHost: where the page sorts live on that machine"
            });
        config.mirrors.forEach((mirror, index) => {
            if (mirror.archiveOnly && !mirror.backfillSince)
                ctx.addIssue({
                    code: "custom",
                    path: ["mirrors", index, "backfillSince"],
                    message: "required with archiveOnly: the walk from the archive is the only source"
                });
        });
        for (const key of ["name", "communityAddress", "signerPath"] as const) {
            const seen = new Set<string>();
            config.mirrors.forEach((mirror, index) => {
                const value = key === "name" ? (mirror.name ?? mirror.subreddit).toLowerCase() : mirror[key];
                if (value === null) return;
                if (seen.has(value)) ctx.addIssue({ code: "custom", path: ["mirrors", index, key], message: `duplicate ${key}` });
                seen.add(value);
            });
        }
    });

export type Config = Omit<z.infer<typeof ConfigSchema>, "mirrors"> & { mirrors: MirrorConfig[] };
export type MirrorConfig = Omit<z.infer<typeof ConfigSchema>["mirrors"][number], "name"> & { name: string };

export function parseConfig(raw: unknown, baseDir = process.cwd()): Config {
    const result = ConfigSchema.safeParse(raw);
    if (!result.success) {
        throw new Error(
            `Invalid config:\n${result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}`
        );
    }
    const config = result.data;
    return {
        ...config,
        dataDir: path.resolve(baseDir, config.dataDir),
        mirrors: config.mirrors.map((mirror) => ({
            ...mirror,
            name: mirror.name ?? mirror.subreddit,
            signerPath: path.resolve(baseDir, mirror.signerPath)
        }))
    };
}

export function loadConfig(file = process.env.CONFIG || DEFAULT_CONFIG_PATH): Config {
    const absolute = path.resolve(file);
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
        throw new Error(`Could not read config ${absolute}. Copy config.example.json to config.json and fill it in.`, { cause: error });
    }
    return parseConfig(raw, path.dirname(absolute));
}
