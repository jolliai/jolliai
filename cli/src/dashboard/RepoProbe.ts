/**
 * RepoProbe — facts about a candidate folder for the Repositories card,
 * before it is added. Answers "what would picking this folder mean" without
 * committing to anything: no registration, no hooks, no LLM calls.
 *
 * `withoutMemoryYet` is deliberately NOT the mockup's "commits with an AI
 * session Jolli can summarize" — determining that needs a transcript
 * attribution scan (`attributeCommits`), too expensive to run on every folder
 * a user hovers over. `countMissingSummaries` answers the cheaper, honest
 * question instead ("commits that don't have a memory yet"), which is what
 * the backfill count actually bounds.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { countMissingSummaries } from "../backfill/BackfillEngine.js";
import { getCurrentBranch } from "../core/GitOps.js";
import { deriveRepoName, listActiveRepos, resolveRepoIdentity } from "./RepoRegistry.js";

export interface RepoProbeResult {
	readonly isGitRepo: boolean;
	readonly name?: string;
	readonly remote?: string;
	readonly branch?: string;
	readonly commits?: number;
	readonly withoutMemoryYet?: number;
	readonly alreadyAdded: boolean;
}

export async function probeRepo(path: string, configDir?: string): Promise<RepoProbeResult> {
	if (!existsSync(join(path, ".git"))) {
		return { isGitRepo: false, alreadyAdded: false };
	}

	const { identity, remoteUrl } = await resolveRepoIdentity(path);
	const active = await listActiveRepos(configDir);
	const alreadyAdded = active.some((r) => r.repoIdentity === identity);

	const [branch, { total, missing }] = await Promise.all([
		getCurrentBranch(path).catch(() => undefined),
		countMissingSummaries(path).catch(() => ({ total: 0, missing: 0 })),
	]);
	// getCanonicalRepoUrl never throws (falls back to file:// for a local-only
	// repo) — resolveRepoIdentity already read it, but withheld the raw file://
	// form; re-derive only the human-facing remote label, never a path-embedding one.
	const remote = remoteUrl && !remoteUrl.startsWith("file:") ? remoteUrl : undefined;

	return {
		isGitRepo: true,
		name: deriveRepoName(path, remoteUrl),
		...(remote ? { remote } : {}),
		...(branch ? { branch } : {}),
		commits: total,
		withoutMemoryYet: missing,
		alreadyAdded,
	};
}
