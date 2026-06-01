/**
 * Status command for Jolli CLI.
 *
 * `jolli status` — Show current Jolli Memory installation status,
 * including hooks, sessions, stored memories, and Jolli Site info.
 */

import type { Command } from "commander";
import { loadAuthToken } from "../auth/AuthConfig.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import { getStatus } from "../install/Installer.js";
import { createLogger, setLogDir } from "../Logger.js";
import type { StatusInfo } from "../Types.js";
import { resolveProjectDir, VERSION } from "./CliUtils.js";

const log = createLogger("StatusCommand");

/**
 * Maps the v5 migration state to the user-facing one-line description shown
 * under `Data migration:` in `jolli status`. Mirrors the VSCode Hooks tooltip
 * line wording so users see the same language across both surfaces.
 *
 * Deliberately binary: "Up to date (v5)" vs "Not migrated — run jolli migrate".
 * Earlier drafts surfaced five sub-states (completed-fresh, completed-not-fresh,
 * in-progress, failed, pending) but only three are reachable from the current
 * code path, and the distinction between them isn't actionable for users —
 * everything that isn't `completed` reduces to "run `jolli migrate` and check
 * the log".
 *
 * The structured `StatusInfo` mirror of this is the single `schemaV5` field
 * (see `Types.ts`). The richer `SchemaV5MigrationState` fields (`fresh`,
 * `migratedCount`, `errorMessage`, `startedAt`, `completedAt`) live only on the
 * persisted state read by `readSchemaV5State` and are NOT projected onto
 * `StatusInfo` — there's no consumer, so the binary `schemaV5` is all we
 * expose. If a future UI needs finer detail (e.g. distinguishing fresh installs
 * or surfacing a failure reason), add the specific field to `StatusInfo` then,
 * driven by a real consumer rather than ahead of need.
 */
export function describeSchemaV5Status(state: StatusInfo["schemaV5"]): string {
	return state === "completed" ? "Up to date (v5)" : "Not migrated — run jolli migrate";
}

/** Inputs to describeIntegrationStatus — one row in the CLI integration block. */
interface IntegrationStatusInputs {
	readonly enabled: boolean;
	/** undefined = this integration has no hook concept (Codex, OpenCode). */
	readonly hookInstalled: boolean | undefined;
	readonly sessionCount: number | undefined;
	/** DB existed but scan failed (corrupt/locked/schema/etc). Used by OpenCode and Copilot integrations. */
	readonly scanError?: StatusInfo["openCodeScanError"];
}

/**
 * Formats the descriptor for one integration row in `jolli status` output.
 *
 * Mirrors the VSCode STATUS panel's four-state model (see StatusTreeProvider's
 * pushIntegrationItem) plus a dedicated "unavailable" state for OpenCode's
 * scan-error channel. Wording is kept aligned with VSCode so users see the
 * same language in both surfaces.
 */
function describeIntegrationStatus(x: IntegrationStatusInputs): string {
	if (x.scanError) {
		return `unavailable — ${x.scanError.kind}`;
	}
	if (!x.enabled) {
		return "detected but disabled";
	}
	const count = x.sessionCount ?? 0;
	const suffix = count > 0 ? ` (${count} session${count !== 1 ? "s" : ""})` : "";
	if (x.hookInstalled === false) {
		return "hook not installed";
	}
	if (x.hookInstalled === true) {
		return `hook installed${suffix}`;
	}
	return `detected & enabled${suffix}`;
}

