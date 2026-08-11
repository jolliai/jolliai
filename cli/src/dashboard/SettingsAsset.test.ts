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
