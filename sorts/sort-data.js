// Shared by the page sort files. The mirror daemon writes data/sort-data/<communityAddress>.json,
// { "<cid>": { "score": number|null, "createdUtc": number, "status": "up"|"removed"|..., "removedBy": string|null } },
// and each sort keeps it in memory, re-read every 60 s outside score(): score() is sync and gets no database.
// Plain JS because the community node import()s these files directly.
import { readFileSync, promises as fs } from "node:fs";

export const SORT_DATA_PATH_OPTION = "sortDataPath";
export const NATIVE_WEIGHT_OPTION = "nativeWeight";
const REFRESH_MS = 60_000;

const caches = new Map();

function parse(text) {
    const data = JSON.parse(text);
    return new Map(Object.entries(data && typeof data === "object" ? data : {}));
}

// The map for one file, shared by every sort that reads it. Loaded synchronously the first time (when the factory
// runs, never inside score), then refreshed in the background. A missing or broken file leaves the last good map.
export function sortData(path) {
    let cache = caches.get(path);
    if (!cache) {
        cache = { map: new Map() };
        try {
            cache.map = parse(readFileSync(path, "utf8"));
        } catch {}
        const timer = setInterval(async () => {
            try {
                cache.map = parse(await fs.readFile(path, "utf8"));
            } catch {}
        }, REFRESH_MS);
        timer.unref?.();
        caches.set(path, cache);
    }
    return cache;
}

export const optionInputs = [
    { option: SORT_DATA_PATH_OPTION, label: "Sort data file", description: "Path of the JSON file the mirror daemon writes for this community" },
    {
        option: NATIVE_WEIGHT_OPTION,
        label: "Native vote weight",
        description: "How much one Bitsocial vote counts against one Reddit vote (a number, default 1)",
        placeholder: "1"
    }
];

export function validatePageSortSettings({ pageSortSettings }) {
    if (!pageSortSettings.options?.[SORT_DATA_PATH_OPTION]) throw new Error(`${SORT_DATA_PATH_OPTION} must be set`);
    const weight = pageSortSettings.options?.[NATIVE_WEIGHT_OPTION];
    if (weight !== undefined && !Number.isFinite(Number(weight))) throw new Error(`${NATIVE_WEIGHT_OPTION} must be a number, got "${weight}"`);
}

export const nativeWeightOf = (options) => {
    const weight = Number(options?.[NATIVE_WEIGHT_OPTION] ?? "1");
    return Number.isFinite(weight) ? weight : 1;
};

export const nativeVotes = (commentUpdate) => (commentUpdate?.upvoteCount ?? 0) - (commentUpdate?.downvoteCount ?? 0);

// Reddit's hot: log10 of the score's size, signed, plus 1 per 12.5 h since Reddit's epoch
export function redditHot(score, createdUtc) {
    const order = Math.log10(Math.max(Math.abs(score), 1));
    const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
    return sign * order + (createdUtc - 1134028003) / 45000;
}

// What a sort knows about one comment: Reddit's data for mirrored ones, the native timestamp for the rest
export function entryOf(map, commentUpdate) {
    return commentUpdate?.cid ? map.get(commentUpdate.cid) : undefined;
}
