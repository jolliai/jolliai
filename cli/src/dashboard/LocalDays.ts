/**
 * Local-calendar arithmetic, DST-safe.
 *
 * Its own module because the day-bucketing rules now have two callers that must
 * not import each other: the read path in {@link ./DashboardQuery.ts} and the
 * rollup builder in {@link ./StatsRollup.ts}, which runs on the WRITE side and
 * is reached from `StatsWriter` — while `DashboardQuery` already imports
 * `StatsWriter`. Leaving these here rather than in either of them is what keeps
 * that from becoming a cycle.
 *
 * A cached day and a live day must agree on where a boundary falls to the
 * millisecond, so both sides deriving their days from THIS code is not tidiness
 * — a second implementation would disagree exactly on the DST days these
 * functions exist to get right, and disagree silently.
 */

/** Shape of a local calendar day key, `YYYY-MM-DD`. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The machine's IANA zone — the default for every query. */
export function machineTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

interface ZonedParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = partsFormatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		partsFormatterCache.set(timeZone, formatter);
	}
	return formatter;
}

/** Wall-clock components of `ms` in `timeZone`. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
	const parts = partsFormatter(timeZone).formatToParts(ms);
	const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
	return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Local calendar day of `ms` as `YYYY-MM-DD`. */
export function localDayKey(ms: number, timeZone: string): string {
	const p = zonedParts(ms, timeZone);
	return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Local hour (0–23) of `ms`. */
export function localHour(ms: number, timeZone: string): number {
	return zonedParts(ms, timeZone).hour;
}

/**
 * Epoch-ms of local midnight at the start of the day containing `ms`.
 *
 * `Intl` can only map epoch → wall clock; this inverts it by guessing the UTC
 * value of the wall-clock midnight and correcting by the observed error. Two
 * iterations settle every real zone including DST transitions whose 00:00
 * exists: the first correction lands within the zone's offset step, the second
 * removes any residue from a transition between guess and target, so the loop
 * returns the moment `error` reaches zero.
 *
 * On a "spring forward" day whose 00:00 does NOT exist — the clocks jump over
 * local midnight, as `Africa/Cairo` and `Asia/Beirut` do on their transition
 * dates — no epoch maps to 00:00, so the correction never reaches zero and
 * instead oscillates by the gap width. The earlier version returned that
 * oscillating value, which landed an hour short **inside the previous local
 * day**: `startOfLocalDay` then mapped it back to the previous day and the
 * forward day-step became a fixed point, hanging the whole read path. We now
 * fall through to {@link firstInstantOfLocalDay}, which returns the earliest
 * instant that genuinely belongs to this day (the moment right after the gap) —
 * a real day boundary, strictly inside the day, so stepping always advances.
 */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
	const targetNaive = Date.UTC(year, month - 1, day);
	let guess = targetNaive;
	for (let i = 0; i < 3; i++) {
		const seen = zonedParts(guess, timeZone);
		const error = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - targetNaive;
		if (error === 0) return guess;
		guess -= error;
	}
	return firstInstantOfLocalDay(year, month, day, timeZone);
}

/**
 * The earliest epoch-ms belonging to local day `year-month-day`, for the
 * spring-forward case where that day's 00:00 is skipped. The day is real (only
 * its first minute-or-two is missing), so its boundary is the instant right
 * after the gap. Found by bisecting, at minute resolution, the point where the
 * local day key first reaches the target — monotonic in time, and the engine is
 * minute-granular, so the answer is exact. The bracket (`-15 h` / `+14 h` around
 * naive midnight) is wider than any real UTC offset, so the low end is always in
 * an earlier local day and the high end is always at or past this day's start.
 */
function firstInstantOfLocalDay(year: number, month: number, day: number, timeZone: string): number {
	const targetKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	const naive = Date.UTC(year, month - 1, day);
	let loMin = Math.floor((naive - 15 * 3_600_000) / 60_000);
	let hiMin = Math.ceil((naive + 14 * 3_600_000) / 60_000);
	while (hiMin - loMin > 1) {
		const midMin = Math.floor((loMin + hiMin) / 2);
		if (localDayKey(midMin * 60_000, timeZone) < targetKey) loMin = midMin;
		else hiMin = midMin;
	}
	return hiMin * 60_000;
}

export function startOfLocalDay(ms: number, timeZone: string): number {
	const target = zonedParts(ms, timeZone);
	return localMidnight(target.year, target.month, target.day, timeZone);
}

/**
 * Epoch-ms of local midnight starting the day `key` (`YYYY-MM-DD`) names, or
 * `undefined` when `key` is not a real local day.
 *
 * The round-trip check is the validation: `Date.UTC` happily normalises
 * 2026-02-31 into March 3rd, so a request for a day that does not exist would
 * otherwise silently return data for a different one. Comparing the resolved
 * instant's own day key against the input rejects exactly that case — and
 * costs nothing on the overwhelmingly common valid input.
 */
export function dayKeyToMidnight(key: string, timeZone: string): number | undefined {
	if (!DAY_KEY_RE.test(key)) return undefined;
	const ms = localMidnight(
		Number.parseInt(key.slice(0, 4), 10),
		Number.parseInt(key.slice(5, 7), 10),
		Number.parseInt(key.slice(8, 10), 10),
		timeZone,
	);
	return localDayKey(ms, timeZone) === key ? ms : undefined;
}

/**
 * Start of the local day `n` days after the day containing `ms`. Steps through
 * midday rather than adding exact 24 h multiples, so 23- and 25-hour DST days
 * cannot skip or repeat a day.
 *
 * ⚠ Throws on a `days` that is not a finite integer, and the alternative is
 * worse than it looks. The loop terminates on `i !== days`, and `NaN` is not
 * equal to anything — including itself — so a `NaN` here does not produce a
 * wrong answer, it HANGS: the caller's thread spins forever inside a
 * synchronous function, holding whatever it holds, with nothing logged. That
 * is exactly how it presented (a dashboard query that never returned and no
 * slow statement to blame), reached by `-(RANGE_DAYS[preset] - 1)` for a preset
 * the table has no entry for.
 *
 * Throwing rather than clamping to 0 is deliberate: a non-integer day count
 * means the CALLER computed one, and a silent fallback would leave the page
 * rendering the default window as if that had been asked for. `parseRange`
 * already keeps unrecognised input out of the type, so nothing reachable trips
 * this — it is here because the function is now shared, and the failure mode it
 * removes is a hang rather than a wrong number.
 */
export function addLocalDays(ms: number, days: number, timeZone: string): number {
	if (!Number.isInteger(days)) throw new Error(`addLocalDays: days must be a finite integer, got ${days}`);
	let cursor = startOfLocalDay(ms, timeZone);
	const step = days >= 0 ? 1 : -1;
	for (let i = 0; i !== days; i += step) {
		// ±24 h from midnight, then +12 h INTO the target day: lands mid-day in
		// the neighbouring day whether it is 23, 24 or 25 hours long, and
		// startOfLocalDay snaps back to its midnight. (A ±36 h jump would
		// overshoot a whole day when stepping backwards.)
		cursor = startOfLocalDay(cursor + step * 86_400_000 + 43_200_000, timeZone);
	}
	return cursor;
}
