import { describe, expect, it } from "vitest";
import { statsEventId } from "./DashboardModel.js";

describe("statsEventId", () => {
	it("scopes every id by repo identity — the same session in two repos is two rows", () => {
		const base = { type: "session.upserted" as const, source: "claude" as const, sessionId: "s1", updatedAtMs: 1 };
		expect(statsEventId({ ...base, repoIdentity: "a" })).not.toBe(statsEventId({ ...base, repoIdentity: "b" }));
	});

	it("is deterministic per fact — bootstrap and a live hook collide on one row", () => {
		expect(statsEventId({ type: "commit.created", repoIdentity: "r", hash: "abc", committedAtMs: 1 })).toBe(
			statsEventId({ type: "commit.created", repoIdentity: "r", hash: "abc", committedAtMs: 999, message: "x" }),
		);
	});

	it("uses the '' sentinel for a detached-HEAD worktree", () => {
		expect(
			statsEventId({
				type: "worktree.status",
				repoIdentity: "r",
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
				observedAtMs: 1,
			}),
		).toBe("worktree:r:");
	});

	it("keeps commit.summary provenance distinct from commit.created for the same hash", () => {
		expect(statsEventId({ type: "commit.summary", repoIdentity: "r", hash: "abc", committedAtMs: 1 })).toBe(
			"commit-summary:r:abc",
		);
		expect(statsEventId({ type: "commit.summary", repoIdentity: "r", hash: "abc", committedAtMs: 1 })).not.toBe(
			statsEventId({ type: "commit.created", repoIdentity: "r", hash: "abc", committedAtMs: 1 }),
		);
	});

	it("maps enable and disable of the same repo to the same projection key", () => {
		expect(
			statsEventId({
				type: "repo.enabled",
				repoIdentity: "r",
				repoName: "n",
				worktreeRoot: "/w",
				enabledAt: "t",
			}),
		).toBe(statsEventId({ type: "repo.disabled", repoIdentity: "r", disabledAt: "t" }));
	});
});
