/**
 * The agent session a process is running inside, when one advertised itself in
 * the environment. Shared by every surface that needs to know "which session am
 * I a child of" — the recall-receipt producer ([ProducerHooks.ts](../dashboard/ProducerHooks.ts))
 * and the post-commit hook, which stamps it onto the queue entry so a commit
 * made from one worktree can be attributed to the session that authored it even
 * when that session ran in another checkout.
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
 * The agent session this process is running inside, or `undefined` for a plain
 * terminal and for every host in the note above. A blank value is treated as
 * absent rather than returned as an empty id.
 */
export function currentAgentSessionId(): string | undefined {
	for (const name of SESSION_ID_ENV_VARS) {
		const id = process.env[name]?.trim();
		if (id) return id;
	}
	return undefined;
}
