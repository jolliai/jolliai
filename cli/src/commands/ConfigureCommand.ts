/**
 * Configure command for Jolli CLI.
 *
 * `jolli configure` — Manage Jolli Memory configuration (API keys, model, agent toggles).
 * Supports --set key=value, --remove key, and default display of current config.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { resolveJolliUrlForKey, validateJolliApiKey } from "../core/JolliApiUtils.js";
import { ALL_LOCAL_AGENT_MODEL_IDS, LOCAL_AGENT_TOOLS, localAgentToolModels } from "../core/localagent/ToolMeta.js";
import { getGlobalConfigDir, loadConfig, saveConfig } from "../core/SessionTracker.js";
import { track } from "../core/Telemetry.js";
import { validateBackupFolder, validateBackupRetentionDays } from "../dashboard/Backup.js";
import { syncGlobalInstructions } from "../install/Installer.js";
import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig, LogLevel } from "../Types.js";

const log = createLogger("ConfigureCommand");

/** Valid values for the `logLevel` config key. */
const VALID_LOG_LEVELS: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"];

/** Valid values for the `aiProvider` config key. */
const VALID_AI_PROVIDERS: ReadonlyArray<NonNullable<JolliMemoryConfig["aiProvider"]>> = [
	"anthropic",
	"jolli",
	"local-agent",
];

/** Valid values for the `localAgentTool` config key — derived from the tool registry to avoid drift. */
const VALID_LOCAL_AGENT_TOOLS: ReadonlyArray<NonNullable<JolliMemoryConfig["localAgentTool"]>> = Object.keys(
	LOCAL_AGENT_TOOLS,
) as ReadonlyArray<NonNullable<JolliMemoryConfig["localAgentTool"]>>;

/**
 * The tools jollimemory pins a model for, derived from the registry rather than
 * named — `--list-keys` states this fact to the user, and a hand-written
 * "claude-code only" would silently become wrong the day a second tool declares
 * a model list.
 */
const PINNED_LOCAL_AGENT_TOOLS: ReadonlyArray<string> = (
	Object.keys(LOCAL_AGENT_TOOLS) as Array<keyof typeof LOCAL_AGENT_TOOLS>
).filter((id) => localAgentToolModels(id).length > 0);

/**
 * The accepted model ids GROUPED by the tool that offers them, e.g.
 * `claude-code: haiku | sonnet | opus | inherit; codex: gpt-5.6-luna | …`.
 *
 * Grouped rather than flat because the ids are each CLI's own namespace and
 * carry no marker saying which: with two pinned tools the flat union reads as
 * one menu, so nothing tells a person typing `--set localAgentModel=opus` that
 * it will do nothing while their tool is codex. `inherit` repeats under each
 * tool deliberately — it is offered by all of them and dropping it from the
 * groups would make it look unavailable.
 */
const LOCAL_AGENT_MODELS_BY_TOOL: string = (Object.keys(LOCAL_AGENT_TOOLS) as Array<keyof typeof LOCAL_AGENT_TOOLS>)
	.filter((id) => localAgentToolModels(id).length > 0)
	.map(
		(id) =>
			`${id}: ${localAgentToolModels(id)
				.map((m) => m.id)
				.join(" | ")}`,
	)
	.join("; ");

/** Valid values for the `globalInstructions` config key. */
const VALID_GLOBAL_INSTRUCTIONS: ReadonlyArray<NonNullable<JolliMemoryConfig["globalInstructions"]>> = [
	"enabled",
	"disabled",
];

/** Valid values for the `wikiRebuild` config key. */
const VALID_WIKI_REBUILD: ReadonlyArray<NonNullable<JolliMemoryConfig["wikiRebuild"]>> = ["manual", "auto"];

