/**
 * Runtime test for the shell's repository scope: the URL builder and the topbar
 * picker.
 *
 * Same reason as `FeedCardAsset.test.ts`: `assets/js/*.js` is plain JavaScript
 * served verbatim, so tsc never sees it. Here that matters more than usual —
 * `shell.js` is the one place the page decides which params survive a click, and
 * a scope that silently stops riding along is invisible until someone notices
 * their numbers cover the wrong project.
 *
 * The stub DOM has to be a little richer than the other asset tests': the picker
 * re-reads its own checkboxes through `querySelectorAll`, and its Apply is a
 * navigation, so `window.location.href` is recorded rather than followed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DashboardMenus } from "./DashboardModel.js";

interface JDNamespace {
	renderShell: (model: unknown) => void;
	query: (model: unknown, over?: Record<string, unknown>) => string;
	scopeIdentities: (model: unknown) => string[];
	repoToken: (model: unknown, identity: string) => string;
	/** The shell's own POST helper, overwritten by the remove-control cases. */
	post: (path: string, body?: unknown) => Promise<unknown>;
}

interface FakeInput {
	type: string;
	checked: boolean;
	/** DOM PROPERTY, not an attribute — the picker sets it after each render. */
	indeterminate: boolean;
	onchange?: () => void;
	attrs: Record<string, string>;
	getAttribute: (name: string) => string | null;
}

interface FakeElement {
	innerHTML: string;
	/**
	 * How many times `innerHTML` has been ASSIGNED. The picker's rows must not be
	 * rewritten on a toggle or a poll tick — that replaces the checkbox the reader
	 * is standing on — so the count is the only observable that distinguishes
	 * "updated the ticks" from "redrew the list".
	 */
	htmlWrites: number;
	textContent: string;
	hidden: boolean;
	disabled: boolean;
	style: Record<string, string>;
	attrs: Record<string, string>;
	onclick?: () => void;
	onsubmit?: (event: { preventDefault: () => void }) => void;
	setAttribute: (name: string, value: string) => void;
	getAttribute: (name: string) => string | null;
	getBoundingClientRect: () => { top: number; bottom: number; left: number; width: number };
	querySelectorAll: (selector: string) => ReadonlyArray<FakeInput>;
	querySelector: (selector: string) => FakeElement | null;
	addEventListener: () => void;
	focus: () => void;
}

/** The ✕ a missing repo's row carries. Its own shape: it has an `onclick`. */
interface FakeButton {
	disabled: boolean;
	attrs: Record<string, string>;
	getAttribute: (name: string) => string | null;
	onclick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

interface Harness {
	JD: JDNamespace;
	element: (id: string) => FakeElement;
	/** Checkboxes the picker last wrote into `#repoScopeList`, by `data-repo` / `all`. */
	boxes: () => ReadonlyArray<FakeInput>;
	/** Remove controls the picker last wrote, by `data-forget`. */
	forgetButtons: () => ReadonlyArray<FakeButton>;
	href: () => string;
	/** The window object the asset ran against, for `confirm` / `alert` / reload. */
	win: Record<string, unknown>;
	/** Every `document`-level keydown listener still bound, so leaks are visible. */
	keydownCount: () => number;
	escape: () => void;
}

/**
 * Parses the checkbox markup the picker wrote, so a click can be driven through
 * the same `onchange` the browser would call. Deliberately a regex over the
 * emitted HTML rather than a DOM: this suite has no DOM, and what it is testing
 * is precisely the string the renderer produced.
 *
 * Both ticks start FALSE, and that is the contract rather than a stub shortcut:
 * `checked` and `indeterminate` are DOM properties the picker writes after the
 * markup exists, because a tick in the markup can only be applied by redrawing —
 * which destroys the focused row. So the markup carries the rows, never the state.
 */
function parseBoxes(html: string): FakeInput[] {
	const out: FakeInput[] = [];
	for (const match of html.matchAll(/<input type="checkbox" (data-repo-all="1"|data-repo="([^"]*)")>/g)) {
		const attrs: Record<string, string> = match[1].startsWith("data-repo-all")
			? { "data-repo-all": "1" }
			: { "data-repo": match[2] };
		out.push({
			type: "checkbox",
			checked: false,
			indeterminate: false,
			attrs,
			getAttribute: (name) => attrs[name] ?? null,
		});
	}
	return out;
}

/**
 * The same trick as {@link parseBoxes}, for the remove control.
 *
 * Parses the whole tag rather than one attribute: the ✕ now carries the absence
 * KIND alongside the identity (`data-forget-volume`), and a parser that picks
 * attributes by name one at a time makes every later one invisible to the handler
 * under test — the click would silently take the wrong branch and the test would
 * still be asserting something.
 */
function parseForgetButtons(html: string): FakeButton[] {
	const out: FakeButton[] = [];
	for (const tag of html.matchAll(/<button\b[^>]*\bdata-forget="[^"]*"[^>]*>/g)) {
		const attrs: Record<string, string> = {};
		for (const attr of tag[0].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]] = attr[2];
		out.push({ disabled: false, attrs, getAttribute: (name) => attrs[name] ?? null });
	}
	return out;
}

