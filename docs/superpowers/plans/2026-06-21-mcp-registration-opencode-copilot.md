# MCP Registration for OpenCode / Copilot CLI / Copilot Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-register the `jollimemory` MCP server into three additional AI *agents* — OpenCode, GitHub Copilot CLI, and VS Code Copilot Chat — during `jolli enable`, alongside the existing Claude/Cursor/Gemini/Codex registrars.

**Architecture:** Extend the existing per-host `McpHostRegistrar` model in [HostRegistrars.ts](../../../cli/src/install/mcp/HostRegistrars.ts). Three of the four JSON hosts can share one writer once `JsonMcpWriter` is parameterized by top-level key + entry shape; the registrars only differ in config path and entry transform. Detection reuses the existing `is*Installed` detectors, run once in `Installer.ts` and folded into the `DetectedHosts` struct. MCP registration runs independently of any `*Enabled` config flag (same rule the existing four hosts follow).

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest + coverage, Biome (tabs, 120 col).

## Observed Reality

Verified on a real machine (2026-06-21), not from documentation. See per-host notes:

| Agent | Config file (verified path) | Top-level key | Entry shape (verified) | Writer |
|-------|------|---------|------|------|
| **Copilot CLI** | global `~/.copilot/mcp-config.json` | `mcpServers` | `{ command, args }` — `type` optional, defaults `local` (live-verified `copilot mcp get` accepts no-`type`) | reuse parameterized `JsonMcpWriter` (default key) |
| **OpenCode** | global `~/.config/opencode/opencode.json` | `mcp` | `{ type:"local"(**required**), command:["node",…args](**required array**), enabled? }` — `mcpServers` key → "Unrecognized key"; split `{command,args}` → "Invalid input"; missing `type` → "Invalid input". All live-verified via `opencode mcp list`. | `JsonMcpWriter` with `serversKey:"mcp"` + array-command entry |
| **Copilot Chat** (VS Code) | global `<vscodeUserDataDir>/User/mcp.json` | `servers` (source: `serversKey ?? "servers"`) | `{ type:"stdio", command, args, env?, cwd? }` (source: `type:"stdio",command:t,args:n,…`) | `JsonMcpWriter` with `serversKey:"servers"` + stdio entry |

**Scope decision (settled 2026-06-21):** Register at the scope whose config file jolli can cleanly **own** — not a blanket project-vs-global preference. Claude (`.mcp.json`) and Cursor (`.cursor/mcp.json`) have dedicated, jolli-ownable, gitexcludable **project** files, so they stay project-scoped. Gemini/Codex (existing) and the three new agents have no such file — their per-project config is a user-authored shared file (OpenCode `opencode.json`) or doesn't exist — so they register **globally**, matching the Gemini/Codex precedent. Adding a user-scope/global option for Claude (`~/.claude.json` top-level `mcpServers`, `claude mcp add --scope user`) or Cursor (`~/.cursor/mcp.json`) was explicitly **declined**: it would surface `jollimemory` in every project (breaking per-repo opt-in) and, for Claude, merge into the high-risk shared `~/.claude.json` blob rather than a dedicated file. OpenCode therefore stays **global** in this plan despite supporting a project config.

