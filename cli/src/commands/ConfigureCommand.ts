/**
 * Configure command for Jolli CLI.
 *
 * `jolli configure` — Manage Jolli Memory configuration (API keys, model, agent toggles).
 * Supports --set key=value, --remove key, and default display of current config.
 */

import { join } from "node:path";
import type { Command } from "commander";
import { validateJolliApiKey } from "../core/JolliApiUtils.js";
import { getGlobalConfigDir, loadConfig, saveConfig } from "../core/SessionTracker.js";
import { track } from "../core/Telemetry.js";
import { syncGlobalInstructions } from "../install/Installer.js";
import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig, LogLevel } from "../Types.js";

const log = createLogger("ConfigureCommand");

/** Valid values for the `logLevel` config key. */
const VALID_LOG_LEVELS: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"];

/** Valid values for the `aiProvider` config key. */
const VALID_AI_PROVIDERS: ReadonlyArray<NonNullable<JolliMemoryConfig["aiProvider"]>> = ["anthropic", "jolli"];

/** Valid values for the `globalInstructions` config key. */
const VALID_GLOBAL_INSTRUCTIONS: ReadonlyArray<NonNullable<JolliMemoryConfig["globalInstructions"]>> = [
	"enabled",
	"disabled",
];

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
	"globalInstructions",
	"logLevel",
	"excludePatterns",
	"localFolder",
	"aiProvider",
	"syncTranscripts",
	"syncPollIntervalSec",
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
		key === "syncTranscripts"
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
	if (key === "globalInstructions") {
		if (!(VALID_GLOBAL_INSTRUCTIONS as ReadonlyArray<string>).includes(raw)) {
			throw new Error(`${key} must be one of: ${VALID_GLOBAL_INSTRUCTIONS.join(", ")} (got: ${raw})`);
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
	// String fields (apiKey, model, jolliApiKey, authToken, localFolder)
	return raw;
}

/** Descriptions for each config key, shown by --list-keys. */
const CONFIG_KEY_INFO: ReadonlyArray<{ key: ConfigKey; type: string; description: string }> = [
	{ key: "apiKey", type: "string", description: "Anthropic API key (secret)" },
	{ key: "model", type: "string", description: "LLM model name (e.g. claude-sonnet-4-20250514)" },
	{ key: "maxTokens", type: "number", description: "Token budget for LLM calls (positive integer)" },
	{ key: "jolliApiKey", type: "string", description: "Jolli Space API key (secret, sk-jol-...)" },
	{ key: "authToken", type: "string", description: "OAuth token from browser login (secret)" },
	{ key: "codexEnabled", type: "boolean", description: "Enable Codex CLI session discovery (true/false)" },
	{ key: "geminiEnabled", type: "boolean", description: "Enable Gemini CLI session tracking (true/false)" },
	{ key: "claudeEnabled", type: "boolean", description: "Enable Claude Code session tracking (true/false)" },
	{
		key: "openCodeEnabled",
		type: "boolean",
		description: "Enable OpenCode session discovery (true/false; requires Node 22.5+ at runtime)",
	},
	{
		key: "cursorEnabled",
		type: "boolean",
		description: "Enable Cursor Composer session discovery (true/false; requires Node 22.5+ at runtime)",
	},
	{
		key: "copilotEnabled",
		type: "boolean",
		description: "Enable Copilot CLI session discovery (true/false; requires Node 22.5+ at runtime)",
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
		description: "AI summary provider: anthropic | jolli (auto-set on `jolli auth login`)",
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
		key: "syncPollIntervalSec",
		type: "number",
		description: "Sync poll interval in seconds (5400-86400; default + floor = 90 min, ceiling = 24h; plugin only)",
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
