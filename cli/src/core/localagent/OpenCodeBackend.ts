import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { type Candidate, isPresent, resolveExecutable, type ShimDeps } from "./ExecutableResolver.js";
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

const OPENCODE_SPEC = {
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

export class OpenCodeBackend implements LocalAgentBackend {
	readonly id = "opencode";

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
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo (opencode reads AGENTS.md from its cwd).
		const cwd = createLocalAgentCwd();
		// opencode run has no separate system-prompt flag, so it is prepended to
		// the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [...(exe.launchArgs ?? []), "run", ...(req.model ? ["--model", req.model] : []), prompt];
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
