# Cline 会话源(扩展 + CLI)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 jollimemory 在 post-commit 时捕获 Cline 两种形态(VS Code 扩展 `cline` / CLI `cline-cli`)的会话并生成 commit summary。

**Architecture:** 两套"无 hook"明文文件源三件套(detector + session discoverer + transcript reader),仿 CopilotChat 而非 Cursor(明文、非 SQLite)。共用单个 `clineEnabled` config flag(仿 Copilot CLI/Chat)。发现层不读 SQLite(CLI 扫明文目录规避 WAL 陷阱;扩展本无 DB)。两 reader 复用 `cursor.lineNumber` 作 message 下标游标,只抽 `text` block 映射为 `TranscriptEntry`。

**Tech Stack:** TypeScript(ESM,Node 22.5+)、Vitest、Biome(tab 缩进,120 列)。

## Global Constraints

> 每个 task 隐含遵守以下(逐字取自 spec / CLAUDE.md / 用户偏好):

- **提交纪律(用户裁决)**:每个 task **写代码 + 用 `git commit -s` 提交**(供 SDD 逐-task review 与 ledger 恢复);**但不每 task 跑 `npm run all`**——per-task 只跑本 task 自己的测试文件(如 `npm run test -w @jolli.ai/cli -- src/core/ClineCliDetector.test.ts`)。昂贵的全量 `npm run all` 门只在 Task 5 跑一次。PR 阶段可 squash。
- DCO:最终 commit 用 `git commit -s`。**禁止** `Co-Authored-By: Claude` / `🤖 Generated with` footer。
- 覆盖率红线(`cli/vite.config.ts`):statements 97 / branches 96 / functions 97 / lines 97。`cli/src/Types.ts` 免测。新三件套 + 每个新分支需覆盖。单行覆盖率豁免只认 `/* v8 ignore start/stop */` 块。
- 路径归一化用 `normalizePathForCompare`(`cli/src/core/PathUtils.ts`) / `normalizePathForMatch`(`VscodeWorkspaceLocator.ts`);禁止内联 `replace(/\\/g,"/")`(域助手内除外)。Windows/darwin 大小写不敏感。
- Biome:tab 缩进,120 列,`noExplicitAny: error`,`noUnusedImports: error`,`useImportType`。
- 源 id 命名:裸名 `cline` = VS Code 扩展,`cline-cli` = CLI。Label:`Cline (VS Code)` / `Cline CLI`。文件前缀:扩展 `Cline*`、CLI `ClineCli*`。

## 关键既有类型(逐字,供所有 task 引用)

```ts
// cli/src/Types.ts
export interface SessionInfo {
	readonly sessionId: string;
	readonly transcriptPath: string;
	readonly updatedAt: string; // ISO 8601
	readonly source?: TranscriptSource;
	readonly title?: string;
}
export interface TranscriptCursor {
	readonly transcriptPath: string;
	readonly lineNumber: number;
	readonly updatedAt: string; // ISO 8601
}
export interface TranscriptEntry {
	readonly role: "human" | "assistant";
	readonly content: string;
	readonly timestamp?: string;
}
export interface TranscriptReadResult {
	readonly entries: ReadonlyArray<TranscriptEntry>;
	readonly newCursor: TranscriptCursor;
	readonly totalLinesRead: number;
	// usage* 字段可选,Cline reader 不填
}
```

```ts
// cli/src/core/TranscriptReader.ts
export function mergeConsecutiveEntries(entries: ReadonlyArray<TranscriptEntry>): TranscriptEntry[]
```

## 文件结构

**新建(共享 helper + 6 个三件套 + 测试):**

- `cli/src/core/ClineTranscriptShared.ts`(+ `.test.ts`)——`ClineScanError` 类型 + `mapClineRole` + `buildClineReadResult`(游标/beforeTimestamp/合并/newCursor 的共享逻辑,两 reader 复用)
- `cli/src/core/ClineCliDetector.ts` / `ClineCliSessionDiscoverer.ts` / `ClineCliTranscriptReader.ts`(+ 各 `.test.ts`)
- `cli/src/core/ClineDetector.ts` / `ClineSessionDiscoverer.ts` / `ClineTranscriptReader.ts`(+ 各 `.test.ts`)

**修改(共享工具 + 12 处接线):**

- `cli/src/core/VscodeWorkspaceLocator.ts`(扩 `VscodeFlavor` + `ALL_VSCODE_FLAVORS`)
- `cli/src/Types.ts`(`TRANSCRIPT_SOURCES` / `JolliMemoryConfig` / `StatusInfo`)
- `cli/src/core/TranscriptSourceLabel.ts`、`cli/src/hooks/QueueWorker.ts`、`cli/src/core/TranscriptMessageCounter.ts`、`cli/src/core/TranscriptLoader.ts`、`cli/src/core/ActiveSessionAggregator.ts`、`cli/src/core/SessionTracker.ts`、`cli/src/core/SessionTitleResolver.ts`
- `cli/src/install/Installer.ts`、`cli/src/commands/StatusCommand.ts`、`cli/src/commands/ConfigureCommand.ts`

> **两 reader 抽共享 helper(用户裁决)**:游标/beforeTimestamp/合并/newCursor 逻辑放 `ClineTranscriptShared.ts` 的 `buildClineReadResult`;两 reader 各自只做「读文件 + 归一化(文件形状 + `<user_input>` 剥壳)成 `NormalizedMessage[]`」再调共享逻辑。`ClineScanError` 也定义在此共享模块。

---

## Task 1: Cline CLI 三件套(source id `cline-cli`)

**Files:**
- Create: `cli/src/core/ClineCliDetector.ts`
- Create: `cli/src/core/ClineCliSessionDiscoverer.ts`
- Create: `cli/src/core/ClineCliTranscriptReader.ts`
- Test: `cli/src/core/ClineCliDetector.test.ts` / `ClineCliSessionDiscoverer.test.ts` / `ClineCliTranscriptReader.test.ts`

**Interfaces:**
- Produces（供 Task 3 wiring 消费):
  - `isClineCliInstalled(home?: string): Promise<boolean>`
  - `getClineCliDataDir(home?: string): string`、`getClineCliSessionsDir(home?: string): string`
  - `interface ClineCliScanResult { readonly sessions: ReadonlyArray<SessionInfo>; readonly error?: ClineScanError }`
  - `scanClineCliSessions(projectDir: string, sessionsDir?: string): Promise<ClineCliScanResult>`
  - `discoverClineCliSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>>`
  - `readClineCliTranscript(transcriptPath: string, cursor?: TranscriptCursor | null, beforeTimestamp?: string): Promise<TranscriptReadResult>`
- 本 task 先建 `ClineTranscriptShared.ts`(见 Step 1),其中定义 `ClineScanError`、`mapClineRole`、`buildClineReadResult`、`NormalizedMessage`;CLI/扩展 discoverer、Types.ts、Installer 均从此模块 import `ClineScanError`。

