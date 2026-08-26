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
import { LOCAL_AGENT_TOOLS, normalizeStoredLocalAgentModel } from "../core/localagent/ToolMeta.js";
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
	readonly hermesEnabled: boolean;
	readonly globalInstructions: "enabled" | "disabled" | "default";
	readonly aiProvider: "anthropic" | "jolli" | "local-agent";
	/** `"sonnet"` (the default) is stored as unset. */
	readonly model: string;
	readonly maxTokens?: number;
	/** May equal the mask the page was rendered with — then the stored key is kept. */
	readonly apiKey: string;
	readonly jolliApiKey: string;
	readonly localAgentTool: LocalAgentToolId;
	/** The submitted tool's OWN default is stored as unset, like `model`. */
	readonly localAgentModel: string;
	readonly localFolder: string;
	readonly compileExcludeFolders: string;
	readonly syncTranscripts: boolean;
	/**
	 * TRI-STATE, for the same reason as the two Advanced rows below: the Settings
	 * page no longer submits this field at all. Session-statistics sync is an
	 * IMMEDIATE switch now ({@link setSyncSessions} / `/api/settings/set-sync-sessions`),
	 * so every other switch in the Sync to Jolli tab behaves like the per-repo
	 * ones beside it. `undefined` therefore means "leave the stored value alone",
	 * and a two-state read here would have this save silently undo a toggle the
	 * user flipped moments earlier — including one flipped from an older page
	 * still submitting it.
	 */
	readonly syncSessions?: boolean;
	readonly dcoSignoff: boolean;
	readonly excludePatterns: string;
	/**
	 * Optional sidebar rows (Advanced). TRI-STATE, unlike every other boolean
	 * here: `undefined` means "leave the stored value alone".
	 *
	 * The others can safely be two-state because a page always submits the value
	 * it was rendered with, so overwriting one needs a genuinely concurrent edit.
	 * These two are different in kind — a page that PREDATES them submits nothing,
	 * and a two-state read would then have the server invent `false` and switch
	 * both rows off on a save that touched neither. That is reachable without any
	 * concurrency: `settings.js` is inlined into the page at load, so any tab left
	 * open across a CLI upgrade is such a page, and Settings is a modal it can
	 * open without navigating. Same reasoning, and the same conditional spread, as
	 * `jolliUrl` in `applySettings`.
	 *
	 * Unticking a row still persists `false`, because the page always submits an
	 * explicit boolean for both (see `collect()` in `assets/js/settings.js`).
	 */
	readonly dashboardKnowledgeMenuEnabled?: boolean;
	readonly dashboardGraphMenuEnabled?: boolean;
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
	"hermesEnabled",
] as const;

function asBool(v: unknown): boolean {
	return v === true;
}

/**
 * `undefined` for anything that is not a boolean, so a caller can tell "absent"
 * from "present and false". A malformed value (the string `"on"` an HTML form
 * would send, say) is treated as absent rather than as `false`: keeping what is
 * stored is the safe answer to a submission we cannot read.
 */
