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
 * Shape of one line of the `codex exec --json` JSONL event stream, captured
 * from a real run (see `__fixtures__/codex/success.json`). Unlike the other
 * backends' single-envelope JSON, Codex emits one event object per line:
 * `thread.started` -> `turn.started` -> `item.completed` (the assistant
 * message, when `item.type === "agent_message"`) -> `turn.completed` (usage).
 * `usage` fields are snake_case, matching Claude Code's shape.
 */
interface CodexEvent {
	type?: string;
	item?: { id?: string; type?: string; text?: string };
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cached_input_tokens?: number;
	};
	message?: string;
}

const CODEX_SPEC = {
	binName: "codex",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32" ? [join(home, ".local/bin/codex.exe")] : [join(home, ".local/bin/codex")],
	probeArgs: ["--version"] as const,
} as const;

export class CodexBackend implements LocalAgentBackend {
	readonly id = "codex";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(CODEX_SPEC, { overridePath }));
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.OPENAI_API_KEY;
		delete env.OPENAI_BASE_URL;
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo. Also passed via -C below, since codex exec resolves
		// relative paths / repo context off its working directory.
		const cwd = mkdtempSync(join(tmpdir(), LOCAL_AGENT_TMP_PREFIX));
		// codex exec has no separate system-prompt flag, so it is prepended to
		// the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [
			"exec",
			"--json",
			"--skip-git-repo-check",
			"-s",
			"read-only",
			"-C",
			cwd,
			...(req.model ? ["-m", req.model] : []),
			prompt,
		];
		// The prompt is a positional arg, not stdin.
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		let text = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let cachedTokens = 0;
		let sawEvent = false;
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let ev: CodexEvent;
			try {
				ev = JSON.parse(trimmed) as CodexEvent;
			} catch {
				continue;
			}
			sawEvent = true;
			const type = ev.type ?? "";
			const haystack = `${type} ${ev.message ?? ""}`;
			if (/error/i.test(haystack) && /log ?in|logged in|unauthori|authenticat/i.test(haystack)) {
				throw new LocalAgentAuthError(`Codex auth error: ${trimmed.slice(0, 200)}`);
			}
			// Only item.completed agent_message events carry the final assistant
			// text; turn.completed has no `item`, so guard against blanking a
			// text already captured from an earlier item.completed event.
			if (type === "item.completed" && ev.item?.type === "agent_message") {
				const t = ev.item.text;
				if (t) text = t;
			}
			if (type === "turn.completed" && ev.usage) {
				inputTokens = ev.usage.input_tokens ?? inputTokens;
				outputTokens = ev.usage.output_tokens ?? outputTokens;
				cachedTokens = ev.usage.cached_input_tokens ?? cachedTokens;
			}
		}
		if (!sawEvent) {
			throw new LocalAgentSetupError(`Codex produced no JSONL events (first 200 chars): ${stdout.slice(0, 200)}`);
		}
		return { text, inputTokens, outputTokens, cachedTokens, costUsd: 0, stopReason: null };
	}
}
