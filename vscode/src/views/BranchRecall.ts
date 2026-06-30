import { compileTaskContext, renderContextMarkdown } from "../../../cli/src/core/ContextCompiler.js";

export async function buildBranchRecallPrompt(
	cwd: string,
	branch: string,
): Promise<{ prompt: string; commitCount: number }> {
	const ctx = await compileTaskContext({ branch }, cwd);
	if (ctx.commitCount === 0) return { prompt: "", commitCount: 0 };
	return { prompt: renderContextMarkdown(ctx), commitCount: ctx.commitCount };
}
