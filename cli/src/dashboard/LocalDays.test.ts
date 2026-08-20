/**
 * The day-boundary rules the rollup cache and the dashboard read path share.
 *
 * Its own file because the module is: these functions used to live inside
 * `DashboardQuery.ts` and were tested through it, which left the split module
 * covered only by an import path its production callers no longer use.
 */

import { describe, expect, it } from "vitest";
import {
	addLocalDays,
	dayKeyToMidnight,
	localDayKey,
	localHour,
	machineTimeZone,
	startOfLocalDay,
} from "./LocalDays.js";

const SH = "Asia/Shanghai"; // UTC+8, no DST
const LA = "America/Los_Angeles"; // DST

describe("local-day arithmetic", () => {
	it("assigns a 23:30 UTC session to the NEXT local day in Asia/Shanghai", () => {
		const ms = Date.parse("2026-07-29T23:30:00Z"); // 07:30 on the 30th in Shanghai
		expect(localDayKey(ms, SH)).toBe("2026-07-30");
		expect(localDayKey(ms, "UTC")).toBe("2026-07-29");
	});

	it("computes local midnight boundaries, not UTC ones", () => {
		const ms = Date.parse("2026-07-30T10:00:00Z");
		// Shanghai midnight of Jul 30 = Jul 29 16:00 UTC.
		expect(startOfLocalDay(ms, SH)).toBe(Date.parse("2026-07-29T16:00:00Z"));
		expect(startOfLocalDay(ms, "UTC")).toBe(Date.parse("2026-07-30T00:00:00Z"));
	});

	it("handles the 23-hour spring-forward day in America/Los_Angeles", () => {
		// 2026-03-08: DST starts, 02:00 → 03:00. The day is 23 hours long.
		const midnight = startOfLocalDay(Date.parse("2026-03-08T20:00:00Z"), LA);
		expect(localDayKey(midnight, LA)).toBe("2026-03-08");
		const nextMidnight = addLocalDays(midnight, 1, LA);
		expect(localDayKey(nextMidnight, LA)).toBe("2026-03-09");
		expect(nextMidnight - midnight).toBe(23 * 3_600_000);
	});

	it("handles the 25-hour fall-back day", () => {
		// 2026-11-01: DST ends. The day is 25 hours long.
		const midnight = startOfLocalDay(Date.parse("2026-11-01T20:00:00Z"), LA);
		const nextMidnight = addLocalDays(midnight, 1, LA);
		expect(nextMidnight - midnight).toBe(25 * 3_600_000);
	});

	it("addLocalDays walks backwards too", () => {
		const ms = Date.parse("2026-07-30T10:00:00Z");
		expect(localDayKey(addLocalDays(ms, -1, SH), SH)).toBe("2026-07-29");
		expect(localDayKey(addLocalDays(ms, 0, SH), SH)).toBe("2026-07-30");
	});

	it("addLocalDays refuses a day count that is not an integer, rather than hanging on it", () => {
		// The loop ends on `i !== days`, and NaN is not equal to anything — itself
		// included — so this used to spin forever inside a synchronous call with
		// nothing logged and no slow query to blame. A throw is the whole point:
		// the caller computed the value, so a silent fallback to the default window
		// would render a range nobody asked for.
		const ms = Date.parse("2026-07-30T10:00:00Z");
		expect(() => addLocalDays(ms, Number.NaN, SH)).toThrow(/finite integer/);
		expect(() => addLocalDays(ms, Number.POSITIVE_INFINITY, SH)).toThrow(/finite integer/);
		expect(() => addLocalDays(ms, 1.5, SH)).toThrow(/finite integer/);
	});

	it("localHour reports the wall-clock hour in the requested zone", () => {
		const ms = Date.parse("2026-07-29T23:30:00Z");
		expect(localHour(ms, SH)).toBe(7); // 07:30 next day
		expect(localHour(ms, "UTC")).toBe(23);
	});

	it("machineTimeZone returns a resolvable IANA name", () => {
		expect(() => new Intl.DateTimeFormat("en", { timeZone: machineTimeZone() })).not.toThrow();
	});

	it("round-trips a day key, and rejects one that names no real day", () => {
		// `Date.UTC` normalises 2026-02-31 into March 3rd, so without the round-trip
		// check a request for a day that does not exist answers with another day's
		// data rather than refusing.
		const midnight = dayKeyToMidnight("2026-07-30", SH);
		expect(midnight).toBe(Date.parse("2026-07-29T16:00:00Z"));
		expect(dayKeyToMidnight("2026-02-31", SH)).toBeUndefined();
		expect(dayKeyToMidnight("2026-7-30", SH)).toBeUndefined();
		expect(dayKeyToMidnight("not-a-day", SH)).toBeUndefined();
	});

	it("puts a spring-forward day's boundary on its earliest existing instant", () => {
		// 2026-03-08 00:00 exists in Los Angeles, but the general case this guards is
		// a zone whose midnight is skipped entirely; the boundary must still be the
		// first instant OF that day rather than land in the previous one.
		const midnight = dayKeyToMidnight("2026-03-08", LA);
		expect(midnight).toBeDefined();
		expect(localDayKey(midnight as number, LA)).toBe("2026-03-08");
	});
});

