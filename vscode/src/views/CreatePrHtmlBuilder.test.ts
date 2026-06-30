import { describe, expect, it } from "vitest";
import type { CreatePrViewModel } from "./CreatePrData";
import { buildCreatePrHtml } from "./CreatePrHtmlBuilder";

const vm: CreatePrViewModel = {
	branch: "feature/x",
	mainBranch: "main",
	memoryCount: 2,
	missingCount: 0,
	insertions: 184,
	deletions: 37,
	filesChanged: 5,
	title: "feat: redesign",
	bodyMarkdown: "**Summary**\n\nDoes things.",
	memories: [
		{ hash: "aaa1111", title: "Redesign" },
		{ hash: "bbb2222", title: "Fix" },
	],
	files: [{ path: "vscode/src/a.ts", dir: "vscode/src", status: "M" }],
	e2eScenarios: [],
};

describe("buildCreatePrHtml", () => {
	it("renders meta strip, title, memories and files; omits empty E2E", () => {
		const html = buildCreatePrHtml(vm, "NONCE");
		expect(html).toContain("Create Pull Request");
		expect(html).toContain("feature/x");
		expect(html).toContain("main");
		expect(html).toContain("+184");
		expect(html).toContain("−37"); // unicode minus
		expect(html).toContain('data-hash="aaa1111"');
		expect(html).toContain('data-path="vscode/src/a.ts"');
		expect(html).not.toContain("E2E Test Guide");
		expect(html).toContain('nonce="NONCE"');
	});

	it("renders the E2E panel when scenarios are present", () => {
		const html = buildCreatePrHtml(
			{ ...vm, e2eScenarios: [{ title: "Smoke", steps: ["s"], expectedResults: ["e"] }] },
			"N",
		);
		expect(html).toContain("E2E Test Guide");
		expect(html).toContain("Smoke");
	});

	it("escapes HTML in titles to prevent injection", () => {
		const html = buildCreatePrHtml({ ...vm, title: "<img src=x onerror=1>" }, "N");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img");
	});

	it("includes a hidden edit form with title and body inputs", () => {
		const html = buildCreatePrHtml(vm, "N");
		expect(html).toContain('id="prTitleInput"');
		expect(html).toContain('id="prBodyInput"');
		expect(html).toContain("edit-form hidden");
	});

	it("defines CSS rules for the edit form's classes (no undefined .edit-form/.pr-input/.pr-textarea)", () => {
		// The edit form references .edit-form / .pr-input / .pr-textarea; without
		// matching rules in buildCss the inputs render unstyled. Pin that each
		// class has a defining rule (a `{` selector block), not just a usage.
		const html = buildCreatePrHtml(vm, "N");
		expect(html).toMatch(/\.edit-form\s*\{/);
		expect(html).toMatch(/\.pr-input\s*\{/);
		expect(html).toMatch(/\.pr-textarea\s*\{/);
	});

	it("renders '· PR #N' suffix on a memory row that has a prNumber", () => {
		const html = buildCreatePrHtml(
			{
				...vm,
				memories: [
					{ hash: "aaa1111", title: "First" },
					{ hash: "bbb2222", title: "Second", prNumber: 214 },
				],
			},
			"N",
		);
		expect(html).toContain("· PR #214");
		// Memory without prNumber must NOT produce a PR link.
		expect(html).not.toContain("· PR #undefined");
	});

	it("renders E2E scenario steps and expectedResults when present", () => {
		const html = buildCreatePrHtml(
			{
				...vm,
				e2eScenarios: [
					{
						title: "Full flow",
						steps: ["Open the panel", "Click Create PR"],
						expectedResults: ["PR is created", "Panel closes"],
					},
				],
			},
			"N",
		);
		expect(html).toContain("E2E Test Guide");
		expect(html).toContain("Full flow");
		expect(html).toContain("<li>Open the panel</li>");
		expect(html).toContain("<li>Click Create PR</li>");
		expect(html).toContain("PR is created");
		expect(html).toContain("Panel closes");
		expect(html).toContain("1 SCENARIO");
	});

	it("renders plural SCENARIOS label when there are multiple scenarios", () => {
		const html = buildCreatePrHtml(
			{
				...vm,
				e2eScenarios: [
					{ title: "S1", steps: ["step1"], expectedResults: ["result1"] },
					{ title: "S2", steps: ["step2"], expectedResults: ["result2"] },
				],
			},
			"N",
		);
		expect(html).toContain("2 SCENARIOS");
	});

	it("create mode (no existingPr): heading + buttons say Create, no PR link", () => {
		const html = buildCreatePrHtml(vm, "N");
		expect(html).toContain("Create Pull Request");
		expect(html).toContain(">Create PR<");
		expect(html).toContain("Create with these");
		expect(html).not.toContain('id="pr-open-link"');
	});

	it("update mode (existingPr): heading + buttons say Update and render a clickable PR link", () => {
		const html = buildCreatePrHtml(
			{ ...vm, existingPr: { number: 7, url: "https://github.com/o/r/pull/7" } },
			"N",
		);
		expect(html).toContain("Update Pull Request");
		expect(html).toContain(">Update PR<");
		expect(html).toContain("Update with these");
		expect(html).toContain('id="pr-open-link"');
		expect(html).toContain('data-pr-url="https://github.com/o/r/pull/7"');
		expect(html).toContain("PR #7");
		// Clicking the link posts an openPr message.
		expect(html).toContain("command: 'openPr'");
	});

	it("escapes the PR url to prevent attribute injection", () => {
		const html = buildCreatePrHtml(
			{ ...vm, existingPr: { number: 1, url: 'https://x/"><img onerror=1>' } },
			"N",
		);
		expect(html).not.toContain('"><img onerror=1>');
		expect(html).toContain("&quot;&gt;&lt;img");
	});

	it("wires a message listener and an in-flight submit guard so a double-click can't fire twice", () => {
		const html = buildCreatePrHtml(vm, "N");
		// #3: the script must listen for host-posted lifecycle messages so the
		// buttons re-enable after a failure / block instead of staying stuck.
		expect(html).toContain("window.addEventListener('message'");
		expect(html).toContain("'prCreating'");
		expect(html).toContain("'prCreateFailed'");
		expect(html).toContain("'prCreateBlockedCrossBranch'");
		// #3: the in-flight guard short-circuits a second submit before the host
		// responds — without it a double-click runs two push + create flows.
		expect(html).toContain("if (inFlight) return;");
		expect(html).toContain("b.disabled = on;");
	});

	it("renders a file whose path has no slash using the full path as filename with empty dir", () => {
		const html = buildCreatePrHtml(
			{
				...vm,
				files: [{ path: "README.md", dir: "", status: "M" }],
			},
			"N",
		);
		// pop() on a path with no slash returns undefined, so the fallback ?? f.path applies.
		expect(html).toContain("README.md");
		expect(html).toContain('data-path="README.md"');
	});
});
