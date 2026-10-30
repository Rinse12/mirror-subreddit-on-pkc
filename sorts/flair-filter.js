// Pages that hold only flaired comments. Nothing here is Reddit-specific: `flairs` names the flair texts that
// count, and a comment without one of them is declined (score null drops it from this sort's pages). The mirror
// publishes it with its removal flairs, so the page lists what Reddit removed; any community that flairs
// things can use it as a filter.
//
// Posts: a post is kept when it or any reply under it (pkc-js hands every descendant to a requireReplies sort)
// carries one of the flairs. `order` is "flaired" (the most recently flaired first, from the mirror's sort data,
// falling back to the post's time) or "new" (newest post first).
//
// Replies: a flat page of the flaired replies in the thread, so a removed answer shows even when its parent is
// up, in mirrored-reddit-best order.
import { bestScore } from "./reddit-best.js";
import {
    entryOf,
    NATIVE_WEIGHT_OPTION,
    nativeWeightOf,
    optionInputs as dataOptionInputs,
    SORT_DATA_PATH_OPTION,
    sortData
} from "./sort-data.js";

export const FLAIRS_OPTION = "flairs";
export const ORDER_OPTION = "order";
// The mirror's removal flairs (src/content.ts, statusFlair), minus author deletions and locks
export const DEFAULT_FLAIRS = [
    "Removed by mods on Reddit",
    "Removed by Reddit admins",
    "Removed on Reddit",
    "Removed or deleted on Reddit"
];
const ORDERS = ["flaired", "new"];

const flairsOption = {
    option: FLAIRS_OPTION,
    label: "Flairs",
    description: "Comma-separated flair texts; a comment needs one of them to appear on this page",
    placeholder: DEFAULT_FLAIRS.join(",")
};
const orderOption = {
    option: ORDER_OPTION,
    label: "Order",
    description: `"flaired": most recently flaired first (needs the mirror's sort data, else the post's time); "new": newest post first`,
    placeholder: "flaired"
};
const sortDataOption = {
    ...dataOptionInputs.find((input) => input.option === SORT_DATA_PATH_OPTION),
    description: "Optional: the mirror daemon's JSON file for this community, for the flaired order and Reddit scores"
};
const nativeWeightOption = dataOptionInputs.find((input) => input.option === NATIVE_WEIGHT_OPTION);

export const flairSet = (options) =>
    new Set(
        (options?.[FLAIRS_OPTION] ?? DEFAULT_FLAIRS.join(","))
            .split(",")
            .map((text) => text.trim())
            .filter(Boolean)
    );

// A mod flair (commentUpdate.flairs) overrides the author's (comment.flairs), as pkc-js documents
export const flairTexts = (comment, commentUpdate) =>
    (commentUpdate?.flairs ?? comment?.flairs ?? []).map((flair) => flair?.text?.trim()).filter(Boolean);

export const hasFlair = (comment, commentUpdate, wanted) => flairTexts(comment, commentUpdate).some((text) => wanted.has(text));

function validate({ pageSortSettings }) {
    const options = pageSortSettings.options ?? {};
    if (options[FLAIRS_OPTION] !== undefined && !flairSet(options).size)
        throw new Error(`${FLAIRS_OPTION} must list at least one flair text`);
    if (options[ORDER_OPTION] !== undefined && !ORDERS.includes(options[ORDER_OPTION]))
        throw new Error(`${ORDER_OPTION} must be one of ${ORDERS.join(", ")}, got "${options[ORDER_OPTION]}"`);
    const weight = options[NATIVE_WEIGHT_OPTION];
    if (weight !== undefined && !Number.isFinite(Number(weight)))
        throw new Error(`${NATIVE_WEIGHT_OPTION} must be a number, got "${weight}"`);
}

export function flairedPostsSort(sortName) {
    return function ({ pageSortSettings }) {
        const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
        return {
            sortName,
            description: "Only posts that carry one of the configured flairs, or have a reply that does; most recently flaired first",
            scope: "posts",
            requireReplies: true,
            optionInputs: [flairsOption, orderOption, sortDataOption],
            defaultOptions: { [FLAIRS_OPTION]: DEFAULT_FLAIRS.join(","), [ORDER_OPTION]: "flaired" },
            score: ({ comment, commentUpdate, options, replies }) => {
                const wanted = flairSet(options);
                const own = hasFlair(comment, commentUpdate, wanted);
                const flairedReplies = (replies ?? []).filter((reply) => hasFlair(reply.comment, reply.commentUpdate, wanted));
                if (!own && !flairedReplies.length) return null;
                const entry = entryOf(data.map, commentUpdate);
                const created = entry?.createdUtc ?? comment.timestamp;
                if (options?.[ORDER_OPTION] === "new") return created;
                let flairedAt = own ? (entry?.flairedAt ?? null) : null;
                for (const reply of flairedReplies) {
                    const at = entryOf(data.map, reply.commentUpdate)?.flairedAt;
                    if (at) flairedAt = Math.max(flairedAt ?? 0, at);
                }
                return flairedAt ?? created;
            },
            validatePageSortSettings: validate
        };
    };
}

export function flairedRepliesSort(sortName) {
    return function ({ pageSortSettings }) {
        const data = sortData(pageSortSettings.options?.[SORT_DATA_PATH_OPTION]);
        return {
            sortName,
            description: "Only the replies that carry one of the configured flairs, flat, by Reddit score plus Bitsocial votes",
            scope: "replies",
            flat: true,
            optionInputs: [flairsOption, sortDataOption, nativeWeightOption],
            defaultOptions: { [FLAIRS_OPTION]: DEFAULT_FLAIRS.join(","), [NATIVE_WEIGHT_OPTION]: "1" },
            score: (args) => (hasFlair(args.comment, args.commentUpdate, flairSet(args.options)) ? bestScore(data.map, args) : null),
            validatePageSortSettings: validate
        };
    };
}
