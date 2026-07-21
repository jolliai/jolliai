/**
 * SettingsModel — PURE data model for SettingsScreen's config sub-views. The
 * config-row catalog (enum / free-text rows and their read/write bindings) plus
 * the small pure helpers (csv, parseMaxTokens, nextInCycle) live here — out of
 * the Ink view — mirroring ManageModel.ts, so they are unit-testable without
 * rendering. No Ink, no React.
 */
import { isValidLocalFolder } from "../../core/KBPathResolver.js";
import { resolveModelId } from "../../core/Summarizer.js";
import type { JolliMemoryConfig } from "../../Types.js";
import type { TuiDeps } from "./TuiDeps.js";

/** The three model tiers the Settings enum cycles through. */
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;

/** Normalize a stored `model` value to the tier the Settings enum can cycle.
 *  A power user may have pinned a full ID (`jolli configure --set model=claude-sonnet-4-6`);
 *  reverse-map it to its tier so pressing Space advances predictably instead of
 *  treating the ID as "not in the list" and snapping to the first tier — a silent
 *  downgrade to the cheapest model. An unrecognized custom ID is returned as-is
 *  (shown verbatim; the first Space then starts the cycle at the top). */
export function modelTier(stored: string | undefined): string {
	if (!stored) {
		return "sonnet";
	}
	const id = resolveModelId(stored);
	return MODEL_TIERS.find((tier) => resolveModelId(tier) === id) ?? stored;
}

/** The Settings sub-nav views — the four config tabs mirror the VSCode Settings
 *  tabs (see `SettingsHtmlBuilder`); `skills` / `plugins` are TUI-only. */
export type SettingsSubView = "agents" | "summary" | "memory" | "others" | "skills" | "plugins";

/** A general setting row: an enum cycled in place, or free text edited inline. */
export type GeneralRow =
	| {
			readonly kind: "enum";
			readonly key: string;
			readonly label: string;
			readonly values: readonly string[];
			readonly detail?: string;
			read(c: JolliMemoryConfig): string;
			write(deps: TuiDeps, value: string): Promise<void>;
	  }
	| {
			readonly kind: "text";
			readonly key: string;
			readonly label: string;
			readonly detail?: string;
			/** Example text shown dim in an empty editor so the user knows the format. */
			readonly placeholder?: string;
			/** Credential field: value is masked on display and while typing, and the
			 *  editor starts empty (never prefilled with the stored secret). */
			readonly secret?: boolean;
			read(c: JolliMemoryConfig): string;
			write(deps: TuiDeps, value: string): Promise<void>;
	  };

export const csv = (v: string): string[] =>
	v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * Parse the Max Output Tokens editor value. Blank → unset (clears the cap).
 * A non-empty value must be a positive integer — uses `Number()` (NOT
 * `parseInt`, which coerces "8192abc" → 8192, letting malformed input through)
 * to stay in lockstep with ConfigureCommand's `--set maxTokens` validation.
 * Throws on malformed input so the editor surfaces a "Failed" note instead of
 * silently storing a wrong value.
 */
export function parseMaxTokens(v: string): number | undefined {
	const trimmed = v.trim();
	if (trimmed === "") return undefined;
	const n = Number(trimmed);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new Error(`Max Output Tokens must be a positive integer (got: ${trimmed})`);
	}
	return n;
}

/** Global Instructions — lives at the bottom of the AI Agents tab (mirrors the
 *  VSCode "Global preferences" row on that tab). */
export const GLOBAL_INSTRUCTIONS_ROW: Extract<GeneralRow, { kind: "enum" }> = {
	kind: "enum",
	key: "globalInstructions",
	label: "Global Instructions",
	values: ["disabled", "enabled"],
	detail: "skill hints in the agents' global files",
	read: (c) => c.globalInstructions ?? "disabled",
	write: (d, v) => d.applySetting("globalInstructions", v as "enabled" | "disabled"),
};

