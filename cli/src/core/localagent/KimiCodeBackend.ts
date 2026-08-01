import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { isPresent, resolveExecutable } from "./ExecutableResolver.js";
import {
	type Invocation,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	type ResolvedExecutable,
} from "./Types.js";

/**
 * Backend for Moonshot AI's Kimi Code CLI (`kimi`, package `@kimi-code/cli`).
 *
 * Structurally a twin of {@link CodexBackend}, with two deliberate choices:
 *
 * 1. **No `expandShim`.** Kimi's *recommended* install is the official script,
 *    which drops a native `kimi` binary straight onto PATH (a real `.exe` on
 *    Windows) — so `where kimi` / a `.exe` known-path already yields a spawnable
 *    target and no shim resolution is needed, exactly like Codex. The npm install
 *    (`npm i -g @kimi-code/cli`) would instead leave `.cmd`/extensionless shims on
 *    Windows that `discover` filters out; those users fall back to the standalone
 *    installer or an explicit `localAgentPath`. Wiring an `expandShim` for the npm
 *    layout is deferred until a real `where kimi` capture pins the scoped-package
 *    bin path — this file follows the codebase's "pinned to a real install" rule
 *    rather than guessing `@kimi-code/cli`'s bin shape.
 *
 * 2. **One-shot prompt via `-p/--prompt` + `--output-format stream-json`.** Pinned
 *    to the real `kimi --help` / captured runs (kimi-code v0.31.1): `-p, --prompt
 *    <prompt>` runs one prompt non-interactively. There is NO `--quiet`, NO
 *    `--print`, and NO `run` subcommand (those belong to the *other*, unrelated
 *    `moonshotai/kimi-cli` product, not the installed `@kimi-code/cli`); and
 *    `--auto` is rejected in prompt mode ("Cannot combine --prompt with --auto"),
 *    which is fine — `-p` is already a single non-interactive turn with no
 *    tool-approval prompt to block on. The DEFAULT `text` output is NOT machine-
 *    parseable: it prefixes the answer and the model's *reasoning* with `• `
 *    bullets and appends a `To resume this session: kimi -r …` trailer, all of
 *    which would pollute the summary. `stream-json` instead emits clean JSONL —
 *    one `{"role":"assistant","content":…}` line (reasoning suppressed) plus a
 *    `{"role":"meta",…}` resume-hint line we ignore — so `parseResult` recovers
 *    exactly the assistant text, Codex-style. Token/cost accounting is not carried
 *    in that stream, so it is reported as zero (the same gap OpenCode/Cursor have).
 */

/**
 * Install locations to check directly, for when `kimi` is not on the search PATH.
 * Exported and platform-parameterized (like `cursorKnownPaths`) so both branches
 * are unit-testable without a host-platform dependency. Joins with
 * `path.win32` / `path.posix` matching the `platform` argument — never the host
 * `path` — so a `platform`-pinned test yields the same string on any host.
 */
export function kimiKnownPaths(home: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") return [pathPosix.join(home, ".local/bin/kimi")];
	return [
		// The official install script's own location, plus the common
		// `~/.local/bin` a script-based installer often uses.
		pathWin32.join(home, ".kimi-code", "bin", "kimi.exe"),
		pathWin32.join(home, ".local", "bin", "kimi.exe"),
	];
}

const KIMI_SPEC = {
	binName: "kimi",
	knownPaths: kimiKnownPaths,
	probeArgs: ["--version"] as const,
} as const;

export class KimiCodeBackend implements LocalAgentBackend {
	readonly id = "kimi";

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(KIMI_SPEC, { overridePath }));
	}

	isPresent(overridePath?: string): boolean {
		return isPresent(KIMI_SPEC, { overridePath });
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		// Force the subscription login (`kimi login`), never proxy through a leaked
		// API key — same first-party pattern as Claude Code / Codex / Cursor. Kimi's
		// own account OAuth is what `localAgentToolLoginHint` points the user at.
		delete env.MOONSHOT_API_KEY;
		delete env.MOONSHOT_BASE_URL;
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run from
		// the repo (kimi reads project context / AGENTS.md off its working directory).
		const cwd = createLocalAgentCwd();
		// kimi prompt mode has no separate system-prompt flag, so it is prepended to
		// the user prompt — same as Codex / Cursor / OpenCode.
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [
			...(exe.launchArgs ?? []), // interpreter args when `exe.file` is a launcher, not the CLI itself
			// `--model` (= -m) is honored only when set; non-claude tools pass an empty
			// model, so kimi then falls back to its own `default_model` from config.toml.
			...(req.model ? ["--model", req.model] : []),
			// JSONL, not the default `text` (which bullets the reasoning and appends a
			// resume-session trailer — see the header). parseResult reads the assistant line.
			"--output-format",
			"stream-json",
			// `--prompt` (= -p): run one prompt non-interactively. Must be last — its
			// value is the prompt.
			"--prompt",
			prompt,
		];
		// The prompt is the value of --prompt, not stdin.
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	parseResult(stdout: string): LocalAgentOutcome {
		// stream-json is JSONL: one object per line. The assistant's answer is the
		// `{"role":"assistant","content":…}` line(s); a `{"role":"meta",…}`
		// resume-hint line trails and is ignored. Take the LAST non-empty assistant
		// content so a final answer wins over anything earlier, and non-JSON noise
		// lines are skipped. No token/cost fields are carried in this stream, so they
		// are reported as zero. Real failures (not signed in / "No model configured",
		// provider errors) surface on STDERR with empty stdout; the runner rejects a
		// nonzero exit with no stdout as a LocalAgentSetupError (carrying the stderr
		// tail) before this runs — so an empty/assistant-less stdout is the only
		// failure signal here (no separate auth classification, same as opencode).
		let text = "";
		for (const line of stdout.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let obj: { role?: string; content?: string };
			try {
				obj = JSON.parse(trimmed) as { role?: string; content?: string };
			} catch {
				continue;
			}
			if (obj.role === "assistant" && typeof obj.content === "string" && obj.content) text = obj.content;
		}
		if (!text) {
			throw new LocalAgentSetupError(
				`Kimi produced no assistant output (first 200 chars): ${stdout.slice(0, 200)}`,
			);
		}
		return { text, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, stopReason: null };
	}
}