/**
 * Valid config keys exposed via `jolli configure --set/--remove`.
 * Must stay in sync with {@link JolliMemoryConfig} in Types.ts.
 *
 * `"slack.workspaceUrl"` is the one exception: it's a dotted pseudo-key for
 * the nested `slack.workspaceUrl` field, not a top-level `keyof
 * JolliMemoryConfig`. It's coerced and validated like any other key, then
 * folded into a nested `{ slack: { workspaceUrl } }` update just before
 * `saveConfig` — see the flattening step in the `--set`/`--remove` handler.
 */
const VALID_CONFIG_KEYS = [
	"apiKey",
	"model",
	"maxTokens",
	"jolliApiKey",
	"authToken",
	"codexEnabled",
	"geminiEnabled",
	"claudeEnabled",
	"openCodeEnabled",
	"cursorEnabled",
	"copilotEnabled",
	"clineEnabled",
	"devinEnabled",
	"antigravityEnabled",
	"kimiEnabled",
	"hermesEnabled",
	"mcpPlatformToolsEnabled",
	"globalInstructions",
	"logLevel",
	"excludePatterns",
	"localFolder",
	"aiProvider",
	"syncTranscripts",
	"syncSessions",
	"syncPollIntervalSec",
	"syncOnPush",
	"localAgentTool",
	"localAgentPath",
	"localAgentModel",
	"backupFolder",
	"backupRetentionDays",
	"wikiRebuild",
	"slack.workspaceUrl",
] as const satisfies ReadonlyArray<keyof JolliMemoryConfig | "slack.workspaceUrl">;

type ConfigKey = (typeof VALID_CONFIG_KEYS)[number];

/** Hosts allowed for `slack.workspaceUrl`: `slack.com` or any subdomain of it. */
function isAllowedSlackHost(hostname: string): boolean {
	return hostname === "slack.com" || hostname.endsWith(".slack.com");
}

/** Keys whose values should be masked when displayed (contain secrets). */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(["apiKey", "jolliApiKey", "authToken"]);

/** Returns true if the given string is a recognized config key. */
function isValidConfigKey(key: string): key is ConfigKey {
	return (VALID_CONFIG_KEYS as ReadonlyArray<string>).includes(key);
}

