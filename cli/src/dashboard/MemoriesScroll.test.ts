/**
 * Runtime test for `memories.js`'s "scroll the selected memory into view" wiring.
 *
 * Landing on `/memories?hash=…` (e.g. a jump from the wiki viewer) should center
 * the selected row in the tree — but the 30s refresh tick re-runs renderMemories,
 * and scrolling on every tick would yank the view back while the user reads. So
 * the scroll fires only when the selected hash CHANGES. This drives the real IIFE
 * against a stub document whose `scrollIntoView` is a spy.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function setup(commitHash: string | undefined) {
	let scrolled = 0;
	let opts: unknown = null;
	const row = {
		scrollIntoView: (o: unknown) => {
			scrolled++;
			opts = o;
		},
	};
	const element = () => ({
		innerHTML: "",
		style: {} as Record<string, string>,
		classList: { add: () => undefined, remove: () => undefined, contains: () => false },
		querySelectorAll: () => [] as ReadonlyArray<never>,
		querySelector: () => null,
		addEventListener: () => undefined,
		setAttribute: () => undefined,
		getAttribute: () => null,
	});
	const elements = new Map<string, ReturnType<typeof element>>();
	const doc = {
		// memTree/memSearch null → the full first-render branch, which ends in the
		// scroll call; every other id is memoised.
		getElementById: (id: string) => {
			if (id === "memTree" || id === "memSearch") return null;
			const hit = elements.get(id) ?? element();
			elements.set(id, hit);
			return hit;
		},
		querySelectorAll: () => [] as ReadonlyArray<never>,
		querySelector: (sel: string) => (sel === '#memTree [aria-current="true"]' ? row : null),
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
	const model = {
		memories: {
			selected: {
				commitHash,
				title: "m",
				conversations: [],
				context: [],
				excluded: [],
				activity: [],
				activityUncoveredSources: [],
				topics: [],
				files: [],
				e2e: [],
			},
			items: [],
			tree: [],
		},
		scope: { kind: "all" },
	};
	return { render: () => JD.renderMemories(model), scrolled: () => scrolled, opts: () => opts };
}

describe("memories.js — scroll selected into view", () => {
	it("centers the selected row on first render, and does NOT re-scroll on an unchanged re-render", () => {
		const h = setup("abc1234def");
		h.render();
		expect(h.scrolled()).toBe(1);
		expect(h.opts()).toEqual({ block: "center" });

		// The 30s tick re-renders the same selection — must not fight the reader.
		h.render();
		expect(h.scrolled()).toBe(1);
	});

	it("does not scroll when no memory is selected", () => {
		const h = setup(undefined);
		h.render();
		expect(h.scrolled()).toBe(0);
	});
});
