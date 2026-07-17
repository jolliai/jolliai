import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { resolveClaudeExecutable } from "./ClaudeExecutableResolver.js";
import {
	type Invocation,
	LocalAgentAuthError,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	LocalAgentTransientError,
	type ResolvedExecutable,
} from "./Types.js";

/** Shape of the `--output-format json` result envelope we rely on. */
interface ClaudePrintEnvelope {
	is_error?: boolean;
	subtype?: string;
	api_error_status?: number | null;
	result?: string;
	stop_reason?: string | null;
	total_cost_usd?: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

/**
 * Env vars removed from the child so `claude` falls through to its own
 * keychain-stored subscription OAuth. A leaked ANTHROPIC_BASE_URL alone routes
 * `claude` to a third-party gateway with no creds; ANTHROPIC_API_KEY/AUTH_TOKEN
 * would bill the user's API instead of the subscription; a stale parent
 * CLAUDE_CODE_OAUTH_TOKEN or CLAUDECODE ("cannot launch inside another Claude
 * Code session") both break the spawn.
 */
const SCRUBBED_ENV_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDECODE",
] as const;

/**
 * Prefix for the temp cwd created below. Exported so `LlmClient.callLocalAgent`
 * can recognize (and safely clean up) only directories THIS backend created,
 * without duplicating the literal string.
 */
export const LOCAL_AGENT_TMP_PREFIX = "jolli-localagent-";

export class ClaudeCodeBackend implements LocalAgentBackend {
	readonly id = "claude-code";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveClaudeExecutable({ overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of SCRUBBED_ENV_VARS) delete env[key];
		// Mark the child (and everything IT spawns — hooks inherit env) as a
		// jollimemory-spawned agent, so jollimemory's own Claude integration
		// (SessionStart/Stop hooks, `jolli enable`, MCP storage init) no-ops
		// instead of re-entering against this throwaway temp cwd. See AgentReentry.
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd: `claude` auto-discovers a CLAUDE.md from cwd and folds
		// it into the system prompt. Running in the repo would inject the repo's
		// CLAUDE.md — polluting the summary and burning tokens. An empty temp dir
		// is the clean isolation (mirrors claude-mem's cwd jail). Removed again by
		// `LlmClient.callLocalAgent` once the run completes.
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		return {
			file: exe.file,
			// `--tools <tools...>` is an ALLOW-list. Passing a single empty string
			// yields the allow-list [""], which matches no real tool — i.e. every
			// tool is denied. This is a pure text completion; the agent must not
			// touch the filesystem or shell. (`--permission-mode dontAsk` is the
			// belt to this suspenders: even a would-be tool call never prompts.)
			args: [
				"-p",
				"--output-format",
				"json",
				"--model",
				req.model,
				"--system-prompt",
				req.systemPrompt,
				"--tools",
				"",
				"--permission-mode",
				"dontAsk",
				"--no-session-persistence",
			],
			stdin: req.prompt,
			env,
			cwd,
		};
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let env: ClaudePrintEnvelope;
		try {
			env = JSON.parse(stdout) as ClaudePrintEnvelope;
		} catch {
			throw new LocalAgentSetupError(
				`Could not parse Claude Code output as JSON (first 200 chars): ${stdout.slice(0, 200)}`,
			);
		}
		if (env.is_error) {
			const status = env.api_error_status ?? 0;
			const detail = env.result ?? env.subtype ?? "unknown";
			const msg = `Claude Code returned an error (status ${status}): ${detail}`;
			if (status === 401 || status === 403) throw new LocalAgentAuthError(msg);
			if (status === 429 || (status >= 500 && status < 600)) throw new LocalAgentTransientError(msg);
			// A not-signed-in failure in print+json mode surfaces as an is_error
			// envelope, sometimes WITHOUT an HTTP status (a local "run `claude` to
			// log in" rather than a proxied 401). Detect the stable auth phrasings
			// so the user gets sign-in guidance instead of a generic setup error.
			// Both classes are non-retryable, so a miss only degrades the message,
			// never the queue's retry decision.
			if (/log ?in|logged in|unauthori|authenticat|invalid api key/i.test(detail)) {
				throw new LocalAgentAuthError(msg);
			}
			throw new LocalAgentSetupError(msg);
		}
		const usage = env.usage ?? {};
		return {
			text: env.result ?? "",
			inputTokens: usage.input_tokens ?? 0,
			outputTokens: usage.output_tokens ?? 0,
			cachedTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
			costUsd: env.total_cost_usd ?? 0,
			stopReason: env.stop_reason ?? null,
		};
	}
}