/** Masks a secret, keeping the prefix and suffix for recognizability. */
function maskSecret(value: string): string {
	if (value.length <= 10) return "***";
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Coerces a string value from the CLI into the appropriate type for the given config key. */
function coerceConfigValue(key: ConfigKey, raw: string): string | number | boolean | ReadonlyArray<string> {
	// Numeric fields
	if (key === "backupRetentionDays") {
		const n = Number(raw);
		const problem = validateBackupRetentionDays(n);
		if (problem) throw new Error(`${problem} (got: ${raw})`);
		return n;
	}
	if (key === "syncPollIntervalSec") {
		const n = Number(raw);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
			throw new Error(`${key} must be a positive integer (got: ${raw})`);
		}
		// Floor at 5400 (90 min) to prevent runaway push frequency on personal
		// vaults — 90 min is the product default and the Settings UI minimum.
		// Ceiling at 86400 (24h) so a typo can't park the engine for weeks.
		const MIN = 5400;
		const MAX = 86400;
		if (n < MIN) {
			throw new Error(
				`${key} must be at least ${MIN} (90 min) to avoid excessive sync push frequency (got: ${raw})`,
			);
		}
		if (n > MAX) {
			throw new Error(`${key} must be at most ${MAX} (24h) (got: ${raw})`);
		}
		return n;
	}
	if (key === "maxTokens") {
		// Use Number() rather than parseInt() — parseInt("8192abc") silently
		// returns 8192, letting malformed input slip through validation.
		const n = Number(raw);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
			throw new Error(`${key} must be a positive integer (got: ${raw})`);
		}
		return n;
	}
	// Boolean fields
	if (
		key === "codexEnabled" ||
		key === "geminiEnabled" ||
		key === "claudeEnabled" ||
		key === "openCodeEnabled" ||
		key === "cursorEnabled" ||
		key === "copilotEnabled" ||
		key === "clineEnabled" ||
		key === "devinEnabled" ||
		key === "antigravityEnabled" ||
		key === "kimiEnabled" ||
		key === "hermesEnabled" ||
		key === "mcpPlatformToolsEnabled" ||
		key === "syncTranscripts" ||
		key === "syncSessions" ||
		key === "syncOnPush"
	) {
		const lower = raw.toLowerCase();
		if (lower === "true" || lower === "1" || lower === "yes") return true;
		if (lower === "false" || lower === "0" || lower === "no") return false;
		throw new Error(`${key} must be true/false (got: ${raw})`);
	}
	// Enum fields
	if (key === "logLevel") {
		if (!(VALID_LOG_LEVELS as ReadonlyArray<string>).includes(raw)) {
			throw new Error(`${key} must be one of: ${VALID_LOG_LEVELS.join(", ")} (got: ${raw})`);
		}
		return raw;
	}
	if (key === "aiProvider") {
		if (!(VALID_AI_PROVIDERS as ReadonlyArray<string>).includes(raw)) {
			throw new Error(`${key} must be one of: ${VALID_AI_PROVIDERS.join(", ")} (got: ${raw})`);
		}
		return raw;
	}
	if (key === "localAgentTool") {
		if (!(VALID_LOCAL_AGENT_TOOLS as ReadonlyArray<string>).includes(raw)) {
			throw new Error(`${key} must be one of: ${VALID_LOCAL_AGENT_TOOLS.join(", ")} (got: ${raw})`);
		}
		return raw;
	}
	if (key === "localAgentModel") {
		// Rejected here rather than normalised away, unlike the two Settings panels:
		// those submit a dropdown value, so a bad one means a stale page and the
		// kind thing is to drop it; this is a person typing, and telling them the
		// value was ignored is better than silently storing something else.
		//
		// Trimmed before the check so `--set localAgentModel=" haiku"` is accepted
		// and stored the way the runtime reads it — an untrimmed compare would
		// reject a value `resolveLocalAgentModel` handles fine.
		const value = raw.trim();
		if (!ALL_LOCAL_AGENT_MODEL_IDS.includes(value)) {
			throw new Error(`${key} must be one of — ${LOCAL_AGENT_MODELS_BY_TOOL} (got: ${raw})`);
		}
		return value;
	}
	if (key === "globalInstructions") {
		if (!(VALID_GLOBAL_INSTRUCTIONS as ReadonlyArray<string>).includes(raw)) {
			throw new Error(`${key} must be one of: ${VALID_GLOBAL_INSTRUCTIONS.join(", ")} (got: ${raw})`);
		}
		return raw;
	}
	if (key === "wikiRebuild") {
		if (!(VALID_WIKI_REBUILD as ReadonlyArray<string>).includes(raw)) {
			throw new Error(`${key} must be one of: ${VALID_WIKI_REBUILD.join(", ")} (got: ${raw})`);
		}
		return raw;
	}
	// Array fields (comma-separated)
	if (key === "excludePatterns") {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	// Nested field: validated like the JolliApiUtils origin allowlist —
	// HTTPS-only, suffix-boundary host check — before it's ever persisted.
	if (key === "slack.workspaceUrl") {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			throw new Error(`slack.workspaceUrl must be an https://<workspace>.slack.com URL (got: ${raw})`);
		}
		if (parsed.protocol !== "https:" || !isAllowedSlackHost(parsed.hostname)) {
			throw new Error(`slack.workspaceUrl must be an https://<workspace>.slack.com URL (got: ${raw})`);
		}
		// Persist the normalized origin (scheme + host, no trailing slash or path)
		// so the reference extractor's `${workspaceUrl}/archives/...` permalink
		// reconstruction can't produce a double slash from a trailing-slash input.
		return parsed.origin;
	}
	// String fields (apiKey, model, jolliApiKey, authToken, localFolder, localAgentPath)
	return raw;
}

