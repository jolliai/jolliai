# Transcript session timestamps on the pushed summary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a root-stamped, tree-wide `transcriptSessions[]` array on the pushed `summaryJson`, carrying `{sessionId, source, messageCount, startedAt, endedAt}` per conversation, so the coaching dashboard's time axis has a producer.

**Architecture:** Push-time enrichment. A new pure-ish module derives the rows from the transcript artifacts a summary tree references, and the two push weave points fold the result into the copy that `serializeSummaryJson` serializes. Nothing is added to the stored summary schema, so the change is clear of the FolderStorage / IntelliJ-reader lockstep contracts and applies retroactively to every already-stored memory on its next push.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-06-transcript-session-timestamps-design.md`](../specs/2026-08-06-transcript-session-timestamps-design.md)

> **⚠ SUPERSEDED where it names the batch push path — read against the as-shipped code, not literally.** This plan was written when `JolliMemoryPushOrchestrator` still had TWO weave points: `pushSummary` and a `buildOneBatchItem` on a batch endpoint. That batch endpoint has since been removed (the per-kind batch assembly now lives in [`cli/src/core/push/ContextPush.ts`](../../../cli/src/core/push/ContextPush.ts) and `buildOneBatchItem` no longer exists), so:
> - **Task 3 ("both push paths") has ONE CLI weave point as shipped**, `pushSummary`'s `summaryForMarkdown` — the "lines 604–609 / `buildOneBatchItem`" half no longer applies. Do not go looking for that function.
> - **A THIRD weave point was added after this plan**: the ide-bridge `serialize-summary` op ([`cli/src/commands/IdeBridgeCommand.ts`](../../../cli/src/commands/IdeBridgeCommand.ts)) derives the same enrichment for JVM-initiated shares, which have no Kotlin equivalent of `collectTranscriptSessionMeta`.
> - **Task 1's pasted implementation predates the batch removal too** — the shipped `collectTranscriptSessionMeta` reads through `readTranscriptsBatch`, not the `readTranscript`-per-id loop reproduced below. Trust [`cli/src/core/TranscriptSessionMeta.ts`](../../../cli/src/core/TranscriptSessionMeta.ts) over the snippet.

## Global Constraints

- **Per task: run only that task's own test file(s), then commit. Never run `npm run all` before Task 4.** The full gate is 3.5–9 minutes and belongs at the end; a single test file is seconds. So each of Tasks 1–3 ends with `npx vitest run <its own test file>` and a `git commit -s`, and Task 4 is the one place the whole chain runs. Do not expand a task's test command into the suite, the workspace script, or `npm run all` — that substitution is the specific thing this constraint forbids. (Ruled 2026-08-06: the plan originally deferred both the runs and the commits to Task 4, which left the per-task reviews with no diff and no test evidence.)
- **DCO sign-off on the commit:** `git commit -s`. No `Co-Authored-By: Claude …` trailer, no `🤖 Generated with …` footer.
- **The single-file test command, verified — use exactly this form, run from the `cli/` directory:**

  ```bash
  npx vitest run --coverage=false src/core/<file>.test.ts
  ```

  Both obvious alternatives are dead ends, so do not "fix" this into either of them:
  - Dropping `--coverage=false` fails on the coverage floor. `cli`'s `test` script is `vitest run --coverage`, and the 97 % thresholds are computed over the **whole** `src` tree — so a single-file run reports every other file as uncovered and goes red. That red is the command's fault, not the code's.
  - The root-level form AGENTS.md documents (`npm run test -w @jolli.ai/cli -- …`) **cannot** take the flag: the script already hardcodes `--coverage`, and vitest rejects the duplicate with `Expected a single value for option "--coverage", received [true, false]`.

- **CLI coverage floor is 97 % statements / 96 % branches / 97 % functions / 97 % lines.** Never lower it; never edit `cli/vite.config.ts` or `cli/biome.json`.
- **Tests must not spawn `git`.** Inject a fake `StorageProvider` instead. Real-`git` test files are the ones that CPU-starve and time out under a full `--coverage` run, and a timeout is indistinguishable at a glance from a real regression.
- **Biome:** tabs, 4-wide, 120-column limit. `noExplicitAny: error`, `noUnusedImports`/`noUnusedVariables: error`. CI runs `biome check --error-on-warnings`, so warnings fail.
- **Do not touch:** `CommitSummary` (`cli/src/Types.ts`), `FolderStorage`, the IntelliJ `FolderStorageReader` / `KBFolderReader`, the orphan-branch layout, `QueueWorker`, any git hook, or the config schema. No new configuration option.
- **No network call may be added to the push path.** The inline pre-push hook's whole budget is `PRE_PUSH_SYNC_BUDGET_MS = 3_000` with `INLINE_MIN_HTTP_BUDGET_MS = 500` reserved for the request; exceeding it defers the entire batch rather than degrading a field.

---

### Task 1: The derivation module

Derives the per-session rows from a summary tree's transcript artifacts. Pure aggregation over injected reads — no git, no network.

**Files:**
- Create: `cli/src/core/TranscriptSessionMeta.ts`
- Test: `cli/src/core/TranscriptSessionMeta.test.ts`

**Interfaces:**
- Consumes: `resolveTranscriptIdsForUsage(summary)` from `./SummaryTree.js`; `readTranscript(id, cwd?, storage?)` from `./SummaryStore.js`; types `CommitSummary`, `StoredTranscript`, `TranscriptEntry` from `../Types.js`; `StorageProvider` from `./StorageProvider.js`.
- Produces:
  - `export interface TranscriptSessionMeta { readonly sessionId: string; readonly source: string; readonly messageCount: number; readonly startedAt?: string; readonly endedAt?: string }`
  - `export async function collectTranscriptSessionMeta(summary: CommitSummary, cwd?: string, storage?: StorageProvider): Promise<ReadonlyArray<TranscriptSessionMeta>>` — returns `[]` when nothing is derivable.

**Background the implementer needs:**

`summary.transcripts` holds *transcript artifact ids*, not session ids. Each id maps to one `transcripts/<id>.json` file holding a `StoredTranscript` — `{ sessions: StoredSession[] }` — and each `StoredSession` has `{sessionId, source?, entries: TranscriptEntry[]}`. `TranscriptEntry.timestamp` is optional.

Use `resolveTranscriptIdsForUsage` for id gathering; do not hand-roll it and do not use `getTranscriptIds`. Its docstring explains why: it returns every id any node in the tree lists, and falls back to the commit-hash ids of a pre-v5 tree when no node lists any. Both properties matter here — a child-listed id must not be missed, and legacy trees are exactly the retroactive coverage this design exists for.

`readTranscript`'s first parameter is named `commitHash` for legacy reasons; it is interpolated straight into `transcripts/${id}.json`, so passing a transcript id is correct. `resolveStorage(storage)` short-circuits on an injected provider, so passing a fake `StorageProvider` keeps the whole path off git.

Two deliberate simplifications from the spec's §4 wording, both narrowing rather than widening:
- **No cross-summary artifact cache.** The stated purpose was "avoid re-reading the artifacts a squash tree references repeatedly", and a per-call `seen` set of ids achieves exactly that. A cache spanning summaries would add lifetime management for a case that does not arise (different commits reference different artifacts).
- The `seen` set is **required**, not an optimisation: the `getTranscriptIds` fallback path (`collectAllTranscriptHashes`) can yield the same id twice, which would double-count `messageCount`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import type { CommitSummary, StoredTranscript } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { collectTranscriptSessionMeta } from "./TranscriptSessionMeta.js";

/**
 * Minimal StorageProvider that serves the given `transcripts/<id>.json` bodies
 * and nothing else. `readTranscript` calls only `readFile`, and
 * `resolveStorage` short-circuits on an injected provider, so no other method
 * is reached — the casts keep the fake to the surface actually exercised.
 */
function fakeStorage(files: Record<string, string>, opts?: { readonly throwOn?: string }): StorageProvider {
	return {
		readFile: async (path: string) => {
			if (opts?.throwOn === path) throw new Error("simulated read failure");
			return files[path] ?? null;
		},
	} as unknown as StorageProvider;
}

function transcriptJson(transcript: StoredTranscript): string {
	return JSON.stringify(transcript);
}

/** A v5 root: `transcripts` is authoritative, so no tree walk is needed. */
function rootWith(transcriptIds: ReadonlyArray<string>, children?: ReadonlyArray<CommitSummary>): CommitSummary {
	return {
		version: 5,
		commitHash: "a".repeat(40),
		commitMessage: "feat: something",
		commitAuthor: "Dev",
		commitDate: "2026-08-01T10:00:00.000Z",
		branch: "feature/x",
		generatedAt: "2026-08-01T10:05:00.000Z",
		transcripts: transcriptIds,
		...(children !== undefined && { children }),
	} as CommitSummary;
}

describe("collectTranscriptSessionMeta", () => {
	it("sums messageCount and spans min→max across a session's slices in two artifacts", async () => {
		// The amend shape: one session archived into a base artifact and a delta artifact.
		const storage = fakeStorage({
			"transcripts/base.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [
							{ role: "human", content: "a", timestamp: "2026-08-01T10:00:00.000Z" },
							{ role: "assistant", content: "b", timestamp: "2026-08-01T10:10:00.000Z" },
						],
					},
				],
			}),
			"transcripts/delta.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [{ role: "human", content: "c", timestamp: "2026-08-01T09:00:00.000Z" }],
					},
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["base", "delta"]), "/repo", storage);

		expect(rows).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 3,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			},
		]);
	});

	it("keeps sessions with the same id but different sources apart", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [
					{ sessionId: "dup", source: "claude", entries: [{ role: "human", content: "a" }] },
					{ sessionId: "dup", source: "codex", entries: [{ role: "human", content: "b" }] },
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.source).sort()).toEqual(["claude", "codex"]);
	});

	it("defaults a missing source to claude", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [{ sessionId: "s1", entries: [{ role: "human", content: "a" }] }],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows[0]?.source).toBe("claude");
	});

	it("omits both bounds when no entry carries a parseable timestamp", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [
							{ role: "human", content: "a" },
							{ role: "assistant", content: "b", timestamp: "not a date" },
						],
					},
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows[0]).toEqual({ sessionId: "s1", source: "claude", messageCount: 2 });
		expect(rows[0]).not.toHaveProperty("startedAt");
		expect(rows[0]).not.toHaveProperty("endedAt");
	});

	it("returns an empty array when no artifact resolves", async () => {
		const rows = await collectTranscriptSessionMeta(rootWith(["missing"]), "/repo", fakeStorage({}));

		expect(rows).toEqual([]);
	});

	it("skips an unreadable artifact and still emits the readable ones", async () => {
		const storage = fakeStorage(
			{
				"transcripts/good.json": transcriptJson({
					sessions: [{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "a" }] }],
				}),
			},
			{ throwOn: "transcripts/bad.json" },
		);

		const rows = await collectTranscriptSessionMeta(rootWith(["bad", "good"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 1 }]);
	});

	it("skips a session with no sessionId rather than emitting a keyless row", async () => {
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [
					{ sessionId: "", source: "claude", entries: [{ role: "human", content: "a" }] },
					{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "b" }] },
				],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 1 }]);
	});

	it("counts a repeated artifact id once, so messageCount is not doubled", async () => {
		// The pre-v5 fallback path can yield the same id twice; the dedupe guard is
		// what keeps the total equal to the de-duplicated entry count.
		const storage = fakeStorage({
			"transcripts/t1.json": transcriptJson({
				sessions: [{ sessionId: "s1", source: "claude", entries: [{ role: "human", content: "a" }] }],
			}),
		});

		const rows = await collectTranscriptSessionMeta(rootWith(["t1", "t1"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 1 }]);
	});

	it("gathers ids listed on children, not only the root's index", async () => {
		const storage = fakeStorage({
			"transcripts/child.json": transcriptJson({
				sessions: [{ sessionId: "s-child", source: "claude", entries: [{ role: "human", content: "a" }] }],
			}),
		});
		const child = rootWith(["child"]);
		// A root whose own index is empty while a child still lists an id — the shape
		// `resolveTranscriptIdsForUsage` exists to handle.
		const root = { ...rootWith([]), children: [child] } as CommitSummary;

		const rows = await collectTranscriptSessionMeta(root, "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s-child", source: "claude", messageCount: 1 }]);
	});

	it("tolerates a transcript whose session carries no entries array", async () => {
		// `readTranscript` casts JSON.parse output, so the type is a promise, not a guarantee.
		const storage = fakeStorage({ "transcripts/t1.json": '{"sessions":[{"sessionId":"s1"}]}' });

		const rows = await collectTranscriptSessionMeta(rootWith(["t1"]), "/repo", storage);

		expect(rows).toEqual([{ sessionId: "s1", source: "claude", messageCount: 0 }]);
	});
});
```

