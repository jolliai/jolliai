/**
 * Runtime smoke test for the Standup board renderer.
 *
 * Same reason as `FeedCardAsset.test.ts`: `assets/js/*.js` is plain JavaScript
 * served verbatim, so tsc never sees it and a model field read under the wrong
 * name renders "undefined" in the browser with no compile-time signal.
 *
 * What it pins here is the author-filter disclosure. The board's columns feed a
 * Copy-as-standup draft the user posts as their own work, so "filtered to you"
 * and "could not tell who you are, showing everyone" must be distinguishable ON
 * THE PAGE — a silent unfiltered board is how a teammate's commit ends up in
 * someone else's standup.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface JDNamespace {
	renderStandup: (model: unknown) => void;
	standupMarkdown: (model: unknown) => string;
}

interface FakeElement {
	innerHTML: string;
	textContent: string;
	value: string;
	style: Record<string, string>;
	onclick?: () => void;
	classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
	focus: () => void;
	select: () => void;
	querySelectorAll: () => ReadonlyArray<never>;
	querySelector: () => null;
	addEventListener: () => void;
}

/** Evaluates format.js → shell.js → standup.js in load order against a stub DOM. */
function loadJD(): { JD: JDNamespace; element: (id: string) => FakeElement } {
	const elements = new Map<string, FakeElement>();
	const make = (): FakeElement => {
		const classes = new Set<string>();
		return {
			innerHTML: "",
			textContent: "",
			value: "",
			style: {},
			classList: {
				add: (c: string) => void classes.add(c),
				remove: (c: string) => void classes.delete(c),
				contains: (c: string) => classes.has(c),
			},
			focus: () => undefined,
			select: () => undefined,
			querySelectorAll: () => [],
			querySelector: () => null,
			addEventListener: () => undefined,
		};
	};
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, make());
			return elements.get(id);
		},
		querySelectorAll: () => [],
		addEventListener: () => undefined,
		createElement: make,
		body: make(),
	};
	const win = { JD: {}, document: doc, addEventListener: () => undefined } as Record<string, unknown>;
	for (const file of ["format.js", "shell.js", "standup.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}
	return { JD: win.JD as unknown as JDNamespace, element: (id) => doc.getElementById(id) as FakeElement };
}

const nowMs = Date.parse("2026-07-30T12:00:00Z");

function model(standupOver: Record<string, unknown> = {}): unknown {
	return {
		schemaVersion: 1,
		view: "standup",
		tier: "memory",
		generatedAtMs: nowMs,
		timeZone: "UTC",
		scope: { kind: "all" },
		repos: [],
		usage: { available: false },
		standup: {
			today: "2026-07-30",
			yesterday: "2026-07-29",
			yesterdaySessions: [],
			yesterdayCommits: [
				{
					hash: "abc1234def",
					message: "feat: my work",
					committedAtMs: nowMs - 26 * 3_600_000,
					repoName: "jolliai",
					branch: "main",
				},
			],
			todaySessions: [],
			todayCommits: [],
			workspaces: [],
			insights: [],
			...standupOver,
		},
	};
}

describe("standup author disclosure", () => {
	it("names the identity the board was filtered to", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		expect(element("app").innerHTML).toContain("yours only");
		expect(element("app").innerHTML).toContain("me@example.com");
	});

	it("says the board is unfiltered when no identity was resolved", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model());
		expect(element("app").innerHTML).toContain("every author");
		expect(element("app").innerHTML).not.toContain("yours only");
	});

	it("warns in the draft sheet before an unfiltered standup is copied", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model());
		element("copyStandup").onclick?.();
		// The warning outranks the tier note: what you are about to paste matters
		// more than which layer the lines came from.
		expect(element("sheetSub").textContent).toContain("Every author's commits");
		expect(element("mdOut").value).toContain("feat: my work");
	});

	it("keeps the memory-tier note once the board IS filtered", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ authoredBy: "me@example.com" }));
		element("copyStandup").onclick?.();
		expect(element("sheetSub").textContent).toContain("From your commit memories");
	});
});

/**
 * The board is two columns, and the third can never come back by accident.
 *
 * `blocker` / `question` / `gotcha` are not producible — `TOPIC_INSIGHTS_CTE`
 * derives insights from each topic's own `decisions`/`todo` text and nothing
 * writes the other three — so the Risks column always said "Nothing flagged".
 * These cases feed the renderer insights of every kind anyway, including the
 * three it can never really receive: if a filter for them is ever re-added, the
 * column reappears here rather than in a user's browser.
 */
describe("standup columns", () => {
	const everyKind = [
		{
			kind: "decision",
			text: "chose the lock",
			commitHash: "abc1234def",
			repoName: "jolliai",
			committedAtMs: nowMs,
		},
		{ kind: "todo", text: "drop the shim", commitHash: "abc1234def", repoName: "jolliai", committedAtMs: nowMs },
		{
			kind: "blocker",
			text: "waiting on infra",
			commitHash: "abc1234def",
			repoName: "jolliai",
			committedAtMs: nowMs,
		},
		{ kind: "question", text: "which zone?", commitHash: "abc1234def", repoName: "jolliai", committedAtMs: nowMs },
		{
			kind: "gotcha",
			text: "status is lossy",
			commitHash: "abc1234def",
			repoName: "jolliai",
			committedAtMs: nowMs,
		},
	];

	it("renders exactly Yesterday and Today", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: everyKind }));
		const html = element("app").innerHTML;
		expect(html).toContain('aria-label="Yesterday"');
		expect(html).toContain('aria-label="Today"');
		expect(html).not.toContain("Risks");
		expect(html).not.toContain("Blockers");
	});

	it("renders no risk rows even when the payload carries those kinds", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: everyKind }));
		const html = element("app").innerHTML;
		expect(html).not.toContain("waiting on infra");
		expect(html).not.toContain("which zone?");
		expect(html).not.toContain("status is lossy");
		expect(html).not.toContain("kind-blocker");
		expect(html).not.toContain("tag age");
		// TODOs stay — they are Today's work, not a risk.
		expect(html).toContain("TODO: drop the shim");
	});

	it("shows the locked upsell for neither column below the memory tier", () => {
		const { JD, element } = loadJD();
		JD.renderStandup(model({ insights: undefined }));
		expect(element("app").innerHTML).not.toContain("locked-panel");
	});

	it("drafts no risks section in the copied markdown", () => {
		const { JD } = loadJD();
		const md = JD.standupMarkdown(model({ insights: everyKind }));
		expect(md).toContain("**Yesterday**");
		expect(md).toContain("**Today**");
		expect(md).toContain("- TODO: drop the shim");
		expect(md).not.toContain("Risks");
		expect(md).not.toContain("waiting on infra");
	});
});
