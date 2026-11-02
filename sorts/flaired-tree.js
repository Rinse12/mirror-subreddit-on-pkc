// The thread's reply tree cut down to what was flaired: a reply stays when it carries one of the flairs or any
// reply under it does, so a removed answer shows in its place with the chain of parents above it, and nothing
// else. In mirrored-reddit-best order. A nested reply sort: a declined reply takes its subtree with it, which is
// what makes the cut (pkc-js, page-sorts.md, "null declines"). Its own file because the node imports a sort file
// once per process: it uses only exports the older files already had.
import { DEFAULT_FLAIRS, flairSet, hasFlair } from "./flair-filter.js";
import { bestScore } from "./reddit-best.js";
import { NATIVE_WEIGHT_OPTION, optionInputs as dataOptionInputs, SORT_DATA_PATH_OPTION, sortData } from "./sort-data.js";

const FLAIRS_OPTION = "flairs";
const flairsOption = {
    option: FLAIRS_OPTION,
    label: "Flairs",
    description: "Comma-separated flair texts; a reply needs one of them, on itself or on a reply under it, to appear",
    placeholder: DEFAULT_FLAIRS.join(",")
};
const sortDataOption = {
    ...dataOptionInputs.find((input) => input.option === SORT_DATA_PATH_OPTION),
    description: "Optional: the mirror daemon's JSON file for this community, for Reddit scores"
};
const nativeWeightOption = dataOptionInputs.find((input) => input.option === NATIVE_WEIGHT_OPTION);

function validate({ pageSortSettings }) {
    const options = pageSortSettings.options ?? {};
    if (options[FLAIRS_OPTION] !== undefined && !flairSet(options).size)
        throw new Error(`${FLAIRS_OPTION} must list at least one flair text`);
    const weight = options[NATIVE_WEIGHT_OPTION];
    if (weight !== undefined && !Number.isFinite(Number(weight)))
        throw new Error(`${NATIVE_WEIGHT_OPTION} must be a number, got "${weight}"`);
}

export default function flairedTree({ pageSortSettings }) {
    const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
    return {
        sortName: "flaired-tree",
        description:
            "Only the replies that carry one of the configured flairs and the replies above them, in place, by Reddit score plus Bitsocial votes",
        scope: "replies",
        flat: false,
        requireReplies: true,
        optionInputs: [flairsOption, sortDataOption, nativeWeightOption],
        defaultOptions: { [FLAIRS_OPTION]: DEFAULT_FLAIRS.join(","), [NATIVE_WEIGHT_OPTION]: "1" },
        score: (args) => {
            const wanted = flairSet(args.options);
            const kept =
                hasFlair(args.comment, args.commentUpdate, wanted) ||
                (args.replies ?? []).some((reply) => hasFlair(reply.comment, reply.commentUpdate, wanted));
            return kept ? bestScore(data.map, args) : null;
        },
        validatePageSortSettings: validate
    };
}
