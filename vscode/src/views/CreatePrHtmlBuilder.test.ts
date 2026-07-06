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

	it("does not throw when a scenario's steps/expectedResults are not arrays (malformed summary JSON)", () => {
		// steps/expectedResults are typed as required arrays, but the summary is
		// deserialized from orphan-branch JSON with no read-time validation — an
		// older schema or hand-edited file can leave them undefined. The panel is
		// built in one synchronous pass with no render try/catch, so a TypeError
		// here would white-screen the whole Create-PR panel. Degrade to empty lists.
		const malformed = {
			...vm,
			e2eScenarios: [{ title: "Broken", steps: undefined, expectedResults: undefined }],
		} as unknown as CreatePrViewModel;
		let html = "";
		expect(() => {
			html = buildCreatePrHtml(malformed, "N");
		}).not.toThrow();
		expect(html).toContain("E2E Test Guide");
		expect(html).toContain("Broken");
		expect(html).toContain("<ol></ol>");
	});

	it("does not throw when e2eScenarios itself is not an array (malformed summary JSON)", () => {
		// The container is also unvalidated: a non-array truthy value makes the
		// spread / `.length` throw BEFORE the per-scenario guard runs. Degrade to
		// no E2E panel rather than white-screening the whole Create-PR panel.
		const malformed = { ...vm, e2eScenarios: { nope: true } } as unknown as CreatePrViewModel;
		let html = "";
		expect(() => {
			html = buildCreatePrHtml(malformed, "N");
		}).not.toThrow();
		// Non-array container degrades to empty → the E2E panel is omitted entirely.
		expect(html).not.toContain("E2E Test Guide");
	});

	it("does not throw when a scenario title is not a string (malformed summary JSON)", () => {
		// esc (escAttr) calls String.prototype.replace directly, so a non-string
		// title throws TypeError — the same white-screen class the guard targets.
		const malformed = {
			...vm,
			e2eScenarios: [{ title: null, steps: ["a"], expectedResults: ["b"] }],
		} as unknown as CreatePrViewModel;
		let html = "";
		expect(() => {
			html = buildCreatePrHtml(malformed, "N");
		}).not.toThrow();
		expect(html).toContain("E2E Test Guide");
	});

	it("does not throw when a scenario's step/result ELEMENTS are not strings (malformed summary JSON)", () => {
		// The container and title were already guarded, but the individual step /
		// expectedResult items still flow straight into esc (escAttr → .replace),
		// which throws TypeError on a non-string. A partially corrupted summary with
		// steps: [null] or expectedResults: [42] must degrade, not white-screen.
		const malformed = {
			...vm,
			e2eScenarios: [{ title: "Broken", steps: [null, 42], expectedResults: [42, null] }],
		} as unknown as CreatePrViewModel;
		let html = "";
		expect(() => {
			html = buildCreatePrHtml(malformed, "N");
		}).not.toThrow();
		expect(html).toContain("E2E Test Guide");
		expect(html).toContain("Broken");
		// Non-string elements coerce to a string (null/undefined → empty); the
		// numeric ones stringify. Two <li> entries are still emitted.
		expect(html).toContain("<li>42</li>");
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
		expect(html).not.toContain('id="pr-open-link"');
	});

	it("Edit is a full mode switch: view-mode wrapper, form labels, Cancel button, and toggle script", () => {
		const html = buildCreatePrHtml(vm, "N");
		// The read-only content lives in a #view-mode wrapper (visible initially);
		// the edit form starts hidden.
		expect(html).toContain('id="view-mode"');
		expect(html).toContain("edit-form hidden");
		// The form carries Title/Body labels bound to their inputs.
		expect(html).toContain('<label class="field-label" for="prTitleInput">Title</label>');
		expect(html).toContain('<label class="field-label" for="prBodyInput">Body</label>');
		// Edit mode's action row is Create PR + Cancel.
		expect(html).toContain('id="cmd-cancel"');
		// Clicking Edit hides the view and reveals the form; Cancel reverses it.
		expect(html).toContain("document.getElementById('view-mode').classList.add('hidden')");
		expect(html).toContain("document.getElementById('view-mode').classList.remove('hidden')");
	});

	it("update mode (existingPr): heading + buttons say Update and render a clickable PR link", () => {
		const html = buildCreatePrHtml(
			{ ...vm, existingPr: { number: 7, url: "https://github.com/o/r/pull/7" } },
			"N",
		);
		expect(html).toContain("Update Pull Request");
		expect(html).toContain(">Update PR<");
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

	it("renders a 'Previously:' strip with a clickable link per closed/merged PR", () => {
		const html = buildCreatePrHtml(
			{
				...vm,
				prHistory: [
					{ number: 271, url: "https://github.com/o/r/pull/271", state: "MERGED" },
					{ number: 251, url: "https://github.com/o/r/pull/251", state: "CLOSED" },
				],
			},
			"N",
		);
		expect(html).toContain('class="pr-history"');
		expect(html).toContain("Previously:");
		expect(html).toContain('data-pr-url="https://github.com/o/r/pull/271"');
		expect(html).toContain("#271 (merged)");
		expect(html).toContain('data-pr-url="https://github.com/o/r/pull/251"');
		expect(html).toContain("#251 (closed)");
		// The history links reuse the openPr message via class-based wiring.
		expect(html).toContain(".pr-history-link");
	});

	it("shows the 'Previously:' strip alongside an open PR (merged + open coexist)", () => {
		const html = buildCreatePrHtml(
			{
				...vm,
				existingPr: { number: 300, url: "https://github.com/o/r/pull/300" },
				prHistory: [{ number: 271, url: "https://github.com/o/r/pull/271", state: "MERGED" }],
			},
			"N",
		);
		expect(html).toContain('id="pr-open-link"'); // open PR pill
		expect(html).toContain("PR #300");
		expect(html).toContain('class="pr-history"'); // history strip too
		expect(html).toContain("#271 (merged)");
	});

	it("omits the 'Previously:' strip when there is no closed/merged PR history", () => {
		expect(buildCreatePrHtml(vm, "N")).not.toContain('class="pr-history"');
		expect(buildCreatePrHtml({ ...vm, prHistory: [] }, "N")).not.toContain('class="pr-history"');
	});

	it("escapes the history PR url to prevent attribute injection", () => {
		const html = buildCreatePrHtml(
			{ ...vm, prHistory: [{ number: 1, url: 'https://x/"><img onerror=1>', state: "MERGED" }] },
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

	it("disables the Edit button (not just the submit buttons) for the duration of the operation", () => {
		const html = buildCreatePrHtml(vm, "N");
		// Edit joins the submit buttons in the in-flight disable set so the user
		// can't switch into the edit form while a push + create/update is running.
		// It re-enables via the terminal settle messages (prComplete / prCreateFailed).
		expect(html).toContain("disableWhileInFlight");
		expect(html).toContain("['cmd-edit']");
		expect(html).toContain("disableWhileInFlight.forEach(function (b) { b.disabled = on; });");
	});

	it("styles disabled buttons as greyed-out + not-allowed (the .btn bg would otherwise hide it)", () => {
		const html = buildCreatePrHtml(vm, "N");
		expect(html).toContain(".btn:disabled { opacity: 0.5; cursor: not-allowed; }");
		// Hover must not light up a disabled button, or it would still read clickable.
		expect(html).toContain(".btn:not(:disabled):hover");
		expect(html).toContain(".btn.secondary:not(:disabled):hover");
	});

	it("renders a progress line below the buttons in both view and edit modes", () => {
		const html = buildCreatePrHtml(vm, "N");
		// One .pr-progress line per mode — only the visible mode's line shows, so
		// the step text is visible whether the user submitted from view or edit.
		const matches = html.match(/class="pr-progress hidden"/g) ?? [];
		expect(matches).toHaveLength(2);
		// role="status" + aria-live so screen readers announce each step.
		expect(html).toContain('role="status" aria-live="polite"');
	});

	it("surfaces host prProgress steps below the buttons and clears them on settle", () => {
		const html = buildCreatePrHtml(vm, "N");
		// The listener renders prProgress text (keeping buttons disabled) and wipes
		// it on every settle message so a stale step never lingers after success/fail.
		expect(html).toContain("case 'prProgress':");
		expect(html).toContain("setProgress(msg.text);");
		expect(html).toContain("setProgress('');");
		// Instant feedback on click, before the host's first step message arrives.
		expect(html).toContain("setProgress('Starting…');");
	});

	it("treats only prComplete/failure as terminal settle — prStatus fires mid-flight and no longer re-enables", () => {
		const html = buildCreatePrHtml(vm, "N");
		// prComplete is the whole-operation settle (PR + memory push). It returns to
		// the read-only view so an update submitted from the edit form dismisses it.
		expect(html).toContain("case 'prComplete':");
		expect(html).toContain("showViewMode();");
		// prStatus is posted between the PR and the memory push, so it must NOT be a
		// settle case — otherwise the buttons would re-enable before the share runs.
		expect(html).not.toContain("case 'prStatus':");
	});

	it("omits codicon glyph, stylesheet link and font-src when no assets are supplied", () => {
		const html = buildCreatePrHtml(vm, "N");
		expect(html).not.toContain("codicon-git-pull-request");
		expect(html).not.toContain('rel="stylesheet"');
		// Tighter nonce-only CSP: no cspSource origin, no font-src directive.
		expect(html).toContain("style-src 'nonce-N'; script-src 'nonce-N';");
		expect(html).not.toContain("font-src");
	});

	it("renders the pull-request glyph, links codicon.css and allowlists it in CSP when assets are supplied", () => {
		const html = buildCreatePrHtml(vm, "N", {
			cspSource: "vscode-webview://abc",
			codiconCssUri: "https://file+.vscode-resource/codicon.css",
		});
		// Both submit buttons carry the glyph (matching the design mockup).
		expect(html.match(/codicon-git-pull-request/g)?.length).toBe(2);
		expect(html).toContain('<link rel="stylesheet" href="https://file+.vscode-resource/codicon.css" />');
		// CSP allowlists the asset origin for both the stylesheet and its font.
		expect(html).toContain("style-src vscode-webview://abc 'nonce-N'");
		expect(html).toContain("font-src vscode-webview://abc");
	});

	it("uses singular 'memory'/'file' labels in the meta strip when counts are 1", () => {
		const html = buildCreatePrHtml({ ...vm, memoryCount: 1, filesChanged: 1 }, "N");
		expect(html).toContain("drafted from 1 memory");
		expect(html).toContain("1 file<");
		expect(html).not.toContain("1 memories");
		expect(html).not.toContain("1 files");
	});

	it("signed-out (default): renders the Sign In link with the signed-out notice visible and the signed-in one hidden", () => {
		const html = buildCreatePrHtml(vm, "N");
		// The signed-out variant is visible (no `hidden` class on its span) and
		// carries the Sign In link; the signed-in confirmation starts hidden.
		expect(html).toContain('id="pr-signin-link"');
		expect(html).toContain(">Sign In<");
		expect(html).toContain("share these memories to Jolli Space when you create the PR");
		expect(html).toContain('class="share-signed-in hidden"');
		expect(html).toContain('class="share-signed-out"');
		// The signed-out variant must NOT carry the hidden class.
		expect(html).not.toContain('class="share-signed-out hidden"');
	});

	it("signed-in: shows the confirmation notice and hides the signed-out Sign In variant", () => {
		const html = buildCreatePrHtml({ ...vm, signedIn: true }, "N");
		expect(html).toContain("creating this PR also shares the included memories to your Jolli Space");
		expect(html).toContain('class="share-signed-in"');
		expect(html).toContain('class="share-signed-out hidden"');
		// The Sign In link is still in the (hidden) DOM but the signed-in span is
		// the visible one.
		expect(html).not.toContain('class="share-signed-in hidden"');
	});

	it("wires the Sign In link and an authChanged listener that swaps the notice in place", () => {
		const html = buildCreatePrHtml(vm, "N");
		// The link posts a signIn command to the host.
		expect(html).toContain("command: 'signIn'");
		expect(html).toContain("getElementById('pr-signin-link')");
		// The host's authChanged message toggles the two notice variants without a
		// full re-render (which would wipe the edit form).
		expect(html).toContain("case 'authChanged'");
		expect(html).toContain("getElementById('share-signed-in')");
		expect(html).toContain("getElementById('share-signed-out')");
	});

	it("defines CSS rules for the share notice classes", () => {
		const html = buildCreatePrHtml(vm, "N");
		expect(html).toMatch(/\.share-notice\s*\{/);
		expect(html).toMatch(/\.share-signin-link\s*\{/);
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
