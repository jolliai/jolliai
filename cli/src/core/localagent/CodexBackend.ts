import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { isPresent, resolveExecutable } from "./ExecutableResolver.js";
import { applyOptionalFlags, type OptionalFlag } from "./OptionalFlags.js";
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

/**
 * Shape of one line of the `codex exec --json` JSONL event stream, captured
 * from a real run (see `__fixtures__/codex/success.json`). Unlike the other
 * backends' single-envelope JSON, Codex emits one event object per line:
 * `thread.started` -> `turn.started` -> `item.completed` (the assistant
 * message, when `item.type === "agent_message"`) -> `turn.completed` (usage).
 * `usage` fields are snake_case, matching Claude Code's shape.
 *
 * A failed turn substitutes `error` + `turn.failed` for the last two events
 * (see `__fixtures__/codex/out-of-credits.json`), and the two carry the reason
 * in DIFFERENT places: `error` puts it in `message`, `turn.failed` nests it
 * under `error.message`.
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
	error?: { message?: string };
}

/** Longest failure reason carried into the thrown message. */
const MAX_REASON_CHARS = 300;

/**
 * Builds the error for a codex-reported failure, classified on the reason codex
 * itself gave.
 *
 * Deliberately never `LocalAgentSetupError`: that class alone drives LlmClient's
 * optional-flag degradation, and no run-time failure codex reports this way is
 * about argv — degrading would strip an isolation flag and hit the same wall.
 * See OptionalFlags.ts.
 */
function codexFailure(rawReason: string): Error {
	const reason = rawReason.slice(0, MAX_REASON_CHARS);
	return /log ?in|logged in|unauthori|authenticat/i.test(reason)
		? new LocalAgentAuthError(`Codex auth error: ${reason}`)
		: new LocalAgentTransientError(`Codex run failed: ${reason}`);
}

/** Exported so the install-location rules can be asserted per platform in tests. */
export const CODEX_SPEC = {
	binName: "codex",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32"
			? [pathWin32.join(home, ".local", "bin", "codex.exe")]
			: [pathPosix.join(home, ".local/bin/codex")],
	probeArgs: ["--version"] as const,
} as const;

/**
 * Plugin isolation as a droppable unit. The id is `--disable` alone, not
 * `--disable plugins`: clap names only the unrecognised TOKEN, so an older codex
 * reports `unexpected argument '--disable' found` and that is what has to match.
 * Dropping it takes the feature name with it, since a bare `--disable` would
 * then swallow the prompt as its value.
 *
 * A codex new enough for `--disable` but missing the `plugins` feature fails
 * differently — `Error: Unknown feature flag: plugins`, exit 1 (measured) — which
 * `attributeUnsupportedFlag` also matches, via the `unknown feature flag`
 * phrasing, so both vintages degrade to the same place.
 */
const CODEX_OPTIONAL_FLAGS: readonly OptionalFlag[] = [
	{
		id: "--disable",
		args: ["--disable", "plugins"],
		// The unknown-FEATURE failure never writes `--disable`, so the id alone
		// would miss it. Matched as a full phrase — a bare "plugins" would indict
		// this flag for any message that merely mentions the word.
		matches: ["--disable", "Unknown feature flag: plugins"],
	},
];

