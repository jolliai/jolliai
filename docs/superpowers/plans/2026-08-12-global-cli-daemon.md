# Global CLI Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one machine-global resident process that runs unattended periodic work, carrying exactly one scheduled task (the daily `jollimemory.db` snapshot), spawned on demand from four entry points and converging on the newest installed bundle.

**Architecture:** A detached `jolli global-daemon` process binds a per-user unix socket (named pipe on Windows) and speaks a four-line handshake in which it announces its own build version. Any trigger connects; a strictly newer trigger sends `retire`. Inside, a stateless ticker asks each registered task hourly whether it is due — the task itself owns the "am I due" decision, which for backup is already persisted in the database.

**Tech Stack:** TypeScript (ESM), Node ≥ 22.13, `node:net`, `node:sqlite` (via existing `Backup.ts`), commander, vitest, biome.

**Spec:** `docs/superpowers/specs/2026-08-12-global-cli-daemon-design.md`

## Global Constraints

- **Every commit uses `git commit -s`** (DCO). CI rejects PRs without `Signed-off-by:`.
- **No `Co-Authored-By: Claude …` trailer and no `🤖 Generated with …` footer** in any commit message.
- **`npm run all` must pass before the final commit** (clean → build → typecheck → lint → test). Per-task commits run the targeted test file only; the full gate runs once at the end (Task 8).
- **CLI coverage floor: 97% statements / 96% branches / 97% functions / 97% lines.** New code under `cli/src/` is held to it.
- **Biome formatting:** tabs, 4-wide, 120-column limit. `noExplicitAny: error`, `noUnusedImports/Variables: error`. CI runs `biome check --error-on-warnings` — warnings fail.
- **Coverage exemptions use the block form only:** `/* v8 ignore start */` … `/* v8 ignore stop */`. Single-line `/* v8 ignore next */` does not work in this repo.
- **Node floor is 22.13** — the five-place lockstep in `AGENTS.md`. Do not add a Node flag before the script in any spawn.
- **Never block git.** Every trigger path catches everything and returns; a failure is a log line.
- **Never write to stdout** from any code reachable from a plugin bootstrap. Codex validates that hook's stdout as exactly one JSON object.
- **Use `toForwardSlash` for `\` → `/` normalization** (`cli/src/core/PathUtils.ts`); never inline `path.replace(/\\/g, "/")`.
- Test command shape: `npm run test -w @jolli.ai/cli -- <file> -t "<case>"`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `cli/src/core/DaemonHandshake.ts` | Generic "one daemon per key, newest build wins" toolkit — version compare, line framing, socket-dir safety. Shared by the MCP daemon and the global daemon. |
| `cli/src/daemon/GlobalDaemonProtocol.ts` | The global daemon's address and its `hello` shape. Depends on `DaemonHandshake`. |
| `cli/src/daemon/TaskScheduler.ts` | The stateless ticker. Knows nothing about backup, sockets, or processes. |
| `cli/src/daemon/GlobalDaemon.ts` | The process: bind → hello → greeting → tick until retired. |
| `cli/src/daemon/EnsureGlobalDaemon.ts` | The trigger helper called from four entry points. |
| `cli/src/commands/GlobalDaemonCommand.ts` | `jolli global-daemon` (hidden) registration. |

**Modified:**

| File | Change |
|---|---|
| `cli/src/mcp/McpDaemonProtocol.ts` | Generic half moves out; thin MCP-specific wrappers re-export it so every existing call site compiles unchanged. |
| `cli/src/core/TelemetryCommandHook.ts` | Expose `getInvokedRootCommand()` — the commander-parsed command name the exclusion predicate needs. |
| `cli/src/Api.ts` | Register the new command. |
| `cli/src/Cli.ts` | Trigger at the tail. |
| `cli/src/hooks/PostCommitHook.ts`, `SessionStartHook.ts`, `PluginBootstrapHook.ts`, `CodexPluginBootstrapHook.ts` | Trigger. |
| `cli/src/commands/UninstallCommand.ts` | Send `retire`. |
| `cli/src/commands/DoctorCommand.ts` | One observability row. |
| `AGENTS.md` | Record the rules a future change could silently break. |

**Dependency order:** Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Tasks 2 and 3 are independent of each other and could be done in either order.

---

### Task 1: Extract the shared handshake toolkit

`McpDaemonProtocol.ts` currently mixes MCP-specific addressing with a generic daemon toolkit. Split it so the global daemon can reuse the generic half without importing anything MCP.

The extraction must leave every existing MCP call site compiling **unchanged** — `McpDaemon.ts` and `McpProxy.ts` keep importing the same names from the same module. That is what makes this a safe refactor rather than a rewrite: the existing `McpDaemonProtocol.test.ts` suite is the regression proof.

**Files:**
- Create: `cli/src/core/DaemonHandshake.ts`
- Create: `cli/src/core/DaemonHandshake.test.ts`
- Modify: `cli/src/mcp/McpDaemonProtocol.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `cliCoreVersion(): string`
  - `isCoreVersionNewer(candidate: string, incumbent: string): boolean`
  - `type DaemonGreeting = { readonly t: "attach" } | { readonly t: "retire" }`
  - `parseDaemonGreeting(line: string): DaemonGreeting | undefined`
  - `encodeHandshakeLine(message: { readonly t: string }): string`
  - `readHandshakeLine(socket: Readable, timeoutMs?: number): Promise<{ line: string; rest: Buffer } | undefined>`
  - `HANDSHAKE_TIMEOUT_MS: 10_000`
  - `daemonSocketDir(prefix: string, uid: number): string`
  - `ensureSocketParentDir(socketPath: string, platform?: NodeJS.Platform): Promise<void>`
  - `isSocketDirSafe(dir: string, uid: number, platform?: NodeJS.Platform): boolean`
  - `isInSocketDir(socketPath: string, dir: string, platform?: NodeJS.Platform): boolean`

- [ ] **Step 1: Write the failing test for the generalized socket-dir helpers**

Create `cli/src/core/DaemonHandshake.test.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	daemonSocketDir,
	encodeHandshakeLine,
	isCoreVersionNewer,
	isInSocketDir,
	parseDaemonGreeting,
} from "./DaemonHandshake.js";

describe("daemonSocketDir", () => {
	it("puts the prefix and uid in the directory name under tmpdir", () => {
		expect(daemonSocketDir("global", 501)).toBe(join(tmpdir(), ".jolli-global-501"));
	});

	it("gives two prefixes two directories for the same uid", () => {
		expect(daemonSocketDir("mcp", 501)).not.toBe(daemonSocketDir("global", 501));
	});
});

describe("isInSocketDir", () => {
	it("accepts a socket directly inside the given directory", () => {
		const dir = daemonSocketDir("global", 501);
		expect(isInSocketDir(join(dir, "daemon.sock"), dir, "linux")).toBe(true);
	});

	it("rejects a socket elsewhere", () => {
		const dir = daemonSocketDir("global", 501);
		expect(isInSocketDir(join(tmpdir(), "scratch.sock"), dir, "linux")).toBe(false);
	});

	it("is always false on win32, whose named pipes have no directory", () => {
		const dir = daemonSocketDir("global", 501);
		expect(isInSocketDir(join(dir, "daemon.sock"), dir, "win32")).toBe(false);
	});
});

describe("isCoreVersionNewer", () => {
	it("is strict so a tie attaches instead of retiring", () => {
		expect(isCoreVersionNewer("0.99.3", "0.99.3")).toBe(false);
	});

	it("ranks a higher patch as newer", () => {
		expect(isCoreVersionNewer("0.99.4", "0.99.3")).toBe(true);
	});

	it("treats the unrankable dev sentinel as equal in both directions", () => {
		expect(isCoreVersionNewer("dev", "0.99.3")).toBe(false);
		expect(isCoreVersionNewer("0.99.3", "dev")).toBe(false);
	});
});

describe("greeting framing", () => {
	it("round-trips a retire greeting through one NDJSON line", () => {
		const line = encodeHandshakeLine({ t: "retire" });
		expect(line.endsWith("\n")).toBe(true);
		expect(parseDaemonGreeting(line.trimEnd())).toEqual({ t: "retire" });
	});

	it("returns undefined for malformed JSON", () => {
		expect(parseDaemonGreeting("{not json")).toBeUndefined();
	});

	it("returns undefined for an unknown verb", () => {
		expect(parseDaemonGreeting(JSON.stringify({ t: "explode" }))).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/core/DaemonHandshake.test.ts`
Expected: FAIL — `Failed to resolve import "./DaemonHandshake.js"`.

- [ ] **Step 3: Create the shared module by moving code out of `McpDaemonProtocol.ts`**

Create `cli/src/core/DaemonHandshake.ts`. Move these **verbatim** from `cli/src/mcp/McpDaemonProtocol.ts`, keeping their existing doc comments (they carry measured rationale that must not be lost): `cliCoreVersion`, `isCoreVersionNewer`, `readHandshakeLine`, `HANDSHAKE_TIMEOUT_MS`, `MAX_HANDSHAKE_BYTES`, `ensureSocketParentDir`.

Then add the generalized pieces:

