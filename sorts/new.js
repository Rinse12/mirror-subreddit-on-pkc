// Newest first by Reddit creation time, under the built-in name; native posts by their timestamp
import { entryOf, optionInputs, SORT_DATA_PATH_OPTION, sortData, validatePageSortSettings } from "./sort-data.js";

export default function redditNew({ pageSortSettings }) {
    const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
    return {
        sortName: "new",
        description: "Newest first, by the time a mirrored post was made on Reddit",
        scope: "posts",
        optionInputs,
        defaultOptions: {},
        score: ({ comment, commentUpdate }) => entryOf(data.map, commentUpdate)?.createdUtc ?? comment.timestamp,
        validatePageSortSettings
    };
}
