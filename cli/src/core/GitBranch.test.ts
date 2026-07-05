import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../util/Subprocess.js", async () => {
	const actual = await vi.importActual<typeof import("../util/Subprocess.js")>("../util/Subprocess.js");
	return {
		...actual,
		execFileSyncHidden: vi.fn(() => "main\n"),
	};
});

import { execFileSyncHidden } from "../util/Subprocess.js";
import { getCurrentBranchSafe } from "./GitBranch.js";

const mockExecFileSyncHidden = vi.mocked(execFileSyncHidden);

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("getCurrentBranchSafe", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the trimmed branch name on success", () => {
		mockExecFileSyncHidden.mockReturnValue("main\n");
		expect(getCurrentBranchSafe("/repo")).toBe("main");
		expect(mockExecFileSyncHidden).toHaveBeenCalledWith(
			"git",
			["rev-parse", "--abbrev-ref", "HEAD"],
			expect.objectContaining({ cwd: "/repo" }),
		);
	});

	it("returns 'unknown' when the command yields only whitespace", () => {
		mockExecFileSyncHidden.mockReturnValue("  \n");
		expect(getCurrentBranchSafe("/repo")).toBe("unknown");
	});

	it("returns 'unknown' when the command throws", () => {
		mockExecFileSyncHidden.mockImplementation(() => {
			throw new Error("not a git repo");
		});
		expect(getCurrentBranchSafe("/repo")).toBe("unknown");
	});
});
