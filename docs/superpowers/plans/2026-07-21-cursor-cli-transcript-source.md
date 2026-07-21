# Cursor CLI (cursor-agent) Transcript Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cursor-agent` (Cursor CLI) as a first-class hookless transcript source, distinct from the existing Cursor IDE (`cursor`) source.

**Architecture:** A detector+discoverer+reader triplet under `cli/src/core/`, reading **pure JSON** — never SQLite. Discovery reads `~/.cursor/chats/<md5(cwd)>/<uuid>/meta.json` (authoritative `cwd` + epoch-ms timestamps); the transcript text is the plaintext `~/.cursor/projects/<enc>/agent-transcripts/<uuid>/<uuid>.jsonl`, located by uuid. Wired through every `TranscriptSource` ripple point, mirroring **Devin** (standalone enable flag + status row + settings toggle).

**Tech Stack:** TypeScript (ESM), Node 22.5+, Vitest, Biome. VS Code extension bundles the CLI via esbuild.

## Global Constraints

_(copied verbatim from CLAUDE.md / spec — every task's requirements implicitly include these)_

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated with` trailers.
- **Cadence:** per-task commit (`git commit -s`) + run only the task's own targeted test file(s) via vitest; the full `npm run all` gate (clean → build → lint → test) runs **once at the end** (Task 6). Intermediate commits need not typecheck the whole repo (esbuild/vitest strips types); Task 6 is the authoritative gate.
- **Do not regress CLI coverage:** 97% statements / 96% branches / 97% functions / 97% lines under `cli/src/`.
- **Biome:** tabs, 4-wide, 120 columns. `noExplicitAny: error`, `noUnusedImports/Variables: error`. `biome check --error-on-warnings`.
- **Path normalization:** use `normalizePathForCompare` from `cli/src/core/PathUtils.ts`; never inline `.replace(/\\/g,"/")`.
- **No SQLite** for this source (store.db is an unparseable protobuf Merkle-DAG + WAL — see spec Observed Reality). Reader/discoverer touch only `meta.json` + `<uuid>.jsonl`.
- **Coverage exemptions** use `/* v8 ignore start/stop */` blocks, never single-line `ignore next`.
- **source id = `cursor-cli`**, label = `"Cursor CLI"`. Reuse Cursor's brand color `#2dd4bf` and Cursor icon SVG.

---

### Task 1: Open the `TranscriptSource` union, config, InstallStatus, and label

**Files:**
- Modify: `cli/src/Types.ts` (`TRANSCRIPT_SOURCES` ~L18-30; `JolliMemoryConfig` ~L1121; `InstallStatus` ~L1367-1371)
- Modify: `cli/src/core/TranscriptSourceLabel.ts:16-28`
- Test: `cli/src/core/TranscriptSourceLabel.test.ts`

**Interfaces:**
- Produces: `TranscriptSource` now includes `"cursor-cli"`; `JolliMemoryConfig.cursorCliEnabled?: boolean`; `InstallStatus.cursorCliDetected?/cursorCliEnabled?/cursorCliScanError?`. `cursorCliScanError` is typed `CursorCliScanError` (defined in Task 2, imported into Types.ts).

- [ ] **Step 1: Add `"cursor-cli"` to the source enumeration.**

In `cli/src/Types.ts`, `TRANSCRIPT_SOURCES` array — add after `"cursor",` (keep the IDE/CLI pair adjacent, mirroring `cline`/`cline-cli`):

```ts
	"cursor",
	"cursor-cli",
	"copilot",
```

- [ ] **Step 2: Add the config flag.**

In `JolliMemoryConfig` (next to `readonly devinEnabled?: boolean;`):

```ts
	readonly cursorCliEnabled?: boolean;
```

- [ ] **Step 3: Add the three `InstallStatus` fields.**

In `InstallStatus` (next to the `devinDetected/devinEnabled/devinScanError` trio) — use an **inline structural type** for the scan error so this task has NO forward import to the not-yet-created discoverer. Task 2 exports a structurally-identical `CursorCliScanError`, which assigns to this field without any coupling:

```ts
	readonly cursorCliDetected?: boolean;
	readonly cursorCliEnabled?: boolean;
	readonly cursorCliScanError?: { readonly kind: "fs" | "parse"; readonly message: string };
```

- [ ] **Step 4: Add the display label.**

In `cli/src/core/TranscriptSourceLabel.ts`, `TRANSCRIPT_SOURCE_LABELS` (after `cursor: "Cursor",`):

```ts
	cursor: "Cursor",
	"cursor-cli": "Cursor CLI",
```

- [ ] **Step 5: Extend the label test.**

In `cli/src/core/TranscriptSourceLabel.test.ts`, add an assertion mirroring the existing per-source cases:

```ts
	expect(transcriptSourceLabel("cursor-cli")).toBe("Cursor CLI");
```

---

### Task 2: `CursorCliSessionDiscoverer.ts` (+ colocated detection) + tests + real fixture

**Files:**
- Create: `cli/src/core/CursorCliSessionDiscoverer.ts`
- Create: `cli/src/core/CursorCliSessionDiscoverer.test.ts`
- Test fixture: written inline in the test (temp dirs), plus one pinned real `meta.json` sample.

**Interfaces:**
- Produces: `getCursorCliChatsDir(home?)`, `getCursorCliProjectsDir(home?)`, `isCursorCliInstalled(home?): Promise<boolean>`, `scanCursorCliSessions(projectDir, chatsDir?, projectsDir?): Promise<CursorCliScanResult>`, `discoverCursorCliSessions(projectDir): Promise<ReadonlyArray<SessionInfo>>`, and types `CursorCliScanError = { kind: "fs" | "parse"; message: string }`, `CursorCliScanResult = { sessions: ReadonlyArray<SessionInfo>; error?: CursorCliScanError }`.
- Consumes: `SessionInfo` (Types.ts), `normalizePathForCompare` (PathUtils).

- [ ] **Step 1: Write the failing test.**

Create `cli/src/core/CursorCliSessionDiscoverer.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCursorCliSessions, isCursorCliInstalled, scanCursorCliSessions } from "./CursorCliSessionDiscoverer.js";

// hash dir name is md5(cwd) on a real install, but scan never recomputes it — it
// reads meta.json.cwd — so tests use arbitrary hash dir names on purpose.
async function writeChat(chatsDir: string, hash: string, uuid: string, meta: object): Promise<void> {
	const dir = join(chatsDir, hash, uuid);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "meta.json"), JSON.stringify(meta), "utf8");
}
async function writeTranscript(projectsDir: string, enc: string, uuid: string, jsonl: string): Promise<void> {
	const dir = join(projectsDir, enc, "agent-transcripts", uuid);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${uuid}.jsonl`), jsonl, "utf8");
}

