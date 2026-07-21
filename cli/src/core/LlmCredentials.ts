/**
 * LlmCredentials — the lightweight, dependency-free twin of
 * `resolveLlmCredentialSource` (in LlmClient), for callers that must NOT pull in
 * the LLM runtime.
 *
 * `hasLlmCredentials` lives here (not in LlmClient) precisely because LlmClient
 * eagerly imports `@anthropic-ai/sdk` + the local-agent backend graph at module
 * top: importing a credential check from LlmClient would inline that ~800 KB
 * runtime into deliberately LLM-free bundles. The LLM-heavy entry points
 * (QueueWorker summaries, compile, PostMergeHook) already pull LlmClient in and
 * guard on the richer `resolveLlmCredentialSource`; this leaf is the boolean
 * mirror used by the two callers that stay LLM-free — BackfillEngine's
 * pre-enqueue gate and the SessionStart login reminder.
 */

/**
 * True when the configured provider can actually obtain an LLM credential — the
 * boolean mirror of `resolveLlmCredentialSource` (LlmClient), returning `true`
 * exactly where that returns a non-null source, without importing the LLM
 * runtime. It is provider-AWARE, NOT a blind OR of every key — a pinned provider
 * is only satisfied by its own credential:
 *   - `local-agent` → always true (drives the tool's own subscription login; no
 *     jollimemory-held credential needed).
 *   - `jolli`       → true only with a Jolli Space key (`jolliApiKey`); a stray
 *     Anthropic key does NOT satisfy the Jolli proxy.
 *   - `anthropic`   → true only with an Anthropic key (config `apiKey` or the
 *     `ANTHROPIC_API_KEY` env); a stray Jolli key does not count.
 *   - unset         → true if any key is present (the auto-select fallback).
 * Keep this in EXACT lockstep with `resolveLlmCredentialSource` so the LLM-free
 * callers (BackfillEngine's pre-enqueue gate, the SessionStart login reminder)
 * never disagree with the LLM-heavy paths about whether generation can proceed —
 * a blind OR here let the login reminder stay silent on a `jolli`-provider repo
 * that had only a leftover Anthropic key, while generation actually failed.
 */
export function hasLlmCredentials(config: {
	readonly apiKey?: string;
	readonly jolliApiKey?: string;
	readonly aiProvider?: "anthropic" | "jolli" | "local-agent";
}): boolean {
	if (config.aiProvider === "local-agent") return true;
	if (config.aiProvider === "jolli") return Boolean(config.jolliApiKey);
	if (config.aiProvider === "anthropic") return Boolean(config.apiKey || process.env.ANTHROPIC_API_KEY);
	return Boolean(config.apiKey || process.env.ANTHROPIC_API_KEY || config.jolliApiKey);
}
