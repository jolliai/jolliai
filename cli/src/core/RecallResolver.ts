/**
 * Single source of truth for "what does recall return for this input" — the
 * type-tagged discriminated union the jolli-recall skill consumes. Both the CLI
 * `recall --format json` path and the MCP `recall` tool call this, so their
 * results are byte-identical by construction.
 */
import { SAFE_ARGUMENT_PATTERN } from "../commands/CliUtils.js";
import type { RecallOutcome } from "../Types.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import {
	type BranchCatalog,
	buildRecallPayload,
	compileTaskContext,
	DEFAULT_TOKEN_BUDGET,
	listBranchCatalog,
	type RecallPayload,
} from "./ContextCompiler.js";

export type RecallResult = RecallPayload | BranchCatalog | { type: "error"; message: string };

/**
 * Reduces a served result to the {@link RecallOutcome} the dashboard records.
 *
 * Pure, and deliberately here rather than in the producer: this is a statement
 * about what the recall *union* means, and both surfaces that can answer a
 * recall (the MCP tool and the CLI) must agree on it for the same reason they
 * share `resolveRecall` itself. `catalog` and `error` are both misses — the
 * caller got no commit content either way — and so is the `recall` shape with
 * zero commits, which should not occur but must not count as served if it does.
 */
export function recallOutcomeOf(result: RecallResult, atMs: number): RecallOutcome {
	if (result.type !== "recall") return { hit: false, commitCount: 0, commits: [], atMs };
	// Defensive on a field the type says is always there: this runs on the live
	// recall path, in front of the answer the caller is waiting for, so a
	// malformed payload must cost a figure on a card and never the recall.
	const commits = Array.isArray(result.commits)
		? result.commits.map((c) => ({ hash: c.fullHash, date: c.commitDate }))
		: [];
	return { hit: result.commitCount > 0, commitCount: result.commitCount, commits, atMs };
}

export interface ResolveRecallOptions {
	budget?: number;
	depth?: number;
	includeTranscripts?: boolean;
	includePlans?: boolean;
}

export async function resolveRecall(
	branchOrKeyword: string | undefined,
	projectDir: string,
	options: ResolveRecallOptions = {},
): Promise<RecallResult> {
	if (branchOrKeyword && !SAFE_ARGUMENT_PATTERN.test(branchOrKeyword)) {
		return {
			type: "error",
			message:
				"Invalid characters in argument. Only letters, numbers, hyphens, underscores, slashes, and dots are allowed.",
		};
	}

	let branch = branchOrKeyword;
	if (!branch) {
		try {
			branch = execFileSyncHidden("git", ["branch", "--show-current"], {
				encoding: "utf-8",
				cwd: projectDir,
			}).trim();
		} catch {
			branch = undefined;
		}
	}

	const catalog = await listBranchCatalog(projectDir);

	if (branch) {
		const exact = catalog.branches.find((b) => b.branch === branch);
		if (exact) {
			const ctx = await compileTaskContext(
				{
					branch,
					depth: options.depth,
					tokenBudget: options.budget ?? DEFAULT_TOKEN_BUDGET,
					includeTranscripts: options.includeTranscripts,
					includePlans: options.includePlans !== false,
				},
				projectDir,
			);
			if (ctx.commitCount === 0) {
				return { type: "error", message: `No Jolli Memory records found for branch "${branch}".` };
			}
			return buildRecallPayload(ctx, options.budget ?? DEFAULT_TOKEN_BUDGET);
		}
		return { ...catalog, query: branch };
	}

	if (catalog.branches.length === 0) {
		return { type: "error", message: "No Jolli Memory records found in this repository." };
	}
	return catalog;
}
