/**
 * The agent session a process is running inside, when one advertised itself in
 * the environment. Shared by every surface that needs to know "which session am
 * I a child of" — the lookup-receipt producer ([ProducerHooks.ts](../dashboard/ProducerHooks.ts))
 * and the post-commit hook, which stamps it onto the queue entry so a commit
 * made from one worktree can be attributed to the session that authored it even
 * when that session ran in another checkout.
 *
 * ⚠ The environment answers for the process, and a process is only the right
 * answer while it belongs to ONE session — see {@link setAmbientSessionIdTrusted}.
 */

/**
 * Environment variables that carry the id of the agent session this process is
 * running inside, most-specific first.
 *
 * **One entry, and that is a measured result rather than an unfinished list.**
 * Claude Code exports `CLAUDE_CODE_SESSION_ID`, and it is the same uuid
 * `sessions.session_id` carries, so a value read from it joins straight onto the
 * session row (verified against a live session). The other hosts were checked
 * the only way that settles it — reading `/proc/<pid>/environ` of a running one
 * — and they publish nothing usable:
 *
 *   - **codex**: the whole environment carries no session/conversation/thread
 *     variable; the only codex-specific entry is
 *     `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, which names the front-end, not the
 *     session. Its session id exists only inside its own rollout files.
 *
 * So a caller running under those hosts gets `undefined`, and that is the honest
 * answer rather than a gap to paper over: the tempting fallback — pick the most
 * recently touched session for this repo — is a GUESS that looks exactly like a
 * fact once stored, and would attribute work to a session that never did it in
 * the one direction nobody can audit. A null is visible as a null; an invented
 * id is not.
 *
 * Adding a host means measuring it the same way and appending its real variable
 * name here; nothing else changes.
 */
export const SESSION_ID_ENV_VARS: ReadonlyArray<string> = ["CLAUDE_CODE_SESSION_ID"];

/**
 * True when `id` is safe to interpolate as a single path segment when locating a
 * session's transcript (`<projectsDir>/<slug>/<id>.jsonl`). The id reaches that
 * `join` from two attacker-influenceable sources — the process environment, and
 * the executing-session field of a queue entry, which is an ordinary JSON file
 * parsed with no schema — so an unvalidated value carrying `../` traversal
 * escapes the producer's transcript directory (`join` normalises the traversal
 * rather than rejecting it). A real producer session id is a plain token; this
 * predicate admits exactly that and rejects any separator, traversal, or empty /
 * dot-only name, which closes the escape at the point the id becomes a path.
 */
export function isSafeSessionId(id: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

/**
 * Whether this process's environment still names the session it is acting for.
 *
 * True for an ordinary short-lived invocation — a `jolli` command, a git hook, the
 * per-session `mcp` proxy — each launched by the session it serves, so an inherited
 * marker is a fact about the work in front of it.
 *
 * A long-lived SHARED server is the opposite case, and `mcp-serve` is the one that
 * makes it concrete: it is keyed by WORKTREE and a version tie ATTACHES rather than
 * evicting, so several sessions (and several hosts) reach the same process, whose
 * env was frozen at spawn from whichever proxy happened to be first. Left trusted,
 * every `search` and `recall` that daemon answered would be filed under the
 * spawning session's id — so the Search Terms card's "N agent sessions" would count
 * one, for ever, however many sessions searched. That is a WRONG value rather than
 * a missing one, which is the failure the note on {@link SESSION_ID_ENV_VARS}
 * refuses a guessed id to avoid; a null is visible as a null.
 *
 * Set from ONE place — the CLI entry, off the same `isAgentInferenceExempt`
 * predicate that decides whether telemetry may infer its `agent` from the env, for
 * the same reason and over the same processes. There is no per-connection session
 * id to fall back to (the MCP `initialize` handshake names the HOST, not a session),
 * so the honest answer for a shared server is simply no id.
 */
let ambientSessionIdTrusted = true;

/** See {@link ambientSessionIdTrusted}. Idempotent; the CLI entry calls it once. */
export function setAmbientSessionIdTrusted(trusted: boolean): void {
	ambientSessionIdTrusted = trusted;
}

/**
 * The agent session this process is running inside, or `undefined` for a plain
 * terminal, for every host in the note above, and for a shared server that has
 * declared its env untrustworthy. A blank value is treated as absent rather than
 * returned as an empty id.
 */
export function currentAgentSessionId(): string | undefined {
	if (!ambientSessionIdTrusted) return undefined;
	for (const name of SESSION_ID_ENV_VARS) {
		const id = process.env[name]?.trim();
		// A malformed value (traversal, separators) is treated as absent rather
		// than carried forward: an invented/hostile id must never become a path
		// segment downstream, and "no id" is the honest answer for one we refuse.
		if (id && isSafeSessionId(id)) return id;
	}
	return undefined;
}
