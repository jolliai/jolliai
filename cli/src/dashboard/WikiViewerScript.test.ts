/**
 * Behavioral test for `WIKI_LINK_REWRITE_SCRIPT` — the script `buildWikiViewerHtml`
 * injects into the sandboxed `/wiki-viewer` iframe. It is inlined JS (tsc never
 * runs it, coverage excludes it once served), so an earlier version silently
 * misclassified EVERY source-commit link: it required a `summary--` filename
 * prefix that `FolderStorage` does not write (the real file is `<slug>-<hash8>.md`),
 * so every commit link was de-linked and the whole jump feature was dead — while
 * string-only assertions on the served HTML stayed green.
 *
 * This runs the actual script against stub anchors carrying the REAL href shapes
 * (measured from a live Memory Bank `_wiki`) and checks what each becomes.
 */

import { describe, expect, it } from "vitest";
import { WIKI_LINK_REWRITE_SCRIPT } from "./DashboardServer.js";

interface StubAnchor {
	getAttribute: (name: string) => string | null;
	textContent: string;
	hrefSet: string | null;
	clickHandler: ((e: { preventDefault: () => void }) => void) | null;
	replacedWithText: string | null;
	setAttribute: (name: string, value: string) => void;
	addEventListener: (type: string, fn: (e: { preventDefault: () => void }) => void) => void;
	parentNode: { replaceChild: (newNode: { textContent: string }, old: unknown) => void };
}

function anchor(href: string, text: string): StubAnchor {
	const a: StubAnchor = {
		getAttribute: (name) => (name === "href" ? href : null),
		textContent: text,
		hrefSet: null,
		clickHandler: null,
		replacedWithText: null,
		setAttribute: (name, value) => {
			if (name === "href") a.hrefSet = value;
		},
		addEventListener: (type, fn) => {
			if (type === "click") a.clickHandler = fn;
		},
		parentNode: {
			replaceChild: (newNode) => {
				a.replacedWithText = newNode.textContent;
			},
		},
	};
	return a;
}

/** Runs the rewrite script over `anchors`; returns the messages posted to the parent. */
function run(anchors: StubAnchor[], search = "?kb=jolliai&file=topic--x.md"): Array<{ type: string; hash: string }> {
	const posted: Array<{ type: string; hash: string }> = [];
	const md = { querySelectorAll: (sel: string) => (sel === "a[href]" ? anchors : []) };
	const doc = {
		getElementById: (id: string) => (id === "md" ? md : null),
		createElement: () => ({ textContent: "" }),
	};
	// The frame reads its own ?kb= to build the real /memories href (status-bar preview).
	const win = {
		parent: { postMessage: (msg: { type: string; hash: string }) => posted.push(msg) },
		document: doc,
		location: { search },
	};
	new Function("window", "document", WIKI_LINK_REWRITE_SCRIPT)(win, doc);
	return posted;
}

describe("WIKI_LINK_REWRITE_SCRIPT", () => {
	it("rewrites a real source-commit link (NO summary-- prefix) to the /memories href and postMessages on click", () => {
		// Measured real href — <branch>/<slug>-<hash8>.md, label is the hash.
		const a = anchor(
			"../feature-context-relevance-filtering/add-ai-context-relevance-filtering-layer-to-commit-a2bc7940.md",
			"a2bc7940",
		);
		const posted = run([a]);
		// href becomes the REAL destination (kb from the frame's own URL) so the
		// browser status bar previews where the click goes.
		expect(a.hrefSet).toBe("/memories?hash=a2bc7940&detailRepo=jolliai");
		expect(a.replacedWithText).toBeNull();
		expect(posted).toEqual([]); // nothing posts until the click fires
		a.clickHandler?.({ preventDefault: () => undefined });
		expect(posted).toEqual([{ type: "jolli-wiki-nav", hash: "a2bc7940" }]);
	});

	it("omits detailRepo from the href when the frame's URL carries no kb", () => {
		const a = anchor("../main/add-thing-a2bc7940.md", "a2bc7940");
		run([a], "?file=topic--x.md");
		expect(a.hrefSet).toBe("/memories?hash=a2bc7940");
	});

	it("extracts the TRAILING hash from the filename, not a hex-looking slug segment", () => {
		// The slug embeds "deadbeef" (valid hex) and the label is deliberately that
		// wrong value; only correct trailing-group extraction yields "12345678".
		const a = anchor("../main/fix-deadbeef-in-parser-12345678.md", "deadbeef");
		const posted = run([a]);
		a.clickHandler?.({ preventDefault: () => undefined });
		expect(posted).toEqual([{ type: "jolli-wiki-nav", hash: "12345678" }]);
	});

	it("de-links a related-branch link, keeping its text", () => {
		const a = anchor("../main/", "main");
		run([a]);
		expect(a.replacedWithText).toBe("main");
		expect(a.hrefSet).toBeNull();
		expect(a.clickHandler).toBeNull();
	});

	it("de-links the index page's bare topic--<slug>.md link", () => {
		const a = anchor("topic--knowledge-graph-feature.md", "Knowledge graph feature");
		run([a]);
		expect(a.replacedWithText).toBe("Knowledge graph feature");
		expect(a.hrefSet).toBeNull();
	});

	it("leaves an absolute/external link untouched", () => {
		const a = anchor("https://linear.app/acme/issue/ABC-1", "ABC-1");
		const posted = run([a]);
		expect(a.hrefSet).toBeNull();
		expect(a.replacedWithText).toBeNull();
		expect(a.clickHandler).toBeNull();
		expect(posted).toEqual([]);
	});
});
