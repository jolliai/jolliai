/**
 * VS Code telemetry activation (JOLLI-1785 Phase 2). Thin glue between the
 * extension host and the bundled CLI telemetry core:
 *
 *   - bootstraps telemetry on activate, passing the host opt-out signal
 *     (`!vscode.env.isTelemetryEnabled`, which folds in
 *     `telemetry.telemetryLevel`) as `platformDisabled`;
 *   - shows the loud first-run notice once (only when telemetry is actually
 *     enabled), then records it as shown;
 *   - exposes a flush hook for the sidebar's 60s tick.
 *
 * The vscode-specific bits (the platform signal, the notice popup, opening a
 * URL) are injected so this module is unit-testable without a vscode mock; the
 * CLI core functions are imported from the bundled `cli/src/**`.
 */
import { loadConfig, saveConfig } from "../../cli/src/core/SessionTracker.js";
import { shutdownTelemetry, track } from "../../cli/src/core/Telemetry.js";
import { shouldShowTelemetryNotice } from "../../cli/src/core/TelemetryConsent.js";
import { bootstrapTelemetry, flushTelemetryNow } from "../../cli/src/core/TelemetryStartup.js";

export const TELEMETRY_NOTICE =
	"Jolli Memory collects anonymous, content-free usage telemetry (never code, file paths, or memory content) to improve the product. " +
	"Manage it any time with `jolli telemetry off`, the DO_NOT_TRACK env var, or VS Code's own telemetry setting.";
export const TELEMETRY_DOCS_URL = "https://www.jolli.ai/telemetry";
const LEARN_MORE = "Learn more";
const TURN_OFF = "Turn off";

export interface TelemetryActivationDeps {
	/** `!vscode.env.isTelemetryEnabled` — the host's effective opt-out. */
	readonly platformDisabled: boolean;
	/** Show the first-run notice with action buttons; resolves to the chosen action (or undefined). */
	readonly showNotice: (message: string, ...actions: string[]) => Promise<string | undefined>;
	/** Open the transparency docs URL in the user's browser. */
	readonly openExternal: (url: string) => void;
}

/** Bootstrap telemetry for the extension and show the first-run notice once. Never throws. */
export async function activateExtensionTelemetry(cwd: string, deps: TelemetryActivationDeps): Promise<void> {
	await bootstrapTelemetry({ cwd, platformDisabled: deps.platformDisabled });
	// JOLLI-1963: count new + upgrade installs. Fires once per extension activation
	// (a real session), carrying `surface_version` in the envelope; the metric dedups
	// on first-seen (install_id, surface_version). No-op when telemetry is off — track
	// re-gates consent. Unlike `app_installed` (once per machine), this catches upgrades.
	track("client_activated");
	try {
		const config = await loadConfig();
		if (shouldShowTelemetryNotice({ config, platformDisabled: deps.platformDisabled })) {
			await saveConfig({ telemetryNoticeShown: true });
			const choice = await deps.showNotice(TELEMETRY_NOTICE, LEARN_MORE, TURN_OFF);
			if (choice === LEARN_MORE) {
				deps.openExternal(TELEMETRY_DOCS_URL);
			} else if (choice === TURN_OFF) {
				// One-click opt-out: persist the off switch and stop emitting now.
				await saveConfig({ telemetry: "off" });
				shutdownTelemetry();
			}
		}
	} catch {
		// Telemetry must never block extension activation.
	}
}

/**
 * Fire-and-forget flush, wired into the sidebar's 60s tick. The host's platform
 * opt-out (`!vscode.env.isTelemetryEnabled`) MUST be threaded through: the flush
 * re-gates consent, and the platform signal is a runtime value (not persisted in
 * config), so without it the tick would upload events buffered before the user
 * turned VS Code telemetry off. Callers pass the live signal each tick.
 */
export function flushExtensionTelemetry(cwd: string, platformDisabled: boolean): void {
	void flushTelemetryNow(cwd, { platformDisabled });
}

/**
 * Re-evaluate consent when the host telemetry setting changes mid-session
 * (`vscode.env.onDidChangeTelemetryEnabled`). Re-bootstraps with the new
 * platform signal so toggling VS Code telemetry takes effect immediately; no
 * first-run notice (that was handled at activate). Never throws.
 */
export async function reinitExtensionTelemetry(cwd: string, platformDisabled: boolean): Promise<void> {
	await bootstrapTelemetry({ cwd, platformDisabled });
}
