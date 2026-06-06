/**
 * WikiMarkdownBuilder tests — pure renderer, no fs / no mocks needed.
 */

import { describe, expect, it } from "vitest";
import type { TopicPage } from "./TopicKBTypes.js";
import {
	renderTopicImpl,
	renderTopicKBIndex,
	topicPageToCompiledTopic,
	type WikiRenderContext,
} from "./WikiMarkdownBuilder.js";

const sp3Ctx: WikiRenderContext = {
	repoName: "jolliai",
	resolveCommitVisiblePath: () => null,
	resolveBranchFolder: () => null,
	resolveCommitMessage: () => null,
};

const sp3Topic = {
	title: "Auth",
	stableSlug: "auth",
	content: "Body about auth.",
	sourceCommits: [] as string[],
};

describe("renderTopicImpl", () => {
	it("renders topic title, content and generated banner", () => {
		const md = renderTopicImpl(sp3Topic, ["main"], "2026-01-01T00:00:00Z", sp3Ctx);
		expect(md).toContain("# Auth");
		expect(md).toContain("Body about auth.");
		expect(md).toContain("do not edit");
	});

	it("renders the Key Decisions section when keyDecisions is present", () => {
		const topic = {
			title: "Auth",
			stableSlug: "auth",
			content: "Body.",
			keyDecisions: ["Use OAuth", "Drop sessions"],
			sourceCommits: [] as string[],
		};
		const md = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", sp3Ctx);
		expect(md).toContain("## Key Decisions");
		expect(md).toContain("- Use OAuth");
		expect(md).toContain("- Drop sessions");
	});

	it("omits the Key Decisions section when keyDecisions is empty", () => {
		const topic = { ...sp3Topic, keyDecisions: [] as string[] };
		const md = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", sp3Ctx);
		expect(md).not.toContain("## Key Decisions");
	});

	it("falls back to a non-link hash + message when visible path is unresolved", () => {
		const ctx: WikiRenderContext = {
			repoName: "jolliai",
			resolveCommitVisiblePath: () => null,
			resolveCommitMessage: (h) => `commit ${h}`,
			resolveBranchFolder: () => null,
		};
		const topic = { ...sp3Topic, sourceCommits: ["abc12345deadbeef"] };
		const md = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", ctx);
		expect(md).toContain("## Source Commits");
		expect(md).toContain("- `abc12345` — commit abc12345");
		expect(md).not.toContain("](");
	});

	it("falls back to a bare hash when neither path nor message resolve", () => {
		const topic = { ...sp3Topic, sourceCommits: ["abc12345deadbeef"] };
		const md = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", sp3Ctx);
		expect(md).toContain("- `abc12345`");
		// no message dash and no link
		expect(md).not.toContain("`abc12345` —");
		expect(md).not.toContain("](");
	});

	it("falls back to a non-link branch literal when branch folder is unresolved", () => {
		const ctx: WikiRenderContext = {
			repoName: "jolliai",
			resolveCommitVisiblePath: () => null,
			resolveCommitMessage: () => null,
			resolveBranchFolder: () => null,
		};
		const topic = {
			...sp3Topic,
			relatedBranches: ["feature/oauth"],
		};
		const md = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", ctx);
		expect(md).toContain("## Related Branches");
		expect(md).toContain("- `feature/oauth`");
		expect(md).not.toContain("](");
	});

	it("strips a leading ./ from the resolved visible path in the link target", () => {
		const ctx: WikiRenderContext = {
			repoName: "jolliai",
			resolveCommitVisiblePath: (h) => `./impl-${h}.md`,
			resolveCommitMessage: (h) => `commit ${h}`,
			resolveBranchFolder: () => null,
		};
		const topic = { ...sp3Topic, sourceCommits: ["abc12345deadbeef"] };
		const md = renderTopicImpl(topic, ["main"], "2026-01-01T00:00:00Z", ctx);
		expect(md).toContain("- [abc12345](impl-abc12345.md) — commit abc12345");
	});

	it("renders source commits and related branches as standard Markdown links (VS Code preview-clickable)", () => {
		const ctx: WikiRenderContext = {
			repoName: "jolliai",
			resolveCommitVisiblePath: (h) => `../signin-oauth-code/impl-${h}.md`,
			resolveCommitMessage: (h) => `commit ${h}`,
			resolveBranchFolder: (b) => b.replace(/\//g, "-"),
		};
		const topic = {
			title: "Auth",
			stableSlug: "auth",
			content: "Body.",
			relatedBranches: ["signin-oauth-code"],
			sourceCommits: ["abc12345deadbeef"],
		};
		const md = renderTopicImpl(topic, ["signin-oauth-code"], "2026-01-01T00:00:00Z", ctx);
		// standard link, not an Obsidian wikilink
		expect(md).toContain("- [abc12345](../signin-oauth-code/impl-abc12345.md) — commit abc12345");
		expect(md).toContain("- [signin-oauth-code](../signin-oauth-code/)");
		expect(md).not.toContain("[[");
	});
});

describe("topicPageToCompiledTopic", () => {
	it("maps page fields and keeps only commit-type source ids", () => {
		const page: TopicPage = {
			schemaVersion: 1,
			stableSlug: "auth",
			title: "Auth",
			content: "Body.",
			relatedBranches: ["main"],
			sourceRefs: [
				{ type: "summary", id: "abc123", timestamp: "2026-01-01T00:00:00Z" },
				{ type: "plan", id: "p1", timestamp: "2026-01-01T00:00:00Z" },
			],
			lastUpdatedAt: "2026-01-02T00:00:00Z",
		};
		const t = topicPageToCompiledTopic(page);
		expect(t.stableSlug).toBe("auth");
		expect(t.content).toBe("Body.");
		expect(t.relatedBranches).toEqual(["main"]);
		expect(t.sourceCommits).toEqual(["abc123"]); // only summary-type refs are commits
	});
});

describe("renderTopicKBIndex", () => {
	const topic = (slug: string, title: string) => ({ stableSlug: slug, title, content: "", sourceCommits: [] });

	it("renders the banner, topic count, and a standard Markdown link per topic", () => {
		const md = renderTopicKBIndex([topic("auth", "Auth"), topic("storage", "Storage")], sp3Ctx);
		expect(md).toContain("# jolliai · Knowledge Wiki");
		expect(md).toContain("do not edit");
		expect(md).toContain("**2 topics**");
		// Standard relative .md links so VS Code preview / GitHub can follow them
		// (Obsidian resolves them too); NOT Obsidian `[[wikilinks]]`.
		expect(md).toContain("- [Auth](topic--auth.md)");
		expect(md).toContain("- [Storage](topic--storage.md)");
		expect(md).not.toContain("[[");
		// The topic-KB index is NOT branch-organized (no "Source Branches" section).
		expect(md).not.toContain("Source Branches");
	});

	it("omits the Topics section when empty", () => {
		const md = renderTopicKBIndex([], sp3Ctx);
		expect(md).toContain("**0 topics**");
		expect(md).not.toContain("## Topics");
	});

	it("escapes backslashes and brackets in the link label", () => {
		// A lone backslash in the label must be escaped, otherwise a trailing `\`
		// would escape the `]` that closes the link and corrupt the Markdown.
		const md = renderTopicKBIndex([topic("auth", "Auth \\ [v2]")], sp3Ctx);
		expect(md).toContain("- [Auth \\\\ \\[v2\\]](topic--auth.md)");
	});
});
