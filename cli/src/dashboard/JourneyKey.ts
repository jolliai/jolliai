/**
 * The tracker key, and the rule that turns a window's commits into journeys.
 *
 * Pure by design: the grouping is the one thing the whole view is built on, and
 * every rule here is testable without a database.
 *
 * `TICKET_ID_PATTERN` is the single definition of a tracker key on the grouping
 * path — the cloud's equivalent bug was two code paths each carrying their own
 * regex, one strict and one absent, so a reported ticket was trusted unvalidated
 * while the fallback was picky. Do not add a second spelling within this module.
 *
 * Two other spellings exist in the repo, serving different purposes:
 * - `cli/src/core/Summarizer.ts:1180` (`TICKET_PATTERN`) — backs `extractTicketIdFromMessage`,
 *   used in the squash pipeline and panel title generation.
 * - `cli/src/core/SummaryFormat.ts:204` (local `pattern`) — backs `extractTicketFallback`,
 *   the legacy display title fallback for old summaries without ticketId.
 *
 * `extractTicketFallback` deliberately also mines the branch name with a
 * case-insensitive variant `/[A-Za-z][A-Za-z0-9]+-\d+/i` followed by `.toUpperCase()`.
 * That is correct for display (where over-matching is cheap) and wrong for grouping:
 * measured against this repo's real data, branch mining recovers 33 commits into
 * 5 keys of which only `JOLLI-1146` is a real ticket — the other four
 * (`UPDATE-0`, `DOC-0`, `RELEASE-0`, `PR-130`) are invented journeys that steal
 * commits from real groups. MUST NOT import `extractTicketFallback` into this path.
 */

/** Ported from the cloud's `common/src/types/JolliMemorySummary.ts`. */
const TICKET_ID_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
const TICKET_EXACT = new RegExp(`^${TICKET_ID_PATTERN}$`);
const TICKET_ANYWHERE = new RegExp(`\\b(${TICKET_ID_PATTERN})\\b`);

/**
 * Whether a value is a BARE tracker key.
 *
 * The shape check is load-bearing rather than defensive. Measured over this
 * repo's own 2697 stored memories: 955 values pass, and 463 do not — plan
 * slugs, `#117`, branch names, full commit SHAs, `PR #227`, and multi-ticket
 * strings like `"JOLLI-934, JOLLI-959"`. This value is half of a journey's
 * grouping key, so an unvalidated one invents a journey named after the
 * placeholder and steals commits from the journeys it names.
 */
export function isTicketId(value: string | null | undefined): boolean {
	return typeof value === "string" && TICKET_EXACT.test(value);
}

/**
 * The first tracker key in a commit message, if any.
 *
 * "First" is the whole rule for a multi-ticket message: it is deterministic and
 * explainable, which a bucket named after the raw string is not.
 */
export function deriveTicketId(commitMessage: string | null | undefined): string | undefined {
	if (!commitMessage) return undefined;
	const match = commitMessage.match(TICKET_ANYWHERE);
	return match ? match[1] : undefined;
}

/** The reported field when it is a real key, else the message, else unticketed. */
export function resolveTicket(input: {
	readonly ticketId: string | null;
	readonly commitMessage: string | null;
}): string | null {
	if (isTicketId(input.ticketId)) return input.ticketId;
	return deriveTicketId(input.commitMessage) ?? null;
}

export type JourneyGrouping = "ticket" | "branch" | "commit";

export interface JourneyCommitInput {
	readonly repoIdentity: string;
	readonly commitHash: string;
	readonly ticketId: string | null;
	readonly commitMessage: string | null;
	readonly branch: string | null;
}

export interface JourneyKey {
	/** Opaque and namespaced by grouping kind — never parsed apart by callers. */
	readonly key: string;
	readonly groupedBy: JourneyGrouping;
	readonly ticket: string | null;
	readonly branch: string | null;
}

/**
 * Unticketed commits needed on one branch before the branch itself becomes a
 * journey. Below it the commit stands alone, so the fallback cannot mint a
 * "branch journey" holding a single commit — a label that would claim more than
 * the grouping knows.
 */
const BRANCH_FALLBACK_MIN = 2;

/** Escaped, never a raw byte: a literal NUL makes git treat the source as binary. */
const SEP = "\x00";

/** The map key for one commit. Repo-qualified — a hash is only unique per repo. */
export function commitMapKey(repoIdentity: string, commitHash: string): string {
	return `${repoIdentity}${SEP}${commitHash}`;
}

/**
 * Two passes over ONE window's commits.
 *
 * Pass 1 resolves tickets and tallies the unticketed per (repo, branch); pass 2
 * assigns keys. The tally is per window, so the same branch can be a branch
 * journey over 90 days and a lone commit over 7 — see the spec's §2.2. That is
 * the intended behaviour: a journey is what the work looks like over the period
 * being asked about.
 */
export function assignJourneyKeys(commits: ReadonlyArray<JourneyCommitInput>): ReadonlyMap<string, JourneyKey> {
	const tickets = new Map<string, string | null>();
	const unticketedPerBranch = new Map<string, number>();
	for (const commit of commits) {
		const ticket = resolveTicket(commit);
		tickets.set(commitMapKey(commit.repoIdentity, commit.commitHash), ticket);
		if (ticket === null && commit.branch) {
			const branchKey = `${commit.repoIdentity}${SEP}${commit.branch}`;
			unticketedPerBranch.set(branchKey, (unticketedPerBranch.get(branchKey) ?? 0) + 1);
		}
	}

	const assigned = new Map<string, JourneyKey>();
	for (const commit of commits) {
		const mapKey = commitMapKey(commit.repoIdentity, commit.commitHash);
		const ticket = tickets.get(mapKey) ?? null;
		if (ticket !== null) {
			assigned.set(mapKey, {
				key: `T${SEP}${commit.repoIdentity}${SEP}${ticket}`,
				groupedBy: "ticket",
				ticket,
				branch: commit.branch,
			});
			continue;
		}
		const branchKey = commit.branch ? `${commit.repoIdentity}${SEP}${commit.branch}` : undefined;
		if (branchKey && (unticketedPerBranch.get(branchKey) ?? 0) >= BRANCH_FALLBACK_MIN) {
			assigned.set(mapKey, {
				key: `B${SEP}${branchKey}`,
				groupedBy: "branch",
				ticket: null,
				branch: commit.branch,
			});
			continue;
		}
		assigned.set(mapKey, {
			key: `C${SEP}${mapKey}`,
			groupedBy: "commit",
			ticket: null,
			branch: commit.branch,
		});
	}
	return assigned;
}
