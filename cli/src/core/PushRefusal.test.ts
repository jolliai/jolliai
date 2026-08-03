import { describe, expect, it } from "vitest";
import { isRepoWideRefusal, REPO_WIDE_REFUSAL_NAMES } from "./PushRefusal.js";

/** Builds an error carrying only a `name` — the cross-surface contract this module matches on. */
function named(name: string, message = "boom"): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

describe("isRepoWideRefusal", () => {
	it("classifies every listed name as repo-wide", () => {
		for (const name of REPO_WIDE_REFUSAL_NAMES) {
			expect(isRepoWideRefusal(named(name))).toBe(true);
		}
	});

	it("carries both spellings of each cross-surface condition", () => {
		// The CLI and the two IDE clients name the same server response differently,
		// and errors cross the IDE bridge BY NAME — so listing one spelling would
		// silently demote the other to a per-item failure on the surface that raises it.
		expect(REPO_WIDE_REFUSAL_NAMES.has("ClientOutdatedError")).toBe(true); // CLI, 426
		expect(REPO_WIDE_REFUSAL_NAMES.has("PluginOutdatedError")).toBe(true); // VS Code + IntelliJ, 426
		expect(REPO_WIDE_REFUSAL_NAMES.has("NotAuthenticatedError")).toBe(true); // CLI, 401
		expect(REPO_WIDE_REFUSAL_NAMES.has("UnauthorizedError")).toBe(true); // IntelliJ, 401
	});

	it("treats a rejected credential as repo-wide, not as one failed attachment", () => {
		// A 401 is a property of the repo + credential: every remaining document in
		// the loop gets the identical rejection. Collecting it reported one sign-in
		// problem as N `plan "X" failed` lines and fired N doomed requests. IntelliJ's
		// `repoWideStopReason` already classified it this way; this is the entry that
		// brings the other three classifiers into line with it.
		expect(isRepoWideRefusal(named("NotAuthenticatedError"))).toBe(true);
		expect(isRepoWideRefusal(named("UnauthorizedError"))).toBe(true);
	});

	it("leaves BindingRequiredError out — it is recoverable, not a refusal", () => {
		// Each loop that cannot run the binding chooser adds it explicitly; folding it
		// in here would make it fatal for the callers that CAN recover from it.
		expect(isRepoWideRefusal(named("BindingRequiredError"))).toBe(false);
	});

	it("leaves ordinary failures on the collect path", () => {
		expect(isRepoWideRefusal(named("Error", "HTTP 500"))).toBe(false);
		expect(isRepoWideRefusal(named("TypeError"))).toBe(false);
	});

	it("returns false for non-Error values", () => {
		expect(isRepoWideRefusal("PermissionDeniedError")).toBe(false);
		expect(isRepoWideRefusal({ name: "PermissionDeniedError" })).toBe(false);
		expect(isRepoWideRefusal(undefined)).toBe(false);
		expect(isRepoWideRefusal(null)).toBe(false);
	});
});
