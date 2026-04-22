import { describe, expect, it } from "vitest";
import type {
	JolliMemoryConfig,
	StatusInfo,
} from "../../../../cli/src/Types.js";
import { StatusDataService } from "./StatusDataService.js";

function makeStatus(overrides: Partial<StatusInfo> = {}): StatusInfo {
	return {
		enabled: true,
		activeSessions: 0,
		mostRecentSession: null,
		summaryCount: 0,
		orphanBranch: "jollimemory",
		claudeDetected: false,
		codexDetected: false,
		geminiDetected: false,
		claudeHookInstalled: false,
		geminiHookInstalled: false,
		gitHookInstalled: false,
		...overrides,
	} as StatusInfo;
}

describe("StatusDataService.derive", () => {
	it("returns safe defaults when status is null", () => {
		const derived = StatusDataService.derive(null, null);
		expect(derived).toEqual({
			hasApiKey: false,
			signedIn: false,
			allHooksInstalled: false,
			hooksDescription: "none installed",
		});
	});

	it("builds hooksDescription for each installed hook", () => {
		const status = makeStatus({
			gitHookInstalled: true,
			claudeHookInstalled: true,
			geminiHookInstalled: true,
		});
		const derived = StatusDataService.derive(status, null);
		expect(derived.hooksDescription).toBe("3 Git + 2 Claude + 1 Gemini CLI");
		expect(derived.allHooksInstalled).toBe(true);
	});

	it("reports only some hooks when partial", () => {
		const status = makeStatus({ gitHookInstalled: true });
		const derived = StatusDataService.derive(status, null);
		expect(derived.hooksDescription).toBe("3 Git");
		expect(derived.allHooksInstalled).toBe(true);
	});

	it("falls back to 'none installed' when no hooks set", () => {
		const status = makeStatus();
		const derived = StatusDataService.derive(status, null);
		expect(derived.hooksDescription).toBe("none installed");
		expect(derived.allHooksInstalled).toBe(false);
	});

	it("reflects apiKey and authToken from config", () => {
		const config = {
			apiKey: "ak",
			authToken: "tok",
		} as JolliMemoryConfig;
		const derived = StatusDataService.derive(null, config);
		expect(derived.hasApiKey).toBe(true);
		expect(derived.signedIn).toBe(true);
	});

	it("treats missing apiKey/authToken as false", () => {
		const config = {} as JolliMemoryConfig;
		const derived = StatusDataService.derive(null, config);
		expect(derived.hasApiKey).toBe(false);
		expect(derived.signedIn).toBe(false);
	});
});