- [ ] **Step 1: 写 `ClineCliDetector.ts`**

```ts
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cline CLI data root: <home>/.cline/data (home-relative on all platforms). */
export function getClineCliDataDir(home: string = homedir()): string {
	return join(home, ".cline", "data");
}

/** Per-session directory root: <dataDir>/sessions. */
export function getClineCliSessionsDir(home: string = homedir()): string {
	return join(getClineCliDataDir(home), "sessions");
}

/**
 * Detected when the sessions/ dir exists. No node:sqlite gate — the CLI
 * discoverer reads plain JSON sidecars, never the WAL-mode sessions.db.
 */
export async function isClineCliInstalled(home: string = homedir()): Promise<boolean> {
	try {
		await access(getClineCliSessionsDir(home));
		return true;
	} catch {
		return false;
	}
}
```

- [ ] **Step 2: 写 `ClineCliDetector.test.ts`**

```ts
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClineCliDataDir, getClineCliSessionsDir, isClineCliInstalled } from "./ClineCliDetector.js";

describe("ClineCliDetector", () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "cline-cli-det-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("derives data + sessions dirs from home", () => {
		expect(getClineCliDataDir(home)).toBe(join(home, ".cline", "data"));
		expect(getClineCliSessionsDir(home)).toBe(join(home, ".cline", "data", "sessions"));
	});

	it("returns false when sessions dir is absent", async () => {
		expect(await isClineCliInstalled(home)).toBe(false);
	});

	it("returns true once sessions dir exists", async () => {
		await mkdir(getClineCliSessionsDir(home), { recursive: true });
		expect(await isClineCliInstalled(home)).toBe(true);
	});
});
```

- [ ] **Step 3a: 写共享模块 `ClineTranscriptShared.ts`**

> 承载两 reader 共用的:`ClineScanError` 类型、role 映射、以及 `NormalizedMessage[] → TranscriptReadResult` 的游标/beforeTimestamp/合并/newCursor 逻辑。两 reader 各自只负责「读文件 + 抽 text + 归一化」。

```ts
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

/** Structured scan error shared by the Cline CLI + extension sources (non-SQLite). */
export interface ClineScanError {
	readonly kind: "parse" | "fs" | "schema" | "unknown";
	readonly message: string;
}

/** A source message after file-shape + text extraction has been normalized away. */
export interface NormalizedMessage {
	readonly role: "human" | "assistant" | undefined;
	readonly content: string;
	readonly ts?: number;
}

/** Map a raw Cline role string to a TranscriptEntry role (unknown → undefined → dropped). */
export function mapClineRole(role: string | undefined): "human" | "assistant" | undefined {
	if (role === "assistant") return "assistant";
	if (role === "user") return "human";
	return undefined;
}

/**
 * Shared read logic for both Cline sources. `messages` are already normalized
 * (role mapped, text extracted, `<user_input>` unwrapped by the caller as needed).
 * Cursor.lineNumber is repurposed as a message index. When `beforeTimestamp` is
 * set, stops at the first message past the cutoff and advances the cursor only to
 * the last consumed index (commit-attribution mode); otherwise advances to end.
 */
export function buildClineReadResult(
	transcriptPath: string,
	messages: ReadonlyArray<NormalizedMessage>,
	cursor: TranscriptCursor | null | undefined,
	beforeTimestamp: string | undefined,
): TranscriptReadResult {
	const startIndex = cursor?.lineNumber ?? 0;
	const beforeMs = beforeTimestamp ? Date.parse(beforeTimestamp) : undefined;

	const rawEntries: TranscriptEntry[] = [];
	let lastConsumedIndex = startIndex;
	for (let i = startIndex; i < messages.length; i++) {
		const msg = messages[i];
		if (beforeMs !== undefined && typeof msg.ts === "number" && msg.ts > beforeMs) break;
		lastConsumedIndex = i + 1;
		if (msg.role === undefined || msg.content.length === 0) continue;
		const timestamp = typeof msg.ts === "number" ? new Date(msg.ts).toISOString() : undefined;
		rawEntries.push(timestamp ? { role: msg.role, content: msg.content, timestamp } : { role: msg.role, content: msg.content });
	}

	const entries = mergeConsecutiveEntries(rawEntries);
	const newCursor: TranscriptCursor = {
		transcriptPath,
		lineNumber: beforeTimestamp ? lastConsumedIndex : messages.length,
		updatedAt: new Date().toISOString(),
	};
	return { entries, newCursor, totalLinesRead: lastConsumedIndex - startIndex };
}

/** Empty result preserving the caller's cursor index (used on unreadable file). */
export function emptyClineReadResult(transcriptPath: string, cursor?: TranscriptCursor | null): TranscriptReadResult {
	return {
		entries: [],
		newCursor: { transcriptPath, lineNumber: cursor?.lineNumber ?? 0, updatedAt: new Date().toISOString() },
		totalLinesRead: 0,
	};
}
```

- [ ] **Step 3b: 写共享模块测试 `ClineTranscriptShared.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildClineReadResult, emptyClineReadResult, mapClineRole, type NormalizedMessage } from "./ClineTranscriptShared.js";

const N = (role: string | undefined, content: string, ts?: number): NormalizedMessage => ({
	role: mapClineRole(role),
	content,
	ts,
});

describe("mapClineRole", () => {
	it("maps user→human, assistant→assistant, else undefined", () => {
		expect(mapClineRole("user")).toBe("human");
		expect(mapClineRole("assistant")).toBe("assistant");
		expect(mapClineRole("system")).toBeUndefined();
		expect(mapClineRole(undefined)).toBeUndefined();
	});
});

describe("buildClineReadResult", () => {
	const msgs = [N("user", "hi", 1000), N("assistant", "a", 2000), N("assistant", "b", 3000), N("system", "x", 4000)];

	it("merges same-role, drops empty/unknown, advances cursor to end without beforeTimestamp", () => {
		const r = buildClineReadResult("p", msgs, null, undefined);
		expect(r.entries).toEqual([
			{ role: "human", content: "hi", timestamp: new Date(1000).toISOString() },
			{ role: "assistant", content: "a\n\nb", timestamp: new Date(2000).toISOString() },
		]);
		expect(r.newCursor.lineNumber).toBe(4);
		expect(r.totalLinesRead).toBe(4);
	});

	it("resumes from cursor index", () => {
		const r = buildClineReadResult("p", msgs, { transcriptPath: "p", lineNumber: 2, updatedAt: "" }, undefined);
		expect(r.entries).toEqual([{ role: "assistant", content: "b", timestamp: new Date(3000).toISOString() }]);
		expect(r.totalLinesRead).toBe(2);
	});

	it("beforeTimestamp stops at cutoff, cursor = last consumed", () => {
		const r = buildClineReadResult("p", msgs, null, new Date(2000).toISOString());
		expect(r.entries.map((e) => e.role)).toEqual(["human", "assistant"]);
		expect(r.newCursor.lineNumber).toBe(2); // msg[2] ts 3000 > cutoff → break
	});

	it("skips empty content but still advances consumed index", () => {
		const r = buildClineReadResult("p", [N("user", "", 1000), N("assistant", "hi", 2000)], null, undefined);
		expect(r.entries).toEqual([{ role: "assistant", content: "hi", timestamp: new Date(2000).toISOString() }]);
		expect(r.newCursor.lineNumber).toBe(2);
	});
});

describe("emptyClineReadResult", () => {
	it("preserves cursor index", () => {
		const r = emptyClineReadResult("p", { transcriptPath: "p", lineNumber: 7, updatedAt: "" });
		expect(r).toMatchObject({ entries: [], totalLinesRead: 0, newCursor: { lineNumber: 7 } });
	});
});
```

