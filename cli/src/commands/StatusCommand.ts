/**
 * Status command for Jolli CLI.
 *
 * `jolli status` — Show current Jolli Memory installation status,
 * including hooks, sessions, stored memories, the repo's Jolli Space
 * binding, and Jolli Site info.
 */

import type { Command } from "commander";
import { loadAuthToken } from "../auth/AuthConfig.js";
import type { ClineScanError } from "../core/ClineTranscriptShared.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import {
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
	SPACE_PROBE_TIMEOUT_MS,
} from "../core/JolliMemoryPushClient.js";
import { getGlobalConfigDir, loadConfigFromDir } from "../core/SessionTracker.js";
import {
	clearSpaceBindingCache,
	loadSpaceBindingCache,
	saveSpaceBindingCache,
	tenantOriginForKey,
} from "../core/SpaceBindingCache.js";
import type { SqliteScanError } from "../core/SqliteHelpers.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
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

/**
 * Repo→Space binding state behind the `Jolli Space:` status row.
 *
 * Cache-first since the SpaceBindingCache landed: a fresh healthy entry in
 * `<projectDir>/.jolli/jollimemory/space-binding.json` renders the row with
 * zero network I/O (`--refresh` forces a live re-check). On a cache miss the
 * state is resolved by ONE best-effort `POST /api/jolli-memory/front-door`
 * round-trip — the same single call the guided front door makes, reused
 * deliberately so `jolli status` and bare `jolli` can never disagree about
 * bound-ness — and the answer maintains the cache: a healthy bound writes it,
 * an unbound / no-spaces / degraded answer clears it, and network/auth
 * failures leave it untouched. No request at all is made without a
 * `jolliApiKey` (`no_key`) or in `--json` mode (the VS Code extension polls
 * that path; it must stay offline-safe and fast — it neither reads nor writes
 * the cache).
 *
 * Server-side caveat inherited from the endpoint: when the repo is unbound and
 * exactly one Space is bindable, the server auto-binds during the call — on
 * such tenants status reports the resulting `bound` state rather than
 * `unbound`. There is no read-only variant of the endpoint today (the backend's
 * `GET /api/jolli-memory/bindings` is marked unused/slated for removal, returns
 * no Space name, and masks a forbidden binding as 404 — so it cannot replace
 * the front-door call here).
 *
 * Server semantics pinned down against the backend's `JolliMemoryRouter`:
 * `no_spaces` is caller-relative — the bindable pool is filtered by the key
 * creator's Space visibility plus per-Space `articles.edit`, so a tenant full
 * of Spaces the caller cannot access still answers `no_spaces`. A binding
 * whose target Space was deleted is reported through the unbound path (the
 * stale row is preserved server-side), and a bound Space the caller lacks
 * `spaces.view` on comes back `bound` with null name/id.
 */
export type SpaceBindingStatus =
	| {
			readonly kind: "bound";
			readonly spaceName: string | null;
			readonly canPush: boolean | null;
			/** True when the server attached a bindable pool — i.e. `jolli` can actually offer a rebind. */
			readonly canRebind: boolean;
	  }
	| { readonly kind: "unbound"; readonly spaceCount: number }
	| { readonly kind: "no_spaces" }
	| { readonly kind: "no_key" }
	| { readonly kind: "auth_rejected" }
	| { readonly kind: "outdated" }
	| { readonly kind: "unreachable" };

