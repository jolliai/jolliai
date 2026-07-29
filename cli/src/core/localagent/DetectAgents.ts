/**
 * Local-agent detection for onboarding surfaces.
 *
 * Two questions, deliberately separated by cost:
 *
 * - {@link listPresentLocalAgents} — "which tools are on disk?" Pure filesystem
 *   work, no subprocess at all (see `discoverPresence`), measured at ~4 ms for
 *   all four. Cheap enough to run on the VS Code activation path before first
 *   paint.
 * - {@link isLocalAgentUsable} — "does THIS tool actually run?" Spawns the
 *   capability probe; measured 161-1772 ms for a single tool. Called only once
 *   the user has committed to a specific tool.
 *
 * A full four-tool usability sweep costs 3384 ms on a machine with everything
 * installed, which is why onboarding never does one.
 */
import type { JolliMemoryConfig, LocalAgentToolId } from "../../Types.js";
import { getBackend } from "./BackendRegistry.js";
// Side-effect import: populates the registry that getBackend reads.
import "./BuiltinBackends.js";
import { LOCAL_AGENT_TOOLS } from "./ToolMeta.js";

/** One locally-installed agent tool, as offered to the user. */
export interface DetectedAgent {
	readonly id: LocalAgentToolId;
	readonly label: string;
}

/**
 * An explicit executable path, bound to the ONE tool it describes.
 *
 * `config.localAgentPath` overrides discovery for the *configured* tool only, so
 * it can never be handed to a multi-tool sweep as a bare string: on POSIX an
 * override short-circuits enumeration to the verbatim path, which would report
 * every tool present at that one file — a Codex path making Claude Code, Cursor
 * and OpenCode all "installed", and then each of them probed with Codex's
 * binary. Pairing the path with its `tool` makes that mistake unrepresentable.
 */
export interface LocalAgentOverride {
	readonly tool: LocalAgentToolId;
	readonly path: string;
}

/**
 * The tool-scoped override a config implies, or `undefined` when there is no
 * explicit path to apply. An unset `localAgentTool` falls back to
 * `"claude-code"`, matching every other reader of that field (GenerationFix,
 * StatusTreeProvider, SummaryUtils) and covering configs written before it
 * existed.
 *
 * The pairing is a re-derivation, not a stored fact: config.json holds the path
 * WITHOUT its owner, so this function can only assume the path belongs to the
 * currently-configured tool. What makes that assumption true is
 * `saveConfigScoped`, which clears an orphaned `localAgentPath` whenever
 * `localAgentTool` changes — see `dropOrphanedLocalAgentPath` in
 * `core/SessionTracker.ts`. Readers cannot detect the drift themselves.
 */
export function localAgentOverrideFrom(config: JolliMemoryConfig): LocalAgentOverride | undefined {
	if (!config.localAgentPath) return undefined;
	return { tool: config.localAgentTool ?? "claude-code", path: config.localAgentPath };
}

/** All tool ids in display order. LOCAL_AGENT_TOOLS is the ordering authority
 * for every user-facing list (the Settings dropdown already derives from it);
 * BackendRegistry registers in a different order and must not be used here. */
const TOOL_IDS = Object.keys(LOCAL_AGENT_TOOLS) as LocalAgentToolId[];

/**
 * Tools present on this machine, in display order. Never throws: a backend that
 * blows up is reported absent, because a detection failure must degrade to
 * "offer fewer options", never to a broken onboarding panel.
 *
 * `override` applies to its own `tool` and to no other — see
 * {@link LocalAgentOverride}.
 */
export function listPresentLocalAgents(override?: LocalAgentOverride): DetectedAgent[] {
	const found: DetectedAgent[] = [];
	for (const id of TOOL_IDS) {
		try {
			if (getBackend(id).isPresent(override?.tool === id ? override.path : undefined)) {
				found.push({ id, label: LOCAL_AGENT_TOOLS[id].label });
			}
		} catch {
			// Absent. See the docstring — never fail the sweep for one tool.
		}
	}
	return found;
}

/**
 * True when `tool` resolves to a runnable binary that accepts the flags we pass.
 * The registry-backed generalization of the former `isClaudeCodeUsable`, and the
 * seam tests mock so they never shell out to a real agent CLI.
 *
 * Still says nothing about whether the user is SIGNED IN to that tool — there is
 * no uniform auth probe. That failure surfaces at generation time and is what
 * `localAgentToolLoginHint` exists for.
 *
 * Takes a tool-scoped {@link LocalAgentOverride} rather than a bare path, and
 * applies it only when it names `tool`: probing Cursor with the path the user
 * configured for Codex would answer a question nobody asked (and, since an
 * override short-circuits discovery, would answer it wrongly in both
 * directions).
 */
export async function isLocalAgentUsable(
	tool: LocalAgentToolId,
	opts: { override?: LocalAgentOverride } = {},
): Promise<boolean> {
	try {
		await getBackend(tool).discoverExecutable(opts.override?.tool === tool ? opts.override.path : undefined);
		return true;
	} catch {
		return false;
	}
}
