// Newest first by Reddit creation time; native posts by their timestamp
import { entryOf, optionInputs, SORT_DATA_PATH_OPTION, sortData, validatePageSortSettings } from "./sort-data.js";

export default function mirroredRedditNew({ pageSortSettings }) {
    const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
    return {
        sortName: "mirrored-reddit-new",
        description: "Newest first, by the time a mirrored post was made on Reddit",
        scope: "posts",
        optionInputs,
        defaultOptions: {},
        score: ({ comment, commentUpdate }) => entryOf(data.map, commentUpdate)?.createdUtc ?? comment.timestamp,
        validatePageSortSettings
    };
}
