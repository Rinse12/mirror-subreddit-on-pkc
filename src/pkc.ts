import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PKC from "@pkcprotocol/pkc-js";
import type { MirrorConfig } from "./config.js";

export type PkcInstance = Awaited<ReturnType<typeof PKC>>;
export type BotSigner = Awaited<ReturnType<PkcInstance["createSigner"]>>;

const PUBLISH_TIMEOUT_MS = 5 * 60_000;
export const SORTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sorts");

export async function createPkc(rpcUrl: string): Promise<PkcInstance> {
    const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl] });
    // pkc-js has no default error listener; without one an unhandled 'error' would crash the process
    pkc.on("error", (error: unknown) => console.error("pkc error:", error));
    return pkc;
}

interface StoredSigner {
    type: "ed25519";
    privateKey: string;
}

export async function loadSigner(pkc: PkcInstance, file: string): Promise<BotSigner> {
    let stored: StoredSigner;
    try {
        stored = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
        throw new Error(`Could not read ${file}. Run \`npm run create-signer\` first.`, { cause: error });
    }
    return pkc.createSigner({ type: stored.type, privateKey: stored.privateKey });
}

export async function createAndStoreSigner(pkc: PkcInstance, file: string): Promise<BotSigner> {
    const exists = await fs.stat(file).then(
        () => true,
        () => false
    );
    if (exists) throw new Error(`${file} already exists; move it away first if you really want to rotate the key`);
    const signer = await pkc.createSigner();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const stored: StoredSigner = { type: "ed25519", privateKey: signer.privateKey! };
    await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    return signer;
}

// The community said no (challenge failed, invalid publication, over its size limit): retrying won't help
export class PublishRejected extends Error {}

interface Publication {
    on(event: string, listener: (...args: any[]) => void): unknown;
    publish(): Promise<void>;
    stop(): Promise<void>;
}

interface Verification {
    challengeSuccess: boolean;
    reason?: string;
    challengeErrors?: Record<string, string>;
    commentUpdate?: { cid?: string };
}

// Publishes and resolves once the community accepts it. The bot never answers challenges: the daemon exempts its
// key from every challenge, so being challenged means that exclude rule is missing.
function publishAndWait(publication: Publication, what: string, communityAddress: string): Promise<{ cid?: string }> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, cid?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            publication.stop().catch(() => {});
            if (error) reject(error);
            else resolve({ cid });
        };
        const timeout = setTimeout(() => finish(new Error(`publishing the ${what} timed out`)), PUBLISH_TIMEOUT_MS);
        publication.on("challenge", () =>
            finish(new PublishRejected(`${communityAddress} challenged the bot's ${what}; its key is missing from the challenge exclude`))
        );
        publication.on("challengeverification", (verification: Verification) => {
            if (verification.challengeSuccess) finish(undefined, verification.commentUpdate?.cid);
            else
                finish(
                    new PublishRejected(`${what} rejected: ${verification.reason ?? JSON.stringify(verification.challengeErrors ?? {})}`)
                );
        });
        publication.on("error", (error: Error) => finish(error));
        publication.publish().catch((error: Error) => finish(error));
    });
}

export interface NewComment {
    title?: string;
    content: string;
    link?: string;
    author?: { displayName: string };
    // Both set for a reply
    parentCid?: string;
    postCid?: string;
}

export async function publishComment(pkc: PkcInstance, signer: BotSigner, communityAddress: string, comment: NewComment): Promise<string> {
    const publication = await pkc.createComment({ communityAddress, signer, ...comment });
    const { cid } = await publishAndWait(publication as unknown as Publication, comment.parentCid ? "reply" : "post", communityAddress);
    if (!cid) throw new Error(`${communityAddress} accepted the comment but returned no cid`);
    return cid;
}

export async function publishEdit(pkc: PkcInstance, signer: BotSigner, communityAddress: string, commentCid: string, content: string) {
    const publication = await pkc.createCommentEdit({ communityAddress, signer, commentCid, content });
    await publishAndWait(publication as unknown as Publication, "edit", communityAddress);
}

export type Moderation = {
    flairs?: { text: string }[];
    author?: { flairs: { text: string }[] };
    reason?: string;
    [key: string]: unknown;
};

export async function publishModeration(
    pkc: PkcInstance,
    signer: BotSigner,
    communityAddress: string,
    commentCid: string,
    commentModeration: Moderation
) {
    const publication = await pkc.createCommentModeration({ communityAddress, signer, commentCid, commentModeration });
    await publishAndWait(publication as unknown as Publication, "moderation", communityAddress);
}

interface ChallengeSetting {
    exclude?: { publicKeys?: string[] }[];
    [key: string]: unknown;
}

export interface CommunityState {
    roles?: Record<string, { role: string }>;
    settings?: { challenges?: ChallengeSetting[]; pages?: unknown; [key: string]: unknown };
}

const sortEntry = (sortsDir: string, file: string, sortDataFile: string, preloaded: boolean, extra: Record<string, string> = {}) => ({
    // A path on the machine running the community, which import()s it
    path: path.posix.join(sortsDir, file),
    options: { sortDataPath: sortDataFile, ...extra },
    privateOptions: ["sortDataPath"],
    preloaded
});

export type HotSort = MirrorConfig["hotSort"];

