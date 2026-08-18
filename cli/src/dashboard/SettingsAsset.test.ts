/**
 * Runtime smoke test for the Settings page renderer (`assets/js/settings.js`).
 *
 * `assets/js/*.js` is plain JavaScript, never type-checked by tsc, so a typo in
 * a field name or a broken template renders silently in the browser. This
 * evaluates the real IIFE against a stub window/document and asserts each of the
 * five section renderers, following the pattern of `FeedCardAsset.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface FakeButton {
	getAttribute: (name: string) => string | null;
	onclick?: () => void;
	onchange?: () => void;
	oninput?: () => void;
}

interface FakeElement {
	innerHTML: string;
	insertAdjacentHTML: (pos: string, html: string) => void;
}

const SECTION_IDS = ["agents", "summary", "sync", "bank", "others"];

/**
 * Loads format.js → settings.js against a stub window/document. The document's
 * `querySelectorAll(".set-rail-item")` returns five persistent fake buttons so
 * the test can drive section switches; every other selector returns []. The
 * async `JD` helpers are stubbed to never-resolving promises so the lazy loads
 * that fire on the sync/bank sections make no real request.
 */
function loadJD(): { renderSettings: (model: unknown) => void; app: FakeElement; rail: Map<string, FakeButton> } {
	const app: FakeElement = { innerHTML: "", insertAdjacentHTML: () => undefined };
	const rail = new Map<string, FakeButton>(
		SECTION_IDS.map((id) => [id, { getAttribute: (n: string) => (n === "data-section" ? id : null) }]),
	);
	const doc = {
		getElementById: (id: string) => (id === "settingsModalBody" ? app : { innerHTML: "", textContent: "" }),
		querySelectorAll: (sel: string) => (sel.includes(".set-rail-item") ? [...rail.values()] : []),
		querySelector: () => null,
		addEventListener: () => undefined,
		createElement: () => ({ innerHTML: "" }),
		body: { innerHTML: "" },
	};
	const win = {
		JD: {
			getJson: () => new Promise(() => {}),
			post: () => new Promise(() => {}),
			refreshNow: () => undefined,
			renderPage: () => undefined,
		},
		document: doc,
		addEventListener: () => undefined,
	} as Record<string, unknown>;
	for (const file of ["format.js", "settings.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}
	const JD = win.JD as { renderSettings: (model: unknown) => void };
	return { renderSettings: JD.renderSettings, app, rail };
}

const MODEL = {
	view: "settings",
	settings: {
		agents: {
			claudeEnabled: true,
			codexEnabled: false,
			geminiEnabled: true,
			openCodeEnabled: true,
			cursorEnabled: true,
			devinEnabled: true,
			copilotEnabled: true,
			clineEnabled: true,
			antigravityEnabled: true,
			kimiEnabled: true,
			globalInstructions: "default",
		},
		summary: {
			aiProvider: "anthropic",
			model: "opus",
			apiKeyMasked: "sk-ant-abcde****mnop",
			jolliApiKeyMasked: "",
			signedIn: false,
			hasJolliKey: false,
			localAgentTool: "claude-code",
			localAgentTools: [{ id: "claude-code", label: "Claude Code" }],
			localAgentModel: "haiku",
			localAgentModels: {
				"claude-code": [
					{ id: "haiku", label: "Haiku — fastest" },
					{ id: "sonnet", label: "Sonnet — balanced (default)", isDefault: true },
					{ id: "inherit", label: "Use Claude Code's own setting" },
				],
			},
		},
		memoryBank: { localFolder: "/mem/bank", compileExcludeFolders: "archive", syncTranscripts: false },
		others: { dcoSignoff: true, excludePatterns: "*.lock" },
	},
};

describe("settings.js renderSettings", () => {
	it("renders the section rail and the default AI Agents section", () => {
		const { renderSettings, app } = loadJD();
		renderSettings(MODEL);
		for (const label of ["AI Agents", "AI Summary", "Sync to Jolli", "Memory Bank", "Others"]) {
			expect(app.innerHTML).toContain(label);
		}
		expect(app.innerHTML).toContain("Claude Code");
		expect(app.innerHTML).toContain("Kimi Code");
		expect(app.innerHTML).toContain("Apply Changes");
	});

	it("renders each of the five section renderers with its distinctive content", () => {
		const { renderSettings, app, rail } = loadJD();
		renderSettings(MODEL);
		const go = (id: string) => rail.get(id)?.onclick?.();

		go("summary");
		expect(app.innerHTML).toContain("Provider");
		// The MASKED key reaches the page verbatim — never the full key.
		expect(app.innerHTML).toContain("sk-ant-abcde****mnop");
		expect(app.innerHTML).toContain("Opus");

		go("sync");
		expect(app.innerHTML).toContain("Outbound push per repo");

		go("bank");
		expect(app.innerHTML).toContain("Folder Path");
		expect(app.innerHTML).toContain("/mem/bank");

		go("others");
		expect(app.innerHTML).toContain("Exclude Patterns");
		expect(app.innerHTML).toContain("Sign commits with DCO");
	});

	it("survives a settings payload missing optional sections, still rendering each section's own content", () => {
		const { renderSettings, app, rail } = loadJD();
		renderSettings({ view: "settings", settings: {} });
		// Each section must render its OWN distinctive markup even with an empty
		// payload (proves the `|| {}` defaults hold in every renderer, not just that
		// the static card header is present).
		const markers: Record<string, string> = {
			agents: "Claude Code",
			summary: "Provider",
			sync: "Outbound push per repo",
			bank: "Folder Path",
			others: "Exclude Patterns",
		};
		for (const id of SECTION_IDS) {
			rail.get(id)?.onclick?.();
			expect(app.innerHTML).toContain(markers[id]);
		}
	});
});

/**
 * Field-stub harness for the interaction layer (captureField → collect → doApply).
 * The rendering harness above returns [] for `[data-field]`, so it never exercises
 * edits; this returns persistent field stubs and captures the Apply POST body.
 */
interface FieldStub {
	getAttribute: (n: string) => string | null;
	type: string;
	checked: boolean;
	value: string;
	onchange?: () => void;
	oninput?: () => void;
}

function loadFormJD(): {
	fields: Map<string, FieldStub>;
	applyBtn: { onclick?: () => void };
	posts: { path: string; body: Record<string, unknown> }[];
} {
	const posts: { path: string; body: Record<string, unknown> }[] = [];
	const app = { innerHTML: "", insertAdjacentHTML: () => undefined };
	const applyBtn: { onclick?: () => void } = {};
	const field = (name: string, type: string): FieldStub => ({
		getAttribute: (n: string) => (n === "data-field" ? name : null),
		type,
		checked: false,
		value: "",
	});
	const fields = new Map<string, FieldStub>([
		["globalInstructions", field("globalInstructions", "checkbox")],
		["codexEnabled", field("codexEnabled", "checkbox")],
		["maxTokens", field("maxTokens", "number")],
	]);
	const doc = {
		getElementById: (id: string) =>
			id === "settingsModalBody" ? app : id === "applyBtn" ? applyBtn : { innerHTML: "", textContent: "" },
		querySelectorAll: (sel: string) => (sel.includes("[data-field]") ? [...fields.values()] : []),
		querySelector: () => null,
		addEventListener: () => undefined,
		createElement: () => ({ innerHTML: "" }),
		body: { innerHTML: "" },
	};
	const win = {
		JD: {
			getJson: () => new Promise(() => {}),
			post: (path: string, body: Record<string, unknown>) => {
				posts.push({ path, body });
				return Promise.resolve({ ok: true, hookFailures: [] });
			},
			refreshNow: () => undefined,
			renderPage: () => undefined,
		},
		document: doc,
		addEventListener: () => undefined,
	} as Record<string, unknown>;
	for (const f of ["format.js", "settings.js"]) {
		new Function("window", "document", readFileSync(new URL(`./assets/js/${f}`, import.meta.url), "utf8"))(
			win,
			doc,
		);
	}
	// render() → wire() assigns applyBtn.onclick and the fields' on* handlers.
	(win.JD as { renderSettings: (m: unknown) => void }).renderSettings(MODEL);
	return { fields, applyBtn, posts };
}

describe("settings.js form wiring", () => {
	it("captures edits and assembles the Apply payload from the controlled form", () => {
		const { fields, applyBtn, posts } = loadFormJD();

		// Edit through the real captureField handlers wire() attached.
		const gi = fields.get("globalInstructions");
		if (gi) {
			gi.checked = true;
			gi.onchange?.(); // tri-state: checked → "enabled"
		}
		const maxTokens = fields.get("maxTokens");
		if (maxTokens) {
			maxTokens.value = "4096";
			maxTokens.oninput?.();
		}

		applyBtn.onclick?.(); // → doApply → collect() → JD.post

		const apply = posts.find((p) => p.path === "/api/settings/apply");
		expect(apply).toBeTruthy();
		const body = apply?.body as Record<string, unknown>;
		expect(body.globalInstructions).toBe("enabled"); // captured tri-state
		expect(body.maxTokens).toBe(4096); // string → number in collect()
		expect(body.codexEnabled).toBe(false); // seeded from MODEL, untouched
		expect(body.aiProvider).toBe("anthropic"); // seeded, untouched
		expect(body.dcoSignoff).toBe(true); // seeded from MODEL.others
	});
});

describe("settings.js local-agent model picker", () => {
	/** The AI Summary section markup with the provider forced to local-agent. */
	function summaryHtml(over: Record<string, unknown> = {}): string {
		const { renderSettings, app, rail } = loadJD();
		const model = structuredClone(MODEL) as typeof MODEL;
		const summary = model.settings.summary as Record<string, unknown>;
		summary.aiProvider = "local-agent";
		Object.assign(summary, over);
		renderSettings(model);
		rail.get("summary")?.onclick?.();
		return app.innerHTML;
	}

	it("renders the model picker for a pinned tool, selecting the stored value", () => {
		const html = summaryHtml();
		expect(html).toContain('id="localAgentModel"');
		expect(html).toContain('data-field="localAgentModel"');
		expect(html).toContain("Haiku — fastest");
		// The stored value is what must come back selected — a picker that always
		// showed the first option would silently misreport the machine's setting.
		expect(html).toMatch(/value="haiku"[^>]*selected/);
	});

	it("offers the inherit escape hatch, with its label HTML-escaped", () => {
		// Labels go through `esc()` like every other server-provided string, so the
		// apostrophe arrives as an entity — asserting the raw form would pass only
		// by accident of the label's wording.
		expect(summaryHtml()).toContain("Use Claude Code&#39;s own setting");
	});

	it("hides the row for a tool with no pinned models", () => {
		// An unpinned tool defers to its own configuration, so offering a model
		// control for it would promise a setting that does nothing. The row is
		// driven by the tool's ABSENCE from the map, never by naming tools here —
		// which is what let codex move from unpinned to pinned without touching it.
		const html = summaryHtml({
			localAgentTool: "opencode",
			localAgentTools: [{ id: "opencode", label: "OpenCode" }],
		});
		expect(html).toContain('id="localAgentTool"');
		expect(html).not.toContain('id="localAgentModel"');
	});

	it("selects the marked default when the payload's model is unusable, not the first option", () => {
		// The trap: `opt()` marks selected by strict equality, so a value matching
		// no option selects NOTHING and the browser shows the first one — which is
		// Haiku, because the list is ordered to match the Anthropic picker and the
		// default sits in the middle. Displayed and submitted would disagree.
		const html = summaryHtml({ localAgentModel: "" });
		expect(html).toMatch(/value="sonnet"[^>]*selected/);
		expect(html).not.toMatch(/value="haiku"[^>]*selected/);
	});

	it("falls back to the first option when no entry is marked default", () => {
		// An older server sends the list without the marker; showing SOMETHING
		// selected still beats letting the browser and the form state disagree.
		const html = summaryHtml({
			localAgentModel: "gone",
			localAgentModels: { "claude-code": [{ id: "haiku", label: "Haiku — fastest" }] },
		});
		expect(html).toMatch(/value="haiku"[^>]*selected/);
	});

	it("hides the row when the payload carries no model map at all", () => {
		// An older server (or a partial payload) must degrade to "no picker",
		// never to a picker with an empty dropdown.
		const html = summaryHtml({ localAgentModels: undefined });
		expect(html).not.toContain('id="localAgentModel"');
	});

	it("submits the selected model in the Apply payload", () => {
		const { fields, applyBtn, posts } = loadFormJD();
		applyBtn.onclick?.();
		const body = posts.find((p) => p.path === "/api/settings/apply")?.body as Record<string, unknown>;
		// Seeded from the payload and carried through collect() untouched — the
		// field has to survive a save that edited something else entirely.
		expect(body.localAgentModel).toBe("haiku");
		expect(fields).toBeTruthy();
	});
});

/**
 * Tool-switch harness: renders like `loadJD` but also serves a `localAgentTool`
 * field stub to `wire()`, so the real `onchange` handler runs. `loadJD` returns
 * [] for `[data-field]` (so it never exercises edits) and `loadFormJD` does not
 * expose the rendered markup — this needs both.
 */
function loadToolSwitchJD(): {
	app: { innerHTML: string };
	rail: Map<string, FakeButton>;
	tool: FieldStub;
	render: (model: unknown) => void;
} {
	const app = { innerHTML: "", insertAdjacentHTML: () => undefined };
	const rail = new Map<string, FakeButton>(
		SECTION_IDS.map((id) => [id, { getAttribute: (n: string) => (n === "data-section" ? id : null) }]),
	);
	const tool: FieldStub = {
		getAttribute: (n: string) => (n === "data-field" ? "localAgentTool" : null),
		type: "select-one",
		checked: false,
		value: "claude-code",
	};
	const doc = {
		getElementById: (id: string) => (id === "settingsModalBody" ? app : { innerHTML: "", textContent: "" }),
		querySelectorAll: (sel: string) =>
			sel.includes("[data-field]") ? [tool] : sel.includes(".set-rail-item") ? [...rail.values()] : [],
		querySelector: () => null,
		addEventListener: () => undefined,
		createElement: () => ({ innerHTML: "" }),
		body: { innerHTML: "" },
	};
	const win = {
		JD: {
			getJson: () => new Promise(() => {}),
			post: () => new Promise(() => {}),
			refreshNow: () => undefined,
			renderPage: () => undefined,
		},
		document: doc,
		addEventListener: () => undefined,
	} as Record<string, unknown>;
	for (const f of ["format.js", "settings.js"]) {
		new Function("window", "document", readFileSync(new URL(`./assets/js/${f}`, import.meta.url), "utf8"))(
			win,
			doc,
		);
	}
	return { app, rail, tool, render: (win.JD as { renderSettings: (m: unknown) => void }).renderSettings };
}

describe("settings.js Agent-tool switching", () => {
	it("re-renders the model row when the tool changes, not only on a provider change", () => {
		// `localAgentModels` is keyed by tool precisely because switching the picker
		// is a client-side state change that never refetches the payload. With only
		// `aiProvider` in the re-render set, the row kept showing the PREVIOUS
		// tool's options — offering models for a tool that pins none, and hiding
		// the row for one that does — until an unrelated toggle happened to
		// re-render. Both earlier tests set the payload tool and the form tool to
		// the same value, so neither could see it.
		const { app, rail, tool, render } = loadToolSwitchJD();
		const model = structuredClone(MODEL) as typeof MODEL;
		const summary = model.settings.summary as Record<string, unknown>;
		summary.aiProvider = "local-agent";
		summary.localAgentTools = [
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		];
		render(model);
		rail.get("summary")?.onclick?.();
		expect(app.innerHTML).toContain('id="localAgentModel"');

		tool.value = "opencode";
		tool.onchange?.();

		expect(app.innerHTML).not.toContain('id="localAgentModel"');
	});

	it("swaps in the new tool's own options when both tools pin models", () => {
		// The case that only exists once a SECOND tool is pinned, and the one a
		// hide/show test cannot reach: the row STAYS open across the switch, so
		// nothing about its presence changes while every option inside it must.
		// Leaving the old tool's options up would offer a model the new tool
		// answers with a 400.
		const { app, rail, tool, render } = loadToolSwitchJD();
		const model = structuredClone(MODEL) as typeof MODEL;
		const summary = model.settings.summary as Record<string, unknown>;
		summary.aiProvider = "local-agent";
		summary.localAgentTools = [
			{ id: "claude-code", label: "Claude Code" },
			{ id: "codex", label: "Codex" },
		];
		(summary.localAgentModels as Record<string, unknown>).codex = [
			{ id: "gpt-5.6-luna", label: "GPT-5.6-Luna — fastest" },
			{ id: "gpt-5.6-terra", label: "GPT-5.6-Terra — balanced (default)", isDefault: true },
			{ id: "inherit", label: "Use Codex's own setting" },
		];
		render(model);
		rail.get("summary")?.onclick?.();
		expect(app.innerHTML).toContain('value="haiku"');

		tool.value = "codex";
		tool.onchange?.();

		expect(app.innerHTML).toContain('id="localAgentModel"');
		expect(app.innerHTML).toContain('value="gpt-5.6-terra"');
		expect(app.innerHTML).not.toContain('value="haiku"');
		// The stored `haiku` cannot survive into codex's list, so the row resolves
		// to the option MARKED default — not to the first one, which is the
		// cheapest model.
		expect(app.innerHTML).toMatch(/value="gpt-5\.6-terra"[^>]*selected/);
		expect(app.innerHTML).not.toMatch(/value="gpt-5\.6-luna"[^>]*selected/);
	});
});
