# Devin CLI Transcript Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Devin CLI a first-class `TranscriptSource` so its sessions are discovered at post-commit, read into transcript entries, and summarized alongside Claude/Codex/Cursor/OpenCode.

**Architecture:** Devin stores sessions in a global WAL-mode SQLite (`~/.local/share/devin/cli/sessions.db`) whose `sessions` table carries a direct `working_directory` column — data-model-identical to OpenCode. We reuse `SqliteHelpers.withSqliteDb` (native `node:sqlite`, WAL-safe, lazy-imported + version-gated). Two new modules — a discoverer (with colocated detection, OpenCode-style) and a transcript reader — plus wiring into the existing post-commit enumeration, the message counter, the active-session aggregator, config, and status. Devin's one novel piece: its `message_nodes` are a **forest**; the canonical conversation is the main chain walked from `sessions.main_chain_id` up the `parent_node_id` pointers.

**Tech Stack:** TypeScript (ESM, Node 22.5+ for `node:sqlite`), Vitest, Biome. VS Code bundle targets Node 18 → all SQLite access stays lazy-imported behind `hasNodeSqliteSupport()`.

## Global Constraints

- **DCO sign-off on the final commit** — `git commit -s`. No `Co-Authored-By: Claude …` / `🤖 Generated with …`. Only `Signed-off-by:`.
- **`npm run all` must pass before commit** (clean → build → lint → test). Run once at the end (Task 7), not per task.
- **CLI coverage floor:** 97% statements / 96% branches / 97% functions / 97% lines for `cli/src/`. New modules need real-fixture tests; use `/* v8 ignore start/stop */` blocks (single-line `ignore next` does NOT work here) for genuinely-unreachable TOCTOU branches, mirroring the OpenCode/Cursor discoverers.
- **External-parser fixtures MUST be real.** Snapshot an actual Devin `message_nodes` forest from a live DB (Task 2/3). Never hand-author the JSON shape from imagination.
- **Path normalization** via `toForwardSlash` / `normalizePathForCompare` — never inline `.replace(/\\/g, "/")`.
- **Batching policy (overrides the skill's per-task commit/run):** each task contains only failing-test + implementation. TDD red/green uses a **single-file** `vitest run <file>` (fast). The full `npm run all` and the single `git commit -s` happen once in Task 7.
- **Config default:** `devinEnabled` gates discovery with `!== false` semantics (on by default when Devin is detected), matching every other source.

## Observed Reality (verified on a live install — see spec)

- DB: `~/.local/share/devin/cli/sessions.db`, `journal_mode=wal` (609 KB in `.db-wal`, unread by sql.js — we use `node:sqlite`).
- `sessions(id TEXT pk, working_directory TEXT, title TEXT, main_chain_id INTEGER, last_activity_at INTEGER /* epoch SECONDS */, hidden INTEGER)`.
- `message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER /* NULL=root */, chat_message TEXT /* JSON */, created_at INTEGER, UNIQUE(session_id,node_id))`.
- `chat_message` JSON: `{ message_id, role: "system"|"user"|"assistant"|"tool", content: string, metadata: { created_at: ISO8601, is_user_input } }`.
- Forest: siblings under one `parent_node_id` are discarded regenerations; walk `main_chain_id → parent → root`, reverse.
- **`last_activity_at` is epoch SECONDS** (OpenCode is ms) → multiply by 1000 for `Date`.

## File Structure

- **Create** `cli/src/core/DevinSessionDiscoverer.ts` — `getDevinSessionsDbPath`, `isDevinInstalled`, `scanDevinSessions`, `discoverDevinSessions`. (Detection colocated, OpenCode-style — deviates from the spec's separate `DevinDetector.ts` to match the closest data-model analogue and avoid file sprawl.)
- **Create** `cli/src/core/DevinTranscriptReader.ts` — `readDevinTranscript` + main-chain reconstruction + role mapping.
- **Create** `cli/src/core/DevinSessionDiscoverer.test.ts`, `cli/src/core/DevinTranscriptReader.test.ts`.
- **Create** `cli/src/core/__fixtures__/devin-sessions.db` (or a helper that builds it) — real snapshot.
- **Modify** `cli/src/Types.ts` — `TRANSCRIPT_SOURCES`, `JolliMemoryConfig.devinEnabled`, status `devinDetected`.
- **Modify** `cli/src/core/TranscriptSourceLabel.ts` — `devin: "Devin"`.
- **Modify** `cli/src/core/TranscriptLoader.ts` — `devin` dispatch.
- **Modify** `cli/src/core/TranscriptMessageCounter.ts` — `case "devin"`.
- **Modify** `cli/src/core/SessionTracker.ts` — filter branch.
- **Modify** `cli/src/core/ActiveSessionAggregator.ts` — `loadDevin` + fan-out entry.
- **Modify** `cli/src/hooks/QueueWorker.ts` — enumeration block + imports.
- **Modify** `cli/src/commands/ConfigureCommand.ts` — key list + validation + descriptor.
- **Modify** `cli/src/commands/StatusCommand.ts` — status item.

Explicitly NOT touched (scope-confirmed): no `McpHostRegistrar`, no `SkillInstaller`, no `Installer`/`DispatchScripts`/dist-path (Devin has no agent hook), no references subsystem (`tool_call_state` unread), no telemetry list edits (`UserProfile`/`TelemetryDoc` read `s.source` dynamically — no hardcoded source list to extend).

---

### Task 1: Register the `devin` source in the type system

**Files:**
- Modify: `cli/src/Types.ts` (`TRANSCRIPT_SOURCES` ~line 17; `JolliMemoryConfig` ~line 1088; status interface ~line 1330)
- Modify: `cli/src/core/TranscriptSourceLabel.ts` (`TRANSCRIPT_SOURCE_LABELS`)

**Interfaces:**
- Produces: `TranscriptSource` union now includes `"devin"`; `config.devinEnabled?: boolean`; status `devinDetected?: boolean`; `transcriptSourceLabel("devin") === "Devin"`.

Adding `"devin"` to the `TRANSCRIPT_SOURCES` tuple makes `TRANSCRIPT_SOURCE_LABELS` (a `Record<TranscriptSource, string>`) a **compile error** until the label entry is added — that is the intended forcing function.

- [ ] **Step 1: Write the failing test**

Append to `cli/src/core/TranscriptSourceLabel.test.ts` (create if absent, mirroring existing label tests):

```typescript
import { describe, expect, it } from "vitest";
import { isTranscriptSource } from "../Types.js";
import { transcriptSourceLabel } from "./TranscriptSourceLabel.js";

describe("devin source registration", () => {
	it("is a recognized TranscriptSource", () => {
		expect(isTranscriptSource("devin")).toBe(true);
	});
	it("renders the friendly label", () => {
		expect(transcriptSourceLabel("devin")).toBe("Devin");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/TranscriptSourceLabel.test.ts`
Expected: FAIL — `isTranscriptSource("devin")` is `false` and/or a TS compile error on the `Record` missing `devin`.

- [ ] **Step 3: Add `"devin"` to the source tuple**

In `cli/src/Types.ts`, extend the tuple:

```typescript
export const TRANSCRIPT_SOURCES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"cursor",
	"copilot",
	"copilot-chat",
	"devin",
] as const;
```

- [ ] **Step 4: Add the label entry**

In `cli/src/core/TranscriptSourceLabel.ts`, add to `TRANSCRIPT_SOURCE_LABELS`:

```typescript
	opencode: "OpenCode",
	devin: "Devin",
};
```

- [ ] **Step 5: Add the config + status fields**

In `cli/src/Types.ts` `JolliMemoryConfig`, next to `copilotEnabled` (~line 1088):

```typescript
	readonly copilotEnabled?: boolean;
	/** Enable Devin CLI session discovery. Defaults to on when Devin is detected. */
	readonly devinEnabled?: boolean;
```

In the status interface, next to `copilotDetected` (~line 1330):

```typescript
	/** Whether Devin CLI's session DB (~/.local/share/devin/cli/sessions.db) was detected */
	readonly devinDetected?: boolean;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/TranscriptSourceLabel.test.ts`
Expected: PASS.

---

### Task 2: `DevinSessionDiscoverer.ts` — detection + session discovery

**Files:**
- Create: `cli/src/core/DevinSessionDiscoverer.ts`
- Create: `cli/src/core/DevinSessionDiscoverer.test.ts`

**Interfaces:**
- Consumes: `withSqliteDb`, `classifyScanError`, `SqliteScanError`, `hasNodeSqliteSupport` from `./SqliteHelpers.js`; `SessionInfo` from `../Types.js`.
- Produces:
  - `getDevinSessionsDbPath(home?: string): string`
  - `isDevinInstalled(): Promise<boolean>`
  - `interface DevinScanResult { readonly sessions: ReadonlyArray<SessionInfo>; readonly error?: SqliteScanError }`
  - `scanDevinSessions(projectDir: string): Promise<DevinScanResult>`
  - `discoverDevinSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>>`
  - Synthetic transcript path: `"<dbPath>#<sessionId>"`.

- [ ] **Step 1: Snapshot a real fixture DB**

Build a real SQLite fixture from the live install (do NOT hand-author rows). Run this once to materialize `cli/src/core/__fixtures__/devin-sessions.db`:

```bash
mkdir -p cli/src/core/__fixtures__
# Copy real schema + one real session's rows out of the live WAL DB into a standalone file.
sqlite3 "$HOME/.local/share/devin/cli/sessions.db" ".dump sessions message_nodes" \
  | sqlite3 cli/src/core/__fixtures__/devin-sessions.db
# Verify it opens and has the forest + main chain:
sqlite3 cli/src/core/__fixtures__/devin-sessions.db \
  "SELECT id, working_directory, main_chain_id FROM sessions; SELECT COUNT(*) FROM message_nodes;"
```

Record the fixture's real `id`, `working_directory`, and `main_chain_id` — the tests below key off them. Replace `WORKDIR_FROM_FIXTURE` / `SESSION_ID_FROM_FIXTURE` placeholders in the test with those literal values.

- [ ] **Step 2: Write the failing test**

Create `cli/src/core/DevinSessionDiscoverer.test.ts`:

```typescript
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverDevinSessions, getDevinSessionsDbPath, scanDevinSessions } from "./DevinSessionDiscoverer.js";

const FIXTURE_DIR = join(__dirname, "__fixtures__");

describe("getDevinSessionsDbPath", () => {
	it("resolves under XDG data home", () => {
		expect(getDevinSessionsDbPath("/home/u")).toBe("/home/u/.local/share/devin/cli/sessions.db");
	});
});

describe("scanDevinSessions", () => {
	it("returns empty (no error) when the DB is missing", async () => {
		const r = await scanDevinSessions("/no/such/project");
		expect(r.sessions).toEqual([]);
		expect(r.error).toBeUndefined();
	});
});
```

> The discoverer reads a fixed absolute path (`getDevinSessionsDbPath()`), so full end-to-end discovery against the fixture is covered by injecting the fixture path. Add a second test that calls an internal `scanDevinSessionsAt(dbPath, projectDir)` helper (export it) so the fixture DB can be targeted directly:

```typescript
describe("scanDevinSessionsAt (fixture)", () => {
	const dbPath = join(FIXTURE_DIR, "devin-sessions.db");
	it("discovers the session matching its working_directory", async () => {
		const { scanDevinSessionsAt } = await import("./DevinSessionDiscoverer.js");
		const r = await scanDevinSessionsAt(dbPath, "WORKDIR_FROM_FIXTURE");
		expect(r.error).toBeUndefined();
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({
			sessionId: "SESSION_ID_FROM_FIXTURE",
			source: "devin",
			transcriptPath: `${dbPath}#SESSION_ID_FROM_FIXTURE`,
		});
	});
	it("returns no sessions for an unrelated directory", async () => {
		const { scanDevinSessionsAt } = await import("./DevinSessionDiscoverer.js");
		const r = await scanDevinSessionsAt(dbPath, "/somewhere/else");
		expect(r.sessions).toEqual([]);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/DevinSessionDiscoverer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `DevinSessionDiscoverer.ts`**

```typescript
/**
 * Devin CLI Session Discoverer (+ colocated detection)
 *
 * Devin stores every CLI session in a global WAL-mode SQLite at
 *   <XDG_DATA_HOME|~/.local/share>/devin/cli/sessions.db
 * The `sessions` table carries a direct `working_directory` column, so sessions
 * are scoped to a project the same way OpenCode's `directory` column is —
 * no workspace-hash indirection. `last_activity_at` is epoch SECONDS.
 *
 * Synthetic transcript path: "<dbPath>#<sessionId>" (matches OpenCode/Cursor).
 */

import { stat } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { classifyScanError, hasNodeSqliteSupport, type SqliteScanError, withSqliteDb } from "./SqliteHelpers.js";

const log = createLogger("DevinDiscoverer");

/** Sessions older than 48 hours are considered stale (matches other sources). */
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

function getXdgDataHome(home?: string): string {
	const base = home ?? process.env.HOME ?? "";
	const xdg = process.env.XDG_DATA_HOME;
	return xdg && xdg.length > 0 ? xdg : join(base, ".local", "share");
}

/** Absolute path to Devin CLI's global session database. */
export function getDevinSessionsDbPath(home?: string): string {
	return join(getXdgDataHome(home), "devin", "cli", "sessions.db");
}

/**
 * Devin is "installed" when its session DB exists AND the runtime can read
 * SQLite. Gated on hasNodeSqliteSupport() so Node 18 VS Code hosts report
 * "not installed" rather than "detected but 0 sessions".
 */
export async function isDevinInstalled(): Promise<boolean> {
	if (!hasNodeSqliteSupport()) {
		log.info(
			"Devin support disabled: this runtime is Node %s, requires 22.5+ for built-in SQLite",
			process.versions.node,
		);
		return false;
	}
	try {
		return (await stat(getDevinSessionsDbPath())).isFile();
	} catch {
		return false;
	}
}

export interface DevinScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	/** Present only on a genuine failure (not a missing DB). Surface to UI rather than reporting "0 sessions". */
	readonly error?: SqliteScanError;
}

/** Discover Devin sessions for the given project directory (production entrypoint). */
export async function scanDevinSessions(projectDir: string): Promise<DevinScanResult> {
	return scanDevinSessionsAt(getDevinSessionsDbPath(), projectDir);
}

/**
 * Discover Devin sessions from an explicit DB path. Split out so tests can point
 * at a fixture DB; production callers use `scanDevinSessions`.
 */
export async function scanDevinSessionsAt(dbPath: string, projectDir: string): Promise<DevinScanResult> {
	const cutoffMs = Date.now() - SESSION_STALE_MS;

	// Pre-flight: "DB missing" (silent) vs "DB unreadable" (genuine failure).
	try {
		await stat(dbPath);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		/* v8 ignore start -- ENOENT covered by the "DB missing" test; other codes (EACCES/EPERM/EIO) need a filesystem mock. classifyScanError is unit-tested separately. */
		if (code !== "ENOENT") {
			const scanError = classifyScanError(error);
			if (scanError) {
				log.error("Devin DB stat failed (%s): %s", scanError.kind, scanError.message);
				return { sessions: [], error: scanError };
			}
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.debug("Devin DB not present at %s — treating as not installed", dbPath);
		return { sessions: [] };
	}

	try {
		const sessions = await withSqliteDb(dbPath, (db) => {
			// last_activity_at is epoch SECONDS → compare against cutoff in seconds.
			const cutoffSec = Math.floor(cutoffMs / 1000);
			const os = platform();
			const caseInsensitive = os === "win32" || os === "darwin";
			const dirMatch = caseInsensitive
				? "LOWER(working_directory) = LOWER(:projectDir)"
				: "working_directory = :projectDir";

			const rows = db
				.prepare(
					`SELECT id, title, last_activity_at
					 FROM sessions
					 WHERE ${dirMatch}
					   AND hidden = 0
					   AND last_activity_at > :cutoff
					 ORDER BY last_activity_at DESC`,
				)
				.all({ projectDir, cutoff: cutoffSec }) as ReadonlyArray<{
				id: string;
				title: string | null;
				last_activity_at: number;
			}>;

			return rows.flatMap((row): SessionInfo[] => {
				if (!Number.isFinite(row.last_activity_at)) {
					log.warn("Skipping Devin session %s: non-finite last_activity_at", row.id);
					return [];
				}
				return [
					{
						sessionId: String(row.id),
						transcriptPath: `${dbPath}#${row.id}`,
						updatedAt: new Date(row.last_activity_at * 1000).toISOString(),
						source: "devin",
						title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : undefined,
					},
				];
			});
		});

		log.debug("Discovered %d Devin session(s) for %s", sessions.length, projectDir);
		return { sessions };
	} catch (error: unknown) {
		const scanError = classifyScanError(error);
		/* v8 ignore start -- TOCTOU: DB passed stat() but vanished before open. classifyScanError covered by its own unit tests. */
		if (scanError === null) {
			log.debug("Devin DB disappeared between detection and scan: %s", (error as Error).message);
			return { sessions: [] };
		}
		/* v8 ignore stop */
		log.error("Devin scan failed (%s): %s", scanError.kind, scanError.message);
		return { sessions: [], error: scanError };
	}
}

