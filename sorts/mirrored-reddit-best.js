// Replies by Reddit score plus native votes, older first among equals; native replies by native votes
import { entryOf, nativeVotes, nativeWeightOf, optionInputs, SORT_DATA_PATH_OPTION, sortData, validatePageSortSettings } from "./sort-data.js";

export default function mirroredRedditBest({ pageSortSettings }) {
    const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
    return {
        sortName: "mirrored-reddit-best",
        description: "Replies by their Reddit score plus Bitsocial votes",
        scope: "replies",
        optionInputs,
        defaultOptions: { nativeWeight: "1" },
        score: ({ comment, commentUpdate, options }) => {
            const entry = entryOf(data.map, commentUpdate);
            const score = (entry?.score ?? 0) + nativeWeightOf(options) * nativeVotes(commentUpdate);
            // The tie-break folded into the score: an earlier reply wins by a fraction smaller than one vote
            return score - (entry?.createdUtc ?? comment.timestamp) / 1e10;
        },
        validatePageSortSettings
    };
}
