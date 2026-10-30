const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Re-check interval by age: every 10 min for the first 6 h, hourly until day 2, then daily. The interval is also
// the precision of the removal window shown to users.
export function recheckIntervalSeconds(ageSeconds: number): number {
    if (ageSeconds < 6 * HOUR) return 10 * MINUTE;
    if (ageSeconds < 2 * DAY) return HOUR;
    return DAY;
}

// When to check an item next, or null once it is older than commentUpdateDays (unix seconds throughout)
export function nextCheckAt(createdUtc: number, now: number, commentUpdateDays: number): number | null {
    const next = now + recheckIntervalSeconds(now - createdUtc);
    return next - createdUtc > commentUpdateDays * DAY ? null : next;
}