/** Descriptions for each config key, shown by --list-keys. */
const CONFIG_KEY_INFO: ReadonlyArray<{ key: ConfigKey; type: string; description: string }> = [
	{ key: "apiKey", type: "string", description: "Anthropic API key (secret)" },
	{ key: "model", type: "string", description: "LLM model name (e.g. claude-sonnet-4-20250514)" },
	{ key: "maxTokens", type: "number", description: "Token budget for LLM calls (positive integer)" },
	{ key: "jolliApiKey", type: "string", description: "Jolli Space API key (secret, sk-jol-...)" },
	{ key: "authToken", type: "string", description: "OAuth token from browser login (secret)" },
	{ key: "codexEnabled", type: "boolean", description: "Enable Codex session discovery (true/false)" },
	{ key: "geminiEnabled", type: "boolean", description: "Enable Gemini session tracking (true/false)" },
	{ key: "claudeEnabled", type: "boolean", description: "Enable Claude Code session tracking (true/false)" },
	{
		key: "openCodeEnabled",
		type: "boolean",
		description: "Enable OpenCode session discovery (true/false; requires Node 22.13+ at runtime)",
	},
	{
		key: "cursorEnabled",
		type: "boolean",
		description:
			"Enable Cursor session discovery — Composer IDE + cursor-agent CLI (true/false; requires Node 22.13+ at runtime)",
	},
	{
		key: "copilotEnabled",
		type: "boolean",
		description: "Enable Copilot CLI session discovery (true/false; requires Node 22.13+ at runtime)",
	},
	{
		key: "clineEnabled",
		type: "boolean",
		description: "Enable Cline (VS Code extension + CLI) session discovery (true/false)",
	},
	{
		key: "devinEnabled",
		type: "boolean",
		description: "Enable Devin CLI session discovery (true/false; requires Node 22.13+ at runtime)",
	},
	{
		key: "antigravityEnabled",
		type: "boolean",
		description: "Enable Antigravity session discovery (true/false; requires Node 22.13+ at runtime)",
	},
	{
		key: "kimiEnabled",
		type: "boolean",
		description: "Enable Kimi Code CLI (~/.kimi-code) session discovery (true/false)",
	},
	{
		key: "hermesEnabled",
		type: "boolean",
		description: "Enable Hermes Agent (~/.hermes) session discovery (true/false; requires Node 22.13+ at runtime)",
	},
	{
		key: "mcpPlatformToolsEnabled",
		type: "boolean",
		description: "Register backend-defined Jolli-platform tools in the MCP server (true/false; on by default)",
	},
	{ key: "logLevel", type: "enum", description: "Log level: debug | info | warn | error" },
	{ key: "excludePatterns", type: "string[]", description: "Glob patterns for file exclusion (comma-separated)" },
	{
		key: "localFolder",
		type: "string",
		description: "Absolute path to the Memory Bank folder (per-machine)",
	},
	{
		key: "aiProvider",
		type: "enum",
		description: "AI summary provider: anthropic | jolli | local-agent (auto-set on `jolli auth login`)",
	},
	{
		key: "localAgentTool",
		type: "enum",
		description: `Local agent CLI to drive when aiProvider=local-agent: ${VALID_LOCAL_AGENT_TOOLS.join(" | ")}`,
	},
	{
		key: "localAgentPath",
		type: "string",
		description: "Explicit path to the local agent binary, overriding PATH discovery",
	},
	{
		key: "localAgentModel",
		type: "enum",
		description: `Model the local agent is told to run (${PINNED_LOCAL_AGENT_TOOLS.join(", ")} only) — ${LOCAL_AGENT_MODELS_BY_TOOL}. A value the tool in force does not offer falls back to that tool's default; "inherit" runs whatever the tool is configured with`,
	},
	{
		key: "globalInstructions",
		type: "enum",
		description:
			"Skill-preference block in global AI instruction files: enabled | disabled (applied immediately — written when enabled, removed when disabled)",
	},
	{
		key: "syncTranscripts",
		type: "boolean",
		description: "Include raw AI conversation transcripts in cloud sync (default: false)",
	},
	{
		key: "syncSessions",
		type: "boolean",
		// Spelled out because this switch does not follow the rule the two around it
		// follow. `syncTranscripts` and `syncOnPush` are about a repo whose memories
		// the user chose to push; this one covers EVERY repo Jolli is enabled in,
		// bound to a Space or not. Until it existed, the dashboard's Sync tab was the
		// only place it could be turned off — not this command, not the editors — which
		// is a thin opt-out for the one channel that uploads from repositories the
		// user never connected to anything.
		description:
			"Sync session statistics (tokens, cost, tool names, session titles, memory search queries) to your Jolli organization, for every repo on this machine (default: true)",
	},
	{
		key: "syncOnPush",
		type: "boolean",
		description: "Auto-sync pushed commits' memory to Jolli Space on every git push (default: true when signed in)",
	},
	{
		key: "syncPollIntervalSec",
		type: "number",
		description: "Sync poll interval in seconds (5400-86400; default + floor = 90 min, ceiling = 24h; plugin only)",
	},
	{
		key: "wikiRebuild",
		type: "enum",
		description:
			"When the wiki/graph rebuilds: manual (default — rebuild on demand from dashboard/sidebar) | auto (every commit/merge/backfill)",
	},
	{
		key: "slack.workspaceUrl",
		type: "string",
		description:
			"Slack workspace base URL (https://<workspace>.slack.com) — fallback for thread permalinks when none was pasted",
	},
];

