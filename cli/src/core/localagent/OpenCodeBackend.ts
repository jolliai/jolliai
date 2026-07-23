import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { LOCAL_AGENT_TMP_PREFIX } from "./ClaudeCodeBackend.js";
import { resolveExecutable } from "./ExecutableResolver.js";
import {
	type Invocation,
	LocalAgentAuthError,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	type ResolvedExecutable,
} from "./Types.js";

/**
 * Longest output we will still consider an auth-failure *line* rather than a
 * real summary. opencode prints the assistant's answer straight to stdout with
 * no envelope, and a compliant structured summary is always far longer than a
 * one-line "not logged in" error, so the length gate is what keeps a genuine
 * summary — which in THIS repo can itself mention "login" / "auth" — from being
 * misread as an auth failure.
 */
const OPENCODE_AUTH_LINE_MAX_LEN = 400;

/**
 * Auth/credential vocabulary opencode is likely to print when it cannot reach a
 * provider. HEURISTIC — opencode exposes no structured error, and no
 * logged-out fixture has been captured yet (run `scripts/probe-local-agents.mjs`
 * signed out to ground this). Paired with the length gate above so the false
 * positive surface is a short answer that merely mentions auth, which for our
 * structured-summary prompt is negligible.
 */
const OPENCODE_AUTH_SIGNAL =
	/log\s?in|logged\s?in|sign\s?in|not_logged_in|unauthori[sz]ed|unauthenticated|authenticat|no\s+provider|(invalid|missing|expired)\s+api\s?key|credential/i;

/**
 * True when stdout looks like an opencode auth failure rather than a summary.
 * Conservative by construction (see the two constants above): a miss simply
 * falls back to today's behaviour — the text is returned, or the runner has
 * already thrown a generic setup error on empty-stdout — so there is no
 * regression, only a possibly-missed classification.
 */
function looksLikeOpenCodeAuthError(text: string): boolean {
	return text.length <= OPENCODE_AUTH_LINE_MAX_LEN && OPENCODE_AUTH_SIGNAL.test(text);
}

const OPENCODE_SPEC = {
	binName: "opencode",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32" ? [join(home, ".local/bin/opencode.exe")] : [join(home, ".local/bin/opencode")],
	probeArgs: ["--version"] as const,
} as const;

export class OpenCodeBackend implements LocalAgentBackend {
	readonly id = "opencode";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(OPENCODE_SPEC, { overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		// BYOK: do NOT scrub provider credentials — OpenCode uses its own stored
		// auth (~/.local/share/opencode/auth.json) or env-provided provider keys.
		// Scrubbing would break env-key logins.
		const env: NodeJS.ProcessEnv = { ...process.env };
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo (opencode reads AGENTS.md from its cwd).
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		// opencode run has no separate system-prompt flag, so it is prepended to
		// the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = ["run", ...(req.model ? ["--model", req.model] : []), prompt];
		// The prompt is a positional arg, not stdin.
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		// opencode run has no structured-output flag (only --print-logs /
		// --log-level) — it prints the assistant's answer directly to stdout with
		// no envelope. So there is no cost/token accounting available here.
		const text = stdout.trim();
		if (!text) throw new LocalAgentSetupError("OpenCode produced no output.");
		// opencode has no result envelope, so unlike the other backends it can
		// only recognise an auth failure heuristically from the printed text.
		// Classify it into a LocalAgentAuthError (→ "local-agent-auth" marker →
		// sign-in remediation) instead of silently persisting the error line as a
		// commit summary. See looksLikeOpenCodeAuthError for the false-positive
		// safeguards.
		if (looksLikeOpenCodeAuthError(text)) {
			throw new LocalAgentAuthError(`OpenCode auth error: ${text.slice(0, 200)}`);
		}
		return { text, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null };
	}
}
