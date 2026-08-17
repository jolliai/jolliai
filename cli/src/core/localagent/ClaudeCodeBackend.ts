import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { isClaudeCodePresent, resolveClaudeExecutable } from "./ClaudeExecutableResolver.js";
import { applyOptionalFlags, type OptionalFlag } from "./OptionalFlags.js";
import {
	type Invocation,
	LocalAgentAuthError,
	type LocalAgentBackend,
	LocalAgentModelRefusedError,
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
	/**
	 * Per-model usage, keyed by the model id the CLI actually ran — the ONLY
	 * place the envelope names it. Captured from a real 2.1.220 run:
	 * `"modelUsage":{"claude-opus-5[1m]":{"outputTokens":4,…,"canonicalModel":"claude-opus-5"}}`.
	 * Note the inner fields are camelCase, unlike the snake_case `usage` above.
	 *
	 * We key off the map key rather than `canonicalModel` deliberately: the key
	 * keeps the context-window variant (`[1m]`), which is a distinct SKU at a
	 * distinct price, and the whole point of reading this is to stop guessing.
	 */
	modelUsage?: Record<string, { outputTokens?: number; inputTokens?: number; cacheReadInputTokens?: number } | null>;
}

/**
 * The model id from a `modelUsage` map, or undefined when the envelope carries
 * none (older CLI, or an error envelope — real runs emit `"modelUsage":{}`).
 *
 * This map is NOT single-entry, and assuming it was is what this function used to
 * get wrong. Measured on 2.1.212 with the full isolation set, a `--model sonnet`
 * run reports `{"claude-haiku-4-5-…":{outputTokens:12}, "claude-sonnet-5":{outputTokens:4}}`
 * — claude runs a small helper turn of its own, which we cannot switch off, and
 * when the real answer is short that helper OUT-PRODUCES it. Picking the
 * highest-output entry therefore named haiku for a sonnet run.
 *
 * The answering turn is identified by TOTAL INPUT, not by output and NOT by the
 * requested alias: it is the turn carrying the conversation prompt and its cache
 * (measured, sonnet 1 + 3289 cached against the helper's 523 + 0), while the
 * output column gets this exactly backwards. Every prompt this project sends is
 * thousands of tokens, so the answering turn always outweighs the helper.
 *
 * `requested` is ONLY a tie-breaker, and that restraint is the point. `LlmClient`
 * compares this value against the request to detect a model that was not
 * honoured, so preferring the requested alias outright would close a loop and
 * make the check tautological — it could then only fire when the alias appeared
 * nowhere at all. The scenario that exposes it: pin `haiku`, claude answers with
 * sonnet, and the un-suppressible helper turn runs haiku. Alias-first names the
 * HELPER, so nothing warns and a sonnet-written summary is recorded as haiku —
 * exactly the "stored metadata is not allowed to guess" rule, inverted.
 *
 * The tie-break still earns its place: an older CLI reports `outputTokens` only,
 * leaving every weight at 0, and there the requested alias is a better answer
 * than whichever key happened to come first.
 */
