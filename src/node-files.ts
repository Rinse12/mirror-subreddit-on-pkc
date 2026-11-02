import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { FLAIR_SORT_DIST, FLAIR_SORT_SUBDIR, SORTS_DIR } from "./pkc.js";

const run = promisify(execFile);

// Where the page sort files and their data live on the machine that runs the community: the sorts are import()ed
// by the community node, so with rpcSshHost they are pushed there over ssh. rsync writes to a temp file and
// renames it, so a sort never reads half a file. The flair filter's files (the dist/ of @pkcprotocol/flair-page-sort)
// go under <sortsDir>/flair-page-sort/, locally as well, so the node imports them from one place.
export interface NodeFiles {
    sortsDir: string;
    sortDataFile(communityAddress: string): string;
    // Copies the local sort files to sortsDir (a no-op when the node is this machine)
    pushSorts(): Promise<void>;
    // Copies a sort data file written locally to its place on the node
    pushSortData(localFile: string, communityAddress: string): Promise<void>;
}

export function localNodeFiles(dataDir: string): NodeFiles {
    return {
        sortsDir: SORTS_DIR,
        sortDataFile: (address) => path.join(dataDir, "sort-data", `${address}.json`),
        pushSorts: async () => {
            await fs.cp(FLAIR_SORT_DIST, path.join(SORTS_DIR, FLAIR_SORT_SUBDIR), { recursive: true });
        },
        pushSortData: async () => {}
    };
}

const SSH = "ssh -o BatchMode=yes -o ConnectTimeout=15";

export function remoteNodeFiles(sshHost: string, nodeDir: string): NodeFiles {
    const sortDataFile = (address: string) => path.posix.join(nodeDir, "sort-data", `${address}.json`);
    return {
        sortsDir: path.posix.join(nodeDir, "sorts"),
        sortDataFile,
        async pushSorts() {
            await run("ssh", [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=15",
                sshHost,
                "mkdir",
                "-p",
                path.posix.join(nodeDir, "sorts"),
                path.posix.join(nodeDir, "sort-data")
            ]);
            // -rlt, not -a: the files take the remote user as owner instead of a local uid
            const sorts = path.posix.join(nodeDir, "sorts");
            await run("rsync", ["-rlt", "--delete", "--exclude", FLAIR_SORT_SUBDIR, "-e", SSH, `${SORTS_DIR}/`, `${sshHost}:${sorts}/`]);
            await run("rsync", [
                "-rlt",
                "--delete",
                "-e",
                SSH,
                `${FLAIR_SORT_DIST}/`,
                `${sshHost}:${path.posix.join(sorts, FLAIR_SORT_SUBDIR)}/`
            ]);
        },
        async pushSortData(localFile, address) {
            await run("rsync", ["-rlt", "-e", SSH, localFile, `${sshHost}:${sortDataFile(address)}`]);
        }
    };
}
