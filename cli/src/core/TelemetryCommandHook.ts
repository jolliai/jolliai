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

/** Register the `command_invoked` auto-emit hooks on the root program. */
export function installCommandTelemetryHooks(program: Command): void {
	const starts = new WeakMap<Command, number>();
	program.hook("preAction", (_thisCommand, actionCommand) => {
		starts.set(actionCommand, Date.now());
	});
	program.hook("postAction", (_thisCommand, actionCommand) => {
		const start = starts.get(actionCommand);
		track("command_invoked", {
			command: commandPath(actionCommand),
			duration_ms: start === undefined ? undefined : Date.now() - start,
			ok: true,
		});
	});
}
