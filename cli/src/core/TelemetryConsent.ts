/**
 * TelemetryConsent — the single gate that decides whether telemetry may be
 * collected (JOLLI-1785 Phase 2). Opt-out model: telemetry is ON by default,
 * but is silenced when the user has said no through any of three channels,
 * checked in order of authority:
 *
 *   1. `DO_NOT_TRACK` — the cross-tool platform signal
 *      (https://consoledonottrack.com): set and not "0" ⇒ opt out.
 *   2. A host platform opt-out — VS Code passes
 *      `!vscode.env.isTelemetryEnabled` (which already folds in
 *      `telemetry.telemetryLevel === "off"`). This module deliberately takes
 *      it as a parameter rather than importing `vscode`, because CLI core is
 *      bundled verbatim into the extension and must not depend on the
 *      extension host.
 *   3. Our own config `telemetry: "off"` — the one-line in-app off switch.
 *
 * A loud first-run notice is shown once per machine (tracked by
 * `telemetryNoticeShown`); `shouldShowTelemetryNotice` decides when.
 */
import type { JolliMemoryConfig } from "../Types.js";

/** Why telemetry is on or off — surfaced by `jolli telemetry status|inspect`. */
export type ConsentReason = "on" | "do-not-track" | "platform-off" | "config-off";

export interface ConsentInput {
	/** The loaded global config (only the telemetry-related fields are read). */
	readonly config: Pick<JolliMemoryConfig, "telemetry" | "telemetryNoticeShown">;
	/** Environment to read `DO_NOT_TRACK` from. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Host-platform opt-out. VS Code passes `!vscode.env.isTelemetryEnabled`.
	 * The CLI leaves this undefined (no host platform to honor).
	 */
	readonly platformDisabled?: boolean;
}

export interface ConsentResult {
	readonly enabled: boolean;
	readonly reason: ConsentReason;
}

/**
 * `DO_NOT_TRACK` is "set" for our purposes when present and not `"0"` and not
 * empty — matching the de-facto console DNT convention (any truthy value means
 * opt out; `"0"` explicitly means "tracking allowed").
 */
function doNotTrackSet(env: NodeJS.ProcessEnv): boolean {
	const raw = env.DO_NOT_TRACK;
	if (raw === undefined) return false;
	const v = raw.trim();
	return v !== "" && v !== "0";
}

/** Resolve the effective consent state and the reason behind it. */
export function resolveTelemetryConsent(input: ConsentInput): ConsentResult {
	const env = input.env ?? process.env;
	if (doNotTrackSet(env)) {
		return { enabled: false, reason: "do-not-track" };
	}
	if (input.platformDisabled === true) {
		return { enabled: false, reason: "platform-off" };
	}
	if (input.config.telemetry === "off") {
		return { enabled: false, reason: "config-off" };
	}
	return { enabled: true, reason: "on" };
}

/** Convenience boolean for the hot `track()` path. */
export function isTelemetryEnabled(input: ConsentInput): boolean {
	return resolveTelemetryConsent(input).enabled;
}

/**
 * The loud first-run notice is shown once — only when telemetry is actually
 * enabled (no point announcing collection we then won't do) and the notice has
 * not been recorded as shown yet. The caller persists `telemetryNoticeShown`
 * after displaying it.
 */
export function shouldShowTelemetryNotice(input: ConsentInput): boolean {
	if (input.config.telemetryNoticeShown === true) return false;
	return resolveTelemetryConsent(input).enabled;
}
