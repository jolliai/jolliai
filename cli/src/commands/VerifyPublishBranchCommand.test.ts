import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVerifyPublishBranchCommand } from "./VerifyPublishBranchCommand.js";

// Thin wiring over the pure `checkPublishBranch`; drive the real command so its
// JSON print + exit-code wiring runs for real.
async function run(args: string[]): Promise<string> {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m?: unknown) => void logs.push(String(m)));
	const program = new Command();
	registerVerifyPublishBranchCommand(program);
	await program.parseAsync(["node", "jolli", "verify-publish-branch", ...args]);
	return logs.join("\n");
}

beforeEach(() => {
	process.exitCode = 0;
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("verify-publish-branch command", () => {
	it("prints { match: true } and exits 0 when the branches match", async () => {
		const out = await run(["jolli-agent-8226c9abc576", "jolli-agent-8226c9abc576"]);
		expect(JSON.parse(out)).toEqual({
			match: true,
			expected: "jolli-agent-8226c9abc576",
			actual: "jolli-agent-8226c9abc576",
		});
		expect(process.exitCode).toBe(0);
	});

	it("prints { match: false } and exits 1 when the publish landed on a different branch", async () => {
		const out = await run(["jolli-agent-8226c9abc576", "jolli-6e3a72e55c22"]);
		expect(JSON.parse(out)).toEqual({
			match: false,
			expected: "jolli-agent-8226c9abc576",
			actual: "jolli-6e3a72e55c22",
		});
		expect(process.exitCode).toBe(1);
	});

	it("exits 1 when headBranch is omitted (unverifiable publish)", async () => {
		const out = await run(["jolli-agent-8226c9abc576"]);
		expect(JSON.parse(out)).toEqual({ match: false, expected: "jolli-agent-8226c9abc576", actual: "" });
		expect(process.exitCode).toBe(1);
	});
});
