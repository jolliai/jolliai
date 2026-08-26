/**
 * Runtime smoke test for the Settings page renderer (`assets/js/settings.js`).
 *
 * `assets/js/*.js` is plain JavaScript, never type-checked by tsc, so a typo in
 * a field name or a broken template renders silently in the browser. This
 * evaluates the real IIFE against a stub window/document and asserts each of the
 * six section renderers, following the pattern of `FeedCardAsset.test.ts`.
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

const SECTION_IDS = ["agents", "summary", "sync", "bank", "others", "advanced"];

/**
 * Loads format.js → settings.js against a stub window/document. The document's
 * `querySelectorAll(".set-rail-item")` returns one persistent fake button per
 * section so
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
		sync: { syncSessions: true },
		memoryBank: { localFolder: "/mem/bank", compileExcludeFolders: "archive", syncTranscripts: false },
		others: { dcoSignoff: true, excludePatterns: "*.lock" },
	},
};

describe("settings.js renderSettings", () => {
	it("renders the section rail and the default AI Agents section", () => {
		const { renderSettings, app } = loadJD();
		renderSettings(MODEL);
		for (const label of ["AI Agents", "AI Summary", "Sync to Jolli", "Memory Bank", "Others", "Advanced"]) {
			expect(app.innerHTML).toContain(label);
		}
		expect(app.innerHTML).toContain("Claude Code");
		expect(app.innerHTML).toContain("Kimi Code");
		expect(app.innerHTML).toContain("Apply Changes");
	});

	it("renders each of the six section renderers with its distinctive content", () => {
		const { renderSettings, app, rail } = loadJD();
		renderSettings(MODEL);
		const go = (id: string) => rail.get(id)?.onclick?.();

		go("summary");
		expect(app.innerHTML).toContain("Provider");
		// The MASKED key reaches the page verbatim — never the full key.
		expect(app.innerHTML).toContain("sk-ant-abcde****mnop");
		expect(app.innerHTML).toContain("Opus");

		go("sync");
		// The signed-OUT prompt names both outbound streams (the signed-in verdict
		// is asserted below) — saying only "memories" reads as a denial that
		// anything else is sent.
		expect(app.innerHTML).toContain("Sign in to push session statistics and memories");
		// …and each block heading carries its own scope, which is the pair the two
		// switches differ on.
		expect(app.innerHTML).toContain("Session statistics — for the whole machine");
		expect(app.innerHTML).toContain("Memories — per repository");
		// The session-statistics switch lives on THIS tab, not on Others.
		expect(app.innerHTML).toContain("Sync session statistics");

		go("bank");
		expect(app.innerHTML).toContain("Folder Path");
		expect(app.innerHTML).toContain("/mem/bank");

		go("others");
		expect(app.innerHTML).toContain("Exclude Patterns");
		expect(app.innerHTML).toContain("Sign commits with DCO");
		expect(app.innerHTML).not.toContain("Sync session statistics");

		go("advanced");
		expect(app.innerHTML).toContain("Show Knowledge");
		expect(app.innerHTML).toContain("Show Graph");
	});

	it("names both outbound streams in the signed-in verdict", () => {
		const { renderSettings, app, rail } = loadJD();
		const summary = { ...MODEL.settings.summary, signedIn: true };
		renderSettings({ ...MODEL, settings: { ...MODEL.settings, summary } });
		rail.get("sync")?.onclick?.();
		expect(app.innerHTML).toContain("Signed in — ready to push session statistics and memories");
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
			sync: "Memories — per repository",
			bank: "Folder Path",
			others: "Exclude Patterns",
			advanced: "Show Knowledge",
		};
		for (const id of SECTION_IDS) {
			rail.get(id)?.onclick?.();
			expect(app.innerHTML).toContain(markers[id]);
		}
	});
});

/**
 * Like {@link loadJD}, but `/api/settings/push-repos` and
 * `/api/settings/space-bindings` resolve to caller-given data instead of
 * hanging forever — needed to drive the per-repo Space column (JOLLI-2152)
 * past its initial "Checking…" placeholder. Passing `spaceBindingsResponse`
 * as `undefined` leaves that one request hanging (the "still pending" case),
 * and `"reject"` makes it REJECT the way `JD.getJson` really does on any
 * non-2xx — including this endpoint's own 500. Every other path is unaffected
 * (never resolves), matching {@link loadJD}.
 */
