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
 * Shape of the `cursor-agent -p --output-format json` result envelope,
 * captured from a real run (see `__fixtures__/cursor-agent/success.json`).
 * `usage` fields are camelCase — distinct from Claude Code's snake_case.
 */
interface CursorEnvelope {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}

const CURSOR_SPEC = {
	binName: "cursor-agent",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32" ? [join(home, ".local/bin/cursor-agent.exe")] : [join(home, ".local/bin/cursor-agent")],
	probeArgs: ["--version"] as const,
} as const;

export class CursorAgentBackend implements LocalAgentBackend {
	readonly id = "cursor-agent";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(CURSOR_SPEC, { overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.CURSOR_API_KEY; // force subscription login, never proxy through a leaked API key
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo (and, for cursor-agent specifically, from its Workspace
		// Trust prompt over an unfamiliar directory — see --trust below).
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		// cursor-agent has no separate system-prompt flag in headless mode, so the
		// system prompt is prepended to the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [
			"-p",
			"--output-format",
			"json",
			// Required: the fresh temp cwd above trips cursor-agent's Workspace
			// Trust gate otherwise (confirmed via probe). This is the real
			// "Trust the current workspace without prompting" flag, not
			// -f/--yolo (which governs command execution approval, not trust).
			"--trust",
			...(req.model ? ["--model", req.model] : []),
			prompt,
		];
		// The prompt is a positional arg, not stdin, in headless mode.
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let env: CursorEnvelope;
		try {
			env = JSON.parse(stdout) as CursorEnvelope;
		} catch {
			throw new LocalAgentSetupError(
				`Could not parse Cursor output as JSON (first 200 chars): ${stdout.slice(0, 200)}`,
			);
		}
		if (env.is_error) {
			const detail = env.result ?? env.subtype ?? "unknown";
			const msg = `Cursor returned an error: ${detail}`;
			if (
				/log ?in|logged in|unauthori|authenticat|not_logged_in/i.test(detail) ||
				/auth/i.test(env.subtype ?? "")
			) {
				throw new LocalAgentAuthError(msg);
			}
			throw new LocalAgentSetupError(msg);
		}
		const usage = env.usage ?? {};
		return {
			text: env.result ?? "",
			inputTokens: usage.inputTokens ?? 0,
			outputTokens: usage.outputTokens ?? 0,
			cachedTokens: (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
			costUsd: 0, // no cost field in the cursor-agent envelope
			stopReason: env.subtype ?? null,
		};
	}
}
