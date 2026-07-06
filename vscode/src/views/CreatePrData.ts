/**
 * CreatePrData
 *
 * Pure-ish async function that assembles the view-model rendered by the
 * "Create PR" webview pane.  Isolated from the panel class so it is fully
 * unit-testable without any VS Code surface.
 */

import { buildPrBodyMarkdown, pickPrTitle } from "../../../cli/src/core/PrDescription.js";
import { toForwardSlash } from "../../../cli/src/core/PathUtils.js";
import type { E2eTestScenario } from "../../../cli/src/Types.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import type { PrHistoryEntry } from "../services/PrCommentService.js";
import { loadBranchSummaries } from "./BranchSummaryLoader.js";

export interface CreatePrFileRow {
	path: string;
	dir: string;
	status: string;
	/**
	 * For a rename (status "R"), the file's path at the diff base. `path` holds
	 * the *new* path; `oldPath` holds the *old* one so a per-file diff can read
	 * the left (base) side from where the content actually lived — the new path
	 * does not exist at the base, so using it there yields an empty "new file"
	 * diff instead of the real rename. Absent for non-rename rows.
	 */
	oldPath?: string;
}

export interface CreatePrMemoryRow {
	hash: string;
	title: string;
	prNumber?: number;
}

export interface CreatePrViewModel {
	branch: string;
	mainBranch: string;
	/** Total number of summaries loaded for this branch. */
	memoryCount: number;
	/** Number of commits on the branch with no recorded summary. */
	missingCount: number;
	insertions: number;
	deletions: number;
	filesChanged: number;
	/** PR title derived from the newest commit summary. */
	title: string;
	/** Raw PR body markdown (no idempotent markers). */
	bodyMarkdown: string;
	memories: CreatePrMemoryRow[];
	files: CreatePrFileRow[];
	/** E2E test scenarios from the newest (anchor) commit summary. */
	e2eScenarios: ReadonlyArray<E2eTestScenario>;
	/**
	 * The open PR already on this branch, if any. Populated by the panel (not
	 * this pure builder) since it needs a gh round-trip. When set, the pane
	 * renders an "Update PR" affordance + a clickable PR link instead of "Create
	 * PR"; when undefined the pane is in create mode.
	 */
	existingPr?: { number: number; url: string };
	/**
	 * Closed (merged / closed-without-merge) PRs previously opened from this
	 * branch, newest-first. Populated by the panel (not this pure builder) from
	 * the same gh round-trip as {@link existingPr}. Rendered as a lightweight
	 * "Previously: #N (merged) · …" strip under the meta-strip so a branch whose
	 * PR was already merged still surfaces that PR's link here. Empty/undefined
	 * when the branch has no closed PRs (or the gh lookup failed).
	 */
	prHistory?: ReadonlyArray<PrHistoryEntry>;
	/**
	 * Whether the user is signed in to Jolli. Populated by the panel (not this
	 * pure builder) since auth state lives on the VS Code side. Drives the share
	 * notice above the Title panel: signed-in shows a confirmation that creating
	 * the PR also shares the memories to Jolli Space; signed-out shows a Sign In
	 * link. Undefined is treated as signed-out (never falsely claim "signed in").
	 */
	signedIn?: boolean;
}

/**
 * Builds the view-model for the Create PR pane.
 *
 * Returns `{ empty: true }` when the branch has no unmerged memories so the
 * panel can show an appropriate empty state without rendering a broken form.
 *
 * The **anchor** is the newest summary (`summaries[summaries.length - 1]`)
 * because `loadBranchSummaries` returns commits in chronological (oldest-
 * first) order. Title and body are derived from the anchor; E2E scenarios are
 * aggregated across ALL included memories (matching the aggregated PR body),
 * so the panel's E2E Test Guide isn't empty just because the newest commit
 * happened not to generate scenarios.
 */
export async function buildCreatePrViewModel(
	bridge: JolliMemoryBridge,
	mainBranch: string,
): Promise<CreatePrViewModel | { empty: true }> {
	const { summaries, missingCount } = await loadBranchSummaries(bridge, mainBranch);
	if (summaries.length === 0) return { empty: true };

	// anchor = newest commit summary (chronological order, so last element)
	const anchor = summaries[summaries.length - 1];
	const branch = anchor.branch || (await bridge.getCurrentBranch());

	const stats = await bridge.getBranchPrStats(mainBranch);

	const memories: CreatePrMemoryRow[] = summaries.map((s) => ({
		hash: s.commitHash,
		title: s.commitMessage.split("\n")[0],
	}));

	return {
		branch,
		mainBranch,
		memoryCount: summaries.length,
		missingCount,
		insertions: stats.insertions,
		deletions: stats.deletions,
		filesChanged: stats.filesChanged,
		title: pickPrTitle(anchor, summaries),
		bodyMarkdown: buildPrBodyMarkdown(anchor, summaries, missingCount),
		memories,
		files: stats.files,
		// Aggregate E2E scenarios across every included memory (not just the
		// anchor) so the panel mirrors the aggregated PR body — a newest commit
		// without scenarios must not blank out the whole E2E Test Guide section.
		e2eScenarios: summaries.flatMap((s) => s.e2eTestGuide ?? []),
	};
}

/**
 * Parses raw `git diff --name-status` output into `CreatePrFileRow` objects.
 *
 * Each non-empty line is `<STATUS>\t<path>` or `R<pct>\t<old>\t<new>` for
 * renames.  Status codes are normalised: rename codes like "R100" become "R".
 * Paths are normalised to forward slashes via {@link toForwardSlash}.
 *
 * Exported for unit testing — the bridge's `getBranchPrStats` method uses its
 * own copy of this logic so views/ never imports from the bridge.
 *
 * keep in lockstep with parseDiffNameStatus in JolliMemoryBridge.ts — they are
 * byte-identical; any logic change must be applied to both.
 */
export function parseNameStatus(raw: string): CreatePrFileRow[] {
	const rows: CreatePrFileRow[] = [];
	for (const line of raw.split("\n")) {
		const entry = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (!entry.trim() || !entry.includes("\t")) continue;
		const parts = entry.split("\t");
		const rawStatus = parts[0];
		const status = rawStatus.startsWith("R") ? "R" : rawStatus;
		const isRename = status === "R" && parts.length >= 3;
		const filePath = toForwardSlash(isRename ? parts[2] : parts[1]);
		const lastSlash = filePath.lastIndexOf("/");
		const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : "";
		rows.push({ path: filePath, dir, status, ...(isRename ? { oldPath: toForwardSlash(parts[1]) } : {}) });
	}
	return rows;
}
