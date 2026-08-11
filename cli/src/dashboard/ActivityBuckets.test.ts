import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../Types.js";
import { ACTIVITY_BUCKET_MS, bucketsFrom } from "./ActivityBuckets.js";

const entry = (timestamp?: string): TranscriptEntry => ({
	role: "human",
	content: "x",
	...(timestamp ? { timestamp } : {}),
});

describe("bucketsFrom", () => {
	it("floors each timestamp to its quarter-hour start", () => {
		// 2026-08-11T10:07:23Z falls in the 10:00 bucket.
		expect(bucketsFrom([entry("2026-08-11T10:07:23.000Z")])).toEqual([Date.parse("2026-08-11T10:00:00.000Z")]);
		// 10:44:59 falls in the 10:30 bucket, not 10:45.
		expect(bucketsFrom([entry("2026-08-11T10:44:59.000Z")])).toEqual([Date.parse("2026-08-11T10:30:00.000Z")]);
	});

	it("dedupes messages sharing a bucket and returns ascending order", () => {
		const out = bucketsFrom([
			entry("2026-08-11T10:50:00.000Z"),
			entry("2026-08-11T10:07:00.000Z"),
			entry("2026-08-11T10:12:00.000Z"),
		]);
		expect(out).toEqual([Date.parse("2026-08-11T10:00:00.000Z"), Date.parse("2026-08-11T10:45:00.000Z")]);
	});

	it("occupies only the buckets a resumed session spoke in, never the span between", () => {
		// The measured 18-hour session shape: two messages, a night apart.
		const out = bucketsFrom([entry("2026-08-10T22:00:00.000Z"), entry("2026-08-11T16:00:00.000Z")]);
		expect(out).toHaveLength(2);
	});

	it("skips entries with no timestamp, and unparseable ones, without dropping the rest", () => {
		expect(bucketsFrom([entry(), entry("not-a-date"), entry("2026-08-11T10:07:00.000Z")])).toEqual([
			Date.parse("2026-08-11T10:00:00.000Z"),
		]);
	});

	it("returns empty when nothing is timestamped — the caller turns that into an ABSENT field", () => {
		expect(bucketsFrom([entry(), entry()])).toEqual([]);
		expect(bucketsFrom([])).toEqual([]);
	});

	it("produces integral buckets, which the STRICT column requires", () => {
		for (const b of bucketsFrom([entry("2026-08-11T10:07:23.456Z")])) {
			expect(Number.isInteger(b)).toBe(true);
			expect(b % ACTIVITY_BUCKET_MS).toBe(0);
		}
	});
});
