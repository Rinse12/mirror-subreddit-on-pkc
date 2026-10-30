// Posts removed on Reddit first, each group in mirrored-reddit-hot order
import { hotScore } from "./mirrored-reddit-hot.js";
import { entryOf, optionInputs, SORT_DATA_PATH_OPTION, sortData, validatePageSortSettings } from "./sort-data.js";

// Larger than any hot score (the time term is ~15k in 2026)
const REMOVED_BOOST = 1e6;

export default function removedFirst({ pageSortSettings }) {
    const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
    return {
        sortName: "removed-first",
        description: "Posts removed on Reddit first, then the rest, each in Reddit's hot order",
        scope: "posts",
        optionInputs,
        defaultOptions: { nativeWeight: "1" },
        score: (args) => hotScore(data.map, args) + (entryOf(data.map, args.commentUpdate)?.status === "removed" ? REMOVED_BOOST : 0),
        validatePageSortSettings
    };
}
