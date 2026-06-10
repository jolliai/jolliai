import { describe, expect, it } from "vitest";
import { ghIssueCliBinding } from "./GhIssueCliBinding.js";

const matches = (cmd: string) => ghIssueCliBinding.matches(cmd);
const normalize = (b: unknown) => ghIssueCliBinding.normalize(b) as Record<string, unknown>;

describe("ghIssueCliBinding", () => {
	it("has the github identity + canonical tool name", () => {
		expect(ghIssueCliBinding.id).toBe("github");
		expect(ghIssueCliBinding.canonicalToolName).toBe("mcp__github__issue_read");
	});

	describe("matches — positives", () => {
		it.each([
			"gh issue view 959 --repo jolliai/jolli --json number,title",
			"GH_TOKEN=x gh issue view 1 --json f",
			"FOO=bar BAZ=qux gh issue view 1 --json f",
			"cd /x && gh issue view 1 --json f",
			"false || gh issue view 1 --json f",
			"gh issue view 1 --json number | jq .",
			"gh issue view 1 --json number 2>/dev/null",
			"/usr/bin/gh issue view 1 --json f",
			"gh.exe issue view 1 --json f",
			"gh issue view --json f", // gh defaults to current-branch context; number not required
			"cd /repo\ngh issue view 1 --json f", // gh on its own line after a prior statement
			"# fetch the issue\ngh issue view 1 --json f", // comment line above the command
			"gh --repo cli/cli issue view 1 --json title", // global --repo BEFORE subcommand (valid on gh 2.85.0)
			"gh -R cli/cli issue view 1 --json title", // global -R BEFORE subcommand (valid on gh 2.85.0)
		])("matches %j", (cmd) => {
			expect(matches(cmd)).toBe(true);
		});
	});

	describe("matches — negatives", () => {
		it.each([
			"gh pr view 1 --json", // different subcommand
			"gh issue list --json", // not `view`
			"gh issue viewer --json", // not exactly `view`
			"gh issue view 1", // no --json
			"gh issue view 1 --jsonfoo", // --json not a standalone flag
			"gh issue --json view", // a flag splits the `issue view` pair (not consecutive)
			'echo "gh issue view 1 --json"', // quoted mention, echo is the executable
			"# gh issue view 1 --json", // whole line is a comment
			"gh foo # gh issue view 1 --json", // the real gh is `gh foo`; the rest is a comment
			"mygh issue view 1 --json", // executable is not gh
			"github issue view 1 --json", // executable is not gh
			"sudo gh issue view 1 --json", // gh not at command position (wrapper command)
			"",
		])("does not match %j", (cmd) => {
			expect(matches(cmd)).toBe(false);
		});
	});

	describe("normalize", () => {
		it("reshapes a real `gh issue view --json` payload and lowercases state", () => {
			const out = normalize({
				number: 959,
				title: "Support multi-source external entity auto-discovery",
				state: "CLOSED",
				url: "https://github.com/jolliai/jolli/issues/959",
				body: "Body text",
				labels: [{ name: "enhancement" }, { name: "JolliMemory" }],
				assignees: [{ login: "sanshizhang-jolli" }],
				author: { login: "sanshizhang-jolli" },
			});
			expect(out.number).toBe(959);
			expect(out.html_url).toBe("https://github.com/jolliai/jolli/issues/959");
			expect(out.state).toBe("closed"); // CLOSED → closed (gh-only normalization)
			expect(out.labels).toEqual(["enhancement", "JolliMemory"]);
			expect(out.assignees).toEqual(["sanshizhang-jolli"]);
		});

		it("leaves a non-string state untouched", () => {
			const out = normalize({ number: 1, title: "t", url: "https://github.com/o/r/issues/1", state: null });
			expect(out.state).toBeUndefined(); // reshape only copies string state
		});

		it("passes through a non-object business value", () => {
			expect(ghIssueCliBinding.normalize(42)).toBe(42);
		});
	});
});