/** Registers the `status` command on the given Commander program. */
export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Show Jolli Memory installation status")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--json", "Output status as JSON (used by the VSCode extension)")
		.action(async (options: { cwd: string; json?: boolean }) => {
			setLogDir(options.cwd);

			log.info("Running 'status' command");
			const status = await getStatus(options.cwd);

			if (options.json) {
				console.log(JSON.stringify(status));
				return;
			}

			// Build hooks description matching VSCode STATUS panel format
			const hookParts: string[] = [];
			if (status.gitHookInstalled) hookParts.push("3 Git");
			if (status.claudeHookInstalled) hookParts.push("2 Claude");
			if (status.geminiHookInstalled) hookParts.push("1 Gemini CLI");
			const hooksDesc = hookParts.length > 0 ? hookParts.join(" + ") : "none installed";

			const hookRuntime = status.hookSource
				? `${status.hookSource}${status.hookVersion && status.hookVersion !== "unknown" ? `@${status.hookVersion}` : ""}`
				: undefined;

			// Load config for Jolli Site display (same layered logic as enable).
			// `jolliUrl` is the persisted public site origin, written on every
			// sign-in since 0.99.2. We deliberately do NOT fall back to the tenant
			// URL embedded in `jolliApiKey`: although `meta.u` is a public origin
			// (not secret material), deriving a *logged* value from the key trips
			// CodeQL's clear-text-logging taint analysis (jolliApiKey ->
			// parseJolliApiKey -> console.log). A pre-0.99.2 install that carries
			// only `jolliApiKey` simply omits this row until the next sign-in
			// persists `jolliUrl`.
			const configDir = getGlobalConfigDir();
			const config = await loadConfigFromDir(configDir);
			const jolliSite = config?.jolliUrl;
			// Use loadAuthToken() so JOLLI_AUTH_TOKEN env var is honored, matching `jolli auth status`.
			const authToken = await loadAuthToken();

			console.log(`\n  Jolli Memory Status (v${VERSION})`);
			console.log("  ──────────────────────────────────────");
			console.log(`  Hooks:            ${hooksDesc}`);
			if (hookRuntime) {
				console.log(`  Hook runtime:     ${hookRuntime}`);
			}
			console.log(`  Data migration:   ${describeSchemaV5Status(status.schemaV5)}`);
			/* v8 ignore next -- ternary: auth token presence depends on external config/env */
			console.log(`  Jolli Account:    ${authToken ? "Signed in" : "Not signed in"}`);
			console.log(`  Jolli API Key:    ${config?.jolliApiKey ? "Configured" : "Not configured"}`);
			/* v8 ignore next 2 -- ternary: env var presence depends on external environment */
			console.log(
				`  Anthropic Key:    ${config?.apiKey || process.env.ANTHROPIC_API_KEY ? "Configured" : "Not configured"}`,
			);
			console.log(`  Sessions:         ${status.activeSessions}`);

			// Per-integration breakdown. Only print rows for detected integrations;
			// undetected ones stay hidden to keep the output terse (same rule as
			// the VSCode STATUS panel). Claude's enabled flag lives in config, not
			// StatusInfo, so read it from the already-loaded `config`.
			const counts = status.sessionsBySource ?? {};
			const integrationRows: ReadonlyArray<
				readonly [label: string, detected: boolean | undefined, inputs: IntegrationStatusInputs]
			> = [
				[
					"Claude:",
					status.claudeDetected,
					{
						enabled: config?.claudeEnabled !== false,
						hookInstalled: status.claudeHookInstalled,
						sessionCount: counts.claude,
					},
				],
				[
					"Codex:",
					status.codexDetected,
					{
						enabled: status.codexEnabled !== false,
						hookInstalled: undefined,
						sessionCount: counts.codex,
					},
				],
				[
					"Gemini:",
					status.geminiDetected,
					{
						enabled: status.geminiEnabled !== false,
						hookInstalled: status.geminiHookInstalled,
						sessionCount: counts.gemini,
					},
				],
				[
					"OpenCode:",
					status.openCodeDetected,
					{
						enabled: status.openCodeEnabled !== false,
						hookInstalled: undefined,
						sessionCount: counts.opencode,
						scanError: status.openCodeScanError,
					},
				],
				[
					"Cursor:",
					status.cursorDetected,
					{
						enabled: status.cursorEnabled !== false,
						hookInstalled: undefined,
						sessionCount: counts.cursor,
						scanError: status.cursorScanError,
					},
				],
				[
					"Copilot:",
					(status.copilotDetected ?? false) || (status.copilotChatDetected ?? false),
					{
						enabled: status.copilotEnabled !== false,
						hookInstalled: undefined,
						sessionCount: (counts.copilot ?? 0) + (counts["copilot-chat"] ?? 0),
						// CLI scan error renders on the main row; Chat scan error renders as a sub-line below.
						scanError: status.copilotScanError,
					},
				],
			];
			for (const [label, detected, inputs] of integrationRows) {
				if (!detected) continue;
				console.log(`  ${label.padEnd(18)}${describeIntegrationStatus(inputs)}`);
			}
			const anyCopilotDetected = (status.copilotDetected ?? false) || (status.copilotChatDetected ?? false);
			if (anyCopilotDetected) {
				const cliMark = status.copilotDetected ? "✓" : "✗";
				const chatMark = status.copilotChatDetected ? "✓" : "✗";
				console.log(`  ${"".padEnd(18)}↳ CLI: ${cliMark}, Chat: ${chatMark}`);
				if (status.copilotChatScanError) {
					console.log(
						`  ${"".padEnd(18)}↳ Chat scan failed (${status.copilotChatScanError.kind}): ${status.copilotChatScanError.message}`,
					);
				}
			}

			console.log(`  Stored memories:  ${status.summaryCount}`);
			if (jolliSite) {
				// `jolliSite` is the on-disk `jolliUrl`. Label it the live "Jolli
				// Site" only when an on-disk credential actually backs it. We
				// deliberately gate on the DISK auth token (`config?.authToken`),
				// not the env-first `authToken` above: a `JOLLI_AUTH_TOKEN` injected
				// purely via the environment carries no tenant of its own, so
				// pairing it with a stale on-disk `jolliUrl` from a prior web login
				// would render "Signed in" beside an unrelated tenant. In that
				// env-only case (and after `jolli auth logout`, where `jolliUrl` is
				// intentionally retained), fall back to "Last signed-in site" so the
				// row can't be misread as the currently-connected tenant.
				const diskBacked = !!(config?.authToken || config?.jolliApiKey);
				const siteLabel = diskBacked ? "Jolli Site:      " : "Last signed-in site:";
				console.log(`  ${siteLabel} ${jolliSite.replace(/^https?:\/\//, "")}`);
			}
			console.log(`  Orphan branch:    ${status.orphanBranch}`);
			console.log("");
		});
}
