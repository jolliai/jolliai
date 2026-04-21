import { afterEach, describe, expect, it, vi } from "vitest";
import {
	escMd,
	formatRelativeDate,
	formatShortRelativeDate,
} from "./FormatUtils.js";

describe("FormatUtils", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats recent dates as just now", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

		expect(formatRelativeDate("2026-03-30T11:59:45.000Z")).toContain(
			"just now",
		);
		expect(formatShortRelativeDate("2026-03-30T11:59:45.000Z")).toBe(
			"just now",
		);
	});

	it("formats minute, hour, day, month, and year ranges", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

		expect(formatRelativeDate("2026-03-30T11:15:00.000Z")).toContain(
			"45 minutes ago",
		);
		expect(formatRelativeDate("2026-03-30T09:00:00.000Z")).toContain(
			"3 hours ago",
		);
		expect(formatRelativeDate("2026-03-27T12:00:00.000Z")).toContain(
			"3 days ago",
		);
		expect(formatRelativeDate("2026-02-10T12:00:00.000Z")).toContain(
			"1 month ago",
		);
		expect(formatRelativeDate("2024-03-30T12:00:00.000Z")).toContain(
			"2 years ago",
		);

		expect(formatShortRelativeDate("2026-03-30T11:15:00.000Z")).toBe("45m ago");
		expect(formatShortRelativeDate("2026-03-30T09:00:00.000Z")).toBe("3h ago");
		expect(formatShortRelativeDate("2026-03-27T12:00:00.000Z")).toBe("3d ago");
		expect(formatShortRelativeDate("2026-02-10T12:00:00.000Z")).toBe("1mo ago");
		expect(formatShortRelativeDate("2024-03-30T12:00:00.000Z")).toBe("2y ago");
	});

	it("formats singular forms (exactly 1 minute, 1 hour, 1 day, 1 month, 1 year)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-30T12:00:00.000Z"));

		// Exactly 1 minute ago — covers diffMins === 1 branch (no "s")
		expect(formatRelativeDate("2026-03-30T11:59:00.000Z")).toContain(
			"1 minute ago",
		);

		// Exactly 1 hour ago — covers diffHours === 1 branch (no "s")
		expect(formatRelativeDate("2026-03-30T11:00:00.000Z")).toContain(
			"1 hour ago",
		);

		// Exactly 1 day ago — covers diffDays === 1 branch (no "s")
		expect(formatRelativeDate("2026-03-29T12:00:00.000Z")).toContain(
			"1 day ago",
		);

		// Exactly 1 month ago (30 days) — covers diffMonths === 1 branch (no "s")
		expect(formatRelativeDate("2026-02-28T12:00:00.000Z")).toContain(
			"1 month ago",
		);

		// Exactly 1 year ago (365 days) — covers diffYears === 1 branch (no "s")
		expect(formatRelativeDate("2025-03-30T12:00:00.000Z")).toContain(
			"1 year ago",
		);
	});

	it("formats plural months ago (e.g. 3 months)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

		// ~3 months ago (90 days)
		expect(formatRelativeDate("2026-03-15T12:00:00.000Z")).toContain(
			"3 months ago",
		);
	});

	it("surfaces invalid Date output for malformed timestamps", () => {
		expect(formatRelativeDate("not-a-date-value")).toBe(
			"NaN years ago (Invalid Date)",
		);
		expect(formatShortRelativeDate("also-not-a-date")).toBe("NaNy ago");
	});

	it("formatRelativeDate catch block returns iso substring when Date methods throw", () => {
		const spy = vi
			.spyOn(Date.prototype, "toLocaleString")
			.mockImplementation(() => {
				throw new Error("locale error");
			});

		expect(formatRelativeDate("2026-03-30T12:00:00Z")).toBe("2026-03-30");

		spy.mockRestore();
	});

	it("formatShortRelativeDate catch block returns iso substring when getTime throws", () => {
		const spy = vi.spyOn(Date.prototype, "getTime").mockImplementation(() => {
			throw new Error("getTime error");
		});

		expect(formatShortRelativeDate("2026-03-30T12:00:00Z")).toBe("2026-03-30");

		spy.mockRestore();
	});

	it("escapes markdown-special characters", () => {
		expect(escMd("\\`*_{}[]()#+-.!|<>")).toBe(
			"\\\\\\`\\*\\_\\{\\}\\[\\]\\(\\)\\#\\+\\-\\.\\!\\|\\<\\>",
		);
	});
});
