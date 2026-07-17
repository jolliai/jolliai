/**
 * LlmCredentials — the credential predicate shared by every LLM-generation entry
 * point AND by lightweight callers that must NOT pull in the LLM runtime.
 *
 * `hasLlmCredentials` lives here (not in LlmClient) precisely because LlmClient
 * eagerly imports `@anthropic-ai/sdk` + the local-agent backend graph at module
 * top: importing this predicate from LlmClient would inline that ~800 KB runtime
 * into deliberately LLM-free bundles (e.g. SessionStartHook, which only records
 * session metadata and never calls the LLM). Keeping the pure predicate in this
 * dependency-free leaf lets those hooks share the ONE source of truth without the
 * bloat. LlmClient re-exports it, so existing generation-side importers are
 * unchanged.
 */

/**
 * True when any LLM credential is available — an Anthropic key (config or
 * `ANTHROPIC_API_KEY` env) or a Jolli Space key — or the provider is
 * `local-agent`, which drives the tool's own subscription login rather than a
 * jollimemory-held credential (so it needs no jollimemory-held key; mirrors
 * `resolveLlmCredentialSource`). The single predicate every generation entry point
 * guards on before doing LLM work, so the check can't drift between the
 * summarizer siblings, compile, back-fill, and the SessionStart login reminder.
 */
export function hasLlmCredentials(config: {
	readonly apiKey?: string;
	readonly jolliApiKey?: string;
	readonly aiProvider?: "anthropic" | "jolli" | "local-agent";
}): boolean {
	if (config.aiProvider === "local-agent") return true;
	return Boolean(config.apiKey || config.jolliApiKey || process.env.ANTHROPIC_API_KEY);
}
