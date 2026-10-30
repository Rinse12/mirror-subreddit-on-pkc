// Replies by Reddit score plus native votes, older first among equals; native replies by native votes. Kept under
// its own name: a reply file published as `best` would be re-sorted by bitsocial-react-hooks' own best.
import { bestScore } from "./reddit-best.js";
import { optionInputs, SORT_DATA_PATH_OPTION, sortData, validatePageSortSettings } from "./sort-data.js";

export default function mirroredRedditBest({ pageSortSettings }) {
    const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
    return {
        sortName: "mirrored-reddit-best",
        description: "Replies by their Reddit score plus Bitsocial votes",
        scope: "replies",
        optionInputs,
        defaultOptions: { nativeWeight: "1" },
        score: (args) => bestScore(data.map, args),
        validatePageSortSettings
    };
}
