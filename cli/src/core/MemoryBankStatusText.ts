/**
 * User-facing wording for {@link MemoryBankState} — the ONE place the Memory
 * Bank's effective state is turned into text.
 *
 * Shared rather than mirrored per surface: this text exists specifically because
 * the folder layer degrades silently (`StorageFactory` and `ReadStorageResolver`
 * fall back to orphan-only with nothing but a `debug.log` line), so the CLI's
 * `Memory Bank:` status row and the VS Code Settings → Memory Bank tab must not
 * be able to disagree about whether writes are landing. The neighbouring
 * `describeSchemaV5Status` predates this rule and is duplicated by hand across
 * surfaces — don't copy that pattern here.
 *
 * Every non-`ok` string names the blocker AND the remedy, because the user can
 * see neither input: `storageMode` has no UI, and the write-boundary gate's
 * verdict is computed from a cwd they never typed.
 */

import type { MemoryBankState } from "./KBTypes.js";

/**
 * `severity` drives presentation only (icon + colour token in the webview, no
 * decoration in the CLI row). `"off"` is deliberately distinct from `"warn"`:
 * orphan-only is a valid configuration, not a problem to fix.
 */
export interface MemoryBankDisplay {
	readonly severity: "ok" | "warn" | "off";
	readonly text: string;
}

/**
 * The active arm reports the resolved **per-repo** folder rather than the
 * configured parent: the `-N` suffix ladder means the two routinely differ, and
 * the folder actually being written is the answer to "where did my memories go".
 */
export function describeMemoryBank(state: MemoryBankState): MemoryBankDisplay {
	switch (state.kind) {
		case "orphan-only":
			return { severity: "off", text: "Off — memories are stored on the orphan branch only" };
		case "active":
			return {
				severity: "ok",
				text: state.mode === "folder" ? `${state.folder} (folder-only)` : state.folder,
			};
		default:
			return { severity: "warn", text: describeBlocker(state) };
	}
}

/** The degraded arms, split out to keep {@link describeMemoryBank} flat. */
function describeBlocker(state: Extract<MemoryBankState, { kind: "degraded" }>): string {
	switch (state.blocker) {
		case "not-a-project":
			return "Not writing — this directory is not inside a git worktree";
		case "folder-inside-repo":
			return `Not writing — the Memory Bank folder (${state.parent}) is inside this repository; point it somewhere outside the working tree`;
		default:
			return "Not writing — the Memory Bank folder could not be resolved (check $HOME)";
	}
}