```ts
/**
 * Directory holding one flavour of this user's daemon sockets.
 *
 * Under `tmpdir()` rather than `~/.jolli/jollimemory/` on purpose: a home
 * directory can sit on NFS or a synced folder, neither of which can host a unix
 * socket, and a socket is per-boot state that has no business surviving a
 * reboot. The uid is in the NAME (not only the mode) because on Linux `/tmp` is
 * shared: without it, the first user to create the directory would own the mode
 * bits for everyone else.
 *
 * `prefix` separates daemon flavours (`mcp`, `global`) so one flavour's safety
 * verdict can never be read as another's.
 */
export function daemonSocketDir(prefix: string, uid: number): string {
	return join(tmpdir(), `.jolli-${prefix}-${uid}`);
}

/**
 * Whether `dir` is exclusively this user's.
 *
 * Not paranoia about our own `mkdir`: on a shared `/tmp` (Linux — macOS gives
 * each user their own `tmpdir()`) another user can win the race to create the
 * directory, and binding inside a directory they control would let them
 * intercept the connection. A refusal is cheap; the caller degrades.
 *
 * Always true on Windows, whose named pipes live in a kernel namespace with no
 * directory to police.
 */
export function isSocketDirSafe(dir: string, uid: number, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return true;
	try {
		const st = statSync(dir);
		// `& 0o077` — any permission granted to group or other. Owner bits are
		// irrelevant to the question being asked.
		return st.uid === uid && (st.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

/**
 * Whether `socketPath` lives directly in `dir` — i.e. whether
 * {@link isSocketDirSafe} governs it.
 *
 * Compared with {@link normalizePathForCompareOn} because on a case-insensitive
 * filesystem two spellings of the directory are one directory, and a
 * case-sensitive string test would let a path that IS in the managed directory
 * present itself as an unpoliced scratch path.
 *
 * Always false on Windows — see {@link daemonSocketDir}.
 */
export function isInSocketDir(
	socketPath: string,
	dir: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform === "win32") return false;
	return normalizePathForCompareOn(dirname(socketPath), platform) === normalizePathForCompareOn(dir, platform);
}

/** The two things any client can say to any Jolli daemon after its hello. */
export type DaemonGreeting = { readonly t: "attach" } | { readonly t: "retire" };

/** Serialises one handshake message as the single NDJSON line the wire expects. */
export function encodeHandshakeLine(message: { readonly t: string }): string {
	return `${JSON.stringify(message)}\n`;
}

/** Parses a client greeting; `undefined` for anything the daemon cannot act on. */
export function parseDaemonGreeting(line: string): DaemonGreeting | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { t } = parsed as Record<string, unknown>;
	return t === "attach" || t === "retire" ? { t } : undefined;
}
```

Required imports for the new file:

```ts
import { statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { normalizePathForCompareOn } from "./PathUtils.js";
```

Note the import path is `./PathUtils.js` (same directory), not `../core/PathUtils.js`.

- [ ] **Step 4: Rewrite `McpDaemonProtocol.ts` as thin MCP-specific wrappers**

Delete the moved bodies and replace them with re-exports plus MCP-shaped wrappers. Every name previously exported must still be exported with the same signature:

```ts
import {
	daemonSocketDir,
	type DaemonGreeting,
	isInSocketDir,
	isSocketDirSafe,
	parseDaemonGreeting,
} from "../core/DaemonHandshake.js";

export {
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	HANDSHAKE_TIMEOUT_MS,
	isCoreVersionNewer,
	readHandshakeLine,
} from "../core/DaemonHandshake.js";

/** MCP's greeting vocabulary is the shared one; the alias keeps call sites unchanged. */
export type McpClientGreeting = DaemonGreeting;

/** @see parseDaemonGreeting */
export const parseClientGreeting = parseDaemonGreeting;

/** Directory holding this user's MCP daemon sockets. */
export function mcpSocketDir(uid: number): string {
	return daemonSocketDir("mcp", uid);
}

/** Whether the derived MCP socket directory is exclusively this user's. */
export function isManagedSocketDirSafe(uid: number, platform: NodeJS.Platform = process.platform): boolean {
	return isSocketDirSafe(mcpSocketDir(uid), uid, platform);
}

/** Whether `socketPath` lives directly in this user's managed MCP socket directory. */
export function isInManagedSocketDir(
	socketPath: string,
	uid: number,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return isInSocketDir(socketPath, mcpSocketDir(uid), platform);
}
```

Keep `MCP_DAEMON_PROTOCOL`, `McpDaemonHello`, `mcpSocketPath`, `sameWorktreeRoot` and `parseDaemonHello` where they are — they are MCP-specific and stay.

**Fix the import table precisely** — `noUnusedImports` is an **error**, so a leftover import fails lint. After the extraction `McpDaemonProtocol.ts` still needs exactly:

```ts
import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizePathForCompareOn } from "../core/PathUtils.js";
```

(`createHash` + `join` + `normalizePathForCompareOn` for `mcpSocketPath`; `normalizePathForCompareOn` again for `sameWorktreeRoot`.) These four move out and their imports must be **deleted**: `statSync`, `mkdir` from `node:fs/promises`, `tmpdir`, `dirname`, and the `Readable` type import.

`encodeHandshakeLine` was typed `(message: McpDaemonHello | McpClientGreeting)` and is now `(message: { readonly t: string })`. Both `McpDaemonHello` and `McpClientGreeting` have a literal `t`, so every existing call site still type-checks.

- [ ] **Step 5: Run the new test plus the existing MCP suites**

Run: `npm run test -w @jolli.ai/cli -- src/core/DaemonHandshake.test.ts src/mcp/McpDaemonProtocol.test.ts src/mcp/McpDaemon.test.ts src/mcp/McpProxy.test.ts`
Expected: PASS, all four files. The three MCP files passing unchanged is the proof the extraction preserved behaviour.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck:cli` then `npm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/DaemonHandshake.ts cli/src/core/DaemonHandshake.test.ts cli/src/mcp/McpDaemonProtocol.ts
git commit -s -m "refactor: extract the generic daemon handshake toolkit

McpDaemonProtocol mixed MCP-specific addressing with a generic 'one daemon
per key, newest build wins' toolkit. The generic half moves to
core/DaemonHandshake so a second daemon flavour can reuse it without
importing anything MCP.

McpDaemonProtocol keeps every name it exported, now as thin wrappers, so
McpDaemon and McpProxy compile unchanged — their existing suites passing
untouched is what proves the split preserved behaviour."
```

---

### Task 2: The global daemon's address and hello

**Files:**
- Create: `cli/src/daemon/GlobalDaemonProtocol.ts`
- Create: `cli/src/daemon/GlobalDaemonProtocol.test.ts`

**Interfaces:**
- Consumes: `daemonSocketDir`, `DaemonGreeting`, `encodeHandshakeLine` from `cli/src/core/DaemonHandshake.js` (Task 1).
- Produces:
  - `GLOBAL_DAEMON_PROTOCOL: 1`
  - `interface GlobalDaemonHello { readonly t: "hello"; readonly protocol: number; readonly version: string; readonly pid: number; readonly startedAt: number }`
  - `globalSocketDir(uid: number): string`
  - `globalSocketPath(opts?: { platform?: NodeJS.Platform; uid?: number }): string`
  - `parseGlobalDaemonHello(line: string): GlobalDaemonHello | undefined`
  - `GLOBAL_HELLO_TIMEOUT_MS: 300`

- [ ] **Step 1: Write the failing test**

Create `cli/src/daemon/GlobalDaemonProtocol.test.ts`:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	GLOBAL_DAEMON_PROTOCOL,
	GLOBAL_HELLO_TIMEOUT_MS,
	globalSocketPath,
	parseGlobalDaemonHello,
} from "./GlobalDaemonProtocol.js";

describe("globalSocketPath", () => {
	it("uses one fixed filename per user — there is no path to encode", () => {
		expect(globalSocketPath({ platform: "linux", uid: 501 })).toBe(
			join(tmpdir(), ".jolli-global-501", "daemon.sock"),
		);
	});

	it("gives two users two sockets", () => {
		expect(globalSocketPath({ platform: "linux", uid: 501 })).not.toBe(
			globalSocketPath({ platform: "linux", uid: 502 }),
		);
	});

	it("uses a named pipe on win32", () => {
		expect(globalSocketPath({ platform: "win32", uid: 501 })).toBe("\\\\.\\pipe\\jolli-global-501");
	});
});

describe("parseGlobalDaemonHello", () => {
	const valid = {
		t: "hello",
		protocol: GLOBAL_DAEMON_PROTOCOL,
		version: "0.99.3",
		pid: 4242,
		startedAt: 1_754_000_000_000,
	};

	it("accepts a well-formed hello", () => {
		expect(parseGlobalDaemonHello(JSON.stringify(valid))).toEqual(valid);
	});

	it("rejects a foreign protocol rather than guessing", () => {
		expect(parseGlobalDaemonHello(JSON.stringify({ ...valid, protocol: 99 }))).toBeUndefined();
	});

	it("rejects a hello missing startedAt", () => {
		const { startedAt: _dropped, ...withoutStartedAt } = valid;
		expect(parseGlobalDaemonHello(JSON.stringify(withoutStartedAt))).toBeUndefined();
	});

	it("rejects malformed JSON without throwing", () => {
		expect(parseGlobalDaemonHello("{")).toBeUndefined();
	});

	it("rejects a non-object payload", () => {
		expect(parseGlobalDaemonHello("42")).toBeUndefined();
	});
});

describe("GLOBAL_HELLO_TIMEOUT_MS", () => {
	it("is far below the MCP handshake budget — this one rides a git hook", () => {
		expect(GLOBAL_HELLO_TIMEOUT_MS).toBe(300);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/GlobalDaemonProtocol.test.ts`
Expected: FAIL — cannot resolve `./GlobalDaemonProtocol.js`.

- [ ] **Step 3: Implement**

Create `cli/src/daemon/GlobalDaemonProtocol.ts`:

