import fs from "node:fs/promises";
import path from "node:path";
import type { StateDb } from "./db.js";

// What sorts/sort-data.js reads, keyed by cid
export interface SortDataEntry {
    score: number | null;
    createdUtc: number;
    status: string;
    removedBy: string | null;
    // When the daemon first saw the item gone (or locked): the "most recently flaired first" order of sorts/flair-filter.js
    flairedAt: number | null;
}

export const sortDataPath = (dataDir: string, communityAddress: string) => path.join(dataDir, "sort-data", `${communityAddress}.json`);

// Writes the community's sort data atomically, so a sort never reads half a file
export async function writeSortData(db: StateDb, subreddit: string, file: string): Promise<number> {
    const data: Record<string, SortDataEntry> = {};
    for (const row of db.publishedForSortData(subreddit)) {
        data[row.cid!] = {
            score: row.score,
            createdUtc: row.createdUtc,
            status: row.status,
            removedBy: row.removedBy,
            flairedAt: row.status === "up" || row.status === "missing" ? null : row.goneSeenAt
        };
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
    return Object.keys(data).length;
}