function asOptionalBool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
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
	// Validate against the known tool ids like aiProvider/globalInstructions above —
	// an unchecked cast let a bad value through to config, only to explode later
	// inside summarization. `Object.keys().includes` (not `in`) so a prototype key
	// like "constructor" can't pass.
	const localAgentTool = asString(body.localAgentTool) || "claude-code";
	if (!Object.keys(LOCAL_AGENT_TOOLS).includes(localAgentTool)) {
		throw new SettingsValidationError(
			`localAgentTool must be one of: ${Object.keys(LOCAL_AGENT_TOOLS).join(", ")}`,
		);
	}
	// Deliberately NOT rejected the way localAgentTool is. A tool id decides which
	// binary runs, so a bad one has to stop the save; a model id is a dropdown
	// value that the runner clamps at read time anyway, and refusing the whole
	// submission over one would block a user whose stored value came from a newer
	// build from saving anything at all — including the setting that would fix it.
	const localAgentModel = asString(body.localAgentModel);
	const agents = Object.fromEntries(AGENT_FIELDS.map((f) => [f, asBool(body[f])])) as Record<
		(typeof AGENT_FIELDS)[number],
		boolean
	>;
	if (!AGENT_FIELDS.some((f) => agents[f])) {
		throw new SettingsValidationError("At least one AI agent must be enabled");
	}
	const syncSessions = asOptionalBool(body.syncSessions);
	const knowledgeMenu = asOptionalBool(body.dashboardKnowledgeMenuEnabled);
	const graphMenu = asOptionalBool(body.dashboardGraphMenuEnabled);
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
		localAgentTool: localAgentTool as LocalAgentToolId,
		localAgentModel,
		localFolder: asString(body.localFolder),
		compileExcludeFolders: asString(body.compileExcludeFolders),
		syncTranscripts: asBool(body.syncTranscripts),
		dcoSignoff: asBool(body.dcoSignoff),
		excludePatterns: asString(body.excludePatterns),
		// `asOptionalBool`, never `asBool` — see `SettingsApplyInput` for why these
		// three must be able to say "the submission did not mention me".
		...(syncSessions !== undefined ? { syncSessions } : {}),
		...(knowledgeMenu !== undefined ? { dashboardKnowledgeMenuEnabled: knowledgeMenu } : {}),
		...(graphMenu !== undefined ? { dashboardGraphMenuEnabled: graphMenu } : {}),
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
 * Settings → Sync to Jolli: flip the machine-wide session-statistics switch and
 * persist it right away, the way the per-repo push toggles beside it already do.
 *
 * It is its own endpoint rather than a field of the batched save because the two
 * kinds of control sat in one tab looking identical and behaving differently —
 * one switch took effect on the next click, its neighbours only after "Apply
 * Changes". The write is a one-field merge inside the config lock, so it cannot
 * clobber a concurrent save of the rest of the form. Returns the value that was
 * stored, which is what the page renders the checkbox from.
 */
export async function setSyncSessions(
	enabled: boolean,
	configDir: string = getGlobalConfigDir(),
): Promise<{ readonly syncSessions: boolean }> {
	await updateConfigTransactionalScoped(() => ({ update: { syncSessions: enabled }, result: undefined }), configDir);
	return { syncSessions: enabled };
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
			hermesEnabled: input.hermesEnabled,
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
			// One shared rule for what reaches disk, so this surface, the VS Code
			// panel and `configure --set` cannot disagree about the same intent.
			localAgentModel: normalizeStoredLocalAgentModel(input.localAgentTool, input.localAgentModel),
			localFolder: input.localFolder.trim() || undefined,
			compileExcludeFolders: splitCsv(input.compileExcludeFolders),
			syncTranscripts: input.syncTranscripts,
			dcoSignoff: input.dcoSignoff,
			// Conditional for the same reason as the two Advanced rows below: this
			// field has its own immediate endpoint and is normally absent here.
			...(input.syncSessions !== undefined ? { syncSessions: input.syncSessions } : {}),
			// Conditional, unlike every other boolean above — an absent field must
			// leave the stored row alone rather than switch it off. See
			// `SettingsApplyInput` for the failure this closes.
			...(input.dashboardKnowledgeMenuEnabled !== undefined
				? { dashboardKnowledgeMenuEnabled: input.dashboardKnowledgeMenuEnabled }
				: {}),
			...(input.dashboardGraphMenuEnabled !== undefined
				? { dashboardGraphMenuEnabled: input.dashboardGraphMenuEnabled }
				: {}),
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
 * registered repo, then each clone's worktrees. Two filters, same switch at two
 * granularities: `listActiveRepos` drops a row whose EVERY clone is switched off,
 * and the per-clone check below drops the individual clones of a row that is still
 * active because a sibling clone is on. Granular per-agent install/remove (not a full `install()`),
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
			// Per-clone opt-out. `listActiveRepos` can only answer for the identity as
			// a whole (a row survives while ANY clone is on), so the clones of a
			// surviving row still have to be asked one by one. Skip: re-installing a
			// hook the user disabled would silently undo their opt-out.
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
