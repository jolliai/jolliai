import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
	hostname: vi.fn(),
}));

import { hostname } from "node:os";
import { getDeviceLabel, sanitizeDeviceLabel } from "./DeviceLabel.js";

describe("sanitizeDeviceLabel", () => {
	it("preserves a typical macOS hostname unchanged", () => {
		expect(sanitizeDeviceLabel("Foster-MacBook-Pro.local")).toBe("Foster-MacBook-Pro.local");
	});

	it("preserves a typical Windows hostname unchanged", () => {
		expect(sanitizeDeviceLabel("DESKTOP-ABC123")).toBe("DESKTOP-ABC123");
	});

	it("preserves internal spaces, underscores, dots, and hyphens", () => {
		expect(sanitizeDeviceLabel("my host_name.v1-prod")).toBe("my host_name.v1-prod");
	});

	it("trims surrounding whitespace before filtering", () => {
		expect(sanitizeDeviceLabel("   desktop-1   ")).toBe("desktop-1");
	});

	it("strips disallowed characters (control chars, quotes, angle brackets, slashes)", () => {
		// Mirror the server allow-list — anything outside [A-Za-z0-9 _.-] is dropped.
		expect(sanitizeDeviceLabel('name"quoted')).toBe("namequoted");
		expect(sanitizeDeviceLabel("name'apostrophe")).toBe("nameapostrophe");
		expect(sanitizeDeviceLabel("<script>")).toBe("script");
		expect(sanitizeDeviceLabel("path/with/slashes")).toBe("pathwithslashes");
		expect(sanitizeDeviceLabel("tab\there")).toBe("tabhere");
		expect(sanitizeDeviceLabel("null\x00byte")).toBe("nullbyte");
	});

	it("strips non-ASCII Unicode (e.g. accented characters)", () => {
		expect(sanitizeDeviceLabel("café")).toBe("caf");
	});

	it("truncates to 32 characters", () => {
		const long = "a".repeat(50);
		const result = sanitizeDeviceLabel(long);
		expect(result).toBe("a".repeat(32));
		expect(result?.length).toBe(32);
	});

	it("truncates AFTER stripping, so disallowed bytes don't consume the budget", () => {
		// 30 valid chars + 5 disallowed → after strip we have 30 chars, no truncation.
		const input = `${"a".repeat(30)}<<<<<`;
		expect(sanitizeDeviceLabel(input)).toBe("a".repeat(30));
	});

	it("returns undefined for an empty string", () => {
		expect(sanitizeDeviceLabel("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only input", () => {
		expect(sanitizeDeviceLabel("   ")).toBeUndefined();
	});

	it("returns undefined when input contains only disallowed characters", () => {
		// All bytes are outside the allow-list → cleaned string is empty.
		expect(sanitizeDeviceLabel("///\x00\x01")).toBeUndefined();
		expect(sanitizeDeviceLabel("中文")).toBeUndefined();
	});
});

describe("getDeviceLabel", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("returns the sanitized hostname() value", () => {
		vi.mocked(hostname).mockReturnValue("Foster-MBP.local");
		expect(getDeviceLabel()).toBe("Foster-MBP.local");
	});

	it("applies the same sanitization rules as sanitizeDeviceLabel", () => {
		vi.mocked(hostname).mockReturnValue("  has spaces and <unsafe>  ");
		expect(getDeviceLabel()).toBe("has spaces and unsafe");
	});

	it("returns undefined when hostname() returns an empty string", () => {
		vi.mocked(hostname).mockReturnValue("");
		expect(getDeviceLabel()).toBeUndefined();
	});

	it("returns undefined when hostname() returns a value of only disallowed characters", () => {
		vi.mocked(hostname).mockReturnValue("中文主机");
		expect(getDeviceLabel()).toBeUndefined();
	});
});
