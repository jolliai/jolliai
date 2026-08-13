/**
 * Runtime smoke test for `assets/js/knowledge.js`'s wiki-navigation wiring.
 *
 * Same rationale as `MemoriesAsset.test.ts`: the asset scripts are plain JS
 * bundled verbatim into the served page — tsc never sees them and the coverage
 * floor excludes `assets/**`, so a listener that stops firing does so silently.
 * This evaluates the real IIFE against a stub document and drives the `message`
 * handler `wireWikiNav` installs, which turns a source-commit link click inside
 * the sandboxed wiki iframe into a `/memories?hash=…&detailRepo=…` navigation.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type MessageHandler = (event: { data: unknown }) => void;

interface FakeRow {
	getAttribute: (name: string) => string | null;
	onclick?: () => void;
}

/**
 * Loads `format.js` + `knowledge.js` into a stub window/document, renders one
 * repo's wiki list, and returns the seams the tests drive: the captured `message`
 * handler, a click on the (single) wiki row to set `state.selected`, and the
 * `location` object whose `href` the navigation writes.
 */
function setup() {
	let messageHandler: MessageHandler | undefined;
	const location = { href: "" };

	// One wiki row; its click sets the module's `state.selected = {kb, file}`.
	const row: FakeRow = {
		getAttribute: (name: string) => (name === "data-kb" ? "jolliai" : "topic--x.md"),
	};

	const makeEl = () => ({
		innerHTML: "",
		value: "",
		oninput: undefined as undefined | (() => void),
		style: {} as Record<string, string>,
	});
	const byId = new Map<string, ReturnType<typeof makeEl>>();

	const doc = {
		getElementById: (id: string) => {
			const hit = byId.get(id) ?? makeEl();
			byId.set(id, hit);
			return hit;
		},
		querySelectorAll: (selector: string) => (selector === "#knList .kn-row" ? [row] : []),
		createElement: () => makeEl(),
	};

	const win = {
		JD: {},
		document: doc,
		location,
		addEventListener: (type: string, fn: MessageHandler) => {
			if (type === "message") messageHandler = fn;
		},
		removeEventListener: () => undefined,
	} as Record<string, unknown>;

	for (const file of ["format.js", "knowledge.js"]) {
		const src = readFileSync(new URL(`./assets/js/${file}`, import.meta.url), "utf8");
		new Function("window", "document", src)(win, doc);
	}

	const JD = win.JD as { renderKnowledge: (model: unknown) => void };
	const model = {
		knowledge: {
			repos: [
				{
					kb: "jolliai",
					repoName: "Jolli AI",
					graphAvailable: true,
					files: [{ file: "topic--x.md", title: "X" }],
				},
			],
		},
	};
	JD.renderKnowledge(model);

	return {
		openWikiRow: () => row.onclick?.(),
		fireMessage: (data: unknown) => messageHandler?.({ data }),
		href: () => location.href,
	};
}

describe("knowledge.js — wiki source-commit navigation", () => {
	it("navigates to /memories with the hash and the open page's kb as detailRepo", () => {
		const h = setup();
		h.openWikiRow(); // sets state.selected → kb "jolliai"
		h.fireMessage({ type: "jolli-wiki-nav", hash: "a742fa47" });
		// detailRepo is the kb — the SAME value the iframe wrote into the link's
		// visible href, so the status-bar preview and the real destination match.
		expect(h.href()).toBe("/memories?hash=a742fa47&detailRepo=jolliai");
	});

	it("ignores a message whose hash is not a valid hex commit id", () => {
		const h = setup();
		h.openWikiRow();
		h.fireMessage({ type: "jolli-wiki-nav", hash: "../../etc/passwd" });
		expect(h.href()).toBe("");
	});

	it("ignores a message of the wrong type", () => {
		const h = setup();
		h.openWikiRow();
		h.fireMessage({ type: "something-else", hash: "a742fa47" });
		expect(h.href()).toBe("");
	});

	it("navigates without detailRepo when no wiki page is open yet", () => {
		const h = setup();
		// No openWikiRow(): state.selected is null, so there is no owning repo.
		h.fireMessage({ type: "jolli-wiki-nav", hash: "a742fa47" });
		expect(h.href()).toBe("/memories?hash=a742fa47");
	});
});
