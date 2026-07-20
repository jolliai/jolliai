# Antigravity transcript source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Antigravity（Google Gemini agentic IDE/CLI）接入为第 8 个 transcript source，让其对话在 post-commit 时被读取并生成 summary。

**Architecture:** 直接扫描发现（方案 A，无 hook）。detector + discoverer + reader 三件套，对标现有 `Cursor*` 源：discoverer 用 `node:sqlite` 读每个 `~/.gemini/<variant>/conversations/<convId>.db` 的 `trajectory_metadata_blob` 提取 workspace 路径做归属；reader 读旁挂的明文 `brain/<convId>/.system_generated/logs/transcript_full.jsonl`。

**Tech Stack:** TypeScript (ESM), Node 22.5+ `node:sqlite`, Vitest, Biome. VSCode 侧 esbuild bundle。

设计依据：[`docs/superpowers/specs/2026-07-19-antigravity-support-design.md`](../specs/2026-07-19-antigravity-support-design.md)。

## Global Constraints

- 每个 commit 必须 `git commit -s`（DCO）；**不加** `Co-Authored-By: Claude` / `🤖 Generated with` footer。
- `npm run all`（clean→build→lint→test）必须通过；本计划把它集中到最后一个 task 一次性跑，**每个 task 内只写代码（测试+实现），不插入 run/commit step**。
- CLI 覆盖率门槛：97% statements / 96% branches / 97% functions / 97% lines（`cli/vite.config.ts`）。
- Biome：Tab 缩进 4 宽、120 列；`noExplicitAny: error`、`noUnusedImports/Variables: error`。CI 跑 `biome check --error-on-warnings`。
- 路径归一化只用 `toForwardSlash` / `normalizePathForCompare`（`cli/src/core/PathUtils.ts`），禁止内联 `replace(/\\/g,"/")`。
- 三变体全扫：`antigravity`、`antigravity-ide`、`antigravity-cli`，根均在 `~/.gemini/<variant>/`。
- reader 读 `transcript_full.jsonl`（非 `transcript.jsonl`）。
- 覆盖率豁免只用 `/* v8 ignore start/stop */` 块（单行 `ignore next` 在本仓库不生效）。
- `node:sqlite` 走 lazy-import + `hasNodeSqliteSupport()` 门控（VSCode bundle 目标 Node 18，缺模块要静默降级），与 opencode/cursor 一致。

---

### Task 1: Types & label 基础

**Files:**
- Modify: `cli/src/Types.ts`（`TRANSCRIPT_SOURCES`、`JolliMemoryConfig`、`StatusInfo`）
- Modify: `cli/src/core/TranscriptSourceLabel.ts`
- Test: `cli/src/core/TranscriptSourceLabel.test.ts`

**Interfaces:**
- Produces: `TranscriptSource` union 含 `"antigravity"`；`JolliMemoryConfig.antigravityEnabled?: boolean`；`StatusInfo.antigravityDetected?/antigravityEnabled?/antigravityScanError?: ...`；`TRANSCRIPT_SOURCE_LABELS.antigravity === "Antigravity"`。

- [ ] **Step 1: 写 label 失败测试**

在 `TranscriptSourceLabel.test.ts` 追加：

```typescript
it("labels antigravity", () => {
	expect(transcriptSourceLabel("antigravity")).toBe("Antigravity");
});
```

- [ ] **Step 2: 实现**

`cli/src/Types.ts`：`TRANSCRIPT_SOURCES` 数组末尾加 `"antigravity",`。在 `JolliMemoryConfig` 中（`cursorEnabled` 旁）加 `readonly antigravityEnabled?: boolean;`（同一 interface 若有第二处 config 镜像，一并加）。在 `StatusInfo`（`cursorDetected` 旁）加：

```typescript
	readonly antigravityDetected?: boolean;
	readonly antigravityEnabled?: boolean;
	readonly antigravityScanError?: SqliteScanError;
```

`cli/src/core/TranscriptSourceLabel.ts`：`TRANSCRIPT_SOURCE_LABELS` 加 `antigravity: "Antigravity",`（穷举 `Record<TranscriptSource,string>`，不加则本 task 与后续 task 均不过编译）。

---

### Task 2: AntigravityDetector

