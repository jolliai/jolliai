# Cursor-Aware Conversation-Overlay GC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the QueueWorker consumes a transcript slice into the orphan-branch summary + transcript, automatically drop any `ConversationOverlay` rule whose identity matches an entry in that slice, and unlink the overlay file when no rules remain.

**Architecture:** Add `pruneConsumedOverlayRules(sessions, projectDir)` next to the rest of the overlay store (same file, so it can reuse the private `matchesAnyIdentity` helper). Wire it into `QueueWorker.executePipeline` and `QueueWorker.handleAmendPipeline` immediately after `loadSessionTranscripts` returns the cursor-trimmed slice — that mirrors the existing "cursor advance = consumed" semantics (cursor advances inside `readAllTranscripts` regardless of summary success, so GC must too). Per-session try/catch isolates errors so one bad overlay file never aborts the sweep.

**Tech Stack:** TypeScript ESM, Vitest, existing modules in `cli/src/core/` and `cli/src/hooks/`.

**Project conventions in scope (CLAUDE.md critical rules):**
- DCO sign-off required on every commit (`git commit -s`). NO `Co-Authored-By: Claude …` / `🤖 Generated with …` trailers.
- `npm run all` must pass before commit. CLI coverage thresholds: 97% statements / 96% branches / 97% functions / 97% lines.
- Per user feedback (`feedback_no_per_task_commit_and_test`): tasks contain only code + tests. The full `npm run all` gate and the single commit live in the final task — not per task.
- Per user feedback (`feedback_no_claude_coauthor`): commit message ends with `Signed-off-by:` only.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| [`cli/src/core/ConversationOverlayStore.ts`](cli/src/core/ConversationOverlayStore.ts) | modify | Add exported `pruneConsumedOverlayRules` + private `pruneOneSession` helper. Reuses private `matchesAnyIdentity`. |
| [`cli/src/core/ConversationOverlayStore.test.ts`](cli/src/core/ConversationOverlayStore.test.ts) | modify | Add `describe("pruneConsumedOverlayRules")` block with 5 cases. |
| [`cli/src/hooks/QueueWorker.ts`](cli/src/hooks/QueueWorker.ts) | modify | Extend overlay-store import; call `pruneConsumedOverlayRules` right after `loadSessionTranscripts` in both `executePipeline` (~line 964) and `handleAmendPipeline` (~line 1576). |
| [`cli/src/hooks/QueueWorker.overlay.test.ts`](cli/src/hooks/QueueWorker.overlay.test.ts) | modify | Two end-to-end cases: rules all consumed → file unlinked; rule outside slice → file retained. |

No new files.

---

## Tasks

### Task 1: Failing unit tests for `pruneConsumedOverlayRules`

**Files:**
- Test: `cli/src/core/ConversationOverlayStore.test.ts`

- [ ] **Step 1: Extend the existing import block**

The current import (top of the file) is:

```ts
import {
	applyDeletes,
	applyOverlay,
	applyOverlaysToSessions,
	type ConversationOverlay,
	loadOverlay,
	mergeOverlay,
	overlayPath,
	saveOverlay,
} from "./ConversationOverlayStore.js";
```

Replace it with:

```ts
import {
	applyDeletes,
	applyOverlay,
	applyOverlaysToSessions,
	type ConversationOverlay,
	loadOverlay,
	mergeOverlay,
	type OverlayableSession,
	overlayPath,
	pruneConsumedOverlayRules,
	saveOverlay,
} from "./ConversationOverlayStore.js";
```

Verify the `node:fs` import line already includes `statSync`. If not, change it from:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

to:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
```

Verify the `node:path` import already includes `dirname`. If not, change it from:

```ts
import { join, resolve, sep } from "node:path";
```

to:

```ts
import { dirname, join, resolve, sep } from "node:path";
```

- [ ] **Step 2: Append the new describe block**

Inside the outer `describe("ConversationOverlayStore", () => { … })` block, right before its closing `});`, append:

```ts
	describe("pruneConsumedOverlayRules", () => {
		const sid = "session-prune";
		const overlayFile = () => overlayPath({ projectDir, source: "claude", sessionId: sid });

		it("removes rules whose identity matches an entry in the consumed slice", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{
					deletes: [
						{ role: "human", content: "ask-A", timestamp: "t1" },
						{ role: "human", content: "ask-B", timestamp: "t2" },
					],
					edits: [
						{ role: "assistant", content: "raw-C", timestamp: "t3", newContent: "edited-C" },
					],
				},
			);

			const session: OverlayableSession = {
				sessionId: sid,
				source: "claude",
				entries: [
					// matches the first delete rule by identity
					{ role: "human", content: "ask-A", timestamp: "t1" },
					// matches the edit rule by raw identity (NOT by newContent)
					{ role: "assistant", content: "raw-C", timestamp: "t3" },
					// ask-B is NOT in the slice → that delete rule must survive
				],
			};

			await pruneConsumedOverlayRules([session], projectDir);

			const remaining = await loadOverlay({ projectDir, source: "claude", sessionId: sid });
			expect(remaining?.deletes).toEqual([
				{ role: "human", content: "ask-B", timestamp: "t2" },
			]);
			expect(remaining?.edits).toEqual([]);
		});

		it("unlinks the overlay file when all rules are consumed", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{
					deletes: [{ role: "human", content: "only", timestamp: "t1" }],
					edits: [],
				},
			);
			expect(existsSync(overlayFile())).toBe(true);

			const session: OverlayableSession = {
				sessionId: sid,
				source: "claude",
				entries: [{ role: "human", content: "only", timestamp: "t1" }],
			};

			await pruneConsumedOverlayRules([session], projectDir);

			expect(existsSync(overlayFile())).toBe(false);
		});

		it("is a no-op when the overlay file does not exist", async () => {
			const session: OverlayableSession = {
				sessionId: "never-saved",
				source: "claude",
				entries: [{ role: "human", content: "x", timestamp: "t" }],
			};
			await expect(pruneConsumedOverlayRules([session], projectDir)).resolves.toBeUndefined();
		});

		it("does not re-write the file when nothing matched (idempotent, mtime stable)", async () => {
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: sid },
				{
					deletes: [{ role: "human", content: "ask-X", timestamp: "tX" }],
					edits: [],
				},
			);
			const path = overlayFile();
			const mtimeBefore = statSync(path).mtimeMs;

			// Wait long enough that a rewrite would change mtime measurably on
			// macOS/Linux (filesystem timestamp granularity is ms or coarser).
			await new Promise((r) => setTimeout(r, 20));

			const session: OverlayableSession = {
				sessionId: sid,
				source: "claude",
				entries: [{ role: "human", content: "unrelated", timestamp: "tY" }],
			};
			await pruneConsumedOverlayRules([session], projectDir);

			expect(statSync(path).mtimeMs).toBe(mtimeBefore);
		});

		it("isolates per-session errors so one bad overlay does not abort the sweep", async () => {
			// Good overlay for s1 — should be pruned and the file unlinked.
			await saveOverlay(
				{ projectDir, source: "claude", sessionId: "s1" },
				{ deletes: [{ role: "human", content: "ask", timestamp: "t1" }], edits: [] },
			);
			// Corrupt overlay for s2 — loadOverlay returns null, prune skips it.
			const s2Path = overlayPath({ projectDir, source: "claude", sessionId: "s2" });
			mkdirSync(dirname(s2Path), { recursive: true });
			writeFileSync(s2Path, "not json", "utf8");

			const sessions: ReadonlyArray<OverlayableSession> = [
				{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "ask", timestamp: "t1" }] },
				{ sessionId: "s2", source: "claude", entries: [] },
			];

			await pruneConsumedOverlayRules(sessions, projectDir);

			expect(existsSync(overlayPath({ projectDir, source: "claude", sessionId: "s1" }))).toBe(false);
			// Corrupt file is left alone — operator can inspect, and prune treats it
			// like "no overlay" (loadOverlay returned null).
			expect(existsSync(s2Path)).toBe(true);
		});
	});
```

- [ ] **Step 3: Run tests — verify they fail**

Run:
```bash
npm run test -w @jolli.ai/cli -- src/core/ConversationOverlayStore.test.ts -t "pruneConsumedOverlayRules"
```

Expected: TypeScript / runtime error — `pruneConsumedOverlayRules` is not exported from `./ConversationOverlayStore.js`. This is the TDD red step. Confirm the failure mode is "missing export" (not a typo elsewhere) before moving on.

---

### Task 2: Implement `pruneConsumedOverlayRules`

**Files:**
- Modify: `cli/src/core/ConversationOverlayStore.ts`

- [ ] **Step 1: Insert the new function**

Find the end of `applyOverlaysToSessions` and the start of the identity-matching section. The exact anchor is:

```ts
		}),
	);
}