- [ ] **Step 3c: 写 `ClineCliTranscriptReader.ts`(薄:读文件 + 抽 text + 剥 `<user_input>` + 调共享)**

> CLI transcript = 单对象 `{messages:[{role, content:[{type,text?}], ts}]}`,user 文本包 `<user_input mode="...">…</user_input>`。

```ts
import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptReadResult } from "../Types.js";
import { buildClineReadResult, emptyClineReadResult, mapClineRole, type NormalizedMessage } from "./ClineTranscriptShared.js";

const log = createLogger("ClineCliReader");

interface ClineCliBlock {
	readonly type: string;
	readonly text?: string;
}
interface ClineCliMessage {
	readonly role?: string;
	readonly content?: ReadonlyArray<ClineCliBlock>;
	readonly ts?: number;
}
interface ClineCliFile {
	readonly messages?: ReadonlyArray<ClineCliMessage>;
}

const USER_INPUT_RE = /<user_input\b[^>]*>([\s\S]*?)<\/user_input>/i;

function unwrapUserInput(text: string): string {
	const m = USER_INPUT_RE.exec(text);
	return (m ? m[1] : text).trim();
}

function extractText(msg: ClineCliMessage): string {
	const parts: string[] = [];
	for (const block of msg.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

export async function readClineCliTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let parsed: ClineCliFile;
	try {
		parsed = JSON.parse(await readFile(transcriptPath, "utf8")) as ClineCliFile;
	} catch (error: unknown) {
		log.error("Failed to read Cline CLI transcript %s: %s", transcriptPath, (error as Error).message);
		return emptyClineReadResult(transcriptPath, cursor);
	}
	const messages: NormalizedMessage[] = (Array.isArray(parsed.messages) ? parsed.messages : []).map((msg) => {
		const role = mapClineRole(msg.role);
		const raw = extractText(msg);
		return { role, content: role === "human" ? unwrapUserInput(raw) : raw, ts: msg.ts };
	});
	return buildClineReadResult(transcriptPath, messages, cursor, beforeTimestamp);
}
```

- [ ] **Step 4: 写 `ClineCliTranscriptReader.test.ts`**

> Fixture 内联写入临时文件(脱敏:占位路径)。覆盖 text/thinking/tool_use/tool_result 全类型、`<user_input>` 剥壳、下标游标、beforeTimestamp、损坏文件。

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";

const FIXTURE = {
	version: 1,
	messages: [
		{ id: "m1", role: "user", content: [{ type: "text", text: '<user_input mode="act">hi</user_input>' }], ts: 1000 },
		{
			id: "m2",
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "planning" },
				{ type: "text", text: "Hi! How can I help?" },
			],
			ts: 2000,
		},
		{
			id: "m3",
			role: "assistant",
			content: [
				{ type: "text", text: "Running check" },
				{ type: "tool_use", id: "c1", name: "run_commands", input: { commands: ["git branch"] } },
			],
			ts: 3000,
		},
		{
			id: "m4",
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "c1", name: "run_commands", content: [{ result: "main" }] }],
			ts: 4000,
		},
		{ id: "m5", role: "assistant", content: [{ type: "text", text: "Branch is main" }], ts: 5000 },
	],
};

describe("readClineCliTranscript", () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cline-cli-rd-"));
		path = join(dir, "m.messages.json");
		await writeFile(path, JSON.stringify(FIXTURE), "utf8");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("extracts text blocks, strips <user_input>, drops thinking/tool blocks, merges same-role", async () => {
		const r = await readClineCliTranscript(path);
		// m1 human "hi"; m2+m3 assistant merged (thinking/tool_use dropped); m4 tool_result → empty → dropped; m5 assistant
		expect(r.entries).toEqual([
			{ role: "human", content: "hi", timestamp: new Date(1000).toISOString() },
			{
				role: "assistant",
				content: "Hi! How can I help?\n\nRunning check",
				timestamp: new Date(2000).toISOString(),
			},
			{ role: "assistant", content: "Branch is main", timestamp: new Date(5000).toISOString() },
		]);
		expect(r.newCursor.lineNumber).toBe(5);
		expect(r.totalLinesRead).toBe(5);
	});

	it("resumes from cursor.lineNumber", async () => {
		const r = await readClineCliTranscript(path, { transcriptPath: path, lineNumber: 4, updatedAt: "" });
		expect(r.entries).toEqual([
			{ role: "assistant", content: "Branch is main", timestamp: new Date(5000).toISOString() },
		]);
		expect(r.totalLinesRead).toBe(1);
	});

	it("honors beforeTimestamp (stops at first message past cutoff, advances cursor to consumed)", async () => {
		const r = await readClineCliTranscript(path, null, new Date(3000).toISOString());
		expect(r.entries.map((e) => e.role)).toEqual(["human", "assistant"]);
		expect(r.newCursor.lineNumber).toBe(3); // m1,m2,m3 consumed; m4 (ts 4000) > cutoff → break
	});

	it("returns empty result on unreadable file", async () => {
		const r = await readClineCliTranscript(join(dir, "missing.json"));
		expect(r.entries).toEqual([]);
		expect(r.totalLinesRead).toBe(0);
	});
});
```

- [ ] **Step 5: 写 `ClineCliSessionDiscoverer.ts`**

> 扫 `sessions/*/`,读 `<id>.json` sidecar,按 `workspace_root`(回退 `cwd`)归属;`updatedAt` = `<id>.messages.json` mtime;`transcriptPath` = sidecar `messages_path`;`title` = `metadata.title`;48h stale。

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getClineCliSessionsDir } from "./ClineCliDetector.js";
import type { ClineScanError } from "./ClineTranscriptShared.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("ClineCliDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { ClineScanError };

export interface ClineCliScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: ClineScanError;
}

interface ClineCliSidecar {
	readonly session_id?: string;
	readonly cwd?: string;
	readonly workspace_root?: string;
	readonly messages_path?: string;
	readonly metadata?: { readonly title?: string };
}

export async function scanClineCliSessions(
	projectDir: string,
	sessionsDir: string = getClineCliSessionsDir(),
): Promise<ClineCliScanResult> {
	let ids: string[];
	try {
		ids = await readdir(sessionsDir);
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { sessions: [] };
		return { sessions: [], error: { kind: "fs", message: (error as Error).message } };
	}

	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const target = normalizePathForCompare(projectDir);
	const sessions: SessionInfo[] = [];

	for (const id of ids) {
		const sidecarPath = join(sessionsDir, id, `${id}.json`);
		let meta: ClineCliSidecar;
		try {
			meta = JSON.parse(await readFile(sidecarPath, "utf8")) as ClineCliSidecar;
		} catch (error: unknown) {
			log.debug("Skipping %s: sidecar read/parse failed (%s)", id, (error as Error).message);
			continue;
		}
		const root = meta.workspace_root ?? meta.cwd;
		if (typeof root !== "string" || normalizePathForCompare(root) !== target) continue;
		const messagesPath = meta.messages_path ?? join(sessionsDir, id, `${id}.messages.json`);
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(messagesPath)).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs < cutoffMs) continue;
		const title = meta.metadata?.title?.trim();
		sessions.push({
			sessionId: meta.session_id ?? id,
			transcriptPath: messagesPath,
			updatedAt: new Date(mtimeMs).toISOString(),
			source: "cline-cli",
			...(title ? { title } : {}),
		});
	}
	return { sessions };
}

/** QueueWorker wrapper — strips the error channel. */
export async function discoverClineCliSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanClineCliSessions(projectDir);
	if (error) log.warn("Cline CLI scan error (%s): %s", error.kind, error.message);
	return sessions;
}
```

- [ ] **Step 6: 写 `ClineCliSessionDiscoverer.test.ts`**

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClineCliSessions, scanClineCliSessions } from "./ClineCliSessionDiscoverer.js";

async function writeSession(sessionsDir: string, id: string, sidecar: object): Promise<void> {
	const dir = join(sessionsDir, id);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${id}.json`), JSON.stringify(sidecar), "utf8");
	await writeFile(join(dir, `${id}.messages.json`), JSON.stringify({ messages: [] }), "utf8");
}

