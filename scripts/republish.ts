// Purges every mirrored post from its community, with its reply tree, and queues the threads to be published again,
// so a change to how items are published (content, author) reaches what is already there. Native replies and votes
// on those posts are purged with them. Stop the daemon first; it republishes on its next start.
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { StateDb } from "../src/db.js";
import { createPkc, loadSigner, publishModeration } from "../src/pkc.js";
import { openRpcTunnel } from "../src/tunnel.js";

const config = loadConfig();
const db = new StateDb(path.join(config.dataDir, "state.sqlite"));
const tunnel = config.rpcSshHost ? await openRpcTunnel(config.rpcSshHost, config.rpcPort) : undefined;
const pkc = await createPkc(tunnel?.rpcUrl ?? config.rpcUrl);
try {
    for (const mirror of config.mirrors) {
        const address = mirror.communityAddress ?? db.mirror(mirror.subreddit).communityAddress;
        if (!address) continue;
        const signer = await loadSigner(pkc, mirror.signerPath);
        const posts = db.publishedPosts(mirror.subreddit);
        for (const [i, post] of posts.entries()) {
            await publishModeration(pkc, signer, address, post.cid!, { purged: true, reason: "Republished in a new format" });
            db.transaction(() => {
                db.unpublishThread(mirror.subreddit, post.redditId);
                // The bot's author flair is a moderation on its first published item, which may be this one
                db.updateMirror(mirror.subreddit, { authorFlairSet: 0 });
            });
            console.log(`r/${mirror.subreddit}: purged ${i + 1}/${posts.length} ${post.redditId}`);
        }
    }
} finally {
    await pkc.destroy();
    tunnel?.close();
    db.close();
}