```ts
/**
 * Wire contract between any Jolli entry point and `jolli global-daemon` — the
 * one resident process per machine per user.
 *
 * The singleton key is the machine+user and nothing finer. That is not a choice
 * between options: `jollimemory.db` lives at `~/.jolli/jollimemory/` and there
 * is exactly one per machine, so a process whose job is to maintain that file
 * has no reason to be more granular than the file. Contrast `mcpSocketPath`,
 * which keys on the worktree because five of the ten MCP tools are
 * branch-scoped.
 *
 * As in the MCP handshake, the DIST VERSION travels in `hello`, never in the
 * path. Baking it into the address would let two installed bundles keep two
 * daemons forever; in the handshake, the newer trigger retires the incumbent
 * and everything converges on one process.
 */

import { join } from "node:path";
import { daemonSocketDir } from "../core/DaemonHandshake.js";

/**
 * Handshake protocol version, independent of `MCP_DAEMON_PROTOCOL`. Bump ONLY
 * on an incompatible change to the message shapes — a trigger that sees an
 * unknown protocol treats the daemon as unusable, which is safe but costs the
 * version convergence this exists for.
 *
 * Adding an optional field to {@link GlobalDaemonHello} is compatible and must
 * NOT bump it: an older trigger ignores what it does not read.
 */
export const GLOBAL_DAEMON_PROTOCOL = 1;

/**
 * How long a trigger waits for `hello` before giving up on the version check.
 *
 * Deliberately NOT `HANDSHAKE_TIMEOUT_MS` (10 s). This handshake runs on the
 * `post-commit` path, whose budget is under 5 ms, and the daemon's response
 * time has no upper bound: it runs `VACUUM INTO` through `node:sqlite`'s
 * synchronous API, which stops its event loop for the duration (measured: 547 ms
 * on a 143 MB database, plus 196 ms for the verifying `integrity_check`, both
 * scaling with size).
 *
 * A timeout here is NOT treated as a dead daemon — see `EnsureGlobalDaemon`. A
 * successful `connect()` already proved something is listening; `hello` only
 * refines that into "which build", so the budget is short and the failure is
 * simply doing nothing.
 */
export const GLOBAL_HELLO_TIMEOUT_MS = 300;

/**
 * First line on the wire, daemon → trigger, sent the instant a connection is
 * accepted. The daemon speaks first for the same reason the MCP one does: the
 * trigger needs `version` before it decides, and the alternative would put the
 * retire decision in the process that has to be retired.
 *
 * `startedAt` replaces the MCP hello's `cwd` — a machine-global daemon has no
 * cwd to assert, and uptime is what the `doctor` row wants.
 */
export interface GlobalDaemonHello {
	readonly t: "hello";
	readonly protocol: number;
	/** The daemon's `@jolli.ai/cli` CORE version — see `cliCoreVersion`. */
	readonly version: string;
	readonly pid: number;
	/** Epoch milliseconds at which the daemon bound its socket. */
	readonly startedAt: number;
}

/** Directory holding this user's global daemon socket. */
export function globalSocketDir(uid: number): string {
	return daemonSocketDir("global", uid);
}

/**
 * The socket (unix) or named pipe (Windows) for this user's global daemon.
 *
 * A FIXED filename, unlike `mcpSocketPath`'s hash: that one hashes because a
 * real worktree path blows the 104-byte `sun_path` cap, and there is no path to
 * encode here. One user, one daemon, one name.
 */
export function globalSocketPath(opts: { platform?: NodeJS.Platform; uid?: number } = {}): string {
	const platform = opts.platform ?? process.platform;
	const uid = opts.uid ?? process.getuid?.() ?? 0;
	// Windows named pipes live in their own kernel namespace: no directory to
	// create, no mode bits to police, and no stale file left behind if the daemon
	// is killed — the pipe disappears with its last handle.
	if (platform === "win32") return `\\\\.\\pipe\\jolli-global-${uid}`;
	return join(globalSocketDir(uid), "daemon.sock");
}

/**
 * Parses a daemon greeting, returning `undefined` for anything unusable —
 * malformed JSON, a foreign protocol, or a missing field.
 *
 * Total (never throws) because the caller answers every failure the same way:
 * treat the peer as not-a-Jolli-daemon. Something else listening on a stale
 * path is a real possibility after a tmpdir sweep.
 */
export function parseGlobalDaemonHello(line: string): GlobalDaemonHello | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { t, protocol, version, pid, startedAt } = parsed as Record<string, unknown>;
	if (t !== "hello" || protocol !== GLOBAL_DAEMON_PROTOCOL) return undefined;
	if (typeof version !== "string" || typeof pid !== "number" || typeof startedAt !== "number") return undefined;
	return { t: "hello", protocol, version, pid, startedAt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/GlobalDaemonProtocol.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/daemon/GlobalDaemonProtocol.ts cli/src/daemon/GlobalDaemonProtocol.test.ts
git commit -s -m "feat: address and hello for the machine-global daemon

One socket per user with a fixed name — there is no path to encode, unlike
the MCP daemon's worktree hash. The version travels in hello so a newer
bundle can retire an older daemon instead of the two coexisting.

The hello read budget is 300ms rather than the MCP handshake's 10s: this
one runs on the post-commit path, and the daemon's response time is
unbounded because VACUUM INTO blocks its event loop."
```

---

### Task 3: The stateless task scheduler

**Files:**
- Create: `cli/src/daemon/TaskScheduler.ts`
- Create: `cli/src/daemon/TaskScheduler.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface DaemonTask { readonly name: string; readonly tickIntervalMs: number; run(): Promise<string> }`
  - `interface SchedulerHandle { stop(): void }`
  - `startScheduler(tasks: ReadonlyArray<DaemonTask>, deps?: SchedulerDeps): SchedulerHandle`
  - `interface SchedulerDeps { readonly setInterval?: typeof globalThis.setInterval; readonly clearInterval?: typeof globalThis.clearInterval; readonly onTaskResult?: (name: string, result: string) => void; readonly onTaskError?: (name: string, error: unknown) => void }`

- [ ] **Step 1: Write the failing test**

Create `cli/src/daemon/TaskScheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DaemonTask, startScheduler } from "./TaskScheduler.js";

/** Lets the microtask queue drain so an awaited `run()` settles. */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("startScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ticks each task once immediately, so downtime catch-up needs no code", async () => {
		const run = vi.fn(async () => "did the thing");
		const task: DaemonTask = { name: "backup", tickIntervalMs: 60_000, run };

		const handle = startScheduler([task]);
		await flush();

		expect(run).toHaveBeenCalledTimes(1);
		handle.stop();
	});

	it("ticks again once the interval elapses", async () => {
		const run = vi.fn(async () => "ok");
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run }]);
		await flush();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
	});

	it("keeps ticking after a task throws", async () => {
		const run = vi
			.fn<[], Promise<string>>()
			.mockRejectedValueOnce(new Error("backup drive unplugged"))
			.mockResolvedValue("ok");
		const onTaskError = vi.fn();
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run }], { onTaskError });
		await flush();

		expect(onTaskError).toHaveBeenCalledWith("backup", expect.any(Error));

		await vi.advanceTimersByTimeAsync(60_000);
		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
	});

	it("does not overlap a task with itself when a run outlives its interval", async () => {
		let release: (() => void) | undefined;
		const run = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = () => resolve("slow");
				}),
		);
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 1_000, run }]);
		await flush();
		expect(run).toHaveBeenCalledTimes(1);

		// Three intervals pass while the first run is still in flight.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(run).toHaveBeenCalledTimes(1);

		release?.();
		await flush();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(run).toHaveBeenCalledTimes(2);
		handle.stop();
	});

	it("stops ticking after stop()", async () => {
		const run = vi.fn(async () => "ok");
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run }]);
		await flush();
		handle.stop();

		await vi.advanceTimersByTimeAsync(180_000);

		expect(run).toHaveBeenCalledTimes(1);
	});

	it("reports each task's result string for logging", async () => {
		const onTaskResult = vi.fn();
		const handle = startScheduler([{ name: "backup", tickIntervalMs: 60_000, run: async () => "created" }], {
			onTaskResult,
		});
		await flush();

		expect(onTaskResult).toHaveBeenCalledWith("backup", "created");
		handle.stop();
	});

	it("runs independent tasks on their own intervals", async () => {
		const fast = vi.fn(async () => "fast");
		const slow = vi.fn(async () => "slow");
		const handle = startScheduler([
			{ name: "fast", tickIntervalMs: 1_000, run: fast },
			{ name: "slow", tickIntervalMs: 10_000, run: slow },
		]);
		await flush();

		await vi.advanceTimersByTimeAsync(1_000);

		expect(fast).toHaveBeenCalledTimes(2);
		expect(slow).toHaveBeenCalledTimes(1);
		handle.stop();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/TaskScheduler.test.ts`
Expected: FAIL — cannot resolve `./TaskScheduler.js`.

- [ ] **Step 3: Implement**

Create `cli/src/daemon/TaskScheduler.ts`:

```ts
/**
 * TaskScheduler — the global daemon's ticker, and deliberately nothing more.
 *
 * It holds NO persistent state, and that falls out of a property its only task
 * already has rather than from minimalism for its own sake. `maybeSnapshot`
 * gates itself on `last-snapshot-at` in `schema_meta`, so the backup task
 * already knows whether it is due and that knowledge is already persisted,
 * already shared across processes. A scheduler that recorded its own `lastRun`
 * would become a second owner of the same fact, and nothing would say which to
 * believe when they disagreed.
 *
 * So `tickIntervalMs` is how often to ASK a task whether it is due — not how
 * often it acts. Backup is asked hourly and answers "already done today" 23
 * times out of 24.
 *
 * Three properties come free from that shape:
 *
 *   - **Catch-up needs no code.** Every task is ticked once at startup, so a
 *     machine that was off for three days snapshots on the first tick. There is
 *     no "missed run" to model.
 *   - **Retire needs no handover.** A fresh daemon inherits nothing and
 *     self-aligns on its first tick.
 *   - **No cron vocabulary.** "24 hours since the last success" is already
 *     expressed inside the task; restating it here would be the second owner
 *     again.
 */

import { createLogger, errMsg } from "../Logger.js";

const log = createLogger("TaskScheduler");

/** One thing the daemon asks about on a clock. */
export interface DaemonTask {
	readonly name: string;
	/** How often to ASK this task whether it is due — not its execution period. */
	readonly tickIntervalMs: number;
	/** The task decides whether to act. The returned string is for logging only. */
	run(): Promise<string>;
}

export interface SchedulerDeps {
	/** Test seam. Defaults to the global timer. */
	readonly setInterval?: typeof globalThis.setInterval;
	readonly clearInterval?: typeof globalThis.clearInterval;
	readonly onTaskResult?: (name: string, result: string) => void;
	readonly onTaskError?: (name: string, error: unknown) => void;
}

export interface SchedulerHandle {
	stop(): void;
}

/**
 * Starts ticking every task and returns a handle that stops all of them.
 *
 * A task that throws is reported and its schedule continues: backup failure
 * already has an independent, result-oriented signal (`backupHealthCheck`, on
 * `jolli doctor`), so a second one here would be noise — and stopping the
 * schedule would turn one bad day into a permanently dead timer.
 *
 * A task never overlaps itself. `VACUUM INTO` on a large database can outlive a
 * short tick interval, and two concurrent snapshots would race on the same temp
 * file; the in-flight flag is cheaper than any lock and is correct because this
 * is one process.
 */
export function startScheduler(tasks: ReadonlyArray<DaemonTask>, deps: SchedulerDeps = {}): SchedulerHandle {
	const setIntervalImpl = deps.setInterval ?? globalThis.setInterval;
	const clearIntervalImpl = deps.clearInterval ?? globalThis.clearInterval;
	const timers: Array<ReturnType<typeof globalThis.setInterval>> = [];
	const inFlight = new Set<string>();

	const tick = (task: DaemonTask): void => {
		if (inFlight.has(task.name)) {
			log.debug("%s still running; skipping this tick", task.name);
			return;
		}
		inFlight.add(task.name);
		void task
			.run()
			.then((result) => {
				log.debug("%s: %s", task.name, result);
				deps.onTaskResult?.(task.name, result);
			})
			.catch((error: unknown) => {
				log.warn("%s failed: %s", task.name, errMsg(error));
				deps.onTaskError?.(task.name, error);
			})
			.finally(() => {
				inFlight.delete(task.name);
			});
	};

	for (const task of tasks) {
		// Tick once now: this is the entire catch-up mechanism.
		tick(task);
		const timer = setIntervalImpl(() => tick(task), task.tickIntervalMs);
		// The listening socket keeps the daemon alive on its own, so an unref'd
		// timer is what lets "socket closed -> process exits" work. Note this is
		// the OPPOSITE of McpProxy's retry timer, which must NOT be unref'd
		// because there it is the only handle keeping the loop alive.
		timer.unref?.();
		timers.push(timer);
	}

	return {
		stop(): void {
			for (const timer of timers) clearIntervalImpl(timer);
			timers.length = 0;
		},
	};
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/TaskScheduler.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/daemon/TaskScheduler.ts cli/src/daemon/TaskScheduler.test.ts
git commit -s -m "feat: stateless ticker for the global daemon

tickIntervalMs is how often to ASK a task whether it is due, not how often
it acts. The scheduler stores no lastRun because maybeSnapshot already
gates itself on last-snapshot-at in the database — a second copy of that
fact would have no tie-breaker.

Catch-up after downtime and handover after a retire then need no code at
all: every task is ticked once at startup and answers for itself."
```

