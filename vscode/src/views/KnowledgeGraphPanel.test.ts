import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = join(HERE, "..", "..", "..", "cli", "src", "graph", "assets", "index.html");

const { createWebviewPanel, showInformationMessage, showErrorMessage } = vi.hoisted(() => ({
	createWebviewPanel: vi.fn(),
	showInformationMessage: vi.fn(),
	showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
	window: { createWebviewPanel, showInformationMessage, showErrorMessage },
	Uri: {
		file: (s: string) => ({ fsPath: s, toString: () => s }),
		joinPath: (base: { fsPath?: string }, ...parts: string[]) => {
			const p = [base?.fsPath ?? String(base), ...parts].join("/");
			return { fsPath: p, toString: () => p };
		},
	},
	ViewColumn: { One: 1 },
}));

import { buildGraphHtml, KnowledgeGraphPanel, openKnowledgeGraph, renderGraphHtml } from "./KnowledgeGraphPanel.js";

const TEMPLATE = `<!doctype html><html><head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="styles/main.css" />
</head><body>
  <div id="board"></div>
  <!-- scripts:start -->
  <script src="vendor/panzoom.min.js"></script>
  <!-- scripts:end -->
</body></html>`;

const ASSETS = {
	cspSource: "vscode-resource:",
	nonce: "NONCE123",
	cssUri: "vsc:css",
	vendorUris: ["vsc:panzoom", "vsc:elk", "vsc:marked"],
	scriptUris: ["vsc:data", "vsc:main"],
	graphJson: '{"ok":true}',
};

let disposeCbs: Array<() => void> = [];
const tmpDirs: string[] = [];

function makeExtensionDir(withTemplate = true): { fsPath: string; toString: () => string } {
	const dir = mkdtempSync(join(tmpdir(), "kg-ext-"));
	tmpDirs.push(dir);
	mkdirSync(join(dir, "assets", "graph"), { recursive: true });
	if (withTemplate) writeFileSync(join(dir, "assets", "graph", "index.html"), TEMPLATE, "utf8");
	return { fsPath: dir, toString: () => dir };
}

beforeEach(() => {
	createWebviewPanel.mockReset();
	showInformationMessage.mockReset();
	showErrorMessage.mockReset();
	disposeCbs = [];
	createWebviewPanel.mockImplementation((_viewType: string, title: string) => ({
		webview: {
			asWebviewUri: (u: { toString: () => string }) => ({ toString: () => `vsc:${u.toString()}` }),
			cspSource: "vscode-resource:",
			html: "",
		},
		onDidDispose: (cb: () => void) => {
			disposeCbs.push(cb);
		},
		reveal: vi.fn(),
		title,
		dispose: vi.fn(),
	}));
});