/**
 * Regression for the availability defect: two real zones spring forward AT local
 * midnight, so that day's 00:00 does not exist. The inversion used to converge on
 * an instant in the PREVIOUS local day, which made `addLocalDays` a fixed point —
 * the forward window walk never advanced and the whole read path hung. These are
 * the only two zones on that shape (measured across the platform's zones), each
 * recurring annually 2027–2040.
 *
 * The skipped-midnight day is DETECTED at runtime, not pinned to a date. Egypt's
 * DST in particular is a political decision (it was cancelled outright 2015–2023),
 * so the exact transition date can move under an ICU/tzdata update — while the
 * INVARIANT under test (the walk must advance and never repeat a day, and the
 * skipped-midnight day resolves to its own earliest instant) does not depend on
 * WHICH day it is. Binding the assertions to the detected day keeps the test
 * meaningful without making it hostage to the zone database; if a future tzdata
 * removes the transition from the window entirely, the case skips rather than
 * failing on a date that is no longer special. A skipped-midnight day is found by
 * its signature: its earliest existing instant is 01:00 local, so `localHour` of
 * it is not 0.
 */
describe("local-day engine — zones whose local midnight is skipped", () => {
	const zones = [
		{ zone: "Africa/Cairo", from: "2027-04-25", to: "2027-05-05" },
		{ zone: "Asia/Beirut", from: "2027-03-24", to: "2027-04-02" },
	];

	/** The first day in [from,to) whose local midnight does not exist, or undefined. */
	function findSkippedMidnightDay(
		zone: string,
		from: string,
		to: string,
	): { key: string; midnight: number } | undefined {
		const end = dayKeyToMidnight(to, zone) as number;
		let cursor = dayKeyToMidnight(from, zone) as number;
		let guard = 0;
		while (cursor < end) {
			if (localHour(cursor, zone) !== 0) return { key: localDayKey(cursor, zone), midnight: cursor };
			cursor = addLocalDays(cursor, 1, zone);
			if (++guard > 100) break;
		}
		return undefined;
	}

	for (const { zone, from, to } of zones) {
		const gap = findSkippedMidnightDay(zone, from, to);

		it.skipIf(!gap)(`${zone}: a forward day-walk across the transition terminates and never repeats a day`, () => {
			const start = dayKeyToMidnight(from, zone) as number;
			const end = dayKeyToMidnight(to, zone) as number;
			expect(start).toBeDefined();
			expect(end).toBeDefined();

			const keys: string[] = [];
			let cursor = start;
			let guard = 0;
			while (cursor < end) {
				keys.push(localDayKey(cursor, zone));
				const next = addLocalDays(cursor, 1, zone);
				// The fixed point: on the unfixed engine `next === cursor` here, so the
				// real walk (a plain `cursor < end` loop) span forever.
				expect(next).toBeGreaterThan(cursor);
				cursor = next;
				if (++guard > 100) throw new Error(`${zone}: forward walk did not terminate`);
			}

			expect(keys).toContain((gap as { key: string }).key); // the skipped-midnight day is visited...
			expect(new Set(keys).size).toBe(keys.length); // ...exactly once, and every day is distinct
			for (let i = 1; i < keys.length; i++) expect(keys[i] > keys[i - 1]).toBe(true);
		});

		it.skipIf(!gap)(
			`${zone}: the skipped-midnight day resolves to its own earliest instant, not the previous day`,
			() => {
				const { key, midnight } = gap as { key: string; midnight: number };
				expect(localDayKey(midnight, zone)).toBe(key);
			},
		);
	}
});