// ─── Identity matching ───────────────────────────────────────────────────────
```

Replace it with:

```ts
		}),
	);
}

/**
 * Garbage-collects overlay rules whose identity matches an entry in the
 * QueueWorker's consumed slice. Called from QueueWorker immediately after
 * `loadSessionTranscripts` returns — by that point, cursor has already
 * advanced inside `readAllTranscripts` past every entry in the slice, so
 * any rule whose identity matches one of those entries can no longer
 * affect future summaries. Such rules are dead state: keep dropping them
 * here so overlay files don't accumulate.
 *
 * Per session:
 *   - Drops delete/edit rules whose `(role, content, timestamp)` identity
 *     matches one of `s.entries`. For edits, the matched identity is the
 *     source entry's *original* content, not the `newContent` replacement
 *     — see [[OverlayEditRule]] for why identity anchors to the raw entry.
 *   - If all rules end up gone, unlinks the overlay file entirely so
 *     [[hasOverlayChanges]] (which drives the sidebar `edited` badge)
 *     also flips to false. Leaving a present-but-empty overlay would
 *     cost a `loadOverlay` round-trip on every panel open and every
 *     active-sessions refresh; unlinking lets the ENOENT short-circuit
 *     handle those cases.
 *
 * Failure isolation: per-session try/catch — a malformed overlay
 * (`loadOverlay` returns null → silent skip) or a write failure on one
 * session never aborts the sweep for the rest of the batch. Errors are
 * warn-logged.
 *
 * Safe to call when `sessions` includes entries with no overlay file on
 * disk — that is the common case, since most sessions are never edited.
 */
export async function pruneConsumedOverlayRules(
	sessions: ReadonlyArray<OverlayableSession>,
	projectDir: string,
): Promise<void> {
	await Promise.all(sessions.map((s) => pruneOneSession(s, projectDir)));
}

