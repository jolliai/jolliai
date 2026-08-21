import { describe, expect, it } from "vitest";
import { claudeEnvelopeParser } from "./ClaudeEnvelopeParser.js";
import { codexEnvelopeParser } from "./CodexEnvelopeParser.js";
import { kimiEnvelopeParser } from "./KimiEnvelopeParser.js";
import { getEnvelopeParser } from "./TranscriptEnvelopeParser.js";

describe("getEnvelopeParser", () => {
	it("defaults to the claude parser when no source is given", () => {
		expect(getEnvelopeParser()).toBe(claudeEnvelopeParser);
	});

	it("resolves the claude parser for 'claude'", () => {
		expect(getEnvelopeParser("claude")).toBe(claudeEnvelopeParser);
	});

	it("resolves the codex parser for 'codex'", () => {
		expect(getEnvelopeParser("codex")).toBe(codexEnvelopeParser);
	});

	it("resolves the kimi parser for 'kimi'", () => {
		expect(getEnvelopeParser("kimi")).toBe(kimiEnvelopeParser);
	});

	it("falls back to the claude parser for a source with no dedicated envelope parser", () => {
		// "gemini" is a real TranscriptSource with no per-source envelope
		// parser — the documented fallback for "unknown/other sources".
		expect(getEnvelopeParser("gemini")).toBe(claudeEnvelopeParser);
	});
});
