/**
 * SettingsMutations — the write half of the Settings page: parse a submitted
 * settings object, persist it transactionally, and reconcile the two side
 * effects a config write can have (agent hooks across every repo, and the
 * global-instructions block).
 *
 * Design rules carried over from the VS Code panel it replaces:
 *   - The full API key never leaves the server. The page submits the MASKED
 *     value for an untouched key; when a submitted key equals the mask of the
 *     currently-stored key, the stored key is kept (re-read inside the write
 *     transaction). Only a genuinely new value is written. Nothing here logs a
 *     key.
 *   - `globalInstructions` is tri-state: `"default"` means "never decided" and
 *     is written as "leave the field unset", never `"disabled"`.
 *   - Agent-hook toggles are reconciled across EVERY registered repo (the
 *     dashboard is a machine-wide surface, unlike the VS Code panel's single
 *     workspace), skipping any clone the user has `jolli disable`d. Only a real
 *     `claudeEnabled` / `geminiEnabled` transition triggers the sweep.
 */

import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { getProjectRootDir, listWorktrees } from "../core/GitOps.js";
import { assertJolliOriginAllowed, parseJolliApiKey, resolveJolliUrlForKey } from "../core/JolliApiUtils.js";
import { extractRepoName } from "../core/KBPathResolver.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { getGlobalConfigDir, updateConfigTransactionalScoped } from "../core/SessionTracker.js";
import {
	installClaudeHook,
	installGeminiHook,
	removeClaudeHook,
	removeGeminiHook,
	syncGlobalInstructions,
} from "../install/Installer.js";
import { createLogger, errMsg } from "../Logger.js";
import type { JolliMemoryConfig, LocalAgentToolId } from "../Types.js";
import { existingWorktrees, listActiveRepos } from "./RepoRegistry.js";
import { maskApiKey } from "./SettingsPageQuery.js";

const log = createLogger("SettingsMutations");

/** Thrown for a rejected submission (bad shape, no agent enabled, invalid key). */
export class SettingsValidationError extends Error {}

/** One repo/worktree that failed to sync a hook, surfaced back to the page. */
export interface HookSyncFailure {
	readonly integration: "Claude" | "Gemini";
	readonly worktree: string;
	readonly cause: string;
}

export interface SettingsApplyInput {
	readonly claudeEnabled: boolean;
	readonly codexEnabled: boolean;
	readonly geminiEnabled: boolean;
	readonly openCodeEnabled: boolean;
	readonly cursorEnabled: boolean;
	readonly devinEnabled: boolean;
	readonly copilotEnabled: boolean;
	readonly clineEnabled: boolean;
	readonly antigravityEnabled: boolean;
	readonly kimiEnabled: boolean;
	readonly globalInstructions: "enabled" | "disabled" | "default";
	readonly aiProvider: "anthropic" | "jolli" | "local-agent";
	/** `"sonnet"` (the default) is stored as unset. */
	readonly model: string;
	readonly maxTokens?: number;
	/** May equal the mask the page was rendered with — then the stored key is kept. */
	readonly apiKey: string;
	readonly jolliApiKey: string;
	readonly localAgentTool: LocalAgentToolId;
	readonly localFolder: string;
	readonly compileExcludeFolders: string;
	readonly syncTranscripts: boolean;
	readonly dcoSignoff: boolean;
	readonly excludePatterns: string;
}

export interface SettingsApplyResult {
	readonly ok: true;
	readonly hookFailures: ReadonlyArray<HookSyncFailure>;
}

const AGENT_FIELDS = [
	"claudeEnabled",
	"codexEnabled",
	"geminiEnabled",
	"openCodeEnabled",
	"cursorEnabled",
	"devinEnabled",
	"copilotEnabled",
	"clineEnabled",
	"antigravityEnabled",
	"kimiEnabled",
] as const;

function asBool(v: unknown): boolean {
	return v === true;
}