- [ ] **Step 2: Write the implementation**

```typescript
/**
 * Per-conversation metadata for the pushed summary sidecar.
 *
 * A PUSH-TIME enrichment, never stored: the rows are derived from the transcript
 * artifacts a summary tree already references, so every memory already on disk
 * gains its time axis on its next push. Deliberately absent from
 * `CommitSummary` — see `EnrichedPushSummary` in `JolliMemoryPushOrchestrator.ts`
 * for the type boundary that keeps the storage path unable to name this field.
 *
 * Timestamps only, no conversation content, so the `BranchShareScope.transcripts
 * = false` contract is untouched.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, StoredSession, TranscriptEntry } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { readTranscript } from "./SummaryStore.js";
import { resolveTranscriptIdsForUsage } from "./SummaryTree.js";

const log = createLogger("TranscriptSessionMeta");

/** Back-compat convention shared with the server: a source-less session is a Claude one. */
const DEFAULT_SOURCE = "claude";

/**
 * One conversation's bounds and size. `startedAt`/`endedAt` are omitted together
 * when the session carries no parseable timestamp — a journey of unknown length
 * must render as unmeasured, never as an instant one, so an epoch or an empty
 * string here would be worse than the gap.
 */
export interface TranscriptSessionMeta {
	readonly sessionId: string;
	readonly source: string;
	readonly messageCount: number;
	readonly startedAt?: string;
	readonly endedAt?: string;
}

/** Running total for one `<source>:<sessionId>` key. The `*Ms` fields never leave this module. */
interface SessionAccumulator {
	readonly sessionId: string;
	readonly source: string;
	messageCount: number;
	startedAt?: string;
	startedMs?: number;
	endedAt?: string;
	endedMs?: number;
}

/** The original string when it parses as a date, else undefined. Never coerced. */
function usableTimestamp(value: string | undefined): { readonly at: string; readonly ms: number } | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? undefined : { at: value, ms };
}

/**
 * Widens the accumulator's span to cover `entries`. Compares parsed epoch millis
 * rather than the ISO strings: two timestamps can be the same instant in
 * different offsets, where a lexicographic comparison picks the wrong one.
 */
function foldEntryTimes(acc: SessionAccumulator, entries: ReadonlyArray<TranscriptEntry>): void {
	for (const entry of entries) {
		const parsed = usableTimestamp(entry.timestamp);
		if (!parsed) continue;
		if (acc.startedMs === undefined || parsed.ms < acc.startedMs) {
			acc.startedAt = parsed.at;
			acc.startedMs = parsed.ms;
		}
		if (acc.endedMs === undefined || parsed.ms > acc.endedMs) {
			acc.endedAt = parsed.at;
			acc.endedMs = parsed.ms;
		}
	}
}

function toMeta(acc: SessionAccumulator): TranscriptSessionMeta {
	return {
		sessionId: acc.sessionId,
		source: acc.source,
		messageCount: acc.messageCount,
		...(acc.startedAt !== undefined && { startedAt: acc.startedAt }),
		...(acc.endedAt !== undefined && { endedAt: acc.endedAt }),
	};
}

/** Folds one archived session's slice into the running per-session map. */
function foldSession(byKey: Map<string, SessionAccumulator>, session: StoredSession): void {
	// A row with no id has no join key server-side, so it would be dropped there anyway.
	if (!session.sessionId) return;
	const source = session.source ?? DEFAULT_SOURCE;
	const key = `${source}:${session.sessionId}`;
	const acc = byKey.get(key) ?? { sessionId: session.sessionId, source, messageCount: 0 };
	// `readTranscript` casts JSON.parse output, so `entries` can be absent in older data.
	const entries = session.entries ?? [];
	acc.messageCount += entries.length;
	foldEntryTimes(acc, entries);
	byKey.set(key, acc);
}

/**
 * Derives the tree-wide per-session rows for one summary — the root's artifacts
 * and every child's, aggregated by `<source>:<sessionId>`.
 *
 * Aggregated rather than keep-first because one session legitimately spans
 * several artifacts (an amend delta plus its base): `messageCount` sums and the
 * bounds span min→max, matching the field's "across all of the session's
 * transcript slices" contract. The result is stamped on the ROOT only — the
 * server merges duplicate rows keep-first, so a copy on a squash child would
 * have it silently truncate both the count and the span.
 *
 * Returns `[]` when nothing is derivable; the caller omits the field entirely
 * rather than sending an empty array, which would read as a measurement of zero
 * conversations and disable the server's bare-transcript-id fallback.
 *
 * `storage` is injected rather than resolved so this stays off git — which is
 * also what keeps its tests in the fast tier.
 */
export async function collectTranscriptSessionMeta(
	summary: CommitSummary,
	cwd?: string,
	storage?: StorageProvider,
): Promise<ReadonlyArray<TranscriptSessionMeta>> {
	const byKey = new Map<string, SessionAccumulator>();
	const seen = new Set<string>();
	for (const id of resolveTranscriptIdsForUsage(summary)) {
		// Required, not an optimisation: the pre-v5 fallback path can list one id
		// twice, which would double-count messageCount.
		if (seen.has(id)) continue;
		seen.add(id);
		try {
			const transcript = await readTranscript(id, cwd, storage);
			if (!transcript) continue;
			for (const session of transcript.sessions ?? []) foldSession(byKey, session);
		} catch (err) {
			// A detached or pruned artifact must not block a push — its sessions are
			// simply absent, which the server reports as unmeasured.
			log.debug("Transcript %s unreadable, skipping: %s", id, errMsg(err));
		}
	}
	return [...byKey.values()].map(toMeta);
}
```