/** Backwards-compatible wrapper returning only the session array. */
export async function discoverDevinSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions } = await scanDevinSessions(projectDir);
	return sessions;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/DevinSessionDiscoverer.test.ts`
Expected: PASS (all cases, including the fixture-backed discovery).

---

### Task 3: `DevinTranscriptReader.ts` — main-chain reconstruction + role mapping

**Files:**
- Create: `cli/src/core/DevinTranscriptReader.ts`
- Create: `cli/src/core/DevinTranscriptReader.test.ts`

**Interfaces:**
- Consumes: `withSqliteDb` from `./SqliteHelpers.js`; `mergeConsecutiveEntries` from `./TranscriptReader.js`; `TranscriptCursor`, `TranscriptEntry`, `TranscriptReadResult` from `../Types.js`.
- Produces: `readDevinTranscript(transcriptPath: string, cursor?: TranscriptCursor | null, beforeTimestamp?: string): Promise<TranscriptReadResult>`.

Role mapping (confirmed): `user → human`, `assistant → assistant`, `system`/`tool` → dropped, empty `content` → skipped. Main chain: from `sessions.main_chain_id`, walk `parent_node_id` to root (cycle-guarded via a `visited` set; stop on a broken link), then reverse. `main_chain_id` NULL → fall back to the node with the greatest `node_id`.

- [ ] **Step 1: Write the failing test (real fixture)**

Create `cli/src/core/DevinTranscriptReader.test.ts`, keyed off the same fixture DB from Task 2:

```typescript
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDevinTranscript } from "./DevinTranscriptReader.js";

