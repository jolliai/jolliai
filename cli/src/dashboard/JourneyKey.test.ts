/**
 * The junk values below are REAL — read out of the live 150 MB dashboard
 * database, not invented. A parser and a fixture that both came from
 * imagination form a self-consistent loop that is entirely wrong.
 */

import { describe, expect, it } from "vitest";
import { assignJourneyKeys, commitMapKey, deriveTicketId, isTicketId, resolveTicket } from "./JourneyKey.js";

describe("isTicketId", () => {
	it("accepts a bare tracker key", () => {
		expect(isTicketId("JOLLI-2123")).toBe(true);
		expect(isTicketId("AB1-7")).toBe(true);
	});

	it.each([
		["JOLLI-1032\nJOLLI-548", "two tickets, newline-joined"],
		["JOLLI-934, JOLLI-959", "two tickets, comma-joined"],
		["2026-07-02-memory-detail-panel-mockup-alignment", "a plan slug"],
		["#117", "a PR number"],
		["feature/active-conversations", "a branch name"],
		["dbda476102e184b3785b1c96a141579991449493", "a full commit SHA"],
		["PR #227", "a PR label"],
		["JOLLIMEMORY-CI", "no number, so not a tracker key"],
		["", "empty"],
	])("rejects %j (%s)", (value) => {
		expect(isTicketId(value)).toBe(false);
	});

	it("rejects null and undefined", () => {
		expect(isTicketId(null)).toBe(false);
		expect(isTicketId(undefined)).toBe(false);
	});
});

describe("deriveTicketId", () => {
	it("finds a key inside a commit message", () => {
		expect(deriveTicketId("Closes JOLLI-2123: add the journey model")).toBe("JOLLI-2123");
	});

	it("returns the FIRST key when a message names several", () => {
		expect(deriveTicketId("Part of JOLLI-934, JOLLI-959")).toBe("JOLLI-934");
	});

	it("returns undefined with no key and on empty input", () => {
		expect(deriveTicketId("refactor the folder sweep")).toBeUndefined();
		expect(deriveTicketId(null)).toBeUndefined();
	});
});

describe("resolveTicket", () => {
	it("prefers a ticketId that passes the shape gate", () => {
		expect(resolveTicket({ ticketId: "JOLLI-1", commitMessage: "Closes JOLLI-2" })).toBe("JOLLI-1");
	});

	it("falls back to the message when ticketId is a multi-ticket string", () => {
		// The gate is load-bearing: ungated, this becomes a journey NAMED
		// "JOLLI-934, JOLLI-959" that steals commits from two real ones.
		expect(
			resolveTicket({
				ticketId: "JOLLI-934, JOLLI-959",
				commitMessage: "Part of JOLLI-934",
			}),
		).toBe("JOLLI-934");
	});

	it("is null when neither path yields a key", () => {
		expect(resolveTicket({ ticketId: "#117", commitMessage: "tidy the sweep" })).toBeNull();
	});
});

describe("assignJourneyKeys", () => {
	const commit = (hash: string, over: Partial<Parameters<typeof assignJourneyKeys>[0][number]> = {}) => ({
		repoIdentity: "repo-a",
		commitHash: hash,
		ticketId: null,
		commitMessage: null,
		branch: "feature/x",
		...over,
	});

	it("groups by ticket across branches", () => {
		const keys = assignJourneyKeys([
			commit("h1", { ticketId: "JOLLI-9", branch: "feature/a" }),
			commit("h2", { ticketId: "JOLLI-9", branch: "feature/b" }),
		]);
		const first = keys.get(commitMapKey("repo-a", "h1"));
		expect(first?.groupedBy).toBe("ticket");
		expect(first?.ticket).toBe("JOLLI-9");
		expect(keys.get(commitMapKey("repo-a", "h2"))?.key).toBe(first?.key);
	});

	it("falls back to the branch when it holds two or more unticketed commits", () => {
		const keys = assignJourneyKeys([commit("h1"), commit("h2")]);
		const first = keys.get(commitMapKey("repo-a", "h1"));
		expect(first?.groupedBy).toBe("branch");
		expect(first?.branch).toBe("feature/x");
		expect(keys.get(commitMapKey("repo-a", "h2"))?.key).toBe(first?.key);
	});

	it("leaves a lone unticketed commit as its own journey", () => {
		const keys = assignJourneyKeys([commit("h1")]);
		expect(keys.get(commitMapKey("repo-a", "h1"))?.groupedBy).toBe("commit");
	});

	it("counts the branch fallback per repo, never across repos", () => {
		// One commit each on a same-named branch in two repos is two lone
		// commits, not a two-commit branch journey.
		const keys = assignJourneyKeys([commit("h1"), commit("h2", { repoIdentity: "repo-b" })]);
		expect(keys.get(commitMapKey("repo-a", "h1"))?.groupedBy).toBe("commit");
		expect(keys.get(commitMapKey("repo-b", "h2"))?.groupedBy).toBe("commit");
	});

	it("does not let ticketed commits raise a branch over the fallback threshold", () => {
		// Only UNTICKETED commits count toward the branch: the ticketed one has
		// already left for its own journey.
		const keys = assignJourneyKeys([commit("h1", { ticketId: "JOLLI-9" }), commit("h2")]);
		expect(keys.get(commitMapKey("repo-a", "h2"))?.groupedBy).toBe("commit");
	});

	it("leaves a branchless unticketed commit as its own journey", () => {
		const keys = assignJourneyKeys([commit("h1", { branch: null }), commit("h2", { branch: null })]);
		expect(keys.get(commitMapKey("repo-a", "h1"))?.groupedBy).toBe("commit");
	});

	it("gives each grouping kind a distinct key namespace", () => {
		// A ticket literally named like a branch must not collide with it.
		const keys = assignJourneyKeys([
			commit("h1", { ticketId: "JOLLI-9" }),
			commit("h2", { branch: "JOLLI-9" }),
			commit("h3", { branch: "JOLLI-9" }),
		]);
		expect(keys.get(commitMapKey("repo-a", "h1"))?.key).not.toBe(keys.get(commitMapKey("repo-a", "h2"))?.key);
	});

	it("never mines branch names into ticket keys, even when they look like tracker patterns", () => {
		// Real branch names from this repo that happen to match the digit pattern:
		// UPDATE-0, DOC-0, RELEASE-0, PR-130. These must never become journeys
		// grouped by ticket, and their ticket field must stay null. The reason
		// extractTicketFallback mines them (correct for display title fallback,
		// wrong for grouping) is that case-insensitive mining recovers 33 commits
		// into 5 keys, of which only JOLLI-1146 is real — the other four are
		// invented journeys that steal commits from correct groups.
		const keys = assignJourneyKeys([
			commit("h1", { branch: "UPDATE-0" }),
			commit("h2", { branch: "PR-130" }),
			commit("h3", { branch: "DOC-0" }),
		]);
		expect(keys.get(commitMapKey("repo-a", "h1"))?.groupedBy).toBe("commit");
		expect(keys.get(commitMapKey("repo-a", "h1"))?.ticket).toBeNull();
		expect(keys.get(commitMapKey("repo-a", "h2"))?.groupedBy).toBe("commit");
		expect(keys.get(commitMapKey("repo-a", "h2"))?.ticket).toBeNull();
		expect(keys.get(commitMapKey("repo-a", "h3"))?.groupedBy).toBe("commit");
		expect(keys.get(commitMapKey("repo-a", "h3"))?.ticket).toBeNull();
	});
});
