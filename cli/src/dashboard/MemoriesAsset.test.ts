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
	/** Set by every dialog path; read back by the cases that assert what it wrote. */
	textContent?: string;
	className?: string;
	style: Record<string, string>;
	classList: { add: () => void; remove: () => void; contains: () => boolean };
	querySelectorAll: () => ReadonlyArray<never>;
	querySelector: () => null;
	addEventListener: () => void;
	setAttribute: () => void;
	getAttribute: () => null;
	/**
	 * The Conversation viewer builds its turns as DOM rather than as a markup
	 * string, so what it wrote is only readable if the stub keeps them. Both calls
	 * maintain this list — `replaceChildren` clears it, which is also the
	 * "re-rendered for a different conversation" case the stale-response cases
	 * depend on.
	 */
	children: FakeElement[];
	replaceChildren: () => void;
	appendChild: (child: FakeElement) => void;
}

/**
 * The `fetch` the asset scripts see.
 *
 * Injected as a function parameter rather than set on the stub window, because
 * the scripts call the bare global — inside `new Function` a parameter of that
 * name is the only thing that shadows it. Defaulting to a promise that never
 * settles keeps every other case off the real network: these run under Node,
 * where a relative url is not a fetchable one.
 */
type FakeFetch = (url: string, init?: unknown) => Promise<unknown>;

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
	opts: { selected?: boolean; fetch?: FakeFetch } = {},
): {
	rows: FakeRow[];
	conversationRows: FakeRow[];
	win: Record<string, unknown>;
	doc: { getElementById: (id: string) => FakeElement | null };
	html: string;
} {
	const rows: FakeRow[] = [
		{
			getAttribute: (name: string) => (name === "data-context-kind" ? "plan" : "plan-key"),
		},
	];
	// The conversation counterpart, on the same terms: what the cases check is
	// which events reach `openConversationDialog`, so the row only has to answer
	// `getAttribute` and take the two handlers. One per conversation, each
	// answering its OWN key — the stale-response case needs two rows that open
	// two different conversations from the one shared overlay.
	const conversationRows: FakeRow[] = conversations.map((c) => ({
		getAttribute: (name: string) => String((name === "data-source" ? c.source : c.sessionId) ?? ""),
	}));
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
		// The Conversation viewer builds its turns as DOM rather than as a markup
		// string — deliberately, since a transcript is set with `textContent` — so
		// the stub has to answer the two calls that does, and keep what they wrote.
		children: [] as FakeElement[],
		replaceChildren() {
			this.children.length = 0;
		},
		appendChild(child: FakeElement) {
			this.children.push(child);
		},
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
		// `JD.currentTheme` reads this to decide the theme it hands the Context
		// viewer's frame — answering null means "no explicit theme", which is the
		// branch that falls through to `matchMedia` (absent on the stub window, so
		// "light"). Without it the row handlers throw on the way into the dialog.
		documentElement: { getAttribute: () => null },
		// The two selectors the wiring uses — `[data-context-key]` for Context rows
		// and `[data-session]` for Conversation rows. Everything else in the module
		// asks for elements by id, which the stub above always answers.
		querySelectorAll: (selector: string) =>
			selector === "[data-context-key]" ? rows : selector === "[data-session]" ? conversationRows : [],
		addEventListener: () => undefined,
		createElement: element,
		body: element(),
	};
	// `__JOLLI_SOURCE_META__` is what the server inlines (assembleDashboardHtml)
	// from the CLI's own SOURCE_META. Seeded with the real entries the badge cases
	// assert on plus the neutral fallback, so the page is exercised in the shape
	// it is actually served in rather than in its degraded no-injection state.
	const win = {
		JD: {},
		document: doc,
		addEventListener: () => undefined,
		// The page registers its postMessage handlers remove-then-add, so a window
		// that outlives one render reaches this. Modelled here even though each
		// `render()` builds a fresh window, so the harness matches a real one.
		removeEventListener: () => undefined,
		// The Context link bridge resolves the frame's url against this before
		// deciding whether to open it, and records what it opened.
		location: { origin: "http://dash.test" },
		open: () => undefined,
		__JOLLI_SOURCE_META__: {
			meta: {
				linear: { label: "Linear", letter: "L", icon: "issues", color: "#5e6ad2" },
				sentry: { label: "Sentry", letter: "S", icon: "bug", color: "#6559C6" },
			},
			neutral: "#6e7681",
		},
	} as Record<string, unknown>;
	const fetchImpl: FakeFetch = opts.fetch ?? (() => new Promise(() => undefined));
	for (const file of ["format.js", "shell.js", "charts.js", "memories.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", "fetch", src)(win, doc, fetchImpl);
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
			// `selected: false` is the no-memory-picked branch, which renders the
			// whole-pane placeholder instead of a detail.
			selected:
				opts.selected === false
					? undefined
					: {
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
	return { rows, conversationRows, win, doc, html: elements.get("app")?.innerHTML ?? "" };
}

/** The keyboard cases only ever look at the wired rows. */
const wireRows = (): FakeRow[] => render([PLAN_ROW]).rows;

/** The no-memory-selected branch, which renders the whole-pane placeholder. */
const renderNoSelection = (): { html: string } => render([], [], [], { selected: false });

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
/**
 * The Context badge. A reference is badged by its SOURCE (letter + brand hue
 * from the injected `SOURCE_META`), every other kind by its kind — the split the
 * editor makes. Before this the page keyed on the kind alone, so a Linear
 * ticket, a Jira issue and a Sentry issue were one identical amber `R`.
 */
/**
 * Which empty state gets the centred, 120px-margin treatment.
 *
 * The rule keyed on `.mem-detail .gd-empty`, which caught the SECTION empties
 * too — so a memory with no context rendered "None." with 120px of blank above
 * and below, and one with neither context nor conversations produced two such
 * voids stacked. CSS has no typechecker and this file is outside the coverage
 * denominator, so the class placement is pinned here or nowhere.
 */
describe("memories.js — empty states", () => {
	it("marks only the whole-pane placeholder as the centred empty", () => {
		const { html } = renderNoSelection();
		expect(html).toContain('class="gd-empty mem-empty-pane"');
		expect(html).toContain("Pick a memory on the left");
	});

	it("leaves a section's empty state as a plain one-liner", () => {
		// Both sections empty — the case that used to stack two 120px voids.
		const { html } = render([], []);
		expect(html).toContain('<div class="gd-empty">None.</div>');
		expect(html).toContain('<div class="gd-empty">No conversations linked yet.</div>');
		expect(html).not.toContain("mem-empty-pane");
	});
});

/**
 * The Context viewer's link bridge.
 *
 * The framed document is sandboxed, so a click inside it can navigate nothing on
 * its own — it posts the href up here instead. That makes `window.open` a real
 * sink fed by a document an agent wrote, which is exactly what CodeQL flagged
 * (`js/client-side-unvalidated-url-redirect`). These pin both gates, because
 * neither is visible to tsc and this file is outside the coverage denominator.
 */
describe("memories.js — context link bridge", () => {
	/** Renders, then drives `JD._ctxNavHandler` the way the frame would. */
	const bridge = () => {
		const { win, doc } = render([PLAN_ROW]);
		const frame = doc.getElementById("ctxFrame") as unknown as { contentWindow: unknown };
		frame.contentWindow = { marker: "the frame" };
		const opened: string[] = [];
		(win as { open: (u: string, t?: string, f?: string) => void }).open = (u) => opened.push(u);
		const handler = (win.JD as { _ctxNavHandler: (ev: unknown) => void })._ctxNavHandler;
		// `source` defaults to the frame, so a case that wants NO source must pass
		// `null` — passing `undefined` triggers the default and silently tests the
		// happy path instead. (That mistake made the "foreign source" case below
		// pass a VALID source and open the url, which is how it was caught.)
		const post = (href: unknown, source: unknown = frame.contentWindow, type = "jolli-context-nav") =>
			handler({ source, data: { type, href } });
		return { post, opened, frame };
	};

	it("opens an http(s) url the frame posted", () => {
		const { post, opened } = bridge();
		post("https://linear.app/acme/issue/ABC-1");
		expect(opened).toEqual(["https://linear.app/acme/issue/ABC-1"]);
	});

	it("refuses every other scheme, javascript: included", () => {
		const { post, opened } = bridge();
		// `\n` inside the scheme is the case the probe rules exist for: a browser
		// strips tab/LF/CR before reading a scheme, so a naive string test passes it.
		for (const href of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "mailto:a@b.c"]) {
			post(href);
		}
		expect(opened).toEqual([]);
	});

	it("refuses a message from anything but the Context frame", () => {
		// Any other frame on the page — or an embedder — could otherwise aim this
		// sink. The Knowledge page's equivalent handler needs no such check: its
		// payload is a hex-validated hash going to a same-origin path.
		const { post, opened, frame } = bridge();
		post("https://evil.test/x", { marker: "someone else" });
		post("https://evil.test/x", null);
		expect(opened).toEqual([]);
		// Same url, right source — proves the rejections above were about the source.
		post("https://evil.test/x", frame.contentWindow);
		expect(opened).toEqual(["https://evil.test/x"]);
	});

	it("ignores a message that is not this bridge's, or carries no string href", () => {
		const { post, opened, frame } = bridge();
		post("https://ok.test/a", frame.contentWindow, "some-other-channel");
		post(42);
		post(null);
		expect(opened).toEqual([]);
	});
});