/** Commander collector: collects multiple --set entries into a string array. */
function collectSetOption(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** Commander collector: collects multiple --remove entries into a string array. */
function collectRepeatable(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** Registers the `configure` command on the given Commander program. */
export function registerConfigureCommand(program: Command): void {
	program
		.command("configure")
		.description("Manage Jolli Memory configuration (API keys, model, agent toggles)")
		.option("--set <key=value>", "Set a config value (repeatable)", collectSetOption, [] as string[])
		.option("--remove <key>", "Remove a config value (repeatable)", collectRepeatable, [] as string[])
		.option("--list-keys", "List all available config keys with descriptions")
		.action(async (options: { set: string[]; remove: string[]; listKeys?: boolean }) => {
			log.info("Running 'configure' command");

			if (options.listKeys) {
				console.log("\n  Available config keys:\n");
				for (const info of CONFIG_KEY_INFO) {
					console.log(`  ${info.key.padEnd(20)} (${info.type.padEnd(9)}) ${info.description}`);
				}
				console.log(`\n  Set:    jolli configure --set key=value`);
				console.log(`  Remove: jolli configure --remove key\n`);
				return;
			}

			// Apply --set and --remove mutations
			if (options.set.length > 0 || options.remove.length > 0) {
				const update: Record<string, unknown> = {};
				/** Tenant URL embedded in a newly-set `jolliApiKey`, for the `jolliUrl` sync below. */
				let keyTenantUrl: string | undefined;

				for (const entry of options.set) {
					const eq = entry.indexOf("=");
					if (eq < 0) {
						console.error(`\n  Error: --set expects key=value, got: ${entry}\n`);
						process.exitCode = 1;
						return;
					}
					const key = entry.slice(0, eq).trim();
					const rawValue = entry.slice(eq + 1);
					if (!isValidConfigKey(key)) {
						console.error(
							`\n  Error: unknown config key: ${key}\n  Valid keys: ${VALID_CONFIG_KEYS.join(", ")}\n`,
						);
						process.exitCode = 1;
						return;
					}
					try {
						update[key] = coerceConfigValue(key, rawValue);
					} catch (err) {
						console.error(`\n  Error: ${(err as Error).message}\n`);
						process.exitCode = 1;
						return;
					}
					// Reject unrecognized shapes and keys whose embedded `.u` points off
					// the allowlist before we touch disk. Matches saveAuthCredentials.
					if (key === "jolliApiKey" && typeof update[key] === "string") {
						try {
							validateJolliApiKey(update[key] as string);
						} catch (err) {
							console.error(`\n  Error: ${(err as Error).message}\n`);
							process.exitCode = 1;
							return;
						}
						keyTenantUrl = resolveJolliUrlForKey(update[key] as string);
					}
					// backupFolder is validated at SAVE time (the cutover gate's
					// rule); the snapshot engine itself never re-routes a bad value.
					if (key === "backupFolder" && typeof update[key] === "string") {
						const existing = await loadConfig();
						const problem = await validateBackupFolder(update[key] as string, {
							localFolder: existing.localFolder,
						});
						if (problem) {
							console.error(`\n  Error: ${problem}\n`);
							process.exitCode = 1;
							return;
						}
					}
				}

				for (const key of options.remove) {
					if (!isValidConfigKey(key)) {
						console.error(
							`\n  Error: unknown config key: ${key}\n  Valid keys: ${VALID_CONFIG_KEYS.join(", ")}\n`,
						);
						process.exitCode = 1;
						return;
					}
					update[key] = undefined;
				}

				// Fold the dotted "slack.workspaceUrl" pseudo-key into a nested update.
				// saveConfig/saveConfigScoped only shallow-merge top-level keys, so a
				// bare `update.slack = { workspaceUrl }` would clobber sibling `slack`
				// fields on disk — read the current config and spread its `slack`
				// object first.
				if ("slack.workspaceUrl" in update) {
					const workspaceUrl = update["slack.workspaceUrl"] as string | undefined;
					delete update["slack.workspaceUrl"];
					const existing = await loadConfig();
					update.slack = { ...existing.slack, workspaceUrl };
				}

				// A pasted key retargets every request at its own tenant, so `jolliUrl`
				// follows it — see `resolveJolliUrlForKey` for why leaving the two out
				// of step is silent rather than merely untidy.
				//
				// No "an explicit --set jolliUrl wins" guard: `jolliUrl` is NOT in
				// VALID_CONFIG_KEYS, so neither --set nor --remove can put it in
				// `update` (both spellings are rejected as an unknown key before
				// reaching here). Add it there and this needs one.
				//
				// The `typeof` check IS load-bearing, and must stay AFTER the --remove
				// loop: `--set jolliApiKey=<B> --remove jolliApiKey` in one invocation
				// leaves `keyTenantUrl` pointing at B while the remove has already
				// reset the field to undefined. Writing the URL anyway would name a
				// tenant the user never signed into, with no key to prove it — the
				// half-state this sync exists to remove, rebuilt from the other side.
				if (keyTenantUrl !== undefined && typeof update.jolliApiKey === "string") {
					update.jolliUrl = keyTenantUrl;
				}

				await saveConfig(update as Partial<JolliMemoryConfig>);
				if (typeof update.aiProvider === "string") {
					track("ai_provider_selected", { provider: update.aiProvider });
				}
				// Apply a globalInstructions change immediately, mirroring the VS Code
				// Settings toggle: "enabled" writes the skill-preference block now,
				// "disabled" removes it. This is the CLI's opt-in surface — the block is
				// only ever written because the user explicitly set it here, never on a
				// bare `jolli enable`. (`--remove globalInstructions` leaves the switch
				// undecided, which syncGlobalInstructions treats as a no-op.)
				if ("globalInstructions" in update) {
					await syncGlobalInstructions();
				}
				console.log(`\n  Config updated: ${join(getGlobalConfigDir(), "config.json")}\n`);
				return;
			}

			// Default: show current config with sensitive values masked
			const config = await loadConfig();
			console.log("\n  Jolli Memory Configuration");
			console.log("  ──────────────────────────────────────");
			console.log(`  Location: ${join(getGlobalConfigDir(), "config.json")}`);
			const entries = Object.entries(config);
			if (entries.length === 0) {
				console.log("  (empty — no configuration set)\n");
				return;
			}
			for (const [key, raw] of entries) {
				const value =
					SENSITIVE_KEYS.has(key) && typeof raw === "string"
						? maskSecret(raw)
						: Array.isArray(raw)
							? raw.join(", ")
							: String(raw);
				console.log(`  ${key.padEnd(20)} ${value}`);
			}
			console.log("");
		});
}
