/**
 * JolliRefs — which git refs belong to this product rather than to the user.
 *
 * Jolli's storage lives on ordinary local branches under a reserved namespace
 * (today `jollimemory/summaries/v3`, plus every retired version a long-lived
 * clone still carries), so anything that walks `refs/heads` sees them unless it
 * is told not to — and the orphan branch holds one commit PER MEMORY. Two
 * dashboard consumers must agree on the exclusion, which is why the rule lives
 * in a module of its own rather than inside either of them:
 *
 *   - the commit collector, or the orphan's summary commits are imported as the
 *     user's own work (measured on this repo before the exclusion: 1800 of 2468
 *     stored commits were `Add summary for …` about the other 668, and
 *     `jollimemory/summaries/v3` outranked `main` in the branch attribution);
 *   - the backfill change signal, or it moves on every memory write and can
 *     never converge, so `jolli dashboard` re-swept git history on essentially
 *     every launch.
 *
 * A LEAF on purpose: no imports, in particular not `Logger.js` — where
 * `ORPHAN_BRANCH` lives and where this rule first sat. Two dozen suites replace
 * that module with a hand-written `vi.mock`, so every export added to it breaks
 * each of them with "No export is defined on the mock" until they are all
 * amended. The namespace is therefore restated here rather than derived from
 * `ORPHAN_BRANCH`; keep the two in step if the branch is ever renamed wholesale
 * (a version bump within the namespace needs no change here).
 */

/** The `refs/heads/` namespace this product reserves. @see ORPHAN_BRANCH */
const JOLLI_REF_NAMESPACE = "jollimemory";

/**
 * True for a ref this product owns. Accepts `refs/heads/x` or the short `x`.
 *
 * Matched by NAMESPACE, so retired branch versions go with it while a user
 * branch merely NAMED `jollimemory-notes` stays ordinary work.
 */
export function isJolliInternalRef(ref: string): boolean {
	const short = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
	return short.startsWith(`${JOLLI_REF_NAMESPACE}/`);
}

/**
 * The same rule as git's `--exclude` argument.
 *
 * Deliberately NOT prefixed with `refs/heads/`, and the trailing `/*` is
 * mandatory. `--exclude` takes its pattern relative to the selector it applies
 * to, so the `refs/heads/` form — the one that looks right, and the one
 * required when the selector is `--glob`/`--all` — matches NOTHING under
 * `--branches` and is silently ignored: measured, `git log
 * --exclude=refs/heads/jollimemory/* --branches HEAD` still listed all 2468
 * commits, exactly as if the flag were absent, while the correct form listed
 * 668. Neither shape produces an error or a warning.
 */
export const JOLLI_REFS_EXCLUDE_GLOB = `--exclude=${JOLLI_REF_NAMESPACE}/*`;
