import { describe, expect, it } from "vitest";
import { resolveAssetsDir } from "../graph/GraphExport.js";
import { buildGraphViewerDocument } from "./GraphViewerDocument.js";

// The real source viz assets (cli/src/graph/assets) resolve under tsx/vitest.
const ASSETS = resolveAssetsDir();
const GRAPH = '{"schemaVersion":4,"nodes":[]}';

describe("buildGraphViewerDocument", () => {
	it("injects a repo switcher into the graph header, current repo selected", () => {
		const html = buildGraphViewerDocument(ASSETS, GRAPH, {
			kb: "b",
			repos: [
				{ kb: "a", repoName: "Repo A" },
				{ kb: "b", repoName: "Repo B" },
			],
			light: false,
		});
		expect(html).toContain('id="jolli-repo-switcher"');
		expect(html).toContain('<option value="a">Repo A</option>');
		expect(html).toContain('<option value="b" selected>Repo B</option>');
		// The switcher self-navigates the iframe (carrying the theme), and the doc
		// is still the real graph viz.
		expect(html).toContain('location.href="/graph-viewer?kb="');
		expect(html).toContain("__EMBEDDED_GRAPH__");
	});

	it("escapes repo names (text) and kb keys (attribute) in the switcher", () => {
		const html = buildGraphViewerDocument(ASSETS, GRAPH, {
			kb: 'a"b',
			repos: [{ kb: 'a"b', repoName: "<script>x</script>" }],
			light: false,
		});
		expect(html).toContain('<option value="a&quot;b" selected>&lt;script&gt;x&lt;/script&gt;</option>');
		expect(html).not.toContain("<script>x</script>");
	});

	it("injects the light --vscode-* palette only when light, on the real <body>", () => {
		const dark = buildGraphViewerDocument(ASSETS, GRAPH, {
			kb: "a",
			repos: [{ kb: "a", repoName: "A" }],
			light: false,
		});
		expect(dark).not.toContain("--vscode-editor-background:#eef1f5");
		expect(dark).toMatch(/<\/head>\s*<body>/);

		const light = buildGraphViewerDocument(ASSETS, GRAPH, {
			kb: "a",
			repos: [{ kb: "a", repoName: "A" }],
			light: true,
		});
		expect(light).toContain("--vscode-editor-background:#eef1f5");
		expect(light).toMatch(/<\/head>\s*<body class="vscode-light">/);
	});
});
