import { readFileSync } from "node:fs";
import { join, posix as pathPosix, win32 as pathWin32 } from "node:path";
import { createLogger } from "../../Logger.js";
import { createLocalAgentCwd, LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import { isPresent, resolveExecutable } from "./ExecutableResolver.js";
import type { OptionalFlag } from "./OptionalFlags.js";
import {
	type Invocation,
	type LocalAgentBackend,
	type LocalAgentOutcome,
	type LocalAgentRequest,
	LocalAgentSetupError,
	type ResolvedExecutable,
} from "./Types.js";

/**
 * Backend for Hermes Agent (NousResearch, `hermes`).
 *
 * Four decisions, each pinned to the installed CLI (v0.20.5) or to its source
 * rather than to the shape of a sibling backend:
 *
 * 1. **One-shot via `-z/--oneshot`.** Its own help states the contract this
 *    backend depends on: "send a single prompt and print ONLY the final response
 *    text to stdout. No banner, no spinner, no tool previews, no session_id
 *    line." So `parseResult` needs no envelope parsing at all — the cleanest
 *    stdout of the five tools.
 *
 * 2. **Isolation is `--ignore-rules`, never `--safe-mode`.** `--ignore-rules`
 *    skips the AGENTS.md / SOUL.md / memory / preloaded-skill injection, which is
 *    the token cost worth removing. `--safe-mode` looks stronger and is a trap:
 *    it *implies* `--ignore-user-config`, and a Hermes user's provider — including
 *    a `custom_providers` entry carrying the API key — lives in that config. It
 *    would take the user's credentials with it, which is the same trap
 *    `--ignore-user-config` set for the Codex backend. Declared optional so an
 *    older `hermes` that does not know the flag degrades instead of failing every
 *    summary on the machine.
 *
 * 3. **argv is the ONLY prompt channel, and that is measured, not assumed.**
 *    `-z` takes its value on the command line; there is no `--prompt-file` and no
 *    stdin path (`hermes_cli/oneshot.py` uses the string it was handed). The two
 *    file-shaped alternatives were both read out of Hermes' own source and are
 *    both too small for the ~400 KB worst-case `summarize` prompt: `read_file`
 *    truncates at `_DEFAULT_MAX_READ_CHARS = 100_000` (`tools/file_tools.py`) and
 *    an auto-injected `AGENTS.md` at `CONTEXT_FILE_MAX_CHARS = 20_000`
 *    (`agent/prompt_builder.py`). Either would silently deliver a fraction of the
 *    prompt and produce a confident, incomplete summary — strictly worse than the
 *    argv limit, which fails loudly. So the body rides argv and the backend
 *    refuses prompts the platform cannot carry losslessly; see
 *    {@link argvPromptBudget}.
 *
 * 4. **The model is NOT pinned.** `LOCAL_AGENT_TOOLS.hermes` declares no `models`
 *    list, so `resolveLocalAgentModel` yields `""` and no `-m` is emitted. Hermes
 *    model ids are `provider/model` pairs over a user-defined provider set (a
 *    machine can point `sub2api` at localhost), so any list shipped here would be
 *    a 400 on somebody's machine. The user's own `model.default` is the right
 *    answer and this backend defers to it — matching cursor-agent / opencode /
 *    kimi. The `requestedModel` parameter is therefore never populated for this
 *    tool, and `parseResult` reads the model Hermes REPORTS instead.
 */

const log = createLogger("HermesBackend");

/** Where `--usage-file` is written, inside the run's own throwaway cwd. */
const USAGE_FILE = "usage.json";

/**
 * Max UTF-8 prompt bytes passed as one argv item, by platform.
 *
 * Windows `CreateProcess` caps the whole command line at ~32,767 UTF-16 code
 * units, so 24 KB is a conservative cross-script ceiling with room for the
 * executable and other flags. Linux has a second, smaller limit that `ARG_MAX`
 * does not reveal: each individual argv string is capped by `MAX_ARG_STRLEN`
 * (normally 128 KiB). Keep 8 KiB of headroom there. macOS has no equivalent
 * 128-KiB per-item limit; its measured 1-MiB ARG_MAX can carry the ~400 KiB
 * worst-case summarize prompt, so use a 512-KiB prompt ceiling and leave the
 * other half for the environment, executable and remaining argv strings.
 *
 * Crossing the ceiling is a hard failure. A partial prompt can produce a
 * confident but incomplete memory and is therefore worse than preserving the
 * existing summary with an actionable error. It is deliberately NOT a file
 * channel — see decision 3 in the header for why both of Hermes' file routes are
 * smaller than this.
 */
export function argvPromptBudget(platform: NodeJS.Platform): number {
	if (platform === "win32") return 24_000;
	if (platform === "darwin") return 512 * 1024;
	return 120_000;
}

/**
 * Install locations to check directly, for when `hermes` is not on the search
 * PATH. Platform-parameterized (like `kimiKnownPaths`) so both branches are
 * unit-testable without a host-platform dependency, joining with
 * `path.win32` / `path.posix` to match the `platform` argument rather than the
 * host's — so a `platform`-pinned test yields the same string anywhere.
 *
 * `~/.local/bin/hermes` is where the documented installer puts it (verified on a
 * real v0.20.5 install). The Windows entries are the same layout under the
 * installer's own directory; they are a best guess and are why a Windows user
 * with a different layout falls back to `localAgentPath`.
 */
export function hermesKnownPaths(home: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") return [pathPosix.join(home, ".local/bin/hermes")];
	return [pathWin32.join(home, ".hermes", "bin", "hermes.exe"), pathWin32.join(home, ".local", "bin", "hermes.exe")];
}

const HERMES_SPEC = {
	binName: "hermes",
	knownPaths: hermesKnownPaths,
	probeArgs: ["--version"] as const,
} as const;

/**
 * `--ignore-rules` is optional across Hermes versions. `--usage-file` is not:
 * it is the only structured success/failure receipt, so dropping it would let a
 * failed run's diagnostic stdout masquerade as a valid summary.
 */
const HERMES_OPTIONAL_FLAGS: readonly OptionalFlag[] = [{ id: "--ignore-rules", args: ["--ignore-rules"] }];

/** The `--usage-file` report Hermes writes, per `hermes_cli/oneshot.py`. */
interface HermesUsageReport {
	readonly input_tokens?: unknown;
	readonly output_tokens?: unknown;
	readonly cache_read_tokens?: unknown;
	readonly cache_write_tokens?: unknown;
	readonly estimated_cost_usd?: unknown;
	readonly model?: unknown;
	readonly failed?: unknown;
	readonly failure?: unknown;
}

/** A finite non-negative number (or numeric string) from the usage report, or 0. */
function num(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim().length > 0
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export class HermesBackend implements LocalAgentBackend {
	readonly id = "hermes";
	readonly optionalFlags = HERMES_OPTIONAL_FLAGS;

	discoverExecutable(overridePath?: string): Promise<ResolvedExecutable> {
		return Promise.resolve(resolveExecutable(HERMES_SPEC, { overridePath }));
	}

	isPresent(overridePath?: string): boolean {
		return isPresent(HERMES_SPEC, { overridePath });
	}

	buildInvocation(exe: ResolvedExecutable, req: LocalAgentRequest): Invocation {
		const env: NodeJS.ProcessEnv = { ...process.env };
		env[LOCAL_AGENT_CHILD_ENV] = "1";
		// One-shot mode has no separate system-prompt flag, so it is prepended —
		// same as Codex / Cursor / OpenCode / Kimi. Validate before creating the
		// throwaway cwd so a rejected oversized prompt cannot leak a temp directory.
		const full = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
		const budget = argvPromptBudget(process.platform);
		const fullBytes = Buffer.byteLength(full, "utf8");
		if (fullBytes > budget) {
			throw new LocalAgentSetupError(
				`Hermes prompt is ${fullBytes} UTF-8 bytes, above this platform's ${budget}-byte argv budget. ` +
					"Hermes exposes no lossless prompt-file channel, so refusing to generate a partial summary.",
			);
		}
		// HERMES_HOME is deliberately INHERITED, not isolated: the user's provider,
		// credentials and model default live in that home, and pointing the child at
		// a scratch one would leave it with no way to reach a model at all.
		//
		// The cwd is still a fresh empty directory, same rationale as every other
		// backend: Hermes reads project context (AGENTS.md / .cursorrules) from its
		// working directory, and `--ignore-rules` is only best-effort here since it
		// is droppable by the degradation loop.
		const cwd = createLocalAgentCwd();
		const args = [
			...(exe.launchArgs ?? []), // interpreter args when `exe.file` is a launcher, not the CLI itself
			// Emitted only when a model is pinned. This tool declares no `models`
			// list, so in practice it never is — see decision 4 in the header.
			...(req.model ? ["--model", req.model] : []),
			...(req.disabledFlagIds?.has("--ignore-rules") ? [] : ["--ignore-rules"]),
			// Written even when the run fails, per Hermes' own contract. It is
			// load-bearing, not optional: stale persisted degradation state from an
			// earlier Jolli build must not be able to remove this receipt.
			"--usage-file",
			join(cwd, USAGE_FILE),
			"-z",
			full,
		];
		return { file: exe.file, args, stdin: "", env, cwd };
	}

	/**
	 * `cwd` is the run's own throwaway directory, which is where `--usage-file`
	 * put the report. It is the only way this backend can see that file: the
	 * report's path is minted per invocation in {@link buildInvocation}, and
	 * nothing else in the result carries it.
	 *
	 * An absent or malformed report is a failure. Hermes stdout has no envelope,
	 * and older versions can print failure text there; the report is therefore the
	 * only proof that accepting stdout is safe. The `failed` member itself is
	 * version-dependent: `true` is authoritative, `false` is explicit success, and
	 * absence means no failure was recorded. Some producers omit false-valued
	 * optional fields instead of serialising them.
	 */
	parseResult(stdout: string, _requestedModel?: string, cwd?: string): LocalAgentOutcome {
		const usage = cwd === undefined ? undefined : readUsageReport(join(cwd, USAGE_FILE));
		if (usage === undefined) {
			throw new LocalAgentSetupError(
				"Hermes did not produce a valid usage report; refusing unverified stdout that may describe a failed run.",
			);
		}

		// A run that produced no answer MUST throw: returning "" would let an empty
		// summary overwrite a good stored one, reported as success. Hermes' own
		// failure signal is `failed: true` in the report (written even when the run
		// dies), so it is preferred over the generic empty-stdout message — it
		// carries the reason, which the stored summary has nowhere to keep.
		const text = stdout.trim();
		const failureReason =
			typeof usage.failure === "string" && usage.failure.trim().length > 0 ? usage.failure : undefined;
		if (usage.failed === true || failureReason !== undefined) {
			const reason = failureReason ?? "no reason reported";
			throw new Error(`Hermes reported a failed run: ${reason}`);
		}
		if (usage.failed !== undefined && usage.failed !== false) {
			throw new LocalAgentSetupError(
				"Hermes usage report contained a non-boolean failure status; refusing unverified stdout.",
			);
		}
		if (!text) {
			// `LocalAgentSetupError` deliberately: a `-z` run that writes nothing at
			// all has not started properly (not signed in, no model configured, a
			// provider that refused), which is the class the runner already reports
			// with its stderr tail. A run that DID start and then failed is the
			// `failed: true` branch above, which is not a setup error.
			throw new LocalAgentSetupError(
				`Hermes produced no output (first 200 chars of stdout): ${stdout.slice(0, 200)}`,
			);
		}

		return {
			text,
			inputTokens: num(usage.input_tokens),
			outputTokens: num(usage.output_tokens),
			// Hermes splits its cache accounting in two; the outcome carries one
			// `cachedTokens`, so both halves are summed into it.
			cachedTokens: num(usage.cache_read_tokens) + num(usage.cache_write_tokens),
			costUsd: num(usage.estimated_cost_usd),
			stopReason: null,
			// The model Hermes says it RAN, which is a receipt rather than a request —
			// worth more than the pinned value precisely because this tool is unpinned.
			...(typeof usage.model === "string" && usage.model ? { model: usage.model } : {}),
		};
	}
}

/** Reads and shape-checks the `--usage-file` report; undefined when unusable. */
function readUsageReport(path: string): HermesUsageReport | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		// The caller treats absence as a failed verification. The usage report is
		// best-effort inside Hermes, but the throwaway cwd is writable; accepting
		// unverified stdout here would recreate the silent-summary-loss failure.
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as HermesUsageReport)
			: undefined;
	} catch {
		log.debug("Hermes usage report at %s is not valid JSON — treating the run as unverifiable", path);
		return undefined;
	}
}
