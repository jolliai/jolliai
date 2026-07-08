import { describe, expect, it } from "vitest";
import { ghIssueCliBinding } from "./GhIssueCliBinding.js";

const matches = (cmd: string) => ghIssueCliBinding.matches(cmd);
const normalize = (b: unknown) => ghIssueCliBinding.normalize(b) as Record<string, unknown>;
const normalizeWith = (b: unknown, cmd: string) => ghIssueCliBinding.normalize(b, cmd) as Record<string, unknown>;

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
			"gh issue view 1 --repo cli/cli --json=number,title", // --json=fields equals form (valid on gh 2.85.0)
			"cd /repo; gh issue view 1 --json number", // `;` glued to the previous token
			"cd /x&&gh issue view 1 --json f", // `&&` glued with no surrounding spaces
			"cd C:\\repo; gh issue view 1 --json number", // PowerShell-style `;` separator
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

	describe("normalize — command fallback (payload missing number/url)", () => {
		it("derives number from the positional arg and synthesizes url from --repo", () => {
			const out = normalizeWith(
				{ title: "Log Tracing - TEST", state: "OPEN", body: "Body" },
				"gh issue view 1132 --repo jolliai/jolli --json title,body,state",
			);
			expect(out.number).toBe(1132);
			expect(out.html_url).toBe("https://github.com/jolliai/jolli/issues/1132");
		});

		it("derives everything from a URL positional arg", () => {
			const out = normalizeWith(
				{ title: "t", state: "open" },
				"gh issue view https://github.com/cli/cli/issues/42 --json title,state",
			);
			expect(out.number).toBe(42);
			expect(out.html_url).toBe("https://github.com/cli/cli/issues/42");
		});

		it("accepts the -R short form for the repo", () => {
			const out = normalizeWith({ title: "t" }, "gh -R octo/repo issue view 7 --json title");
			expect(out.number).toBe(7);
			expect(out.html_url).toBe("https://github.com/octo/repo/issues/7");
		});

		it("does not override a number/url already present in the payload", () => {
			const out = normalizeWith(
				{ number: 999, url: "https://github.com/real/repo/issues/999", title: "t" },
				"gh issue view 1132 --repo jolliai/jolli --json number,url,title",
			);
			expect(out.number).toBe(999);
			expect(out.html_url).toBe("https://github.com/real/repo/issues/999");
		});

		it("leaves number/url absent when the command carries no repo and no URL", () => {
			const out = normalizeWith({ title: "t" }, "gh issue view 5 --json title");
			// number alone cannot form a valid reference (no owner/repo, no url) — stays absent.
			expect(out.number).toBeUndefined();
			expect(out.html_url).toBeUndefined();
		});

		it("accepts the --repo=owner/repo equals form", () => {
			const out = normalizeWith({ title: "t" }, "gh issue view 8 --repo=octo/repo --json title");
			expect(out.number).toBe(8);
			expect(out.html_url).toBe("https://github.com/octo/repo/issues/8");
		});

		it("ignores a --repo value that is not owner/repo", () => {
			const out = normalizeWith({ title: "t" }, "gh issue view 8 --repo not-a-repo --json title");
			expect(out.number).toBeUndefined();
			expect(out.html_url).toBeUndefined();
		});

		it("finds the gh statement on a later line of a multi-line command", () => {
			const out = normalizeWith({ title: "t" }, "echo start\ngh issue view 3 --repo o/r --json title");
			expect(out.number).toBe(3);
			expect(out.html_url).toBe("https://github.com/o/r/issues/3");
		});

		it("derives from the --json statement, not an earlier gh line that produced no payload", () => {
			// The payload came from the SECOND statement (issue 5, the one with --json).
			// A prior non-JSON `gh issue view 99` must NOT hijack the selector.
			const out = normalizeWith(
				{ title: "t" },
				"gh issue view https://github.com/a/b/issues/99\ngh issue view 5 -R o/r --json title",
			);
			expect(out.number).toBe(5);
			expect(out.html_url).toBe("https://github.com/o/r/issues/5");
		});

		it("keeps a query string intact in a URL selector (bare & is not a token boundary)", () => {
			const out = normalizeWith(
				{ title: "t" },
				"gh issue view https://github.com/o/r/issues/42?foo=1&bar=2 --json title",
			);
			// The `&` inside the URL must not split the token and truncate the selector —
			// the whole URL (query included) survives to the reshaped payload.
			expect(out.number).toBe(42);
			expect(out.html_url).toBe("https://github.com/o/r/issues/42?foo=1&bar=2");
		});

		it("derives nothing when the command has no issue-number/URL selector", () => {
			// `gh issue view --json title` uses the current-branch context — no positional.
			const out = normalizeWith({ title: "t" }, "gh issue view --repo o/r --json title");
			expect(out.number).toBeUndefined();
			expect(out.html_url).toBeUndefined();
		});

		it("passes a non-object business through untouched even with a command", () => {
			expect(ghIssueCliBinding.normalize(42, "gh issue view 1 --repo o/r --json title")).toBe(42);
		});
	});
});