describe("scanClineCliSessions", () => {
	let sessionsDir: string;
	const project = "/tmp/proj-a";
	beforeEach(async () => {
		sessionsDir = await mkdtemp(join(tmpdir(), "cline-cli-disc-"));
	});
	afterEach(async () => {
		await rm(sessionsDir, { recursive: true, force: true });
	});

	it("returns empty (no error) when sessions dir absent", async () => {
		const r = await scanClineCliSessions(project, join(sessionsDir, "nope"));
		expect(r).toEqual({ sessions: [] });
	});

	it("attributes by workspace_root, sets source/title, uses messages.json mtime", async () => {
		await writeSession(sessionsDir, "s1", {
			session_id: "s1",
			workspace_root: project,
			messages_path: join(sessionsDir, "s1", "s1.messages.json"),
			metadata: { title: "fix bug" },
		});
		await writeSession(sessionsDir, "s2", { session_id: "s2", workspace_root: "/tmp/other" });
		const r = await scanClineCliSessions(project, sessionsDir);
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({ sessionId: "s1", source: "cline-cli", title: "fix bug" });
		expect(r.sessions[0].transcriptPath).toContain("s1.messages.json");
	});

	it("falls back to cwd when workspace_root missing; skips corrupt sidecar", async () => {
		await writeSession(sessionsDir, "s3", { session_id: "s3", cwd: project });
		await mkdir(join(sessionsDir, "s4"), { recursive: true });
		await writeFile(join(sessionsDir, "s4", "s4.json"), "{ not json", "utf8");
		const r = await scanClineCliSessions(project, sessionsDir);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["s3"]);
	});

	it("discoverClineCliSessions strips error channel", async () => {
		const sessions = await discoverClineCliSessions(project);
		expect(Array.isArray(sessions)).toBe(true);
	});
});
```

---

## Task 2: Cline 扩展三件套(source id `cline`,跨 VS Code flavor)

**Files:**
- Modify: `cli/src/core/VscodeWorkspaceLocator.ts:24`(扩 `VscodeFlavor` + 新增 `ALL_VSCODE_FLAVORS`)
- Create: `cli/src/core/ClineDetector.ts` / `ClineSessionDiscoverer.ts` / `ClineTranscriptReader.ts`
- Test: 各 `.test.ts` + `VscodeWorkspaceLocator.test.ts`(补 `ALL_VSCODE_FLAVORS` 断言,若该测试文件存在)

**Interfaces:**
- Consumes:`buildClineReadResult` / `mapClineRole` / `emptyClineReadResult` / `NormalizedMessage` / `ClineScanError`(from `ClineTranscriptShared.ts`,Task 1)、`getVscodeUserDataDir(flavor, home?)`
- Produces（供 Task 3):
  - `export const ALL_VSCODE_FLAVORS: ReadonlyArray<VscodeFlavor>`（VscodeWorkspaceLocator.ts)
  - `isClineInstalled(home?: string): Promise<boolean>`、`getClineStorageDirs(home?: string): string[]`
  - `interface ClineScanResult { readonly sessions: ReadonlyArray<SessionInfo>; readonly error?: ClineScanError }`
  - `scanClineSessions(projectDir: string, storageDirs?: string[]): Promise<ClineScanResult>`
  - `discoverClineSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>>`
  - `readClineTranscript(transcriptPath: string, cursor?: TranscriptCursor | null, beforeTimestamp?: string): Promise<TranscriptReadResult>`

- [ ] **Step 1: 扩 `VscodeWorkspaceLocator.ts` 的 `VscodeFlavor` union + 导出 `ALL_VSCODE_FLAVORS`**

改 line 24:

```ts
export type VscodeFlavor = "Cursor" | "Code" | "Code - Insiders" | "VSCodium" | "Windsurf";

/** All VS Code-family flavors Jolli scans for extension data. Directory name == flavor string. */
export const ALL_VSCODE_FLAVORS: ReadonlyArray<VscodeFlavor> = [
	"Code",
	"Code - Insiders",
	"Cursor",
	"VSCodium",
	"Windsurf",
];
```

> `getVscodeUserDataDir` 用 `join(..., flavor)`,flavor 字符串即目录名,新增成员无需改其 body。现有 `"Cursor"`/`"Code"` 字面量调用点(Cursor/CopilotChat)不受 union 变宽影响。

- [ ] **Step 2: 写 `ClineDetector.ts`**

```ts
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_VSCODE_FLAVORS, getVscodeUserDataDir } from "./VscodeWorkspaceLocator.js";

const EXTENSION_ID = "saoudrizwan.claude-dev";

/** globalStorage dir for the Cline extension under one VS Code flavor. */
function flavorStorageDir(flavor: (typeof ALL_VSCODE_FLAVORS)[number], home: string): string {
	return join(getVscodeUserDataDir(flavor, home), "User", "globalStorage", EXTENSION_ID);
}