**Note on the fake in the test:** `StorageProvider` has more methods than `readFile`, but `readTranscript` calls only `readFile` and `resolveStorage` short-circuits on an injected provider, so the single-method fake with a cast is honest about the surface exercised rather than a shortcut.

- [ ] **Step 3: Run this task's test file**

From the `cli/` directory:

```bash
npx vitest run --coverage=false src/core/TranscriptSessionMeta.test.ts
```

Expected: 10 passed. Do not run any other test file, the suite, or `npm run all` — see the Global Constraints for why, and for the two forms of this command that fail for reasons unrelated to the code.

- [ ] **Step 4: Commit**

```bash
git add cli/src/core/TranscriptSessionMeta.ts cli/src/core/TranscriptSessionMeta.test.ts
git commit -s -m "feat(cli): derive per-session transcript bounds from a summary tree

Aggregates each conversation's message count and its min/max entry
timestamp across every transcript artifact the tree references, keyed by
source:sessionId. One session legitimately spans several artifacts (an
amend delta plus its base), so the fold sums and spans rather than taking
the first row.

A session with no parseable timestamp emits neither bound: a journey of
unknown length must read as unmeasured, never as an instant one. Reads go
through an injected StorageProvider, which keeps the derivation off git."
```

---

### Task 2: The push-layer type and the size-cap retry

