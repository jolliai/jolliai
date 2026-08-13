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

/**
 * @param commitHash   the selected memory's hash (undefined = nothing selected)
 * @param opts.rows    the tree rows carrying `aria-current` (all share the hash);
 *                     defaults to a single "repo-1" row
 * @param opts.owner   which repoIdentity actually OWNS the selected detail
 *                     (defaults to "repo-1"); the row we expect to be centered
 */
function setup(commitHash: string | undefined, opts?: { rows?: string[]; owner?: string }) {
	const scrolls: Array<{ repoIdentity: string; opts: unknown }> = [];
	const makeRow = (repoIdentity: string) => ({
		getAttribute: (name: string) => (name === "data-repo" ? repoIdentity : null),
		scrollIntoView: (o: unknown) => scrolls.push({ repoIdentity, opts: o }),
	});
	// Cross-repo hash reuse → the tree marks EVERY row with the hash aria-current.
	const rows = (opts?.rows ?? ["repo-1"]).map(makeRow);
	const owner = opts?.owner ?? "repo-1";
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
		querySelectorAll: (sel: string) => (sel === '#memTree [aria-current="true"]' ? rows : []),
		querySelector: () => null,
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
				repoIdentity: owner,
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
	return {
		render: () => JD.renderMemories(model),
		scrolls: () => scrolls,
		scrolled: () => scrolls.length,
	};
}

describe("memories.js — scroll selected into view", () => {
	it("centers the selected row on first render, and does NOT re-scroll on an unchanged re-render", () => {
		const h = setup("abc1234def");
		h.render();
		expect(h.scrolls()).toEqual([{ repoIdentity: "repo-1", opts: { block: "center" } }]);

		// The 30s tick re-renders the same selection — must not fight the reader.
		h.render();
		expect(h.scrolled()).toBe(1);
	});

	it("does not scroll when no memory is selected", () => {
		const h = setup(undefined);
		h.render();
		expect(h.scrolled()).toBe(0);
	});

	it("centers the OWNER repo's row when the same hash exists in two repos", () => {
		// A cherry-pick: repo-A and repo-B both have this hash, so BOTH rows are marked
		// aria-current. The detail pane belongs to repo-B (detailRepo scoped the jump
		// there), so the scroll must land on repo-B's row, not the first (repo-A).
		const h = setup("abc1234def", { rows: ["repo-A", "repo-B"], owner: "repo-B" });
		h.render();
		expect(h.scrolls()).toEqual([{ repoIdentity: "repo-B", opts: { block: "center" } }]);
	});

	it("falls back to the first selected row when none matches the owner (should not happen)", () => {
		const h = setup("abc1234def", { rows: ["repo-A", "repo-B"], owner: "repo-Z" });
		h.render();
		expect(h.scrolls()).toEqual([{ repoIdentity: "repo-A", opts: { block: "center" } }]);
	});
});