afterEach(() => {
	// Clear the module-level singleton so each test starts fresh.
	for (const cb of disposeCbs) cb();
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("renderGraphHtml", () => {
	it("injects CSP, swaps the stylesheet, and inlines vendor/app scripts + graph data", () => {
		const html = renderGraphHtml(TEMPLATE, ASSETS);
		expect(html).toContain("Content-Security-Policy");
		expect(html).toContain("script-src vscode-resource: 'nonce-NONCE123'");
		expect(html).toContain('<link rel="stylesheet" href="vsc:css" />');
		expect(html).not.toContain('href="styles/main.css"');
		expect(html).toContain('<script src="vsc:panzoom"></script>');
		expect(html).toContain('<script src="vsc:main"></script>');
		expect(html).toContain('<script nonce="NONCE123">window.__EMBEDDED_GRAPH__ = {"ok":true};</script>');
		expect(html).not.toContain("<!-- scripts:start -->");
	});

	it("escapes </script sequences in the embedded graph data", () => {
		const html = renderGraphHtml(TEMPLATE, { ...ASSETS, graphJson: '{"x":"</script>BAD"}' });
		expect(html).toContain("<\\/script");
		expect(html).not.toContain("</script>BAD");
	});

	it("permits inline styles (style-src 'unsafe-inline') so per-category colors survive", () => {
		const html = renderGraphHtml(TEMPLATE, ASSETS);
		expect(html).toContain("style-src vscode-resource: 'unsafe-inline'");
	});

	it("throws if the template is missing an expected marker (no silent CSP drop)", () => {
		const broken = TEMPLATE.replace("<!-- scripts:start -->", "").replace("<!-- scripts:end -->", "");
		expect(() => renderGraphHtml(broken, ASSETS)).toThrow(/missing expected marker/);
	});

	it("escapes U+2028/U+2029 line separators in the embedded data", () => {
		const ls = String.fromCharCode(0x2028);
		const html = renderGraphHtml(TEMPLATE, { ...ASSETS, graphJson: `{"x":"a${ls}b"}` });
		expect(html).toContain("\\u2028");
		expect(html).not.toContain(ls);
	});

	it("renders the REAL shipped template (CSP injected, all markers resolved)", () => {
		const realTemplate = readFileSync(REAL_TEMPLATE, "utf8");
		const html = renderGraphHtml(realTemplate, ASSETS);
		expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
		expect(html).toContain('<link rel="stylesheet" href="vsc:css" />');
		expect(html).not.toContain("styles/main.css");
		expect(html).not.toContain("<!-- scripts:start -->");
		expect(html).toContain("window.__EMBEDDED_GRAPH__");
	});
});

describe("buildGraphHtml", () => {
	it("reads the shipped template and resolves webview URIs", () => {
		const extensionUri = makeExtensionDir();
		const webview = {
			asWebviewUri: (u: { toString: () => string }) => ({ toString: () => `w:${u.toString()}` }),
			cspSource: "vscode-resource:",
		} as never;
		const html = buildGraphHtml(webview, extensionUri as never, '{"a":1}');
		expect(html).toContain("window.__EMBEDDED_GRAPH__ = {\"a\":1};");
		expect(html).toContain("/assets/graph/vendor/panzoom.min.js");
		expect(html).toContain("/assets/graph/styles/main.css");
	});

	it("throws a clear error when the shipped template is missing from the build", () => {
		const extensionUri = makeExtensionDir(false); // graph dir exists but no index.html
		const webview = {
			asWebviewUri: (u: { toString: () => string }) => ({ toString: () => String(u) }),
			cspSource: "vscode-resource:",
		} as never;
		expect(() => buildGraphHtml(webview, extensionUri as never, "{}")).toThrow(/assets are missing/);
	});
});

describe("KnowledgeGraphPanel.show", () => {
	it("opens one tab per repo, reuses a repo's tab on re-show, and recreates after dispose", () => {
		const extensionUri = makeExtensionDir() as never;

		KnowledgeGraphPanel.show(extensionUri, "repo-a", '{"a":1}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
		const panelA = createWebviewPanel.mock.results[0].value;
		expect(panelA.title).toBe("Knowledge Graph — repo-a");

		// A different repo gets its own tab — it does NOT overwrite repo-a's.
		KnowledgeGraphPanel.show(extensionUri, "repo-b", '{"b":2}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		const panelB = createWebviewPanel.mock.results[1].value;
		expect(panelB.title).toBe("Knowledge Graph — repo-b");
		expect(panelA.title).toBe("Knowledge Graph — repo-a"); // untouched

		// Re-showing repo-a reveals its existing tab, no new panel.
		KnowledgeGraphPanel.show(extensionUri, "repo-a", '{"a":11}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		expect(panelA.reveal).toHaveBeenCalled();

		// After repo-a's tab is disposed, the next show for repo-a creates a fresh panel.
		disposeCbs[0]();
		KnowledgeGraphPanel.show(extensionUri, "repo-a", '{"a":111}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(3);
	});

	it("ignores a late dispose for an already-recreated repo tab (stale-instance guard)", () => {
		const extensionUri = makeExtensionDir() as never;
		KnowledgeGraphPanel.show(extensionUri, "a", "{}"); // panel A1 (disposeCbs[0]), panels[a]=A1
		disposeCbs[0](); // dispose A1 -> panels[a] cleared (panels.get(a) === this TRUE)
		KnowledgeGraphPanel.show(extensionUri, "a", "{}"); // panel A2 (disposeCbs[1]), panels[a]=A2
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		disposeCbs[0](); // A1's dispose fires again -> panels.get(a)(A2) !== A1 -> no-op (FALSE branch)
		KnowledgeGraphPanel.show(extensionUri, "a", "{}"); // A2 still live -> reused, no 3rd panel
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
	});
});

describe("openKnowledgeGraph", () => {
	it("does nothing without a repo name", async () => {
		await openKnowledgeGraph({ fsPath: "/x" } as never, "/kb", undefined);
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(createWebviewPanel).not.toHaveBeenCalled();
	});

	it("prompts to build first when no graph exists", async () => {
		const kbParent = mkdtempSync(join(tmpdir(), "kg-kb-"));
		tmpDirs.push(kbParent);
		await openKnowledgeGraph({ fsPath: "/x" } as never, kbParent, "missing-repo");
		expect(showInformationMessage).toHaveBeenCalledTimes(1);
		expect(createWebviewPanel).not.toHaveBeenCalled();
	});

	it("opens the panel when the repo's graph.json exists", async () => {
		const extensionUri = makeExtensionDir() as never;
		const kbParent = mkdtempSync(join(tmpdir(), "kg-kb-"));
		tmpDirs.push(kbParent);
		mkdirSync(join(kbParent, "repo-a", ".jolli", "graph"), { recursive: true });
		writeFileSync(join(kbParent, "repo-a", ".jolli", "graph", "graph.json"), '{"stats":{}}', "utf8");

		await openKnowledgeGraph(extensionUri, kbParent, "repo-a");
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
	});

	it("surfaces a clear error when the viz assets are missing at open time", async () => {
		const extensionUri = makeExtensionDir(false) as never; // no index.html
		const kbParent = mkdtempSync(join(tmpdir(), "kg-kb-"));
		tmpDirs.push(kbParent);
		mkdirSync(join(kbParent, "repo-a", ".jolli", "graph"), { recursive: true });
		writeFileSync(join(kbParent, "repo-a", ".jolli", "graph", "graph.json"), '{"stats":{}}', "utf8");

		await openKnowledgeGraph(extensionUri, kbParent, "repo-a");
		expect(showErrorMessage).toHaveBeenCalledTimes(1);
	});
});
