import { describe, expect, it } from "vitest";

import { readReferenceMarkdownFromString } from "../../../cli/src/core/references/ReferenceStore.js";
import { renderReferenceForPreview } from "./ReferencePreviewMarkdown.js";

/**
 * Shaped exactly like `ReferenceStore.renderMarkdown` writes it — the frontmatter
 * key order and the JSON-stringified values are that writer's contract, and the
 * assertion below proves this fixture still parses as a real reference.
 */
const LINEAR_SNAPSHOT = [
	"---",
	'source: "linear"',
	'nativeId: "PROJ-1"',
	'title: "Fix the login redirect"',
	'url: "https://linear.app/acme/issue/PROJ-1"',
	"fields:",
	'  - {"label":"Status","value":"In Progress"}',
	'referencedAt: "2026-08-05T09:30:00.000Z"',
	'sourceToolName: "get_issue"',
	"---",
	"",
	"The redirect drops the `next` param when the session is stale.",
	"",
].join("\n");

/** A bookmark-shaped snapshot: no permalink, and the body points at a link. */
const SLACK_SNAPSHOT = [
	"---",
	'source: "slack"',
	'nativeId: "C123-1699999999.000100"',
	'title: "#eng-standup thread"',
	'referencedAt: "2026-08-05T09:30:00.000Z"',
	'sourceToolName: "slack_read_thread"',
	"---",
	"",
	"<!-- jolli-reference-note -->",
	"",
	"---",
	"",
	"> ℹ️ **This is a bookmark, not a full copy.** Only the query is recorded here.",
	"",
].join("\n");

describe("renderReferenceForPreview", () => {
	it("the fixtures are real references as far as the CLI parser is concerned", () => {
		// Guards against this file drifting from ReferenceStore.renderMarkdown and
		// quietly testing a shape that never reaches disk.
		expect(readReferenceMarkdownFromString(LINEAR_SNAPSHOT)?.url).toBe(
			"https://linear.app/acme/issue/PROJ-1",
		);
		expect(readReferenceMarkdownFromString(SLACK_SNAPSHOT)?.url).toBeUndefined();
	});

	it("promotes the title out of the invisible frontmatter into a heading", () => {
		// VS Code's markdown preview mounts markdown-it-front-matter with an empty
		// renderer, so every frontmatter field is invisible in a rendered preview.
		expect(renderReferenceForPreview(LINEAR_SNAPSHOT)).toContain(
			"# Fix the login redirect",
		);
	});

	it("makes the url visible as a link", () => {
		expect(renderReferenceForPreview(LINEAR_SNAPSHOT)).toContain(
			"[https://linear.app/acme/issue/PROJ-1](https://linear.app/acme/issue/PROJ-1)",
		);
	});

	it("shows the source and the capture time", () => {
		const out = renderReferenceForPreview(LINEAR_SNAPSHOT);

		expect(out).toContain("linear");
		expect(out).toContain("2026-08-05T09:30:00.000Z");
	});

	it("keeps the body verbatim", () => {
		expect(renderReferenceForPreview(LINEAR_SNAPSHOT)).toContain(
			"The redirect drops the `next` param when the session is stale.",
		);
	});

	it("keeps the bookmark note, which the parser would have stripped", () => {
		// `parseMarkdown` runs `stripReferenceNote` before handing back a Reference,
		// so rebuilding the body from the parsed object would delete exactly the
		// paragraph that explains why there is no full copy.
		expect(renderReferenceForPreview(SLACK_SNAPSHOT)).toContain(
			"This is a bookmark, not a full copy.",
		);
	});

	it("omits the link line for a reference that has no url", () => {
		// Slack threads without a permalink, and jollimemory's own lookups, have no
		// url at all — an empty `[]()` would be worse than nothing.
		const out = renderReferenceForPreview(SLACK_SNAPSHOT);

		expect(out).toContain("# #eng-standup thread");
		expect(out).not.toContain("]()");
	});

	it("emits no frontmatter of its own", () => {
		// A leading `---` would be swallowed by the same front-matter renderer this
		// function exists to route around.
		expect(renderReferenceForPreview(LINEAR_SNAPSHOT).startsWith("---")).toBe(
			false,
		);
	});

	it("returns markdown that carries no frontmatter unchanged", () => {
		const plain = "# Already plain\n\nBody.";

		expect(renderReferenceForPreview(plain)).toBe(plain);
	});

	it("returns an unterminated frontmatter block unchanged", () => {
		const broken = "---\nsource: not-json\n";

		expect(renderReferenceForPreview(broken)).toBe(broken);
	});

	it("returns a closed but unparseable frontmatter block unchanged", () => {
		// Missing the required `nativeId` / `title` / `referencedAt` keys, so the CLI
		// parser rejects it. Showing the body with a hidden header beats dropping it.
		const broken = '---\nsource: "linear"\n---\n\nBody worth keeping.\n';

		expect(renderReferenceForPreview(broken)).toBe(broken);
	});
});
