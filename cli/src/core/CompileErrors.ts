/**
 * CompileErrors — discriminated error classification for the compile pipeline.
 *
 * Motivation: `compileAllRepos` / `drainIngest` / LLM calls surface failures
 * as generic `Error` instances with human-readable messages. Every GUI surface
 * that consumes them (VS Code plugin, desktop) then reinvents string matching
 * to decide whether to show "check your API key" vs "we're rate-limited" vs
 * "unknown error." Bugs and copy drift follow.
 *
 * This module provides a light classifier — best-effort, never throws, always
 * returns a known kind (default `internal`). Callers classify a caught error at
 * their boundary and carry the resulting `kind` in their result envelope (see
 * `SingleRepoCompile` / `MultiRepoCompile`, which return `{ kind, message,
 * errorKind }`); every downstream layer then dispatches on `errorKind` instead
 * of grepping `err.message`.
 *
 * Non-goals:
 *   - Perfect coverage of every SDK/HTTP failure mode. New kinds may be added
 *     as UX surfaces demand them; consumers must default-branch on unknowns.
 */

/**
 * The finite set of failure kinds a UI can render distinct copy for. Keep it
 * short — every new kind means every consuming surface writes new copy in every
 * locale. Prefer collapsing to `internal` over over-specialising.
 */
export type CompileErrorKind =
	| "auth" //           401/403 — API key rejected or lacks permission
	| "rateLimit" //      429   — provider rate limit tripped
	| "overloaded" //     529   — provider capacity briefly exceeded (Anthropic-specific but broadly useful)
	| "network" //        no HTTP response reached — DNS, TLS, socket, timeout
	| "serverError" //    5xx (excl. 529) — provider-side crash
	| "quotaExhausted" // 402 or explicit quota/billing message — key valid but out of credits
	| "invalidResponse" // response reached us but was malformed (missing content, unparseable)
	| "internal"; //      catch-all — bugs, config, filesystem, and everything unclassified

/**
 * Best-effort classifier over arbitrary caught errors. Recognises common
 * shapes:
 *   - Anthropic SDK errors carry `.status` (HTTP status) and sometimes `.name`.
 *   - Fetch failures throw `TypeError('fetch failed')` with no `.status`.
 *   - AbortError has `.name === "AbortError"` — NOT classified here (callers
 *     should already have handled abort separately; return `internal` to make
 *     misuse loud rather than silent).
 *   - Plain Error strings are pattern-matched against a small allowlist of
 *     known Jolli-thrown phrases (invalid API key, rate limit, etc.).
 *
 * Never throws. Unknown shapes fall through to `internal`.
 */
export function classifyCompileError(err: unknown): CompileErrorKind {
	if (!(err instanceof Error)) return "internal";

	// HTTP status wins when present — provider SDKs set this and it's the
	// most reliable signal we get.
	const status = (err as { status?: number }).status;
	if (typeof status === "number") {
		if (status === 401 || status === 403) return "auth";
		if (status === 402) return "quotaExhausted";
		if (status === 429) return "rateLimit";
		if (status === 529) return "overloaded";
		if (status >= 500 && status < 600) return "serverError";
	}

	// SDK error names — `AuthenticationError` etc. come from Anthropic SDK's
	// typed subclasses when the caller upgrades from bare `APIError`.
	const name = err.name;
	if (name === "AuthenticationError" || name === "PermissionDeniedError") return "auth";
	if (name === "RateLimitError") return "rateLimit";
	if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") return "network";
	// `AbortSignal.timeout()` aborts with a DOMException named "TimeoutError" — a
	// wall-clock timeout with no HTTP response, i.e. a transport failure. (Plain
	// user-cancel is "AbortError", handled by callers before they classify.)
	if (name === "TimeoutError") return "network";
	if (name === "InternalServerError") return "serverError";

	// Fetch failures at the transport level — no HTTP response ever reached us.
	// TypeError('fetch failed') is Node's undici fingerprint; the SDK also
	// wraps ETIMEDOUT / ECONNRESET into similar messages.
	const msg = err.message.toLowerCase();
	if (name === "TypeError" && (msg.includes("fetch failed") || msg.includes("network") || msg.includes("timeout"))) {
		return "network";
	}
	if (
		msg.includes("etimedout") ||
		msg.includes("econnreset") ||
		msg.includes("econnrefused") ||
		msg.includes("enotfound") ||
		msg.includes("socket hang up")
	) {
		return "network";
	}

	// Message-pattern fallback for CLI-thrown wrapper errors. These are the
	// throws in LlmClient.ts / the auth pipeline that wrap the underlying
	// error into a friendlier string without preserving `.status`.
	if (msg.includes("api key") && (msg.includes("invalid") || msg.includes("unauthorized"))) return "auth";
	if (msg.includes("rate limit")) return "rateLimit";
	if (msg.includes("insufficient") && (msg.includes("credit") || msg.includes("quota") || msg.includes("balance")))
		return "quotaExhausted";
	if (msg.includes("no text content in api response") || msg.includes("malformed")) return "invalidResponse";

	return "internal";
}