const SUMMARY_ROWS: readonly GeneralRow[] = [
	{
		kind: "enum",
		key: "aiProvider",
		label: "Provider",
		values: ["anthropic", "jolli", "local-agent"],
		read: (c) => c.aiProvider ?? "anthropic",
		write: (d, v) => d.applySetting("aiProvider", v as "anthropic" | "jolli" | "local-agent"),
	},
	{
		kind: "text",
		key: "apiKey",
		label: "API Key",
		secret: true,
		placeholder: "sk-ant-…",
		read: (c) => (c.apiKey ? "configured" : ""),
		// Saving a key also switches the provider to "anthropic" (mirrors
		// saveJolliApiKey → "jolli" and Home onboarding), so a pasted key actually
		// takes effect instead of leaving aiProvider on jolli/local-agent. Clearing
		// the field just removes the key without forcing a provider switch.
		write: (d, v) => (v ? d.saveAnthropicKey(v) : d.applySetting("apiKey", undefined)),
	},
	{
		kind: "enum",
		key: "model",
		label: "Model",
		values: [...MODEL_TIERS],
		detail: "model that writes your summaries (default sonnet)",
		read: (c) => modelTier(c.model),
		write: (d, v) => d.applySetting("model", v),
	},
	{
		kind: "text",
		key: "maxTokens",
		label: "Max Output Tokens",
		detail: "per-summary output cap (default 8192)",
		placeholder: "8192",
		read: (c) => (c.maxTokens != null ? String(c.maxTokens) : ""),
		write: (d, v) => d.applySetting("maxTokens", parseMaxTokens(v)),
	},
	{
		kind: "text",
		key: "jolliApiKey",
		label: "Jolli API Key",
		secret: true,
		placeholder: "sk-jol-…",
		read: (c) => (c.jolliApiKey ? "configured" : ""),
		// Clearing removes the key without validating (the validating saver rejects
		// an empty string) — mirrors the API Key row so both secrets can be wiped.
		write: (d, v) => (v ? d.saveJolliApiKey(v) : d.applySetting("jolliApiKey", undefined)),
	},
];

const MEMORY_ROWS: readonly GeneralRow[] = [
	{
		kind: "text",
		key: "localFolder",
		label: "Folder Path",
		detail: "absolute path to the Memory Bank root (blank = default)",
		placeholder: "/home/you/memory-bank",
		read: (c) => c.localFolder ?? "",
		// Reject relative / `..` paths at save time (shares KBPathResolver's
		// predicate) — otherwise the value saves fine and only blows up later when
		// a write path hits assertValidLocalFolder, leaving Settings showing a path
		// git never uses. Blank is allowed (means "use the default").
		write: (d, v) => {
			if (v && !isValidLocalFolder(v)) {
				throw new Error("Folder Path must be an absolute path with no '..' segments");
			}
			return d.applySetting("localFolder", v);
		},
	},
	{
		kind: "enum",
		key: "syncTranscripts",
		label: "Include transcripts",
		values: ["disabled", "enabled"],
		detail: "raw AI conversation logs",
		read: (c) => (c.syncTranscripts ? "enabled" : "disabled"),
		write: (d, v) => d.applySetting("syncTranscripts", v === "enabled"),
	},
	{
		kind: "text",
		key: "compileExcludeFolders",
		label: "Compile Exclude Folders",
		detail: "comma-separated folder names, e.g. vendor, dist",
		placeholder: "vendor, dist",
		read: (c) => (c.compileExcludeFolders ?? []).join(", "),
		write: (d, v) => d.applySetting("compileExcludeFolders", csv(v)),
	},
];

const OTHERS_ROWS: readonly GeneralRow[] = [
	{
		kind: "enum",
		key: "dcoSignoff",
		label: "Sign commits with DCO",
		values: ["disabled", "enabled"],
		read: (c) => (c.dcoSignoff ? "enabled" : "disabled"),
		write: (d, v) => d.applySetting("dcoSignoff", v === "enabled"),
	},
	{
		kind: "text",
		key: "excludePatterns",
		label: "Exclude Patterns",
		detail: "comma-separated globs, e.g. node_modules, *.log, dist/",
		placeholder: "node_modules, *.log, dist/",
		read: (c) => (c.excludePatterns ?? []).join(", "),
		write: (d, v) => d.applySetting("excludePatterns", csv(v)),
	},
];

/** Config rows for a config sub-view (empty for host/skill/plugin sub-views). */
export function configRowsFor(sub: SettingsSubView): readonly GeneralRow[] {
	switch (sub) {
		case "summary":
			return SUMMARY_ROWS;
		case "memory":
			return MEMORY_ROWS;
		case "others":
			return OTHERS_ROWS;
		default:
			return [];
	}
}

/** Every config row, for editor lookup by key (agents' Global Instructions too). */
export const ALL_CONFIG_ROWS: readonly GeneralRow[] = [
	...SUMMARY_ROWS,
	...MEMORY_ROWS,
	...OTHERS_ROWS,
	GLOBAL_INSTRUCTIONS_ROW,
];

export function nextInCycle(values: readonly string[], current: string): string {
	const i = values.indexOf(current);
	return values[(i + 1) % values.length];
}
