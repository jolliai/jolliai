/**
 * Tier 2 AI merge using the user's locally-configured Anthropic API key.
 *
 * Per the Phase 3 client decision (plan-personal-memory-bank-jolly-breeze.md),
 * Tier 2 NEVER routes through a backend proxy — the user either has
 * `config.apiKey` set (this provider is used) or has nothing and the
 * `ConflictResolver` falls straight to Tier 3 with `ai: null`.
 *
 * The model is selectable via `config.model`; default mirrors `LlmClient`'s
 * direct path. Temperature stays at 0 for determinism — merges are not a
 * creative writing task and reproducibility helps debugging.
 *
 * The prompt is intentionally compact and structured. The output guards in
 * `ConflictResolver.passesGuards` (no merge markers, length window, JSON
 * parseability, confidence threshold) act as a second line of defence; if
 * the LLM hallucinates structure we surface the failure to the user via
 * Tier 3 rather than committing garbage.
 */

import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { resolveModelId } from "../core/Summarizer.js";
import { createLogger } from "../Logger.js";
import type { AiMergeProvider, AiMergeRequest, AiMergeResponse } from "./ConflictResolver.js";

const log = createLogger("Sync:LocalAiMerge");

export interface LocalAiMergeOpts {
	readonly apiKey: string;
	readonly model?: string;
	/** Test seam — swap in a stub Anthropic SDK. */
	readonly clientFactory?: (apiKey: string) => Pick<Anthropic, "messages">;
	/** Caps the response to a sensible bound; default 8192. */
	readonly maxTokens?: number;
	/**
	 * Test seam — substitute the per-call random merge token. Default uses
	 * `crypto.randomBytes(8)`; tests pin a fixed value for deterministic
	 * stub-LLM responses. In production the token is unpredictable to any
	 * external party (peer-pushed content, jail-broken LLM trying to forge
	 * markers from training-data shapes).
	 */
	readonly tokenFactory?: () => string;
}

const DEFAULT_MAX_TOKENS = 8192;
/**
 * Hard ceiling on the Tier 2 Anthropic call. Pre-fix the SDK had no per-call
 * deadline, so a slow Sonnet generation (1–3 min is normal for an 8 K-token
 * output) blocked the entire sync round — and when the response missed the
 * `BEGIN_MERGED_<token>` markers and got thrown away, the full cost was
 * wasted before Tier 2.7 / Tier 3 fall-through could run.
 *
 * 30 s is a deliberate compromise: long enough for short-to-medium files
 * (most user plan / note diffs finish in 5–15 s), short enough to bound the
 * worst-case sync-round latency. Hitting the timeout falls cleanly through
 * to Tier 2.7 / Tier 3 — same path as a network failure.
 *
 * Applied via `AbortSignal.timeout` (not the SDK's `{ timeout }` option) so
 * the deadline is truly end-to-end and consistent with `LlmClient`'s direct
 * path — the SDK's own `timeout` historically applied per retry rather than
 * to the whole call.
 */
const TIER2_TIMEOUT_MS = 30_000;

export class LocalAiMergeProvider implements AiMergeProvider {
	private readonly client: Pick<Anthropic, "messages">;
	private readonly model: string;
	private readonly maxTokens: number;
	private readonly tokenFactory: () => string;

	constructor(opts: LocalAiMergeOpts) {
		this.model = resolveModelId(opts.model);
		this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
		this.client = (opts.clientFactory ?? defaultClientFactory)(opts.apiKey);
		this.tokenFactory = opts.tokenFactory ?? defaultTokenFactory;
	}

	async merge(req: AiMergeRequest): Promise<AiMergeResponse> {
		const token = this.tokenFactory();
		const prompt = buildPrompt(req, token);
		const response = await this.client.messages.create(
			{
				model: this.model,
				max_tokens: this.maxTokens,
				temperature: 0,
				messages: [{ role: "user", content: prompt }],
			},
			// End-to-end deadline via `AbortSignal.timeout` (matches
			// `LlmClient`'s direct-mode path — one timeout mechanism across
			// the codebase). `AbortSignal.timeout` aborts the underlying
			// fetch on expiry regardless of which retry the SDK is on, so
			// the worst-case wall-clock is bounded at `TIER2_TIMEOUT_MS`
			// (the SDK's own `timeout` option historically applied per
			// retry, not end-to-end). `tryAiMerge` catches the resulting
			// AbortError and falls through to Tier 2.7 / Tier 3.
			{ signal: AbortSignal.timeout(TIER2_TIMEOUT_MS) },
		);
		const textBlock = response.content.find((b) => b.type === "text");
		if (!textBlock || textBlock.type !== "text") {
			throw new Error("LocalAiMergeProvider: no text content in LLM response");
		}
		const parsed = parseModelOutput(textBlock.text, token);
		log.debug(
			"Tier 2 merge for %s — confidence=%s len=%d model=%s",
			req.path,
			parsed.confidence.toFixed(2),
			parsed.merged.length,
			response.model,
		);
		return { merged: parsed.merged, confidence: parsed.confidence, model: response.model };
	}
}

/* v8 ignore next 3 -- thin crypto adapter exercised only by the real bundle path */
function defaultTokenFactory(): string {
	return randomBytes(8).toString("hex");
}

/* v8 ignore next 3 -- thin SDK adapter exercised only by real bundle */
function defaultClientFactory(apiKey: string): Pick<Anthropic, "messages"> {
	return new Anthropic({ apiKey });
}