describe("memories.js — context row badges", () => {
	const reference = (over: Record<string, unknown> = {}) => ({
		kind: "reference",
		title: "JOLLI-2198 — Cutover compare",
		contextKey: "linear/JOLLI-2198",
		source: "linear",
		...over,
	});

	it("badges a reference with its source's letter and brand colour", () => {
		const { html } = render([reference()]);
		expect(html).toContain("background:#5e6ad2");
		expect(html).toContain('title="Linear"');
		expect(html).toContain(">L</span>");
		expect(html).toContain("src-linear");
	});

	it("distinguishes two references that used to render identically", () => {
		const { html } = render([reference(), reference({ source: "sentry", contextKey: "sentry/PROJ-1" })]);
		expect(html).toContain("background:#5e6ad2");
		expect(html).toContain("background:#6559C6");
		// The old behaviour: one amber `R` for every source, whatever it was.
		expect(html).not.toContain(">R</span>");
	});

	it("falls back to the id's initial on the neutral hue for a source with no entry", () => {
		// A phase-2 config-registered source, or one that left the registry —
		// `getSourceMeta`'s fallback, reproduced client-side.
		const { html } = render([reference({ source: "someUnknownSource", contextKey: undefined })]);
		expect(html).toContain("background:#6e7681");
		expect(html).toContain(">S</span>");
	});

	it("sanitizes a source id before it reaches a class token", () => {
		// A source id is a plain string from disk: a space would end the token and
		// inject a second class.
		const { html } = render([reference({ source: "my source", contextKey: undefined })]);
		expect(html).toContain("src-my-source");
	});

	it("still badges a non-reference kind by its kind", () => {
		const { html } = render([PLAN_ROW]);
		expect(html).toContain('<span class="mem-ctx-badge mem-ctx-badge--plan">P</span>');
	});

	// Title over sub-line, as the editor's `.r-main` column does — they shared a
	// line before, and a plan's `<slug>.md` fought the title for width.
	it("stacks the title and the sub-line in one column", () => {
		const { html } = render([{ ...PLAN_ROW, meta: "rate-limit-plan.md" }]);
		expect(html).toContain(
			'<div class="mem-row-main"><span class="mem-row-title">A plan</span>' +
				'<span class="mem-row-meta mem-ctx-sub">rate-limit-plan.md</span></div>',
		);
	});

	it("still emits the column for a row with no sub-line", () => {
		const { html } = render([PLAN_ROW]);
		expect(html).toContain('<div class="mem-row-main"><span class="mem-row-title">A plan</span></div>');
	});

	it("drops the Open → label the editor never had", () => {
		const { html } = render([PLAN_ROW]);
		expect(html).not.toContain("Open →");
		// The affordance that replaces it.
		expect(html).toContain("gd-row-open");
		expect(html).toContain('role="button"');
	});
});

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
		expect(html).toContain('title="Session sess-abc"');
		expect(html).toContain("Add the rate limiter");
	});

	// The id is load-bearing twice: it is the tooltip, and it is the archive key
	// (`source:sessionId`) the viewer looks the conversation up by.
	it("makes a row with a session id an openable button", () => {
		const { html } = render([], [conversation()]);
		expect(html).toContain('<div class="gd-row gd-row-open"');
		expect(html).toContain('role="button" tabindex="0" data-session="sess-abc" data-source="claude"');
	});

	it("leaves a row with no session id inert rather than a button that would 404", () => {
		// Same rule a Context row applies to a missing `contextKey`: without the key
		// there is nothing to fetch, so a plain label beats a dead button.
		const { html } = render([], [conversation({ sessionId: undefined })]);
		expect(html).toContain('<div class="gd-row">');
		expect(html).not.toContain("gd-row-open");
		expect(html).not.toContain("data-session");
	});

	it("carries no Open → label — the hover state and the role are the affordance", () => {
		const { html } = render([], [conversation()]);
		expect(html).not.toContain("Open →");
	});

	it("opens the dialog on click and on Enter/Space", () => {
		const { conversationRows } = render([], [conversation()]);
		const row = conversationRows[0];
		expect(row?.onclick).toBeTypeOf("function");
		for (const key of ["Enter", " "]) {
			const ev = keyEvent(key, false);
			row?.onkeydown?.(ev);
			expect(ev.wasPrevented(), `${key} should activate the row`).toBe(true);
		}
	});

	it("leaves other keys to the browser", () => {
		const { conversationRows } = render([], [conversation()]);
		const ev = keyEvent("a", false);
		conversationRows[0]?.onkeydown?.(ev);
		expect(ev.wasPrevented()).toBe(false);
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

	/**
	 * One overlay serves every row, so a response has to prove it is still the one
	 * being awaited before it writes. Two clicks, answered in the opposite order:
	 * without the guard the first click's document lands on the second's dialog —
	 * title, subtitle and every turn — with nothing on screen saying so.
	 */
	describe("stale responses", () => {
		/** What `/api/conversation` answers with — one loaded document, or a status. */
		const loaded = (title: string) => ({
			ok: true,
			json: () => Promise.resolve({ title, source: "claude", messageCount: 1, entries: [] }),
		});
		const failed = (status: number) => ({ ok: false, status });

		/** Lets the fetch chain's `.then`s run; nothing here waits on a real timer. */
		const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

		/** Renders N openable rows over a fetch the case answers by hand, in any order. */
		const rows = (...conversations: ReadonlyArray<Record<string, unknown>>) => {
			const answer: Array<(res: unknown) => void> = [];
			const harness = render([], conversations, [], {
				fetch: () => new Promise((resolve) => answer.push(resolve)),
			});
			return { ...harness, answer };
		};

		/** Two rows opened back to back, both requests still in flight. */
		const twoOpened = () => {
			const h = rows(
				conversation({ sessionId: "sess-a", title: "A" }),
				conversation({ sessionId: "sess-b", title: "B" }),
			);
			h.conversationRows[0]?.onclick?.(undefined);
			h.conversationRows[1]?.onclick?.(undefined);
			return h;
		};

		it("keeps the second conversation when the first answers late", async () => {
			const h = twoOpened();
			h.answer[1]?.(loaded("B loaded"));
			await settled();
			h.answer[0]?.(loaded("A loaded"));
			await settled();
			expect(h.doc.getElementById("convTitle")?.textContent).toBe("B loaded");
			expect(h.doc.getElementById("convSub")?.textContent).toContain("1 msgs");
		});

		it("keeps the second conversation when the first fails late", async () => {
			// The sharper half: an abandoned request that 404s would otherwise paint
			// its "could not load" over a conversation that loaded fine.
			const h = twoOpened();
			h.answer[1]?.(loaded("B loaded"));
			await settled();
			h.answer[0]?.(failed(404));
			await settled();
			expect(h.doc.getElementById("convTitle")?.textContent).toBe("B loaded");
			expect(h.doc.getElementById("convSub")?.textContent).not.toContain("Could not load");
		});

		it("still reports a failure that belongs to the conversation on screen", async () => {
			// The guard must not swallow the live request's own error — the dialog
			// would sit on "Loading…" forever.
			const h = rows(conversation());
			h.conversationRows[0]?.onclick?.(undefined);
			h.answer[0]?.(failed(404));
			await settled();
			expect(h.doc.getElementById("convSub")?.textContent).toContain("HTTP 404");
		});
	});

	/**
	 * The trimming note. Two independent caps produce it — turns DROPPED past the
	 * entry limit, and a single turn's body CUT at the content limit — and only
	 * the first shows up in the counts the page can see. Wording both as the first
	 * announced "showing the first 12 of 12 turns" for a clipped turn: numbers
	 * that say nothing is missing, printed instead of the thing that was.
	 */
	describe("trimming note", () => {
		/** Opens one conversation over a doc the case supplies, and reads the note back. */
		const noteFor = async (over: Record<string, unknown>) => {
			const answer: Array<(res: unknown) => void> = [];
			const h = render([], [conversation()], [], {
				fetch: () => new Promise((resolve) => answer.push(resolve)),
			});
			h.conversationRows[0]?.onclick?.(undefined);
			answer[0]?.({
				ok: true,
				json: () =>
					Promise.resolve({
						title: "t",
						source: "claude",
						messageCount: 2,
						entries: [
							{ role: "human", content: "a" },
							{ role: "assistant", content: "b" },
						],
						truncated: true,
						clippedEntries: 0,
						...over,
					}),
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			const body = h.doc.getElementById("convBody");
			return (body?.children ?? []).filter((c) => c.className === "conv-note")[0]?.textContent;
		};

		it("counts the turns it dropped", async () => {
			expect(await noteFor({ messageCount: 450 })).toBe(
				"Trimmed for this view: showing the first 2 of 450 turns.",
			);
		});

		it("reports a cut turn as a cut turn, not as missing turns", async () => {
			// The regression: `messageCount` equals what was served, so the old
			// sentence claimed a completeness the reader can check for themselves
			// while the cut characters went unmentioned.
			const note = await noteFor({ clippedEntries: 1 });
			expect(note).toBe("Trimmed for this view: one turn's text cut short.");
			expect(note).not.toContain("2 of 2");
		});

		it("says both when both caps bit", async () => {
			expect(await noteFor({ messageCount: 450, clippedEntries: 2 })).toBe(
				"Trimmed for this view: showing the first 2 of 450 turns; 2 turns' text cut short.",
			);
		});

		it("stays silent when nothing was withheld", async () => {
			expect(await noteFor({ truncated: false })).toBeUndefined();
		});

		it("still says something when the server withheld for a reason this page cannot name", async () => {
			// `truncated` is the gate, the counts are only the wording — so a cap
			// added server-side later is still announced rather than swallowed.
			expect(await noteFor({})).toBe("Trimmed for this view.");
		});
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
