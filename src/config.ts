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
        skipAuthors: z.array(z.string()).default(["AutoModerator"])
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
        for (const key of ["subreddit", "communityAddress", "signerPath"] as const) {
            const seen = new Set<string>();
            config.mirrors.forEach((mirror, index) => {
                const value = key === "subreddit" ? mirror[key].toLowerCase() : mirror[key];
                if (value === null) return;
                if (seen.has(value)) ctx.addIssue({ code: "custom", path: ["mirrors", index, key], message: `duplicate ${key}` });
                seen.add(value);
            });
        }
    });

export type Config = z.infer<typeof ConfigSchema>;
export type MirrorConfig = Config["mirrors"][number];

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
        mirrors: config.mirrors.map((mirror) => ({ ...mirror, signerPath: path.resolve(baseDir, mirror.signerPath) }))
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