/** Resolves the repo's Space-binding state for the status display. See {@link SpaceBindingStatus}. */
async function fetchSpaceBindingStatus(
	cwd: string,
	jolliApiKey: string | undefined,
	refresh = false,
): Promise<SpaceBindingStatus> {
	if (!jolliApiKey) {
		return { kind: "no_key" };
	}
	try {
		const repoUrl = await getCanonicalRepoUrl(cwd);
		const origin = tenantOriginForKey(jolliApiKey);
		// Cache-first: a fresh healthy binding renders with zero network I/O.
		// canRebind false is safe — the rebind hint only matters on degraded
		// bindings, which are never cached.
		if (!refresh && origin) {
			const cached = await loadSpaceBindingCache(cwd, { repoUrl, origin });
			if (cached) {
				return { kind: "bound", spaceName: cached.spaceName, canPush: cached.canPush, canRebind: false };
			}
		}
		const client = new JolliMemoryPushClient({
			apiKeyProvider: async () => jolliApiKey,
			timeoutMs: SPACE_PROBE_TIMEOUT_MS,
		});
		const result = await client.frontDoor({ repoUrl, repoName: deriveRepoNameFromUrl(repoUrl) });
		if (result.status === "bound") {
			const healthy = result.binding.canPush !== false && result.binding.spaceName !== null;
			if (healthy && origin) {
				await saveSpaceBindingCache(cwd, {
					repoUrl,
					origin,
					jmSpaceId: result.binding.jmSpaceId,
					spaceName: result.binding.spaceName as string,
					canPush: result.binding.canPush === true ? true : null,
				});
			} else {
				// Degraded bindings must never be served from cache.
				await clearSpaceBindingCache(cwd);
			}
			return {
				kind: "bound",
				spaceName: result.binding.spaceName,
				canPush: result.binding.canPush,
				canRebind: result.spaces.length > 0,
			};
		}
		// The server says unbound/no_spaces — drop any stale bound cache.
		await clearSpaceBindingCache(cwd);
		// An `unbound` whose list came back empty is contract drift (the server
		// answers `no_spaces` when nothing is bindable) — fold it into
		// `no_spaces`, mirroring SpaceSyncStep, so the row can never point at a
		// bind with zero options.
		if (result.status === "unbound" && result.spaces.length > 0) {
			return { kind: "unbound", spaceCount: result.spaces.length };
		}
		return { kind: "no_spaces" };
	} catch (error) {
		if (error instanceof ClientOutdatedError) {
			return { kind: "outdated" };
		}
		if (error instanceof NotAuthenticatedError) {
			return { kind: "auth_rejected" };
		}
		log.debug(`space binding probe failed: ${error instanceof Error ? error.message : String(error)}`);
		return { kind: "unreachable" };
	}
}

/**
 * Formats the `Jolli Space:` row value. The bound Space name is labelled and
 * quoted (`Space "Acme Core"`) for the same reason as the front door's sync
 * line: a name that reads like a product name (e.g. a Space called "Jolli
 * Memory") must still be recognizably a Space.
 *
 * Two bound shapes degrade to a warning — both mean pushes 403 until access
 * is restored: a null name (caller has no `spaces.view`, i.e. no role at all)
 * and `canPush === false` (Space visible, but the push gate `articles.edit`
 * is gone — e.g. demoted to viewer). When the server attached a bindable pool
 * (`canRebind`), the hint points at `jolli`, whose front door offers the
 * interactive rebind escape hatch (status itself stays read-only); with no
 * pool a rebind would offer zero choices, so the only way out is restored
 * access — same wording as the front door's own warning. A null `canPush`
 * (older server) renders as healthy: unknown must not false-alarm.
 */
export function describeSpaceBinding(state: SpaceBindingStatus): string {
	switch (state.kind) {
		case "bound": {
			const fix = state.canRebind ? "run jolli to rebind" : "ask for access";
			if (!state.spaceName) {
				return `Bound — no access to the Space (memories won't sync; ${fix})`;
			}
			if (state.canPush === false) {
				return `Bound to Space "${state.spaceName}" — read-only (memories won't sync; ${fix})`;
			}
			return `Bound to Space "${state.spaceName}"`;
		}
		case "unbound":
			return `Not bound — ${state.spaceCount} Space${state.spaceCount === 1 ? "" : "s"} available (run jolli to bind)`;
		case "no_spaces":
			// Caller-relative on the server: also the answer when Spaces exist
			// but none are visible/bindable to this key — don't claim "the
			// tenant has none".
			return "Not bound — no Spaces available to you";
		case "no_key":
			return "Not connected — run jolli auth login";
		case "auth_rejected":
			return "Not connected — key rejected (run jolli auth login)";
		case "outdated":
			return "Unknown — client outdated, update the CLI";
		case "unreachable":
			return "Unknown — Jolli not reachable (offline?)";
	}
}

