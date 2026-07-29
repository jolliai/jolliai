/**
 * PushControlCommand — `jolli push-control`, the CLI surface for the per-repo
 * outbound-push control (spec 306). It always targets the CURRENT repo (`--cwd`):
 *
 *   jolli push-control            show this repo's outbound-push state
 *   jolli push-control --disable  disable outbound push (memory stays local)
 *   jolli push-control --enable   re-enable + drain retained memory
 *
 * All the real work lives in the shared `PushControl` core so this stays a thin
 * Commander shell, mirroring the `push` / `spaces` conventions (resolveProjectDir,
 * setLogDir, `--format json`).
 */
import { type Command, Option } from "commander";
import { applyPushDisabled, readPushDisabledState } from "../core/PushControl.js";
import { setLogDir } from "../Logger.js";
import { resolveProjectDir } from "./CliUtils.js";

interface PushControlOptions {
	enable?: boolean;
	disable?: boolean;
	format?: string;
	cwd: string;
}

function emitError(message: string, format: string | undefined): void {
	if (format === "json") {
		console.log(JSON.stringify({ type: "error", message }));
	} else {
		console.error(`\n  Error: ${message}\n`);
	}
	process.exitCode = 1;
}

async function runShow(cwd: string, format: string | undefined): Promise<void> {
	// Read the STATE (not the boolean shorthand): an unreadable store fails closed to
	// "OFF" for every repo on the machine, so without the reason the user sees an
	// inexplicable OFF they cannot act on. `error` carries the store's absolute path.
	const { disabled, error } = await readPushDisabledState(cwd);
	if (format === "json") {
		console.log(JSON.stringify({ type: "state", pushDisabled: disabled, ...(error ? { error } : {}) }));
		return;
	}
	const state = disabled ? "OFF — recorded locally, NOT sent to Jolli" : "ON";
	const lines = ["", `  Push this repo's memory to a Jolli Space: ${state}`];
	if (error) {
		lines.push(`  Reported OFF because the setting could not be read: ${error}`);
		// --enable is the documented recovery, but it rebuilds the store from an EMPTY
		// set — say so, or the user trades one corrupt file for silently-lost opt-outs.
		lines.push("  Repair that file to recover; --enable also rebuilds it, but drops every repo's opt-out.");
	}
	lines.push(
		`  ${disabled ? "Turn back on:" : "Turn off:   "} jolli push-control ${disabled ? "--enable" : "--disable"}`,
		"",
	);
	console.log(lines.join("\n"));
}

async function runToggle(disabled: boolean, options: PushControlOptions): Promise<void> {
	const { recoveredFromCorrupt, preservedAt } = await applyPushDisabled(options.cwd, disabled, "cli");
	if (options.format === "json") {
		console.log(
			JSON.stringify({
				type: "set",
				pushDisabled: disabled,
				cwd: options.cwd,
				...(recoveredFromCorrupt
					? { recoveredFromCorrupt: true, ...(preservedAt ? { preservedAt } : {}) }
					: {}),
			}),
		);
		return;
	}
	const verb = disabled
		? "OFF — this repo's memory stays local, not sent to Jolli"
		: "ON — retained memory will now sync";
	const lines = ["", `  Push this repo's memory to a Jolli Space: ${verb}.`];
	if (recoveredFromCorrupt) {
		// Never let the reset hide behind a plain success line: enabling rebuilt an
		// unreadable store from empty, so EVERY other repo now reads as push-allowed.
		lines.push(
			"",
			"  Note: the setting file was unreadable and has been rebuilt from scratch —",
			"  every other repository's opt-out was reset to ON. Re-apply the ones you want off.",
		);
		if (preservedAt) lines.push(`  The unreadable file was kept at: ${preservedAt}`);
	}
	lines.push("");
	console.log(lines.join("\n"));
}

/** Registers the `push-control` command on the given Commander program. */
export function registerPushControlCommand(program: Command): void {
	program
		.command("push-control")
		.description(
			"Show or set whether THIS repo's memory is pushed to a Jolli Space (per-repo on/off; capture stays local either way)",
		)
		.option("--enable", "Turn pushing ON for this repo; sync any memory retained while off")
		.option("--disable", "Turn pushing OFF for this repo (memory is still recorded locally, just not sent)")
		.addOption(new Option("--format <fmt>", "Output format").choices(["json"]))
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: PushControlOptions) => {
			try {
				setLogDir(options.cwd);
				if (options.enable && options.disable) {
					emitError("--enable and --disable are mutually exclusive.", options.format);
					return;
				}
				if (options.disable) {
					await runToggle(true, options);
					return;
				}
				if (options.enable) {
					await runToggle(false, options);
					return;
				}
				await runShow(options.cwd, options.format);
			} catch (error: unknown) {
				emitError(error instanceof Error ? error.message : String(error), options.format);
			}
		});
}