/** Existing-or-not, one entry per flavor (caller filters). */
export function getClineStorageDirs(home: string = homedir()): string[] {
	return ALL_VSCODE_FLAVORS.map((f) => flavorStorageDir(f, home));
}

export async function isClineInstalled(home: string = homedir()): Promise<boolean> {
	for (const dir of getClineStorageDirs(home)) {
		try {
			await access(join(dir, "state", "taskHistory.json"));
			return true;
		} catch {
			// try next flavor
		}
	}
	return false;
}
```

- [ ] **Step 3: 写 `ClineDetector.test.ts`**

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClineStorageDirs, isClineInstalled } from "./ClineDetector.js";

describe("ClineDetector", () => {
	let home: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "cline-ext-det-"));
	});
	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("returns one storage dir per flavor", () => {
		const dirs = getClineStorageDirs(home);
		expect(dirs.length).toBeGreaterThanOrEqual(5);
		expect(dirs.some((d) => d.includes("saoudrizwan.claude-dev"))).toBe(true);
	});

	it("false when no flavor has taskHistory.json", async () => {
		expect(await isClineInstalled(home)).toBe(false);
	});

	it("true when any flavor has taskHistory.json", async () => {
		// darwin layout: <home>/Library/Application Support/Code/User/globalStorage/<ext>/state/
		const stateDir = join(getClineStorageDirs(home)[0], "state");
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, "taskHistory.json"), "[]", "utf8");
		expect(await isClineInstalled(home)).toBe(true);
	});
});
```

> 注:`getClineStorageDirs(home)[0]` 对应 `ALL_VSCODE_FLAVORS[0] = "Code"`。测试用真实平台布局(`getVscodeUserDataDir` 已按 platform 分支),无需 mock。

- [ ] **Step 4: 写 `ClineTranscriptReader.ts`**

> 扩展 transcript = `api_conversation_history.json`,**顶层数组** `[{role, content:[Anthropic blocks], ts}]`,无 `<user_input>` 壳。薄:读文件 + 抽 text + 归一化 + 调 Task 1 的 `buildClineReadResult`。

```ts
import { readFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import type { TranscriptCursor, TranscriptReadResult } from "../Types.js";
import { buildClineReadResult, emptyClineReadResult, mapClineRole, type NormalizedMessage } from "./ClineTranscriptShared.js";

const log = createLogger("ClineReader");

interface AnthropicBlock {
	readonly type: string;
	readonly text?: string;
}
interface ExtMessage {
	readonly role?: string;
	readonly content?: ReadonlyArray<AnthropicBlock> | string;
	readonly ts?: number;
}

function extractText(msg: ExtMessage): string {
	if (typeof msg.content === "string") return msg.content.trim();
	const parts: string[] = [];
	for (const block of msg.content ?? []) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

export async function readClineTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor | null,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw: ExtMessage[];
	try {
		const parsed = JSON.parse(await readFile(transcriptPath, "utf8")) as unknown;
		raw = Array.isArray(parsed) ? (parsed as ExtMessage[]) : [];
	} catch (error: unknown) {
		log.error("Failed to read Cline transcript %s: %s", transcriptPath, (error as Error).message);
		return emptyClineReadResult(transcriptPath, cursor);
	}
	const messages: NormalizedMessage[] = raw.map((msg) => ({
		role: mapClineRole(msg.role),
		content: extractText(msg),
		ts: msg.ts,
	}));
	return buildClineReadResult(transcriptPath, messages, cursor, beforeTimestamp);
}
```

- [ ] **Step 5: 写 `ClineTranscriptReader.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClineTranscript } from "./ClineTranscriptReader.js";

const FIXTURE = [
	{ role: "user", content: [{ type: "text", text: "env" }, { type: "text", text: "查看当前分支" }], ts: 1000 },
	{ role: "assistant", content: [{ type: "thinking", text: "plan" }, { type: "text", text: "分支是 main" }], ts: 2000 },
	{ role: "assistant", content: [{ type: "text", text: "done" }], ts: 3000 },
];

describe("readClineTranscript", () => {
	let dir: string;
	let path: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cline-ext-rd-"));
		path = join(dir, "api_conversation_history.json");
		await writeFile(path, JSON.stringify(FIXTURE), "utf8");
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("joins text blocks, drops thinking, merges same-role, no <user_input> stripping", async () => {
		const r = await readClineTranscript(path);
		expect(r.entries).toEqual([
			{ role: "human", content: "env\n查看当前分支", timestamp: new Date(1000).toISOString() },
			{ role: "assistant", content: "分支是 main\n\ndone", timestamp: new Date(2000).toISOString() },
		]);
		expect(r.newCursor.lineNumber).toBe(3);
	});

	it("honors cursor + beforeTimestamp", async () => {
		const r = await readClineTranscript(path, { transcriptPath: path, lineNumber: 2, updatedAt: "" });
		expect(r.entries).toEqual([{ role: "assistant", content: "done", timestamp: new Date(3000).toISOString() }]);
		const cut = await readClineTranscript(path, null, new Date(1500).toISOString());
		expect(cut.entries.map((e) => e.role)).toEqual(["human"]);
		expect(cut.newCursor.lineNumber).toBe(1);
	});

	it("empty on bad file", async () => {
		const r = await readClineTranscript(join(dir, "nope.json"));
		expect(r.entries).toEqual([]);
	});
});
```

- [ ] **Step 6: 写 `ClineSessionDiscoverer.ts`**

> 遍历各 flavor 的 `state/taskHistory.json`(数组),按 `cwdOnTaskInitialization` 归属;`updatedAt` = 条目 `ts`;`transcriptPath` = 该 flavor `tasks/<id>/api_conversation_history.json`;`title` = `task`;48h stale。

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import type { SessionInfo } from "../Types.js";
import { getClineStorageDirs } from "./ClineDetector.js";
import type { ClineScanError } from "./ClineTranscriptShared.js";
import { normalizePathForCompare } from "./PathUtils.js";

const log = createLogger("ClineDiscoverer");
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export type { ClineScanError };

export interface ClineScanResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly error?: ClineScanError;
}

interface TaskHistoryEntry {
	readonly id?: string;
	readonly ts?: number;
	readonly task?: string;
	readonly cwdOnTaskInitialization?: string;
}

