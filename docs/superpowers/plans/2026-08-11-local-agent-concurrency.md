# Local Agent Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record 15-minute activity buckets per agent session so the local dashboard can answer "how many agents was I running at the same time?", data layer only.

**Architecture:** A new `session_activity` table stores one row per (session, 15-minute bucket) in which that session produced a message. `DashboardCollector` derives buckets from per-message timestamps it already reads; `StatsWriter` persists them with the same replace-when-observed contract `session_tool_use` uses; `DashboardQuery` aggregates them into an optional `StatsModel.concurrency` field. No UI.

**Tech Stack:** TypeScript (ESM), `node:sqlite` (STRICT tables), Vitest, Biome.

Spec: [`docs/superpowers/specs/2026-08-11-local-agent-concurrency-design.md`](../specs/2026-08-11-local-agent-concurrency-design.md)

## Global Constraints

- Every commit uses `git commit -s` (DCO). CI rejects PRs without `Signed-off-by:`.
- **No `Co-Authored-By: Claude …` trailer and no "🤖 Generated with …" footer** in commit messages or PR descriptions.
- `npm run all` must pass before the final commit (clean → build → typecheck → lint → test).
- CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines. Do not regress it.
- Biome: tabs, 4-wide indent, 120 column limit. `noExplicitAny: error`, `noUnusedImports/Variables: error`. CI runs `biome check --error-on-warnings` — warnings fail.
- `MIGRATIONS` in `DashboardDb.ts` is **append-only**. Never edit or reorder an existing entry; never drop a column.
- **The version number in this plan is not a constant — recompute it.** At writing time this branch declares `DASHBOARD_SCHEMA_VERSION = 5` with five migrations, so `session_activity` is entry 5 and version 6. But branch `pr460` has already appended `TOOL_CALL_TIME_ZERO_SWEEP_DDL` as its own entry 5 and shipped version 6 (verified: `~/.jolli/jollimemory/jollimemory.db` reports `schema_version = 6` today, written by that build). If `pr460` merges first, this becomes entry 6 / version 7. **Read the tail of `MIGRATIONS` on your actual branch point, append after whatever is last, and set `DASHBOARD_SCHEMA_VERSION` to the new array length.**
- **A dev machine whose shared DB is already at the version you are claiming will silently skip your migration.** The dashboard DB is machine-global (`~/.jolli/jollimemory/jollimemory.db`), shared by every worktree. If it already reads 6 because `pr460` migrated it, a build of this branch that also declares 6 makes `migrateDashboardDb` see `6 >= 6` and run nothing — `session_activity` is never created, and every query against it fails with `no such table`, which reads like a code bug rather than a version collision. Diagnose with the snippet in Task 6 Step 3; recover by pointing tests at a temp `dbPath` (which every test in this plan already does) and, for manual verification, by using a throwaway `dbPath` rather than the shared file.
- Inner loop is `npm run test:fast`; the dashboard tests are in that tier. Run a single file with
  `npm run test -w @jolli.ai/cli -- src/dashboard/<File>.test.ts -t "<case>"`.

---

### Task 1: Schema — the `session_activity` table

**Files:**
- Modify: `cli/src/dashboard/SotSchema.ts` (add `SESSION_ACTIVITY_DDL` after `TOOL_CALL_TIME_DDL`, which ends at line 487)
- Modify: `cli/src/dashboard/DashboardDb.ts:69` (version) and `cli/src/dashboard/DashboardDb.ts:217-240` (`MIGRATIONS`)
- Test: `cli/src/dashboard/DashboardDb.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SESSION_ACTIVITY_DDL: string` exported from `SotSchema.ts`; `DASHBOARD_SCHEMA_VERSION === 6`; table `session_activity(session_event_id TEXT, bucket_ms INTEGER)` with `PRIMARY KEY (session_event_id, bucket_ms)`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/dashboard/DashboardDb.test.ts`, inside the existing top-level `describe` that already exercises `withDashboardDb` with a temp `dbPath`:

```ts
	it("creates session_activity, keyed per (session, bucket) and rejecting a REAL bucket", async () => {
		const rows = await withDashboardDb(
			(db) =>
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_activity'")
					.all() as ReadonlyArray<{ name: string }>,
			{ dbPath },
		);
		expect(rows).toHaveLength(1);

		// STRICT is what turns a forgotten Math.floor into a loud failure instead
		// of a fractional bucket that silently defeats the primary key.
		await withDashboardDb((db) => {
			// `enabled_at` is NOT NULL with no default — omitting it fails the insert.
			db.prepare(
				"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
			).run("repo-1", "repo-1", "/tmp/repo-1", "2026-08-11T00:00:00.000Z");
			db.prepare(
				`INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms)
				 VALUES ('s-evt', 1, 'claude', 's1', 1786425300000)`,
			).run();
			db.prepare("INSERT INTO session_activity (session_event_id, bucket_ms) VALUES (?, ?)").run(
				"s-evt",
				1786425300000,
			);
			expect(() =>
				db.prepare("INSERT INTO session_activity (session_event_id, bucket_ms) VALUES (?, ?)").run(
					"s-evt",
					1786425300000.5,
				),
			).toThrow(/REAL/);
		}, { dbPath });
	});

	it("is at schema version 6", async () => {
		const version = await withDashboardDb((db) => readSchemaVersion(db), { dbPath });
		expect(version).toBe(6);
	});
