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