Introduces the type boundary that keeps the enrichment out of storage, and stops the enrichment from being able to cost a summary its whole sidecar.

**Files:**
- Modify: `cli/src/core/JolliMemoryPushOrchestrator.ts` — `serializeSummaryJson` at lines 87–103
- Test: `cli/src/core/JolliMemoryPushOrchestrator.test.ts`

**Interfaces:**
- Consumes: `TranscriptSessionMeta` from `./TranscriptSessionMeta.js` (Task 1).
- Produces:
  - `export type EnrichedPushSummary = CommitSummary & { readonly transcriptSessions?: ReadonlyArray<TranscriptSessionMeta> }`
  - `serializeSummaryJson(summary: EnrichedPushSummary): string | undefined` — signature widened from `CommitSummary`. Every existing caller still type-checks, since `CommitSummary` is assignable to the intersection's optional-extra form.

**Why the retry exists:** the server validates `summaryJson` with `z.string().max(2_000_000)`, so one character over 400s the *whole request* and the markdown article fails with it. That is why the client drops the entire sidecar above `MAX_SUMMARY_JSON_BYTES` (1.5 MB). A session row is ~150 bytes, so the enrichment is ~0.3 % of the cap — but a summary already sitting at 1.499 MB would lose its whole sidecar to it. Retrying without the enrichment makes the worst case equal today's behaviour instead of worse than it.

