import { describe, expect, it } from "vitest";
import { isLocalAgentChild, LOCAL_AGENT_CHILD_ENV } from "./AgentReentry.js";

describe("AgentReentry", () => {
	it("is false when the sentinel is absent", () => {
		expect(isLocalAgentChild({})).toBe(false);
	});

	it("is true only for the exact '1' value the backend sets", () => {
		expect(isLocalAgentChild({ [LOCAL_AGENT_CHILD_ENV]: "1" })).toBe(true);
		// Guard against accidental truthiness of other values.
		expect(isLocalAgentChild({ [LOCAL_AGENT_CHILD_ENV]: "0" })).toBe(false);
		expect(isLocalAgentChild({ [LOCAL_AGENT_CHILD_ENV]: "true" })).toBe(false);
	});
});
