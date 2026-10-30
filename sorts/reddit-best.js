// Reddit score plus native votes, older first among equals. Shared by mirrored-reddit-best.js and the flair filter;
// a module of its own because the community node imports a sort file once per process (Node's ES module cache),
// so a new file must not depend on a new export of a file the node may have imported before.
import { entryOf, nativeVotes, nativeWeightOf } from "./sort-data.js";

export const bestScore = (map, { comment, commentUpdate, options }) => {
    const entry = entryOf(map, commentUpdate);
    const score = (entry?.score ?? 0) + nativeWeightOf(options) * nativeVotes(commentUpdate);
    // The tie-break folded into the score: an earlier reply wins by a fraction smaller than one vote
    return score - (entry?.createdUtc ?? comment.timestamp) / 1e10;
};