---

### Task 4: The daemon process and its command

**Files:**
- Create: `cli/src/daemon/GlobalDaemon.ts`
- Create: `cli/src/daemon/GlobalDaemon.test.ts`
- Create: `cli/src/commands/GlobalDaemonCommand.ts`
- Modify: `cli/src/Api.ts`

**Interfaces:**
- Consumes: `GLOBAL_DAEMON_PROTOCOL`, `GlobalDaemonHello`, `globalSocketPath`, `globalSocketDir` (Task 2); `startScheduler`, `DaemonTask` (Task 3); `cliCoreVersion`, `encodeHandshakeLine`, `readHandshakeLine`, `parseDaemonGreeting`, `ensureSocketParentDir`, `isSocketDirSafe`, `isInSocketDir`, `HANDSHAKE_TIMEOUT_MS` (Task 1).
- Produces:
  - `GLOBAL_DAEMON_COMMAND = "global-daemon"`
  - `type GlobalDaemonExitReason = "unsafe-socket-dir" | "address-in-use" | "listen-failed" | "retired"`
  - `runGlobalDaemon(options: RunGlobalDaemonOptions): Promise<GlobalDaemonExitReason>`
  - `interface RunGlobalDaemonOptions { readonly socketPath?: string; readonly tasks?: ReadonlyArray<DaemonTask>; readonly onListening?: (socketPath: string) => void }`
  - `registerGlobalDaemonCommand(program: Command): void`

- [ ] **Step 1: Write the failing test**

Create `cli/src/daemon/GlobalDaemon.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHandshakeLine, readHandshakeLine } from "../core/DaemonHandshake.js";
import { runGlobalDaemon } from "./GlobalDaemon.js";
import { parseGlobalDaemonHello } from "./GlobalDaemonProtocol.js";
import type { DaemonTask } from "./TaskScheduler.js";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "jolli-globald-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

/** Connects and reads the daemon's hello line. */
async function connectAndRead(socketPath: string): Promise<{ socket: Socket; hello: string | undefined }> {
	const socket = await new Promise<Socket>((resolve, reject) => {
		const s = connect(socketPath);
		s.once("connect", () => resolve(s));
		s.once("error", reject);
	});
	const read = await readHandshakeLine(socket, 5_000);
	return { socket, hello: read?.line };
}

/** Starts a daemon on a scratch socket and resolves once it is bound. */
function startDaemon(
	socketPath: string,
	tasks: ReadonlyArray<DaemonTask> = [],
): { exit: Promise<string>; listening: Promise<void> } {
	let signalListening: () => void = () => {};
	const listening = new Promise<void>((resolve) => {
		signalListening = resolve;
	});
	const exit = runGlobalDaemon({ socketPath, tasks, onListening: () => signalListening() });
	return { exit, listening };
}

describe("runGlobalDaemon", () => {
	it("greets a connecting client with a hello carrying its version and pid", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const { socket, hello } = await connectAndRead(socketPath);
		const parsed = parseGlobalDaemonHello(hello ?? "");

		expect(parsed?.pid).toBe(process.pid);
		expect(typeof parsed?.version).toBe("string");
		expect(parsed?.startedAt).toBeGreaterThan(0);

		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("exits with 'retired' when a client asks it to stand down", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));

		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("keeps running when a client attaches and disconnects", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const first = await connectAndRead(socketPath);
		first.socket.write(encodeHandshakeLine({ t: "attach" }));
		first.socket.destroy();

		// Still serving: a second client gets a hello too.
		const second = await connectAndRead(socketPath);
		expect(parseGlobalDaemonHello(second.hello ?? "")).toBeDefined();

		second.socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		second.socket.destroy();
	});

	it("keeps running when a client connects and says nothing", async () => {
		const socketPath = join(scratch, "d.sock");
		const { exit, listening } = startDaemon(socketPath);
		await listening;

		const probe = await connectAndRead(socketPath);
		probe.socket.destroy(); // the trigger's "I only wanted to know you exist" path

		const second = await connectAndRead(socketPath);
		expect(parseGlobalDaemonHello(second.hello ?? "")).toBeDefined();

		second.socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		second.socket.destroy();
	});

	it("answers 'address-in-use' rather than throwing when another daemon holds the socket", async () => {
		const socketPath = join(scratch, "d.sock");
		const first = startDaemon(socketPath);
		await first.listening;

		// Losing the bind race is the SUCCESS case from the caller's viewpoint:
		// a daemon for this user exists, which is all anyone wanted.
		await expect(runGlobalDaemon({ socketPath, tasks: [] })).resolves.toBe("address-in-use");

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(first.exit).resolves.toBe("retired");
		socket.destroy();
	});

	it("runs its registered tasks once at startup", async () => {
		const socketPath = join(scratch, "d.sock");
		const run = vi.fn(async () => "snapshot skipped");
		const { exit, listening } = startDaemon(socketPath, [
			{ name: "backup", tickIntervalMs: 3_600_000, run },
		]);
		await listening;

		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

		const { socket } = await connectAndRead(socketPath);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		await expect(exit).resolves.toBe("retired");
		socket.destroy();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/GlobalDaemon.test.ts`
Expected: FAIL — cannot resolve `./GlobalDaemon.js`.

- [ ] **Step 3: Implement the daemon**

Create `cli/src/daemon/GlobalDaemon.ts`:

```ts
/**
 * GlobalDaemon — the one resident process per machine per user.
 *
 * It exists to run work that must happen when NOBODY is working: today the
 * daily `jollimemory.db` snapshot, next the periodic session-activity upload.
 * Every other trigger for that snapshot is opportunistic (the dashboard
 * launcher, the post-commit worker, `doctor`), which covers the user who
 * commits regularly and abandons the user who does not — exactly the user who
 * needs an old snapshot most.
 *
 * Owned by NO session, spawned detached. Unlike `McpDaemon` it has **no idle
 * timeout**, and that inversion is the whole point: the MCP daemon reaps itself
 * when its last client leaves because it exists to serve clients, whereas this
 * one exists to be awake when there is nobody to serve. Its only exit paths are
 * a retire from a newer bundle, a lost bind race, and the machine going down.
 *
 * Lifecycle in one line: bind → hello → (attach | retire) → tick → retired.
 */

import { createServer, type Server as NetServer, type Socket } from "node:net";
import { homedir } from "node:os";
import {
	cliCoreVersion,
	encodeHandshakeLine,
	ensureSocketParentDir,
	isInSocketDir,
	isSocketDirSafe,
	parseDaemonGreeting,
	readHandshakeLine,
} from "../core/DaemonHandshake.js";
import { opportunisticSnapshot } from "../dashboard/Backup.js";
import { createLogger, errMsg, setLogDir } from "../Logger.js";
import {
	GLOBAL_DAEMON_PROTOCOL,
	type GlobalDaemonHello,
	globalSocketDir,
	globalSocketPath,
} from "./GlobalDaemonProtocol.js";
import { type DaemonTask, startScheduler } from "./TaskScheduler.js";

const log = createLogger("GlobalDaemon");

/** The hidden subcommand name, shared with the trigger that spawns it. */
export const GLOBAL_DAEMON_COMMAND = "global-daemon";

/** How long to wait for a client's greeting before dropping the connection. */
const GREETING_TIMEOUT_MS = 5_000;

/** How often to ASK the backup task whether it is due. See `TaskScheduler`. */
const BACKUP_TICK_MS = 60 * 60 * 1000;

/** Why the daemon stopped — surfaced for logs and asserted by tests. */
export type GlobalDaemonExitReason = "unsafe-socket-dir" | "address-in-use" | "listen-failed" | "retired";

export interface RunGlobalDaemonOptions {
	/** Override the derived socket path. Tests pass a scratch path. */
	readonly socketPath?: string;
	/** Override the task set. Defaults to {@link defaultTasks}. */
	readonly tasks?: ReadonlyArray<DaemonTask>;
	/** Notified once the socket is bound. Tests await this instead of polling. */
	readonly onListening?: (socketPath: string) => void;
}

/**
 * The tasks a production daemon runs.
 *
 * `opportunisticSnapshot` is asked hourly and decides for itself: it reads
 * `last-snapshot-at` from the database and skips unless a day has passed. The
 * daemon adds no scheduling knowledge of its own — see `TaskScheduler`.
 */
export function defaultTasks(): ReadonlyArray<DaemonTask> {
	return [
		{
			name: "backup",
			tickIntervalMs: BACKUP_TICK_MS,
			run: async (): Promise<string> => {
				const result = await opportunisticSnapshot();
				return result.status === "created" ? `created ${result.path}` : `${result.status}: ${result.reason}`;
			},
		},
	];
}

/**
 * Runs the daemon until it is retired or loses the bind race.
 *
 * Never throws for "another daemon got there first": losing that race is the
 * SUCCESS case from the caller's point of view — a daemon for this user exists,
 * which is all anyone wanted.
 */
export async function runGlobalDaemon(options: RunGlobalDaemonOptions = {}): Promise<GlobalDaemonExitReason> {
	const socketPath = options.socketPath ?? globalSocketPath();
	const tasks = options.tasks ?? defaultTasks();

	// A detached process inherits its spawner's cwd, and `getJolliMemoryDir()`
	// falls back to `process.cwd()`. Left alone, this daemon would write
	// debug.log into whichever repository happened to trigger it first — a
	// different one across reboots. `homedir()` lands it in the global config
	// dir, since getGlobalConfigDir() is join(homedir(), ".jolli", "jollimemory").
	setLogDir(homedir());

	await ensureSocketParentDir(socketPath);
	const uid = process.getuid?.() ?? 0;
	const dir = globalSocketDir(uid);
	// The gate follows the PATH, not who chose it: production always lands in the
	// shared-/tmp directory the gate exists to police, while a test's scratch
	// path elsewhere is its own choice and is not second-guessed.
	if (isInSocketDir(socketPath, dir) && !isSocketDirSafe(dir, uid)) {
		log.warn("Refusing to bind: %s is not exclusively owned by this user", dir);
		return "unsafe-socket-dir";
	}

	const startedAt = Date.now();
	const hello: GlobalDaemonHello = {
		t: "hello",
		protocol: GLOBAL_DAEMON_PROTOCOL,
		version: cliCoreVersion(),
		pid: process.pid,
		startedAt,
	};

	return await new Promise<GlobalDaemonExitReason>((resolve) => {
		let settled = false;
		let scheduler: { stop(): void } | undefined;
		let server: NetServer | undefined;

		const finish = (reason: GlobalDaemonExitReason): void => {
			if (settled) return;
			settled = true;
			scheduler?.stop();
			server?.close();
			log.info("global daemon exiting: %s", reason);
			resolve(reason);
		};

		server = createServer((socket: Socket) => {
			socket.on("error", (err) => log.debug("client socket error: %s", errMsg(err)));
			socket.write(encodeHandshakeLine(hello));
			void readHandshakeLine(socket, GREETING_TIMEOUT_MS).then((read) => {
				const greeting = read ? parseDaemonGreeting(read.line) : undefined;
				if (greeting?.t === "retire") {
					socket.end();
					finish("retired");
					return;
				}
				// Everything else — `attach`, an unparseable line, a timeout, a client
				// that connected only to learn we exist and hung up — means carry on.
				// A probe closing its socket is the COMMON case, not an error: the
				// trigger's cheapest question is answered by connect() alone.
				socket.end();
			});
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				finish("address-in-use");
				return;
			}
			log.warn("listen failed: %s", errMsg(err));
			finish("listen-failed");
		});

		server.listen(socketPath, () => {
			log.info("global daemon listening on %s (pid %d, v%s)", socketPath, process.pid, hello.version);
			scheduler = startScheduler(tasks);
			options.onListening?.(socketPath);
		});
	});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/GlobalDaemon.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register the command**

Create `cli/src/commands/GlobalDaemonCommand.ts`:

```ts
/**
 * GlobalDaemonCommand — `jolli global-daemon`, the machine-global resident
 * process.
 *
 * Hidden from `jolli --help`: nothing asks a user to run this. Every entry
 * point spawns it through `ensureGlobalDaemon`, and it reaps itself when a
 * newer bundle retires it.
 *
 * The name is qualified because `jolli daemon` is already taken by the
 * per-project IDE stdio bridge, and the two run side by side.
 */