const dbPath = join(__dirname, "__fixtures__", "devin-sessions.db");
const transcriptPath = `${dbPath}#SESSION_ID_FROM_FIXTURE`;

describe("readDevinTranscript", () => {
	it("reconstructs the main chain, keeping only human/assistant with content", async () => {
		const { entries } = await readDevinTranscript(transcriptPath);
		// Fixture's real conversation: user asks, assistant answers.
		expect(entries.length).toBeGreaterThanOrEqual(2);
		expect(entries.every((e) => e.role === "human" || e.role === "assistant")).toBe(true);
		expect(entries.every((e) => e.content.trim().length > 0)).toBe(true);
		expect(entries[0]).toMatchObject({ role: "human" });
		expect(entries.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("returns an advancing cursor", async () => {
		const { newCursor } = await readDevinTranscript(transcriptPath);
		expect(newCursor.transcriptPath).toBe(transcriptPath);
		expect(newCursor.lineNumber).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/DevinTranscriptReader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DevinTranscriptReader.ts`**

```typescript
/**
 * Devin CLI Transcript Reader
 *
 * Reads one Devin session (identified by a "<dbPath>#<sessionId>" synthetic
 * path) out of the global sessions.db and returns the canonical conversation.
 *
 * Devin's `message_nodes` form a FOREST: alternate regenerations appear as
 * sibling nodes under one parent. The canonical thread is the "main chain",
 * walked from `sessions.main_chain_id` up the `parent_node_id` pointers to a
 * root, then reversed. Each `chat_message` is JSON:
 *   { role: "system"|"user"|"assistant"|"tool", content: string, metadata: { created_at } }
 * Role mapping: user→human, assistant→assistant, system/tool dropped, empty→skipped.
 */

import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { withSqliteDb } from "./SqliteHelpers.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("DevinReader");

interface NodeRow {
	readonly node_id: number;
	readonly parent_node_id: number | null;
	readonly chat_message: string;
}

interface ChatMessage {
	readonly role?: string;
	readonly content?: unknown;
	readonly metadata?: { readonly created_at?: unknown } | null;
}

const ROLE_MAP: Readonly<Record<string, "human" | "assistant">> = {
	user: "human",
	assistant: "assistant",
};

/** Split "<dbPath>#<sessionId>" into its parts. */
function parseSyntheticPath(transcriptPath: string): { dbPath: string; sessionId: string } {
	const hash = transcriptPath.lastIndexOf("#");
	if (hash < 0) {
		throw new Error(`Malformed Devin transcript path (no '#'): ${transcriptPath}`);
	}
	return { dbPath: transcriptPath.slice(0, hash), sessionId: transcriptPath.slice(hash + 1) };
}

/**
 * Walk from the tip node up parent pointers to a root, then reverse to
 * chronological order. Cycle-guarded; stops on a dangling parent.
 */
function buildMainChain(byId: Map<number, NodeRow>, tip: number | null): NodeRow[] {
	const chain: NodeRow[] = [];
	const visited = new Set<number>();
	let cur: number | null = tip;
	while (cur !== null && byId.has(cur) && !visited.has(cur)) {
		visited.add(cur);
		const node = byId.get(cur) as NodeRow;
		chain.push(node);
		cur = node.parent_node_id;
	}
	chain.reverse();
	return chain;
}

export async function readDevinTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	const { dbPath, sessionId } = parseSyntheticPath(transcriptPath);
	const startIndex = cursor?.lineNumber ?? 0;
	const cutoffTime = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	try {
		const { rawEntries, totalNodes, lastConsumedIndex } = await withSqliteDb(dbPath, (db) => {
			const sessionRow = db
				.prepare("SELECT main_chain_id FROM sessions WHERE id = ? LIMIT 1")
				.get(sessionId) as { main_chain_id: number | null } | undefined;
			if (!sessionRow) {
				throw new Error(`Devin session ${sessionId} not found`);
			}

			const nodeRows = db
				.prepare("SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ?")
				.all(sessionId) as ReadonlyArray<NodeRow>;
			const byId = new Map<number, NodeRow>(nodeRows.map((r) => [r.node_id, r]));

			// main_chain_id NULL → fall back to the greatest node_id as the tip.
			let tip = sessionRow.main_chain_id;
			if (tip === null || !byId.has(tip)) {
				tip = nodeRows.reduce<number | null>((max, r) => (max === null || r.node_id > max ? r.node_id : max), null);
			}

			const chain = buildMainChain(byId, tip);
			const newNodes = chain.slice(startIndex);
			const rawEntries: TranscriptEntry[] = [];
			let lastConsumedIndex = startIndex;

			for (let i = 0; i < newNodes.length; i++) {
				const node = newNodes[i];
				let msg: ChatMessage;
				try {
					msg = JSON.parse(node.chat_message) as ChatMessage;
				} catch {
					log.debug("Skipping Devin node %d: invalid chat_message JSON", node.node_id);
					lastConsumedIndex = startIndex + i + 1;
					continue;
				}

				const timestamp = typeof msg.metadata?.created_at === "string" ? msg.metadata.created_at : undefined;
				if (cutoffTime !== undefined && timestamp !== undefined) {
					const t = Date.parse(timestamp);
					if (Number.isFinite(t) && t > cutoffTime) {
						break;
					}
				}

				const role = typeof msg.role === "string" ? ROLE_MAP[msg.role] : undefined;
				const content = typeof msg.content === "string" ? msg.content.trim() : "";
				if (role !== undefined && content.length > 0) {
					rawEntries.push({ role, content, timestamp });
				}
				lastConsumedIndex = startIndex + i + 1;
			}

			return { rawEntries, totalNodes: chain.length, lastConsumedIndex };
		});

		const entries = mergeConsecutiveEntries(rawEntries);
		const newCursor: TranscriptCursor = {
			transcriptPath,
			lineNumber: beforeTimestamp ? lastConsumedIndex : totalNodes,
			updatedAt: new Date().toISOString(),
		};
		const totalLinesRead = lastConsumedIndex - startIndex;
		log.info(
			"Read Devin session %s: %d new nodes, %d entries (index %d→%d)",
			sessionId,
			totalLinesRead,
			entries.length,
			startIndex,
			newCursor.lineNumber,
		);
		return { entries, newCursor, totalLinesRead };
	} catch (error: unknown) {
		log.error("Failed to read Devin session %s: %s", sessionId, (error as Error).message);
		throw new Error(`Cannot read Devin session: ${sessionId}`);
	}
}
```

- [ ] **Step 4: Add coverage for the null-tip fallback and broken-link guard**

Add to `DevinTranscriptReader.test.ts` (these exercise the defensive branches for the coverage floor). If the fixture's session has a non-null `main_chain_id`, add a tiny second fixture row set OR assert via a session whose tip is missing. Minimal approach — build an in-memory-style temp DB in the test using `node:sqlite` directly to insert a NULL-`main_chain_id` session with two linked nodes:

```typescript
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

it("falls back to the greatest node_id when main_chain_id is NULL", async () => {
	const dir = mkdtempSync(join(tmpdir(), "devin-"));
	const p = join(dir, "s.db");
	const db = new DatabaseSync(p);
	db.exec(
		"CREATE TABLE sessions(id TEXT, main_chain_id INTEGER); CREATE TABLE message_nodes(session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT);",
	);
	db.prepare("INSERT INTO sessions VALUES('s', NULL)").run();
	const mk = (role: string, content: string) => JSON.stringify({ role, content, metadata: { created_at: "2026-07-18T00:00:00Z" } });
	db.prepare("INSERT INTO message_nodes VALUES('s',1,NULL,?)").run(mk("user", "hi"));
	db.prepare("INSERT INTO message_nodes VALUES('s',2,1,?)").run(mk("assistant", "hello"));
	db.close();
	const { entries } = await readDevinTranscript(`${p}#s`);
	expect(entries).toEqual([
		{ role: "human", content: "hi", timestamp: "2026-07-18T00:00:00Z" },
		{ role: "assistant", content: "hello", timestamp: "2026-07-18T00:00:00Z" },
	]);
	rmSync(dir, { recursive: true, force: true });
});

it("throws a wrapped error for an unknown session", async () => {
	await expect(readDevinTranscript(`${dbPath}#does-not-exist`)).rejects.toThrow("Cannot read Devin session");
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/core/DevinTranscriptReader.test.ts`
Expected: PASS.

---

### Task 4: Wire Devin into the post-commit + active-session pipelines

**Files:**
- Modify: `cli/src/core/TranscriptLoader.ts` (single-artifact dispatch)
- Modify: `cli/src/core/TranscriptMessageCounter.ts` (`switch (source)` ~line 122)
- Modify: `cli/src/core/SessionTracker.ts` (`filterSessionsByEnabledIntegrations`)
- Modify: `cli/src/core/ActiveSessionAggregator.ts` (`loadDevin` + fan-out ~line 218)
- Modify: `cli/src/hooks/QueueWorker.ts` (imports + enumeration block ~line 3178)

**Interfaces:**
- Consumes: `discoverDevinSessions`, `isDevinInstalled`, `scanDevinSessions` (Task 2); `readDevinTranscript` (Task 3).
- Produces: Devin sessions flow into summary generation, message counting, integration filtering, and the live active-conversation list.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/core/SessionTracker.test.ts` (filter behavior — deterministic, no SQLite):

```typescript
it("filterSessionsByEnabledIntegrations drops devin when devinEnabled is false", () => {
	const sessions = [
		{ sessionId: "a", transcriptPath: "x#a", updatedAt: "2026-07-18T00:00:00Z", source: "devin" as const },
		{ sessionId: "b", transcriptPath: "y#b", updatedAt: "2026-07-18T00:00:00Z", source: "codex" as const },
	];
	const out = filterSessionsByEnabledIntegrations(sessions, { devinEnabled: false });
	expect(out.map((s) => s.source)).toEqual(["codex"]);
});
```

(Ensure `filterSessionsByEnabledIntegrations` and any needed types are imported at the top of the test file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t "drops devin"`
Expected: FAIL — devin still present (no filter branch yet).

- [ ] **Step 3: Add the SessionTracker filter branch**

In `cli/src/core/SessionTracker.ts` `filterSessionsByEnabledIntegrations`, after the `copilotEnabled` branch:

```typescript
	if (config.copilotEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "copilot" && s.source !== "copilot-chat");
	}
	if (config.devinEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "devin");
	}
	return filtered;
```

- [ ] **Step 4: Add the TranscriptLoader dispatch**

In `cli/src/core/TranscriptLoader.ts`, add a branch alongside the other single-artifact readers (after the `cursor`/`copilot` blocks):

```typescript
	if (opts.source === "devin") {
		try {
			const { readDevinTranscript } = await import("./DevinTranscriptReader.js");
			const result = await readDevinTranscript(opts.transcriptPath);
			return [...result.entries];
		} catch (err) {
			if (!isEnoent(err)) {
				log.warn("loadTranscript (devin) failed for %s: %s", opts.transcriptPath, errMsg(err));
			}
			return [];
		}
	}
```

- [ ] **Step 5: Add the TranscriptMessageCounter case**

At the top of `cli/src/core/TranscriptMessageCounter.ts`, import the reader (mirror how `readCursorTranscript` is imported). Then in the `switch (source)` (~line 122):

```typescript
		case "cursor":
			return readCursorTranscript(transcriptPath, cursor);
		case "devin":
			return readDevinTranscript(transcriptPath, cursor);
```

- [ ] **Step 6: Add the ActiveSessionAggregator loader + fan-out**

In `cli/src/core/ActiveSessionAggregator.ts`, add a loader mirroring `loadOpenCode` (Devin's `scanDevinSessions` returns the same `{ sessions, error? }` envelope):

```typescript
async function loadDevin(cwd: string): Promise<LoaderResult> {
	try {
		const { scanDevinSessions } = await import("./DevinSessionDiscoverer.js");
		const r = await scanDevinSessions(cwd);
		if (r.error) {
			log.warn("scanDevinSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["devin"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanDevinSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["devin"] };
	}
}
```

Add it to the `Promise.all([...])` fan-out in `collectFromAllSources` (~line 218):

```typescript
	const batches = await Promise.all([
		loadClaudeAndGemini(cwd),
		loadCursor(cwd),
		loadCodex(cwd),
		loadOpenCode(cwd),
		loadCopilot(cwd),
		loadCopilotChat(cwd),
		loadDevin(cwd),
	]);
```

- [ ] **Step 7: Add the QueueWorker enumeration block**

In `cli/src/hooks/QueueWorker.ts`, add the import near the other discoverer imports (~line 40):

```typescript
import { discoverDevinSessions, isDevinInstalled } from "../core/DevinSessionDiscoverer.js";
```

Then, after the Copilot Chat block (~line 3200), add:

```typescript
	// Discover Devin CLI sessions (on-demand SQLite scan of the global sessions.db).
	if (config.devinEnabled !== false && (await isDevinInstalled())) {
		const devinSessions = await discoverDevinSessions(cwd);
		if (devinSessions.length > 0) {
			allSessions = [...allSessions, ...devinSessions];
			log.info("Discovered %d Devin session(s)", devinSessions.length);
		}
	}
```

- [ ] **Step 8: Run the wiring test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/core/SessionTracker.test.ts -t "drops devin"`
Expected: PASS. (QueueWorker/TranscriptLoader/counter/aggregator changes are exercised by the full suite in Task 7; if `QueueWorker.test.ts` mocks discoverers explicitly, add a `discoverDevinSessions`/`isDevinInstalled` mock mirroring the existing OpenCode mocks so the block is covered.)

---

### Task 5: Surface the Devin toggle in `configure` and `status`

**Files:**
- Modify: `cli/src/commands/ConfigureCommand.ts` (key list ~54, validation ~129, descriptor ~204)
- Modify: `cli/src/commands/StatusCommand.ts` (status item ~370)

**Interfaces:**
- Consumes: `config.devinEnabled`, status `devinDetected` (Task 1).
- Produces: `jolli configure --set devinEnabled false` works; `jolli status` shows a Devin line.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/commands/ConfigureCommand.test.ts` (mirror an existing `openCodeEnabled` set test):

```typescript
it("accepts devinEnabled as a boolean key", async () => {
	const result = await runConfigureSet("devinEnabled", "false");
	expect(result.ok).toBe(true);
	expect(result.config.devinEnabled).toBe(false);
});
```

(Adapt to the file's actual harness — reuse whatever helper the `openCodeEnabled`/`cursorEnabled` tests already use.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/ConfigureCommand.test.ts -t "devinEnabled"`
Expected: FAIL — key rejected as unknown.

- [ ] **Step 3: Register the config key**

In `cli/src/commands/ConfigureCommand.ts`:

Key list (~line 59):
```typescript
	"copilotEnabled",
	"devinEnabled",
```

Validation branch (~line 134):
```typescript
		key === "copilotEnabled" ||
		key === "devinEnabled" ||
```

Descriptor list (~line 218, after the copilot descriptor):
```typescript
	{
		key: "devinEnabled",
		type: "boolean",
		description: "Enable Devin CLI session discovery (true/false; requires Node 22.5+ at runtime)",
	},
```

- [ ] **Step 4: Add the status line**

In `cli/src/commands/StatusCommand.ts`, mirror the Cursor status item (~line 370):

```typescript
					"Devin:",
					{
						enabled: status.devinEnabled !== false,
						detected: status.devinDetected === true,
						// …match the exact shape the neighboring items use (hook/unavailable fields as applicable)
					},
```

Populate `status.devinDetected` wherever the sibling `*Detected` flags are computed (search for `cursorDetected:` in the status-building path and add `devinDetected: await isDevinInstalled()` alongside it).

- [ ] **Step 5: Run it to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/commands/ConfigureCommand.test.ts -t "devinEnabled"`
Expected: PASS.

---

### Task 6: Documentation touch-up

**Files:**
- Modify: `CLAUDE.md` (the "Two-layer hook model" paragraph listing hookless sources)

**Interfaces:** none.

- [ ] **Step 1: Update the source inventory sentence**

In `CLAUDE.md`, the sentence enumerating hookless post-commit sources ("Codex, OpenCode, Cursor (Composer), GitHub Copilot CLI, and VS Code Copilot Chat have **no hook**…") — add Devin CLI to that list and note it is a SQLite-backed source read via the same `node:sqlite` lazy-import pattern. Keep it one clause; no internal governance detail.

---

### Task 7: Full verification + single commit

**Files:** none (verification + commit only).

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS, including the CLI 97%/96%/97%/97% coverage floor. If coverage dips on the new modules, add targeted tests (not `v8 ignore`) for reachable branches; reserve `/* v8 ignore start/stop */` for the TOCTOU/`ENOENT`-only branches already marked.

- [ ] **Step 2: Verify against real data (end-to-end)**

Run the built CLI's discovery path against the live Devin DB to confirm a real session is found and summarized-ready (mirror how you'd smoke-test any source):

```bash
npm run cli -- status   # Devin line shows detected
# Optionally exercise discovery directly via a one-off tsx script calling discoverDevinSessions(process.cwd())
```

Expected: Devin reported as detected; discovery returns the live session when run from its `working_directory`.

- [ ] **Step 3: Commit (single, DCO-signed)**

```bash
git add -A
git commit -s -m "Add Devin CLI as a transcript source"
```

Expected: commit created with a `Signed-off-by:` trailer and no AI co-author trailer.

---

## Self-Review

- **Spec coverage:** Detector+Discoverer (Task 2), Reader with forest/main-chain + role mapping + cursor (Task 3), TranscriptLoader/QueueWorker/SessionTracker/counter/aggregator wiring (Task 4), config+status (Task 5), Types+label (Task 1), tests with real fixtures (Tasks 2–3), docs (Task 6), full gate (Task 7). Spec's `UserProfile`/`TelemetryDoc` line was dropped after verifying they read `s.source` dynamically (no hardcoded list) — noted in File Structure.
- **Deviation from spec:** detection colocated into `DevinSessionDiscoverer.ts` (OpenCode pattern) instead of a separate `DevinDetector.ts` — flagged in File Structure and Task 2.
- **Type consistency:** `scanDevinSessions`/`scanDevinSessionsAt`/`discoverDevinSessions`/`isDevinInstalled`/`getDevinSessionsDbPath` and `readDevinTranscript(path, cursor?, beforeTimestamp?)` are used verbatim across Tasks 2–5. `DevinScanResult { sessions, error? }` matches `LoaderResult` consumption in Task 4.
- **`last_activity_at` seconds→ms** (`* 1000`) handled in Task 2; called out in Global Constraints/Observed Reality.
