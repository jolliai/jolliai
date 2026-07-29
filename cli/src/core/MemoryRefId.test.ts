import { describe, expect, it } from "vitest";
import { formatMemoryRefId, formatMemoryRefIdWithHashFallback, MEMORY_REF_PREFIX } from "./MemoryRefId.js";

describe("formatMemoryRefId", () => {
	it("formats a positive integer doc id as JM-<n>", () => {
		expect(formatMemoryRefId(142)).toBe("JM-142");
		expect(formatMemoryRefId(1)).toBe("JM-1");
	});

	it("uses the shared MEMORY_REF_PREFIX", () => {
		expect(formatMemoryRefId(9)).toBe(`${MEMORY_REF_PREFIX}9`);
	});

	it("returns undefined when the doc id is missing", () => {
		expect(formatMemoryRefId(undefined)).toBeUndefined();
	});

	it("returns undefined for non-positive or non-integer doc ids", () => {
		expect(formatMemoryRefId(0)).toBeUndefined();
		expect(formatMemoryRefId(-5)).toBeUndefined();
		expect(formatMemoryRefId(1.5)).toBeUndefined();
		expect(formatMemoryRefId(Number.NaN)).toBeUndefined();
		expect(formatMemoryRefId(Number.POSITIVE_INFINITY)).toBeUndefined();
	});
});

describe("formatMemoryRefIdWithHashFallback", () => {
	const hash = "f159924cabc0000000000000000000000000dead";

	it("uses the doc id when present", () => {
		expect(formatMemoryRefIdWithHashFallback(142, hash)).toBe("JM-142");
	});

	it("falls back to JM-<first 8 hash chars> when there is no doc id", () => {
		expect(formatMemoryRefIdWithHashFallback(undefined, hash)).toBe("JM-f159924c");
	});

	it("uses the hash fallback for non-positive / non-integer doc ids too", () => {
		expect(formatMemoryRefIdWithHashFallback(0, hash)).toBe("JM-f159924c");
		expect(formatMemoryRefIdWithHashFallback(1.5, hash)).toBe("JM-f159924c");
	});

	it("uses the whole hash when it is shorter than 8 chars", () => {
		expect(formatMemoryRefIdWithHashFallback(undefined, "abc123")).toBe("JM-abc123");
	});
});
