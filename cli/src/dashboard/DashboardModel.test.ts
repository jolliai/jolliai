import { describe, expect, it } from "vitest";
import { statsEventId } from "./DashboardModel.js";
import { LOOKUP_QUERY_MAX } from "./LookupQuery.js";

/**
 * The server's cap on `receipt_id` (`JolliMemorySessionPushSchema`, backend repo).
 *
 * Restated here rather than imported because it lives in another repository, and
 * pinned because it is the reason the search id carries a fingerprint instead of the
 * query's bucket key: the same row's `query` may be 20 000 characters on that wire,
 * so an id that interpolated it was a much lower ceiling hidden inside the one column
 * nothing clamps.
 */
const WIRE_RECEIPT_ID_MAX = 500;

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

describe("statsEventId — lookup receipts", () => {
	const search = (queryKey: string): string =>
		statsEventId({
			type: "lookup.observed",
			kind: "search",
			repoIdentity: "https://github.com/jolliai/jolliai",
			surface: "mcp",
			atMs: 1_700_000_000_000,
			query: queryKey,
			queryKey,
			resultCount: 3,
		});

	it("stays inside the wire cap even at the producer's own clamp", () => {
		// The regression this shape exists for. `receipt_id` is a PRIMARY KEY that
		// TRAVELS, and the server caps it at 500 while capping `query` at 20 000 — so
		// interpolating the bucket key made a ~430-character search a permanent 400 on
		// a channel that is all-or-nothing and neither silences a 400 nor steps past
		// it: one lookup wedged every table on that machine, for ever.
		const id = search("x".repeat(LOOKUP_QUERY_MAX));

		expect(id.length).toBeLessThan(WIRE_RECEIPT_ID_MAX);
	});

	it("never carries the reader's own words", () => {
		// A side effect worth asserting: `receipt_id` is an opaque NAME, so it matches
		// neither tier of `SessionPushManifest.test.ts`'s column net. Free text inside
		// it would have reached the wire with nothing reviewing it.
		expect(search("acme merger rollout")).not.toContain("acme");
	});

	it("separates two different queries in the same millisecond", () => {
		// The ordinary shape of this event: an agent firing several searches at once.
		// A shared id does not merge them — `projectLookupObserved` restates every
		// column — so the second would overwrite the first.
		expect(search("rate limiter")).not.toBe(search("rate limiter bursts"));
	});

	it("converges two spellings of one search", () => {
		// Derived from the bucket key, so the id groups exactly as the card does.
		expect(search("rate limiter")).toBe(search("rate limiter"));
	});

	it("leaves a recall keyed on the timestamp alone", () => {
		expect(
			statsEventId({
				type: "lookup.observed",
				kind: "recall",
				repoIdentity: "r",
				surface: "cli",
				atMs: 1000,
				hit: true,
				resultCount: 0,
			}),
		).toBe("lookup:r:recall:cli:1000");
	});
});