function asString(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function splitCsv(v: string): ReadonlyArray<string> {
	return v
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * Coerces a raw POST body into a validated {@link SettingsApplyInput}. Throws
 * {@link SettingsValidationError} when the submission is structurally unusable
 * or would leave every AI agent disabled.
 */
export function parseSettingsApplyInput(body: Record<string, unknown>): SettingsApplyInput {
	const provider = body.aiProvider;
	if (provider !== "anthropic" && provider !== "jolli" && provider !== "local-agent") {
		throw new SettingsValidationError("aiProvider must be anthropic, jolli or local-agent");
	}
	const gi = body.globalInstructions;
	if (gi !== "enabled" && gi !== "disabled" && gi !== "default") {
		throw new SettingsValidationError("globalInstructions must be enabled, disabled or default");
	}
	const agents = Object.fromEntries(AGENT_FIELDS.map((f) => [f, asBool(body[f])])) as Record<
		(typeof AGENT_FIELDS)[number],
		boolean
	>;
	if (!AGENT_FIELDS.some((f) => agents[f])) {
		throw new SettingsValidationError("At least one AI agent must be enabled");
	}
	const maxTokensRaw = body.maxTokens;
	const maxTokens =
		typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
			? Math.floor(maxTokensRaw)
			: undefined;
	return {
		...agents,
		globalInstructions: gi,
		aiProvider: provider,
		model: asString(body.model) || "sonnet",
		...(maxTokens !== undefined ? { maxTokens } : {}),
		apiKey: asString(body.apiKey),
		jolliApiKey: asString(body.jolliApiKey),
		localAgentTool: (asString(body.localAgentTool) || "claude-code") as LocalAgentToolId,
		localFolder: asString(body.localFolder),
		compileExcludeFolders: asString(body.compileExcludeFolders),
		syncTranscripts: asBool(body.syncTranscripts),
		dcoSignoff: asBool(body.dcoSignoff),
		excludePatterns: asString(body.excludePatterns),
	};
}

/** What `applySettings`'s config transaction decided to do afterwards. */
interface WriteOutcome {
	readonly hookToggleChanged: boolean;
	readonly giChanged: boolean;
	readonly claudeEnabled: boolean;
	readonly geminiEnabled: boolean;
}

/** Verdict for a typed Memory Bank root. `empty` = unset (allowed). */
export type LocalFolderStatus = "empty" | "ok" | "relative" | "missing" | "not-a-dir" | "not-writable";

/**
 * Non-throwing, non-mutating validation of the typed Memory Bank root. It NEVER
 * creates anything: this field points at a folder that already exists, and
 * creating a brand-new bank is what "Migrate to Memory Bank" does — so a typo
 * must not silently spawn a directory. Feeds both the check-folder endpoint
 * (advisory blur feedback) and {@link ensureLocalFolder} (the save gate).
 */
export async function checkLocalFolder(localFolder: string): Promise<LocalFolderStatus> {
	const trimmed = localFolder.trim();
	if (!trimmed) return "empty";
	if (!isAbsolute(trimmed)) return "relative";
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(trimmed);
	} catch {
		return "missing";
	}
	if (!info.isDirectory()) return "not-a-dir";
	try {
		await access(trimmed, fsConstants.W_OK);
	} catch {
		return "not-writable";
	}
	return "ok";
}

const LOCAL_FOLDER_ERRORS: Record<Exclude<LocalFolderStatus, "ok" | "empty">, (p: string) => string> = {
	relative: (p) => `Folder path must be an absolute path (got "${p}").`,
	missing: (p) => `Folder "${p}" doesn't exist. Create it first, then save.`,
	"not-a-dir": (p) => `"${p}" already exists but is not a folder.`,
	"not-writable": (p) => `Folder "${p}" is not writable.`,
};

/**
 * Save-time gate: rejects anything {@link checkLocalFolder} does not clear as
 * "ok" or "empty", with a {@link SettingsValidationError} (→ 400). Deliberately
 * never creates the folder — see checkLocalFolder for why.
 */
async function ensureLocalFolder(localFolder: string): Promise<void> {
	const status = await checkLocalFolder(localFolder);
	if (status === "ok" || status === "empty") return;
	throw new SettingsValidationError(LOCAL_FOLDER_ERRORS[status](localFolder.trim()));
}

/**
 * Persists a submitted settings object, then reconciles side effects. Throws
 * {@link SettingsValidationError} on an invalid Jolli key (the transaction does
 * not write in that case, since the throw happens inside `decide`).
 */
export async function applySettings(
	input: SettingsApplyInput,
	configDir: string = getGlobalConfigDir(),
): Promise<SettingsApplyResult> {
	// Validate the Memory Bank folder BEFORE the config write, so a bad path throws
	// a 400 and nothing is persisted. Now that the path is a free-text field (the
	// folder browser was removed), this is the only guard against an unusable
	// localFolder reaching storage — and it never creates the folder, so a typo
	// can't silently spawn one.
	await ensureLocalFolder(input.localFolder);
	const outcome = await updateConfigTransactionalScoped<WriteOutcome>((current) => {
		// Mask reuse: an untouched key comes back equal to the mask we rendered,
		// so keep the stored full value; anything else is a genuine new key.
		const apiKey = input.apiKey === maskApiKey(current.apiKey) ? (current.apiKey ?? "") : input.apiKey;
		const jolliApiKey =
			input.jolliApiKey === maskApiKey(current.jolliApiKey) ? (current.jolliApiKey ?? "") : input.jolliApiKey;
		// Validate only a genuinely NEW key. Re-validating an untouched stored key
		// would let a key that predates the allowlist (or a tightened one) block
		// every unrelated save; and any validation failure must surface as a 400,
		// not the generic 500 an uncaught `assertJolliOriginAllowed` Error becomes.
		if (jolliApiKey && jolliApiKey !== current.jolliApiKey) {
			const meta = parseJolliApiKey(jolliApiKey);
			if (!meta) throw new SettingsValidationError("Rejected Jolli API key: it cannot be decoded.");
			try {
				assertJolliOriginAllowed(meta.u);
			} catch (err) {
				throw new SettingsValidationError(errMsg(err));
			}
		}
		const keyTenantUrl = resolveJolliUrlForKey(jolliApiKey);
		// gi tri-state: "default" leaves the field unset (never writes "disabled").
		const giUpdate: Partial<JolliMemoryConfig> =
			input.globalInstructions === "default" ? {} : { globalInstructions: input.globalInstructions };

		const update: Partial<JolliMemoryConfig> = {
			claudeEnabled: input.claudeEnabled,
			codexEnabled: input.codexEnabled,
			geminiEnabled: input.geminiEnabled,
			openCodeEnabled: input.openCodeEnabled,
			cursorEnabled: input.cursorEnabled,
			devinEnabled: input.devinEnabled,
			copilotEnabled: input.copilotEnabled,
			clineEnabled: input.clineEnabled,
			antigravityEnabled: input.antigravityEnabled,
			kimiEnabled: input.kimiEnabled,
			aiProvider: input.aiProvider,
			// "sonnet" is the default — stored as unset so the config stays minimal.
			model: input.model === "sonnet" ? undefined : input.model,
			// Unconditional (not a conditional spread) so clearing the field — which
			// parses to `undefined` — actually REMOVES the stored cap rather than
			// silently keeping the old value; JSON.stringify drops the undefined.
			maxTokens: input.maxTokens,
			// Empty string clears the key; a mask-equal submission reused the stored one above.
			apiKey: apiKey || undefined,
			jolliApiKey: jolliApiKey || undefined,
			localAgentTool: input.localAgentTool,
			localFolder: input.localFolder.trim() || undefined,
			compileExcludeFolders: splitCsv(input.compileExcludeFolders),
			syncTranscripts: input.syncTranscripts,
			dcoSignoff: input.dcoSignoff,
			excludePatterns: splitCsv(input.excludePatterns),
			...giUpdate,
			// Conditional spread — writing `jolliUrl: undefined` would DELETE a URL a
			// legacy key cannot replace. Absent means "leave the stored value alone".
			...(keyTenantUrl !== undefined ? { jolliUrl: keyTenantUrl } : {}),
		};

		const wasClaude = current.claudeEnabled !== false;
		const wasGemini = current.geminiEnabled !== false;
		const newGi = input.globalInstructions === "default" ? undefined : input.globalInstructions;
		return {
			update,
			result: {
				hookToggleChanged: wasClaude !== input.claudeEnabled || wasGemini !== input.geminiEnabled,
				giChanged: newGi !== undefined && newGi !== current.globalInstructions,
				claudeEnabled: input.claudeEnabled,
				geminiEnabled: input.geminiEnabled,
			},
		};
	}, configDir);

	// The config is ALREADY committed above. These reconciliation side effects run
	// after the durable write, so a throw here must NOT turn a successful save into
	// a 500 — collect problems and still report ok. (This also guards the iterator
	// sources inside syncAllReposHooks — listActiveRepos/existingWorktrees/
	// readManualDisableFlag — which are outside its per-repo try/catch.)
	const hookFailures: HookSyncFailure[] = [];
	// Machine-global — runs once, outside the per-repo loop.
	if (outcome.giChanged) {
		try {
			await syncGlobalInstructions();
		} catch (err) {
			log.warn("global-instructions sync failed after save: %s", errMsg(err));
		}
	}
	if (outcome.hookToggleChanged) {
		try {
			hookFailures.push(
				...(await syncAllReposHooks(
					{ claudeEnabled: outcome.claudeEnabled, geminiEnabled: outcome.geminiEnabled },
					configDir,
				)),
			);
		} catch (err) {
			log.warn("agent-hook sweep failed after save: %s", errMsg(err));
			hookFailures.push({ integration: "Claude", worktree: "(all repos)", cause: errMsg(err) });
		}
	}

	return { ok: true, hookFailures };
}

/**
 * Reconciles BOTH Claude and Gemini agent hooks to `settings` across EVERY
 * registered repo (skipping dashboard-disabled repos via `listActiveRepos`, and
 * any clone the user `jolli disable`d via `readManualDisableFlag`), then each
 * clone's worktrees. Granular per-agent install/remove (not a full `install()`),
 * the same body as VS Code's `syncHooks`, wrapped in the all-repos loop — so it
 * always drives both hooks to the config-desired state (idempotent), which is
 * why a flip of either agent runs the whole sweep. Failures are collected, never
 * thrown, so one bad repo does not abort the sweep.
 */
export async function syncAllReposHooks(
	settings: { readonly claudeEnabled: boolean; readonly geminiEnabled: boolean },
	configDir?: string,
): Promise<HookSyncFailure[]> {
	const failures: HookSyncFailure[] = [];
	for (const repo of await listActiveRepos(configDir)) {
		for (const cloneRoot of existingWorktrees(repo)) {
			// Per-clone user opt-out (`jolli disable`) — independent of the dashboard
			// registry's `disabledAt`. Skip: re-installing a hook the user disabled
			// would silently undo their opt-out.
			if (await readManualDisableFlag(cloneRoot)) continue;
			let worktrees: ReadonlyArray<string>;
			try {
				worktrees = await listWorktrees(cloneRoot);
			} catch {
				worktrees = [cloneRoot];
			}
			for (const wt of worktrees) {
				try {
					if (settings.claudeEnabled) await installClaudeHook(wt);
					else await removeClaudeHook(wt);
				} catch (err) {
					log.warn("failed to sync Claude hook for %s: %s", wt, errMsg(err));
					failures.push({ integration: "Claude", worktree: wt, cause: errMsg(err) });
				}
				try {
					if (settings.geminiEnabled) await installGeminiHook(wt);
					else await removeGeminiHook(wt);
				} catch (err) {
					log.warn("failed to sync Gemini hook for %s: %s", wt, errMsg(err));
					failures.push({ integration: "Gemini", worktree: wt, cause: errMsg(err) });
				}
			}
		}
	}
	return failures;
}

/**
 * Missing-summaries count for the server's launch repo — its own endpoint
 * because it runs `git rev-list HEAD` over the full history (too slow for the
 * page's first paint). Returns `null` when the cwd is not a git project (the
 * page then renders no count line).
 */
export async function countMissingForCwd(
	cwd: string,
): Promise<{ readonly missing: number; readonly total: number; readonly repoName: string } | null> {
	let repoRoot: string;
	try {
		repoRoot = await getProjectRootDir(cwd);
	} catch {
		return null;
	}
	const { countMissingSummaries } = await import("../backfill/BackfillEngine.js");
	// Carry the repo name so the panel can say "N of your commits in <repo>…"
	// (and highlight it), matching the VS Code Settings wording.
	return { ...(await countMissingSummaries(repoRoot)), repoName: extractRepoName(repoRoot) };
}
