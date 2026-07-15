/**
 * Pure eligibility logic for running a Jolli workflow LOCALLY (the calling
 * client's own agent executes the recipe; Jolli supplies the recipe and tracks
 * the run). A workflow is offered as locally-runnable ONLY when its destination
 * space is git-backed AND that space is already cloned on this machine — so the
 * workflow's writes can land through a branch + PR that space-cli commits and
 * pushes locally.
 *
 * This module is deliberately I/O-free: it takes the raw candidate workflow list
 * (fetched elsewhere via the manifest-served `list_workflows` platform tool) and
 * the set of space keys cloned on this machine (read elsewhere from
 * `jolli space clones --json`), and returns a verdict per workflow. No fetching,
 * no spawning, no config reads — every input is passed in, every verdict comes
 * out, which makes the whole rule exhaustively unit-testable.
 *
 * The destination identity is the space **JRN** (the backend keys spaces by JRN,
 * not by a numeric id): a workflow is cloned-locally when its destination JRN —
 * or the space slug encoded in that JRN — is among the machine's cloned-space
 * keys.
 */

/** The destination-space facts an eligibility decision depends on. */
export interface WorkflowDestination {
	/**
	 * The destination space's sync protocol. Only `git` is git-backed and
	 * therefore locally-runnable (a PR needs a git remote to open against); other
	 * values (e.g. `db`) are not runnable locally.
	 */
	readonly syncProtocol: string;
	/**
	 * Whether the destination auto-applies (auto-merges) an approved PR. Read
	 * ONLY to tell the user up front whether the resulting PR auto-merges (`true`)
	 * or opens for team review (`false`) — it is NEVER an eligibility input.
	 */
	readonly autoApply: boolean;
	/**
	 * The destination space's JRN (e.g. `jrn:/global:spaces:space/impact-1783452586552`).
	 * Matched against the machine's cloned-space keys, by full JRN or by the space
	 * slug encoded in it (see {@link spaceSlugFromJrn}).
	 */
	readonly jrn: string;
}

/** One candidate workflow as surfaced by the `list_workflows` platform tool. */
export interface WorkflowSummary {
	/**
	 * Workflow identifier passed to `start_local_run`. The backend emits a numeric
	 * id; it is carried as-is (not coerced to a string) so it stays usable as the
	 * integer the `start_local_run` tool expects. A string id/slug is also accepted.
	 */
	readonly id: string | number;
	/**
	 * Human-readable workflow name (e.g. "Impact Analysis"), carried for display
	 * ONLY so the recipe can present a chosen-from list by name rather than by an
	 * opaque id. Advisory: absent when the backend omits it, and NEVER an
	 * eligibility input.
	 */
	readonly name?: string;
	readonly destination: WorkflowDestination;
}

/** The eligibility verdict for a single workflow. */
export interface EligibilityVerdict {
	readonly id: string | number;
	/** The workflow's human-readable name, echoed for display when the backend supplied one. Never an eligibility input. */
	readonly name?: string;
	/** `true` iff the destination is git-backed AND its space is cloned locally. */
	readonly runnable: boolean;
	/** `destination.autoApply` — whether an approved PR auto-merges. Always populated, never an eligibility input. */
	readonly autoMerges: boolean;
	/** Present only when `runnable` is `false`; a short human-readable explanation. */
	readonly reason?: string;
}

/**
 * Sync protocols that are git-backed and therefore locally-runnable. Only `git`
 * qualifies today (the backend's `destination.syncProtocol` value); add any
 * future git-backed protocols here.
 */
const GIT_BACKED_SYNC_PROTOCOLS: ReadonlySet<string> = new Set(["git"]);

/** Whether a destination sync protocol is git-backed (and so eligible for a local run). */
export function isGitBackedSyncProtocol(syncProtocol: string): boolean {
	return GIT_BACKED_SYNC_PROTOCOLS.has(syncProtocol);
}

/**
 * The space slug encoded in a space JRN — the segment after the final `/` — or
 * `null` when the JRN carries no slug segment. Example:
 * `jrn:/global:spaces:space/impact-1783452586552` → `impact-1783452586552`.
 */
export function spaceSlugFromJrn(jrn: string): string | null {
	const slash = jrn.lastIndexOf("/");
	if (slash < 0 || slash === jrn.length - 1) {
		return null;
	}
	return jrn.slice(slash + 1);
}

/**
 * Computes the runnable verdict for every candidate workflow. Preserves input
 * order. A workflow is `runnable` iff its destination is git-backed AND its
 * destination space (by JRN, or by the slug encoded in the JRN) is in
 * `clonedSpaceKeys`; `autoMerges` always echoes `destination.autoApply`; a
 * `runnable: false` verdict carries a `reason`.
 */
export function evaluateLocalRunEligibility(
	workflows: readonly WorkflowSummary[],
	clonedSpaceKeys: ReadonlySet<string>,
): EligibilityVerdict[] {
	return workflows.map((workflow) => evaluateOne(workflow, clonedSpaceKeys));
}

function evaluateOne(workflow: WorkflowSummary, clonedSpaceKeys: ReadonlySet<string>): EligibilityVerdict {
	const { id, name, destination } = workflow;
	const autoMerges = destination.autoApply;
	if (!isGitBackedSyncProtocol(destination.syncProtocol)) {
		return {
			id,
			name,
			runnable: false,
			autoMerges,
			reason: `Destination is not git-backed (syncProtocol="${destination.syncProtocol}"); local runs require a git-backed space.`,
		};
	}
	if (!isCloned(destination.jrn, clonedSpaceKeys)) {
		return {
			id,
			name,
			runnable: false,
			autoMerges,
			reason: `Destination space ${destination.jrn} is not cloned on this machine.`,
		};
	}
	return { id, name, runnable: true, autoMerges };
}

/** Whether the destination space — by full JRN or by its encoded slug — is among the machine's cloned-space keys. */
function isCloned(jrn: string, clonedSpaceKeys: ReadonlySet<string>): boolean {
	if (clonedSpaceKeys.has(jrn)) {
		return true;
	}
	const slug = spaceSlugFromJrn(jrn);
	return slug !== null && clonedSpaceKeys.has(slug);
}