describe("scanCursorCliSessions", () => {
	let chatsDir: string;
	let projectsDir: string;
	const project = "/Users/x/proj-a";
	const now = Date.now();
	beforeEach(async () => {
		const base = await mkdtemp(join(tmpdir(), "cursor-cli-disc-"));
		chatsDir = join(base, "chats");
		projectsDir = join(base, "projects");
		await mkdir(chatsDir, { recursive: true });
		await mkdir(projectsDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(join(chatsDir, ".."), { recursive: true, force: true });
	});

	it("returns empty (no error) when chats dir absent", async () => {
		const r = await scanCursorCliSessions(project, join(chatsDir, "nope"), projectsDir);
		expect(r).toEqual({ sessions: [] });
	});

	it("attributes by meta.cwd, sets source/title/updatedAt, resolves JSONL by uuid", async () => {
		await writeChat(chatsDir, "h1", "u1", { cwd: project, updatedAtMs: now, title: "Hello There" });
		await writeTranscript(projectsDir, "Users-x-proj-a", "u1", '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n');
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({ sessionId: "u1", source: "cursor-cli", title: "Hello There" });
		expect(r.sessions[0].transcriptPath).toContain("u1.jsonl");
		expect(r.sessions[0].updatedAt).toBe(new Date(now).toISOString());
	});

	it("does NOT attribute a session run from a subdirectory of the repo (contract: exact-equality, like Devin)", async () => {
		await writeChat(chatsDir, "h2", "u2", { cwd: `${project}/vscode`, updatedAtMs: now });
		await writeTranscript(projectsDir, "Users-x-proj-a", "u2", '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n');
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("skips stale sessions (updatedAtMs older than 48h)", async () => {
		await writeChat(chatsDir, "h3", "u3", { cwd: project, updatedAtMs: now - 49 * 60 * 60 * 1000 });
		await writeTranscript(projectsDir, "e", "u3", "{}\n");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("falls back to createdAtMs when updatedAtMs missing; skips non-finite timestamp", async () => {
		await writeChat(chatsDir, "h4", "u4", { cwd: project, createdAtMs: now });
		await writeTranscript(projectsDir, "e", "u4", "{}\n");
		await writeChat(chatsDir, "h5", "u5", { cwd: project });
		await writeTranscript(projectsDir, "e", "u5", "{}\n");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["u4"]);
	});

	it("skips a matching chat whose transcript JSONL is absent", async () => {
		await writeChat(chatsDir, "h6", "u6", { cwd: project, updatedAtMs: now });
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions).toHaveLength(0);
	});

	it("skips a corrupt meta.json without sinking the scan", async () => {
		await writeChat(chatsDir, "h7", "u7", { cwd: project, updatedAtMs: now });
		await writeTranscript(projectsDir, "e", "u7", "{}\n");
		const bad = join(chatsDir, "h8", "u8");
		await mkdir(bad, { recursive: true });
		await writeFile(join(bad, "meta.json"), "{ not json", "utf8");
		const r = await scanCursorCliSessions(project, chatsDir, projectsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["u7"]);
	});

	it("returns a filesystem error when chats path is a file, not a dir", async () => {
		const filePath = join(projectsDir, "not-a-dir");
		await writeFile(filePath, "x", "utf8");
		const r = await scanCursorCliSessions(project, filePath, projectsDir);
		expect(r.error?.kind).toBe("fs");
	});

	it("discoverCursorCliSessions strips the error channel", async () => {
		const filePath = join(projectsDir, "nd2");
		await writeFile(filePath, "x", "utf8");
		// point default chats at a file → fs error → still returns an array
		const sessions = await discoverCursorCliSessions("/nope");
		expect(Array.isArray(sessions)).toBe(true);
	});

	it("isCursorCliInstalled is false when chats dir missing", async () => {
		expect(await isCursorCliInstalled(join(chatsDir, "no-home"))).toBe(false);
	});
});
```

- [ ] **Step 2: Implement `CursorCliSessionDiscoverer.ts`.**

```ts
/**
 * Cursor CLI (cursor-agent) Session Discoverer (+ colocated detection)
 *
 * cursor-agent is a DIFFERENT product from Cursor IDE (the `cursor` source).
 * Storage (verified on a real macOS install — see the JOLLI-2023 design spec):
 *   - Authoritative index: ~/.cursor/chats/<md5(cwd)>/<uuid>/meta.json
 *       { cwd, createdAtMs, updatedAtMs, title, hasConversation }  (epoch MS)
 *   - Transcript text:     ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl
 *       plaintext JSONL — located by uuid (the encoded-cwd dir name is a lossy
 *       `/`↔`-` encoding, so we never decode it; the uuid is globally unique).
 * The co-located store.db is a protobuf Merkle-DAG + WAL — deliberately NOT read.
 * Pure JSON path → no node:sqlite, no WAL trap, no Node-18 feature gate.
 *
 * Directory attribution is exact-equality on meta.cwd via normalizePathForCompare,
 * mirroring Devin/OpenCode/Cline CLI: a session started from a repo *subdirectory*
 * is NOT attributed to the repo root. This is the known, intentional hookless
 * limitation — see the "subdirectory" contract test.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("CursorCliDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export interface CursorCliScanError {
	readonly kind: "fs" | "parse";
	readonly message: string;
}
export interface CursorCliScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: CursorCliScanError;
}

interface CursorCliMeta {
	readonly cwd?: string;
	readonly updatedAtMs?: number;
	readonly createdAtMs?: number;
	readonly title?: string;
}

/** ~/.cursor (home-relative on all platforms; cursor-agent uses ~/.cursor on every OS). */
export function getCursorCliDir(home: string = homedir()): string {
	return join(home, ".cursor");
}
export function getCursorCliChatsDir(home: string = homedir()): string {
	return join(getCursorCliDir(home), "chats");
}
export function getCursorCliProjectsDir(home: string = homedir()): string {
	return join(getCursorCliDir(home), "projects");
}

/** Detected when the chats/ dir exists — pure JSON/JSONL, so no hasNodeSqliteSupport() gate. */
export async function isCursorCliInstalled(home: string = homedir()): Promise<boolean> {
	try {
		return (await stat(getCursorCliChatsDir(home))).isDirectory();
	} catch {
		return false;
	}
}

/** Locate the plaintext JSONL transcript for `uuid` under projects/<any>/agent-transcripts/. */
async function resolveTranscriptPath(projectsDir: string, uuid: string): Promise<string | undefined> {
	let projects: string[];
	try {
		projects = await readdir(projectsDir);
	} catch {
		return undefined;
	}
	for (const p of projects) {
		const candidate = join(projectsDir, p, "agent-transcripts", uuid, `${uuid}.jsonl`);
		try {
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {
			// not this project bucket — keep looking
		}
	}
	return undefined;
}

export async function scanCursorCliSessions(
	projectDir: string,
	chatsDir: string = getCursorCliChatsDir(),
	projectsDir: string = getCursorCliProjectsDir(),
): Promise<CursorCliScanResult> {
	let hashes: string[];
	try {
		hashes = await readdir(chatsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const target = normalizePathForCompare(projectDir);
	const sessions: SessionInfo[] = [];

	for (const hash of hashes) {
		let uuids: string[];
		try {
			uuids = await readdir(join(chatsDir, hash));
		} catch {
			continue; // a stray file at chats/<hash> — skip
		}
		for (const uuid of uuids) {
			let meta: CursorCliMeta;
			try {
				meta = JSON.parse(await readFile(join(chatsDir, hash, uuid, "meta.json"), "utf8")) as CursorCliMeta;
			} catch (error: unknown) {
				log.debug("Skipping %s: meta.json read/parse failed (%s)", uuid, (error as Error).message);
				continue;
			}
			if (typeof meta.cwd !== "string" || normalizePathForCompare(meta.cwd) !== target) continue;
			const updatedAtMs = meta.updatedAtMs ?? meta.createdAtMs;
			if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) {
				log.warn("Skipping Cursor CLI session %s: non-finite updatedAtMs", uuid);
				continue;
			}
			if (updatedAtMs < cutoffMs) continue;
			const transcriptPath = await resolveTranscriptPath(projectsDir, uuid);
			if (!transcriptPath) {
				log.debug("Skipping Cursor CLI session %s: no transcript JSONL found", uuid);
				continue;
			}
			const title = meta.title?.trim();
			sessions.push({
				sessionId: uuid,
				transcriptPath,
				updatedAt: new Date(updatedAtMs).toISOString(),
				source: "cursor-cli",
				...(title ? { title } : {}),
			});
		}
	}
	return { sessions };
}

/** QueueWorker wrapper — strips the error channel. */
export async function discoverCursorCliSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanCursorCliSessions(projectDir);
	if (error) log.warn("Cursor CLI scan error (%s): %s", error.kind, error.message);
	return sessions;
}
```

---

### Task 3: `CursorCliTranscriptReader.ts` + tests + pinned real fixture

**Files:**
- Create: `cli/src/core/CursorCliTranscriptReader.ts`
- Create: `cli/src/core/CursorCliTranscriptReader.test.ts`

**Interfaces:**
- Produces: `readCursorCliTranscript(transcriptPath, cursor?, beforeTimestamp?): Promise<TranscriptReadResult>`.
- Consumes: `TranscriptCursor`, `TranscriptEntry`, `TranscriptReadResult` (Types.ts); `mergeConsecutiveEntries` (TranscriptReader.ts).

- [ ] **Step 1: Write the failing test.** The fixture lines are copied verbatim from a real `~/.cursor/projects/.../agent-transcripts/<uuid>/<uuid>.jsonl` (JOLLI-2023 discovery).

Create `cli/src/core/CursorCliTranscriptReader.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";

// Real line shapes verified on a live cursor-agent install (JOLLI-2023):
//   {role, message:{content:[{type:"text"|"tool_use", …}]}}  and  {type, status}
const REAL_JSONL = [
	JSON.stringify({
		role: "user",
		message: { content: [{ type: "text", text: "<timestamp>Tuesday, Jul 21, 2026, 6:56 PM (UTC+8)</timestamp>\n<user_query>\nhi\n</user_query>" }] },
	}),
	JSON.stringify({
		role: "assistant",
		message: { content: [{ type: "text", text: "Hi — how can I help?" }] },
	}),
	JSON.stringify({ type: "turn_ended", status: "completed" }),
	"",
].join("\n");

describe("readCursorCliTranscript", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cursor-cli-read-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("parses user/assistant lines, unwraps <user_query>, skips control lines", async () => {
		const p = join(dir, "t.jsonl");
		await writeFile(p, REAL_JSONL, "utf8");
		const r = await readCursorCliTranscript(p);
		expect(r.entries).toEqual([
			{ role: "human", content: "hi" },
			{ role: "assistant", content: "Hi — how can I help?" },
		]);
		expect(r.newCursor.lineNumber).toBe(4);
	});

	it("skips a tool_use-only assistant turn (no text) and malformed lines", async () => {
		const p = join(dir, "t2.jsonl");
		await writeFile(
			p,
			[
				JSON.stringify({ role: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
				"{ not json",
				JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>\nok\n</user_query>" }] } }),
			].join("\n"),
			"utf8",
		);
		const r = await readCursorCliTranscript(p);
		expect(r.entries).toEqual([{ role: "human", content: "ok" }]);
	});

	it("resumes from cursor.lineNumber", async () => {
		const p = join(dir, "t3.jsonl");
		await writeFile(p, REAL_JSONL, "utf8");
		const r = await readCursorCliTranscript(p, { transcriptPath: p, lineNumber: 1, updatedAt: "" });
		expect(r.entries).toEqual([{ role: "assistant", content: "Hi — how can I help?" }]);
	});

	it("throws (with preserved code) when the file is missing", async () => {
		await expect(readCursorCliTranscript(join(dir, "nope.jsonl"))).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Implement `CursorCliTranscriptReader.ts`.**

```ts
/**
 * Cursor CLI (cursor-agent) Transcript Reader
 *
 * Reads one cursor-agent conversation from its plaintext JSONL
 * (~/.cursor/projects/<enc>/agent-transcripts/<uuid>/<uuid>.jsonl). Line shapes
 * (verified live — JOLLI-2023):
 *   { role: "user"|"assistant", message: { content: [{ type: "text"|"tool_use", text? }] } }
 *   { type, status }   ← control lines (turn_ended, …) — skipped
 * Role map: user→human, assistant→assistant. Only `text` parts contribute
 * content; `tool_use` parts are dropped (a pure tool-call turn yields no entry,
 * matching the empty-content skip in Devin/Codex readers).
 *
 * The stream is linear + append-only, so the cursor is a plain `lineNumber`
 * (no anchorId). JSONL lines carry NO structured timestamp, so `beforeTimestamp`
 * cannot gate per-line and is intentionally ignored — the `lineNumber` cursor
 * still prevents re-summarizing already-consumed turns.
 */

import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const log = createLogger("CursorCliReader");

interface CursorCliPart {
	readonly type?: string;
	readonly text?: unknown;
}
interface CursorCliLine {
	readonly role?: string;
	readonly message?: { readonly content?: ReadonlyArray<CursorCliPart> };
}

const TIMESTAMP_RE = /<timestamp>[\s\S]*?<\/timestamp>\s*/gi;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

function unwrapUser(text: string): string {
	const stripped = text.replace(TIMESTAMP_RE, "");
	const m = USER_QUERY_RE.exec(stripped);
	return (m ? m[1] : stripped).trim();
}

function extractText(line: CursorCliLine): string {
	const parts: string[] = [];
	for (const p of line.message?.content ?? []) {
		if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
	}
	return parts.join("\n").trim();
}

function mapRole(role: string | undefined): "human" | "assistant" | undefined {
	if (role === "user") return "human";
	if (role === "assistant") return "assistant";
	return undefined;
}

export async function readCursorCliTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	_beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw: string;
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch (error: unknown) {
		log.error("Failed to read Cursor CLI transcript %s: %s", transcriptPath, (error as Error).message);
		const wrapped = new Error(`Cannot read Cursor CLI transcript: ${transcriptPath}`) as NodeJS.ErrnoException;
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== undefined) wrapped.code = code;
		throw wrapped;
	}

	const lines = raw.split("\n");
	const startLine = cursor?.lineNumber ?? 0;
	const rawEntries: TranscriptEntry[] = [];

	for (let i = startLine; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		let parsed: CursorCliLine;
		try {
			parsed = JSON.parse(line) as CursorCliLine;
		} catch {
			continue; // {type,status} control lines are JSON too, but a mid-write partial line isn't
		}
		const role = mapRole(parsed.role);
		if (role === undefined) continue; // control lines have no role
		const text = extractText(parsed);
		const content = role === "human" ? unwrapUser(text) : text;
		if (content.length > 0) rawEntries.push({ role, content });
	}

	const entries = mergeConsecutiveEntries(rawEntries);
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: lines.length,
		updatedAt: new Date().toISOString(),
	};
	return { entries, newCursor, totalLinesRead: lines.length - startLine };
}
```

---

### Task 4: CLI wiring (discovery, read dispatch, aggregator, tracker, installer, configure, status, title)

**Files (all Modify):**
- `cli/src/hooks/QueueWorker.ts` — imports L51-52; discovery block ~L3225; read dispatch ~L3518
- `cli/src/core/ActiveSessionAggregator.ts` — fan-out ~L227; loader ~L365
- `cli/src/core/TranscriptLoader.ts` — dispatch ~L107; `JsonlSource` Exclude L181-184
- `cli/src/core/TranscriptMessageCounter.ts` — import L34; switch ~L135
- `cli/src/core/SessionTracker.ts` — filter ~L188
- `cli/src/install/Installer.ts` — import L36; detect ~L802; scan ~L860; emit ~L1003
- `cli/src/commands/ConfigureCommand.ts` — key L61; coercion L139; descriptor L234
- `cli/src/commands/StatusCommand.ts` — row ~L417
- `cli/src/core/SessionTitleResolver.ts` — map L37; stub ~L169

**Interfaces:**
- Consumes: everything produced in Tasks 1-3 (`discoverCursorCliSessions`, `isCursorCliInstalled`, `scanCursorCliSessions`, `readCursorCliTranscript`, config/InstallStatus fields).

- [ ] **Step 1: QueueWorker — imports + discovery + read dispatch.**

Imports (after the Devin imports, L52):

```ts
import { discoverCursorCliSessions, isCursorCliInstalled } from "../core/CursorCliSessionDiscoverer.js";
import { readCursorCliTranscript } from "../core/CursorCliTranscriptReader.js";
```

Discovery block — insert after the Devin `if (...)` block (after L3232):

```ts
	// Discover Cursor CLI (cursor-agent) sessions (on-demand scan of ~/.cursor/chats/*/*/meta.json).
	if (config.cursorCliEnabled !== false && (await isCursorCliInstalled())) {
		const cursorCliSessions = await discoverCursorCliSessions(cwd);
		if (cursorCliSessions.length > 0) {
			allSessions = [...allSessions, ...cursorCliSessions];
			log.info("Discovered %d Cursor CLI session(s)", cursorCliSessions.length);
		}
	}
```

Read dispatch — insert a new `else if` after the `devin` branch (after L3524):

```ts
		} else if (source === "cursor-cli") {
			try {
				result = await readCursorCliTranscript(session.transcriptPath, cursor, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping Cursor CLI session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
```

- [ ] **Step 2: ActiveSessionAggregator — fan-out + loader.**

Add to the `Promise.all([...])` array (after `loadDevin(cwd),`, L227):

```ts
		loadCursorCli(cwd),
```

Add the loader function (after `loadDevin`, ~L378):

```ts
async function loadCursorCli(cwd: string): Promise<LoaderResult> {
	try {
		const { scanCursorCliSessions } = await import("./CursorCliSessionDiscoverer.js");
		const r = await scanCursorCliSessions(cwd);
		if (r.error) {
			log.warn("scanCursorCliSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cursor-cli"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanCursorCliSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cursor-cli"] };
	}
}
```

- [ ] **Step 3: TranscriptLoader — dispatch branch + Exclude.**

Add the dispatch branch (after the `devin` branch, ~L118):

```ts
	if (opts.source === "cursor-cli") {
		try {
			const { readCursorCliTranscript } = await import("./CursorCliTranscriptReader.js");
			const result = await readCursorCliTranscript(opts.transcriptPath);
			return [...result.entries];
		} catch (err) {
			if (!isEnoent(err)) {
				log.warn("loadTranscript (cursor-cli) failed for %s: %s", opts.transcriptPath, errMsg(err));
			}
			return [];
		}
	}
```

Add `"cursor-cli"` to the `JsonlSource` Exclude union (L181-184):

```ts
type JsonlSource = Exclude<
	TranscriptSource,
	"gemini" | "opencode" | "cursor" | "cursor-cli" | "copilot" | "cline" | "cline-cli" | "devin" | "antigravity"
>;
```

- [ ] **Step 4: TranscriptMessageCounter — import + switch case.**

Import (after the Devin reader import, L34):

```ts
import { readCursorCliTranscript } from "./CursorCliTranscriptReader.js";
```

Switch case (after `case "devin":`, ~L136):

```ts
		case "cursor-cli":
			return readCursorCliTranscript(transcriptPath, cursor);
```

- [ ] **Step 5: SessionTracker — enabled filter.**

After the Devin filter block (~L190):

```ts
	if (config.cursorCliEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "cursor-cli");
	}
```

- [ ] **Step 6: Installer — import + detect + scan + emit.**

Import (after the Devin discoverer import, L36):

```ts
import { isCursorCliInstalled, scanCursorCliSessions } from "../core/CursorCliSessionDiscoverer.js";
```

Detect (after `const devinDetected = ...`, ~L802):

```ts
	const cursorCliDetected = await isCursorCliInstalled();
```

Scan (after the Devin scan block, ~L868):

```ts
	// Discover Cursor CLI (cursor-agent) sessions on-demand (not stored in sessions.json).
	let cursorCliScanError: CursorCliScanError | undefined;
	if (config.cursorCliEnabled !== false && cursorCliDetected) {
		const scan = await scanCursorCliSessions(projectDir);
		if (scan.sessions.length > 0) {
			allEnabledSessions = [...allEnabledSessions, ...scan.sessions];
		}
		cursorCliScanError = scan.error;
	}
```

Add the `CursorCliScanError` type import at the top of Installer.ts (alongside the discoverer import, or extend it):

```ts
import { type CursorCliScanError, isCursorCliInstalled, scanCursorCliSessions } from "../core/CursorCliSessionDiscoverer.js";
```

(Replace the plain import from the first sub-step with this combined form.)

Emit into `InstallStatus` (after the Devin trio, ~L1005):

```ts
		cursorCliDetected,
		cursorCliEnabled: config.cursorCliEnabled,
		cursorCliScanError,
```

- [ ] **Step 7: ConfigureCommand — editable key + coercion + descriptor.**

Editable-keys list (after `"devinEnabled",`, L61):

```ts
	"cursorCliEnabled",
```

Boolean coercion guard (extend the `||` chain at ~L139):

```ts
		key === "cursorCliEnabled" ||
```

Descriptor (after the Devin descriptor, ~L236):

```ts
	{
		key: "cursorCliEnabled",
		description: "Enable Cursor CLI (cursor-agent) session discovery (true/false)",
	},
```

- [ ] **Step 8: StatusCommand — status row.** Insert after the Devin row (~L425), mirroring its shape:

```ts
				renderIntegrationRow(
					"Cursor CLI:",
					status.cursorCliDetected,
					{
						enabled: status.cursorCliEnabled !== false,
						sessionCount: counts["cursor-cli"],
						scanError: status.cursorCliScanError,
					},
				),
```

> Match the exact call signature used by the surrounding rows (read L410-428 first; the helper name / argument order must be copied from the neighbours, not from this snippet's guess). `counts` is `status.sessionsBySource ?? {}`.

- [ ] **Step 9: SessionTitleResolver — map entry + stub.**

Map entry (after `devin: parseDevinUserLine,`, L37):

```ts
	"cursor-cli": parseCursorCliUserLine,
```

Stub (after `parseDevinUserLine`, ~L171):

```ts
function parseCursorCliUserLine(_line: string): string | undefined {
	// Cursor CLI sessions carry SessionInfo.title from the discoverer (meta.json.title).
	return undefined;
}
```

- [ ] **Step 10: Update CLI test expectations enumerating all sources.** Add `cursor-cli` to expectation sets in (read each first; add the parallel entry):
  - `cli/src/commands/ConfigureCommand.test.ts` (editable-keys / descriptor count)
  - `cli/src/core/SessionTracker.test.ts` (per-source enable filter, if it enumerates)
  - `cli/src/hooks/QueueWorker.test.ts` (if it asserts discovered sources)
  - any test asserting `TRANSCRIPT_SOURCES.length` or iterating all sources.

---

### Task 5: VS Code extension wiring (status tree, settings, brand, labels)

**Files (all Modify):**
- `vscode/src/providers/StatusTreeProvider.ts` ~L329-350
- `vscode/src/views/SettingsHtmlBuilder.ts:57`
- `vscode/src/views/SettingsScriptBuilder.ts` L40, 268, 342, 371, 439, 473, 590
- `vscode/src/views/SettingsWebviewPanel.ts` L57, 467, 618
- `vscode/src/views/SidebarCssBuilder.ts:973` and `vscode/src/views/ConversationDetailsHtmlBuilder.ts:87,170`
- `vscode/src/views/NextMemoryScriptBuilder.ts` L137, 187
- `vscode/src/views/SidebarScriptBuilder.ts` L4543, 4577/4598
- `vscode/src/views/SummaryScriptBuilder.ts` L2135/2156, 2382

**Interfaces:** Consumes `InstallStatus.cursorCliDetected/cursorCliEnabled/cursorCliScanError` and config `cursorCliEnabled` from Task 1/4. Brand: reuse Cursor's color `#2dd4bf` and Cursor icon SVG.

- [ ] **Step 1: StatusTreeProvider — scanError branch + normal row.** After the Devin block (~L349), mirror it:

```ts
	// Cursor CLI (cursor-agent): plaintext JSONL sessions (no agent hook; fs scan errors surface like Devin).
	if (s.cursorCliScanError) {
		rows.push(
			buildScanErrorRow(
				"Cursor CLI Integration",
				`unavailable — ${s.cursorCliScanError.kind}`,
				`Cursor CLI scan failed (${s.cursorCliScanError.kind}): ${s.cursorCliScanError.message}`,
			),
		);
	} else {
		rows.push(
			buildIntegrationRow(
				s.cursorCliDetected,
				s.cursorCliEnabled !== false,
				"Cursor CLI Integration",
				"Cursor CLI (cursor-agent) sessions found — session discovery is enabled",
				"Cursor CLI detected but session discovery is disabled in config",
				counts["cursor-cli"],
			),
		);
	}
```

> Read L329-350 first and copy the EXACT helper names/argument order used for Devin (`buildScanErrorRow`/`buildIntegrationRow` names here are placeholders for whatever the neighbours call). Update the comment at L244 to append "Cursor CLI".

- [ ] **Step 2: SettingsHtmlBuilder — toggle row.** After L57:

```ts
      ${buildToggleRow("cursorCliEnabled", "Cursor CLI", "Session discovery via Cursor CLI (cursor-agent), reading ~/.cursor/chats + agent-transcripts JSONL")}
```

- [ ] **Step 3: SettingsScriptBuilder — 7 enumeration sites.** Add `cursorCliEnabled` parallel to `devinEnabled` at each:
  - L40: `const cursorCliEnabledInput = document.getElementById('cursorCliEnabled');`
  - L268 (at-least-one-enabled guard): add `&& !cursorCliEnabledInput.checked`
  - L342 (payload build): `cursorCliEnabled: cursorCliEnabledInput.checked,`
  - L371 (dirty-check): `cursorCliEnabledInput.checked !== initialState.cursorCliEnabled ||`
  - L439 (listener array): add `cursorCliEnabledInput,`
  - L473 (second payload): `cursorCliEnabled: cursorCliEnabledInput.checked,`
  - L590 (hydrate): `cursorCliEnabledInput.checked = msg.settings.cursorCliEnabled;`

- [ ] **Step 4: SettingsWebviewPanel — state field + read + write-back.**
  - L57: `readonly cursorCliEnabled: boolean;`
  - L467: `cursorCliEnabled: config.cursorCliEnabled !== false,`
  - L618: `cursorCliEnabled: settings.cursorCliEnabled,`

- [ ] **Step 5: Brand color (reuse Cursor's teal `#2dd4bf`).**
  - `SidebarCssBuilder.ts` after L973: `  .tree-node.conversation-row .badge.transcript-source-cursor-cli    { color: #2dd4bf; border-color: #2dd4bf; background: rgba(45,212,191,0.12); }`
  - `ConversationDetailsHtmlBuilder.ts` after L87: `".badge.transcript-source-cursor-cli    { color: #2dd4bf; border-color: #2dd4bf; background: rgba(45,212,191,0.12); }",`

- [ ] **Step 6: Label + brand-icon SVG maps (3 builders, kept in lockstep). Reuse the `cursor:` SVG entry for `'cursor-cli':`.**
  - `NextMemoryScriptBuilder.ts`: label switch after L137 `case 'cursor-cli': return 'Cursor CLI';`; in `SOURCE_ICON_SVG`, add `'cursor-cli':` with the same SVG string as the `cursor:` entry.
  - `SidebarScriptBuilder.ts`: label switch after L4543 `case 'cursor-cli':    return 'Cursor CLI';`; in the SVG map add `'cursor-cli':` = the `cursor:` SVG.
  - `SummaryScriptBuilder.ts`: in the SVG map (~L2135) add `'cursor-cli':` = the `cursor:` SVG; and update `sourceOrder` at L2382 to insert `'cursor-cli'` after `'cursor'`:
    ```js
        var sourceOrder = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'cursor-cli', 'copilot', 'copilot-chat', 'cline', 'cline-cli', 'devin', 'antigravity'];
    ```
  - `ConversationDetailsHtmlBuilder.ts` label switch after L170: `case "cursor-cli":\n\t\t\treturn "Cursor CLI";`

> These builders return single template literals — **never write a backtick inside an added comment** (it truncates the whole literal). Reference identifiers with single quotes. (memory: builder backtick trap.)

- [ ] **Step 7: Update VS Code test expectations.** Add `cursor-cli` to source enumerations in: `StatusTreeProvider.test.ts`, `SettingsHtmlBuilder.test.ts`, `SettingsScriptBuilder.test.ts`, `SettingsWebviewPanel.test.ts`, `SidebarCssBuilder.test.ts`, `SidebarScriptBuilder.test.ts`, `SummaryScriptBuilder.test.ts`, `NextMemoryScriptBuilder.test.ts`, `ConversationDetailsHtmlBuilder.test.ts`, `services/ActiveSessionsProvider.test.ts`. Read each; add the parallel `cursor-cli` case/expectation next to the `devin` one.

---

### Task 6: Final full-gate verification

Tasks 1-5 have each already committed (per-task commit + targeted tests). This task is the authoritative full gate.

- [ ] **Step 1: Run the full gate.**

```bash
cd /Users/flyer/jolli/code/jollimemory-worktrees/feature/change-storage-to-folder
npm run all
```

Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97. A pre-existing `src/sync/GitClient.test.ts` push/pullRebase timeout under full-suite contention is a known env flake (re-run isolated to confirm) — everything else must be green.

- [ ] **Step 2: Fix any failures**, committing each fix with `git commit -s` (DCO, no Claude trailer). Re-run `npm run all` until green.

- [ ] **Step 3: Confirm final state.**

```bash
git log --oneline "$(git merge-base main HEAD)"..HEAD
git status
```

Expected: the Task 1-5 (+ any fix) commits are present; working tree clean.

---

## Self-Review

**Spec coverage:**
- Detection + discovery via chats/meta.json → Task 2 ✅
- Transcript via projects JSONL → Task 3 ✅
- Exact-equality attribution + subdirectory-limitation contract test → Task 2 Step 1 ✅
- 48h staleness → Task 2 ✅
- No SQLite (deviation #1) → Tasks 2/3 (pure JSON) ✅
- No SessionDirMatch dependency (deviation #2) → Task 2 inline `normalizePathForCompare` ✅
- All CLI ripple points → Task 4 ✅
- All VS Code ripple points + brand reuse → Task 5 ✅
- Real fixtures pinned → Task 2/3 test data copied from live install ✅
- `npm run all` + single commit at end → Task 6 ✅

**Placeholder scan:** Two intentional "read the neighbours first" notes (StatusCommand Step 8, StatusTree Step 1) exist because those helper signatures are only knowable at edit time; they carry a concrete snippet plus the anchor to verify against. No `TBD`/`TODO`.

**Type consistency:** `CursorCliScanError`/`CursorCliScanResult`, `scanCursorCliSessions`/`discoverCursorCliSessions`/`isCursorCliInstalled`/`readCursorCliTranscript`, config key `cursorCliEnabled`, InstallStatus `cursorCliDetected/cursorCliEnabled/cursorCliScanError`, source id `"cursor-cli"` — used identically across Tasks 1-5.