**Files:**
- Create: `cli/src/core/AntigravityDetector.ts`
- Test: `cli/src/core/AntigravityDetector.test.ts`

**Interfaces:**
- Consumes: `hasNodeSqliteSupport` from `cli/src/core/SqliteHelpers.js`。
- Produces:
  - `ANTIGRAVITY_VARIANTS: readonly ["antigravity","antigravity-ide","antigravity-cli"]`
  - `interface AntigravityVariantDirs { variant: string; root: string; conversationsDir: string; brainDir: string }`
  - `getAntigravityVariants(home?: string): AntigravityVariantDirs[]`（返回**存在**的变体，用 `~` = `home ?? os.homedir()`，路径经 `path.join`）
  - `isAntigravityInstalled(): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAntigravityVariants, isAntigravityInstalled } from "./AntigravityDetector.js";

describe("AntigravityDetector", () => {
	it("lists only existing variants with a conversations dir", () => {
		const home = mkdtempSync(join(tmpdir(), "agy-"));
		mkdirSync(join(home, ".gemini", "antigravity-ide", "conversations"), { recursive: true });
		const variants = getAntigravityVariants(home);
		expect(variants.map((v) => v.variant)).toEqual(["antigravity-ide"]);
		expect(variants[0].conversationsDir).toBe(join(home, ".gemini", "antigravity-ide", "conversations"));
		expect(variants[0].brainDir).toBe(join(home, ".gemini", "antigravity-ide", "brain"));
	});

	it("isAntigravityInstalled false when no .db present", async () => {
		expect(await isAntigravityInstalled()).toBe(typeof globalThis === "object" ? await isAntigravityInstalled() : false);
	});
});
```

> 第二个测试的真实断言在 Step 2 实现后按 `hasNodeSqliteSupport()` + 临时 HOME 注入重写；此处先占位保证 import 失败。实现时把 `isAntigravityInstalled` 改为接受可选 `home` 形参以便测试注入（对齐 `isCursorInstalled` 的可测形态）。

- [ ] **Step 2: 实现 `AntigravityDetector.ts`**

```typescript
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasNodeSqliteSupport } from "./SqliteHelpers.js";

export const ANTIGRAVITY_VARIANTS = ["antigravity", "antigravity-ide", "antigravity-cli"] as const;

export interface AntigravityVariantDirs {
	readonly variant: string;
	readonly root: string;
	readonly conversationsDir: string;
	readonly brainDir: string;
}

export function getAntigravityVariants(home: string = homedir()): AntigravityVariantDirs[] {
	const out: AntigravityVariantDirs[] = [];
	for (const variant of ANTIGRAVITY_VARIANTS) {
		const root = join(home, ".gemini", variant);
		const conversationsDir = join(root, "conversations");
		if (existsSync(conversationsDir)) {
			out.push({ variant, root, conversationsDir, brainDir: join(root, "brain") });
		}
	}
	return out;
}

export async function isAntigravityInstalled(home: string = homedir()): Promise<boolean> {
	if (!hasNodeSqliteSupport()) return false;
	for (const v of getAntigravityVariants(home)) {
		try {
			if (readdirSync(v.conversationsDir).some((f) => f.endsWith(".db"))) return true;
		} catch {
			/* unreadable variant dir — skip */
		}
	}
	return false;
}
```

修正 Step 1 第二个测试为：无 `.db` 的临时 home → `expect(await isAntigravityInstalled(home)).toBe(false)`；有 `.db` → `true`（在 `hasNodeSqliteSupport()` 为真时）。

---

### Task 3: 真实 fixture builder

**Files:**
- Create: `cli/src/testUtils/antigravityFixture.ts`

**Interfaces:**
- Produces:
  - `interface AntigravityConvoInput { convId: string; variant?: string; workspacePath: string; gitRemote?: string; branch?: string; transcriptLines: object[] }`
  - `createAntigravityConvo(home: string, input: AntigravityConvoInput): { dbPath: string; transcriptPath: string }`
  - `REAL_TRANSCRIPT_FULL: object[]`（下方真实样本，逐行 parse 后的数组）
  - `buildMetadataBlob(workspacePath: string, gitRemote?: string, branch?: string): Buffer`（生成与真机同形的 protobuf blob）