```

Substitute the real number for `6` here and everywhere below in this task — see
the recompute rule in Global Constraints. It is the length of `MIGRATIONS`
after your append, on your actual branch point.

This literal assertion is new and worth adding: the file's existing check at
line 481 compares `readSchemaVersion(db)` against `DASHBOARD_SCHEMA_VERSION`,
which passes for any value and so cannot catch a migration appended without a
version bump.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/DashboardDb.test.ts -t "session_activity"`
Expected: FAIL — `expect(received).toHaveLength(1)` got `0` (no such table).

- [ ] **Step 3: Write the DDL constant**

In `cli/src/dashboard/SotSchema.ts`, after `TOOL_CALL_TIME_DDL`:

```ts
/**
 * One row per (session, 15-minute bucket) in which that session produced a
 * message — the input to the concurrency figure.
 *
 * `bucket_ms` holds an ABSOLUTE epoch-ms bucket start, not a localised day or
 * hour key: time zone is a render-time concern that `localDayKey` / `localHour`
 * already handle in the query layer, and a stored localised copy would be a
 * second answer to a question that already has one.
 *
 * Buckets rather than a stored `(start, end)` interval because a resumed
 * session is common and its span is not its presence — measured, the longest
 * session on the author's machine spans 18 hours across 28 messages. A bucket
 * list occupies only the quarter-hours the session actually spoke in, with no
 * gap-threshold parameter to tune.
 *
 * `INTEGER` under STRICT is load-bearing twice: `node:sqlite` returns these as
 * JS numbers (epoch ms sits ~5000x below `Number.MAX_SAFE_INTEGER`), and STRICT
 * REJECTS a REAL here, so a missing `Math.floor` upstream fails at insert
 * instead of storing a fractional bucket that defeats the primary key.
 */
export const SESSION_ACTIVITY_DDL = `
CREATE TABLE session_activity (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  bucket_ms        INTEGER NOT NULL,
  PRIMARY KEY (session_event_id, bucket_ms)
) STRICT;
CREATE INDEX ix_activity_bucket ON session_activity(bucket_ms);
`;
```

- [ ] **Step 4: Append the migration and bump the version**

In `cli/src/dashboard/DashboardDb.ts`, add `SESSION_ACTIVITY_DDL` to the existing import from `./SotSchema.js`, then append it as the **sixth** entry (index 5) of `MIGRATIONS`, after `TOOL_CALL_TIME_DDL`:

```ts
	TOOL_CALL_TIME_DDL,
	SESSION_ACTIVITY_DDL,
];
```

And at line 69:

```ts
export const DASHBOARD_SCHEMA_VERSION = 6;
```

Do not edit entries 0-4. Dev databases are already at 5, and editing an earlier entry reaches only databases created afterwards.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/DashboardDb.test.ts`
Expected: PASS, whole file.

- [ ] **Step 6: Commit**

```bash
git add cli/src/dashboard/SotSchema.ts cli/src/dashboard/DashboardDb.ts cli/src/dashboard/DashboardDb.test.ts
git commit -s -m "Add a session_activity table for per-session quarter-hour buckets"
```

---

### Task 2: `bucketsFrom` — the pure bucketing helper

**Files:**
- Create: `cli/src/dashboard/ActivityBuckets.ts`
- Test: `cli/src/dashboard/ActivityBuckets.test.ts`

**Interfaces:**
- Consumes: `TranscriptEntry` from `../Types.js` (`{ role, content, timestamp?: string }`).
- Produces:
  - `ACTIVITY_BUCKET_MS: number` (= 900_000)
  - `bucketsFrom(entries: ReadonlyArray<TranscriptEntry>): ReadonlyArray<number>` — deduped, ascending bucket starts. Returns `[]` when no entry carries a parseable timestamp.

- [ ] **Step 1: Write the failing test**

Create `cli/src/dashboard/ActivityBuckets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../Types.js";
import { ACTIVITY_BUCKET_MS, bucketsFrom } from "./ActivityBuckets.js";

const entry = (timestamp?: string): TranscriptEntry => ({ role: "human", content: "x", ...(timestamp ? { timestamp } : {}) });

