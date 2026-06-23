/**
 * `jolli telemetry` — user-facing control + transparency for anonymous usage
 * telemetry (JOLLI-1785 Phase 2). Subcommands:
 *
 *   - `status`  (default) — on/off + the reason, installId, env, buffered count.
 *   - `on`      — opt back in (clears the off switch, marks the notice seen).
 *   - `off`     — opt out (no events are collected or sent).
 *   - `inspect` — print the exact buffered events that would be sent, as
 *     plaintext, before anything leaves the machine (the privacy promise).
 *
 * Computes consent + origin standalone from config (not the in-process
 * Telemetry context) so the output is truthful even when invoked in a process
 * where telemetry was never bootstrapped, and so it is unit-testable.
 */
import type { Command } from "commander";
import { getJolliUrl } from "../auth/AuthConfig.js";
import { getOrCreateInstallId, loadConfig, saveConfig } from "../core/SessionTracker.js";
import { resolveTelemetryEnv, shutdownTelemetry } from "../core/Telemetry.js";
import { clearTelemetryBuffer, readTelemetryEvents } from "../core/TelemetryBuffer.js";
import { resolveTelemetryConsent } from "../core/TelemetryConsent.js";
import { resolveTelemetryOrigin } from "../core/TelemetryStartup.js";
import { resolveProjectDir } from "./CliUtils.js";

export function registerTelemetryCommand(program: Command): void {
	const telemetry = program
		.command("telemetry")
		.description("Show or change anonymous usage telemetry (opt-out, content-free)");

	telemetry
		.command("status", { isDefault: true })
		.description("Show whether telemetry is on and what identifies this machine")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			const config = await loadConfig();
			const consent = resolveTelemetryConsent({ config });
			const { installId } = await getOrCreateInstallId();
			const env = resolveTelemetryEnv(resolveTelemetryOrigin(config, getJolliUrl));
			const buffered = (await readTelemetryEvents(options.cwd)).length;

			console.log(`Telemetry:  ${consent.enabled ? "on" : "off"} (${consent.reason})`);
			console.log(`Install ID: ${installId}`);
			console.log(`Environment: ${env}`);
			console.log(`Buffered events: ${buffered}`);
			console.log("Run `jolli telemetry inspect` to see exactly what would be sent.");
			console.log("Turn off any time with `jolli telemetry off` (or set DO_NOT_TRACK=1).");
		});

	telemetry
		.command("on")
		.description("Opt in to anonymous usage telemetry")
		.action(async () => {
			await saveConfig({ telemetry: "on", telemetryNoticeShown: true });
			console.log("Telemetry is now ON. Turn it off any time with `jolli telemetry off`.");
		});

	telemetry
		.command("off")
		.description("Opt out — no telemetry is collected or sent")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			await saveConfig({ telemetry: "off" });
			// Reflect the opt-out in the LIVE context immediately, so the command's
			// own postAction `command_invoked` hook becomes a no-op instead of
			// writing one event back into the buffer we're about to clear.
			shutdownTelemetry();
			// Honor the printed promise: discard anything already buffered (not just
			// stop future writes). Other repos' buffers are dropped lazily by the
			// flush-time consent re-gate in flushTelemetryNow.
			await clearTelemetryBuffer(options.cwd);
			console.log("Telemetry is now OFF. No events will be collected or sent.");
		});

	telemetry
		.command("inspect")
		.description("Print the exact buffered events that would be sent (plaintext)")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.action(async (options: { cwd: string }) => {
			const events = await readTelemetryEvents(options.cwd);
			if (events.length === 0) {
				console.log("No telemetry events are currently buffered.");
				return;
			}
			console.log(`${events.length} buffered event(s) — exactly what would be sent:`);
			console.log(JSON.stringify(events, null, 2));
		});
}