function loadJD(): Harness {
	const elements = new Map<string, FakeElement>();
	let listeners: Array<(event: { key: string }) => void> = [];
	let lastBoxes: FakeInput[] = [];
	let lastForget: FakeButton[] = [];
	const make = (): FakeElement => {
		const attrs: Record<string, string> = {};
		let html = "";
		// Element IDENTITY, which is the whole point of the rebuild-only-when-changed
		// rule: re-parsed only when the markup actually changed, so an unchanged list
		// hands back the same box objects a browser would — the ones still holding
		// focus — rather than silently fresh ones.
		let parsed: FakeInput[] = [];
		let parsedFrom: string | null = null;
		const self: FakeElement = {
			get innerHTML() {
				return html;
			},
			set innerHTML(next: string) {
				html = next;
				self.htmlWrites++;
			},
			htmlWrites: 0,
			textContent: "",
			hidden: false,
			disabled: false,
			style: {},
			attrs,
			setAttribute: (name, value) => {
				attrs[name] = value;
			},
			getAttribute: (name) => attrs[name] ?? null,
			getBoundingClientRect: () => ({ top: 0, bottom: 40, left: 0, width: 100 }),
			querySelectorAll: (selector) => {
				// The picker re-reads the boxes it just wrote; everything else in the
				// shell (the range segment, the nav) has no rows in this harness.
				if (selector === "button[data-forget]") {
					// Re-parsed on every ask rather than cached against `html` like the
					// boxes: identity does not matter here (nothing holds focus on it),
					// and a shared cache key would make one selector evict the other.
					lastForget = parseForgetButtons(html);
					return lastForget as unknown as ReadonlyArray<FakeInput>;
				}
				if (selector !== "input[type=checkbox]") return [];
				if (parsedFrom !== html) {
					parsed = parseBoxes(html);
					parsedFrom = html;
				}
				lastBoxes = parsed;
				return parsed;
			},
			querySelector: () => make(),
			addEventListener: () => undefined,
			focus: () => undefined,
		};
		return self;
	};
	const doc = {
		getElementById: (id: string) => {
			if (!elements.has(id)) elements.set(id, make());
			return elements.get(id);
		},
		querySelectorAll: () => [],
		addEventListener: (_type: string, fn: (event: { key: string }) => void) => void listeners.push(fn),
		removeEventListener: (_type: string, fn: (event: { key: string }) => void) => {
			listeners = listeners.filter((each) => each !== fn);
		},
		createElement: make,
		body: make(),
	};
	const location = { href: "" };
	const win = {
		JD: {},
		document: doc,
		location,
		innerWidth: 1400,
		innerHeight: 900,
		addEventListener: () => undefined,
		navigator: {},
	} as Record<string, unknown>;
	for (const file of ["format.js", "shell.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}
	return {
		JD: win.JD as unknown as JDNamespace,
		element: (id) => doc.getElementById(id) as FakeElement,
		boxes: () => lastBoxes,
		forgetButtons: () => lastForget,
		win,
		href: () => location.href,
		keydownCount: () => listeners.length,
		escape: () => {
			for (const fn of [...listeners]) fn({ key: "Escape" });
		},
	};
}

const JOLLIAI = "https://github.com/jolliai/jolliai";
const SITE = "https://github.com/jolliai/site";

function model(over: Record<string, unknown> = {}): unknown {
	return {
		schemaVersion: 3,
		view: "stats",
		tier: "memory",
		generatedAtMs: Date.parse("2026-07-30T12:00:00Z"),
		timeZone: "UTC",
		scope: { kind: "all" },
		repos: [
			{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
			{ repoIdentity: SITE, repoName: "site", worktreeRoot: "/b", sessionsThisWeek: 1 },
		],
		coverage: [],
		stats: { range: "month", rangeFrom: "2026-07-01", rangeTo: "2026-07-30", seriesDimension: "model" },
		...over,
	};
}

const scoped = (...identities: string[]) => ({ kind: "repo", repoIdentities: identities });

/**
 * Three repos, for the cases that need a selection which is genuinely PARTIAL.
 * With the two-repo fixture, ticking the second is "all" — and all-ticked
 * deliberately collapses to the empty param, so those cases would be asserting
 * the opposite of what they mean to.
 */
const THIRD = "https://github.com/jolliai/docs";
const threeRepos = (over: Record<string, unknown> = {}): unknown =>
	model({
		repos: [
			{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
			{ repoIdentity: SITE, repoName: "site", worktreeRoot: "/b", sessionsThisWeek: 1 },
			{ repoIdentity: THIRD, repoName: "docs", worktreeRoot: "/c", sessionsThisWeek: 0 },
		],
		...over,
	});

describe("JD.scopeIdentities", () => {
	const { JD } = loadJD();

	it("answers an empty list for the all-repos scope", () => {
		expect(JD.scopeIdentities(model())).toEqual([]);
	});

	it("answers the selected identities in order", () => {
		expect(JD.scopeIdentities(model({ scope: scoped(SITE, JOLLIAI) }))).toEqual([SITE, JOLLIAI]);
	});

	it("survives a model with no scope at all rather than throwing", () => {
		// The refresh loop repaints whatever it last held, and a hand-built or
		// pre-upgrade payload is exactly what reaches here after a schema bump.
		expect(JD.scopeIdentities({})).toEqual([]);
	});
});

describe("JD.query — repo params", () => {
	const { JD } = loadJD();

	it("emits nothing for the all-repos scope", () => {
		expect(JD.query(model())).toBe("?range=month&dimension=model");
	});

	it("emits one repo= for a single selection, as old links carry", () => {
		expect(JD.query(model({ scope: scoped(JOLLIAI) }))).toContain("repo=jolliai&");
	});

	it("emits one repo= per identity, never a joined list", () => {
		const query = JD.query(model({ scope: scoped(JOLLIAI, SITE) }));
		expect(query).toContain("repo=jolliai");
		expect(query).toContain("repo=site");
		// A delimiter would be a character a remote URL may legitimately contain.
		expect(query).not.toContain(",");
	});

	it("shortens each identity independently through repoToken", () => {
		const dupes = model({
			repos: [
				{
					repoIdentity: "https://github.com/one/jolli",
					repoName: "jolli",
					worktreeRoot: "/a",
					sessionsThisWeek: 0,
				},
				{
					repoIdentity: "https://github.com/two/jolli",
					repoName: "jolli",
					worktreeRoot: "/b",
					sessionsThisWeek: 0,
				},
				{ repoIdentity: SITE, repoName: "site", worktreeRoot: "/c", sessionsThisWeek: 0 },
			],
			scope: scoped("https://github.com/one/jolli", SITE),
		});
		// The ambiguous one keeps its identity; the unique one shortens. Both in
		// the same URL — a per-URL choice would have to pick one rule for both.
		expect(JD.query(dupes)).toContain("repo=https%3A%2F%2Fgithub.com%2Fone%2Fjolli");
		expect(JD.query(dupes)).toContain("repo=site");
	});

	it("clears the scope when overridden with an empty list", () => {
		expect(JD.query(model({ scope: scoped(JOLLIAI) }), { repo: [] })).not.toContain("repo=");
	});
});

describe("the topbar repo picker", () => {
	it("labels the scope, and opens seeded from it", () => {
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI) }));
		expect(h.element("repoScopeLabel").textContent).toBe("jolliai");
		expect(h.element("repoScope").hidden).toBe(true);

		h.element("repoScopeBtn").onclick?.();
		expect(h.element("repoScope").hidden).toBe(false);
		expect(h.element("repoScopeBtn").getAttribute("aria-expanded")).toBe("true");
		const boxes = h.boxes();
		expect(boxes.map((b) => [b.getAttribute("data-repo-all") ?? b.getAttribute("data-repo"), b.checked])).toEqual([
			["1", false],
			[JOLLIAI, true],
			[SITE, false],
		]);
	});

	it("counts rather than naming past one repo", () => {
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI, SITE) }));
		expect(h.element("repoScopeLabel").textContent).toBe("2 repos");
	});

	it("tells same-named repos apart by their checkout path", () => {
		// A repo name is a directory basename, so three clones all called `repo`
		// is ordinary, not a corner — and identical rows are a list you cannot
		// choose from. Measured on a real machine: 3 of its 6 repos shared a name.
		const h = loadJD();
		h.JD.renderShell(
			model({
				repos: [
					{ repoIdentity: "local:a", repoName: "repo", worktreeRoot: "/src/one", sessionsThisWeek: 2 },
					{ repoIdentity: "local:b", repoName: "repo", worktreeRoot: "/src/two", sessionsThisWeek: 0 },
					{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/src/jolliai", sessionsThisWeek: 5 },
				],
			}),
		);
		h.element("repoScopeBtn").onclick?.();
		const html = h.element("repoScopeList").innerHTML;
		expect(html).toContain("/src/one");
		expect(html).toContain("/src/two");
		// The unambiguous row keeps the session figure — the path is only worth
		// the space where it is the thing that differs.
		expect(html).toContain("5 sessions · 7d");
		expect(html).not.toContain("/src/jolliai</span>");
	});

	it("lists a paused repo, marks it, and keeps it selectable", () => {
		// A paused repo's rows are never deleted and it still counts in the
		// aggregate numbers, so it belongs in the list — its history is worth
		// reaching. It draws dimmed with a `paused` meta over its session figure,
		// and its checkbox works like any other.
		const h = loadJD();
		h.JD.renderShell(
			model({
				repos: [
					{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
					{ repoIdentity: SITE, repoName: "site", worktreeRoot: "/b", sessionsThisWeek: 1 },
					{ repoIdentity: THIRD, repoName: "docs", worktreeRoot: "/c", sessionsThisWeek: 0, disabled: true },
				],
				scope: scoped(JOLLIAI),
			}),
		);
		h.element("repoScopeBtn").onclick?.();
		const html = h.element("repoScopeList").innerHTML;
		// Flagged for the stylesheet, and the meta says paused rather than "0 sessions".
		expect(html).toContain('class="repo-scope-row paused"');
		expect(html).toContain(">paused</span>");
		expect(html).not.toContain("0 sessions");
		// A real checkbox — ticking it and applying scopes the page to it.
		const docs = h.boxes().find((b) => b.getAttribute("data-repo") === THIRD);
		expect(docs).toBeDefined();
		docs?.onchange?.();
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).toContain("repo=docs");
	});

	it("marks a repo whose folder is gone, keeps it selectable, and offers a ✕", () => {
		// Marked, never dropped: the memories are still reachable. What must not
		// happen is the row reading as a working checkout, since every action on it
		// names a directory that is not there.
		const h = loadJD();
		h.JD.renderShell(
			model({
				repos: [
					{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
					{ repoIdentity: SITE, repoName: "site", worktreeRoot: "/b", sessionsThisWeek: 1 },
					{ repoIdentity: THIRD, repoName: "docs", worktreeRoot: "/c", sessionsThisWeek: 0, missing: true },
				],
				scope: scoped(JOLLIAI),
			}),
		);
		h.element("repoScopeBtn").onclick?.();
		const html = h.element("repoScopeList").innerHTML;

		expect(html).toContain('class="repo-scope-row missing"');
		expect(html).toContain(">folder missing</span>");
		expect(html).toContain(`data-forget="${THIRD}"`);
		// Only the dead row gets one.
		expect(h.forgetButtons().map((b) => b.getAttribute("data-forget"))).toEqual([THIRD]);
		// Still a real checkbox — its history is worth scoping to. (Three repos, so
		// the two-of-three selection stays a `repo=` param instead of collapsing to
		// "all", which is what an all-ticked list means.)
		h.boxes()
			.find((b) => b.getAttribute("data-repo") === THIRD)
			?.onchange?.();
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).toContain("repo=docs");
	});

	it("says the drive is not mounted rather than claiming the folder is gone", () => {
		// The two absences are not degrees of one thing: here the repository is
		// probably fine and the machine is what is missing, so the row must not
		// assert a deletion. `existsSync` alone cannot tell them apart.
		const h = loadJD();
		h.JD.renderShell(
			model({
				repos: [
					{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
					{
						repoIdentity: THIRD,
						repoName: "docs",
						worktreeRoot: "Z:\\docs",
						sessionsThisWeek: 0,
						missing: true,
						volumeUnavailable: true,
					},
				],
				scope: scoped(JOLLIAI),
			}),
		);
		h.element("repoScopeBtn").onclick?.();
		const html = h.element("repoScopeList").innerHTML;

		expect(html).toContain(">drive not mounted</span>");
		expect(html).not.toContain(">folder missing</span>");
		// Still the `missing` class and still a ✕ — the row is unreachable either way,
		// and withholding the control is what B rejected.
		expect(html).toContain('class="repo-scope-row missing"');
		expect(html).toContain('data-forget-volume="1"');
	});

	it("shows both flags when a repo is paused AND gone", () => {
		const h = loadJD();
		h.JD.renderShell(
			model({
				repos: [
					{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
					{
						repoIdentity: THIRD,
						repoName: "docs",
						worktreeRoot: "/c",
						sessionsThisWeek: 0,
						disabled: true,
						missing: true,
					},
				],
				scope: scoped(JOLLIAI),
			}),
		);
		h.element("repoScopeBtn").onclick?.();
		const html = h.element("repoScopeList").innerHTML;
		expect(html).toContain('class="repo-scope-row paused missing"');
		expect(html).toContain(">paused · folder missing</span>");
	});

	it("keeps the disambiguating path when neither flag is set", () => {
		// The flags take the meta slot; without them two same-named repos still get
		// their checkout paths, which is the only thing telling them apart.
		const h = loadJD();
		h.JD.renderShell(
			model({
				repos: [
					{ repoIdentity: "local:a", repoName: "repo", worktreeRoot: "/src/one", sessionsThisWeek: 2 },
					{ repoIdentity: "local:b", repoName: "repo", worktreeRoot: "/src/two", sessionsThisWeek: 0 },
				],
				scope: scoped("local:a"),
			}),
		);
		h.element("repoScopeBtn").onclick?.();
		const html = h.element("repoScopeList").innerHTML;
		expect(html).toContain('class="meta path"');
		expect(html).toContain("/src/two");
	});

	describe("the ✕ itself", () => {
		const withMissingRow = (): Harness => {
			const h = loadJD();
			h.JD.renderShell(
				model({
					repos: [
						{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
						{
							repoIdentity: THIRD,
							repoName: "docs",
							worktreeRoot: "/c",
							sessionsThisWeek: 0,
							missing: true,
						},
					],
					scope: scoped(JOLLIAI),
				}),
			);
			h.element("repoScopeBtn").onclick?.();
			return h;
		};
		const withVolumeRow = (): Harness => {
			const h = loadJD();
			h.JD.renderShell(
				model({
					repos: [
						{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 3 },
						{
							repoIdentity: THIRD,
							repoName: "docs",
							worktreeRoot: "Z:\\docs",
							sessionsThisWeek: 0,
							missing: true,
							volumeUnavailable: true,
						},
					],
					scope: scoped(JOLLIAI),
				}),
			);
			h.element("repoScopeBtn").onclick?.();
			return h;
		};
		const click = (h: Harness): void => {
			const [btn] = h.forgetButtons();
			btn.onclick?.({ preventDefault: () => undefined, stopPropagation: () => undefined });
		};
		/** Answers each `confirm` in turn, recording the sentences it was shown. */
		const confirmScript = (h: Harness, answers: ReadonlyArray<boolean>): string[] => {
			const shown: string[] = [];
			h.win.confirm = (message: string) => {
				shown.push(message);
				return answers[shown.length - 1] ?? false;
			};
			return shown;
		};

		it("posts nothing until the confirmation is accepted", () => {
			const h = withMissingRow();
			const posts: string[] = [];
			h.win.confirm = () => false;
			h.JD.post = (path: string) => {
				posts.push(path);
				return Promise.resolve({});
			};
			click(h);
			expect(posts).toEqual([]);
		});

		it("forgets the identity on the row and reloads", async () => {
			const h = withMissingRow();
			const calls: Array<[string, unknown]> = [];
			let reloaded = 0;
			h.win.confirm = () => true;
			h.win.location = { reload: () => void reloaded++ };
			h.JD.post = (path: string, body: unknown) => {
				calls.push([path, body]);
				return Promise.resolve({ ok: true });
			};
			click(h);
			await Promise.resolve();
			await Promise.resolve();

			expect(calls).toEqual([["/api/repos/forget", { repoIdentity: THIRD }]]);
			expect(reloaded).toBe(1);
		});

		it("re-enables the button and says why when the removal was refused", async () => {
			// A 409 (the folder came back) has to leave the control usable — the page
			// has no other way to retry, and a dead ✕ reads as a broken dashboard.
			const h = withMissingRow();
			const alerts: string[] = [];
			h.win.confirm = () => true;
			h.win.alert = (message: string) => void alerts.push(message);
			h.JD.post = () => Promise.reject(new Error("that repository still exists on disk"));
			const [btn] = h.forgetButtons();

			click(h);
			await Promise.resolve();
			await Promise.resolve();

			expect(btn.disabled).toBe(false);
			expect(alerts[0]).toContain("still exists on disk");
		});

		it("asks a deleted folder for ONE confirmation, and says so", () => {
			const h = withMissingRow();
			const shown = confirmScript(h, [true]);
			h.win.location = { reload: () => undefined };
			h.JD.post = () => Promise.resolve({ ok: true });
			click(h);

			expect(shown).toHaveLength(1);
			expect(shown[0]).toContain("folder cannot be found");
		});

		it("asks TWO confirmations for an unmounted volume, each saying something true", () => {
			// The likeliest reading of this row is "plug it back in", and the
			// registration is kept on purpose — so the first sentence must not claim a
			// deletion, and the second has to offer waiting as the alternative.
			const h = withVolumeRow();
			const shown = confirmScript(h, [true, true]);
			const calls: Array<[string, unknown]> = [];
			h.win.location = { reload: () => undefined };
			h.JD.post = (path: string, body: unknown) => {
				calls.push([path, body]);
				return Promise.resolve({ ok: true });
			};
			click(h);

			expect(shown).toHaveLength(2);
			expect(shown[0]).toContain("not mounted");
			expect(shown[0]).not.toContain("cannot be undone");
			expect(shown[1]).toContain("reconnect it instead");
			// The flag is the record that a human saw that second sentence — the server
			// refuses this verdict without it.
			expect(calls).toEqual([["/api/repos/forget", { repoIdentity: THIRD, acknowledgeUnavailableVolume: true }]]);
		});

		it("posts nothing when the second confirmation is declined", () => {
			const h = withVolumeRow();
			const shown = confirmScript(h, [true, false]);
			const posts: string[] = [];
			h.JD.post = (path: string) => {
				posts.push(path);
				return Promise.resolve({});
			};
			click(h);

			expect(shown).toHaveLength(2);
			expect(posts).toEqual([]);
		});
	});

	it("names the exact identities on the button, where the label cannot", () => {
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI, SITE) }));
		expect(h.element("repoScopeBtn").getAttribute("title")).toBe(`${JOLLIAI}\n${SITE}`);
		h.JD.renderShell(model());
		expect(h.element("repoScopeBtn").getAttribute("title")).toBe("Every registered repository");
	});

	it("names the identity when the repo has left the list", () => {
		// Paused since the page was rendered: the identity is still what the
		// numbers were filtered by, so the label must not go blank.
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped("local:gone") }));
		expect(h.element("repoScopeLabel").textContent).toBe("local:gone");
	});

	it("ticking a second repo applies both", () => {
		const h = loadJD();
		h.JD.renderShell(threeRepos({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		const site = h.boxes().find((b) => b.getAttribute("data-repo") === SITE);
		site?.onchange?.();
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).toContain("repo=jolliai");
		expect(h.href()).toContain("repo=site");
	});

	// ── the select-all master row ──────────────────────────────────────────
	//
	// Two things have to hold at once, and they pull in opposite directions:
	// the DRAWN state is the ordinary tri-state select-all every list like this
	// uses (all ticked / some ticked + indeterminate / none), while the STORED
	// state for "all" is an EMPTY `?repo=` — an explicit list of every repo goes
	// stale the moment one is registered, silently excluding it from a scope
	// that reads as "all". These cases pin both halves and the seam between.

	it("seeds every box ticked on an unscoped page, not none", () => {
		const h = loadJD();
		h.JD.renderShell(model());
		h.element("repoScopeBtn").onclick?.();
		expect(h.boxes().every((b) => b.checked)).toBe(true);
		expect(h.element("repoScopeSelection").textContent).toBe("All repositories");
	});

	it("collapses an all-ticked selection back to the empty param", () => {
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		// Tick the one that is missing → every box ticked → "all".
		h.boxes()
			.find((b) => b.getAttribute("data-repo") === SITE)
			?.onchange?.();
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).not.toContain("repo=");
		expect(h.href()).toContain("/dashboard?");
	});

	it("marks the master row indeterminate for a partial selection", () => {
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		const master = () => h.boxes().find((b) => b.getAttribute("data-repo-all"));
		expect(master()?.indeterminate).toBe(true);
		expect(master()?.checked).toBe(false);
		// Tick the rest → checked, not indeterminate.
		h.boxes()
			.find((b) => b.getAttribute("data-repo") === SITE)
			?.onchange?.();
		expect(master()?.indeterminate).toBe(false);
		expect(master()?.checked).toBe(true);
	});

	it("the master row clears when it is already all, and selects all otherwise", () => {
		const h = loadJD();
		h.JD.renderShell(model());
		h.element("repoScopeBtn").onclick?.();
		// All → none.
		h.boxes()
			.find((b) => b.getAttribute("data-repo-all"))
			?.onchange?.();
		expect(h.boxes().some((b) => b.checked)).toBe(false);
		// None → all again.
		h.boxes()
			.find((b) => b.getAttribute("data-repo-all"))
			?.onchange?.();
		expect(h.boxes().every((b) => b.checked)).toBe(true);
	});

	it("refuses to apply an empty selection instead of widening it to all", () => {
		// A scope of zero repositories is not expressible — the server reads an
		// empty `?repo=` as EVERY repo — so applying nothing would hand back the
		// widest answer under a control that says none. Say why instead.
		const h = loadJD();
		h.JD.renderShell(model());
		h.element("repoScopeBtn").onclick?.();
		h.boxes()
			.find((b) => b.getAttribute("data-repo-all"))
			?.onchange?.();
		expect(h.element("repoScopeApply").disabled).toBe(true);
		expect(h.element("repoScopeSelection").textContent).toBe("Select at least one repository");
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).toBe("");
	});

	it("hides itself with only one repo to pick between", () => {
		const h = loadJD();
		const one = [{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 1 }];
		h.JD.renderShell(model({ repos: one }));
		expect(h.element("repoScopeWrap").hidden).toBe(true);
	});

	// ── a `?repo=` token naming nothing registered ─────────────────────────
	//
	// The server keeps such a token rather than dropping it (`resolveScope` leaves
	// what it cannot resolve in place, and the query side folds it to a row id that
	// matches nothing) precisely so the page cannot silently widen to every repo —
	// which makes showing the way out of it the client's job. Reachable from an
	// ordinary bookmark: a repo disabled, removed, or re-cloned to a new remote.

	const GHOST = "https://github.com/jolliai/gone";

	it("ticks only the repos a dead token leaves, and drops it on Apply", () => {
		const h = loadJD();
		h.JD.renderShell(threeRepos({ scope: scoped(GHOST, JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		// The dead token is not a row, so it cannot be drawn — and must not be
		// counted either. Counting it made two ticks out of three read as "all",
		// which Apply then stored as the empty param: "just jolliai" silently
		// widened to every repo.
		expect(h.boxes().map((b) => b.checked)).toEqual([false, true, false, false]);
		expect(h.element("repoScopeSelection").textContent).toBe("1 repository selected");

		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).toContain("repo=jolliai");
		expect(h.href()).not.toContain("gone");
	});

	it("counts only the live half of the scope on the button", () => {
		// The label is drawn from the same scope as the ticks, the footer and
		// `everyRepoSelected`, and those three already count only what is there —
		// a dead token folds to a row id matching nothing, so the page under this
		// button is showing ONE repo. Counting the token said "2 repos" over it.
		const h = loadJD();
		h.JD.renderShell(threeRepos({ scope: scoped(GHOST, JOLLIAI) }));
		expect(h.element("repoScopeLabel").textContent).toBe("jolliai");
		// The dead token is not hidden, it just does not COUNT: the button's title
		// is still the full list, which is what shows the reader what to drop.
		expect(h.element("repoScopeBtn").getAttribute("title")).toBe(`${GHOST}\n${JOLLIAI}`);
	});

	it("says no repo matched rather than borrowing the empty scope's label", () => {
		// Every token dead. "All repos" is the EMPTY scope and would be the exact
		// inverse of what this page shows, which is nothing at all; a lone token
		// still names itself (asserted above), but several have no name to give.
		const h = loadJD();
		h.JD.renderShell(threeRepos({ scope: scoped(GHOST, `${GHOST}-2`) }));
		expect(h.element("repoScopeLabel").textContent).toBe("No matching repos");
	});

	it("stays visible with a single repo when the URL carries a dead token", () => {
		// The one case where "nothing to pick between" is false with one repo: the
		// page is showing an empty scope nothing on it explains, and every link
		// rebuilds that token into the next URL — so hiding the control leaves no
		// way back short of editing the address bar.
		const h = loadJD();
		const one = [{ repoIdentity: JOLLIAI, repoName: "jolliai", worktreeRoot: "/a", sessionsThisWeek: 1 }];
		h.JD.renderShell(model({ repos: one, scope: scoped(GHOST) }));
		expect(h.element("repoScopeWrap").hidden).toBe(false);

		h.element("repoScopeBtn").onclick?.();
		// Nothing live in the scope → nothing ticked, and Apply off until the reader
		// picks. That is the honest drawing of a scope naming no live repo, and
		// ticking the only repo there is clears the token.
		expect(h.boxes().some((b) => b.checked)).toBe(false);
		expect(h.element("repoScopeApply").disabled).toBe(true);
		expect(h.element("repoScopeSelection").textContent).toBe("Select at least one repository");

		h.boxes()
			.find((b) => b.getAttribute("data-repo") === JOLLIAI)
			?.onchange?.();
		expect(h.element("repoScopeApply").disabled).toBe(false);
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).not.toContain("repo=");
	});

	it("still hides itself when a dead token is the only thing there is", () => {
		// No repo registered at all: every row would be unpickable, so the control
		// has nothing to offer and the empty page speaks for itself.
		const h = loadJD();
		h.JD.renderShell(model({ repos: [], scope: scoped(GHOST) }));
		expect(h.element("repoScopeWrap").hidden).toBe(true);
	});

	// ── the rows are not redrawn for a tick ────────────────────────────────
	//
	// `list.innerHTML = …` replaces the very checkbox the reader is standing on, so
	// with the tick state in the markup every toggle destroyed its own focus and
	// keyboard multi-select lost its place after each row. The state lives on the
	// DOM properties instead; these two pin that the markup stops moving.

	it("updates ticks in place instead of rebuilding the rows", () => {
		const h = loadJD();
		h.JD.renderShell(threeRepos({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		const drawn = h.element("repoScopeList").htmlWrites;
		const before = h.boxes();
		const site = before.find((b) => b.getAttribute("data-repo") === SITE);

		site?.onchange?.();

		expect(h.element("repoScopeList").htmlWrites).toBe(drawn);
		// Same objects, not equal-looking replacements — a rebuilt list would be
		// new elements, and the focused one would be gone.
		expect(h.boxes()[0]).toBe(before[0]);
		expect(site?.checked).toBe(true);
	});

	it("leaves the open list alone across a refresh tick that changed nothing", () => {
		const h = loadJD();
		const m = threeRepos({ scope: scoped(JOLLIAI) });
		h.JD.renderShell(m);
		h.element("repoScopeBtn").onclick?.();
		const drawn = h.element("repoScopeList").htmlWrites;
		const before = h.boxes();

		h.JD.renderShell(m);

		expect(h.element("repoScopeList").htmlWrites).toBe(drawn);
		expect(h.boxes()[0]).toBe(before[0]);
	});

	it("redraws when a repo appears while the list is open", () => {
		// The other half of the same rule: rows that genuinely changed have to be
		// rebuilt, or a newly registered repo is unreachable until the popover is
		// closed and re-opened.
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		const drawn = h.element("repoScopeList").htmlWrites;

		h.JD.renderShell(threeRepos({ scope: scoped(JOLLIAI) }));

		expect(h.element("repoScopeList").htmlWrites).toBe(drawn + 1);
		expect(h.boxes()).toHaveLength(4);
		// The in-progress selection survives the redraw.
		expect(
			h
				.boxes()
				.filter((b) => b.checked)
				.map((b) => b.getAttribute("data-repo")),
		).toEqual([JOLLIAI]);
	});

	it("hides itself on a view the scope does not narrow", () => {
		// Every view HEAD ships is scoped, so this is reached only by a future
		// one. `SCOPED_VIEWS` is an allowlist for that reason: an unrecognised
		// view hides the control rather than offering a switch that does nothing.
		const h = loadJD();
		h.JD.renderShell(model({ view: "knowledge" }));
		expect(h.element("repoScopeWrap").hidden).toBe(true);
	});

	it("closes an open popover when a re-render hides the control", () => {
		// Otherwise the list survives its own control disappearing — a floating
		// panel anchored to nothing.
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		h.JD.renderShell(model({ view: "knowledge" }));
		expect(h.element("repoScope").hidden).toBe(true);
	});

	it("keeps an open popover and its ticks across a refresh tick", () => {
		// renderShell runs on the 30 s poll. Closing the popover there would yank
		// it shut mid-selection; leaving it alone would strand its checkboxes on
		// the previous closure while Apply read the new one.
		const h = loadJD();
		const m = threeRepos({ scope: scoped(JOLLIAI) });
		h.JD.renderShell(m);
		h.element("repoScopeBtn").onclick?.();
		h.boxes()
			.find((b) => b.getAttribute("data-repo") === SITE)
			?.onchange?.();

		h.JD.renderShell(m);
		expect(h.element("repoScope").hidden).toBe(false);
		expect(
			h
				.boxes()
				.filter((b) => b.checked)
				.map((b) => b.getAttribute("data-repo")),
		).toEqual([JOLLIAI, SITE]);

		// Apply reads THIS render's selection, not the one frozen at open time.
		h.element("repoScope").onsubmit?.({ preventDefault: () => undefined });
		expect(h.href()).toContain("repo=jolliai");
		expect(h.href()).toContain("repo=site");
	});

	it("binds exactly one Escape handler however many times it re-renders", () => {
		const h = loadJD();
		const m = model({ scope: scoped(JOLLIAI) });
		for (let tick = 0; tick < 5; tick++) h.JD.renderShell(m);
		// One for the picker, one for the range calendar — never five of each.
		expect(h.keydownCount()).toBe(2);

		h.element("repoScopeBtn").onclick?.();
		h.escape();
		expect(h.element("repoScope").hidden).toBe(true);
	});

	it("Cancel discards the pending ticks", () => {
		const h = loadJD();
		const m = model({ scope: scoped(JOLLIAI) });
		h.JD.renderShell(m);
		h.element("repoScopeBtn").onclick?.();
		h.boxes()
			.find((b) => b.getAttribute("data-repo") === SITE)
			?.onchange?.();
		h.element("repoScopeCancel").onclick?.();
		expect(h.element("repoScope").hidden).toBe(true);

		h.JD.renderShell(m);
		expect(h.element("repoScope").hidden).toBe(true);
		expect(h.element("repoScopeLabel").textContent).toBe("jolliai");
	});

	// The case above re-renders between Cancel and the assertion, which is what
	// hid this: `close()` clears `repoPending` but not the closure's own `picked`,
	// and re-opening reads `picked`. A render in between recomputes it from the
	// server's scope — so the discard only actually happened on the poll tick, up
	// to PAGE_REFRESH_MS later. Re-opening before that tick brought the cancelled
	// ticks back.
	it("Cancel discards the pending ticks even when re-opened before the next render", () => {
		const h = loadJD();
		h.JD.renderShell(model({ scope: scoped(JOLLIAI) }));
		h.element("repoScopeBtn").onclick?.();
		h.boxes()
			.find((b) => b.getAttribute("data-repo") === SITE)
			?.onchange?.();
		expect(h.boxes().find((b) => b.getAttribute("data-repo") === SITE)?.checked).toBe(true);

		h.element("repoScopeCancel").onclick?.();
		h.element("repoScopeBtn").onclick?.();

		expect(h.element("repoScope").hidden).toBe(false);
		expect(
			h.boxes().map((b) => [b.getAttribute("data-repo-all") ?? b.getAttribute("data-repo"), b.checked]),
		).toEqual([
			["1", false],
			[JOLLIAI, true],
			[SITE, false],
		]);
	});
});

/**
 * The sidebar's two OPTIONAL rows (Settings → Advanced).
 *
 * Worth its own suite for the same reason the scope cases above are: the rows are
 * built by string concatenation into `#sbNav`, so tsc never sees them, and the
 * failure mode is silent in both directions — a row that never appears however it
 * is configured looks exactly like "the user left it off", and a row that ignores
 * the flag looks exactly like the feature was never built.
 *
 * `data-nav-view` rather than the visible label: the label is also what the
 * DASHBOARDS title table carries, so matching on it would pass on a page title
 * while the row was missing.
 */
describe("JD.renderShell — optional nav rows", () => {
	const navViews = (h: Harness): string[] =>
		[...h.element("sbNav").innerHTML.matchAll(/data-nav-view="([^"]*)"/g)].map((m) => m[1]);

	/**
	 * Every `menus` literal below is typed, and that is the only thing holding the
	 * two halves of this feature in lockstep. `shell.js` indexes `model.menus` by a
	 * plain string (`optional: "knowledge"`), so renaming a `DashboardMenus` field
	 * is a change tsc propagates through every TypeScript caller while leaving the
	 * asset silently reading a key nobody sends — both rows then never appear again,
	 * with every test still green. Typing the literal makes the rename fail HERE
	 * first, and the assertions below fail if only the test is updated.
	 */
	const menus = (knowledge: boolean, graph: boolean): DashboardMenus => ({ knowledge, graph });

	/** How many icons a row rendered, keyed by view — a per-row count, not a page total. */
	const iconsPerRow = (h: Harness): Record<string, number> => {
		const out: Record<string, number> = {};
		for (const row of h
			.element("sbNav")
			.innerHTML.matchAll(/<button[^>]*data-nav-view="([^"]*)"[\s\S]*?<\/button>/g)) {
			out[row[1]] = (row[0].match(/<svg /g) ?? []).length;
		}
		return out;
	};

	it("hides Knowledge and Graph when both flags are off", () => {
		const h = loadJD();
		h.JD.renderShell(model({ menus: menus(false, false) }));
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories"]);
	});

	it("shows each row only when its own flag is on, keeping NAV_MIDDLE's order", () => {
		const h = loadJD();
		h.JD.renderShell(model({ menus: menus(true, false) }));
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories", "knowledge"]);

		h.JD.renderShell(model({ menus: menus(false, true) }));
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories", "graph"]);

		h.JD.renderShell(model({ menus: menus(true, true) }));
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories", "knowledge", "graph"]);
	});

	// The rows carry their icon and path from the same tables the always-on rows
	// use, so a flag that only controlled visibility of a half-built row would be
	// worse than no flag at all.
	it("renders a revealed row with the same path and icon markup as an always-on row", () => {
		const h = loadJD();
		h.JD.renderShell(model({ menus: menus(true, true) }));
		const html = h.element("sbNav").innerHTML;
		expect(html).toContain('data-nav-path="/knowledge"');
		expect(html).toContain('data-nav-path="/graph"');
		// Per ROW, not per page: the menu is one flat list where EVERY row draws
		// exactly one mark, so a page total cannot tell a row that lost its icon from
		// one that grew a second. `stats` and `standup` are the two that used to draw
		// none — they were indented children under a group label that wore the mark
		// belonging to My Dashboard.
		expect(iconsPerRow(h)).toEqual({
			stats: 1,
			standup: 1,
			skills: 1,
			journeys: 1,
			memories: 1,
			knowledge: 1,
			graph: 1,
		});
	});

	// A payload with no `menus` at all is what a tab left open across an upgrade
	// polls its way into, and what a hand-built model in another suite passes. It
	// must read as HIDDEN — the same polarity config has — rather than throwing or
	// revealing a row nobody switched on.
	it("treats an absent menus slice as both rows hidden", () => {
		const h = loadJD();
		h.JD.renderShell(model());
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories"]);
	});

	// A slice naming only one row, or holding a non-boolean, must degrade the same
	// way — the predicate is `=== true`, so anything unreadable is "not switched on"
	// rather than a row appearing off the back of a truthy string.
	it("treats a partial or non-boolean menus slice as hidden", () => {
		const h = loadJD();
		h.JD.renderShell(model({ menus: { knowledge: true } }));
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories", "knowledge"]);

		h.JD.renderShell(model({ menus: { knowledge: "yes", graph: 1 } }));
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories"]);
	});

	// Only the ROW is gated. Landing on /graph with the flag off still renders the
	// page's identity, because the route is deliberately left live (a bookmark is
	// not answered with a redirect) — and a hidden row must not take the title with
	// it.
	it("keeps the page title of a hidden view when the page is opened directly", () => {
		const h = loadJD();
		h.JD.renderShell(model({ view: "graph", menus: menus(false, false) }));
		expect(h.element("pageTitle").textContent).toBe("Graph");
		expect(navViews(h)).toEqual(["stats", "standup", "skills", "journeys", "memories"]);
	});

	// Settings is built from NAV_BOTTOM, outside the filtered loop, so no change to
	// the predicate itself can reach it. What this does catch is the refactor that
	// would: folding NAV_BOTTOM into NAV_MIDDLE to share the filter, which empties
	// the pinned slot and hides its own container.
	it("leaves the pinned Settings row outside the filtered list", () => {
		const h = loadJD();
		h.JD.renderShell(model({ menus: menus(false, false) }));
		expect(h.element("sbBottom").innerHTML).toContain('data-nav-view="settings"');
		expect(h.element("sbBottom").hidden).toBe(false);
		expect(navViews(h)).not.toContain("settings");
	});
});

/**
 * The standup week pager (topbar), which replaces the range control on the standup
 * board. Two halves: `JD.query` carries the `offset` across a scope change or a
 * reload and drops it on the way out, and `renderShell` wires the three controls'
 * disabled state and destinations. The board itself had asset coverage before this;
 * the pager did not, which is how a `›` left enabled at the furthest window (a dead
 * button) could ship — see the STANDUP_MAX_OFFSET guard in DashboardQuery.ts.
 */
const standupModel = (standupOver: Record<string, unknown> = {}, modelOver: Record<string, unknown> = {}): unknown =>
	model({
		view: "standup",
		// No ranged payload on standup — the board carries its own week window.
		stats: undefined,
		standup: {
			windowFrom: "2026-07-24",
			windowTo: "2026-07-30",
			offset: 0,
			hasNewer: false,
			hasOlder: true,
			days: [],
			workspaces: [],
			...standupOver,
		},
		...modelOver,
	});

describe("JD.query — standup offset", () => {
	it("carries the offset from the model's own echo, so a reload preserves the window", () => {
		const { JD } = loadJD();
		expect(JD.query(standupModel({ offset: 3 }))).toBe("?offset=3");
	});

	it("keeps the offset when only the repo scope changes", () => {
		const { JD } = loadJD();
		const query = JD.query(standupModel({ offset: 2 }, { scope: scoped(JOLLIAI) }), { repo: [SITE] });
		expect(query).toContain("offset=2");
		expect(query).toContain("repo=site");
	});

	it("omits offset 0 — the current week is the bare URL", () => {
		const { JD } = loadJD();
		expect(JD.query(standupModel({ offset: 0 }))).toBe("");
	});

	it("drops the offset when it is explicitly cleared, as navigating away does", () => {
		const { JD } = loadJD();
		expect(JD.query(standupModel({ offset: 4 }), { offset: undefined })).toBe("");
	});

	it("never emits offset off the standup view, even with one in the model", () => {
		const { JD } = loadJD();
		// A stats model still carries stats, so this also proves the emit is gated on
		// the view and not on the absence of a standup payload.
		expect(JD.query(model(), { offset: 5 })).not.toContain("offset");
	});
});

describe("the standup week pager", () => {
	it("is hidden on a non-standup view", () => {
		const h = loadJD();
		h.JD.renderShell(model());
		expect(h.element("standupPager").hidden).toBe(true);
	});

	it("shows the window range as its label", () => {
		const h = loadJD();
		h.JD.renderShell(standupModel({ windowFrom: "2026-07-24", windowTo: "2026-07-30" }));
		expect(h.element("standupPager").hidden).toBe(false);
		expect(h.element("standupPagerLabel").textContent).toBe("Jul 24 – 30");
	});

	it("on the current week disables ‹ and Today, and enables › when older data exists", () => {
		const h = loadJD();
		h.JD.renderShell(standupModel({ offset: 0, hasNewer: false, hasOlder: true }));
		expect(h.element("standupNewer").disabled).toBe(true);
		expect(h.element("standupToday").disabled).toBe(true);
		expect(h.element("standupOlder").disabled).toBe(false);
	});

	it("at the furthest window disables › and enables ‹ / Today", () => {
		// The server sets hasOlder:false at the STANDUP_MAX_OFFSET ceiling (a further
		// click clamps back onto this window); the client must honour it. This is the
		// asset-side half of the dead-button fix.
		const h = loadJD();
		h.JD.renderShell(standupModel({ offset: 52, hasNewer: true, hasOlder: false }));
		expect(h.element("standupOlder").disabled).toBe(true);
		expect(h.element("standupNewer").disabled).toBe(false);
		expect(h.element("standupToday").disabled).toBe(false);
	});

	it("‹ pages one week newer, › one older, Today jumps to the current week", () => {
		const h = loadJD();
		h.JD.renderShell(standupModel({ offset: 3, hasNewer: true, hasOlder: true }));
		h.element("standupNewer").onclick?.();
		expect(h.href()).toBe("/dashboard/standup?offset=2");
		h.element("standupOlder").onclick?.();
		expect(h.href()).toBe("/dashboard/standup?offset=4");
		h.element("standupToday").onclick?.();
		// offset 0 is left out of the URL, so Today lands on the bare current-week path.
		expect(h.href()).toBe("/dashboard/standup");
	});

	it("preserves the repo scope in a pager destination", () => {
		const h = loadJD();
		h.JD.renderShell(standupModel({ offset: 1, hasNewer: true, hasOlder: true }, { scope: scoped(JOLLIAI) }));
		h.element("standupOlder").onclick?.();
		expect(h.href()).toContain("/dashboard/standup?");
		expect(h.href()).toContain("repo=jolliai");
		expect(h.href()).toContain("offset=2");
	});

	it("a disabled control navigates nowhere", () => {
		const h = loadJD();
		h.JD.renderShell(standupModel({ offset: 0, hasNewer: false, hasOlder: false }));
		h.element("standupNewer").onclick?.();
		h.element("standupOlder").onclick?.();
		h.element("standupToday").onclick?.();
		expect(h.href()).toBe("");
	});
});
