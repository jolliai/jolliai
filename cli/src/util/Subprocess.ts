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