/**
 * Builds the merge prompt. The instructions are intentionally narrow:
 *
 *   - Output ONLY the merged file body
 *   - No conflict markers
 *   - No commentary
 *   - First line carries the confidence score so the guard can parse it
 *
 * The guard treats malformed output as a Tier-2 failure → Tier 3, so the
 * prompt failure modes degrade safely.
 *
 * **Per-call random merge token (S6 hardening).** The structural markers
 * are `BEGIN_MERGED_<token>` / `END_MERGED_<token>` where `<token>` is a
 * cryptographically random 16-char hex string generated once per call by
 * `LocalAiMergeProvider`. Closes two collision lanes that the static
 * `BEGIN_MERGED` / `END_MERGED` form left open:
 *
 *   - Peer-pushed `base/ours/theirs` containing a line that legitimately
 *     reads `END_MERGED` (e.g. file content discusses this very protocol)
 *     no longer accidentally truncates the parsed body.
 *   - An attacker who pre-crafted hostile content into the peer repo
 *     can't synthesise a marker that matches our parser, because the
 *     token is generated AFTER they pushed.
 *
 * The trade-off is that a jail-broken / non-Claude LLM that ignores the
 * exact token will produce unparseable output → Tier-3 fallback. That
 * failure is safe (no garbage on disk).
 */
export function buildPrompt(req: AiMergeRequest, token: string): string {
	const fileKindHint =
		req.fileKind === "json"
			? "The file is JSON. Preserve key order from `ours` where possible and ensure the result parses as valid JSON."
			: "The file is Markdown. Preserve heading structure from `ours` where possible.";

	const FENCE = "```";
	const beginMarker = `BEGIN_MERGED_${token}`;
	const endMarker = `END_MERGED_${token}`;
	const baseLines =
		req.base === null
			? ["BASE: <no common ancestor — the file did not exist on the merge base>"]
			: ["BASE:", FENCE, req.base, FENCE];

	return [
		"You are merging two divergent versions of a single file into one coherent result.",
		fileKindHint,
		"",
		"OUTPUT FORMAT — required, no exceptions:",
		"  Line 1: CONFIDENCE=<0.00-1.00>",
		`  Line 2: ${beginMarker}`,
		"  Lines 3..N-1: the merged file body, exactly as it should be written to disk",
		`  Final line: ${endMarker}`,
		`The marker tokens (${beginMarker}, ${endMarker}) are randomised per request — emit them VERBATIM, do not invent your own.`,
		"Do not include conflict markers (<<<<<<<, =======, >>>>>>>) anywhere.",
		"Do not include commentary, explanations, or apologies. Body only.",
		"",
		`PATH: ${req.path}`,
		"",
		...baseLines,
		"",
		"OURS:",
		FENCE,
		req.ours,
		FENCE,
		"",
		"THEIRS:",
		FENCE,
		req.theirs,
		FENCE,
	].join("\n");
}

interface ParsedOutput {
	readonly merged: string;
	readonly confidence: number;
}

/**
 * Parses the structured response, scoping marker matches to the caller-
 * supplied per-call token. Throws when the format is broken.
 *
 * **Prompt-injection robustness (S6).**
 *
 *   - Body extraction uses the FIRST `END_MERGED_<token>` after
 *     `BEGIN_MERGED_<token>`. A hallucinated / attacker-appended duplicate
 *     close marker cannot extend the body past the canonical close.
 *   - Marker line equality calls `.trim()` so a stray trailing space on
 *     the canonical close still matches.
 *   - The `<token>` is generated per-call by `LocalAiMergeProvider` and
 *     is not known to peer-pushed content at the time of push, so a peer
 *     cannot pre-craft content whose lines collide with our markers.
 */
export function parseModelOutput(text: string, token: string): ParsedOutput {
	const lines = text.split(/\r?\n/);
	if (lines.length < 3) {
		throw new Error("LocalAiMergeProvider: response too short to parse");
	}

	/* v8 ignore start -- defensive ?? fallback: lines[0] is defined past the length < 3 guard above */
	const confidenceMatch = /^CONFIDENCE=(-?[0-9]*\.?[0-9]+)$/.exec(lines[0]?.trim() ?? "");
	/* v8 ignore stop */
	if (!confidenceMatch) {
		throw new Error("LocalAiMergeProvider: missing CONFIDENCE header");
	}
	/* v8 ignore start -- defensive ?? fallback: regex guarantees confidenceMatch[1] when the match object is non-null */
	const rawConfidence = Number.parseFloat(confidenceMatch[1] ?? "0");
	/* v8 ignore stop */
	const confidence = Math.max(0, Math.min(1, rawConfidence));

	const beginMarker = `BEGIN_MERGED_${token}`;
	const endMarker = `END_MERGED_${token}`;
	const beginIdx = lines.findIndex((l) => l.trim() === beginMarker);
	let endIdx = -1;
	if (beginIdx !== -1) {
		for (let i = beginIdx + 1; i < lines.length; i++) {
			/* v8 ignore start -- lines[i] is defined inside the i < lines.length loop, the ?? "" is a TS-strictness belt-and-suspenders */
			if ((lines[i]?.trim() ?? "") === endMarker) {
				/* v8 ignore stop */
				endIdx = i;
				break;
			}
		}
	}
	if (beginIdx === -1 || endIdx === -1) {
		throw new Error("LocalAiMergeProvider: missing BEGIN_MERGED / END_MERGED bracket");
	}
	const body = lines.slice(beginIdx + 1, endIdx).join("\n");
	return { merged: body, confidence };
}
