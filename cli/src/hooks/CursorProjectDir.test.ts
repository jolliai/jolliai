import { describe, expect, it } from "vitest";
import { pickCursorProjectDir, resolveCursorProjectDir } from "./CursorProjectDir.js";

/** A path `isPluginBundleCwd` recognises, so the screening cases are real rather than mocked. */
const BUNDLE = "/Users/someone/.cursor/plugins/local/jolli";

describe("pickCursorProjectDir", () => {
	it("prefers the first usable workspace_roots entry", () => {
		const pick = pickCursorProjectDir({ workspace_roots: ["/repo", "/other"] }, {}, "/cwd");
		expect(pick).toEqual({ dir: "/repo", channel: "workspace_roots" });
	});

	it("skips blank roots rather than treating one as an answer", () => {
		const pick = pickCursorProjectDir({ workspace_roots: ["", "   ", "/repo"] }, {}, "/cwd");
		expect(pick.dir).toBe("/repo");
	});

	it("falls back to CURSOR_PROJECT_DIR when no root was named", () => {
		const pick = pickCursorProjectDir({}, { CURSOR_PROJECT_DIR: "/env-repo" }, "/cwd");
		expect(pick).toEqual({ dir: "/env-repo", channel: "CURSOR_PROJECT_DIR" });
	});

	/*
	 * Cursor's chat-first Agents Window sets this to the empty STRING rather than leaving
	 * it unset (measured on 3.15.19), so a `??` would pass "" through as a real answer and
	 * every later step would act on a path that is not one.
	 */
	it("treats an empty CURSOR_PROJECT_DIR as absent, not as an answer", () => {
		const pick = pickCursorProjectDir({}, { CURSOR_PROJECT_DIR: "" }, "/cwd");
		expect(pick).toEqual({ dir: "/cwd", channel: "cwd" });
	});

	it("falls back to cwd last", () => {
		const pick = pickCursorProjectDir({}, {}, "/cwd");
		expect(pick).toEqual({ dir: "/cwd", channel: "cwd" });
	});

	/*
	 * The failure this screening exists to prevent: Cursor runs most plugin hooks with the
	 * bundle as cwd, and a marketplace served over git leaves that cache a REAL checkout —
	 * so `rev-parse` would accept it and jolli would install git hooks into the plugin's
	 * own repository.
	 */
	it("refuses a plugin-bundle cwd instead of acting on the bundle it was launched from", () => {
		const pick = pickCursorProjectDir({}, {}, BUNDLE);
		expect(pick).toEqual({ dir: null, channel: "none" });
	});

	// Screening is uniform across channels because the harm is identical whichever one
	// supplied the path — but a screened-out candidate must fall THROUGH, not abort, or a
	// bundle-valued root would suppress a perfectly good env var.
	it("screens every channel, and a rejected candidate falls through to the next", () => {
		const pick = pickCursorProjectDir({ workspace_roots: [BUNDLE] }, { CURSOR_PROJECT_DIR: "/env-repo" }, BUNDLE);
		expect(pick).toEqual({ dir: "/env-repo", channel: "CURSOR_PROJECT_DIR" });
	});

	it("answers none when every channel is unusable", () => {
		const pick = pickCursorProjectDir({ workspace_roots: [] }, { CURSOR_PROJECT_DIR: "  " }, BUNDLE);
		expect(pick).toEqual({ dir: null, channel: "none" });
	});

	it("ignores a workspace_roots that is not an array", () => {
		const pick = pickCursorProjectDir({ workspace_roots: "/repo" }, {}, "/cwd");
		expect(pick).toEqual({ dir: "/cwd", channel: "cwd" });
	});

	it("ignores non-string entries inside workspace_roots", () => {
		const pick = pickCursorProjectDir({ workspace_roots: [42, null, "/repo"] }, {}, "/cwd");
		expect(pick.dir).toBe("/repo");
	});
});

describe("resolveCursorProjectDir", () => {
	// A projection, never a second implementation of the order — that duplication is what
	// this module was extracted to remove.
	it("returns exactly the directory pickCursorProjectDir chose", () => {
		const input = { workspace_roots: [BUNDLE] };
		const env = { CURSOR_PROJECT_DIR: "/env-repo" };
		expect(resolveCursorProjectDir(input, env, "/cwd")).toBe(pickCursorProjectDir(input, env, "/cwd").dir);
	});

	it("defaults cwd to the process cwd so existing callers need not pass one", () => {
		expect(resolveCursorProjectDir({}, {})).toBe(process.cwd());
	});

	it("returns null when nothing survived screening", () => {
		expect(resolveCursorProjectDir({}, {}, BUNDLE)).toBeNull();
	});
});
