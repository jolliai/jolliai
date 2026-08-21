/**
 * The test-command heuristic's honesty, pinned to two REAL commands read off
 * this machine's transcripts (§7.3): a Claude `Bash` `input.command` and a Codex
 * `exec_command` `.cmd`, both running `npx vitest run`. The negative cases are
 * the point — a matcher that fires on `cat test.txt` invents a test run.
 */

import { describe, expect, it } from "vitest";
import { isTestCommand } from "./TestCommandDetect.js";

describe("isTestCommand", () => {
	it("recognises the real Claude Bash command (npx vitest run, redacted path)", () => {
		// cd /Users/flyer/…/cli && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository
		//   GIT_CONFIG_VALUE_0=all npx vitest run src/core/KBPathResolver.test.ts 2>&1 | tail -35
		expect(
			isTestCommand(
				"cd /…/cli && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npx vitest run src/core/KBPathResolver.test.ts 2>&1 | tail -35",
			),
		).toBe(true);
	});

	it("recognises the real Codex exec_command cmd (npx vitest run)", () => {
		expect(
			isTestCommand(
				"npx vitest run cli/src/core/SummaryFormat.test.ts cli/src/core/SummaryTree.test.ts cli/src/commands/ExportCommand.ts",
			),
		).toBe(true);
	});

	it("recognises the closed set of runner invocations", () => {
		for (const command of [
			"npm test",
			"npm t",
			"pnpm run test",
			"yarn test",
			"bun test",
			"deno test",
			"make test",
			"vitest",
			"jest --watch",
			"pytest tests/",
			"python -m pytest",
			"python3 -m unittest",
			"go test ./...",
			"cargo test",
			"mix test",
			"npx playwright test",
		]) {
			expect(isTestCommand(command)).toBe(true);
		}
	});

	it("never fires on a runner token as a substring of a non-test word", () => {
		expect(isTestCommand("cat test.txt")).toBe(false);
		expect(isTestCommand("grep vitest README.md")).toBe(false);
		expect(isTestCommand("vitest-config")).toBe(false);
		expect(isTestCommand("npx vitest-config")).toBe(false);
	});

	it("never fires on a non-exec or non-test command", () => {
		expect(isTestCommand("gh pr view 448 --json number,title,author")).toBe(false);
		expect(isTestCommand("npx tsc --noEmit")).toBe(false);
		expect(isTestCommand("git status --short")).toBe(false);
	});

	it("recognises a runner after a control operator and env assignments", () => {
		expect(isTestCommand("cd /repo && npm test")).toBe(true);
		expect(isTestCommand("FOO=bar npx vitest run")).toBe(true);
		expect(isTestCommand("pnpm install && pnpm test")).toBe(true);
	});
});