/** Inputs to describeIntegrationStatus — one row in the CLI integration block. */
interface IntegrationStatusInputs {
	readonly enabled: boolean;
	/** undefined = this integration has no hook concept (Codex, OpenCode). */
	readonly hookInstalled: boolean | undefined;
	readonly sessionCount: number | undefined;
	/**
	 * DB/file scan failed (corrupt/locked/schema/parse/etc). Used by OpenCode,
	 * Cursor, Copilot, and Cline integrations. Union preserves literal-kind safety
	 * for both SqliteScanError (corrupt|locked|permission|schema|unknown) and
	 * ClineScanError (parse|fs|schema|unknown).
	 */
	readonly scanError?: SqliteScanError | ClineScanError;
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
		.option("--refresh", "Re-check the Jolli Space binding against the server (bypass the local cache)")
		.action(async (options: { cwd: string; json?: boolean; refresh?: boolean }) => {
			setLogDir(options.cwd);
			// Bind the active storage provider before any summary read (getStatus →
			// getSummaryCount). Without it resolveStorage falls back to the orphan
			// branch and logs a WARN — harmless for this read, but noisy, and it
			// bypasses the folder/dual-write provider a folder-mode user expects.
			setActiveStorage(await createStorage(options.cwd, options.cwd));

			log.info("Running 'status' command");
			const status = await getStatus(options.cwd);

			if (options.json) {
				console.log(JSON.stringify(status));
				return;
			}

			// Build hooks description matching VSCode STATUS panel format
			const hookParts: string[] = [];
			if (status.gitHookInstalled) hookParts.push(`${status.prePushHookInstalled ? 5 : 4} Git`);
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
			// Cache-first, at most one best-effort round-trip, human-readable
			// output only (see SpaceBindingStatus).
			const spaceBinding = await fetchSpaceBindingStatus(
				options.cwd,
				config?.jolliApiKey,
				options.refresh === true,
			);

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
			console.log(`  Jolli Space:      ${describeSpaceBinding(spaceBinding)}`);
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
			const subIndent = "".padEnd(18);
			const mark = (detected: boolean | undefined): string => (detected ? "✓" : "✗");

			// Copilot and Cline are dual-variant sources (terminal CLI + editor). Each
			// prints an indented breakdown sub-line beneath its main row. These are
			// attached to the row tuple (not emitted after the loop) so they render
			// directly under their own row rather than the last integration row.
			const copilotSubLines: string[] = [];
			const anyCopilotDetected = (status.copilotDetected ?? false) || (status.copilotChatDetected ?? false);
			if (anyCopilotDetected) {
				copilotSubLines.push(
					`  ${subIndent}↳ CLI: ${mark(status.copilotDetected)}, Chat: ${mark(status.copilotChatDetected)}`,
				);
				if (status.copilotChatScanError) {
					copilotSubLines.push(
						`  ${subIndent}↳ Chat scan failed (${status.copilotChatScanError.kind}): ${status.copilotChatScanError.message}`,
					);
				}
			}
			const clineSubLines: string[] = [];
			if (status.clineDetected) {
				clineSubLines.push(
					`  ${subIndent}↳ CLI: ${mark(status.clineCliDetected)}, VS Code: ${mark(status.clineVscodeDetected)}`,
				);
			}

			const integrationRows: ReadonlyArray<
				readonly [
					label: string,
					detected: boolean | undefined,
					inputs: IntegrationStatusInputs,
					subLines?: readonly string[],
				]
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
					"Devin:",
					status.devinDetected,
					{
						enabled: status.devinEnabled !== false,
						hookInstalled: undefined,
						sessionCount: counts.devin,
						scanError: status.devinScanError,
					},
				],
				[
					"Copilot:",
					anyCopilotDetected,
					{
						enabled: status.copilotEnabled !== false,
						hookInstalled: undefined,
						sessionCount: (counts.copilot ?? 0) + (counts["copilot-chat"] ?? 0),
						// CLI scan error renders on the main row; Chat scan error renders as a sub-line below.
						scanError: status.copilotScanError,
					},
					copilotSubLines,
				],
				[
					"Cline:",
					status.clineDetected ?? false,
					{
						enabled: status.clineEnabled !== false,
						hookInstalled: undefined,
						sessionCount: (counts.cline ?? 0) + (counts["cline-cli"] ?? 0),
						scanError: status.clineScanError,
					},
					clineSubLines,
				],
				[
					"Antigravity:",
					status.antigravityDetected,
					{
						enabled: status.antigravityEnabled !== false,
						hookInstalled: undefined,
						sessionCount: counts.antigravity,
						scanError: status.antigravityScanError,
					},
				],
			];
			for (const [label, detected, inputs, subLines] of integrationRows) {
				if (!detected) continue;
				console.log(`  ${label.padEnd(18)}${describeIntegrationStatus(inputs)}`);
				for (const line of subLines ?? []) {
					console.log(line);
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
