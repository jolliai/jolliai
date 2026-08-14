/**
 * Runtime smoke test for `assets/js/memories.js`'s context-row wiring.
 *
 * Same rationale as `FeedCardAsset.test.ts`: the asset scripts are plain JS
 * bundled verbatim into the served page, so tsc never sees them and a keyboard
 * handler that stops firing does so silently. This evaluates the real IIFEs
 * against a stub document and drives the handlers the wiring installs.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface FakeRow {
	getAttribute: (name: string) => string | null;
	onclick?: (event: unknown) => void;
	onkeydown?: (event: unknown) => void;
}

interface FakeElement {
	innerHTML: string;
	style: Record<string, string>;
	classList: { add: () => void; remove: () => void; contains: () => boolean };
	querySelectorAll: () => ReadonlyArray<never>;
	querySelector: () => null;
	addEventListener: () => void;
	setAttribute: () => void;
	getAttribute: () => null;
}

/** The context row every case starts from: openable, no upstream url. */
const PLAN_ROW = { kind: "plan", key: "plan-key", contextKey: "plan-key", title: "A plan" };

/**
 * Renders one memory detail and hands back both the markup it wrote into `#app`
 * and the context rows with the handlers `wireContextRows` installed on them.
 *
 * The rows are stubs rather than parsed markup: what the keyboard cases test is
 * which events reach `openContextDialog`, and the row element only has to answer
 * `getAttribute` and accept the two handler assignments. The markup is read back
 * separately, from the one element the full-page branch writes.
 */
