/**
 * Single source of truth for "what does recall return for this input" — the
 * type-tagged discriminated union the jolli-recall skill consumes. Both the CLI
 * `recall --format json` path and the MCP `recall` tool call this, so their
 * results are byte-identical by construction.
 */
import { SAFE_ARGUMENT_PATTERN } from "../commands/CliUtils.js";
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
