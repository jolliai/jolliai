import { afterEach, describe, expect, it, vi } from "vitest";
import { hasLlmCredentials } from "./LlmCredentials.js";

describe("hasLlmCredentials", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns true when apiKey is set", () => {
		expect(hasLlmCredentials({ apiKey: "sk-ant-xxx" })).toBe(true);
	});

	it("returns true when jolliApiKey is set", () => {
		expect(hasLlmCredentials({ jolliApiKey: "jolli_xxx" })).toBe(true);
	});

	it("returns true when ANTHROPIC_API_KEY env is set", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env");
		expect(hasLlmCredentials({})).toBe(true);
	});

	it("returns true when aiProvider is local-agent (no key needed)", () => {
		expect(hasLlmCredentials({ aiProvider: "local-agent" })).toBe(true);
	});

	it("returns false when no credential is available", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		expect(hasLlmCredentials({})).toBe(false);
	});

	it("returns false for anthropic provider without any key", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		expect(hasLlmCredentials({ aiProvider: "anthropic" })).toBe(false);
	});

	// Provider-aware, not a blind OR — must match resolveLlmCredentialSource's
	// null-vs-non-null verdict so the SessionStart reminder / BackfillEngine gate
	// never disagree with the LLM-heavy paths.
	it("returns true for jolli provider with a Jolli Space key", () => {
		expect(hasLlmCredentials({ aiProvider: "jolli", jolliApiKey: "sk-jol-x" })).toBe(true);
	});

	it("returns false for jolli provider with only an Anthropic key (a stray key does not satisfy the proxy)", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		expect(hasLlmCredentials({ aiProvider: "jolli", apiKey: "sk-ant-x" })).toBe(false);
	});

	it("returns true for anthropic provider with a config apiKey", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		expect(hasLlmCredentials({ aiProvider: "anthropic", apiKey: "sk-ant-x" })).toBe(true);
	});

	it("returns false for anthropic provider with only a Jolli key", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		expect(hasLlmCredentials({ aiProvider: "anthropic", jolliApiKey: "sk-jol-x" })).toBe(false);
	});
});
