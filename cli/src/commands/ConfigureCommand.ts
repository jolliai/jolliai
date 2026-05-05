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
import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig, LogLevel } from "../Types.js";

const log = createLogger("ConfigureCommand");

/** Valid values for the `logLevel` config key. */
const VALID_LOG_LEVELS: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"];

/**
 * Valid config keys exposed via `jolli configure --set/--remove`.
 * Must stay in sync with {@link JolliMemoryConfig} in Types.ts.
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
	"logLevel",
	"excludePatterns",
] as const satisfies ReadonlyArray<keyof JolliMemoryConfig>;

type ConfigKey = (typeof VALID_CONFIG_KEYS)[number];

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
		key === "copilotEnabled"
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
	// Array fields (comma-separated)
	if (key === "excludePatterns") {
		return raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	// String fields (apiKey, model, jolliApiKey, authToken)
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

				await saveConfig(update as Partial<JolliMemoryConfig>);
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
