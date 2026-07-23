/**
 * TelemetryCommandHook — wires commander's action lifecycle to the
 * `command_invoked` telemetry event (JOLLI-1785 Phase 2). Registered once on
 * the root program; every command (including future ones and plugins) is
 * auto-tracked with no per-command code.
 *
 * `preAction` stamps a start time; `postAction` emits
 * `command_invoked { command, duration_ms, ok: true }` on the success path.
 * Failures don't fire `postAction` (commander skips it when the action
 * throws); those are captured by the dedicated `error_occurred` event at the
 * structured-error choke points rather than mislabeled as a completed command.
 *
 * NB: the property is `command`, NOT `name`. The backend telemetry scrubber
 * treats a property literally called `name` as PII and drops it (verified
 * against the live backend) — so the JOLLI-1786 §7.B catalog's `name` example
 * would silently lose the command. `command` survives the scrubber.
 *
 * `track()` is a no-op until `initTelemetry` runs, so registering these hooks
 * is harmless in contexts where telemetry was never bootstrapped (unit tests,
 * programmatic `main()` callers).
 */
import type { Command } from "commander";
import { track } from "./Telemetry.js";

/**
 * Space-joined command path excluding the root program, e.g. `recall` or
 * `auth login`. Used as the `command` property — a fixed identifier from our
 * own CLI surface, never user input.
 */
export function commandPath(cmd: Command): string {
	const parts: string[] = [];
	let current: Command | null = cmd;
	while (current?.parent) {
		parts.unshift(current.name());
		current = current.parent;
	}
	return parts.join(" ");
}

/**
 * The command that started but hasn't completed. `preAction` sets it; the
 * `postAction` success path clears it. Commander skips `postAction` when the
 * action throws, so a still-set `pending` after `parseAsync` rejects means the
 * command FAILED — `trackCommandFailureIfPending()` records that. A CLI runs one
 * command per process, so a single slot suffices.
 */
let pending: { readonly command: string; readonly start: number } | null = null;

/**
 * Root-level name of the command commander actually resolved this run (e.g.
 * `telemetry` for `telemetry inspect`, `recall` for `recall`). Set by
 * `preAction`, so it reflects the parsed command tree rather than an argv
 * position — robust even if global options are ever added before the
 * subcommand. `null` when no action ran. See `shouldSkipExitFlush`.
 */
let invokedRootCommand: string | null = null;

/**
 * Set by commands that run as a synchronous bootstrap (e.g. `enable
 * PluginBootstrapHook on every Claude Code SessionStart) where the ≤2s
 * exit-flush adds latency to the critical path with no user-visible benefit.
 */
let forcedSkipExitFlush = false;

/** Opt the current process out of the exit-flush (e.g. SessionStart bootstrap). */
export function markSkipExitFlush(): void {
	forcedSkipExitFlush = true;
}

/**
 * True when the resolved command belongs to the `telemetry` group, so the CLI's
 * exit-flush should be skipped: `telemetry off` clears the buffer and
 * `telemetry inspect` must not transmit. Derived from the commander-parsed
 * command (via `preAction`), not `process.argv[2]` — the positional check broke
 * silently the moment a global option preceded the subcommand. Also true when
 * a command explicitly opted out via {@link markSkipExitFlush}.
 */
export function shouldSkipExitFlush(): boolean {
	return forcedSkipExitFlush || invokedRootCommand === "telemetry";
}

/** Register the `command_invoked` auto-emit hooks on the root program. */
export function installCommandTelemetryHooks(program: Command): void {
	program.hook("preAction", (_thisCommand, actionCommand) => {
		const command = commandPath(actionCommand);
		pending = { command, start: Date.now() };
		invokedRootCommand = command.split(" ")[0] ?? null;
	});
	program.hook("postAction", (_thisCommand, actionCommand) => {
		const start = pending?.start;
		pending = null; // success — recorded below (or intentionally skipped for mcp)
		// `mcp` is emitted per tool call by the MCP server's CallTool handler
		// (JOLLI-1959, tagged with `tool`). The generic session-level event here
		// would be a coarse duplicate (`command:"mcp"` with no tool, once at stdio
		// disconnect), so skip it — the CallTool handler is the source of truth.
		if (commandPath(actionCommand) === "mcp") return;
		track("command_invoked", {
			command: commandPath(actionCommand),
			duration_ms: start === undefined ? undefined : Date.now() - start,
			ok: true,
		});
	});
}

/**
 * Emit a failed `command_invoked{ ok: false }` when an action started but never
 * completed. Commander skips `postAction` on a thrown action, so this is the
 * only place a command *failure* is recorded (JOLLI-1960) — otherwise every
 * `command_invoked` would report `ok: true` and the failure would be invisible.
 * Call from the CLI's top-level catch. No-op when the last command succeeded,
 * none ran, or it was `mcp` (tracked per tool call by the MCP server). Never
 * throws — telemetry must not mask the original command error.
 */
export function trackCommandFailureIfPending(): void {
	const p = pending;
	pending = null;
	if (!p || p.command === "mcp") return;
	track("command_invoked", { command: p.command, duration_ms: Date.now() - p.start, ok: false });
}
