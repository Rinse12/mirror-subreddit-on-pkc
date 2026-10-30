// Why a source failed, which decides whether the caller moves on to the next source
export type FetchFailure = "throttled" | "blocked" | "unavailable";

export class FetchError extends Error {
    constructor(
        readonly failure: FetchFailure,
        message: string,
        // How long the host asked us to wait, when it said
        readonly retryAfterMs?: number
    ) {
        super(message);
    }
}

const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

// Keeps requests to one host polite: one at a time, at least minIntervalMs apart, and none while the host has
// asked us to back off (its X-RateLimit-Reset / Retry-After, else 1 min doubling up to 1 h). A request made
// during a backoff fails at once instead of waiting, so a caller with another source can move on.
export class HostThrottle {
    private queue: Promise<unknown> = Promise.resolve();
    private nextAt = 0;
    private backoffUntil = 0;
    private backoffMs = 0;

    constructor(
        readonly minIntervalMs: number,
        private readonly now: () => number = Date.now,
        private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    ) {}

    run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.queue.then(async () => {
            if (this.backoffUntil > this.now())
                throw new FetchError(
                    "throttled",
                    `backing off until ${new Date(this.backoffUntil).toISOString()}`,
                    this.backoffUntil - this.now()
                );
            const wait = this.nextAt - this.now();
            if (wait > 0) await this.sleep(wait);
            try {
                const value = await task();
                this.backoffMs = 0;
                return value;
            } catch (error) {
                if (error instanceof FetchError && error.failure === "throttled") {
                    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, MAX_BACKOFF_MS) : MIN_BACKOFF_MS;
                    this.backoffUntil = this.now() + Math.max(error.retryAfterMs ?? 0, this.backoffMs);
                }
                throw error;
            } finally {
                this.nextAt = this.now() + this.minIntervalMs;
            }
        });
        this.queue = result.catch(() => {});
        return result;
    }
}

export interface FetchOptions {
    headers?: Record<string, string>;
    timeoutMs?: number;
    throttle?: HostThrottle;
}

// Arctic Shift sends X-RateLimit-Reset (seconds until reset); others may send Retry-After (seconds)
function retryAfterMs(headers: Headers): number | undefined {
    const seconds = Number(headers.get("x-ratelimit-reset") ?? headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

async function request(url: string, headers: Record<string, string> | undefined, timeoutMs: number): Promise<string> {
    let response: Response;
    try {
        response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        throw new FetchError("unavailable", `${url}: ${(error as Error).message}`);
    }
    // Arctic Shift answers 422 "Timeout. Maybe slow down a bit" when it wants less traffic
    if (response.status === 429 || response.status === 422)
        throw new FetchError("throttled", `${url}: HTTP ${response.status}`, retryAfterMs(response.headers));
    // Reddit answers unauthenticated clients it doesn't like with 403, or a redirect to its login page
    if (response.status === 403 || (response.status >= 300 && response.status < 400))
        throw new FetchError("blocked", `${url}: HTTP ${response.status} ${response.headers.get("location") ?? ""}`.trim());
    if (!response.ok) throw new FetchError("unavailable", `${url}: HTTP ${response.status}`);
    return response.text();
}

export function fetchText(url: string, { headers, timeoutMs = 30_000, throttle }: FetchOptions = {}): Promise<string> {
    return throttle ? throttle.run(() => request(url, headers, timeoutMs)) : request(url, headers, timeoutMs);
}

export async function fetchJson(url: string, options?: FetchOptions): Promise<unknown> {
    const text = await fetchText(url, options);
    try {
        return JSON.parse(text);
    } catch {
        throw new FetchError("unavailable", `${url}: not JSON (${text.slice(0, 80)})`);
    }
}