// The page sorts of a mirror community (see README, Scores). Post sorts take the built-in names Seedit requests (`hot`
// preloaded, `new`, `active`), since a path file under a built-in name keeps the community's order on the client while a
// name nobody asks for is never shown. With hotSort "removed-only" the flaired filter is what `hot` serves, and Reddit's
// hot order moves to `mirrored-reddit-hot`. The reply sort keeps its own name: a reply file published as `best` would
// be re-sorted by the client.
export function pageSettings(sortDataFile: string, sortsDir = SORTS_DIR, hotSort: HotSort = "reddit-hot") {
    const flairedOptions = { order: "flaired" };
    return {
        posts: [
            ...(hotSort === "removed-only"
                ? [
                      sortEntry(sortsDir, "flaired-hot.js", sortDataFile, true, flairedOptions),
                      sortEntry(sortsDir, "mirrored-reddit-hot.js", sortDataFile, false, { nativeWeight: "1" })
                  ]
                : [
                      sortEntry(sortsDir, "hot.js", sortDataFile, true, { nativeWeight: "1" }),
                      sortEntry(sortsDir, "flaired.js", sortDataFile, false, flairedOptions)
                  ]),
            sortEntry(sortsDir, "new.js", sortDataFile, false),
            sortEntry(sortsDir, "removed-first.js", sortDataFile, false, { nativeWeight: "1" }),
            // pkc-js's own active: bumps on native replies, so Seedit's "active" tab isn't empty
            { name: "active" }
        ],
        replies: [
            sortEntry(sortsDir, "mirrored-reddit-best.js", sortDataFile, true, { nativeWeight: "1" }),
            sortEntry(sortsDir, "flaired-replies.js", sortDataFile, false, { nativeWeight: "1" })
        ]
    };
}

// JSON with object keys sorted: the node hands settings back with its own key order
const canonicalJson = (value: unknown): string =>
    JSON.stringify(value, (_key, v) =>
        v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v
    );

// The roles and settings the community needs, built on what it has; null when nothing has to change. Settings are
// replaced wholesale on edit, and any settings.pages change regenerates every CommentUpdate, so this only returns
// an edit when something actually differs.
export function communityEdit(
    current: CommunityState,
    botAddress: string,
    sortDataFile: string,
    sortsDir = SORTS_DIR,
    hotSort: HotSort = "reddit-hot"
): CommunityState | null {
    const roles = current.roles?.[botAddress] ? current.roles : { ...current.roles, [botAddress]: { role: "moderator" } };
    const challenges = (current.settings?.challenges ?? []).map((challenge) =>
        challenge.exclude?.some((rule) => Object.keys(rule).length === 1 && rule.publicKeys?.includes(botAddress))
            ? challenge
            : { ...challenge, exclude: [...(challenge.exclude ?? []), { publicKeys: [botAddress] }] }
    );
    const pages = pageSettings(sortDataFile, sortsDir, hotSort);
    const settings = { ...current.settings, challenges, pages };
    const changed =
        roles !== current.roles ||
        canonicalJson(challenges) !== canonicalJson(current.settings?.challenges ?? []) ||
        canonicalJson(pages) !== canonicalJson(current.settings?.pages);
    return changed ? { roles, settings } : null;
}

// The addresses in the RPC server's list of hosted communities: plain strings on older pkc-js, `{ publicKey, name?,
// started }` entries since 0.0.129 (a community with a domain name is listed under its key as well)
export function hostedAddresses(communities: unknown): string[] {
    if (!Array.isArray(communities)) return [];
    return communities.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        const { publicKey, address, name } = (entry ?? {}) as { publicKey?: unknown; address?: unknown; name?: unknown };
        return [publicKey, address, name].filter((value): value is string => typeof value === "string");
    });
}

// Waits for the RPC server's list of the communities it hosts
async function hostedCommunities(pkc: PkcInstance): Promise<string[]> {
    for (let i = 0; i < 50 && !pkc.communities?.length; i++) await new Promise((resolve) => setTimeout(resolve, 200));
    return hostedAddresses(pkc.communities);
}

// Opens the mirror's community on the node, creating it when it has none yet, brings its roles and settings in
// line, and starts it. Returns its address.
export async function ensureCommunity(
    pkc: PkcInstance,
    options: {
        address: string | null;
        subreddit: string;
        botAddress: string;
        sortsDir: string;
        sortDataFile: (address: string) => string;
        hotSort: HotSort;
    }
): Promise<string> {
    let community;
    if (options.address) {
        if (!(await hostedCommunities(pkc)).includes(options.address))
            throw new Error(`${options.address} is not hosted on the RPC node; remove communityAddress to have a new one created`);
        community = await pkc.createCommunity({ address: options.address });
    } else {
        const created = await pkc.createCommunity({
            title: `r/${options.subreddit} mirror`,
            description: `Posts and comments from r/${options.subreddit}, mirrored from Reddit, with a note on everything Reddit removes.`
        });
        console.log(`created community ${created.address} for r/${options.subreddit}`);
        // The instance returned by createCommunity doesn't have the settings the node filled in (its default
        // challenge among them) yet; open it again so the exclude is added to what the node actually runs
        community = await pkc.createCommunity({ address: created.address });
    }
    const local = community as unknown as CommunityState & {
        address: string;
        started?: boolean;
        edit(edit: CommunityState): Promise<void>;
        start(): Promise<void>;
    };
    // Sort file and challenge failures on the node surface here
    (community as unknown as { on(event: string, listener: (error: unknown) => void): void }).on("error", (error) =>
        console.error(`community ${local.address} error:`, error instanceof Error ? error.message : error)
    );
    // settings is replaced wholesale on edit: editing without having read it would wipe the challenges
    if (!local.settings) throw new Error(`${local.address} came back without its settings; is it hosted on this RPC node?`);
    const edit = communityEdit(local, options.botAddress, options.sortDataFile(local.address), options.sortsDir, options.hotSort);
    if (edit) {
        await local.edit(edit);
        console.log(`updated roles and settings of ${local.address}`);
    }
    if (!local.started) await local.start();
    return local.address;
}
