import { FetchError } from "./http.js";

const MIN_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

// Tries sources in order. One that fails goes on a cooldown (1 min, doubling up to 1 h) and is skipped until it
// ends; a success resets it. Errors that aren't FetchErrors are bugs, not source trouble, and are thrown as is.
export class SourcePool<S> {
    private readonly cooldowns = new Map<S, { until: number; ms: number }>();

    constructor(
        readonly sources: S[],
        private readonly now: () => number = Date.now
    ) {}

    async run<T>(task: (source: S) => Promise<T>): Promise<T> {
        const failures: string[] = [];
        for (const source of this.sources) {
            const cooldown = this.cooldowns.get(source);
            if (cooldown && cooldown.until > this.now()) continue;
            try {
                const result = await task(source);
                this.cooldowns.delete(source);
                return result;
            } catch (error) {
                if (!(error instanceof FetchError)) throw error;
                const ms = cooldown ? Math.min(cooldown.ms * 2, MAX_COOLDOWN_MS) : MIN_COOLDOWN_MS;
                // A host that said how long to wait gets at least that long
                this.cooldowns.set(source, { until: this.now() + Math.max(ms, error.retryAfterMs ?? 0), ms });
                failures.push(error.message);
            }
        }
        throw new FetchError(
            "unavailable",
            failures.length ? `All sources failed:\n  ${failures.join("\n  ")}` : "All sources cooling down"
        );
    }
}