async function pruneOneSession(s: OverlayableSession, projectDir: string): Promise<void> {
	const source = (s.source ?? "claude") as TranscriptSource;
	const key: OverlayKey = { projectDir, source, sessionId: s.sessionId };
	try {
		const overlay = await loadOverlay(key);
		if (!overlay) return;
		// matchesAnyIdentity uses the symmetric sameIdentity comparator, so
		// passing (rule, s.entries) is equivalent to "entries.some(e =>
		// sameIdentity(e, rule))" — we reuse the helper rather than calling
		// sameIdentity directly so prune stays consistent with applyOverlay's
		// matching semantics (one source of truth for identity equality).
		const remainingDeletes = overlay.deletes.filter((r) => !matchesAnyIdentity(r, s.entries));
		const remainingEdits = overlay.edits.filter((r) => !matchesAnyIdentity(r, s.entries));
		const unchanged =
			remainingDeletes.length === overlay.deletes.length &&
			remainingEdits.length === overlay.edits.length;
		if (unchanged) return;
		if (remainingDeletes.length === 0 && remainingEdits.length === 0) {
			try {
				await unlink(overlayPath(key));
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}
		await saveOverlay(key, { deletes: remainingDeletes, edits: remainingEdits });
	} catch (err) {
		log.warn(
			"pruneConsumedOverlayRules failed for %s/%s: %s",
			source,
			s.sessionId,
			errMsg(err),
		);
	}
}

// ─── Identity matching ───────────────────────────────────────────────────────
```

- [ ] **Step 2: Run tests — verify they pass**

Run:
```bash
npm run test -w @jolli.ai/cli -- src/core/ConversationOverlayStore.test.ts -t "pruneConsumedOverlayRules"
```

Expected: all 5 cases PASS.

---

### Task 3: Wire `pruneConsumedOverlayRules` into QueueWorker

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts`

- [ ] **Step 1: Extend the existing overlay import**

Find at line 25:

```ts
import { applyOverlaysToSessions } from "../core/ConversationOverlayStore.js";
```

Replace with:

```ts
import { applyOverlaysToSessions, pruneConsumedOverlayRules } from "../core/ConversationOverlayStore.js";
```

- [ ] **Step 2: Add the GC call in `executePipeline`**

Find at line 964:

```ts
	const { sessionTranscripts, totalEntries, humanEntries } = await loadSessionTranscripts(cwd, config, op.createdAt);
```

Insert the following lines immediately after, before whatever block follows:

```ts
	// Cursor-aware overlay GC. `sessionTranscripts` is the slice cursor just
	// advanced past — cursor advance happens inside readAllTranscripts and is
	// decoupled from storeSummary success (see SessionTracker.saveCursor), so
	// any overlay rule whose identity matches an entry here will never apply
	// again no matter what the downstream pipeline does. Drop them now; unlink
	// the overlay file when nothing remains so the sidebar `edited` badge
	// (hasOverlayChanges) also turns off. GC is fire-and-forget for the
	// pipeline — per-session errors only warn-log.
	await pruneConsumedOverlayRules(sessionTranscripts, cwd);
```

- [ ] **Step 3: Add the GC call in `handleAmendPipeline`**

Find at line 1572:

```ts
	const { sessionTranscripts, totalEntries, humanEntries } = await loadSessionTranscripts(
		cwd,
		amendConfig,
		beforeTimestamp,
	);
```

Insert immediately after the closing `);`:

```ts
	// Cursor-aware overlay GC — same rationale as in executePipeline. Runs
	// before any amend-pipeline branch (Short-circuit A trivial-delta path,
	// retry-exhausted return at ~line 1700, full path, fresh-leaf path) so
	// every branch gets the cleanup even when it short-circuits past
	// storeSummary.
	await pruneConsumedOverlayRules(sessionTranscripts, cwd);
```

- [ ] **Step 4: Run typecheck — verify imports resolve**

Run:
```bash
npm run typecheck:cli
```

Expected: PASS. If a TypeScript error appears about the new identifier, re-check the import edit in Step 1.

---

### Task 4: End-to-end GC tests in `QueueWorker.overlay.test.ts`

**Files:**
- Modify: `cli/src/hooks/QueueWorker.overlay.test.ts`

- [ ] **Step 1: Extend the imports**

Verify `existsSync` is imported from `node:fs` at the top of the test file. If only some fs primitives are imported, change the import to include `existsSync` (it is used by the new assertions).

Find at line 139:

```ts
import { saveOverlay } from "../core/ConversationOverlayStore.js";
```

Replace with:

```ts
import { loadOverlay, overlayPath, pruneConsumedOverlayRules, saveOverlay } from "../core/ConversationOverlayStore.js";
```

- [ ] **Step 2: Append two GC cases to the describe block**

Inside `describe("QueueWorker overlay path", () => { … })`, right before the closing `});`, append:

```ts
	it("pruneConsumedOverlayRules unlinks the overlay once every rule's identity appears in the consumed slice", async () => {
		const { sessionInfo } = stubSession();
		// Both rules' identities match entries returned by stubSession
		// (msg-2 at t1, msg-4 at t3).
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: [{ role: "assistant", content: "msg-2", timestamp: "t1" }],
				edits: [{ role: "assistant", content: "msg-4", timestamp: "t3", newContent: "EDITED" }],
			},
		);
		const file = overlayPath({ projectDir, source: "claude", sessionId: sessionInfo.sessionId });
		expect(existsSync(file)).toBe(true);

		const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);
		await pruneConsumedOverlayRules(result.sessionTranscripts, projectDir);

		expect(existsSync(file)).toBe(false);
	});

	it("pruneConsumedOverlayRules keeps the overlay when a rule's identity is outside the consumed slice", async () => {
		const { sessionInfo } = stubSession();
		// "future-msg" / "t99" is NOT in stubSession's entries — rule must survive.
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: [{ role: "assistant", content: "future-msg", timestamp: "t99" }],
				edits: [],
			},
		);
		const file = overlayPath({ projectDir, source: "claude", sessionId: sessionInfo.sessionId });

		const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);
		await pruneConsumedOverlayRules(result.sessionTranscripts, projectDir);

		expect(existsSync(file)).toBe(true);
		const remaining = await loadOverlay({ projectDir, source: "claude", sessionId: sessionInfo.sessionId });
		expect(remaining?.deletes).toEqual([{ role: "assistant", content: "future-msg", timestamp: "t99" }]);
		expect(remaining?.edits).toEqual([]);
	});
```

- [ ] **Step 3: Run tests — verify all overlay-suite tests pass**

Run:
```bash
npm run test -w @jolli.ai/cli -- src/hooks/QueueWorker.overlay.test.ts
```

Expected: every existing case + the two new GC cases PASS.

---

### Task 5: Full workspace gate, manual cleanup of legacy overlay files, single commit

- [ ] **Step 1: Run the workspace gate**

Run:
```bash
npm run all
```

Expected: PASS — `clean → build → lint → test`. The CLI coverage gate (97/96/97/97) is enforced inside `npm run test`. If the new function's coverage dips below threshold, add cases to `ConversationOverlayStore.test.ts` until it meets the floor — do NOT lower the threshold and do NOT add `/* v8 ignore */` to make unhit lines disappear.

- [ ] **Step 2: Manually clean up legacy dead overlay files**

The current worktree has 3 pre-existing dead overlay files at `.jolli/jollimemory/conversation-edits/claude--*.json` whose rules all reference entries already past the cursor. The new active GC won't sweep them because no future commit will re-include those long-consumed entries in a slice. Clean them by hand:

```bash
ls .jolli/jollimemory/conversation-edits/
# Expected: three claude--<sid>.json files. Confirm the listing matches before deleting.
rm .jolli/jollimemory/conversation-edits/claude--*.json
```

If the implementer is running this in a clean worktree without those files, this step is a harmless no-op (`rm` will fail with "no matches" depending on shell glob settings — that is fine).

This step is NOT staged in the commit — `.jolli/jollimemory/` is per-project gitignored state.

- [ ] **Step 3: Stage exactly the four modified files**

Run:
```bash
git add \
	cli/src/core/ConversationOverlayStore.ts \
	cli/src/core/ConversationOverlayStore.test.ts \
	cli/src/hooks/QueueWorker.ts \
	cli/src/hooks/QueueWorker.overlay.test.ts

git status
git diff --cached --stat
```

Expected: exactly four files in the staged set, no other modifications crept in (re-run the relevant `git restore --staged` and stage again if so).

- [ ] **Step 4: Commit with DCO sign-off**

Run:
```bash
git commit -s -m "$(cat <<'EOF'
Garbage-collect consumed conversation-overlay rules in QueueWorker

When the QueueWorker reads a transcript slice and bakes it into the
orphan-branch summary + transcript, any ConversationOverlay rule whose
identity matches an entry in that slice has completed its purpose:
cursor has advanced past the matched entries and the rule will never
apply again. ConversationDetailsPanel only renders the unread
(cursor-trimmed) slice, so the sidebar `edited` badge backed by
hasOverlayChanges currently keeps pointing at sessions whose edits
are no longer visible anywhere.

Add pruneConsumedOverlayRules — drops matched rules and unlinks the
overlay file when none remain — and call it in executePipeline and
handleAmendPipeline immediately after loadSessionTranscripts returns.
Per-session try/catch keeps a single bad overlay from aborting the
sweep; co-locating with the rest of the overlay store lets it reuse
the private identity helpers.
EOF
)"
```

Expected: commit succeeds. The commit message ends with the `Signed-off-by:` trailer auto-added by `-s`. NO `Co-Authored-By: Claude …` trailer. NO `🤖 Generated with …` footer.

- [ ] **Step 5: Final verification**

Run:
```bash
git log -1 --stat
git log -1 --format="%(trailers)"
```

Expected: HEAD shows the four-file diff, and `--format="%(trailers)"` shows `Signed-off-by: …` and nothing else.

---

## Self-Review

**Spec coverage:**
- "消费完就清" → Task 2 (prune impl) + Task 3 (wire into both pipelines). ✓
- "sidebar `edited` 标记跟未点亮 panel 编辑视图脱钩" → Task 1's "unlinks the overlay file when all rules are consumed" case + Task 4's first integration case both assert `existsSync(file) === false`. Since `loadOverlay` returns null for a missing file and `hasOverlayChanges(null) === false`, the badge link is unbroken; no separate assertion needed. ✓
- User's 3 legacy overlay files → Task 5 Step 2 manual cleanup. ✓

**Placeholder scan:** no "TBD"/"如适用"/"similar to Task N"/empty test bodies. Every code block is the actual content to paste. ✓

**Type consistency:**
- `pruneConsumedOverlayRules(sessions: ReadonlyArray<OverlayableSession>, projectDir: string): Promise<void>` — used identically in Task 2 (def), Task 3 (two call sites), Task 4 (two test call sites). ✓
- `OverlayableSession` fields (`sessionId`, `source`, `entries`) — used identically across Task 1 / Task 4. ✓
- `matchesAnyIdentity(r, s.entries)` — `r: EntryIdentity`, `s.entries: ReadonlyArray<TranscriptEntry>`. `TranscriptEntry` is structurally a superset of `EntryIdentity` (role / content / optional timestamp), and `sameIdentity` is symmetric, so this call is well-typed and semantically equivalent to `s.entries.some(e => sameIdentity(e, r))`. ✓
