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
	it("neutralizes </script and the U+2028/U+2029 terminators", () => {
		const ls = String.fromCharCode(0x2028),
			ps = String.fromCharCode(0x2029);
		const out = escapeForInlineScript(`{"x":"</script>${ls}${ps}"}`);
		expect(out).toContain("<\\/script");
		expect(out).not.toContain("</script>");
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
		expect(html).toContain("<\\/script");
		expect(html).not.toContain("</script>bad");
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
});