function pickModel(modelUsage: ClaudePrintEnvelope["modelUsage"], requested?: string): string | undefined {
	const needle = requested?.trim().toLowerCase() ?? "";
	let best: string | undefined;
	let bestWeight = -1;
	let bestMatched = false;
	for (const [id, usage] of Object.entries(modelUsage ?? {})) {
		const weight = (usage?.inputTokens ?? 0) + (usage?.cacheReadInputTokens ?? 0);
		const matched = needle !== "" && id.toLowerCase().includes(needle);
		// Heaviest input wins outright; the requested alias only breaks a tie.
		if (weight > bestWeight || (weight === bestWeight && matched && !bestMatched)) {
			best = id;
			bestWeight = weight;
			bestMatched = matched;
		}
	}
	return best;
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
 * The isolation block, as three independently droppable units.
 *
 * Each is a pure cost optimization (see the comment at the use site), so an
 * older `claude` that does not recognise one must lose only that one rather
 * than failing the call — `LlmClient` drops it and remembers. Kept in the same
 * order the arg vector used to hard-code, so a fully-supported CLI builds a
 * byte-identical command line.
 */
const CLAUDE_OPTIONAL_FLAGS: readonly OptionalFlag[] = [
	{ id: "--strict-mcp-config", args: ["--strict-mcp-config"] },
	{ id: "--disable-slash-commands", args: ["--disable-slash-commands"] },
	{ id: "--setting-sources", args: ["--setting-sources", ""] },
];

export class ClaudeCodeBackend implements LocalAgentBackend {
	readonly id = "claude-code";
	readonly optionalFlags = CLAUDE_OPTIONAL_FLAGS;

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveClaudeExecutable({ overridePath }));
	}

	isPresent(overridePath?: string): boolean {
		return isClaudeCodePresent({ overridePath });
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const key of SCRUBBED_ENV_VARS) delete env[key];
		// Mark the child (and everything IT spawns — hooks inherit env) as a
		// jollimemory-spawned agent, so jollimemory's own Claude integration
		// (SessionStart/Stop hooks, `jolli enable`, MCP storage init) no-ops
		// instead of re-entering against this throwaway temp cwd. See AgentReentry.
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// Fresh temp cwd carrying the re-entrancy sentinel — see createLocalAgentCwd
		// for why it must be empty of instruction files and why the env marker above
		// is not sufficient on its own. Removed by `LlmClient.callLocalAgent`.
		const cwd = createLocalAgentCwd();
		return {
			file: exe.file,
			// `--tools <tools...>` is an ALLOW-list. Passing a single empty string
			// yields the allow-list [""], which matches no real tool — i.e. every
			// tool is denied. This is a pure text completion; the agent must not
			// touch the filesystem or shell. (`--permission-mode dontAsk` is the
			// belt to this suspenders: even a would-be tool call never prompts.)
			args: [
				...(exe.launchArgs ?? []), // interpreter args when `exe.file` is a launcher, not the CLI itself
				"-p",
				"--output-format",
				"json",
				// Conditional, like every other backend: an empty model means "leave the
				// CLI's own configured default alone" (the `inherit` choice), and
				// `--model ""` would instead assert an empty selection.
				//
				// NOT an OptionalFlag, and that was tried: the degradation loop only
				// sees failures `run()` REJECTS with, while a refused model exits
				// nonzero having written its failure envelope to stdout, which the
				// runner deliberately resolves. So the entry was inert for the case it
				// existed for, and live for every case it did not — any unattributed
				// setup error would silently drop the pin. `LlmClient.callLocalAgent`
				// owns the one un-pinned retry instead.
				...(req.model ? ["--model", req.model] : []),
				"--system-prompt",
				req.systemPrompt,
				"--tools",
				"",
				"--permission-mode",
				"dontAsk",
				"--no-session-persistence",
				// Isolation block — the child must carry NOTHING of the user's own
				// Claude Code setup. `--tools ""` above only denies BUILT-IN tools;
				// without these three, `claude` still boots the user's MCP servers
				// (observed: `npm exec @playwright/mcp@latest`) and injects their tool
				// schemas, plus skills and settings-sourced content, into a prompt that
				// is forbidden from calling any tool.
				//
				// Measured on 2.1.220, same prompt, back-to-back:
				//   baseline  in=2 cache_create=4676 cache_read=3529 → 8,207 tok, $0.0486
				//   isolated  in=172 cache_create=0   cache_read=0   →   172 tok, $0.0015
				// i.e. ~48x fewer prompt tokens and ~32x cheaper. Count the cache
				// columns when re-measuring: most of the baseline weight sits in
				// cache_creation/cache_read, so reading `input_tokens` alone makes the
				// bloat look like ~2 tokens and the win look like a regression.
				//
				// These flags do not themselves change latency (per-call wall time is
				// dominated by output volume). Local-agent latency DID change in the
				// same commit that added them, but for an unrelated reason — dropping
				// `--model` moved runs onto the user's own default model; see
				// `LlmClient.callLocalAgent`.
				//
				// `--setting-sources ""` also stops user hooks firing in the child,
				// which reinforces the `AgentReentry` defenses (env sentinel + empty
				// temp cwd) rather than duplicating them.
				//
				// Deliberately NOT `--bare`, which reads like the perfect fit for this
				// block (it skips hooks, plugin sync, auto-memory and CLAUDE.md
				// discovery in one flag) but ALSO stops `claude` reading OAuth and the
				// keychain. Since SCRUBBED_ENV_VARS removes every API-key path on
				// purpose, keychain subscription auth is the only credential left, so
				// `--bare` fails every call outright: `is_error`, zero tokens,
				// "Not logged in · Please run /login". Verified, do not "simplify" to it.
				//
				// Emitted through the optional-flag filter so an older `claude` that
				// rejects one of them loses that flag, not every summary on the
				// machine. A CLI supporting all three gets the same vector as before.
				...applyOptionalFlags(CLAUDE_OPTIONAL_FLAGS, req.disabledFlagIds),
			],
			stdin: req.prompt,
			env,
			cwd,
		};
	}

	parseResult(stdout: string, requestedModel?: string): LocalAgentOutcome {
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
			// 404 from this envelope means the model, not the route: measured,
			// `--model bogus` answers `{"api_error_status":404,"result":"There's an
			// issue with the selected model (…)"}`. Classified by STATUS, never by
			// that phrasing — the wording is not a contract, the status is what the
			// other branches here already key on. Narrowing it out of the generic
			// setup error is what lets LlmClient retry un-pinned for this case and
			// this case only.
			if (status === 404) throw new LocalAgentModelRefusedError(msg);
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
		const model = pickModel(env.modelUsage, requestedModel);
		return {
			text: env.result ?? "",
			inputTokens: usage.input_tokens ?? 0,
			outputTokens: usage.output_tokens ?? 0,
			cachedTokens: (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
			costUsd: env.total_cost_usd ?? 0,
			stopReason: env.stop_reason ?? null,
			// Only set when the envelope actually named a model, so `LlmClient` can
			// tell "the CLI told us" from "assume the configured alias".
			...(model !== undefined && { model }),
		};
	}
}