Do not "fix" the byte-vs-character mismatch: the client measures UTF-8 bytes, the server counts UTF-16 code units, and byte count is always ≥ character count, so the client guard errs on the safe side.

- [ ] **Step 1: Write the failing tests**

Add to `cli/src/core/JolliMemoryPushOrchestrator.test.ts`. Import `serializeSummaryJson` from the module under test if it is not already imported.

```typescript
describe("serializeSummaryJson session enrichment", () => {
	/** A summary whose `recap` alone lands just under the 1.5 MB cap. */
	function summaryOfRecapSize(chars: number): CommitSummary {
		return {
			version: 5,
			commitHash: "b".repeat(40),
			commitMessage: "feat: big",
			commitAuthor: "Dev",
			commitDate: "2026-08-01T10:00:00.000Z",
			branch: "feature/x",
			generatedAt: "2026-08-01T10:05:00.000Z",
			recap: "x".repeat(chars),
		} as CommitSummary;
	}

	it("carries transcriptSessions through when the payload fits", () => {
		const json = serializeSummaryJson({
			...summaryOfRecapSize(10),
			transcriptSessions: [
				{
					sessionId: "s1",
					source: "claude",
					messageCount: 3,
					startedAt: "2026-08-01T09:00:00.000Z",
					endedAt: "2026-08-01T10:10:00.000Z",
				},
			],
		});

		expect(json).toBeDefined();
		expect(JSON.parse(json as string).transcriptSessions).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 3,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			},
		]);
	});

	it("drops only the enrichment when it is what pushes the payload over the cap", () => {
		// 1.5 MB is 1_572_864 bytes; leave under 400 bytes of headroom so a handful
		// of session rows is the difference between fitting and not.
		const base = summaryOfRecapSize(1_572_500);
		const withoutEnrichment = serializeSummaryJson(base);
		expect(withoutEnrichment).toBeDefined();

		const json = serializeSummaryJson({
			...base,
			transcriptSessions: Array.from({ length: 20 }, (_, i) => ({
				sessionId: `session-${i}`,
				source: "claude",
				messageCount: 10,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			})),
		});

		// The sidecar survives; only the enrichment is gone.
		expect(json).toBe(withoutEnrichment);
		expect(JSON.parse(json as string)).not.toHaveProperty("transcriptSessions");
	});

	it("still returns undefined when the payload is oversized without any enrichment", () => {
		expect(serializeSummaryJson(summaryOfRecapSize(2_000_000))).toBeUndefined();
	});
});
```

- [ ] **Step 2: Write the implementation**

Add the type next to `MAX_SUMMARY_JSON_BYTES`:

```typescript
/**
 * A summary as the PUSH path sees it: the stored record plus the push-time
 * session enrichment.
 *
 * The extra field lives here, not on `CommitSummary`, on purpose — the storage
 * path cannot name it, so it cannot persist it. That is what keeps this change
 * clear of the stored-schema lockstep contracts (FolderStorage's hidden layer
 * and the IntelliJ readers over it).
 */
export type EnrichedPushSummary = CommitSummary & {
	readonly transcriptSessions?: ReadonlyArray<TranscriptSessionMeta>;
};
```

Replace the body of `serializeSummaryJson`, keeping its existing docstring and appending the retry paragraph to it:

