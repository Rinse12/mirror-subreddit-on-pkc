// Reddit's hot order on Reddit score plus native votes; native posts use their native votes and timestamp. One
// factory per wire name: `hot` is what Seedit asks for, `mirrored-reddit-hot` is the same order under its own name
// when a community serves another sort as hot (see README, Scores).
import {
    entryOf,
    nativeVotes,
    nativeWeightOf,
    optionInputs,
    redditHot,
    SORT_DATA_PATH_OPTION,
    sortData,
    validatePageSortSettings
} from "./sort-data.js";

export const hotScore = (map, { comment, commentUpdate, options }) => {
    const entry = entryOf(map, commentUpdate);
    const score = (entry?.score ?? 0) + nativeWeightOf(options) * nativeVotes(commentUpdate);
    return redditHot(score, entry?.createdUtc ?? comment.timestamp);
};

export function redditHotSort(sortName) {
    return function ({ pageSortSettings }) {
        const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
        return {
            sortName,
            description: "Reddit's hot order, from the Reddit score of mirrored posts plus Bitsocial votes",
            scope: "posts",
            optionInputs,
            defaultOptions: { nativeWeight: "1" },
            score: (args) => hotScore(data.map, args),
            validatePageSortSettings
        };
    };
}
