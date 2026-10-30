import type { Observed } from "../reddit.js";

// What the daemon needs from a live source (Redlib or Reddit's .json); tried in order through a SourcePool
export interface LiveSource {
    readonly name: string;
    listNewPosts(subreddit: string): Promise<Observed[]>;
    // The post and every comment the source shows
    fetchThread(permalink: string): Promise<{ post: Observed; comments: Observed[] }>;
    // The comment's current state; null when it is gone (Redlib can't tell removed from deleted)
    checkComment(permalink: string, commentId: string): Promise<Observed | null>;
}