import type { Command } from "commander";
import { GLOBAL_DAEMON_COMMAND, runGlobalDaemon } from "../daemon/GlobalDaemon.js";

export function registerGlobalDaemonCommand(program: Command): void {
	program
		.command(GLOBAL_DAEMON_COMMAND, { hidden: true })
		.description("Machine-global resident process for scheduled maintenance work")
		.option("--socket <path>", "Override the derived socket path")
		.action(async (options: { socket?: string }) => {
			await runGlobalDaemon({ socketPath: options.socket });
		});
}
```

In `cli/src/Api.ts`, add the import alongside the other command imports and the registration call immediately after `registerMcpCommand(program);`:

```ts
registerGlobalDaemonCommand(program);
```

- [ ] **Step 6: Verify the command is registered and hidden**

Run: `npm run cli -- global-daemon --help`
Expected: prints the command's own help (proving it is registered).

Run: `npm run cli -- --help`
Expected: `global-daemon` does NOT appear in the listing (proving `hidden: true`).

- [ ] **Step 7: Typecheck, lint, commit**

Run: `npm run typecheck:cli` then `npm run lint`

```bash
git add cli/src/daemon/GlobalDaemon.ts cli/src/daemon/GlobalDaemon.test.ts \
        cli/src/commands/GlobalDaemonCommand.ts cli/src/Api.ts
git commit -s -m "feat: the machine-global daemon process

Binds one socket per user, announces its build version, and ticks its
tasks until a newer bundle retires it. No idle timeout, inverting
McpDaemon: that one reaps itself when its last client leaves because it
serves clients, while this one exists to be awake when there is nobody to
serve.

Losing the bind race resolves 'address-in-use' rather than throwing — from
the caller's point of view a daemon existing IS the success case.

setLogDir(homedir()) at startup: a detached process inherits its spawner's
cwd, so without it debug.log would land in whichever repo happened to
trigger the daemon first, and a different one after each reboot."
```

---

### Task 5: The trigger helper

**Files:**
- Create: `cli/src/daemon/EnsureGlobalDaemon.ts`
- Create: `cli/src/daemon/EnsureGlobalDaemon.test.ts`
- Modify: `cli/src/core/TelemetryCommandHook.ts`

**Interfaces:**
- Consumes: `globalSocketPath`, `parseGlobalDaemonHello`, `GLOBAL_HELLO_TIMEOUT_MS` (Task 2); `cliCoreVersion`, `isCoreVersionNewer`, `encodeHandshakeLine`, `readHandshakeLine` (Task 1); `GLOBAL_DAEMON_COMMAND` (Task 4).
- Produces:
  - `type EnsureOutcome = "already-running" | "spawned" | "retired-incumbent" | "skipped-unsupported-node" | "skipped-excluded-command" | "failed"`
  - `ensureGlobalDaemon(deps?: EnsureDeps): Promise<EnsureOutcome>`
  - `interface EnsureDeps { readonly socketPath?: string; readonly command?: string | null; readonly nodeVersion?: string; readonly ownVersion?: string; readonly helloTimeoutMs?: number; readonly spawnDaemon?: (socketPath: string) => void }`
  - `shouldSkipGlobalDaemon(command: string | null): boolean`
  - `retireGlobalDaemon(deps?: { readonly socketPath?: string }): Promise<boolean>`
  - In `TelemetryCommandHook.ts`: `getInvokedRootCommand(): string | null`

- [ ] **Step 1: Write the failing test**

Create `cli/src/daemon/EnsureGlobalDaemon.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHandshakeLine, readHandshakeLine } from "../core/DaemonHandshake.js";
import { ensureGlobalDaemon, shouldSkipGlobalDaemon } from "./EnsureGlobalDaemon.js";
import { GLOBAL_DAEMON_PROTOCOL, parseGlobalDaemonHello } from "./GlobalDaemonProtocol.js";

let scratch: string;
let servers: Server[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "jolli-ensure-"));
	servers = [];
});
afterEach(async () => {
	for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
	await rm(scratch, { recursive: true, force: true });
});

/**
 * A fake daemon that greets with `version` and records the greeting it is sent.
 * `silent: true` accepts the connection but never sends hello — the VACUUM case.
 */