describe("bucketsFrom", () => {
	it("floors each timestamp to its quarter-hour start", () => {
		// 2026-08-11T10:07:23Z falls in the 10:00 bucket.
		expect(bucketsFrom([entry("2026-08-11T10:07:23.000Z")])).toEqual([Date.parse("2026-08-11T10:00:00.000Z")]);
		// 10:44:59 falls in the 10:30 bucket, not 10:45.
		expect(bucketsFrom([entry("2026-08-11T10:44:59.000Z")])).toEqual([Date.parse("2026-08-11T10:30:00.000Z")]);
	});

	it("dedupes messages sharing a bucket and returns ascending order", () => {
		const out = bucketsFrom([
			entry("2026-08-11T10:50:00.000Z"),
			entry("2026-08-11T10:07:00.000Z"),
			entry("2026-08-11T10:12:00.000Z"),
		]);
		expect(out).toEqual([Date.parse("2026-08-11T10:00:00.000Z"), Date.parse("2026-08-11T10:45:00.000Z")]);
	});

	it("occupies only the buckets a resumed session spoke in, never the span between", () => {
		// The measured 18-hour session shape: two messages, a night apart.
		const out = bucketsFrom([entry("2026-08-10T22:00:00.000Z"), entry("2026-08-11T16:00:00.000Z")]);
		expect(out).toHaveLength(2);
	});

	it("skips entries with no timestamp, and unparseable ones, without dropping the rest", () => {
		expect(bucketsFrom([entry(), entry("not-a-date"), entry("2026-08-11T10:07:00.000Z")])).toEqual([
			Date.parse("2026-08-11T10:00:00.000Z"),
		]);
	});

	it("returns empty when nothing is timestamped — the caller turns that into an ABSENT field", () => {
		expect(bucketsFrom([entry(), entry()])).toEqual([]);
		expect(bucketsFrom([])).toEqual([]);
	});

	it("produces integral buckets, which the STRICT column requires", () => {
		for (const b of bucketsFrom([entry("2026-08-11T10:07:23.456Z")])) {
			expect(Number.isInteger(b)).toBe(true);
			expect(b % ACTIVITY_BUCKET_MS).toBe(0);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/ActivityBuckets.test.ts`
Expected: FAIL — cannot resolve `./ActivityBuckets.js`.

- [ ] **Step 3: Write the implementation**

Create `cli/src/dashboard/ActivityBuckets.ts`:

```ts
/**
 * Quarter-hour activity bucketing — the one place a transcript's per-message
 * timestamps become the rows behind the concurrency figure.
 *
 * Kept apart from the collector because it is pure and is the only piece of
 * this feature with arithmetic worth pinning on its own.
 */

import type { TranscriptEntry } from "../Types.js";

/** Bucket width. 15 minutes: coarse enough that a pause mid-thought does not
 *  fragment a session, fine enough that "the same bucket" still reads as "at
 *  the same time" to a person. */
export const ACTIVITY_BUCKET_MS = 15 * 60 * 1000;

/**
 * The quarter-hour bucket starts a slice of transcript touched, deduped and
 * ascending.
 *
 * An EMPTY result means no entry carried a parseable timestamp — the caller
 * must turn that into an ABSENT `activityBuckets` field, never `[]`, so that a
 * source whose reader emits no timestamps is reported as uncovered rather than
 * as "used no agents". Entries without a timestamp are skipped individually, so
 * one malformed line cannot cost the rest of the session its buckets.
 */
export function bucketsFrom(entries: ReadonlyArray<TranscriptEntry>): ReadonlyArray<number> {
	const seen = new Set<number>();
	for (const e of entries) {
		if (!e.timestamp) continue;
		const at = Date.parse(e.timestamp);
		if (!Number.isFinite(at)) continue;
		seen.add(Math.floor(at / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS);
	}
	return [...seen].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/ActivityBuckets.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/dashboard/ActivityBuckets.ts cli/src/dashboard/ActivityBuckets.test.ts
git commit -s -m "Add quarter-hour bucketing for transcript activity"
```

---

### Task 3: Event field and its projection

**Files:**
- Modify: `cli/src/dashboard/DashboardModel.ts:44-68` (`SessionUpsertedEvent`)
- Modify: `cli/src/dashboard/StatsWriter.ts:603-621` (append a block at the end of `projectSession`)
- Test: `cli/src/dashboard/StatsWriter.test.ts`

**Interfaces:**
- Consumes: the `session_activity` table from Task 1.
- Produces: `SessionUpsertedEvent.activityBuckets?: ReadonlyArray<number>`, persisted to `session_activity` keyed on the session's `event_id`.

**Do NOT touch `projectCommitSummary`.** It seeds session rows from `SessionLinkItem`, which carries only `messageCount` and per-model usage — no per-message timestamps exist on that path, so it can never produce buckets and must leave existing rows alone.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/dashboard/StatsWriter.test.ts` a new top-level `describe`, next to the existing `describe("session_tool_use projection", …)`:

```ts
describe("session_activity projection", () => {
	const readBuckets = (db: DashboardDbHandle) =>
		(
			db
				.prepare("SELECT bucket_ms FROM session_activity ORDER BY bucket_ms")
				.all() as ReadonlyArray<{ bucket_ms: number }>
		).map((r) => r.bucket_ms);

	it("stores one row per bucket and replaces them wholesale on re-read", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000, 1_700_000_900_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		await withDashboardDb((db) => {
			expect(readBuckets(db)).toEqual([1_700_000_000_000, 1_700_000_900_000]);
		}, { dbPath });

		// A later full read that saw fewer buckets must not leave the old ones behind.
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		await withDashboardDb((db) => {
			expect(readBuckets(db)).toEqual([1_700_000_000_000]);
		}, { dbPath });
	});

	it("leaves stored buckets alone when the field is ABSENT", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		// A producer that cannot see timestamps re-upserts the same session.
		await applyStatsEvents([envelope(session())], { producerKind: "cli", dbPath });
		await withDashboardDb((db) => {
			expect(readBuckets(db)).toEqual([1_700_000_000_000]);
		}, { dbPath });
	});

	it("clears stored buckets when an observed read genuinely found none", async () => {
		await applyStatsEvents([envelope(session({ activityBuckets: [1_700_000_000_000] }))], {
			producerKind: "cli",
			dbPath,
		});
		await applyStatsEvents([envelope(session({ activityBuckets: [] }))], { producerKind: "cli", dbPath });
		await withDashboardDb((db) => {
			expect(readBuckets(db)).toEqual([]);
		}, { dbPath });
	});
});
```

`DashboardDbHandle` and `withDashboardDb` are already imported at the top of this test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/StatsWriter.test.ts -t "session_activity projection"`
Expected: FAIL — TypeScript rejects `activityBuckets` as an unknown property of `SessionUpsertedEvent`.

- [ ] **Step 3: Add the event field**

In `cli/src/dashboard/DashboardModel.ts`, inside `SessionUpsertedEvent`, directly after the `tools` field:

```ts
	/**
	 * Quarter-hour buckets in which this session produced a message. REPLACES
	 * the stored set when present; `undefined` means "this producer could not
	 * see per-message timestamps" and leaves the rows alone — which is what
	 * keeps a re-upsert from a source without timestamps from erasing what a
	 * full read collected.
	 *
	 * Producers must send `undefined`, never `[]`, when nothing was timestamped:
	 * a source whose reader emits no timestamps computes an empty array on every
	 * read, and emitting it would assert "measured, no activity" about a source
	 * that was never measurable.
	 */
	readonly activityBuckets?: ReadonlyArray<number>;
```

- [ ] **Step 4: Add the projection**

In `cli/src/dashboard/StatsWriter.ts`, at the very end of `projectSession` (after the closing brace of the `if (event.tools !== undefined)` block, before the function's own closing brace):

```ts
	// Same replace-when-observed contract as the model split and the tool rows.
	// Safe as a wholesale replace because the collector reads the WHOLE
	// transcript, never a cursor-bounded slice — a slice-based producer would
	// need a merge here instead.
	if (event.activityBuckets !== undefined) {
		db.prepare("DELETE FROM session_activity WHERE session_event_id = ?").run(eventId);
		const insertBucket = db.prepare(
			"INSERT OR IGNORE INTO session_activity (session_event_id, bucket_ms) VALUES (?, ?)",
		);
		for (const bucket of event.activityBuckets) {
			insertBucket.run(eventId, bucket);
		}
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/StatsWriter.test.ts`
Expected: PASS, whole file.

- [ ] **Step 6: Commit**

```bash
git add cli/src/dashboard/DashboardModel.ts cli/src/dashboard/StatsWriter.ts cli/src/dashboard/StatsWriter.test.ts
git commit -s -m "Persist per-session activity buckets from session.upserted events"
```

---

### Task 4: Collect buckets from every source

**Files:**
- Modify: `cli/src/core/TranscriptMessageCounter.ts:122-158` (export the dispatcher)
- Modify: `cli/src/dashboard/DashboardCollector.ts:196-243` (`sessionEventFromInfo`)
- Test: `cli/src/dashboard/DashboardCollector.test.ts` (update the existing case at line 108, add new ones)

**Interfaces:**
- Consumes: `bucketsFrom` from Task 2; `SessionUpsertedEvent.activityBuckets` from Task 3.
- Produces: `readTranscriptForSource(source: TranscriptSource, transcriptPath: string, cursor: TranscriptCursor | null): Promise<TranscriptReadResult>` exported from `cli/src/core/TranscriptMessageCounter.ts`.

**Why this is not just deleting the early return.** `sessionEventFromInfo` calls `readTranscript(path)` with **no parser argument**, which defaults to `new ClaudeTranscriptParser()`. Letting a Codex transcript through that path yields zero entries — a silent empty result, not an error. The read must be dispatched per source.

- [ ] **Step 1: Export the dispatcher**

In `cli/src/core/TranscriptMessageCounter.ts`, rename the private `readUnreadTranscript` to `readTranscriptForSource`, export it, widen its cursor parameter, and update its two existing call sites in that file:

```ts
/**
 * Reads a transcript with the reader its source requires.
 *
 * Exported because the dashboard collector needs the same 13-way dispatch: the
 * bare `readTranscript` defaults to the CLAUDE parser, so calling it for a
 * Codex or OpenCode path returns zero entries rather than failing.
 *
 * Pass `null` for a full read from the start of the file.
 */
export async function readTranscriptForSource(
	source: TranscriptSource,
	transcriptPath: string,
	cursor: TranscriptCursor | null,
): Promise<TranscriptReadResult> {
	switch (source) {
		// …body unchanged…
	}
}
```

Keep the `switch` body exactly as it is, including the `cursor ?? undefined` spellings on the `copilot-chat` and `antigravity` branches and the `default` case that treats an unknown source as Claude.

- [ ] **Step 2: Update the test that pins the behaviour being changed**

`cli/src/dashboard/DashboardCollector.test.ts:108` currently reads:

> `it("does not read transcripts for non-Claude sources — no per-turn usage exists there", …)`

That assertion is now wrong by design. Replace it with:

```ts
	it("reads every source's transcript, but attributes tokens only where per-turn usage exists", async () => {
		vi.mocked(readTranscriptForSource).mockResolvedValue({
			entries: [
				{ role: "human", content: "hi", timestamp: "2026-08-11T10:07:00.000Z" },
				{ role: "assistant", content: "yo", timestamp: "2026-08-11T10:41:00.000Z" },
			],
			newCursor: { lineNumber: 2 },
			totalLinesRead: 2,
		} as TranscriptReadResult);

		const event = await sessionEventFromInfo("repo-1", {
			sessionId: "s1",
			source: "codex",
			transcriptPath: "/tmp/s1.jsonl",
			updatedAt: "2026-08-11T10:41:00.000Z",
		} as SessionInfo);

		expect(event?.messageCount).toBe(2);
		expect(event?.activityBuckets).toEqual([
			Date.parse("2026-08-11T10:00:00.000Z"),
			Date.parse("2026-08-11T10:30:00.000Z"),
		]);
		// Codex carries no per-turn usage, so nothing is attributed.
		expect(event?.tokenCoverage).toBeUndefined();
		expect(event?.models).toBeUndefined();
	});

	it("omits activityBuckets entirely when no entry is timestamped", async () => {
		vi.mocked(readTranscriptForSource).mockResolvedValue({
			entries: [{ role: "human", content: "hi" }],
			newCursor: { lineNumber: 1 },
			totalLinesRead: 1,
		} as TranscriptReadResult);

		const event = await sessionEventFromInfo("repo-1", {
			sessionId: "s2",
			source: "cursor",
			transcriptPath: "/tmp/s2.db#c1",
			updatedAt: "2026-08-11T10:41:00.000Z",
		} as SessionInfo);

		// ABSENT, not `[]` — "uncovered", not "used no agents".
		expect(event).not.toHaveProperty("activityBuckets");
	});
```

Add `readTranscriptForSource` to the file's mocks alongside the existing `readTranscript` mock, and import `sessionEventFromInfo` if the file does not already.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/DashboardCollector.test.ts -t "reads every source"`
Expected: FAIL — `event.messageCount` is `undefined` (the early return still fires for `codex`).

- [ ] **Step 4: Move the early return**

In `cli/src/dashboard/DashboardCollector.ts`, replace the `readTranscript` import with `readTranscriptForSource` from `../core/TranscriptMessageCounter.js`, add `bucketsFrom` from `./ActivityBuckets.js`, and rewrite the body of `sessionEventFromInfo` after `const base = {…}`:

```ts
	try {
		// Full read (null cursor): the wholesale replace in `projectSession`
		// depends on this being the whole session, not a slice.
		const read = await readUsage(source, s.transcriptPath, null);
		const buckets = bucketsFrom(read.entries);
		const models: StatsModelUsage[] = toStatsModelUsage(read.usageByModel ?? []);
		const first = read.entries[0]?.timestamp;
		const last = read.entries[read.entries.length - 1]?.timestamp;
		const startedAtMs = first ? Date.parse(first) : Number.NaN;
		const endedAtMs = last ? Date.parse(last) : Number.NaN;
		return {
			...base,
			messageCount: read.entries.length,
			...(Number.isFinite(startedAtMs) ? { startedAtMs } : {}),
			...(Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs > startedAtMs
				? { durationMs: endedAtMs - startedAtMs }
				: {}),
			// ABSENT, never `[]`: a source whose reader emits no timestamps
			// computes an empty array on every read, and emitting it would
			// assert "measured, no activity" about a source never measurable.
			...(buckets.length > 0 ? { activityBuckets: buckets } : {}),
			...(models.length > 0
				? { models, tokenCoverage: "full" as const, pricesAsOf: PRICES_AS_OF }
				: {}),
			// Forwarded only when the reader actually produced it. An empty array
			// means "called no tools" and is worth storing; absence means "this
			// source records none", and the two must not collapse.
			...(read.toolUse ? { tools: read.toolUse } : {}),
		};
	} catch (err) {
		// A moved or deleted transcript still counts as a session — record it
		// with what the discoverer knew rather than dropping the row.
		log.warn("transcript unreadable for %s/%s: %s", source, s.sessionId, errMsg(err));
		return base;
	}
```

Change the injectable third parameter's default accordingly:

```ts
export async function sessionEventFromInfo(
	repoIdentity: string,
	s: SessionInfo,
	readUsage: typeof readTranscriptForSource = readTranscriptForSource,
): Promise<SessionUpsertedEvent | null> {
```

Two things that changed and must stay changed: the `if (source !== "claude") return base;` line is **gone**, and `tokenCoverage: "sessions-only"` is no longer emitted for a model-less read — the field is simply absent, which is what the "omit rather than assert" rule requires and what the test in Step 2 asserts. Verify no other test in the repo depends on the old `"sessions-only"` default from this function; `projectSession` already falls back to `"sessions-only"` when the field is absent.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/DashboardCollector.test.ts`
Expected: PASS, whole file. Then run the neighbours that share these modules:
`npm run test -w @jolli.ai/cli -- src/core/TranscriptMessageCounter.test.ts src/core/ActiveSessionAggregator.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/TranscriptMessageCounter.ts cli/src/dashboard/DashboardCollector.ts cli/src/dashboard/DashboardCollector.test.ts
git commit -s -m "Collect activity buckets from every agent source, not only Claude"
```

---

### Task 5: The concurrency query

**Files:**
- Modify: `cli/src/dashboard/DashboardModel.ts` (add `ConcurrencyModel`, add `StatsModel.concurrency?`)
- Modify: `cli/src/dashboard/DashboardQuery.ts` (add `buildConcurrency`, wire into the `StatsModel` return at line 969-989)
- Test: `cli/src/dashboard/DashboardQuery.test.ts`

**Interfaces:**
- Consumes: the `session_activity` rows written in Task 3.
- Produces: `StatsModel.concurrency?: ConcurrencyModel`.

- [ ] **Step 1: Write the failing test**

Add this inside the existing `describe("buildDashboardModel", …)` block of
`cli/src/dashboard/DashboardQuery.test.ts`, so it inherits that block's
`dir`/`dbPath` lifecycle, its `nowMs` (`Date.parse("2026-07-30T12:00:00Z")`) and
its `session(over)` envelope helper. Seeding goes through `applyStatsEvents`
with real events — that is this file's convention, and it exercises Task 3's
projection end to end rather than reaching into SQL:

```ts
	describe("concurrency", () => {
		// Two adjacent quarter-hours inside the default window.
		const B0 = Math.floor((nowMs - 3_600_000) / 900_000) * 900_000;
		const B1 = B0 + 900_000;

		const model = async () =>
			withDashboardDb(
				(db) => buildDashboardModel(db, { view: "stats", scope: { kind: "all" }, timeZone: "UTC", nowMs }),
				{ dbPath },
			);

		it("counts one agent session once even when it touched two repos", async () => {
			// `sessions` is unique on (repo_id, source, session_id), so the SAME
			// agent session in two repos is two rows with two event ids. Counting
			// event ids would report one agent as two — and this figure is
			// machine-global, which makes that certain rather than latent.
			await applyStatsEvents(
				[
					session({ repoIdentity: "repo-1", source: "cursor", sessionId: "s1", activityBuckets: [B0] }),
					session({ repoIdentity: "repo-2", source: "cursor", sessionId: "s1", activityBuckets: [B0] }),
				],
				{ producerKind: "cli", dbPath },
			);
			expect((await model()).stats?.concurrency?.peak).toBe(1);
		});

		it("reports the peak and the mean over ACTIVE buckets only", async () => {
			await applyStatsEvents(
				[
					session({ source: "claude", sessionId: "s1", activityBuckets: [B0, B1] }),
					session({ source: "codex", sessionId: "s2", activityBuckets: [B0] }),
				],
				{ producerKind: "cli", dbPath },
			);
			const stats = (await model()).stats;
			// B0 holds 2 sessions, B1 holds 1. The mean over the two ACTIVE buckets
			// is 1.5 — not 3/672, which is what dividing by the window would give.
			expect(stats?.concurrency?.peak).toBe(2);
			expect(stats?.concurrency?.meanActive).toBeCloseTo(1.5);
			expect(stats?.concurrency?.buckets).toHaveLength(2);
			expect(stats?.concurrency?.bucketMinutes).toBe(15);
		});

		it("names sources that contributed sessions but no buckets as uncovered", async () => {
			await applyStatsEvents(
				[
					session({ source: "claude", sessionId: "s1", activityBuckets: [B0] }),
					session({ source: "opencode", sessionId: "s2" }),
				],
				{ producerKind: "cli", dbPath },
			);
			const stats = (await model()).stats;
			expect(stats?.concurrency?.measuredSources).toEqual(["claude"]);
			// Uncovered, NOT "ran zero agents".
			expect(stats?.concurrency?.uncoveredSources).toEqual(["opencode"]);
		});

		it("ignores the repo scope — concurrency is a property of the person", async () => {
			await applyStatsEvents(
				[
					session({ repoIdentity: "repo-1", source: "claude", sessionId: "s1", activityBuckets: [B0] }),
					session({ repoIdentity: "repo-2", source: "codex", sessionId: "s2", activityBuckets: [B0] }),
				],
				{ producerKind: "cli", dbPath },
			);
			const scoped = await withDashboardDb(
				(db) =>
					buildDashboardModel(db, {
						view: "stats",
						scope: { kind: "repo", repoIdentity: "repo-1" },
						timeZone: "UTC",
						nowMs,
					}),
				{ dbPath },
			);
			// Both agents still count: filtering here would truncate the number
			// into something with no actionable meaning.
			expect(scoped.stats?.concurrency?.peak).toBe(2);
		});

		it("omits the field entirely when no bucket falls in the window", async () => {
			await applyStatsEvents([session({ source: "claude", sessionId: "s1" })], {
				producerKind: "cli",
				dbPath,
			});
			// Absent, not a zero: under forward-only collection this is the normal
			// state for the first days after deployment.
			expect((await model()).stats?.concurrency).toBeUndefined();
		});
	});
```

`DashboardScope` is the interface at `DashboardModel.ts:643`; its repo-scoped
form is `{ kind: "repo", repoIdentity: "<identity>" }`, as used at
`DashboardServer.ts:651`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/DashboardQuery.test.ts -t "concurrency"`
Expected: FAIL — `concurrency` is not a property of `StatsModel`.

- [ ] **Step 3: Add the model type**

In `cli/src/dashboard/DashboardModel.ts`, next to `HourBucket`:

```ts
/** One quarter-hour and how many distinct agent sessions were active in it. */
export interface ConcurrencyBucket {
	readonly bucketMs: number;
	readonly sessions: number;
}

/**
 * How many agents ran at the same time — machine-global and self-only.
 *
 * Deliberately NOT filtered by the page's repo scope: concurrency means "how
 * many things was this person doing at once", which is a property of the person
 * and not of a repository. A per-repo figure truncates the number into
 * something with no actionable meaning.
 */
export interface ConcurrencyModel {
	/** Only buckets with at least one session; ascending. */
	readonly buckets: ReadonlyArray<ConcurrencyBucket>;
	/** Bucket width, carried on the wire so a renderer never hardcodes it. */
	readonly bucketMinutes: number;
	/**
	 * Highest session count in any one bucket — an UPPER BOUND on instantaneous
	 * concurrency, not the thing itself: two sessions active in the same quarter
	 * hour need not overlap at any instant. Any label must say "agents active
	 * within the same 15 minutes", never "running simultaneously".
	 */
	readonly peak: number;
	/**
	 * Mean session count over ACTIVE buckets. The denominator is deliberately
	 * the buckets with activity, not the buckets in the window: a 7-day window
	 * holds 672 buckets and dividing by all of them yields ~0.2, a figure with
	 * no meaning. Any label must state the denominator.
	 */
	readonly meanActive: number;
	/** Sources that contributed at least one bucket in the window. */
	readonly measuredSources: ReadonlyArray<TranscriptSource>;
	/** Sources that contributed sessions but no buckets — uncovered, not idle. */
	readonly uncoveredSources: ReadonlyArray<TranscriptSource>;
}
```

And in `StatsModel`, alongside `toolUsage`:

```ts
	/** Absent when no bucket falls in the window — a consumer shows "no data",
	 *  never a zero. Under forward-only collection this is the normal state for
	 *  the first days after deployment. */
	readonly concurrency?: ConcurrencyModel;
```

- [ ] **Step 4: Write the query**

In `cli/src/dashboard/DashboardQuery.ts`, next to `buildToolUsage`:

```ts
/**
 * The concurrency figure. Takes a window but NOT a scope: it is machine-global
 * by design (see {@link ConcurrencyModel}).
 */
function buildConcurrency(db: DashboardDbHandle, window: ResolvedWindow): ConcurrencyModel | undefined {
	const rows = db
		.prepare(
			// COUNT(DISTINCT session_event_id) would be WRONG: `sessions` is unique
			// on (repo_id, source, session_id), so one agent session that touched
			// two repos is two rows with two event ids and would count as two
			// agents. Machine-global aggregation makes that certain, not latent.
			`SELECT a.bucket_ms AS bucket_ms,
			        COUNT(DISTINCT s.source || ':' || s.session_id) AS n
			   FROM session_activity a
			   JOIN sessions s ON s.event_id = a.session_event_id
			  WHERE a.bucket_ms >= ? AND a.bucket_ms < ?
			  GROUP BY a.bucket_ms
			  ORDER BY a.bucket_ms`,
		)
		.all(window.startMs, window.endMs) as ReadonlyArray<{ bucket_ms: number; n: number }>;
	if (rows.length === 0) return undefined;

	const buckets = rows.map((r) => ({ bucketMs: r.bucket_ms, sessions: r.n }));
	const peak = buckets.reduce((max, b) => (b.sessions > max ? b.sessions : max), 0);
	const total = buckets.reduce((sum, b) => sum + b.sessions, 0);

	// Derived per query, never a declared list: the declarative alternative is
	// the shape of `PARSER_BACKED_SOURCES`, which omits `kimi` even though
	// `getParserForSource` accepts it.
	const measured = new Set(
		(
			db
				.prepare(
					`SELECT DISTINCT s.source AS source
					   FROM session_activity a
					   JOIN sessions s ON s.event_id = a.session_event_id
					  WHERE a.bucket_ms >= ? AND a.bucket_ms < ?`,
				)
				.all(window.startMs, window.endMs) as ReadonlyArray<{ source: string }>
		).map((r) => r.source),
	);
	const seen = (
		db
			.prepare("SELECT DISTINCT source FROM sessions WHERE updated_at_ms >= ? AND updated_at_ms < ?")
			.all(window.startMs, window.endMs) as ReadonlyArray<{ source: string }>
	).map((r) => r.source);

	return {
		buckets,
		bucketMinutes: ACTIVITY_BUCKET_MS / 60_000,
		peak,
		meanActive: total / buckets.length,
		measuredSources: [...measured].sort() as ReadonlyArray<TranscriptSource>,
		uncoveredSources: seen.filter((s) => !measured.has(s)).sort() as ReadonlyArray<TranscriptSource>,
	};
}
```

Import `ACTIVITY_BUCKET_MS` from `./ActivityBuckets.js` and `ConcurrencyModel` (type-only) from `./DashboardModel.js`. `ResolvedWindow` is the local interface at `DashboardQuery.ts:248`; its bounds are `startMs` (inclusive) and `endMs` (exclusive), the same pair `buildToolUsage` uses at line 1368.

- [ ] **Step 5: Wire it into the model**

In the `StatsModel` return block, after `toolUsage`:

```ts
		toolUsage: buildToolUsage(db, scope, window),
		...(concurrency !== undefined ? { concurrency } : {}),
```

with `const concurrency = buildConcurrency(db, window);` computed just above the return, next to `memoryCards`. Note the deliberate absence of `scope` in that call.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/dashboard/DashboardQuery.test.ts`
Expected: PASS, whole file.

- [ ] **Step 7: Commit**

```bash
git add cli/src/dashboard/DashboardModel.ts cli/src/dashboard/DashboardQuery.ts cli/src/dashboard/DashboardQuery.test.ts
git commit -s -m "Report machine-global agent concurrency from activity buckets"
```

---

### Task 6: Full gate

**Files:** none new.

- [ ] **Step 1: Run the whole gate**

```bash
npm run all
```

Expected: clean → build → typecheck → lint → test, all green, CLI coverage at or above 97/96/97/97.

- [ ] **Step 2: Triage any failure by shape, not by name**

A `Test timed out in NNNNms` under the full run is a **load signal**, not a regression — about a dozen CLI files spawn real `git` and get CPU-starved under `--coverage`. Re-run that file alone with the stock timeout; green in isolation is the proof. An assertion or thrown error is a real regression — investigate it.

- [ ] **Step 3: Verify against real data**

```bash
npm run cli -- dashboard --no-open
```

Then confirm buckets are actually landing. **First check the shared DB's version
against your build's** — if `schema_version` already equals the number you
claimed but `session_activity` is missing, you hit the collision described in
Global Constraints, and nothing below will work until you point at a fresh
`dbPath`:

```bash
node --input-type=module -e '
import {DatabaseSync} from "node:sqlite";
const db = new DatabaseSync(process.env.HOME + "/.jolli/jollimemory/jollimemory.db", {readOnly: true});
const q = (s) => db.prepare(s).all();
console.log("schema_version:", q("SELECT value FROM schema_meta WHERE key='schema_version'")[0]?.value);
console.log("has session_activity:", q("SELECT name FROM sqlite_master WHERE name='session_activity'").length === 1);
console.log("bucket rows:", q("SELECT COUNT(*) c FROM session_activity")[0].c);
console.table(q(`SELECT s.source, COUNT(DISTINCT a.session_event_id) sessions, COUNT(*) buckets
                   FROM session_activity a JOIN sessions s ON s.event_id = a.session_event_id
                  GROUP BY s.source ORDER BY buckets DESC`));
'
```

Expected: rows appear for `claude` and `codex` at minimum, since both readers emit per-message timestamps. Sessions collected before this change carry no buckets — forward-only collection is the chosen scope, so an initially small table is correct, not a bug.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -s -m "Fix <specific issue> found by the full gate"
```

Skip this step if the gate was green.

---

## Out of scope (do not add)

The spec's §7 lists these deliberately. Do not implement them here, even if they look like small wins:

- **UI.** No change to `cli/src/dashboard/assets/`. The stats page's session-activity card was deliberately removed while its payload stayed live; concurrency enters that same state on purpose, because the card order is authored against a design source not available in this repo.
- **Backfill** over the transcripts on disk.
- **OpenCode token/model**, even though its `session` table carries them.
- **Reader work** for the six sources that emit no per-message timestamps.
- **The `PARSER_BACKED_SOURCES` omission of `kimi`** — a real pre-existing bug, but unrelated; it belongs in its own change.