export class CodexBackend implements LocalAgentBackend {
	readonly id = "codex";
	readonly optionalFlags = CODEX_OPTIONAL_FLAGS;

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(CODEX_SPEC, { overridePath }));
	}

	isPresent(overridePath?: string): boolean {
		return isPresent(CODEX_SPEC, { overridePath });
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.OPENAI_API_KEY;
		delete env.OPENAI_BASE_URL;
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh empty cwd, same rationale as ClaudeCodeBackend: isolate the run
		// from the repo. Also passed via -C below, since codex exec resolves
		// relative paths / repo context off its working directory.
		const cwd = createLocalAgentCwd();
		// codex exec has no separate system-prompt flag, so it is prepended to
		// the user prompt (confirmed via --help).
		const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const args = [
			...(exe.launchArgs ?? []), // interpreter args when `exe.file` is a launcher, not the CLI itself
			"exec",
			"--json",
			"--skip-git-repo-check",
			"-s",
			"read-only",
			"-C",
			cwd,
			// Plugin isolation — this is a pure text completion, so the user's Codex
			// plugins (and the skills they carry) have nothing to contribute and are
			// pure prompt weight. `--disable plugins` is sugar for
			// `-c features.plugins=false`, a real stable feature flag (`codex features
			// list`).
			//
			// Verified on 0.146.0-alpha.3 by diffing `RUST_LOG=info` stderr, which is
			// where codex prints its own authoritative session state:
			//   baseline           plugins_enabled=true,  4x codex_core_{plugins,skills} WARN, model=gpt-5.4
			//   --disable plugins  no plugins_enabled line, 0 loader WARN,                     model=gpt-5.4
			//
			// Two things that look right and are NOT:
			//
			// 1. `-c plugins={}` / `-c mcp_servers={}` — accepted, and a complete
			//    no-op. `-c` is a dotted-path SET that MERGES; handing it an empty
			//    inline table merges nothing. Measured: both entries still loaded,
			//    byte-identical stderr state. Do not reintroduce them. (A scalar
			//    dotted path like `features.plugins=false` does work — that is the
			//    difference.) Judging this by whether an incidental MCP transport
			//    error disappeared is what previously made it look verified; grep
			//    `mcp_servers="…"` and `plugins_enabled=` instead.
			//
			// 2. `--ignore-user-config` — genuinely drops the user's MCP servers
			//    (measured: 5 entries collapse to the built-in `codex_apps`) but ALSO
			//    drops everything else in `$CODEX_HOME/config.toml`, including
			//    `model`: gpt-5.4 → gpt-5.6-sol on the same machine. LlmClient sends
			//    codex an EMPTY model on purpose (no `-m` below), so codex resolves it
			//    from that file and ignoring the file silently changes which model
			//    writes every summary.
			//
			// So the user's MCP servers stay booted here: codex exposes no lever that
			// drops them without also dropping the model choice. Same trade-off, and
			// same conclusion, as OpenCodeBackend.
			//
			// Emitted through the optional-flag filter so a codex too old for
			// `--disable` (or for the `plugins` feature) loses the isolation rather
			// than failing the call outright.
			...applyOptionalFlags(CODEX_OPTIONAL_FLAGS, req.disabledFlagIds),
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
		// First reason seen on an `error`-ish event. Held rather than thrown: see
		// the branch below for why only `turn.failed` is fatal on sight.
		let failureReason: string | undefined;
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
			// Failure handling, split by how DEFINITIVE the event is. Both read the
			// reason off the EVENT, never off the assistant text, which is free-form
			// and routinely contains the word "error".
			//
			// `turn.failed` is codex declaring the turn over with no assistant
			// message, so it throws on sight. An `error`-typed event is only a
			// CANDIDATE reason: codex emits these for conditions it may recover from
			// (a dropped model stream it then retries), and the failing run in
			// `__fixtures__/codex/out-of-credits.json` follows its `error` with a
			// `turn.failed` anyway. Throwing on the first one would turn a recovered
			// run into a hard failure while protecting nothing extra — a stream that
			// errors and produces no text still throws, from the post-loop check.
			//
			// Some failure MUST throw here: not doing so is what made an exhausted
			// workspace silent. The stream stays well-formed JSONL, so the `sawEvent`
			// guard below never fires; the old auth regex was the only failure check
			// and "out of credits" names no login word, so parseResult returned
			// text:"" and the caller stored an empty summary over a good one.
			if (type === "turn.failed") {
				throw codexFailure(ev.message ?? ev.error?.message ?? trimmed);
			}
			if (/error/i.test(type)) {
				// First one wins: the earliest reason is the root cause, and a later
				// event is likelier to be a cascade from it.
				failureReason ??= ev.message ?? ev.error?.message ?? trimmed;
				continue;
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
		// An `error` event that was never followed by a `turn.failed` AND never
		// followed by an assistant message: the run produced nothing, so it failed,
		// and this reason is the only explanation available. (`LlmClient` also
		// rejects an empty completion from any tool, but only generically — this is
		// what puts codex's own words in front of the user.) Text present means
		// codex recovered, and the error event is dropped on the floor.
		if (failureReason !== undefined && text.trim() === "") {
			throw codexFailure(failureReason);
		}
		return { text, inputTokens, outputTokens, cachedTokens, costUsd: 0, stopReason: null };
	}
}
