import { describe, expect, it, vi } from "vitest";

vi.mock("../../../cli/src/core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn().mockResolvedValue({ commitCount: 0 }),
	renderContextMarkdown: vi.fn().mockReturnValue("# Recall\n"),
}));

import { compileTaskContext, renderContextMarkdown } from "../../../cli/src/core/ContextCompiler.js";
import { buildBranchRecallPrompt } from "./BranchRecall";

describe("buildBranchRecallPrompt", () => {
	it("returns commitCount 0 and skips markdown render when the branch is empty", async () => {
		const res = await buildBranchRecallPrompt("/repo", "feature/x");
		expect(res.commitCount).toBe(0);
		expect(res.prompt).toBe("");
		expect(renderContextMarkdown).not.toHaveBeenCalled();
		expect(compileTaskContext).toHaveBeenCalledWith({ branch: "feature/x" }, "/repo");
	});

	it("renders the markdown prompt when commits exist", async () => {
		(compileTaskContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ commitCount: 3 });
		const res = await buildBranchRecallPrompt("/repo", "feature/x");
		expect(res.commitCount).toBe(3);
		expect(res.prompt).toBe("# Recall\n");
		expect(renderContextMarkdown).toHaveBeenCalled();
	});
});