async function fakeDaemon(
	socketPath: string,
	version: string,
	opts: { silent?: boolean } = {},
): Promise<{ greetings: string[] }> {
	const greetings: string[] = [];
	const server = createServer((socket) => {
		if (!opts.silent) {
			// Written as raw NDJSON rather than through `encodeHandshakeLine`: that
			// helper's parameter is `{ readonly t: string }`, and TypeScript's
			// excess-property check rejects an object literal carrying the other
			// hello fields. The wire format is one JSON object plus a newline.
			const hello = { t: "hello", protocol: GLOBAL_DAEMON_PROTOCOL, version, pid: 999, startedAt: 1 };
			socket.write(`${JSON.stringify(hello)}\n`);
		}
		void readHandshakeLine(socket, 2_000).then((read) => {
			if (read) greetings.push(read.line);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return { greetings };
}

describe("shouldSkipGlobalDaemon", () => {
	it.each(["global-daemon", "mcp", "mcp-serve", "daemon", "uninstall", "disable"])(
		"skips %s",
		(command) => {
			expect(shouldSkipGlobalDaemon(command)).toBe(true);
		},
	);

	it.each(["status", "recall", "search", "enable", "dashboard"])("does not skip %s", (command) => {
		expect(shouldSkipGlobalDaemon(command)).toBe(false);
	});

	it("does not skip when no command was resolved", () => {
		expect(shouldSkipGlobalDaemon(null)).toBe(false);
	});
});

describe("ensureGlobalDaemon", () => {
	it("spawns when nothing is listening", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe(
			"spawned",
		);
		expect(spawnDaemon).toHaveBeenCalledWith(socketPath);
	});

	it("attaches to an equal-versioned daemon instead of retiring it", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "0.99.3");
		const spawnDaemon = vi.fn();

		// A TIE must attach. Were ties to count as newer, two same-version
		// triggers would retire each other in turn and never share anything.
		const outcome = await ensureGlobalDaemon({
			socketPath,
			spawnDaemon,
			nodeVersion: "22.13.0",
			ownVersion: "0.99.3",
		});

		expect(outcome).toBe("already-running");
		expect(spawnDaemon).not.toHaveBeenCalled();
		expect(daemon.greetings).toEqual([]);
	});

	it("attaches when either version is the unrankable dev sentinel", async () => {
		const socketPath = join(scratch, "d.sock");
		await fakeDaemon(socketPath, "0.99.3");

		// A released trigger must not retire a developer's dev daemon on sight —
		// the replacement it spawns would be the same dev bundle, forever.
		await expect(
			ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0", ownVersion: "dev" }),
		).resolves.toBe("already-running");
	});

	it("does not retire a NEWER daemon", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "1.2.0");

		await expect(
			ensureGlobalDaemon({ socketPath, nodeVersion: "22.13.0", ownVersion: "1.1.0" }),
		).resolves.toBe("already-running");
		expect(daemon.greetings).toEqual([]);
	});

	it("retires a strictly older daemon but does NOT spawn the replacement", async () => {
		const socketPath = join(scratch, "d.sock");
		const daemon = await fakeDaemon(socketPath, "0.0.1");
		const spawnDaemon = vi.fn();

		const outcome = await ensureGlobalDaemon({
			socketPath,
			spawnDaemon,
			nodeVersion: "22.13.0",
			ownVersion: "9.9.9",
		});

		expect(outcome).toBe("retired-incumbent");
		// The retired daemon still holds the socket, and the trigger never waits
		// for its spawn — so an immediate replacement would die address-in-use,
		// silently. The next trigger respawns.
		expect(spawnDaemon).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(daemon.greetings).toEqual([JSON.stringify({ t: "retire" })]));
	});

	it("assumes alive and does nothing when hello never arrives", async () => {
		const socketPath = join(scratch, "d.sock");
		await fakeDaemon(socketPath, "unused", { silent: true });
		const spawnDaemon = vi.fn();

		// connect() succeeded, which already proves something is listening. Only
		// the version refinement was lost, so the correct answer is to do nothing.
		await expect(
			ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0", helloTimeoutMs: 50 }),
		).resolves.toBe("already-running");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("does not spawn on a runtime that cannot open the database", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "20.19.0" })).resolves.toBe(
			"skipped-unsupported-node",
		);
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("does not spawn for an excluded command", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn();

		await expect(
			ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0", command: "uninstall" }),
		).resolves.toBe("skipped-excluded-command");
		expect(spawnDaemon).not.toHaveBeenCalled();
	});

	it("never throws when the spawn itself fails", async () => {
		const socketPath = join(scratch, "d.sock");
		const spawnDaemon = vi.fn(() => {
			throw new Error("ENOENT");
		});

		await expect(ensureGlobalDaemon({ socketPath, spawnDaemon, nodeVersion: "22.13.0" })).resolves.toBe(
			"failed",
		);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/EnsureGlobalDaemon.test.ts`
Expected: FAIL — cannot resolve `./EnsureGlobalDaemon.js`.

- [ ] **Step 3: Expose the parsed command name**

In `cli/src/core/TelemetryCommandHook.ts`, immediately after `shouldSkipExitFlush`, add:

```ts
/**
 * The root-level name of the command commander resolved this run, or `null`
 * when no action ran.
 *
 * Exposed because more than one policy keys off it. The value is set by the
 * `preAction` hook, so it reflects the parsed command TREE rather than an argv
 * position — the positional check broke silently the moment a global option
 * preceded the subcommand, and any new consumer would inherit that bug.
 *
 * This module owns the FACT; the policy that reads it (e.g.
 * `shouldSkipGlobalDaemon`) lives with the feature it governs.
 */
export function getInvokedRootCommand(): string | null {
	return invokedRootCommand;
}
```

- [ ] **Step 4: Implement the trigger helper**

Create `cli/src/daemon/EnsureGlobalDaemon.ts`:

```ts
/**
 * EnsureGlobalDaemon — the one helper every entry point calls to guarantee a
 * machine-global daemon exists.
 *
 * It never throws, never blocks its caller, and logs on every failure path:
 * three of its four call sites are on the git or agent critical path, where a
 * thrown error would be a blocked commit.
 *
 * ## The two questions, and why they get different budgets
 *
 * `connect()` asks *does one exist* and is answered by the KERNEL — a stale
 * socket file with no listener gives ECONNREFUSED, a live daemon accepts even
 * while its event loop is busy. It is therefore bounded.
 *
 * Reading `hello` asks *which build is it* and is answered by the daemon's
 * event loop, which is NOT bounded: the daemon runs `VACUUM INTO` through
 * `node:sqlite`'s synchronous API, so it answers nothing for the duration
 * (measured: 547 ms on a 143 MB database plus 196 ms for the verifying
 * `integrity_check`, both scaling with size).
 *
 * So a successful connect is enough on its own, and the hello read gets a short
 * budget whose failure means DO NOTHING — not retry, and emphatically not
 * "assume dead".
 *
 * ## Why retiring does not spawn the replacement
 *
 * The retired daemon still holds the socket when `retire` is delivered, and may
 * hold it for the rest of an in-flight snapshot. Because this helper
 * deliberately does not wait for its spawn, a replacement started immediately
 * would die `address-in-use` with nobody watching — an upgrade would silently
 * remove the daemon. Leaving the respawn to the NEXT trigger is bounded and
 * self-healing: triggers are frequent while a user works, and a retire only
 * follows an upgrade, which is itself a trigger-dense moment.
 */

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import {
	cliCoreVersion,
	encodeHandshakeLine,
	isCoreVersionNewer,
	readHandshakeLine,
} from "../core/DaemonHandshake.js";
import { canUseDashboardDb } from "../dashboard/DashboardDb.js";
import { createLogger, errMsg } from "../Logger.js";
import { spawnHidden } from "../util/Subprocess.js";
import { GLOBAL_DAEMON_COMMAND } from "./GlobalDaemon.js";
import { GLOBAL_HELLO_TIMEOUT_MS, globalSocketPath, parseGlobalDaemonHello } from "./GlobalDaemonProtocol.js";

const log = createLogger("EnsureGlobalDaemon");

/** How long to wait for the TCP/unix connect itself. */
const CONNECT_TIMEOUT_MS = 200;

/**
 * Commands that must never bring a daemon up.
 *
 * The first three are mechanical: `global-daemon` would trigger itself, and
 * `mcp` / `mcp-serve` / `daemon` own their stdout as a protocol stream and are
 * cold-start sensitive. (Bare `mcp` takes `Cli.ts`'s proxy fast path and never
 * reaches the trigger at all, but `mcp --reindex` and `mcp-serve` do.)
 *
 * The fourth is semantic and is the one that gets missed: without it, `jolli
 * uninstall` spawns a resident process on its way out and leaves an orphan
 * behind.
 */
const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
	GLOBAL_DAEMON_COMMAND,
	"mcp",
	"mcp-serve",
	"daemon",
	"uninstall",
	"disable",
]);

/** Whether the resolved command opts out of bringing the daemon up. */
export function shouldSkipGlobalDaemon(command: string | null): boolean {
	return command !== null && EXCLUDED_COMMANDS.has(command);
}

export type EnsureOutcome =
	| "already-running"
	| "spawned"
	| "retired-incumbent"
	| "skipped-unsupported-node"
	| "skipped-excluded-command"
	| "failed";

export interface EnsureDeps {
	readonly socketPath?: string;
	/** The commander-parsed root command, when there is one. */
	readonly command?: string | null;
	/** Test seam for the Node floor check. */
	readonly nodeVersion?: string;
	/** Test seam for the version comparison. */
	readonly ownVersion?: string;
	readonly helloTimeoutMs?: number;
	/** Spawns the detached daemon. Injected by tests; defaults to a real spawn. */
	readonly spawnDaemon?: (socketPath: string) => void;
}

/** Connects, resolving `undefined` rather than throwing on any failure. */
function tryConnect(socketPath: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		const done = (value: Socket | undefined): void => {
			clearTimeout(timer);
			socket.removeAllListeners("connect");
			socket.removeAllListeners("error");
			if (value === undefined) socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => done(undefined), CONNECT_TIMEOUT_MS);
		timer.unref?.();
		socket.once("connect", () => done(socket));
		socket.once("error", () => done(undefined));
	});
}

/**
 * Ensures a global daemon exists. Resolves with what it did; never rejects.
 */
export async function ensureGlobalDaemon(deps: EnsureDeps = {}): Promise<EnsureOutcome> {
	try {
		if (shouldSkipGlobalDaemon(deps.command ?? null)) return "skipped-excluded-command";

		// The daemon's only job writes the dashboard database, and node:sqlite
		// throws on import below 22.13. A resident process that cannot do the one
		// thing it exists for is worse than no process.
		if (!canUseDashboardDb(deps.nodeVersion ?? process.versions.node)) {
			return "skipped-unsupported-node";
		}

		const socketPath = deps.socketPath ?? globalSocketPath();
		const socket = await tryConnect(socketPath);

		if (!socket) {
			(deps.spawnDaemon ?? spawnDetachedGlobalDaemon)(socketPath);
			return "spawned";
		}

		try {
			const read = await readHandshakeLine(socket, deps.helloTimeoutMs ?? GLOBAL_HELLO_TIMEOUT_MS);
			const hello = read ? parseGlobalDaemonHello(read.line) : undefined;
			// No hello, an unparseable one, or a foreign protocol: connect() already
			// proved a listener exists, and only the version refinement was lost.
			if (!hello) return "already-running";

			const mine = deps.ownVersion ?? cliCoreVersion();
			if (!isCoreVersionNewer(mine, hello.version)) return "already-running";

			socket.write(encodeHandshakeLine({ t: "retire" }));
			log.info("retiring global daemon pid %d (v%s < v%s)", hello.pid, hello.version, mine);
			// Deliberately no spawn — see the module header.
			return "retired-incumbent";
		} finally {
			socket.end();
		}
	} catch (error: unknown) {
		log.warn("could not ensure the global daemon: %s", errMsg(error));
		return "failed";
	}
}

/**
 * Asks a running daemon to stand down. Resolves true when the request was sent.
 *
 * Used by `uninstall`, which is on the exclusion list — so nothing respawns.
 */
export async function retireGlobalDaemon(deps: { readonly socketPath?: string } = {}): Promise<boolean> {
	try {
		const socket = await tryConnect(deps.socketPath ?? globalSocketPath());
		if (!socket) return false;
		// Read and discard the hello so the daemon's write completes before we
		// answer; the version is irrelevant when the answer is always "retire".
		await readHandshakeLine(socket, GLOBAL_HELLO_TIMEOUT_MS);
		socket.write(encodeHandshakeLine({ t: "retire" }));
		socket.end();
		return true;
	} catch (error: unknown) {
		log.warn("could not retire the global daemon: %s", errMsg(error));
		return false;
	}
}

/**
 * Spawns the daemon, detached, from the SAME bundle this process is running.
 *
 * `process.argv[1]` rather than `import.meta.url`: under the CLI's multi-entry
 * Vite build this module is a shared chunk, so `import.meta.url` would name the
 * chunk instead of an executable entry. argv[1] is the script Node was actually
 * launched with, which is what makes the version in the handshake mean what it
 * says — trigger and daemon are guaranteed to be the same build.
 */