```typescript
export function serializeSummaryJson(summary: EnrichedPushSummary): string | undefined {
	const {
		jolliDocId: _docId,
		jolliDocUrl: _docUrl,
		orphanedDocIds: _orphaned,
		unresolvedOrphanHashes: _unresolved,
		...content
	} = summary;
	const json = JSON.stringify(content);
	if (Buffer.byteLength(json, "utf-8") <= MAX_SUMMARY_JSON_BYTES) return json;
	// The session enrichment is a push-time extra, so shedding it is strictly
	// better than shedding the whole sidecar — which is what the cap otherwise
	// does. Worst case becomes the pre-enrichment behavior, never worse.
	if (content.transcriptSessions !== undefined) {
		const { transcriptSessions: _sessions, ...withoutSessions } = content;
		const retry = JSON.stringify(withoutSessions);
		if (Buffer.byteLength(retry, "utf-8") <= MAX_SUMMARY_JSON_BYTES) {
			log.warn(
				`Summary JSON for ${summary.commitHash.substring(0, 8)} exceeds ${MAX_SUMMARY_JSON_BYTES} bytes — pushing without session metadata`,
			);
			return retry;
		}
	}
	log.warn(
		`Summary JSON for ${summary.commitHash.substring(0, 8)} exceeds ${MAX_SUMMARY_JSON_BYTES} bytes — pushing markdown only`,
	);
	return;
}
```

Add the import: `import type { TranscriptSessionMeta } from "./TranscriptSessionMeta.js";` — type-only for now. Task 3 adds the value import of `collectTranscriptSessionMeta`. Importing the unused function here would trip Biome's `noUnusedImports: error`.

- [ ] **Step 3: Run this task's test file**

From the `cli/` directory:

```bash
npx vitest run --coverage=false src/core/JolliMemoryPushOrchestrator.test.ts
```

Expected: all pre-existing cases still pass, plus the 3 new `serializeSummaryJson session enrichment` cases. A pre-existing failure here is a signal that widening the signature broke a caller — fix it rather than skipping the case.

- [ ] **Step 4: Commit**

```bash
git add cli/src/core/JolliMemoryPushOrchestrator.ts cli/src/core/JolliMemoryPushOrchestrator.test.ts
git commit -s -m "feat(cli): shed only the session enrichment when the sidecar cap is hit

The server validates summaryJson with z.string().max(2_000_000), so one
character over rejects the whole request and the markdown article fails
with it — which is why the client drops the entire sidecar above its own
1.5MB guard.

A session row is ~150 bytes, so the enrichment is ~0.3% of the cap, but a
summary already sitting just under it would lose its whole sidecar to the
addition. Retrying once without the enrichment makes the worst case equal
the previous behavior instead of worse than it.

EnrichedPushSummary lives in the push layer rather than on CommitSummary
so the storage path cannot name the field, and therefore cannot persist
it."
```

---

### Task 3: Weave the enrichment into both push paths

**Files:**
- Modify: `cli/src/core/JolliMemoryPushOrchestrator.ts` — `pushSummary`'s `summaryForMarkdown` at lines 955–960, and `buildOneBatchItem`'s at lines 604–609
- Test: `cli/src/core/JolliMemoryPushOrchestrator.test.ts`

**Interfaces:**
- Consumes: `collectTranscriptSessionMeta` (Task 1), `EnrichedPushSummary` (Task 2).
- Produces: no new exports. Behavioural change only.

**Why both:** they are two independent blocks of weaving code, and `buildOneBatchItem` is the one the pre-push hook actually runs. A change that only lands in `pushSummary` would pass a naive review and ship nothing on the common path.

**The existing test file mocks `./SummaryStore.js` with an enumerating factory** (`getActiveStorage`, `getSummary`, `storeSummary`, …). `collectTranscriptSessionMeta` imports `readTranscript` from that module, so the mock must gain `readTranscript: vi.fn(async () => null)` or the enrichment path throws `readTranscript is not a function`. Tests that want rows back override it per-case with `vi.mocked(readTranscript).mockResolvedValue({ sessions: [...] })`.

- [ ] **Step 1: Extend the existing `./SummaryStore.js` mock**

In `cli/src/core/JolliMemoryPushOrchestrator.test.ts`, add one entry to the existing factory:

```typescript
vi.mock("./SummaryStore.js", () => ({
	getActiveStorage: vi.fn(),
	getIndexEntryMap: vi.fn(async () => new Map()),
	getSummary: vi.fn(),
	readNoteFromBranch: vi.fn(),
	readPlanFromBranch: vi.fn(),
	// Enrichment path (TranscriptSessionMeta) reads through this. Default: no
	// artifact, so existing cases keep their pre-enrichment payloads.
	readTranscript: vi.fn(async () => null),
	readReferenceFromBranch: vi.fn(),
	storeSummary: vi.fn(),
}));
```

Import it alongside the others so tests can override: add `readTranscript` to the existing `import { … } from "./SummaryStore.js";` list.