async function scanFlavor(storageDir: string, target: string, cutoffMs: number): Promise<SessionInfo[]> {
	const historyPath = join(storageDir, "state", "taskHistory.json");
	let entries: TaskHistoryEntry[];
	try {
		const parsed = JSON.parse(await readFile(historyPath, "utf8")) as unknown;
		entries = Array.isArray(parsed) ? (parsed as TaskHistoryEntry[]) : [];
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: SessionInfo[] = [];
	for (const e of entries) {
		if (typeof e.id !== "string" || typeof e.cwdOnTaskInitialization !== "string") continue;
		if (normalizePathForCompare(e.cwdOnTaskInitialization) !== target) continue;
		if (typeof e.ts === "number" && e.ts < cutoffMs) continue;
		const title = e.task?.trim();
		out.push({
			sessionId: e.id,
			transcriptPath: join(storageDir, "tasks", e.id, "api_conversation_history.json"),
			updatedAt: new Date(typeof e.ts === "number" ? e.ts : Date.now()).toISOString(),
			source: "cline",
			...(title ? { title } : {}),
		});
	}
	return out;
}

export async function scanClineSessions(
	projectDir: string,
	storageDirs: string[] = getClineStorageDirs(),
): Promise<ClineScanResult> {
	const target = normalizePathForCompare(projectDir);
	const cutoffMs = Date.now() - SESSION_STALE_MS;
	const sessions: SessionInfo[] = [];
	let error: ClineScanError | undefined;
	for (const dir of storageDirs) {
		try {
			sessions.push(...(await scanFlavor(dir, target, cutoffMs)));
		} catch (err: unknown) {
			log.warn("Cline flavor scan failed at %s: %s", dir, (err as Error).message);
			error = error ?? { kind: "parse", message: (err as Error).message };
		}
	}
	return error ? { sessions, error } : { sessions };
}

/** QueueWorker wrapper — strips the error channel. */
export async function discoverClineSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>> {
	const { sessions, error } = await scanClineSessions(projectDir);
	if (error) log.warn("Cline scan error (%s): %s", error.kind, error.message);
	return sessions;
}
```

- [ ] **Step 7: 写 `ClineSessionDiscoverer.test.ts`**

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverClineSessions, scanClineSessions } from "./ClineSessionDiscoverer.js";

async function writeHistory(storageDir: string, entries: object[]): Promise<void> {
	const stateDir = join(storageDir, "state");
	await mkdir(stateDir, { recursive: true });
	await writeFile(join(stateDir, "taskHistory.json"), JSON.stringify(entries), "utf8");
}

describe("scanClineSessions", () => {
	let sd: string;
	const project = "/tmp/proj-a";
	beforeEach(async () => {
		sd = await mkdtemp(join(tmpdir(), "cline-ext-disc-"));
	});
	afterEach(async () => {
		await rm(sd, { recursive: true, force: true });
	});

	it("empty when no flavor has history (ENOENT ignored, no error)", async () => {
		const r = await scanClineSessions(project, [join(sd, "flavorX")]);
		expect(r).toEqual({ sessions: [] });
	});

	it("attributes by cwdOnTaskInitialization, sets source/title/transcriptPath", async () => {
		await writeHistory(sd, [
			{ id: "t1", ts: Date.now(), task: "查看分支", cwdOnTaskInitialization: project },
			{ id: "t2", ts: Date.now(), task: "other", cwdOnTaskInitialization: "/tmp/other" },
		]);
		const r = await scanClineSessions(project, [sd]);
		expect(r.sessions).toHaveLength(1);
		expect(r.sessions[0]).toMatchObject({ sessionId: "t1", source: "cline", title: "查看分支" });
		expect(r.sessions[0].transcriptPath).toBe(join(sd, "tasks", "t1", "api_conversation_history.json"));
	});

	it("merges across flavors; reports error on corrupt history", async () => {
		await writeHistory(sd, [{ id: "t1", ts: Date.now(), cwdOnTaskInitialization: project }]);
		const bad = await mkdtemp(join(tmpdir(), "cline-bad-"));
		await mkdir(join(bad, "state"), { recursive: true });
		await writeFile(join(bad, "state", "taskHistory.json"), "{ not array", "utf8");
		const r = await scanClineSessions(project, [sd, bad]);
		expect(r.sessions.map((s) => s.sessionId)).toEqual(["t1"]);
		expect(r.error?.kind).toBe("parse");
		await rm(bad, { recursive: true, force: true });
	});

	it("discoverClineSessions strips error channel", async () => {
		expect(Array.isArray(await discoverClineSessions(project))).toBe(true);
	});
});
```

---

## Task 3: 注册 + dispatch 接线(让两源流入 summary 管线)

**Files（均 Modify,锚点为当前行号,实现时以 grep 确认）:**
- `cli/src/Types.ts`(TRANSCRIPT_SOURCES:17 / import:7-8 / JolliMemoryConfig:~1088 / StatusInfo:~1317)
- `cli/src/core/TranscriptSourceLabel.ts`、`QueueWorker.ts`、`TranscriptMessageCounter.ts`、`TranscriptLoader.ts`、`ActiveSessionAggregator.ts`、`SessionTracker.ts`、`SessionTitleResolver.ts`

**Interfaces:** Consumes Task 1/2 的全部导出。

- [ ] **Step 1: `Types.ts` — 加两源 id + 复用 ClineScanError import + config flag + StatusInfo 合并字段**

`TRANSCRIPT_SOURCES`(line 17 数组末尾)加:
```ts
	"cline",
	"cline-cli",
```
import 区(line 7-8 附近)加:
```ts
import type { ClineScanError } from "./core/ClineTranscriptShared.js";
```
`JolliMemoryConfig` 在 `copilotEnabled` 后加:
```ts
	/** Enable Cline (VS Code extension + CLI) session discovery at post-commit time (default: auto-detect) */
	readonly clineEnabled?: boolean;
```
`StatusInfo` 在 copilotChat 字段后加(**合并单组**):
```ts
	/** Whether any Cline surface (VS Code extension globalStorage or ~/.cline CLI) was detected */
	readonly clineDetected?: boolean;
	/** Whether Cline session discovery is enabled in config (undefined = auto-detect) */
	readonly clineEnabled?: boolean;
	/** Cline scan failed with a real error (non-ENOENT): parse / fs / schema. */
	readonly clineScanError?: ClineScanError;
```

- [ ] **Step 2: `TranscriptSourceLabel.ts` — 加两 label(`TRANSCRIPT_SOURCE_LABELS` 是 `Record<TranscriptSource,string>`,不加不编译)**

```ts
	cline: "Cline (VS Code)",
	"cline-cli": "Cline CLI",
```

- [ ] **Step 3: `SessionTitleResolver.ts` — `PARSE_LINE` 加两 stub(两源 discoverer 均带 title,仿 `parseCursorUserLine`)**

map(line 27-35)加:
```ts
	cline: parseClineUserLine,
	"cline-cli": parseClineCliUserLine,
```
新增两函数:
```ts
function parseClineUserLine(_line: string): string | undefined {
	// Cline extension sessions carry SessionInfo.title from taskHistory.task.
	return undefined;
}
function parseClineCliUserLine(_line: string): string | undefined {
	// Cline CLI sessions carry SessionInfo.title from sidecar metadata.title.
	return undefined;
}
```

- [ ] **Step 4: `TranscriptLoader.ts` — 两个 single-artifact 分支 + `JsonlSource` exclude**

在 cursor 分支(line 64-75)后加:
```ts
	if (opts.source === "cline") {
		try {
			const { readClineTranscript } = await import("./ClineTranscriptReader.js");
			return [...(await readClineTranscript(opts.transcriptPath)).entries];
		} catch (err) {
			if (!isEnoent(err)) log.warn("loadTranscript (cline) failed for %s: %s", opts.transcriptPath, errMsg(err));
			return [];
		}
	}
	if (opts.source === "cline-cli") {
		try {
			const { readClineCliTranscript } = await import("./ClineCliTranscriptReader.js");
			return [...(await readClineCliTranscript(opts.transcriptPath)).entries];
		} catch (err) {
			if (!isEnoent(err)) log.warn("loadTranscript (cline-cli) failed for %s: %s", opts.transcriptPath, errMsg(err));
			return [];
		}
	}
```
`JsonlSource`(line 137)加两 exclude:
```ts
type JsonlSource = Exclude<TranscriptSource, "gemini" | "opencode" | "cursor" | "copilot" | "cline" | "cline-cli">;
```

- [ ] **Step 5: `TranscriptMessageCounter.ts` — imports + switch 两 case**

import 区加:
```ts
import { readClineTranscript } from "./ClineTranscriptReader.js";
import { readClineCliTranscript } from "./ClineCliTranscriptReader.js";
```
switch(line 122-140)在 `case "copilot-chat"` 后加:
```ts
		case "cline":
			return readClineTranscript(transcriptPath, cursor);
		case "cline-cli":
			return readClineCliTranscript(transcriptPath, cursor);
```

- [ ] **Step 6: `QueueWorker.ts` — imports + 发现循环两块 + reader dispatch 两 arm**

import 区(line 39-41 附近)加:
```ts
import { isClineInstalled } from "../core/ClineDetector.js";
import { discoverClineSessions } from "../core/ClineSessionDiscoverer.js";
import { readClineTranscript } from "../core/ClineTranscriptReader.js";
import { isClineCliInstalled } from "../core/ClineCliDetector.js";
import { discoverClineCliSessions } from "../core/ClineCliSessionDiscoverer.js";
import { readClineCliTranscript } from "../core/ClineCliTranscriptReader.js";
```
发现循环(cursor 块 line 3168-3175 后)加:
```ts
		// Discover Cline VS Code extension sessions (plain-JSON scan across VS Code flavors).
		if (config.clineEnabled !== false && (await isClineInstalled())) {
			const clineSessions = await discoverClineSessions(cwd);
			if (clineSessions.length > 0) {
				allSessions = [...allSessions, ...clineSessions];
				log.info("Discovered %d Cline (VS Code) session(s)", clineSessions.length);
			}
		}
		// Discover Cline CLI sessions (plain-JSON scan of ~/.cline/data/sessions).
		if (config.clineEnabled !== false && (await isClineCliInstalled())) {
			const clineCliSessions = await discoverClineCliSessions(cwd);
			if (clineCliSessions.length > 0) {
				allSessions = [...allSessions, ...clineCliSessions];
				log.info("Discovered %d Cline CLI session(s)", clineCliSessions.length);
			}
		}
```
reader dispatch(copilot-chat arm line 3452-3458 后)加:
```ts
		} else if (source === "cline") {
			try {
				result = await readClineTranscript(session.transcriptPath, cursor, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping Cline session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
		} else if (source === "cline-cli") {
			try {
				result = await readClineCliTranscript(session.transcriptPath, cursor, beforeTimestamp);
			} catch (error: unknown) {
				log.error("Skipping Cline CLI session %s: %s", session.sessionId, (error as Error).message);
				continue;
			}
```

- [ ] **Step 7: `SessionTracker.ts` — `filterSessionsByEnabledIntegrations` 加合并过滤(copilot 双源单开关模型)**

在 copilot 过滤(line 182-184)后加:
```ts
	if (config.clineEnabled === false) {
		filtered = filtered.filter((s) => s.source !== "cline" && s.source !== "cline-cli");
	}
```

- [ ] **Step 8: `ActiveSessionAggregator.ts` — Promise.all 加两 loader + 两函数(仿 `loadCursor`)**

`Promise.all`(line 218-225)加:
```ts
		loadCline(cwd),
		loadClineCli(cwd),
```
新增两函数(仿 `loadCursor` 261-274):
```ts
async function loadCline(cwd: string): Promise<LoaderResult> {
	try {
		const { scanClineSessions } = await import("./ClineSessionDiscoverer.js");
		const r = await scanClineSessions(cwd);
		if (r.error) {
			log.warn("scanClineSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cline"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanClineSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cline"] };
	}
}
async function loadClineCli(cwd: string): Promise<LoaderResult> {
	try {
		const { scanClineCliSessions } = await import("./ClineCliSessionDiscoverer.js");
		const r = await scanClineCliSessions(cwd);
		if (r.error) {
			log.warn("scanClineCliSessions reported %s: %s", r.error.kind, r.error.message);
			return { sessions: r.sessions, failed: ["cline-cli"] };
		}
		return { sessions: r.sessions, failed: [] };
	} catch (err) {
		log.warn("scanClineCliSessions threw: %s", errMsg(err));
		return { sessions: [], failed: ["cline-cli"] };
	}
}
```

> 若 `LoaderResult.failed` 是 `TranscriptSource[]` 之外的枚举,`"cline"/"cline-cli"` 已在 union 内(Task 3 Step 1),类型安全。

- [ ] **Step 9: 更新共享 dispatch 测试**

为 `TranscriptMessageCounter.test.ts`(+`.dispatch.test.ts` 若存在)、`TranscriptLoader.test.ts`、`ActiveSessionAggregator.test.ts`、`SessionTracker.test.ts`、`SessionTitleResolver.test.ts`、`TranscriptSourceLabel.test.ts`、`QueueWorker.test.ts` 各补 `cline` / `cline-cli` 分支断言,镜像现有 `cursor` / `copilot-chat` 用例。示例(SessionTracker):

```ts
it("clineEnabled:false drops cline + cline-cli", () => {
	const sessions = [
		{ sessionId: "a", transcriptPath: "", updatedAt: "", source: "cline" as const },
		{ sessionId: "b", transcriptPath: "", updatedAt: "", source: "cline-cli" as const },
		{ sessionId: "c", transcriptPath: "", updatedAt: "", source: "claude" as const },
	];
	const out = filterSessionsByEnabledIntegrations(sessions, { clineEnabled: false });
	expect(out.map((s) => s.source)).toEqual(["claude"]);
});
```

示例(TranscriptSourceLabel):
```ts
expect(TRANSCRIPT_SOURCE_LABELS.cline).toBe("Cline (VS Code)");
expect(TRANSCRIPT_SOURCE_LABELS["cline-cli"]).toBe("Cline CLI");
```

---

## Task 4: Install / Status / Configure 表面(合并展示单开关)

**Files:** `cli/src/install/Installer.ts`、`cli/src/commands/StatusCommand.ts`、`cli/src/commands/ConfigureCommand.ts` + 对应 `.test.ts`

- [ ] **Step 1: `Installer.ts` — detector import + 合并检测 + auto-enable + status scan + status 对象 + 日志**

import(line 27-28 附近):
```ts
import { isClineInstalled } from "../core/ClineDetector.js";
import { scanClineSessions } from "../core/ClineSessionDiscoverer.js";
import { isClineCliInstalled } from "../core/ClineCliDetector.js";
import { scanClineCliSessions } from "../core/ClineCliSessionDiscoverer.js";
```
once-before-loop(line 263-268 后)加:
```ts
			const clineDetectedOnce = (await isClineInstalled()) || (await isClineCliInstalled());
```
auto-enable(cursor 块 line 461-468 后)加:
```ts
			// Auto-detect Cline (extension or CLI) and enable session discovery
			if (clineDetectedOnce && config.clineEnabled === undefined) {
				await saveConfig({ clineEnabled: true });
				log.info("Cline detected — enabled Cline session discovery");
			}
```
`getStatus` 检测(line 782-788 后)加:
```ts
	const clineDetected = (await isClineInstalled()) || (await isClineCliInstalled());
```
on-demand scan(cursor scan line 830-838 后)加(**合并两源 session + 合并 error**):
```ts
	// Discover Cline sessions on-demand (extension + CLI), merged under one row.
	let clineScanError: ClineScanError | undefined;
	if (config.clineEnabled !== false && clineDetected) {
		const ext = await scanClineSessions(projectDir);
		const cli = await scanClineCliSessions(projectDir);
		const merged = [...ext.sessions, ...cli.sessions];
		if (merged.length > 0) allEnabledSessions = [...allEnabledSessions, ...merged];
		clineScanError = ext.error ?? cli.error;
	}
```
> `ClineScanError` 从 `../core/ClineTranscriptShared.js` import type(与 Types.ts 同源)。
status 对象(line 950-957 内)加:
```ts
		clineDetected,
		clineEnabled: config.clineEnabled,
		clineScanError,
```
status 日志(line 969-990):在格式串末尾加 `, cline=%s/%s`,并在参数列表末尾(`status.copilotChatDetected` 后)加 `status.clineDetected, status.clineEnabled`。

- [ ] **Step 2: `StatusCommand.ts` — `integrationRows` 合并单行 "Cline"(仿 Copilot 双源行 379-389)**

在 Copilot 行后加:
```ts
				[
					"Cline:",
					status.clineDetected ?? false,
					{
						enabled: status.clineEnabled !== false,
						hookInstalled: undefined,
						sessionCount: (counts.cline ?? 0) + (counts["cline-cli"] ?? 0),
						scanError: status.clineScanError,
					},
				],
```

- [ ] **Step 3: `ConfigureCommand.ts` — `clineEnabled` 三处(keys / boolean guard / descriptions)**

`VALID_CONFIG_KEYS`(line 58-59 后)加 `"clineEnabled",`。
`coerceConfigValue` boolean guard(line 128-138)在 `key === "copilotEnabled" ||` 后加 `key === "clineEnabled" ||`。
`CONFIG_KEY_INFO`(copilot entry 217-221 后)加:
```ts
	{
		key: "clineEnabled",
		type: "boolean",
		description: "Enable Cline (VS Code extension + CLI) session discovery (true/false)",
	},
```

- [ ] **Step 4: 更新 `Installer.test.ts` / `StatusCommand.test.ts` / `ConfigureCommand.test.ts`**

镜像 cursor/copilot 断言,补:Installer auto-enable 在检测到 Cline 时写 `clineEnabled:true`;StatusCommand 渲染 "Cline:" 行且 sessionCount 合并两源;ConfigureCommand 接受 `clineEnabled=true/false` 且拒非布尔。示例(ConfigureCommand):
```ts
it("coerces clineEnabled", () => {
	expect(coerceConfigValue("clineEnabled", "true")).toBe(true);
	expect(() => coerceConfigValue("clineEnabled", "maybe")).toThrow();
});
```

---

## Task 5: 集中验证 + 单次提交(用户偏好:全程唯一 run + commit)

- [ ] **Step 1: 全量校验**

```bash
cd /Users/flyer/jolli/code/jollimemory && npm run all
```
Expected: clean → build → lint → test 全绿;CLI 覆盖率 ≥ 97/96/97/97。若某新分支未覆盖,回到对应 task 补测试(仍不单独 commit)。

- [ ] **Step 2: grep 自检两源已在所有穷举点**

```bash
cd /Users/flyer/jolli/code/jollimemory/cli && \
grep -rn '"cline-cli"\|"cline"' src/core/TranscriptSourceLabel.ts src/core/SessionTitleResolver.ts src/core/TranscriptLoader.ts && \
grep -rn 'clineEnabled' src/Types.ts src/commands/ConfigureCommand.ts src/core/SessionTracker.ts
```
Expected: 每处均命中。

- [ ] **Step 3: 补英文版 spec(仓库约定 `.en.md`)**

将 `docs/superpowers/specs/2026-07-18-cline-cli-source-design.md` 译为 `2026-07-18-cline-cli-source-design.en.md`(英文,内容对齐)。

- [ ] **Step 4: 单次提交(DCO,无 Claude 署名)**

```bash
cd /Users/flyer/jolli/code/jollimemory && git add -A && git commit -s -m "feat: add Cline VS Code extension + CLI session sources"
```

---

## Self-Review(spec 覆盖对照)

- ✅ 两独立源三件套(Task 1/2)、单 `clineEnabled` flag(Task 3.1 / 3.7 / 4)、跨 flavor 扫描(Task 2.1)、Status 合并(Task 4.2)、发现层不读 SQLite(Task 1/2 均明文)、真实字节形状(fixture 内联脱敏,源自本机 capture)。
- ✅ 无 tool-block 表示 → 两 reader 只抽 text(Task 1.3 / 2.4),与 `TranscriptEntry` 约束一致。
- ✅ 每处穷举点(TRANSCRIPT_SOURCES 驱动的 `Record<TranscriptSource,…>`:TranscriptSourceLabel、SessionTitleResolver)均在 Task 3 覆盖。
- ✅ 提交纪律(用户裁决):每 task commit(-s,无 Claude 署名)但不每 task 跑 `npm run all`;全量门只在 Task 5。
- ✅ reader 去重(用户裁决):游标/合并/beforeTimestamp 逻辑抽入 `ClineTranscriptShared.buildClineReadResult`,两 reader 只留文件解析 + 归一化,消除逐字重复。
- 待实现期确认(spec 未决项,非阻塞):`CLINE_DIR`/XDG 覆盖;补一份扩展"原生 tool_use" fixture(当前 fixture 已含 text/thinking,tool_use 被丢弃故不影响正确性);`metadata.git.branch` 增强归属(YAGNI,未纳入)。
