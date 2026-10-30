// Creates the bot signer of every mirror in config.json that has none yet, and prints its address. Key generation is
// local, so this needs no running node.
import PKC from "@pkcprotocol/pkc-js";
import { loadConfig } from "../src/config.js";
import { createAndStoreSigner } from "../src/pkc.js";
import fs from "node:fs";

const config = loadConfig();
const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [] });
try {
    for (const mirror of config.mirrors) {
        if (fs.existsSync(mirror.signerPath)) {
            console.log(`r/${mirror.subreddit}: ${mirror.signerPath} already exists`);
            continue;
        }
        const signer = await createAndStoreSigner(pkc, mirror.signerPath);
        console.log(`r/${mirror.subreddit}: bot signer saved to ${mirror.signerPath}, address ${signer.address}`);
    }
} finally {
    await pkc.destroy();
}
