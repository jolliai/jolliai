import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createStorage } = vi.hoisted(() => ({ createStorage: vi.fn() }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage }));

import { assembleGraphHtml, escapeForInlineScript, exportGraphHtml, resolveAssetsDir } from "./GraphExport.js";

const TEMPLATE = `<!doctype html><html><head>
  <link rel="stylesheet" href="styles/main.css" />
</head><body>
  <div id="board"></div>
  <!-- scripts:start -->
  <script src="vendor/panzoom.min.js"></script>
  <!-- scripts:end -->
</body></html>`;

const PARTS = {
	template: TEMPLATE,
	css: ".board{color:red}",
	vendorJs: ["/* panzoom */", "/* elk */"],
	appJs: ["/* data */", "/* main */"],
	graphJson: '{"ok":true}',
};

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

beforeEach(() => createStorage.mockReset());
afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("escapeForInlineScript", () => {
	// The behaviour itself is pinned in core/InlineScript.test.ts — this only
	// holds the re-export, since assembleGraphHtml below depends on it.
	it("re-exports the shared escape and leaves no raw < in the output", () => {
		const ls = String.fromCharCode(0x2028),
			ps = String.fromCharCode(0x2029);
		const out = escapeForInlineScript(`{"x":"</script>${ls}${ps}"}`);
		expect(out).not.toContain("<");
		expect(out).toContain("\\u003c");
		expect(out).toContain("\\u2028");
		expect(out).toContain("\\u2029");
		expect(out).not.toContain(ls);
		expect(out).not.toContain(ps);
	});
});

describe("assembleGraphHtml", () => {
	it("inlines the stylesheet, vendor + app scripts, and the embedded graph", () => {
		const html = assembleGraphHtml(PARTS);
		expect(html).toContain("<style>\n.board{color:red}\n</style>");
		expect(html).not.toContain('href="styles/main.css"');
		expect(html).toContain("<script>\n/* panzoom */\n</script>");
		expect(html).toContain("<script>\n/* elk */\n</script>");
		expect(html).toContain("<script>\n/* data */\n</script>");
		expect(html).toContain('window.__EMBEDDED_GRAPH__ = {"ok":true};');
		expect(html).not.toContain("<!-- scripts:start -->");
		// Embedded data sits before the app scripts (data.js reads it).
		expect(html.indexOf("__EMBEDDED_GRAPH__")).toBeLessThan(html.indexOf("/* data */"));
	});

	it("inlines __EMBEDDED_WIKI__ (escaped) after the graph and before the app scripts when embeddedWiki is given", () => {
		const html = assembleGraphHtml({ ...PARTS, embeddedWiki: { auth: "# Auth\n</script>x" } });
		expect(html).toContain("window.__EMBEDDED_WIKI__ = ");
		// The body's </script> is escaped like the graph global.
		expect(html).toContain("\\u003c/script");
		expect(html).not.toContain("</script>x");
		// Both globals precede the app scripts; the wiki map follows the graph.
		expect(html.indexOf("__EMBEDDED_GRAPH__")).toBeLessThan(html.indexOf("__EMBEDDED_WIKI__"));
		expect(html.indexOf("__EMBEDDED_WIKI__")).toBeLessThan(html.indexOf("/* data */"));
	});

	it("omits __EMBEDDED_WIKI__ when no embeddedWiki is given (served surfaces fetch on demand)", () => {
		expect(assembleGraphHtml(PARTS)).not.toContain("__EMBEDDED_WIKI__");
	});

	it("preserves $-sequences verbatim (no String.replace $$/$&/$' corruption)", () => {
		const html = assembleGraphHtml({
			...PARTS,
			vendorJs: ["function $$d(a){return $('x')}", 'var s="$&$\'$1"'],
			graphJson: '{"k":"a$$b$&c"}',
		});
		expect(html).toContain("function $$d(a){return $('x')}");
		expect(html).toContain('var s="$&$\'$1"');
		expect(html).toContain('{"k":"a$$b$&c"}');
	});

	it("escapes </script inside the embedded graph data", () => {
		const html = assembleGraphHtml({ ...PARTS, graphJson: '{"x":"</script>bad"}' });
		expect(html).toContain("\\u003c/script");
		expect(html).not.toContain("</script>bad");
	});

	it("applies bodyClass to the real <body>, not a literal <body> in the inlined CSS", () => {
		// The CSS mentions "<body>" in a comment; the class must land on the tag,
		// not that comment (a post-inline String.replace would hit the comment first).
		const html = assembleGraphHtml({ ...PARTS, css: "/* the <body> carries the theme */ .b{}" }, "vscode-light");
		expect(html).toMatch(/<\/head><body class="vscode-light">/);
		expect(html).toContain("the <body> carries the theme");
	});

	it("leaves <body> unclassed when no bodyClass is given", () => {
		expect(assembleGraphHtml(PARTS)).toContain("</head><body>");
	});

	it("throws when the template is missing a marker (no silent drop)", () => {
		expect(() => assembleGraphHtml({ ...PARTS, template: "<html><head></head><body></body></html>" })).toThrow(
			/missing expected marker: stylesheet link/,
		);
		const noScripts = TEMPLATE.replace("<!-- scripts:start -->", "").replace("<!-- scripts:end -->", "");
		expect(() => assembleGraphHtml({ ...PARTS, template: noScripts })).toThrow(
			/missing expected marker: scripts block/,
		);
	});
});