function render(
	context: ReadonlyArray<Record<string, unknown>>,
	conversations: ReadonlyArray<Record<string, unknown>> = [],
	topics: ReadonlyArray<Record<string, unknown>> = [],
): { rows: FakeRow[]; html: string } {
	const rows: FakeRow[] = [
		{
			getAttribute: (name: string) => (name === "data-context-kind" ? "plan" : "plan-key"),
		},
	];
	const elements = new Map<string, FakeElement>();
	const element = (): FakeElement => ({
		innerHTML: "",
		style: {} as Record<string, string>,
		classList: { add: () => undefined, remove: () => undefined, contains: () => false },
		querySelectorAll: () => [] as ReadonlyArray<never>,
		querySelector: () => null,
		addEventListener: () => undefined,
		setAttribute: () => undefined,
		getAttribute: () => null,
	});
	const doc = {
		// `memTree` / `memSearch` answering null is what sends `renderMemories`
		// down the full-page branch, the one that writes `#app`. Every other id is
		// memoised so that write can be read back after the render.
		getElementById: (id: string) => {
			if (id === "memTree" || id === "memSearch") return null;
			const hit = elements.get(id) ?? element();
			elements.set(id, hit);
			return hit;
		},
		// The only selector `wireContextRows` uses. Everything else in the module
		// asks for elements by id, which the stub above always answers.
		querySelectorAll: (selector: string) => (selector === "[data-context-key]" ? rows : []),
		addEventListener: () => undefined,
		createElement: element,
		body: element(),
	};
	const win = { JD: {}, document: doc, addEventListener: () => undefined } as Record<string, unknown>;
	for (const file of ["format.js", "shell.js", "charts.js", "memories.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}
	const JD = win.JD as { renderMemories: (model: unknown) => void };
	// What the tests assert is `preventDefault`, not the dialog itself.
	// `openContextDialog` is module-private and leaves nothing observable here: it
	// writes into overlay elements that `getElementById` hands back as throwaway
	// objects, and then fetches. But the handler calls `preventDefault()` on
	// exactly the paths that go on to open it and on no others, so the event is
	// the seam — prevented means "the row claimed this key", not prevented means
	// "left to the link, or to the browser".
	const model = {
		memories: {
			selected: {
				title: "m",
				conversations,
				context,
				excluded: [],
				activity: [],
				activityUncoveredSources: [],
				topics,
				files: [],
				e2e: [],
			},
			tree: [],
		},
		scope: { kind: "all" },
	};
	JD.renderMemories(model);
	return { rows, html: elements.get("app")?.innerHTML ?? "" };
}

/** The keyboard cases only ever look at the wired rows. */
const wireRows = (): FakeRow[] => render([PLAN_ROW]).rows;

const keyEvent = (key: string, insideLink: boolean) => {
	let defaultPrevented = false;
	return {
		key,
		target: { closest: (sel: string) => (insideLink && sel === ".mem-ctx-link" ? {} : null) },
		preventDefault: () => {
			defaultPrevented = true;
		},
		wasPrevented: () => defaultPrevented,
	};
};

describe("memories.js — context row keyboard wiring", () => {
	it("opens the dialog on Space even when the upstream-link glyph has focus", () => {
		// Space is NOT a link activation key — the browser scrolls instead — so
		// exempting it from the row handler traded a working affordance for
		// nothing: with the glyph focused, Space opened the dialog before the
		// link exemption landed and did neither afterwards.
		const rows = wireRows();
		const event = keyEvent(" ", true);
		rows[0]?.onkeydown?.(event);
		expect(event.wasPrevented()).toBe(true);
	});

	it("leaves Enter to the link when the glyph has focus", () => {
		// Enter IS the anchor's own activation; the row's preventDefault would
		// cancel the navigation and show the dialog instead.
		const rows = wireRows();
		const event = keyEvent("Enter", true);
		rows[0]?.onkeydown?.(event);
		expect(event.wasPrevented()).toBe(false);
	});

	it("still opens the dialog on Enter and Space from the row itself", () => {
		const rows = wireRows();
		for (const key of ["Enter", " "]) {
			const event = keyEvent(key, false);
			rows[0]?.onkeydown?.(event);
			expect(event.wasPrevented()).toBe(true);
		}
	});
});

/**
 * The other half of the same wiring: `JD.safeHrefAttr`'s own cases live in
 * `FormatAsset.test.ts`, and these pin that this renderer routes the url through
 * it and omits the whole anchor when it answers null — the row still renders,
 * rather than carrying a glyph that navigates nowhere.
 */
describe("memories.js — context row upstream link", () => {
	it("emits the link for an allowlisted url", () => {
		const url = "https://linear.app/acme/issue/ABC-1";
		const { html } = render([{ ...PLAN_ROW, url }]);
		expect(html).toContain(`<a class="mem-ctx-link" href="${url}"`);
		expect(html).toContain('rel="noreferrer noopener"');
	});

	it("emits no anchor at all when the scheme is not allowlisted, keeping the row", () => {
		const { html } = render([{ ...PLAN_ROW, url: "javascript:alert(1)" }]);
		expect(html).toContain("A plan");
		expect(html).not.toContain("mem-ctx-link");
		expect(html).not.toContain("javascript:");
	});

	it("emits no anchor for a row with no url", () => {
		expect(render([PLAN_ROW]).html).not.toContain("mem-ctx-link");
	});
});

/**
 * `MemoryConversationRow.sessionId` is served on the strength of being rendered
 * (see the rule on that type: nothing lands in it which the client does not
 * use). These pin the render, so the field cannot quietly go back to being
 * payload nothing reads — which is invisible to tsc and to the coverage floor,
 * since neither sees this file.
 */
describe("memories.js — conversation rows", () => {
	const conversation = (over: Record<string, unknown> = {}) => ({
		title: "Add the rate limiter",
		source: "claude",
		messageCount: 12,
		sessionId: "sess-abc",
		...over,
	});

	it("renders the session id as the row's tooltip", () => {
		const { html } = render([], [conversation()]);
		expect(html).toContain('<div class="gd-row" title="Session sess-abc">');
		expect(html).toContain("Add the rate limiter");
	});

	it("distinguishes two conversations from the same source", () => {
		// The reason the field is there at all: same glyph, same `claude` meta, and
		// titles that a first-user-message fallback can make near-identical.
		const { html } = render([], [conversation({ sessionId: "sess-a" }), conversation({ sessionId: "sess-b" })]);
		expect(html).toContain('title="Session sess-a"');
		expect(html).toContain('title="Session sess-b"');
	});

	it("escapes the id, which reaches an attribute", () => {
		const { html } = render([], [conversation({ sessionId: '"><img src=y onerror=alert(1)>' })]);
		expect(html).toContain('title="Session &quot;&gt;&lt;img src=y onerror=alert(1)&gt;"');
		expect(html).not.toContain("<img src=y");
	});

	it("omits the tooltip entirely when the archive carries no id", () => {
		// Not `Session unknown`: an absent tooltip says nothing, where a placeholder
		// says something false about the session.
		const { html } = render([], [conversation({ sessionId: undefined })]);
		expect(html).toContain('<div class="gd-row">');
		expect(html).not.toContain('title="Session');
	});

	// The row leads with the agent that produced the conversation, the same way
	// VS Code's memory detail and IntelliJ's Working Memory panel do.
	it("leads with the producing agent's brand mark instead of a generic glyph", () => {
		const { html } = render([], [conversation({ source: "codex" })]);
		expect(html).toContain('<span class="src-mark mem-row-icon" role="img" title="codex" aria-label="codex">');
		expect(html).toContain('stroke="#10A37F"');
	});

	// The name moved into the mark rather than being dropped: it used to sit in
	// the meta slot as raw text, competing with the title for width.
	it("no longer prints the source tag as row text", () => {
		const { html } = render([], [conversation({ source: "cursor" })]);
		expect(html).not.toContain('<span class="mem-row-meta">cursor</span>');
		expect(html).toContain('aria-label="cursor"');
		expect(html).toContain("12 msgs");
	});

	// cursor-agent and the Cursor IDE are one brand — the same pairing the other
	// three surfaces make, so the CLI does not render as an unknown agent.
	it("rides the sibling brand for cursor-cli", () => {
		const cli = render([], [conversation({ source: "cursor-cli" })]).html;
		expect(cli).toContain('aria-label="cursor-cli"');
		expect(cli).toContain("M8 1.5 14 5v6L8 14.5 2 11V5L8 1.5Z");
	});
});

/**
 * The anchor the Memory Activity card's "N decisions" chip links at.
 *
 * It is a FIXED id on the topics SECTION — the "What changed and why" header —
 * not a per-topic index, because the card that links here knows only how many
 * decisions a memory has (`MemoryCard.decisionCount`) and carries no topic list.
 * It sat on the first `.decide` block before, which landed the reader below the
 * topic heading that says what the decision is about.
 */
describe("topic anchors", () => {
	const topic = (title: string, decisions: ReadonlyArray<string>) => ({
		title,
		category: "bugfix",
		trigger: "t",
		response: "r",
		decisions,
		files: [],
		todo: "",
	});

	it("gives every topic an index anchor", () => {
		const { html } = render([], [], [topic("T0", []), topic("T1", ["picked sqlite"])]);
		expect(html).toContain('id="topic-0"');
		expect(html).toContain('id="topic-1"');
	});

	it("puts #what-changed on the section header, above every topic", () => {
		const { html } = render([], [], [topic("T0", []), topic("T1", ["picked sqlite"]), topic("T2", ["again"])]);
		// Exactly once — a second copy would make the anchor ambiguous and send
		// the reader to whichever the browser happened to find first.
		expect(html.match(/id="what-changed"/g)).toHaveLength(1);
		// On the section that carries the header, so the scroll lands on "What
		// changed and why" with the first topic below it — not inside a topic.
		expect(html).toContain('<section class="mem-section mem-topics" id="what-changed">');
		expect(html.indexOf('id="what-changed"')).toBeLessThan(html.indexOf('id="topic-0"'));
	});

	// The section is the whole memory's topics, so it is there whenever any topic
	// is — the decision count is what the LINK is gated on, not the target.
	it("emits #what-changed even when no topic recorded a decision", () => {
		const { html } = render([], [], [topic("T0", []), topic("T1", [])]);
		expect(html).toContain('id="topic-1"');
		expect(html).toContain('id="what-changed"');
		expect(html).not.toContain("decide-title");
	});

	it("emits no #what-changed when the memory has no topics at all", () => {
		const { html } = render([], [], []);
		expect(html).not.toContain('id="what-changed"');
	});
});