- [ ] **Step 2: Write the failing tests**

```typescript
describe("session enrichment on the push paths", () => {
	const ONE_SESSION = {
		sessions: [
			{
				sessionId: "s1",
				source: "claude",
				entries: [
					{ role: "human" as const, content: "a", timestamp: "2026-08-01T09:00:00.000Z" },
					{ role: "assistant" as const, content: "b", timestamp: "2026-08-01T10:10:00.000Z" },
				],
			},
		],
	};

	/** A v5 root that lists one artifact, plus a child that lists none. */
	function summaryWithChild(): CommitSummary {
		return {
			version: 5,
			commitHash: "c".repeat(40),
			commitMessage: "feat: x",
			commitAuthor: "Dev",
			commitDate: "2026-08-01T10:00:00.000Z",
			branch: "feature/x",
			generatedAt: "2026-08-01T10:05:00.000Z",
			transcripts: ["t1"],
			children: [
				{
					version: 5,
					commitHash: "d".repeat(40),
					commitMessage: "wip",
					commitAuthor: "Dev",
					commitDate: "2026-08-01T09:30:00.000Z",
					branch: "feature/x",
					generatedAt: "2026-08-01T09:35:00.000Z",
					transcripts: [],
				},
			],
		} as CommitSummary;
	}

	it("stamps the rows on the root only, never on a child", async () => {
		vi.mocked(readTranscript).mockResolvedValue(ONE_SESSION);

		const built = await buildBatchItems([summaryWithChild()], EMPTY_OWNERSHIP, ctx);
		const pushed = JSON.parse(built[0].item.summary.summaryJson as string);

		expect(pushed.transcriptSessions).toEqual([
			{
				sessionId: "s1",
				source: "claude",
				messageCount: 2,
				startedAt: "2026-08-01T09:00:00.000Z",
				endedAt: "2026-08-01T10:10:00.000Z",
			},
		]);
		// A child copy would activate the server's keep-first merge and truncate.
		expect(pushed.children[0]).not.toHaveProperty("transcriptSessions");
	});

	it("weaves the rows on the single-summary path too", async () => {
		vi.mocked(readTranscript).mockResolvedValue(ONE_SESSION);

		await pushSummary(summaryWithChild(), ctx);

		const payload = vi.mocked(ctx.client.push).mock.calls.at(-1)?.[0] as PushPayload;
		expect(JSON.parse(payload.summaryJson as string).transcriptSessions).toHaveLength(1);
	});

	it("omits the key entirely when no session is derivable", async () => {
		vi.mocked(readTranscript).mockResolvedValue(null);

		const built = await buildBatchItems([summaryWithChild()], EMPTY_OWNERSHIP, ctx);

		// An empty array would read as "measured: zero conversations" and would also
		// disable the server's bare-transcript-id fallback.
		expect(JSON.parse(built[0].item.summary.summaryJson as string)).not.toHaveProperty("transcriptSessions");
	});

	it("never persists the enrichment to the stored summary", async () => {
		vi.mocked(readTranscript).mockResolvedValue(ONE_SESSION);

		await pushSummary(summaryWithChild(), ctx);

		const stored = vi.mocked(storeSummary).mock.calls.at(-1)?.[0] as CommitSummary;
		expect(stored).not.toHaveProperty("transcriptSessions");
	});
});
```

**Adapt to the file's existing harness rather than inventing one.** `EMPTY_OWNERSHIP` and `ctx` above are placeholders for whatever the surrounding tests already build (an `OwnedAttachmentMaps` with three empty `Map`s, and a `PushContext` whose `client` is a mocked `JolliMemoryPushClient`). Reuse the file's existing fixtures and `beforeEach` wiring; do not add a second harness. If the existing `pushSummary` cases rely on `getIndexEntryMap` returning an empty map and `storeSummary` resolving, those defaults already hold.

- [ ] **Step 3: Write the implementation**

In `pushSummary`, immediately before the existing `summaryForMarkdown`:

```typescript
	// Push-time session enrichment. Read from the artifacts this tree references,
	// stamped on the root only (the server merges duplicate rows keep-first), and
	// omitted entirely when empty so absence never reads as a measured zero.
	const transcriptSessions = await collectTranscriptSessionMeta(summary, ctx.cwd, ctx.storage);
	const summaryForMarkdown: EnrichedPushSummary = {
		...summary,
		plans: plansWithUrls,
		...(notesWithUrls !== summary.notes && { notes: notesWithUrls }),
		...(referencesWithUrls !== summary.references && { references: referencesWithUrls }),
		...(transcriptSessions.length > 0 && { transcriptSessions }),
	};
```

In `buildOneBatchItem`, the same two changes on its own `summaryForMarkdown`:

```typescript
	const transcriptSessions = await collectTranscriptSessionMeta(summary, ctx.cwd, ctx.storage);
	const summaryForMarkdown: EnrichedPushSummary = {
		...summary,
		plans: plansWithUrls,
		...(notesWithUrls !== undefined && { notes: notesWithUrls }),
		...(referencesWithUrls !== undefined && { references: referencesWithUrls }),
		...(transcriptSessions.length > 0 && { transcriptSessions }),
	};
```

