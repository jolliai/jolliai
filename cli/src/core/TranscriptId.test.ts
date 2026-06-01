import { describe, expect, it } from "vitest";
import { generateTranscriptId, transcriptIdFromPath } from "./TranscriptId.js";

describe("TranscriptId", () => {
	describe("generateTranscriptId", () => {
		it("returns an RFC 4122 v4 UUID", () => {
			expect(generateTranscriptId()).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		});

		it("returns a fresh value on each call", () => {
			expect(generateTranscriptId()).not.toBe(generateTranscriptId());
		});
	});

	describe("transcriptIdFromPath", () => {
		it("extracts the opaque ID from a transcripts/<id>.json path", () => {
			expect(transcriptIdFromPath("transcripts/abc123.json")).toBe("abc123");
		});

		it("extracts a v5 UUID (with hyphens) — not just hex commit hashes", () => {
			expect(transcriptIdFromPath("transcripts/01234567-89ab-cdef-0123-456789abcdef.json")).toBe(
				"01234567-89ab-cdef-0123-456789abcdef",
			);
		});

		it("returns null for a path outside transcripts/ or without a .json extension", () => {
			expect(transcriptIdFromPath("summaries/abc.json")).toBeNull();
			expect(transcriptIdFromPath("transcripts/stray.txt")).toBeNull();
			expect(transcriptIdFromPath("transcripts/.json")).toBeNull();
		});
	});
});