**真实样本（来自真机 `~/.gemini/antigravity/brain/1bbaa61e…/.system_generated/logs/transcript_full.jsonl`，逐字）：**

```jsonl
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-07-19T09:46:50Z","content":"<USER_REQUEST>\n查看当前分支\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-07-19T17:46:50+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.5 Flash (Medium)...\n</USER_SETTINGS_CHANGE>"}
{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE","created_at":"2026-07-19T09:46:50Z"}
{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-07-19T09:46:50Z","tool_calls":[{"name":"run_command","args":{"CommandLine":"git branch --show-current","Cwd":"/Users/flyer/jolli/code/jollimemory","toolSummary":"Git branch check"}}]}
{"step_index":3,"source":"MODEL","type":"RUN_COMMAND","status":"DONE","created_at":"2026-07-19T09:46:52Z","content":"Created At: ...\nThe command completed successfully.\nOutput:\nfeature/cline-cli-source\n"}
{"step_index":4,"source":"SYSTEM","type":"CHECKPOINT","status":"DONE","created_at":"2026-07-19T09:46:52Z","content":"{{ CHECKPOINT 0 }}\n **... truncated ...**"}
{"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-07-19T09:46:52Z","content":"当前分支是 `feature/cline-cli-source`。"}
```

- [ ] **Step 1: 实现 fixture builder**

用 `node:sqlite` 的 `DatabaseSync` 建库，schema 取真机（关键表 `trajectory_metadata_blob(id TEXT PRIMARY KEY, data BLOB)`）。`buildMetadataBlob` 复刻真机 protobuf：field 1 (LEN) 内嵌两次 workspace `file://` 字符串（tag `0x0a`）+ git 子消息（tag `0x1a`：`0x0a` remote-name、`0x12` remote-url、`0x22` branch）+ 顶层 field 7（tag `0x3a`）workspace `file://`。参照真机 hex：

```
0aad010a2a<file-uri>122a<file-uri>1a39 0a0f<name>1226<remote-url>2218<branch> ... 3a2a<file-uri> ...
```

实现只需保证 discoverer 的字节扫描能命中首个 `file://…` 即可（无需完整 protobuf 语义），但 blob 必须是**真实二进制**而非文本占位。

```typescript
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AntigravityConvoInput {
	convId: string;
	variant?: string; // 默认 "antigravity"
	workspacePath: string; // 例 "/Users/x/repo"
	gitRemote?: string;
	branch?: string;
	transcriptLines: object[];
}

function lenField(tag: number, payload: Buffer): Buffer {
	return Buffer.concat([Buffer.from([tag]), encodeVarint(payload.length), payload]);
}
function encodeVarint(n: number): Buffer {
	const bytes: number[] = [];
	do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; bytes.push(b); } while (n);
	return Buffer.from(bytes);
}
export function buildMetadataBlob(workspacePath: string, gitRemote = "", branch = ""): Buffer {
	const uri = Buffer.from(`file://${workspacePath}`, "utf8");
	const uriField = lenField(0x0a, uri); // field 1: file uri
	const gitSub = gitRemote
		? lenField(0x1a, lenField(0x12, Buffer.from(gitRemote, "utf8")))
		: Buffer.alloc(0);
	const branchField = branch ? lenField(0x22, Buffer.from(branch, "utf8")) : Buffer.alloc(0);
	const inner = Buffer.concat([uriField, gitSub, branchField]);
	const topWorkspace = lenField(0x3a, uri); // field 7: workspace uri
	return Buffer.concat([lenField(0x0a, inner), topWorkspace]);
}