describe("resolveAssetsDir", () => {
	function makeAssets(sub: string): string {
		const base = tmp("kg-assets-");
		mkdirSync(join(base, sub), { recursive: true });
		writeFileSync(join(base, sub, "index.html"), "x", "utf8");
		return base;
	}
	it("finds the dist layout (graph-assets/)", () => {
		const base = makeAssets("graph-assets");
		expect(resolveAssetsDir(base)).toBe(join(base, "graph-assets"));
	});
	it("finds the source layout (assets/)", () => {
		const base = makeAssets("assets");
		expect(resolveAssetsDir(base)).toBe(join(base, "assets"));
	});
	it("throws when no assets layout is present", () => {
		expect(() => resolveAssetsDir(tmp("kg-empty-"))).toThrow(/viz assets not found/);
	});
});

describe("exportGraphHtml", () => {
	function seedGraph(): { kbRoot: string; graphJson: string } {
		const kbRoot = tmp("kg-kb-");
		mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
		const graphJson = JSON.stringify({
			stats: { categories: 1 },
			categories: [],
			topics: [],
			units: [],
			edges: [],
		});
		writeFileSync(join(kbRoot, ".jolli", "graph", "graph.json"), graphJson, "utf8");
		return { kbRoot, graphJson };
	}

	it("writes <repo>-graph.html into a directory and returns its path", async () => {
		const { kbRoot } = seedGraph();
		createStorage.mockResolvedValue({ kbRoot });
		const outDir = tmp("kg-out-");

		const file = await exportGraphHtml({ cwd: kbRoot, out: outDir });

		expect(file).toBe(join(outDir, `${basename(kbRoot)}-graph.html`));
		const html = readFileSync(file, "utf8");
		expect(html).toContain("window.__EMBEDDED_GRAPH__");
		expect(html).not.toContain("styles/main.css"); // stylesheet inlined (real assets)
		// host-bridge.js MUST be bundled: it defines WikiHost.requestWikiBody, the
		// on-demand body source for the dashboard iframe (which shares this builder).
		// Dropping it from SCRIPT_FILES would silently break "Open full wiki page"
		// there, so pin its presence and its load-order before data.js.
		expect(html).toContain("requestWikiBody");
		expect(html.indexOf("requestWikiBody")).toBeLessThan(html.indexOf("WikiDataLoader"));
	});

	it("honors an explicit *.html output path", async () => {
		const { kbRoot } = seedGraph();
		createStorage.mockResolvedValue({ kbRoot });
		const out = join(tmp("kg-out2-"), "nested", "my-graph.html");

		const file = await exportGraphHtml({ cwd: kbRoot, out });
		expect(file).toBe(out);
		expect(readFileSync(file, "utf8")).toContain("__EMBEDDED_GRAPH__");
	});

	it("falls back to cwd when storage has no kbRoot", async () => {
		const { kbRoot } = seedGraph();
		createStorage.mockResolvedValue({}); // no kbRoot
		const file = await exportGraphHtml({ cwd: kbRoot, out: tmp("kg-out3-") });
		expect(readFileSync(file, "utf8")).toContain("__EMBEDDED_GRAPH__");
	});

	it("throws a clear error when the repo has no graph yet", async () => {
		const kbRoot = tmp("kg-nograph-");
		createStorage.mockResolvedValue({ kbRoot });
		await expect(exportGraphHtml({ cwd: kbRoot, out: tmp("kg-out4-") })).rejects.toThrow(
			/No knowledge graph found.*jolli compile/s,
		);
	});

	it("re-inlines each topic's _wiki page as __EMBEDDED_WIKI__ (skips missing file / non-basename)", async () => {
		const kbRoot = tmp("kg-wiki-");
		mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
		mkdirSync(join(kbRoot, "_wiki"), { recursive: true });
		const graphJson = JSON.stringify({
			stats: { categories: 1 },
			categories: [],
			units: [],
			edges: [],
			topics: [
				{ slug: "auth", wikiFile: "topic--auth.md" },
				{ slug: "gone", wikiFile: "topic--gone.md" }, // no file on disk → omitted
				{ slug: "evil", wikiFile: "../escape.md" }, // basename guard → skipped
				{ slug: "nofield" }, // no wikiFile → skipped (non-string guard)
			],
		});
		writeFileSync(join(kbRoot, ".jolli", "graph", "graph.json"), graphJson, "utf8");
		writeFileSync(join(kbRoot, "_wiki", "topic--auth.md"), "# Auth page body", "utf8");
		// Plant a file at the traversal TARGET of `../escape.md` (join(kbRoot,"_wiki","../escape.md")
		// = <kbRoot>/escape.md). This is what makes the basename guard load-bearing: without a file
		// here, `evil` would be dropped by existsSync alone and the guard would be untested.
		writeFileSync(join(kbRoot, "escape.md"), "SECRET-TRAVERSAL-CONTENT", "utf8");
		createStorage.mockResolvedValue({ kbRoot });

		const file = await exportGraphHtml({ cwd: kbRoot, out: tmp("kg-wiki-out-") });
		const html = readFileSync(file, "utf8");
		// Extract and parse the embedded wiki map (ASCII bodies → escape is a no-op → valid JSON).
		const m = html.match(/window\.__EMBEDDED_WIKI__ = (\{.*?\});/s);
		expect(m).toBeTruthy();
		expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual({ auth: "# Auth page body" });
		// The WIKI_FILE_RE basename guard blocked the traversal: escape.md's content
		// never reached the export. (Deleting the guard would read it into `evil`.)
		expect(html).not.toContain("SECRET-TRAVERSAL-CONTENT");
	});

	it("still exports (empty wiki map) when graph.json is malformed JSON", async () => {
		const kbRoot = tmp("kg-badjson-");
		mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
		writeFileSync(join(kbRoot, ".jolli", "graph", "graph.json"), "{not valid json", "utf8");
		createStorage.mockResolvedValue({ kbRoot });

		const file = await exportGraphHtml({ cwd: kbRoot, out: tmp("kg-badjson-out-") });
		const html = readFileSync(file, "utf8");
		// readWikiBodies swallows the parse error → empty map; the export still opens.
		const m = html.match(/window\.__EMBEDDED_WIKI__ = (\{.*?\});/s);
		expect(m).toBeTruthy();
		expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual({});
	});

	it("tolerates a graph.json whose `topics` is present but not an array", async () => {
		const kbRoot = tmp("kg-notopics-");
		mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
		writeFileSync(
			join(kbRoot, ".jolli", "graph", "graph.json"),
			JSON.stringify({ stats: {}, topics: "oops" }),
			"utf8",
		);
		createStorage.mockResolvedValue({ kbRoot });

		const file = await exportGraphHtml({ cwd: kbRoot, out: tmp("kg-notopics-out-") });
		const m = readFileSync(file, "utf8").match(/window\.__EMBEDDED_WIKI__ = (\{.*?\});/s);
		expect(m).toBeTruthy();
		expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual({});
	});

	it("omits a topic whose _wiki entry is present but unreadable (a directory in its place)", async () => {
		const kbRoot = tmp("kg-unreadable-");
		mkdirSync(join(kbRoot, ".jolli", "graph"), { recursive: true });
		// A DIRECTORY where the topic page file is expected: existsSync passes, readFileSync throws.
		mkdirSync(join(kbRoot, "_wiki", "topic--dir.md"), { recursive: true });
		writeFileSync(
			join(kbRoot, ".jolli", "graph", "graph.json"),
			JSON.stringify({
				stats: {},
				categories: [],
				units: [],
				edges: [],
				topics: [{ slug: "dir", wikiFile: "topic--dir.md" }],
			}),
			"utf8",
		);
		createStorage.mockResolvedValue({ kbRoot });

		const file = await exportGraphHtml({ cwd: kbRoot, out: tmp("kg-unreadable-out-") });
		const m = readFileSync(file, "utf8").match(/window\.__EMBEDDED_WIKI__ = (\{.*?\});/s);
		expect(m).toBeTruthy();
		expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual({});
	});
});
