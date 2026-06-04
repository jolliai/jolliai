/**
 * Subprocess — thin wrapper around node:child_process that injects
 * `windowsHide: true` by default. Without it, GUI parent processes
 * (VS Code, IntelliJ, Sourcetree) on Windows allocate a visible conhost
 * window for each console child (git.exe, gh.exe, …) — a black flash
 * users see on every commit / rebase.
 *
 * Use this module everywhere instead of `node:child_process`. A biome
 * `noRestrictedImports` rule enforces it for non-test source files.
 *
 * Callers may explicitly override by passing `windowsHide: false`.
 */

import {
	type ExecFileOptions,
	type ExecFileSyncOptions,
	type ExecFileSyncOptionsWithBufferEncoding,
	type ExecFileSyncOptionsWithStringEncoding,
	execFile,
	execFileSync,
	type SpawnOptions,
	type SpawnSyncOptions,
	type SpawnSyncOptionsWithBufferEncoding,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawn,
	spawnSync,
} from "node:child_process";
import { promisify } from "node:util";

const HIDDEN = { windowsHide: true } as const;

/**
 * Promisified `execFile` with `windowsHide: true` injected by default.
 *
 * We promisify inside the call (not at module load) so that tests using
 * `vi.mock("node:child_process", …)` see their mock — eager promisification
 * would close over the original `execFile` before the mock takes effect.
 * Same reason `cli/src/core/Locks.ts` does lazy promisification.
 */
export function execFileAsyncHidden(
	file: string,
	args?: ReadonlyArray<string>,
	options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
	return promisify(execFile)(file, args as ReadonlyArray<string>, { ...HIDDEN, ...(options ?? {}) }) as Promise<{
		stdout: string;
		stderr: string;
	}>;
}

/**
 * Run an `npm` subcommand cross-platform, returning trimmed stdout or null on
 * any failure (npm missing, non-zero exit, timeout, empty output).
 *
 * On Windows the npm launcher is `npm.cmd`, and a bare `npm` cannot be spawned
 * without a shell: `execFile`/`spawn` don't resolve via `PATHEXT` (→ `ENOENT`),
 * and since the Node fix for CVE-2024-27980 (18.20.2 / 20.12.2 / 21.7.2 — all
 * below our `>=22.5` floor) even an explicit `npm.cmd` is rejected without
 * `shell: true` (→ `EINVAL`). So we opt into a shell on win32 only, where
 * `cmd.exe` resolves `npm.cmd` through `PATHEXT`. Every caller passes static
 * tokens plus allow-listed package names — never user-controlled input — and the
 * `UNSAFE_ARG` guard below enforces that contract in code rather than leaving it
 * to comment discipline, so the shell carries no injection surface.
 *
 * Single source of truth for "how to invoke npm" so a future third call site
 * can't reintroduce the bare-`execFile("npm")` bug that silently no-ops on
 * Windows.
 *
 * Coverage-ignored: the only effect is spawning npm, which can't be unit-tested
 * deterministically without a fake npm on PATH — same rationale the two former
 * inline runners carried.
 */
/** A shell-unsafe argument is anything outside the chars npm tokens / package names actually use. */
const UNSAFE_ARG = /[^\w.@/-]/;

/* v8 ignore start */
export async function runNpmCommand(args: ReadonlyArray<string>, opts?: { timeout?: number }): Promise<string | null> {
	// Programmer-error guard, deliberately OUTSIDE the try below: a caller that
	// passes an arg with shell metacharacters is a bug to surface loudly, not to
	// swallow into a silent null (which is the very failure mode this helper exists
	// to prevent). Validated on every platform so the mistake is caught in dev, not
	// only once it reaches the win32 `shell: true` path.
	const unsafe = args.find((arg) => UNSAFE_ARG.test(arg));
	if (unsafe !== undefined) {
		throw new Error(`runNpmCommand: refusing to invoke npm with shell-unsafe argument: ${JSON.stringify(unsafe)}`);
	}
	try {
		const { stdout } = await execFileAsyncHidden("npm", args, {
			timeout: opts?.timeout,
			shell: process.platform === "win32",
		});
		const trimmed = stdout.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}
/* v8 ignore stop */

export function execFileSyncHidden(
	file: string,
	args: ReadonlyArray<string> | undefined,
	options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSyncHidden(
	file: string,
	args: ReadonlyArray<string> | undefined,
	options: ExecFileSyncOptionsWithBufferEncoding,
): Buffer;
export function execFileSyncHidden(
	file: string,
	args?: ReadonlyArray<string>,
	options?: ExecFileSyncOptions,
): Buffer | string;
export function execFileSyncHidden(
	file: string,
	args?: ReadonlyArray<string>,
	options?: ExecFileSyncOptions,
): Buffer | string {
	return execFileSync(file, args as ReadonlyArray<string>, { ...HIDDEN, ...(options ?? {}) });
}

/**
 * `spawn` with `windowsHide: true` injected by default.
 *
 * Cast to `typeof spawn` so we inherit Node's full overload set — in particular
 * the `SpawnOptionsWithoutStdio` / `SpawnOptionsWithStdioTuple<...>` overloads
 * that narrow the return type to `ChildProcessWithoutNullStreams` /
 * `ChildProcessByStdio<Writable, Readable, Readable>`. Without this, callers
 * with `stdio: "pipe"` or `stdio: ["pipe","pipe","pipe"]` would lose the
 * non-null stream guarantee and need `proc.stdout!` everywhere.
 *
 * Runtime: handles both 2-arg (`spawn(cmd, opts)`) and 3-arg
 * (`spawn(cmd, args, opts)`) call shapes that Node's spawn supports.
 */
export const spawnHidden = ((
	command: string,
	argsOrOptions?: ReadonlyArray<string> | SpawnOptions,
	maybeOptions?: SpawnOptions,
) => {
	if (Array.isArray(argsOrOptions)) {
		return spawn(command, argsOrOptions as ReadonlyArray<string>, { ...HIDDEN, ...(maybeOptions ?? {}) });
	}
	const opts = (argsOrOptions ?? {}) as SpawnOptions;
	return spawn(command, { ...HIDDEN, ...opts });
}) as typeof spawn;

export function spawnSyncHidden(
	command: string,
	args: ReadonlyArray<string> | undefined,
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnSyncHidden(
	command: string,
	args: ReadonlyArray<string> | undefined,
	options: SpawnSyncOptionsWithBufferEncoding,
): SpawnSyncReturns<Buffer>;
export function spawnSyncHidden(
	command: string,
	args?: ReadonlyArray<string>,
	options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string>;
export function spawnSyncHidden(
	command: string,
	args?: ReadonlyArray<string>,
	options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string> {
	return spawnSync(command, args as ReadonlyArray<string>, { ...HIDDEN, ...(options ?? {}) });
}
