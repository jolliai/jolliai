/**
 * Covers every branch of `resolveUriScheme()`. The mapping was previously
 * private to AuthService and tested only transitively via
 * `AuthService.test.ts`'s callback-URI assertions; pulling it into its own
 * module deserves a focused test that locks the appName→scheme contract.
 */

import { describe, expect, it, vi } from "vitest";

const appNameState = { current: "Visual Studio Code" };

vi.mock("vscode", () => ({
	env: {
		// Getter so test cases can mutate `appNameState.current` between calls
		// (the factory itself only executes once).
		get appName() {
			return appNameState.current;
		},
	},
}));

import { EXTENSION_ID, resolveUriScheme } from "./UriSchemeResolver.js";

describe("UriSchemeResolver", () => {
	it.each([
		["Visual Studio Code", "vscode"],
		["Visual Studio Code - Insiders", "vscode-insiders"],
		["Cursor", "cursor"],
		["Windsurf", "windsurf"],
		["VSCodium", "vscodium"],
		["Kiro", "kiro"],
		["Antigravity", "antigravity"],
	])("%s -> %s", (appName, expectedScheme) => {
		appNameState.current = appName;
		expect(resolveUriScheme()).toBe(expectedScheme);
	});

	it("falls back to vscode for an unknown fork", () => {
		// Safety net for forks the resolver doesn't know about yet — they
		// silently use vscode://, matching what AuthService does for the OAuth
		// callback so behavior is consistent.
		appNameState.current = "Some Brand New Fork";
		expect(resolveUriScheme()).toBe("vscode");
	});

	it("matches case-insensitively", () => {
		// `appName.toLowerCase()` is applied before pattern matching, so an
		// uppercased "CURSOR" still resolves correctly.
		appNameState.current = "CURSOR";
		expect(resolveUriScheme()).toBe("cursor");
	});

	it("prefers vscode-insiders over vscode for the Insiders build", () => {
		// VSCode Insiders' appName is "Visual Studio Code - Insiders" — both
		// "visual studio code" and "insiders" match. The "insiders" branch
		// runs last in the resolver so it wins, which is the intent.
		appNameState.current = "Visual Studio Code - Insiders";
		expect(resolveUriScheme()).toBe("vscode-insiders");
	});

	it("exports stable EXTENSION_ID constant", () => {
		// Part of the public contract: the URL handler in Extension.ts validates
		// against EXTENSION_ID. Locking the literal prevents accidental drift.
		expect(EXTENSION_ID).toBe("jolli.jollimemory-vscode");
	});
});
