import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withIsolatedHome } from "../testUtils/isolatedHome.js";
import {
	type ClaudeOwnedSession,
	type ClaudeOwnerEdge,
	capLedgerSessions,
	claudeOwnersPath,
	claudeSessionsOwnedBy,
	loadClaudeOwners,
	recordClaudeOwners,
} from "./ClaudeOwnership.js";

let dir: string;

function edge(over: Partial<ClaudeOwnerEdge> = {}): ClaudeOwnerEdge {
	return {
		firstSeenAt: "2026-08-17T10:00:00.000Z",
		firstSeenLine: 12,
		lastSeenAt: "2026-08-17T10:05:00.000Z",
		...over,
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-owners-"));
});

describe("ClaudeOwnership", () => {
	it("returns an empty ledger when the file does not exist", async () => {
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("returns an empty ledger for unparseable JSON rather than throwing", async () => {
		await writeFile(join(dir, "claude-owners.json"), "{ not json", "utf-8");
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("records one session under two owner roots", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([
					["/repo/a", edge({ firstSeenLine: 0 })],
					["/repo/b", edge({ firstSeenLine: 412 })],
				]),
			},
			dir,
		);
		const ledger = await loadClaudeOwners(dir);
		expect(Object.keys(ledger.sessions)).toEqual(["claude:s1"]);
		expect(Object.keys(ledger.sessions["claude:s1"].owners).sort()).toEqual(["/repo/a", "/repo/b"]);
	});

	it("extends an existing edge without resetting its first-seen position", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/a", edge({ firstSeenLine: 12 })]]),
			},
			dir,
		);
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([
					[
						"/repo/a",
						edge({
							firstSeenAt: "2026-08-17T11:00:00.000Z",
							firstSeenLine: 900,
							lastSeenAt: "2026-08-17T11:00:00.000Z",
							lastSeenCwd: "/repo/a/sub",
						}),
					],
				]),
			},
			dir,
		);
		const owners = (await loadClaudeOwners(dir)).sessions["claude:s1"].owners;
		expect(owners["/repo/a"].firstSeenLine).toBe(12);
		expect(owners["/repo/a"].firstSeenAt).toBe("2026-08-17T10:00:00.000Z");
		expect(owners["/repo/a"].lastSeenAt).toBe("2026-08-17T11:00:00.000Z");
		expect(owners["/repo/a"].lastSeenCwd).toBe("/repo/a/sub");
	});

	it("adds a new owner to a session that already has one", async () => {
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/b", edge({ firstSeenLine: 77 })]]),
			},
			dir,
		);
		const owners = (await loadClaudeOwners(dir)).sessions["claude:s1"].owners;
		expect(Object.keys(owners).sort()).toEqual(["/repo/a", "/repo/b"]);
		expect(owners["/repo/b"].firstSeenLine).toBe(77);
	});

	it("queries sessions by owner root and ignores other owners' sessions", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/a", edge({ firstSeenLine: 5 })]]),
			},
			dir,
		);
		await recordClaudeOwners(
			{ sessionId: "s2", transcriptPath: "/t/s2.jsonl", edges: new Map([["/repo/b", edge()]]) },
			dir,
		);
		const mine = await claudeSessionsOwnedBy("/repo/a", dir);
		expect(mine).toEqual([
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edge: expect.objectContaining({ firstSeenLine: 5 }) },
		]);
	});

	it("writes valid JSON that a second load round-trips", async () => {
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);
		const raw = await readFile(join(dir, "claude-owners.json"), "utf-8");
		expect(JSON.parse(raw)).toEqual(await loadClaudeOwners(dir));
	});

	it("records nothing when the edge map is empty", async () => {
		await recordClaudeOwners({ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map() }, dir);
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("reports a durable write when the lock is free, and a durable no-op for an empty edge map", async () => {
		expect(
			await recordClaudeOwners(
				{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge()]]) },
				dir,
			),
		).toBe(true);
		expect(
			await recordClaudeOwners({ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map() }, dir),
		).toBe(true);
	});

	it.each([
		["a bare JSON null", "null"],
		["a JSON array", "[]"],
		["a JSON number", "42"],
		["an object with no sessions field", "{}"],
		["an object whose sessions field is null", '{"sessions":null}'],
		["an object whose sessions field is not an object", '{"sessions":"oops"}'],
	])("returns an empty ledger for %s rather than throwing", async (_label, content) => {
		await writeFile(join(dir, "claude-owners.json"), content, "utf-8");
		expect(await loadClaudeOwners(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("does not move lastSeenAt backward when a later scan reports an older timestamp", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/a", edge({ lastSeenAt: "2026-08-17T12:00:00.000Z" })]]),
			},
			dir,
		);
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/a", edge({ lastSeenAt: "2026-08-17T09:00:00.000Z" })]]),
			},
			dir,
		);
		const owners = (await loadClaudeOwners(dir)).sessions["claude:s1"].owners;
		expect(owners["/repo/a"].lastSeenAt).toBe("2026-08-17T12:00:00.000Z");
	});

	it("keeps a prior lastSeenCwd when a later scan's edge carries none", async () => {
		await recordClaudeOwners(
			{
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/a", edge({ lastSeenCwd: "/repo/a/sub" })]]),
			},
			dir,
		);
		await recordClaudeOwners(
			{ sessionId: "s1", transcriptPath: "/t/s1.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);
		const owners = (await loadClaudeOwners(dir)).sessions["claude:s1"].owners;
		expect(owners["/repo/a"].lastSeenCwd).toBe("/repo/a/sub");
	});

	it("drops a session with malformed owners but keeps a well-formed sibling intact", async () => {
		const malformed = JSON.stringify({
			version: 1,
			sessions: {
				"claude:null-owners": {
					sessionId: "null-owners",
					transcriptPath: "/t/null-owners.jsonl",
					source: "claude",
					owners: null,
				},
				"claude:string-owners": {
					sessionId: "string-owners",
					transcriptPath: "/t/string-owners.jsonl",
					source: "claude",
					owners: "oops",
				},
				"claude:array-owners": {
					sessionId: "array-owners",
					transcriptPath: "/t/array-owners.jsonl",
					source: "claude",
					owners: [],
				},
				"claude:missing-owners": {
					sessionId: "missing-owners",
					transcriptPath: "/t/missing-owners.jsonl",
					source: "claude",
				},
				"claude:null-session": null,
				"claude:array-session": [],
				"claude:good": {
					sessionId: "good",
					transcriptPath: "/t/good.jsonl",
					source: "claude",
					owners: { "/repo/a": edge({ firstSeenLine: 5 }) },
				},
			},
		});
		await writeFile(join(dir, "claude-owners.json"), malformed, "utf-8");
		const ledger = await loadClaudeOwners(dir);
		expect(Object.keys(ledger.sessions)).toEqual(["claude:good"]);
		expect(ledger.sessions["claude:good"].owners["/repo/a"]).toEqual(edge({ firstSeenLine: 5 }));
	});

	it("claudeSessionsOwnedBy does not throw against a ledger with malformed owners and returns only the valid owner", async () => {
		const malformed = JSON.stringify({
			version: 1,
			sessions: {
				"claude:null-owners": {
					sessionId: "null-owners",
					transcriptPath: "/t/null-owners.jsonl",
					source: "claude",
					owners: null,
				},
				"claude:missing-owners": {
					sessionId: "missing-owners",
					transcriptPath: "/t/missing-owners.jsonl",
					source: "claude",
				},
				"claude:good": {
					sessionId: "good",
					transcriptPath: "/t/good.jsonl",
					source: "claude",
					owners: { "/repo/a": edge({ firstSeenLine: 5 }) },
				},
			},
		});
		await writeFile(join(dir, "claude-owners.json"), malformed, "utf-8");
		const mine = await claudeSessionsOwnedBy("/repo/a", dir);
		expect(mine).toEqual([
			{ sessionId: "good", transcriptPath: "/t/good.jsonl", edge: expect.objectContaining({ firstSeenLine: 5 }) },
		]);
	});

	it("quarantines a present-but-corrupt ledger instead of overwriting every other session with the new one", async () => {
		const path = join(dir, "claude-owners.json");
		// A prior ledger held two sessions, then the file was corrupted (torn write).
		await writeFile(path, '{ "sessions": { "claude:old-1": {}, "claude:old-2": ', "utf-8");

		const durable = await recordClaudeOwners(
			{ sessionId: "new", transcriptPath: "/t/new.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);

		// Non-durable: the caller must NOT advance its cursor mark over a
		// recovered-from-corrupt write.
		expect(durable).toBe(false);
		// The corrupt bytes are preserved for recovery, not destroyed...
		const { readdir } = await import("node:fs/promises");
		const quarantined = (await readdir(dir)).filter((f) => f.startsWith("claude-owners.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(await readFile(join(dir, quarantined[0]), "utf-8")).toContain("claude:old-1");
		// ...and a fresh, valid ledger now holds the session being written.
		expect(Object.keys((await loadClaudeOwners(dir)).sessions)).toEqual(["claude:new"]);
	});

	it("quarantines a ledger with a per-session-corrupt entry instead of silently dropping it on the next write", async () => {
		const path = join(dir, "claude-owners.json");
		// The whole file parses and its top-level shape is sound, but ONE session
		// entry is malformed (its `owners` is null). The write path must treat this
		// exactly like a top-level corruption — quarantine the file, preserving the
		// torn entry for recovery — not silently filter it out and rewrite it away.
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				sessions: {
					"claude:good": {
						sessionId: "good",
						transcriptPath: "/t/good.jsonl",
						source: "claude",
						owners: { "/repo/a": edge() },
					},
					"claude:torn": {
						sessionId: "torn",
						transcriptPath: "/t/torn.jsonl",
						source: "claude",
						owners: null,
					},
				},
			}),
			"utf-8",
		);

		const durable = await recordClaudeOwners(
			{ sessionId: "new", transcriptPath: "/t/new.jsonl", edges: new Map([["/repo/b", edge()]]) },
			dir,
		);

		// Non-durable: a recovered-from-corrupt write started from an emptied base,
		// so the caller must not advance its cursor mark over it.
		expect(durable).toBe(false);
		// The torn entry (and its well-formed sibling) are preserved for recovery,
		// not silently deleted...
		const { readdir } = await import("node:fs/promises");
		const quarantined = (await readdir(dir)).filter((f) => f.startsWith("claude-owners.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		const preserved = await readFile(join(dir, quarantined[0]), "utf-8");
		expect(preserved).toContain("claude:torn");
		expect(preserved).toContain("claude:good");
		// ...and a fresh, valid ledger now holds only the session being written.
		expect(Object.keys((await loadClaudeOwners(dir)).sessions)).toEqual(["claude:new"]);
	});

	it("defers the write (never quarantines or overwrites) when the ledger cannot be READ at all", async () => {
		// A non-ENOENT read failure (here EISDIR from a directory in the file's place;
		// in production EACCES / EMFILE / EIO) read NO bytes, so it is no evidence the
		// content is corrupt. Overwriting or quarantining it would destroy every other
		// session's edges over a momentary I/O error, so the write must be deferred.
		const { mkdir, readdir } = await import("node:fs/promises");
		const path = join(dir, "claude-owners.json");
		await mkdir(path); // readFile → EISDIR

		const durable = await recordClaudeOwners(
			{ sessionId: "new", transcriptPath: "/t/new.jsonl", edges: new Map([["/repo/a", edge()]]) },
			dir,
		);

		// Non-durable: the caller keeps its cursor mark put and re-emits next pass.
		expect(durable).toBe(false);
		// The file is left ENTIRELY alone — not quarantined, and not overwritten with
		// a fresh ledger holding only the new session.
		expect((await readdir(dir)).filter((f) => f.startsWith("claude-owners.json.corrupt-"))).toHaveLength(0);
		expect((await stat(path)).isDirectory()).toBe(true);
		expect(Object.keys((await loadClaudeOwners(dir)).sessions)).toEqual([]);
	});

	it("resolves against the machine-global config dir when globalDir is omitted", async () => {
		await withIsolatedHome(dir, async () => {
			await recordClaudeOwners({
				sessionId: "s1",
				transcriptPath: "/t/s1.jsonl",
				edges: new Map([["/repo/a", edge()]]),
			});
			const ledger = await loadClaudeOwners();
			expect(Object.keys(ledger.sessions)).toEqual(["claude:s1"]);
			expect(claudeOwnersPath()).toBe(join(dir, ".jolli", "jollimemory", "claude-owners.json"));
		});
	});
});

describe("capLedgerSessions", () => {
	function session(id: string, lastSeenAt: string): ClaudeOwnedSession {
		return {
			sessionId: id,
			transcriptPath: `/t/${id}.jsonl`,
			source: "claude",
			owners: { "/repo/a": edge({ lastSeenAt }) },
		};
	}

	it("returns the sessions unchanged (as a copy) when under the cap", () => {
		const sessions = {
			"claude:a": session("a", "2026-08-17T10:00:00.000Z"),
			"claude:b": session("b", "2026-08-17T11:00:00.000Z"),
		};
		const out = capLedgerSessions(sessions, "claude:b", 5);
		expect(Object.keys(out).sort()).toEqual(["claude:a", "claude:b"]);
		expect(out).not.toBe(sessions);
	});

	it("evicts the OLDEST sessions by lastSeenAt when over the cap", () => {
		const sessions = {
			"claude:old": session("old", "2026-08-17T08:00:00.000Z"),
			"claude:mid": session("mid", "2026-08-17T09:00:00.000Z"),
			"claude:new": session("new", "2026-08-17T10:00:00.000Z"),
		};
		// max 2, keeping "claude:mid" (the one just written this call).
		const out = capLedgerSessions(sessions, "claude:mid", 2);
		// Survivors: the kept one plus the single most-recent OTHER ("claude:new").
		expect(Object.keys(out).sort()).toEqual(["claude:mid", "claude:new"]);
	});

	it("always retains `keep` even when it is the oldest", () => {
		const sessions = {
			"claude:keep": session("keep", "2026-08-17T08:00:00.000Z"),
			"claude:a": session("a", "2026-08-17T09:00:00.000Z"),
			"claude:b": session("b", "2026-08-17T10:00:00.000Z"),
		};
		const out = capLedgerSessions(sessions, "claude:keep", 1);
		// max 1 leaves room for `keep` only; every other session is evicted.
		expect(Object.keys(out)).toEqual(["claude:keep"]);
	});
});