/* v8 ignore start -- spawns a real detached process; covered by the acceptance run, not unit tests */
function spawnDetachedGlobalDaemon(socketPath: string): void {
	const entry = process.argv[1];
	if (!entry) {
		log.warn("Cannot locate the CLI entry to spawn the global daemon");
		return;
	}
	// NO Node flags before the script: a flag an older Node does not recognise
	// kills the child before it runs a line of code, and with `stdio: "ignore"`
	// that death is invisible.
	//
	// `cwd: homedir()` so every cwd-derived path inside the daemon agrees with
	// the `setLogDir(homedir())` it does at startup.
	const child = spawnHidden(process.execPath, [entry, GLOBAL_DAEMON_COMMAND, "--socket", socketPath], {
		detached: true,
		stdio: "ignore",
		cwd: homedir(),
	});
	// A detached spawn emits `error` asynchronously; with no listener Node
	// re-throws it as an uncaught exception and would kill the git hook.
	child.on("error", (err) => log.warn("global daemon failed to spawn: %s", errMsg(err)));
	child.unref();
	log.info("spawned global daemon (pid %d)", child.pid ?? -1);
}
/* v8 ignore stop */
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/EnsureGlobalDaemon.test.ts`
Expected: PASS, 21 tests (12 exclusion-list cases from the two `it.each` blocks plus the `null` case, and 9 `ensureGlobalDaemon` cases).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `npm run typecheck:cli` then `npm run lint`

```bash
git add cli/src/daemon/EnsureGlobalDaemon.ts cli/src/daemon/EnsureGlobalDaemon.test.ts \
        cli/src/core/TelemetryCommandHook.ts
git commit -s -m "feat: the trigger that guarantees a global daemon exists

connect() and the hello read answer different questions with different
bounds, so they get different treatment. The kernel answers 'does one
exist', so it is bounded; the daemon answers 'which build', and it is not,
because VACUUM INTO stops its event loop. A missing hello therefore means
do nothing — connect() already proved a listener is there.

A retiring trigger does not spawn the replacement: the retired daemon
still holds the socket, and since triggers never wait for their spawn, an
address-in-use death would be silent. The next trigger respawns.

uninstall and disable are on the exclusion list so tearing down does not
start things; uninstall additionally sends retire (next commit)."
```

---

### Task 6: Wire the four call sites and uninstall

**Files:**
- Modify: `cli/src/Cli.ts`
- Modify: `cli/src/hooks/PostCommitHook.ts`
- Modify: `cli/src/hooks/SessionStartHook.ts`
- Modify: `cli/src/hooks/PluginBootstrapHook.ts`
- Modify: `cli/src/hooks/CodexPluginBootstrapHook.ts`
- Modify: `cli/src/commands/UninstallCommand.ts`
- Create: `cli/src/daemon/EnsureGlobalDaemon.wiring.test.ts`

**Interfaces:**
- Consumes: `ensureGlobalDaemon`, `retireGlobalDaemon` (Task 5); `getInvokedRootCommand` (Task 5).
- Produces: no new exported API.

- [ ] **Step 1: Write the failing wiring test**

Create `cli/src/daemon/EnsureGlobalDaemon.wiring.test.ts`. This is a source-shape test: it asserts each entry point actually calls the helper. Unit tests cannot see a missing call site, and a missing one is exactly how "IntelliJ could never do the thing" shipped for a year elsewhere in this repo.

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

async function source(relative: string): Promise<string> {
	return await readFile(join(SRC, relative), "utf8");
}

describe("global daemon trigger wiring", () => {
	it.each([
		["Cli.ts", "Cli.ts"],
		["post-commit hook", "hooks/PostCommitHook.ts"],
		["session start hook", "hooks/SessionStartHook.ts"],
		["Claude plugin bootstrap", "hooks/PluginBootstrapHook.ts"],
		["Codex plugin bootstrap", "hooks/CodexPluginBootstrapHook.ts"],
	])("%s calls ensureGlobalDaemon", async (_label, file) => {
		expect(await source(file)).toContain("ensureGlobalDaemon");
	});

	it("uninstall retires the daemon rather than leaving an orphan", async () => {
		expect(await source("commands/UninstallCommand.ts")).toContain("retireGlobalDaemon");
	});

	it("no trigger writes to stdout — the Codex bootstrap validates its stdout as one JSON object", async () => {
		const helper = await source("daemon/EnsureGlobalDaemon.ts");
		expect(helper).not.toContain("console.log");
		expect(helper).not.toContain("process.stdout.write");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/EnsureGlobalDaemon.wiring.test.ts`
Expected: FAIL — the five `toContain("ensureGlobalDaemon")` assertions and the `retireGlobalDaemon` one all fail.

- [ ] **Step 3: Wire `Cli.ts`**

In `cli/src/Cli.ts`, inside the non-fast-path branch, immediately after the `shouldSkipExitFlush()` block and before `if (failed) process.exit(1);`:

```ts
				// Ensure the machine-global daemon exists. Last, so it can never
				// delay the command's own output, and fire-and-forget: it resolves
				// an outcome rather than throwing, and nothing here depends on it.
				const { ensureGlobalDaemon } = await import("./daemon/EnsureGlobalDaemon.js");
				const { getInvokedRootCommand } = await import("./core/TelemetryCommandHook.js");
				await ensureGlobalDaemon({ command: getInvokedRootCommand() });
```

Use `await import` rather than a static import, matching the surrounding code: `Cli.ts` is the proxy's cold-start path and every static import there is paid by every session.

- [ ] **Step 4: Wire the post-commit hook**

In `cli/src/hooks/PostCommitHook.ts`, in `postCommitEntry`, immediately after the existing detached QueueWorker spawn:

```ts
	// The commit path is already a fire-and-forget region, and this helper is
	// bounded (200ms connect + 300ms hello at worst) and never throws.
	const { ensureGlobalDaemon } = await import("../daemon/EnsureGlobalDaemon.js");
	await ensureGlobalDaemon();
```

No `command` is passed: a hook is not a commander invocation, so the exclusion list does not apply to it.

- [ ] **Step 5: Wire the session-start hook**

In `cli/src/hooks/SessionStartHook.ts`, in `main()`, after the session metadata has been written and before the context is printed:

```ts
	const { ensureGlobalDaemon } = await import("../daemon/EnsureGlobalDaemon.js");
	await ensureGlobalDaemon();
```

- [ ] **Step 6: Wire both plugin bootstraps**

In `cli/src/hooks/PluginBootstrapHook.ts` and `cli/src/hooks/CodexPluginBootstrapHook.ts`, after the install work completes and **before** anything is written to stdout:

```ts
	// Before the JSON envelope is emitted: this helper writes only to the log,
	// but ordering it ahead of stdout keeps that guarantee structural rather
	// than a property someone has to remember. Codex validates this hook's
	// stdout as exactly one JSON object.
	const { ensureGlobalDaemon } = await import("../daemon/EnsureGlobalDaemon.js");
	await ensureGlobalDaemon();
```

- [ ] **Step 7: Wire uninstall**

In `cli/src/commands/UninstallCommand.ts`, in the uninstall action after the repo hooks are removed:

```ts
	// Ask the resident daemon to stand down. `uninstall` is on the trigger's
	// exclusion list, so nothing brings it back.
	const { retireGlobalDaemon } = await import("../daemon/EnsureGlobalDaemon.js");
	await retireGlobalDaemon();
```

- [ ] **Step 8: Run the wiring test plus every touched file's suite**

Run: `npm run test -w @jolli.ai/cli -- src/daemon/ src/Cli.test.ts src/hooks/PostCommitHook.test.ts src/hooks/SessionStartHook.test.ts src/hooks/PluginBootstrapHook.test.ts src/hooks/CodexPluginBootstrapHook.test.ts src/commands/UninstallCommand.test.ts`
Expected: PASS. If a bootstrap test asserts exact stdout, confirm it still sees exactly one JSON object.

- [ ] **Step 9: Typecheck, lint, commit**

Run: `npm run typecheck:cli` then `npm run lint`

```bash
git add cli/src/Cli.ts cli/src/hooks/PostCommitHook.ts cli/src/hooks/SessionStartHook.ts \
        cli/src/hooks/PluginBootstrapHook.ts cli/src/hooks/CodexPluginBootstrapHook.ts \
        cli/src/commands/UninstallCommand.ts cli/src/daemon/EnsureGlobalDaemon.wiring.test.ts
git commit -s -m "feat: bring the global daemon up from every entry point

CLI tail, post-commit, session start and both plugin bootstraps each call
ensureGlobalDaemon; uninstall calls retireGlobalDaemon instead, and is on
the exclusion list so nothing brings it back.

A source-shape test pins all six call sites. A unit test cannot see a
MISSING call site, and that failure mode is silent — the daemon simply
never comes up from whichever surface was forgotten."
```

---

### Task 7: Observability and the recorded rules