**Verification gaps carried into this plan:**
- Copilot Chat schema is from **reading the installed VS Code `workbench.desktop.main.js` source**, NOT a live smoke test (this machine's `User/mcp.json` is a 0-byte empty file; populating it needs the VS Code GUI). **Task 6 includes a mandatory live smoke-test gate** before this registrar is considered done.
- Copilot CLI *workspace* config is `.mcp.json` — the **same file** Claude's registrar already writes (`copilot mcp list` in this worktree already shows `jollimemory` as a Workspace server). This plan therefore writes Copilot only to its **user-global** file; the workspace path is already covered when Claude is detected.

## Global Constraints

- **DCO sign-off on every commit** — `git commit -s`. No `Co-Authored-By: Claude` / `🤖 Generated` trailers.
- **`npm run all` must pass before commit** (clean → build → lint → test). Run it once at the end, not per-task.
- **CLI coverage floor:** 97% statements / 96% branches / 97% functions / 97% lines under `cli/src/`.
- **Biome:** tabs, 4-wide, 120 col. `noExplicitAny: error`, `noUnusedImports/Variables: error`.
- **Path normalization:** use `toForwardSlash` for `\`→`/`; never inline `.replace(/\\/g,"/")`. (Not expected to arise here — config paths are built with `join`.)
- **No literal NUL, no per-task commit+test.** Write tests + impl per task; defer `npm run all` + commit to the end (per repo convention).

## File Structure

- **Modify** [cli/src/install/mcp/JsonMcpWriter.ts](../../../cli/src/install/mcp/JsonMcpWriter.ts) — add optional `serversKey` param (default `"mcpServers"`) and broaden the entry type so any JSON-shaped entry can be written. Single writer now serves Cursor, Gemini, Copilot CLI, OpenCode, Copilot Chat.
- **Modify** [cli/src/install/mcp/HostRegistrars.ts](../../../cli/src/install/mcp/HostRegistrars.ts) — expand `DetectedHosts`, add `opencodeRegistrar` / `copilotCliRegistrar` / `copilotChatRegistrar`, wire them into `buildRegistrars` and the `removeAllMcpHosts` all-true set.
- **Modify** [cli/src/install/Installer.ts](../../../cli/src/install/Installer.ts) — run the three detectors once, fold into the `detected` struct.
- **Modify** test files: `JsonMcpWriter.test.ts`, `HostRegistrars.test.ts` (the latter's existing `buildRegistrars({...})` calls must gain the three new fields — TypeScript will flag every site).

**No new files.** Each new host is a small registrar object reusing the parameterized JSON writer; a bespoke writer (like `CodexTomlWriter`) is not needed because all three are JSON.

---

### Task 1: Parameterize `JsonMcpWriter` by top-level key + entry shape

**Files:**
- Modify: `cli/src/install/mcp/JsonMcpWriter.ts`
- Test: `cli/src/install/mcp/JsonMcpWriter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `upsertJsonMcpServer(configPath: string, entry: Record<string, unknown>, serversKey?: string): Promise<void>` — `serversKey` defaults to `"mcpServers"`.
  - `removeJsonMcpServer(configPath: string, serversKey?: string): Promise<void>` — `serversKey` defaults to `"mcpServers"`.

- [ ] **Step 1: Write the failing test** — append to `JsonMcpWriter.test.ts` inside the `describe("JsonMcpWriter", …)` block:

```typescript
it("writes under a custom serversKey (mcp) preserving the entry shape", async () => {
	const p = join(tmp, "opencode.json");
	const entry = { type: "local", command: ["node", "/x/Cli.js", "mcp"], enabled: true };
	await writeFile(p, JSON.stringify({ $schema: "https://opencode.ai/config.json" }), "utf-8");
	await upsertJsonMcpServer(p, entry, "mcp");
	const cfg = JSON.parse(await readFile(p, "utf-8"));
	expect(cfg.$schema).toBe("https://opencode.ai/config.json"); // other keys preserved
	expect(cfg.mcp.jollimemory).toEqual(entry);
	expect(cfg.mcpServers).toBeUndefined(); // default key NOT used
});

it("removes from a custom serversKey (servers)", async () => {
	const p = join(tmp, "mcp.json");
	await writeFile(p, JSON.stringify({ servers: { jollimemory: { type: "stdio", command: "x" }, other: { command: "y" } } }), "utf-8");
	await removeJsonMcpServer(p, "servers");
	const cfg = JSON.parse(await readFile(p, "utf-8"));
	expect(cfg.servers.jollimemory).toBeUndefined();
	expect(cfg.servers.other).toEqual({ command: "y" });
});
```

(Reuse whatever `tmp` / `entry` setup the existing tests already declare at the top of the file; if `tmp` is named differently there, match it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/JsonMcpWriter.test.ts -t "custom serversKey"`
Expected: FAIL — `upsertJsonMcpServer` currently ignores a 3rd arg and writes under `mcpServers`.

- [ ] **Step 3: Implement** — replace the type declarations and both functions in `JsonMcpWriter.ts`. Broaden the entry type and thread `serversKey` through:

```typescript
const SERVER_KEY = "jollimemory";
const DEFAULT_KEY = "mcpServers";

type ServerEntry = Record<string, unknown>;
type JsonConfig = Record<string, unknown>;

export async function upsertJsonMcpServer(
	configPath: string,
	entry: ServerEntry,
	serversKey: string = DEFAULT_KEY,
): Promise<void> {
	let config: JsonConfig;
	try {
		config = JSON.parse(await readFile(configPath, "utf-8")) as JsonConfig;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			log.warn("Skipping MCP registration: %s unreadable/invalid (%s)", configPath, String(err));
			return;
		}
		config = {};
	}
	const servers = (config[serversKey] as Record<string, ServerEntry> | undefined) ?? {};
	servers[SERVER_KEY] = entry;
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify({ ...config, [serversKey]: servers }, null, 2)}\n`, "utf-8");
	log.info("Registered MCP server in %s", configPath);
}

export async function removeJsonMcpServer(configPath: string, serversKey: string = DEFAULT_KEY): Promise<void> {
	let config: JsonConfig;
	try {
		config = JSON.parse(await readFile(configPath, "utf-8")) as JsonConfig;
	} catch {
		return;
	}
	const servers = config[serversKey] as Record<string, ServerEntry> | undefined;
	if (!servers?.[SERVER_KEY]) return;
	delete servers[SERVER_KEY];
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	log.info("Removed MCP server from %s", configPath);
}
```

Also update the file's top docstring: note the writer is now key-parameterized and lists the verified keys (`mcpServers` for Cursor/Gemini/Copilot-CLI, `mcp` for OpenCode, `servers` for Copilot Chat).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/JsonMcpWriter.test.ts`
Expected: PASS — including the pre-existing `mcpServers` tests (default key unchanged).

---

### Task 2: Expand `DetectedHosts` and add the three registrars

**Files:**
- Modify: `cli/src/install/mcp/HostRegistrars.ts`
- Test: `cli/src/install/mcp/HostRegistrars.test.ts`

**Interfaces:**
- Consumes: `upsertJsonMcpServer(path, entry, serversKey?)`, `removeJsonMcpServer(path, serversKey?)` from Task 1; `getVscodeUserDataDir(flavor, home?)` from `../../core/VscodeWorkspaceLocator.js`.
- Produces: `DetectedHosts` gains `opencode: boolean`, `copilot: boolean`, `copilotChat: boolean`. `buildRegistrars` emits `opencode` / `copilot` / `copilotChat` hosts when their flag is set.

- [ ] **Step 1: Write the failing tests** — append to `HostRegistrars.test.ts`.

All three new hosts are **global** (paths resolved from `homedir()` inside the registrar, NOT from the `wt` argument). So the seam to assert against is the **`vi.doMock("./JsonMcpWriter.js")` pattern the existing gemini describe-block uses** (HostRegistrars.test.ts:122–159) — mock the writer, call `register()`, assert it was called with the expected path + entry + `serversKey`. Do **not** write real files under a temp dir for these — the `wt` arg is ignored.

First add a top-of-file helper so the 7-field literals stay readable:

```typescript
const NONE = { claude: false, codex: false, cursor: false, gemini: false, opencode: false, copilot: false, copilotChat: false } as const;
```

Structure tests (host presence + gitExclude) use the plain `buildRegistrars`:

```typescript
describe("opencode/copilot/copilotChat registrars — structure", () => {
	it("opencode appears when detected.opencode is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, opencode: true });
		expect(r.host).toBe("opencode");
		expect(r.gitExcludePaths()).toEqual([]);
	});
	it("copilot appears when detected.copilot is true", () => {
		expect(buildRegistrars({ ...NONE, copilot: true }).map((r) => r.host)).toContain("copilot");
	});
	it("copilotChat appears when detected.copilotChat is true", () => {
		expect(buildRegistrars({ ...NONE, copilotChat: true }).map((r) => r.host)).toContain("copilotChat");
	});
});
```

Target/shape tests reuse the existing gemini `vi.doMock` seam (mirror the `beforeEach`/`afterEach` doMock/unmock from lines 123–142; `upsertMock`/`removeMock`/`build` are the same locals):

```typescript
describe("new registrars — register targets & entry shape (mocked writer)", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({ upsertJsonMcpServer: upsertMock, removeJsonMcpServer: removeMock }));
		upsertMock.mockClear();
		removeMock.mockClear();
	});
	afterEach(() => { vi.doUnmock("./JsonMcpWriter.js"); vi.resetModules(); });

	it("opencode register() → ~/.config/opencode/opencode.json, key `mcp`, type:local + array command", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, opencode: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".config", "opencode", "opencode.json"));
		expect(key).toBe("mcp");
		expect(entry.type).toBe("local");
		expect(Array.isArray(entry.command)).toBe(true);
		expect(entry.command.at(-1)).toBe("mcp");
	});

	it("copilot register() → ~/.copilot/mcp-config.json, default key, {command,args}", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, copilot: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".copilot", "mcp-config.json"));
		expect(key).toBeUndefined(); // default mcpServers
		expect(entry.args).toEqual(["mcp"]);
	});

	it("copilotChat register() → VS Code User/mcp.json, key `servers`, type:stdio", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, copilotChat: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(getVscodeUserDataDir("Code"), "User", "mcp.json"));
		expect(key).toBe("servers");
		expect(entry.type).toBe("stdio");
		expect(entry.args).toEqual(["mcp"]);
	});

	it("opencode/copilotChat remove() pass the right serversKey", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		await build({ ...NONE, opencode: true })[0].remove("/some/wt");
		expect(removeMock.mock.calls[0][1]).toBe("mcp");
		removeMock.mockClear();
		await build({ ...NONE, copilotChat: true })[0].remove("/some/wt");
		expect(removeMock.mock.calls[0][1]).toBe("servers");
	});
});
```

Add `import { getVscodeUserDataDir } from "../../core/VscodeWorkspaceLocator.js";` to the test imports.

Also update the existing `buildRegistrars({...})` / `registerAllMcpHosts(...)` call sites in this file (claude/cursor/gemini/codex/registerAllMcpHosts tests) to include the three new `false` fields, or refactor them onto the `{ ...NONE, … }` spread. TypeScript flags each one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/HostRegistrars.test.ts`
Expected: FAIL/compile-error — `DetectedHosts` has no `opencode`/`copilot`/`copilotChat`; registrars don't exist.

- [ ] **Step 3: Implement** in `HostRegistrars.ts`.

Expand the interface:

```typescript
export interface DetectedHosts {
	claude: boolean;
	codex: boolean;
	cursor: boolean;
	gemini: boolean;
	opencode: boolean;
	copilot: boolean;
	copilotChat: boolean;
}
```

Add the import:

```typescript
import { getVscodeUserDataDir } from "../../core/VscodeWorkspaceLocator.js";
```

Add the three registrars (place after `codexRegistrar`). `jolliEntry()` already returns `{ command, args }`; derive the other shapes from it:

```typescript
/**
 * OpenCode: global `~/.config/opencode/opencode.json`.
 * Format live-verified via `opencode mcp list` (opencode-ai 1.4.1): top-level key
 * `mcp`; entry REQUIRES `type:"local"` and a single `command` ARRAY (command + args
 * combined). `mcpServers` key → "Unrecognized key"; split {command,args} → "Invalid
 * input"; missing `type` → "Invalid input". `enabled` defaults true. Global config —
 * never committed, so gitExcludePaths returns [].
 */
const opencodeRegistrar: McpHostRegistrar = {
	host: "opencode",
	register: () => {
		const base = jolliEntry();
		const entry = { type: "local", command: [base.command, ...base.args], enabled: true };
		return upsertJsonMcpServer(join(homedir(), ".config", "opencode", "opencode.json"), entry, "mcp");
	},
	remove: () => removeJsonMcpServer(join(homedir(), ".config", "opencode", "opencode.json"), "mcp"),
	gitExcludePaths: () => [],
};

/**
 * GitHub Copilot CLI: user-global `~/.copilot/mcp-config.json`.
 * Format live-verified via `copilot mcp add`/`get` (copilot CLI): top-level key
 * `mcpServers`, entry `{ command, args }` (Copilot defaults `type:"local"` when omitted —
 * live-verified). Same shape as Cursor/Gemini, so the default writer key is reused.
 * NOTE: Copilot CLI ALSO reads workspace `.mcp.json`, which the Claude registrar already
 * writes — so the workspace path is covered there; this registrar handles only the
 * user-global file. Global config — never committed, so gitExcludePaths returns [].
 */
const copilotCliRegistrar: McpHostRegistrar = {
	host: "copilot",
	register: () => upsertJsonMcpServer(join(homedir(), ".copilot", "mcp-config.json"), jolliEntry()),
	remove: () => removeJsonMcpServer(join(homedir(), ".copilot", "mcp-config.json")),
	gitExcludePaths: () => [],
};

/**
 * VS Code Copilot Chat: user-global `<vscodeUserDataDir>/User/mcp.json`.
 * Format from VS Code app source (workbench.desktop.main.js): top-level key
 * `servers` (`serversKey ?? "servers"`); stdio entry `{ type:"stdio", command, args }`.
 * ⚠️ Source-verified only — see plan Task 6 for the mandatory live smoke test.
 * Global config — never committed, so gitExcludePaths returns [].
 */
const copilotChatRegistrar: McpHostRegistrar = {
	host: "copilotChat",
	register: () => {
		const base = jolliEntry();
		const entry = { type: "stdio", command: base.command, args: base.args };
		return upsertJsonMcpServer(join(getVscodeUserDataDir("Code"), "User", "mcp.json"), entry, "servers");
	},
	remove: () => removeJsonMcpServer(join(getVscodeUserDataDir("Code"), "User", "mcp.json"), "servers"),
	gitExcludePaths: () => [],
};
```

Wire into `buildRegistrars`:

```typescript
export function buildRegistrars(detected: DetectedHosts): McpHostRegistrar[] {
	const out: McpHostRegistrar[] = [];
	if (detected.claude) out.push(claudeRegistrar);
	if (detected.cursor) out.push(cursorRegistrar);
	if (detected.gemini) out.push(geminiRegistrar);
	if (detected.codex) out.push(codexRegistrar);
	if (detected.opencode) out.push(opencodeRegistrar);
	if (detected.copilot) out.push(copilotCliRegistrar);
	if (detected.copilotChat) out.push(copilotChatRegistrar);
	return out;
}
```

Update the `removeAllMcpHosts` all-true set:

```typescript
for (const r of buildRegistrars({
	claude: true, codex: true, cursor: true, gemini: true,
	opencode: true, copilot: true, copilotChat: true,
})) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @jolli.ai/cli -- src/install/mcp/HostRegistrars.test.ts`
Expected: PASS.

---

### Task 3: Wire the three detectors into `Installer.ts`

**Files:**
- Modify: `cli/src/install/Installer.ts` (detector block ~line 186; `detected` struct ~line 220; the `removeAllMcpHosts` caller — confirm via grep)
- Test: covered by the existing Installer integration tests (run after wiring).

**Interfaces:**
- Consumes: `isOpenCodeInstalled()` (`../core/OpenCodeSessionDiscoverer.js`, already imported ~line 32), `isCopilotInstalled()` (`../core/CopilotDetector.js`, imported ~line 25), `isCopilotChatInstalled()` (`../core/CopilotChatDetector.js`, imported ~line 22). All three imports already exist in this file.
- Produces: `detected` now carries all seven hosts.

- [ ] **Step 1: Add the detector calls** next to the existing once-before-loop block (after line 188):

```typescript
const opencodeDetectedOnce = await isOpenCodeInstalled();
const copilotDetectedOnce = await isCopilotInstalled();
const copilotChatDetectedOnce = await isCopilotChatInstalled();
```

- [ ] **Step 2: Extend the `detected` struct** (~line 220). MCP registration runs regardless of `*Enabled` — these are pure detector results, mirroring codex/cursor/gemini:

```typescript
const detected = {
	claude: config.claudeEnabled !== false,
	codex: codexDetectedOnce,
	cursor: cursorDetectedOnce,
	gemini: geminiDetectedOnce,
	opencode: opencodeDetectedOnce,
	copilot: copilotDetectedOnce,
	copilotChat: copilotChatDetectedOnce,
};
```

- [ ] **Step 3: Build to confirm type-completeness**

Run: `npm run typecheck:cli`
Expected: PASS — every `DetectedHosts` literal in non-test code now has all seven fields. If any other `buildRegistrars(...)` / `registerAllMcpHosts(...)` call sites exist with a 4-field literal, the compiler flags them; fix each to include the three new fields.

---

### Task 4: Live smoke-test gate for Copilot Chat (manual verification)

This is the verification the discovery phase could not perform (empty `User/mcp.json`; needs the VS Code GUI). It is a **gate**, not code — but it must pass before the feature ships, because the Copilot Chat schema is source-verified only.

- [ ] **Step 1: Generate real reference data.** In VS Code, run Command Palette → **MCP: Add Server** → add any stdio server (e.g. command `echo`). Then read the file:

Run: `cat "$HOME/Library/Application Support/Code/User/mcp.json"` (macOS path; use `getVscodeUserDataDir` equivalent on other OSes)
Expected: a JSON object whose top-level key is `servers` and whose entry has `"type": "stdio"`, `"command"`, `"args"`. Confirm there is **no** `inputs`-style wrapper around the server entry (if there is, the registrar's entry shape must adapt — update Task 2's `copilotChatRegistrar` accordingly and re-run its test).

- [ ] **Step 2: Confirm jolli's written entry is accepted.** With the registrar wired (Tasks 2–3), run `jolli enable` (or the dev equivalent) on a machine with VS Code installed, then open VS Code and verify the `jollimemory` MCP server appears and connects in the Copilot Chat MCP server list.
Expected: `jollimemory` listed and reachable. If VS Code rejects the entry, capture the exact error and reconcile the schema before shipping.

- [ ] **Step 3: Record the result** in the PR description under an "Observed Reality — Copilot Chat" note (verified live vs. still source-only). If a real VS Code install is unavailable at implementation time, **say so explicitly** in the PR and mark the Copilot Chat registrar as source-verified-only — do not silently claim live verification.

---

### Final: build, lint, test, commit

- [ ] **Step 1: Full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97. If the three tiny registrars dip branch coverage, add the missing `remove()` / `gitExcludePaths()` assertions in `HostRegistrars.test.ts` (mirror the existing cursor/gemini coverage).

- [ ] **Step 2: Commit**

```bash
git add cli/src/install/mcp/JsonMcpWriter.ts cli/src/install/mcp/JsonMcpWriter.test.ts \
        cli/src/install/mcp/HostRegistrars.ts cli/src/install/mcp/HostRegistrars.test.ts \
        cli/src/install/Installer.ts \
        docs/superpowers/plans/2026-06-21-mcp-registration-opencode-copilot.md
git commit -s -m "Register jollimemory MCP server in OpenCode, Copilot CLI, and Copilot Chat"
```

## Self-Review

- **Spec coverage:** Copilot CLI → Task 2 (`copilotCliRegistrar`) + Task 3 wiring; OpenCode → Task 1 (key param) + Task 2 (`opencodeRegistrar`) + Task 3; Copilot Chat → Task 1 + Task 2 (`copilotChatRegistrar`) + Task 3 + Task 4 live gate. Writer parameterization → Task 1. Detection → Task 3. ✓
- **Type consistency:** `DetectedHosts` 7 fields defined in Task 2, consumed in Task 3; `upsertJsonMcpServer(path, entry, serversKey?)` signature defined in Task 1, called with `"mcp"`/`"servers"`/default in Task 2. `getVscodeUserDataDir("Code", home?)` matches the real signature. ✓
- **Known follow-on:** IntelliJ registers no MCP today (CLAUDE.md) — out of scope here, unchanged. Copilot CLI/Chat sharing one `copilotEnabled` flag does not affect MCP (registration ignores enable flags), so no flag-split is needed. ✓