function loadJDForSpaceColumn(
	repos: ReadonlyArray<Record<string, unknown>>,
	spaceBindingsResponse?: Record<string, unknown> | "reject",
): { renderSettings: (model: unknown) => void; app: FakeElement; rail: Map<string, FakeButton> } {
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
			getJson: (path: string) => {
				if (path === "/api/settings/push-repos") return Promise.resolve({ repos });
				if (path === "/api/settings/space-bindings") {
					if (spaceBindingsResponse === undefined) return new Promise(() => {});
					if (spaceBindingsResponse === "reject") {
						return Promise.reject(new Error("request failed (500)"));
					}
					return Promise.resolve(spaceBindingsResponse);
				}
				return new Promise(() => {});
			},
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

describe("settings.js Space column (JOLLI-2152)", () => {
	const REPOS = [
		{
			repoIdentity: "https://github.com/acme/widgets",
			repoName: "widgets",
			pushDisabled: false,
			isCurrentRepo: true,
		},
	];

	it("shows a pending 'Checking…' placeholder before space-bindings resolves", async () => {
		const { renderSettings, app, rail } = loadJDForSpaceColumn(REPOS);
		renderSettings(MODEL);
		rail.get("sync")?.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(app.innerHTML).toContain("Checking…");
		expect(app.innerHTML).toContain("set-space-pending");
	});

	it("shows one sign-in hint and a muted dash per row when signed out", async () => {
		const { renderSettings, app, rail } = loadJDForSpaceColumn(REPOS, { signedOut: true, bindings: {} });
		renderSettings(MODEL);
		rail.get("sync")?.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(app.innerHTML).toContain("Sign in to see which Jolli Space");
		expect(app.innerHTML).toContain("set-space-unknown");
	});

	it("renders a bound row with its Space name", async () => {
		const { renderSettings, app, rail } = loadJDForSpaceColumn(REPOS, {
			signedOut: false,
			bindings: { "https://github.com/acme/widgets": { state: "bound", label: "Acme Core" } },
		});
		renderSettings(MODEL);
		rail.get("sync")?.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(app.innerHTML).toContain("Acme Core");
		expect(app.innerHTML).toContain("set-space-bound");
	});

	it("renders an unbound row as 'Not bound'", async () => {
		const { renderSettings, app, rail } = loadJDForSpaceColumn(REPOS, {
			signedOut: false,
			bindings: {
				"https://github.com/acme/widgets": {
					state: "unbound",
					label: "Not bound",
					title: "2 Spaces available",
				},
			},
		});
		renderSettings(MODEL);
		rail.get("sync")?.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(app.innerHTML).toContain("Not bound");
		expect(app.innerHTML).toContain("set-space-unbound");
	});

	it("falls back to 'Not checked' — never blank — when a repoIdentity is missing from a settled bindings map", async () => {
		const { renderSettings, app, rail } = loadJDForSpaceColumn(REPOS, { signedOut: false, bindings: {} });
		renderSettings(MODEL);
		rail.get("sync")?.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(app.innerHTML).toContain("Not checked");
		expect(app.innerHTML).toContain("set-space-unknown");
	});

	// A failed fetch settles the column instead of parking it: JD.getJson
	// REJECTS on any non-2xx (including this endpoint's own 500), and the error
	// flag closes wire()'s retry guard behind it — so leaving spaceBindings null
	// would leave "Checking…" on screen for ever, with nothing left to fetch it.
	// The VS Code panel's own catch already renders "Not checked" here.
	it("settles to 'Not checked' rather than a permanent 'Checking…' when the request fails", async () => {
		const { renderSettings, app, rail } = loadJDForSpaceColumn(REPOS, "reject");
		renderSettings(MODEL);
		rail.get("sync")?.onclick?.();
		// A macrotask, not a fixed number of microtask ticks: the rejection
		// travels through getJson's own .then, the .catch, finishSpaceBindingsFetch
		// and the re-render, and it races the push-repos load's chain.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(app.innerHTML).toContain("Not checked");
		expect(app.innerHTML).toContain("set-space-unknown");
		expect(app.innerHTML).not.toContain("Checking…");
		expect(app.innerHTML).not.toContain("set-space-pending");
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

function loadFormJD(
	model: unknown = MODEL,
	extraFields: ReadonlyArray<readonly [string, string]> = [],
	/**
	 * `window.__JOLLI_DASHBOARD__.menus` — what the SIDEBAR is currently showing,
	 * which is what `doApply` compares against. Defaults to the settings payload's
	 * own slice, the normal case where page and modal agree; pass it explicitly to
	 * model two tabs that have drifted apart.
	 */
	pageMenus: unknown = (model as { menus?: unknown }).menus,
): {
	fields: Map<string, FieldStub>;
	applyBtn: { onclick?: () => void };
	/** The Sync tab's immediate session-statistics switch. */
	syncBox: { checked: boolean; onchange?: () => void };
	posts: { path: string; body: Record<string, unknown> }[];
	/** How many times doApply asked the PAGE to repaint (the sidebar refresh). */
	pageRefreshes: () => number;
	/** The callbacks doApply handed to `JD.refreshNow`, for an identity check. */
	refreshArgs: () => ReadonlyArray<unknown>;
	/** The stub the page render must be driven through. */
	renderPage: unknown;
} {
	const posts: { path: string; body: Record<string, unknown> }[] = [];
	let pageRefreshes = 0;
	const refreshArgs: unknown[] = [];
	const app = { innerHTML: "", insertAdjacentHTML: () => undefined };
	const applyBtn: { onclick?: () => void } = {};
	// The Sync tab's immediate switch. It is reached by `querySelector`, not by the
	// `[data-field]` sweep, precisely because it is NOT part of the form.
	const syncBox: { checked: boolean; onchange?: () => void } = { checked: true };
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
		...extraFields.map(([name, type]): [string, FieldStub] => [name, field(name, type)]),
	]);
	const doc = {
		getElementById: (id: string) =>
			id === "settingsModalBody" ? app : id === "applyBtn" ? applyBtn : { innerHTML: "", textContent: "" },
		querySelectorAll: (sel: string) => (sel.includes("[data-field]") ? [...fields.values()] : []),
		querySelector: (sel: string) => (sel.includes("[data-sync-sessions]") ? syncBox : null),
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
			refreshNow: (render: unknown) => {
				pageRefreshes += 1;
				refreshArgs.push(render);
			},
			renderPage: () => undefined,
		},
		document: doc,
		addEventListener: () => undefined,
		// The page payload the sidebar was rendered from. `doApply` reads its
		// `menus` to decide whether the sidebar needs repainting.
		__JOLLI_DASHBOARD__: { menus: pageMenus },
	} as Record<string, unknown>;
	for (const f of ["format.js", "settings.js"]) {
		new Function("window", "document", readFileSync(new URL(`./assets/js/${f}`, import.meta.url), "utf8"))(
			win,
			doc,
		);
	}
	// render() → wire() assigns applyBtn.onclick and the fields' on* handlers.
	(win.JD as { renderSettings: (m: unknown) => void }).renderSettings(model);
	return {
		fields,
		applyBtn,
		syncBox,
		posts,
		pageRefreshes: () => pageRefreshes,
		refreshArgs: () => refreshArgs,
		renderPage: (win.JD as { renderPage: unknown }).renderPage,
	};
}

describe("settings.js session-statistics switch", () => {
	// The unification this replaced: one switch on the Sync tab waited for "Apply
	// Changes" while the identical-looking per-repo ones beside it did not. Both
	// write on change now, so the switch must POST its own endpoint…
	it("posts immediately on change instead of waiting for Apply", () => {
		const { syncBox, posts } = loadFormJD();
		syncBox.checked = false;
		syncBox.onchange?.();
		expect(posts).toEqual([{ path: "/api/settings/set-sync-sessions", body: { enabled: false } }]);
	});

	// …and must stay OUT of the batched save, or an Apply made afterwards would
	// carry the pre-toggle value back to disk.
	it("is absent from the Apply payload", () => {
		const { applyBtn, posts } = loadFormJD();
		applyBtn.onclick?.();
		const apply = posts.find((p) => p.path === "/api/settings/apply");
		expect(apply).toBeDefined();
		expect(apply?.body).not.toHaveProperty("syncSessions");
	});
});

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

/**
 * The Advanced section — the two optional sidebar rows.
 *
 * Its state does NOT come from `model.settings`: the flags live at the top of the
 * payload as `model.menus`, because the sidebar reads them on every view (see
 * `DashboardMenus`). So this suite is what pins that `initForm` reads the whole
 * model rather than the settings slice — a mistake tsc cannot see, and one whose
 * symptom is a checkbox that is silently always off while the row it controls is
 * showing.
 */
describe("settings.js Advanced section", () => {
	function advancedHtml(menus?: Record<string, boolean>): string {
		const { renderSettings, app, rail } = loadJD();
		renderSettings(menus ? { ...MODEL, menus } : MODEL);
		rail.get("advanced")?.onclick?.();
		return app.innerHTML;
	}

	it("seeds each switch from model.menus, not from the settings slice", () => {
		const html = advancedHtml({ knowledge: true, graph: false });
		expect(html).toMatch(/data-field="dashboardKnowledgeMenuEnabled" checked/);
		expect(html).toContain('data-field="dashboardGraphMenuEnabled"/>');
	});

	it("renders both switches off when the payload carries no menus slice", () => {
		const html = advancedHtml();
		expect(html).toContain('data-field="dashboardKnowledgeMenuEnabled"/>');
		expect(html).toContain('data-field="dashboardGraphMenuEnabled"/>');
	});

	// The rows are hidden by default, so this section is where a reader learns the
	// pages exist — and that switching one off neither stops the content being built
	// nor closes the route. Both halves are load-bearing product text, not phrasing:
	// without the first a user reads the switch as "stop compiling", and without the
	// second a bookmark that still works looks like a bug.
	it("says that switching a row off stops nothing and closes no route", () => {
		const html = advancedHtml();
		expect(html).toContain("nothing stops being generated");
		expect(html).toContain("reachable by URL");
	});

	// Two names are deliberately absent. "Memory Bank" belongs to the VS Code
	// panel's folder settings and means nothing on this surface; `jolli compile` is
	// how the pages are produced, which a reader choosing menu rows does not need
	// (the pages' own empty states name it). Pinned because both are the obvious
	// thing to reach for when describing these two pages.
	it("describes the pages without naming Memory Bank or the compile command", () => {
		const html = advancedHtml();
		expect(html).toContain("Show Knowledge");
		expect(html).toContain("Show Graph");
		const advanced = html.slice(html.indexOf("Sidebar menu"));
		expect(advanced).not.toContain("Memory Bank");
		expect(advanced).not.toContain("jolli compile");
	});
});

describe("settings.js Advanced apply", () => {
	const FIELDS = [["dashboardKnowledgeMenuEnabled", "checkbox"] as const];

	it("carries both flags in the Apply payload, seeded from model.menus", () => {
		const { applyBtn, posts } = loadFormJD({ ...MODEL, menus: { knowledge: false, graph: true } });
		applyBtn.onclick?.();
		const body = posts.find((post) => post.path === "/api/settings/apply")?.body;
		expect(body?.dashboardKnowledgeMenuEnabled).toBe(false);
		expect(body?.dashboardGraphMenuEnabled).toBe(true);
	});

	it("submits a toggled flag and repaints the page so the sidebar row appears", async () => {
		const { fields, applyBtn, posts, pageRefreshes } = loadFormJD(
			{ ...MODEL, menus: { knowledge: false, graph: false } },
			FIELDS,
		);
		const box = fields.get("dashboardKnowledgeMenuEnabled");
		if (box) {
			box.checked = true;
			box.onchange?.();
		}
		applyBtn.onclick?.();
		const body = posts.find((post) => post.path === "/api/settings/apply")?.body;
		expect(body?.dashboardKnowledgeMenuEnabled).toBe(true);
		// The POST resolves on a microtask, so the refresh is queued behind it.
		await Promise.resolve();
		await Promise.resolve();
		expect(pageRefreshes()).toBe(1);
	});

	// The page repaint is not free — it redraws the whole view under the modal — so
	// it must fire only for a change the sidebar can actually show. A save that
	// moves an unrelated field must leave the page alone.
	it("does not repaint the page when no sidebar flag moved", async () => {
		const { fields, applyBtn, pageRefreshes } = loadFormJD({ ...MODEL, menus: { knowledge: true, graph: true } });
		const gi = fields.get("globalInstructions");
		if (gi) {
			gi.checked = true;
			gi.onchange?.();
		}
		applyBtn.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(pageRefreshes()).toBe(0);
	});

	// Each flag needs its own case. With only the Knowledge one covered, deleting
	// the Graph half of the comparison outright still passed — a Graph-only save
	// would then leave the sidebar stale until a reload.
	it("repaints the page for a Graph-only change", async () => {
		const { fields, applyBtn, pageRefreshes } = loadFormJD(
			{ ...MODEL, menus: { knowledge: false, graph: false } },
			[["dashboardGraphMenuEnabled", "checkbox"]],
		);
		const box = fields.get("dashboardGraphMenuEnabled");
		if (box) {
			box.checked = true;
			box.onchange?.();
		}
		applyBtn.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(pageRefreshes()).toBe(1);
	});

	// Both flags moving in OPPOSITE directions in one save. Nothing else here
	// distinguishes the two comparisons, so swapping them read as "unchanged" and
	// skipped the repaint while both rows were wrong.
	it("repaints the page when the two flags move in opposite directions at once", async () => {
		const { fields, applyBtn, posts, pageRefreshes } = loadFormJD(
			{ ...MODEL, menus: { knowledge: true, graph: false } },
			[
				["dashboardKnowledgeMenuEnabled", "checkbox"],
				["dashboardGraphMenuEnabled", "checkbox"],
			],
		);
		const knowledge = fields.get("dashboardKnowledgeMenuEnabled");
		if (knowledge) {
			knowledge.checked = false;
			knowledge.onchange?.();
		}
		const graph = fields.get("dashboardGraphMenuEnabled");
		if (graph) {
			graph.checked = true;
			graph.onchange?.();
		}
		applyBtn.onclick?.();
		const body = posts.find((post) => post.path === "/api/settings/apply")?.body;
		expect(body?.dashboardKnowledgeMenuEnabled).toBe(false);
		expect(body?.dashboardGraphMenuEnabled).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(pageRefreshes()).toBe(1);
	});

	// The comparison is against what the SIDEBAR is showing, not against the
	// modal's own payload. Here another tab already switched Knowledge off, so the
	// page model has moved while this modal still holds `true`: re-saving `true`
	// looks unchanged to the modal and IS a change to the sidebar. Comparing the
	// wrong one skipped the repaint exactly when it was needed most.
	it("repaints the page when the sidebar has drifted from the open modal", async () => {
		const { fields, applyBtn, pageRefreshes } = loadFormJD(
			{ ...MODEL, menus: { knowledge: true, graph: false } },
			[],
			{
				knowledge: false,
				graph: false,
			},
		);
		const gi = fields.get("globalInstructions");
		if (gi) {
			gi.checked = true;
			gi.onchange?.();
		}
		applyBtn.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(pageRefreshes()).toBe(1);
	});

	// The page must be repainted through main.js's renderPage. Handing
	// `refreshNow` this module's own `render` instead type-checks, passes a
	// call-count assertion, and repaints the MODAL from a page payload — whose
	// `settings` slice is undefined, so the whole form comes back empty.
	it("drives the repaint through JD.renderPage, not the modal renderer", async () => {
		const { fields, applyBtn, refreshArgs, renderPage } = loadFormJD(
			{ ...MODEL, menus: { knowledge: false, graph: false } },
			[["dashboardKnowledgeMenuEnabled", "checkbox"]],
		);
		const box = fields.get("dashboardKnowledgeMenuEnabled");
		if (box) {
			box.checked = true;
			box.onchange?.();
		}
		applyBtn.onclick?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(refreshArgs()).toEqual([renderPage]);
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
