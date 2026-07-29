import { describe, expect, it } from "vitest";
// Importing this module MUST be sufficient to populate the registry — no
// LlmClient import anywhere in this file. That is the whole point of the test.
import "./BuiltinBackends.js";
import { getBackend } from "./BackendRegistry.js";

describe("BuiltinBackends", () => {
	it.each(["claude-code", "codex", "cursor-agent", "opencode"])("registers %s without importing LlmClient", (id) => {
		expect(getBackend(id).id).toBe(id);
	});
});