**Files:**
- Modify: `cli/src/commands/DoctorCommand.ts`
- Modify: `cli/src/commands/DoctorCommand.test.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `globalSocketPath`, `parseGlobalDaemonHello` (Task 2); `readHandshakeLine` (Task 1).
- Produces: `probeGlobalDaemon(socketPath?: string): Promise<GlobalDaemonHello | undefined>` exported from `cli/src/daemon/EnsureGlobalDaemon.ts`.

- [ ] **Step 1: Write the failing test**

Add to `cli/src/commands/DoctorCommand.test.ts`:

```ts
describe("global daemon check", () => {
	it("reports the daemon as running with its pid, version and uptime", async () => {
		const { formatGlobalDaemonCheck } = await import("./DoctorCommand.js");
		const check = formatGlobalDaemonCheck(
			{ t: "hello", protocol: 1, version: "0.99.3", pid: 4242, startedAt: 1_000_000 },
			1_000_000 + 3 * 60 * 60 * 1000,
		);

		expect(check.status).toBe("ok");
		expect(check.message).toContain("4242");
		expect(check.message).toContain("0.99.3");
		expect(check.message).toContain("3h");
	});

	it("reports 'not running' as a warning, never a failure", async () => {
		const { formatGlobalDaemonCheck } = await import("./DoctorCommand.js");
		const check = formatGlobalDaemonCheck(undefined, Date.now());

		// Not a failure: backups still land from the opportunistic callers, and
		// the row that reports whether they ACTUALLY landed is "Database backup".
		expect(check.status).toBe("warn");
		expect(check.message).toContain("not running");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @jolli.ai/cli -- src/commands/DoctorCommand.test.ts -t "global daemon check"`
Expected: FAIL — `formatGlobalDaemonCheck` is not exported.

- [ ] **Step 3: Add the probe**

In `cli/src/daemon/EnsureGlobalDaemon.ts`, add:

```ts
/**
 * Reads a running daemon's hello without changing anything, for `doctor`.
 *
 * Uses the full {@link HANDSHAKE_TIMEOUT_MS}-class budget rather than
 * {@link GLOBAL_HELLO_TIMEOUT_MS}: nothing on a git critical path calls this,
 * and a diagnostic that reports "not running" because the daemon was busy
 * snapshotting would be worse than a slow diagnostic.
 */
export async function probeGlobalDaemon(socketPath?: string): Promise<GlobalDaemonHello | undefined> {
	try {
		const socket = await tryConnect(socketPath ?? globalSocketPath());
		if (!socket) return undefined;
		try {
			const read = await readHandshakeLine(socket, 5_000);
			return read ? parseGlobalDaemonHello(read.line) : undefined;
		} finally {
			socket.end();
		}
	} catch {
		return undefined;
	}
}
```

Add `GlobalDaemonHello` to the type import from `./GlobalDaemonProtocol.js`.

- [ ] **Step 4: Add the doctor row**

First, two prerequisites in `cli/src/commands/DoctorCommand.ts`:

1. **Export the `DoctorCheck` interface** (it is currently declared without `export` around line 40). A function exported with a non-exported local interface as its return type fails type declaration emit with "has or is using private name". Change `interface DoctorCheck {` to `export interface DoctorCheck {`.
2. **Add the imports:**

```ts
import { probeGlobalDaemon } from "../daemon/EnsureGlobalDaemon.js";
import type { GlobalDaemonHello } from "../daemon/GlobalDaemonProtocol.js";
```

Then add the exported formatter next to the other check helpers:

```ts
/**
 * The daemon's row. Exported for tests, and pure so the formatting can be
 * asserted without a live socket.
 *
 * "Not running" is a WARNING, never a failure, and the ordering with the
 * "Database backup" row is the reason: that row reports whether snapshots are
 * actually landing, which is the question that matters. A daemon that is up but
 * has never produced a snapshot is a worse state than no daemon with the
 * opportunistic callers keeping up — so the process must never be presented as
 * evidence that the work is getting done.
 */
export function formatGlobalDaemonCheck(hello: GlobalDaemonHello | undefined, nowMs: number): DoctorCheck {
	if (!hello) {
		return {
			name: "Global daemon",
			status: "warn",
			message: "not running — scheduled work falls back to commit-time triggers",
		};
	}
	const upHours = Math.floor((nowMs - hello.startedAt) / (60 * 60 * 1000));
	return {
		name: "Global daemon",
		status: "ok",
		message: `running (pid ${hello.pid}, v${hello.version}, up ${upHours}h)`,
	};
}
```

Then, immediately **before** the existing "Database backup" check (so the backup row reads last and is what the eye lands on):

```ts
	// 9. Global daemon — context for the backup row below, never a substitute
	// for it.
	checks.push(formatGlobalDaemonCheck(await probeGlobalDaemon(), Date.now()));
```

Renumber the subsequent comment markers accordingly.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @jolli.ai/cli -- src/commands/DoctorCommand.test.ts`
Expected: PASS, including the two new cases.

- [ ] **Step 6: Record the rules in `AGENTS.md`**

Add to the "Critical rules" list, after the Node ≥ 22.13 lockstep bullet:

```markdown
- **The global daemon's trigger must never wait on the daemon's event loop, and a retiring trigger must never spawn its replacement.** [`EnsureGlobalDaemon.ts`](cli/src/daemon/EnsureGlobalDaemon.ts) is called from the CLI tail, `post-commit`, `SessionStart` and both plugin bootstraps, so three of its four call sites are on a critical path. `connect()` answers "does one exist" and is answered by the kernel, so it is bounded; reading `hello` answers "which build" and is answered by the daemon, which runs `VACUUM INTO` through `node:sqlite`'s **synchronous** API and therefore answers nothing for the duration (measured: 547 ms on a 143 MB database, plus 196 ms for the verifying `integrity_check`, both scaling with size). Hence the 300 ms hello budget whose timeout means **do nothing** — a successful connect already proved a listener exists. And hence the retire path stopping at `retire`: the retired daemon still holds the socket, the trigger never waits for a spawn, so a replacement started immediately dies `EADDRINUSE` **silently** and the upgrade removes the daemon with nothing reporting it. The next trigger respawns. `uninstall`/`disable` are on the exclusion list so a teardown cannot start one, and `uninstall` additionally sends `retire`; the exclusion list keys off the commander-parsed command (`getInvokedRootCommand`), never an argv position, because a global option before the subcommand silently breaks the positional form. The six call sites are pinned by a source-shape test — a unit test cannot see a call site that was never added, and a forgotten one just means the daemon never comes up from that surface.
- **`TaskScheduler` holds no persistent state, and adding some is a review blocker.** `tickIntervalMs` is how often to ASK a task whether it is due, not how often it acts: `maybeSnapshot` already gates itself on `last-snapshot-at` in `schema_meta`, so a scheduler-owned `lastRun` would be a second owner of one fact with no tie-breaker. Downtime catch-up and post-retire handover both work *because* of this — every task is ticked once at startup and answers for itself. Note the timers are `unref`'d (the listening socket keeps the process alive), which is the OPPOSITE of `McpProxy`'s retry timer, where the timer is the only handle.
```

- [ ] **Step 7: Commit**

```bash
git add cli/src/commands/DoctorCommand.ts cli/src/commands/DoctorCommand.test.ts \
        cli/src/daemon/EnsureGlobalDaemon.ts AGENTS.md
git commit -s -m "feat: report the global daemon in doctor, and record its rules

The daemon's row sits above 'Database backup' and is a warning at worst,
because that row is the one that answers the question that matters —
whether snapshots are actually landing. A daemon that is up but has never
produced one is worse than no daemon with the opportunistic callers
keeping up, so the process must never read as evidence the work is done.

The probe uses a 5s budget rather than the trigger's 300ms: nothing on a
git path calls it, and reporting 'not running' because the daemon happened
to be snapshotting would be the wrong answer, slowly avoided."
```

---

### Task 8: Full gate

**Files:** none — verification only.

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → typecheck → lint → test all pass.

A `Test timed out in NNNNms` failure is a load signal, not a regression: about a dozen CLI test files spawn real `git` subprocesses and get CPU-starved under `--coverage`. Triage by shape — re-run that one file alone with the stock timeout, and green in isolation is the proof it was contention. An assertion or thrown error is a real regression.

- [ ] **Step 2: Confirm coverage did not regress**

The gate enforces 97/96/97/97 for `cli/`. If the new modules fall short, the likely gap is an error branch in `GlobalDaemon.ts` (`listen-failed`) or `EnsureGlobalDaemon.ts`. Add the missing case to the relevant test file rather than widening a `v8 ignore` block — the only block that legitimately carries one is `spawnDetachedGlobalDaemon`, which spawns a real process.

- [ ] **Step 3: Verify the daemon end to end by hand**

```bash
cd cli && npm run build && npm install -g .
cd /tmp && mkdir -p daemon-smoke && cd daemon-smoke && git init -q
jolli status >/dev/null
ps aux | grep -c "[g]lobal-daemon"
```

Expected: `1` — one daemon, spawned by an ordinary CLI command.

```bash
ls "${TMPDIR:-/tmp}/.jolli-global-$(id -u)/"
```

Expected: `daemon.sock`.

```bash
jolli doctor 2>&1 | grep -A 1 "Global daemon"
```

Expected: a `running (pid …, v…, up 0h)` line.

Then confirm exclusion and retirement:

```bash
jolli uninstall --yes >/dev/null 2>&1
sleep 1
ps aux | grep -c "[g]lobal-daemon"
```

Expected: `0` — uninstall retired it, and nothing respawned.

- [ ] **Step 4: Commit any fixes from the gate**

```bash
git add -A
git commit -s -m "fix: <what the gate found>"
```

Skip if the gate was clean on the first run.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 relationship to the two existing daemons | Task 2 (module header), Task 4 (module header) |
| §1.2 not merging `DashboardServer` | Spec-only; recorded as out-of-scope in §7 |
| §2.1 command name | Task 4, Step 5 |
| §2.2 address | Task 2 |
| §2.3 handshake | Tasks 1 + 2 |
| §2.4 lifetime, no idle timeout | Task 4 (no idle timer exists) |
| §2.5 shared handshake module | Task 1 |
| §3.1 stateless scheduler | Task 3 |
| §3.2 failure policy | Task 3, `onTaskError` + continue |
| §3.3 `unref`'d timers | Task 3 |
| §4.1 flow, 300 ms budget, retire-no-spawn | Tasks 2 + 5 |
| §4.2 spawn shape | Task 5, `spawnDetachedGlobalDaemon` |
| §4.3 exclusion list | Task 5, `shouldSkipGlobalDaemon` |
| §4.4 Node floor gate | Task 5 |
| §4.5 call sites | Task 6 |
| §5.1 logging destination | Task 4, `setLogDir(homedir())` |
| §5.2 report the outcome | Task 7 |
| §5.3 retire semantics | Task 4 |
| §5.4 stale sockets | Task 5, `tryConnect` → spawn path |
| §6 testing | Every task; Task 8 for the gate |

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar to Task N".

**Type consistency:** `DaemonTask.run(): Promise<string>` is used identically in Tasks 3 and 4. `GlobalDaemonHello` fields (`t`, `protocol`, `version`, `pid`, `startedAt`) match across Tasks 2, 4, 5 and 7. `EnsureDeps.ownVersion` is declared in Task 5's Produces block and used by the retire test in the same task. `formatGlobalDaemonCheck` returns `DoctorCheck`, the existing interface in `DoctorCommand.ts`.

**Known adjustment points for the implementer:** the exact insertion lines in `PostCommitHook.ts`, `SessionStartHook.ts`, both bootstraps and `UninstallCommand.ts` are described by their surrounding code rather than by line number, because those files are actively edited on neighbouring branches. The wiring test in Task 6 is what proves the insertion actually happened.