`buildPushMarkdown` takes a `CommitSummary`; `EnrichedPushSummary` is assignable to it, so that call is unchanged and the markdown output is unaffected (the builder does not read the new field).

`updatedSummary` in `pushSummary` (line ~1014) is built from `...summary`, not from `summaryForMarkdown` — leave it that way. That is what makes the "never persisted" invariant structural rather than a convention.

Change the Task 2 type-only import to a value import now that the function is used:
`import { collectTranscriptSessionMeta, type TranscriptSessionMeta } from "./TranscriptSessionMeta.js";`

- [ ] **Step 4: Run this task's test file**

From the `cli/` directory:

```bash
npx vitest run --coverage=false src/core/JolliMemoryPushOrchestrator.test.ts
```

Expected: every pre-existing case still passes, plus the 4 new `session enrichment on the push paths` cases. If a pre-existing `pushSummary` or `buildBatchItems` case fails with `readTranscript is not a function`, Step 1 was skipped.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/JolliMemoryPushOrchestrator.ts cli/src/core/JolliMemoryPushOrchestrator.test.ts
git commit -s -m "feat(cli): stamp per-session transcript bounds onto the pushed summary

Weaves the derived rows into both push paths — the single-summary one and
the batch one the pre-push hook actually runs. Two independent blocks of
weaving code, so a change landing in only one would pass review and ship
nothing on the common path.

The rows go on the root alone. The server merges duplicate rows keep-first,
so a copy on a squash child would silently truncate both the count and the
span. An empty result omits the field rather than sending an empty array,
which would read as a measurement of zero conversations and would disable
the server's fallback to bare transcript ids.

The write-back copy is still built from the original summary, so the
enrichment cannot reach storage."
```

---

### Task 4: The full gate

The one place the whole chain runs, per the Global Constraints. Tasks 1–3 each committed after running their own test file; this task verifies the change as a whole.

**Files:** none — verification only, plus whatever the gate reveals.

- [ ] **Step 1: Run the full gate**

```bash
npm run all
```

Expect clean → build → typecheck → lint → test to pass, including the CLI coverage floor (97 / 96 / 97 / 97).

Triage by failure shape, not by re-running blindly:
- **`Test timed out in NNNNms`** — a load signal, not a regression. Re-run that file alone with the stock timeout; green in isolation is the proof it was CPU contention. Do not raise any timeout.
- **Assertion or thrown error** — a real failure. Fix it.
- **`readTranscript is not a function`** — Task 3 Step 1 was skipped; the `./SummaryStore.js` mock in `JolliMemoryPushOrchestrator.test.ts` needs the entry.
- **Coverage below floor** — add the missing case; never lower the threshold and never edit `cli/vite.config.ts`.

- [ ] **Step 2: Commit any fixes the gate required**

If the gate was clean, there is nothing to commit — Tasks 1–3 already landed their commits, and the branch is done. If the gate required fixes, commit them:

```bash
git add -u
git commit -s -m "fix(cli): <what the gate caught>"
```

Do not squash or rewrite the Task 1–3 commits. Each is a coherent, separately reviewed step, and the history is the record.

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| §2 D1 push-time derivation | 3 |
| §2 D2 type boundary keeps it out of storage | 2 (type), 3 (structural test) |
| §2 D3 root-stamped, tree-wide | 1 (gathering), 3 (stamping + child test) |
| §2 D4 aggregate: sum / min / max | 1 |
| §2 D5 injected reader, fast-tier tests | 1 |
| §3 emitted shape | 1 |
| §3.1 rule 1 — no bounds without a timestamp | 1 |
| §3.1 rule 2 — empty ⇒ key absent | 3 |
| §3.1 rule 3 — unreadable artifact is skipped | 1 |
| §3.2 size-cap retry | 2 |
| §4 both weave points | 3 |
| §5 invariants 1–9 | 1 (1, 3, 5, 9), 2 (6), 3 (2, 4, 7, 8) |
| §5 gate, coverage floor | 4 |
| §6 not-touched list | Global Constraints |

**Deviations from the spec, both narrowing:** the per-run artifact cache in §4 is realised as a per-call `seen` set (Task 1 explains why a cross-summary cache serves no case that arises), and §5 invariant 9 is covered by the repeated-id test rather than a separate sum assertion, since the dedupe guard is the only thing that can break the equality.

**Type consistency:** `collectTranscriptSessionMeta` and `TranscriptSessionMeta` are spelled identically in Tasks 1, 2 and 3. `EnrichedPushSummary` is defined in Task 2 and consumed in Task 3. `readTranscript(id, cwd, storage)` matches the real signature in `SummaryStore.ts`, whose first parameter is named `commitHash` but is interpolated as an opaque id.
