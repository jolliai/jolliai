import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { type Candidate, isPresent, resolveExecutable, type ShimDeps } from "./ExecutableResolver.js";
import { applyOptionalFlags, type OptionalFlag } from "./OptionalFlags.js";
import {
	type Invocation,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	type ResolvedExecutable,
} from "./Types.js";

/**
 * Resolves an npm cmd-shim to the package's own binary. Pinned to a real install
 * (`where opencode` on Windows returns `C:\nvm4w\nodejs\opencode{,.cmd}`):
 *
 *   <npm prefix>\opencode.cmd  ->  <npm prefix>\node_modules\opencode-ai\bin\opencode.exe
 *
 * `opencode-ai` declares `"bin": {"opencode": "./bin/opencode.exe"}` — a native
 * binary, not a JS entry point — so no interpreter `launchArgs` are needed and
 * the result is spawned exactly like a PATH-discovered `.exe`.
 */
export function expandOpenCodeShim(shimPath: string, deps: ShimDeps): Candidate[] {
	const prefix = pathWin32.dirname(shimPath);
	const exe = pathWin32.join(prefix, "node_modules", "opencode-ai", "bin", "opencode.exe");
	return deps.exists(exe) ? [{ file: exe }] : [];
}

/** Exported so the install-location rules can be asserted per platform in tests. */
export const OPENCODE_SPEC = {
	binName: "opencode",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32"
			? [
					// The standalone installer's location, already a native binary.
					pathWin32.join(home, ".opencode", "bin", "opencode.exe"),
					pathWin32.join(home, ".local", "bin", "opencode.exe"),
				]
			: [pathPosix.join(home, ".local/bin/opencode")],
	probeArgs: ["--version"] as const,
	expandShim: expandOpenCodeShim,
} as const;

/**
 * `--pure` as a droppable unit — the one backend where the failure text is
 * useless. Measured: an opencode that does not know a flag prints its whole
 * yargs help to stderr and exits 1, naming nothing ("unknown"/"unrecognized"
 * appear nowhere), and that help is longer than the 2 KB stderr tail the runner
 * keeps, so even `Positionals:` is truncated before anyone can match on it.
 *
 * That is survivable only because degradation does not depend on attribution:
 * with nothing matched, `LlmClient` drops every optional flag at once, and this
 * list has exactly one entry. It stays a list so a second opencode flag would
 * inherit the same handling instead of needing a new mechanism.
 *
 * (`OPENCODE_DISABLE_CLAUDE_CODE` is deliberately NOT here: an unrecognised env
 * var is ignored by every version, so it cannot fail a run.)
 */
const OPENCODE_OPTIONAL_FLAGS: readonly OptionalFlag[] = [{ id: "--pure", args: ["--pure"] }];

export class OpenCodeBackend implements LocalAgentBackend {
	readonly id = "opencode";
	readonly optionalFlags = OPENCODE_OPTIONAL_FLAGS;
	/**
	 * The one backend that opts into recording a BLIND drop. Every other tool
	 * names the flag it rejected, so `LlmClient` treats "dropped everything and it
	 * then worked" as too weak to persist there (an unrelated flake would strip
	 * their isolation for good). opencode can never produce that evidence — see
	 * the note on OPENCODE_OPTIONAL_FLAGS — so without this it would re-probe
	 * `--pure` and burn one failed spawn on every single call, forever.
	 */
	readonly unnamedFlagFailures = true;

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(OPENCODE_SPEC, { overridePath }));
	}

	isPresent(overridePath?: string): boolean {
		return isPresent(OPENCODE_SPEC, { overridePath });
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		// BYOK: do NOT scrub provider credentials — OpenCode uses its own stored
		// auth (~/.local/share/opencode/auth.json) or env-provided provider keys.
		// Scrubbing would break env-key logins.
		const env: NodeJS.ProcessEnv = { ...process.env };
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// opencode implements Claude Code compatibility: it reads `~/.claude/CLAUDE.md`
		// and `.claude/skills` on top of its own config. For a pure text completion
		// that is dead prompt weight, and the empty temp cwd below does not dodge it
		// because the paths it reads are in HOME, not the cwd. Verified against a
		// real run: baseline logs `duplicate skill name … existing=<home>/.claude/
		// skills/context7-mcp/SKILL.md`; with this set the line is gone and the run
		// still succeeds.
		//
		// MCP servers are deliberately NOT disabled here. opencode's only lever is
		// `OPENCODE_CONFIG=<file>`, which replaces the user's whole config — and
		// `model` can live in that same file while LlmClient sends EVERY local-agent
		// tool an empty model (see `LlmClient.callLocalAgent`), so redirecting it
		// would silently change which model runs. Same trap as codex's
		// `--ignore-user-config`, where it is measured. Until opencode grows a
		// narrower flag, its MCP servers stay booted.
		env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo (opencode reads AGENTS.md from its cwd).
		const cwd = createLocalAgentCwd();
		// opencode run has no separate system-prompt flag, so it is prepended to
		// the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		// `--pure` = "run without external plugins". Its effect could not be shown on
		// the verification machine (only the `@opencode-ai/plugin` SDK is installed
		// there, so there was nothing for it to disable — hence no log delta), but it
		// is opencode's documented switch for exactly this intent and costs nothing
		// when no plugins are present. Emitted through the optional-flag filter: an
		// opencode too old for it exits 1 on argument parsing, which would otherwise
		// fail every summary.
		const args = [
			...(exe.launchArgs ?? []),
			"run",
			...applyOptionalFlags(OPENCODE_OPTIONAL_FLAGS, req.disabledFlagIds),
			...(req.model ? ["--model", req.model] : []),
			prompt,
		];
		// The prompt is a positional arg, not stdin.
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		// opencode run has no structured-output flag (only --print-logs /
		// --log-level) — it prints the assistant's answer directly to stdout with
		// no envelope. So there is no cost/token accounting available here.
		const text = stdout.trim();
		// opencode has no result envelope to classify errors from, and — verified by
		// running a logged-out `opencode run` forced onto the signed-out provider —
		// real provider/auth failures surface on STDERR with EMPTY stdout, never as a
		// parseable error line here. The runner already rejects a nonzero exit with no
		// stdout as a LocalAgentSetupError (carrying the stderr tail) before this runs,
		// so an empty stdout is the only failure signal this parser can act on. (An
		// earlier stdout auth-vocabulary heuristic was removed: against real opencode
		// output it could only ever false-positive on a short summary mentioning
		// "login"/"auth", never match a true failure.)
		if (!text) throw new LocalAgentSetupError("OpenCode produced no output.");
		return { text, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null };
	}
}