export function createAntigravityConvo(home: string, input: AntigravityConvoInput): { dbPath: string; transcriptPath: string } {
	const variant = input.variant ?? "antigravity";
	const root = join(home, ".gemini", variant);
	const convDir = join(root, "conversations");
	const logDir = join(root, "brain", input.convId, ".system_generated", "logs");
	mkdirSync(convDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	const dbPath = join(convDir, `${input.convId}.db`);
	const db = new DatabaseSync(dbPath);
	db.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
	const blob = buildMetadataBlob(input.workspacePath, input.gitRemote, input.branch);
	db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(blob);
	db.close();
	const transcriptPath = join(logDir, "transcript_full.jsonl");
	writeFileSync(transcriptPath, input.transcriptLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return { dbPath, transcriptPath };
}
```

---

### Task 4: AntigravitySessionDiscoverer

**Files:**
- Create: `cli/src/core/AntigravitySessionDiscoverer.ts`
- Test: `cli/src/core/AntigravitySessionDiscoverer.test.ts`

**Interfaces:**
- Consumes: `getAntigravityVariants` (Task 2)；`withSqliteDb`, `classifyScanError`, `SqliteScanError` from `SqliteHelpers.js`；`normalizePathForCompare` from `PathUtils.js`；`SessionInfo` from `Types.js`；`createAntigravityConvo` (Task 3, 测试用)。
- Produces:
  - `interface AntigravityScanResult { sessions: SessionInfo[]; error?: SqliteScanError }`
  - `scanAntigravitySessions(projectDir: string, home?: string): Promise<AntigravityScanResult>`
  - `discoverAntigravitySessions(projectDir: string, home?: string): Promise<ReadonlyArray<SessionInfo>>`
  - `extractWorkspacePath(blob: Uint8Array): string | undefined`（导出以便单测）
  - `const SESSION_STALE_MS = 48 * 60 * 60 * 1000`

- [ ] **Step 1: 写失败测试**

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAntigravityConvo } from "../testUtils/antigravityFixture.js";
import { discoverAntigravitySessions, extractWorkspacePath } from "./AntigravitySessionDiscoverer.js";
import { buildMetadataBlob } from "../testUtils/antigravityFixture.js";

describe("AntigravitySessionDiscoverer", () => {
	it("extractWorkspacePath reads first file:// uri from blob", () => {
		const blob = buildMetadataBlob("/Users/x/repo", "gh/x", "main");
		expect(extractWorkspacePath(blob)).toBe("/Users/x/repo");
	});

	it("discovers a conversation scoped to projectDir", async () => {
		const home = mkdtempSync(join(tmpdir(), "agy-"));
		const ws = mkdtempSync(join(tmpdir(), "repo-"));
		createAntigravityConvo(home, {
			convId: "c1", workspacePath: ws,
			transcriptLines: [{ step_index: 0, type: "USER_INPUT", created_at: "2026-07-19T09:46:50Z", content: "<USER_REQUEST>\n查看当前分支\n</USER_REQUEST>" }],
		});
		const sessions = await discoverAntigravitySessions(ws, home);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].source).toBe("antigravity");
		expect(sessions[0].transcriptPath.endsWith("transcript_full.jsonl")).toBe(true);
		expect(sessions[0].title).toContain("查看当前分支");
	});

	it("skips conversations for other workspaces", async () => {
		const home = mkdtempSync(join(tmpdir(), "agy-"));
		createAntigravityConvo(home, { convId: "c2", workspacePath: "/some/other/repo", transcriptLines: [] });
		expect(await discoverAntigravitySessions(mkdtempSync(join(tmpdir(), "repo-")), home)).toHaveLength(0);
	});
});
```

- [ ] **Step 2: 实现 `AntigravitySessionDiscoverer.ts`**

要点：
- `extractWorkspacePath`：在 blob 里找 ASCII `file://`，读到下一个非可打印/长度界，去掉 `file://` 前缀返回路径。用 `TextDecoder("latin1")` + 正则 `/file:\/\/([\x20-\x7e]+?)(?=[\x00-\x1f]|$)/`，取第一处，`decodeURIComponent` 还原非 ASCII（真机 `查看` 路径为 ASCII 目录，但仍 `decodeURIComponent` 兜底），再 `toForwardSlash` 不需要（已是 `/`）。
- 遍历 `getAntigravityVariants(home)` → 每变体 `readdirSync(conversationsDir)` 取 `*.db` → `withSqliteDb(dbPath, (db) => db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main'").get())` 拿 blob → `extractWorkspacePath` → `normalizePathForCompare` 与 `projectDir` 比对（相等或前缀，覆盖 worktree 场景按 Cursor 现有逻辑）。
- 命中 → `transcriptPath = join(brainDir, convId, ".system_generated", "logs", "transcript_full.jsonl")`；`existsSync` 为假则跳过。
- `title`：读该 jsonl 首个 `USER_INPUT`，剥 `<USER_REQUEST>` 包裹取内文，截断。
- `updatedAt`：`statSync(dbPath).mtime.toISOString()`。
- `SESSION_STALE_MS` 过滤 `Date.now() - mtime`。
- 任一 `.db` 读失败 → `classifyScanError` 收进 `result.error`，继续其余（不抛）。
- `discoverAntigravitySessions` = `(await scan...).sessions`。

（完整实现镜像 `CursorSessionDiscoverer.ts` 的结构与错误通道；此处新增逻辑仅 `extractWorkspacePath` + 旁挂 jsonl 定位。）

---

### Task 5: AntigravityTranscriptReader

**Files:**
- Create: `cli/src/core/AntigravityTranscriptReader.ts`
- Test: `cli/src/core/AntigravityTranscriptReader.test.ts`

**Interfaces:**
- Consumes: `TranscriptReadResult`, `TranscriptCursor`, `TranscriptEntry` from `Types.js`；`mergeConsecutiveEntries` from `TranscriptReader.js`。
- Produces: `readAntigravityTranscript(transcriptPath: string, cursor?: TranscriptCursor, beforeTimestamp?: string): Promise<TranscriptReadResult>`

- [ ] **Step 1: 写失败测试**（用 Task 3 的 `REAL_TRANSCRIPT_FULL` 真实样本落盘再读）

```typescript
it("maps USER_INPUT→human (unwrapped) and PLANNER_RESPONSE→assistant, skips CHECKPOINT/HISTORY", async () => {
	// 用 fixture 写真实 6 行样本到临时文件
	const result = await readAntigravityTranscript(transcriptPath);
	const roles = result.entries.map((e) => e.role);
	expect(roles[0]).toBe("human");
	expect(result.entries[0].content).toBe("查看当前分支"); // 剥掉 <USER_REQUEST> 及系统块
	expect(result.entries.some((e) => e.content.includes("当前分支是"))).toBe(true);
	// CHECKPOINT / CONVERSATION_HISTORY 不产出 entry
	expect(result.entries.every((e) => !e.content.includes("CHECKPOINT"))).toBe(true);
});

it("resumes from cursor.lineNumber", async () => {
	const first = await readAntigravityTranscript(transcriptPath);
	const again = await readAntigravityTranscript(transcriptPath, first.newCursor);
	expect(again.entries).toHaveLength(0);
	expect(again.newCursor.lineNumber).toBe(first.newCursor.lineNumber);
});
```

- [ ] **Step 2: 实现 `AntigravityTranscriptReader.ts`**

```typescript
import { readFile } from "node:fs/promises";
import type { TranscriptCursor, TranscriptEntry, TranscriptReadResult } from "../Types.js";
import { mergeConsecutiveEntries } from "./TranscriptReader.js";

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;

function unwrapUser(content: string): string {
	const m = USER_REQUEST_RE.exec(content);
	return (m ? m[1] : content).trim();
}

function toolCallSummary(tc: { name?: string; args?: Record<string, unknown> }): string {
	const cmd = tc.args?.CommandLine ?? tc.args?.toolSummary ?? "";
	return `↪ ${tc.name ?? "tool"}${cmd ? `: ${String(cmd)}` : ""}`;
}

export async function readAntigravityTranscript(
	transcriptPath: string,
	cursor?: TranscriptCursor,
	beforeTimestamp?: string,
): Promise<TranscriptReadResult> {
	let raw = "";
	try {
		raw = await readFile(transcriptPath, "utf8");
	} catch {
		return { entries: [], newCursor: { transcriptPath, lineNumber: cursor?.lineNumber ?? 0, updatedAt: new Date().toISOString() }, totalLinesRead: 0 };
	}
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const startLine = cursor?.lineNumber ?? 0;
	const cutoff = beforeTimestamp ? Date.parse(beforeTimestamp) : Number.POSITIVE_INFINITY;
	const entries: TranscriptEntry[] = [];
	let lastTs = cursor?.updatedAt ?? new Date().toISOString();
	let lineNumber = startLine;
	for (let i = startLine; i < lines.length; i++) {
		lineNumber = i + 1;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const ts = typeof obj.created_at === "string" ? obj.created_at : undefined;
		if (ts && Date.parse(ts) >= cutoff) {
			lineNumber = i; // 未消费该行
			break;
		}
		if (ts) lastTs = ts;
		const type = obj.type;
		const content = typeof obj.content === "string" ? obj.content : "";
		if (type === "USER_INPUT") {
			const text = unwrapUser(content);
			if (text) entries.push({ role: "human", content: text, timestamp: ts });
		} else if (type === "PLANNER_RESPONSE") {
			const tcs = Array.isArray(obj.tool_calls) ? (obj.tool_calls as { name?: string; args?: Record<string, unknown> }[]) : [];
			const parts = [content, ...tcs.map(toolCallSummary)].filter((p) => p.length > 0);
			if (parts.length) entries.push({ role: "assistant", content: parts.join("\n"), timestamp: ts });
		} else if (type === "RUN_COMMAND") {
			if (content) entries.push({ role: "assistant", content, timestamp: ts });
		}
		// CHECKPOINT / CONVERSATION_HISTORY / 其他 → skip
	}
	return {
		entries: mergeConsecutiveEntries(entries),
		newCursor: { transcriptPath, lineNumber, updatedAt: lastTs },
		totalLinesRead: lines.length - startLine,
	};
}
```

---

### Task 6: CLI 接线

**Files（均 Modify，各在现有 `cursor` 分支旁加一路 `antigravity`）:**
- `cli/src/hooks/QueueWorker.ts` — import discoverer/reader；`loadSessionTranscripts()` 的 discovery gate（`config.antigravityEnabled !== false && await isAntigravityInstalled()` → push `scanAntigravitySessions(cwd)` 结果，`scanError` 记录）；`readAllTranscripts()` 的 read dispatch 加 `else if (source === "antigravity") return readAntigravityTranscript(...)`。
- `cli/src/core/TranscriptLoader.ts` — `loadTranscript` 顶部单-artifact reader dispatch 加 `antigravity`；从 `JsonlSource = Exclude<TranscriptSource, ...>` 的排除列表补 `"antigravity"`。
- `cli/src/core/TranscriptMessageCounter.ts` — `switch (source)` 加 `case "antigravity": return readAntigravityTranscript(...)`。
- `cli/src/core/SessionTitleResolver.ts` — `PARSE_LINE` Record 加 `antigravity: parseAntigravityUserLine`；实现 `parseAntigravityUserLine` 返回 `undefined`（title 由 discoverer 提供）。
- `cli/src/core/ActiveSessionAggregator.ts` — 加 `loadAntigravity(cwd)`（gate 同 QueueWorker），注册进 `collectFromAllSources` 的 `Promise.all([...])`。
- `cli/src/core/SessionTracker.ts` — `filterSessionsByEnabledIntegrations`：`config.antigravityEnabled === false` 时丢弃 `source === "antigravity"`。
- `cli/src/commands/ConfigureCommand.ts` — `antigravityEnabled` 加进 `VALID_CONFIG_KEYS`、`coerceConfigValue` 布尔强转、`CONFIG_KEY_INFO`。
- `cli/src/commands/StatusCommand.ts` — 状态表加 "Antigravity:" 行（用 `status.antigravityDetected/antigravityEnabled/antigravityScanError`、`counts.antigravity`）。
- `cli/src/install/Installer.ts` — import `isAntigravityInstalled, scanAntigravitySessions`；`getStatus()` 设 `antigravityDetected`，按 `config.antigravityEnabled !== false && detected` 做按需扫描，填 `antigravityScanError` 与返回的 `StatusInfo`。

**Test（Modify，补 antigravity case）:** `cli/src/core/SessionTracker.test.ts`、`cli/src/commands/ConfigureCommand.test.ts`、`cli/src/hooks/QueueWorker.test.ts`、`cli/src/hooks/PostCommitHook.test.ts`。

- [ ] **Step 1: 补上述测试的 antigravity case**（镜像各文件里已有的 `cursor` case：`ConfigureCommand.test.ts` 断言 `antigravityEnabled` 可 set/coerce；`SessionTracker.test.ts` 断言 disabled 时被过滤；`QueueWorker.test.ts` 用 Task 3 fixture 造一个 antigravity 对话并断言被纳入 discovery。）

- [ ] **Step 2: 按 Files 清单逐处接线实现。**（每处都是"复制 cursor 分支改标识符"；`node:sqlite` 依赖的 discoverer 用 lazy `await import(...)`，与 cursor/opencode 同形。）

---

### Task 7: vscode 一等公民接线

**Files（Modify）:**
- `vscode/src/providers/StatusTreeProvider.ts` — `buildFullStatusItems()` 加 "Antigravity Integration" 行（`pushIntegrationItem`），带 `s.antigravityScanError` warn 分支，用 `counts.antigravity`。
- `vscode/src/views/SettingsHtmlBuilder.ts` — `buildToggleRow("antigravityEnabled", "Antigravity", ...)`。
- `vscode/src/views/SettingsScriptBuilder.ts` — `antigravityEnabledInput` 元素 + "至少启用一个 integration" 校验 + dirty-check + save payload + hydration。
- `vscode/src/views/SettingsWebviewPanel.ts` — `SettingsPayload.antigravityEnabled: boolean` + 读(`config.antigravityEnabled !== false`)写。
- `vscode/src/views/SidebarScriptBuilder.ts` / `SummaryScriptBuilder.ts` / `NextMemoryScriptBuilder.ts` — `SOURCE_ICON_SVG` 加 `antigravity` 官方图标（`currentColor`，无 inline style，走 CSS class）；`sourceLabel`/label case 加 `'antigravity' → 'Antigravity'`；`SummaryScriptBuilder.ts` 的 `sourceOrder` 数组加 `'antigravity'`。
- `vscode/src/views/SidebarCssBuilder.ts` / `ConversationDetailsHtmlBuilder.ts` — `.badge.transcript-source-antigravity` 颜色 + `ConversationDetailsHtmlBuilder` 的 `providerLabel` case。

**Test（Modify）:** `vscode/src/providers/StatusTreeProvider.test.ts`、`vscode/src/services/ActiveSessionsProvider.test.ts`、`vscode/src/views/{SettingsHtmlBuilder,SettingsScriptBuilder,SettingsWebviewPanel,SidebarCssBuilder,SidebarScriptBuilder,SummaryScriptBuilder,ConversationDetailsHtmlBuilder}.test.ts`。

- [ ] **Step 1: 补上述 vscode 测试的 antigravity case**（镜像各文件已有 cursor case：Settings 有 antigravity toggle、StatusTree 有 Antigravity 行、图标 map 含 antigravity、sourceOrder 含 antigravity）。

- [ ] **Step 2: 按 Files 清单逐处接线实现。**（图标用 Antigravity 官方 mark 的 SVG path；注意 builder 的 template-literal backtick 陷阱——注释里勿用 backtick 引 identifier。）

---

### Task 8: 全量门禁 + 单次提交

**Files:** 无新增；`.gitignore` / `CLAUDE.md` 视需要各一行（若需在 CLAUDE.md 的 source 列表补 antigravity）。

- [ ] **Step 1: 跑全量门禁**

Run: `npm run all`
Expected: clean→build→lint→test 全绿；CLI 覆盖率 ≥ 97/96/97/97。失败则修，直到通过。

> 若命中记忆中的环境类 flake（git-op push-refspec / worktree 并发），用 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all` 前缀重跑相关文件确认非回归。

- [ ] **Step 2: 单次提交**

```bash
git add -A
git commit -s -m "feat: add Antigravity as a transcript source"
```

（**不加** Claude 署名 / footer。）

---

## Self-Review

- **Spec coverage**：§3.1→Task2、§3.2→Task4、§3.3→Task5、§4→Task6、§5→Task7、§6→Task3+各测试、§2 类型→Task1、§7 决策(字节扫描/工具粒度/去重)→已在 Task4/5 落为默认实现。全覆盖。
- **Placeholder scan**：Step 1 占位测试已在 Task2 Step2 说明改写为真实断言；其余步骤含真实代码/命令。
- **Type consistency**：`scanAntigravitySessions`/`discoverAntigravitySessions`/`extractWorkspacePath`/`readAntigravityTranscript`/`getAntigravityVariants`/`isAntigravityInstalled`/`createAntigravityConvo`/`buildMetadataBlob` 在定义处与 consumer 处签名一致；`TranscriptCursor.lineNumber` 复用未新增字段。
