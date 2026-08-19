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

import {
	buildGraphHtml,
	KnowledgeGraphPanel,
	openKnowledgeGraph,
	readGraphWikiBody,
	renderGraphHtml,
} from "./KnowledgeGraphPanel.js";

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
	createWebviewPanel.mockImplementation((_viewType: string, title: string) => {
		// biome-ignore lint/suspicious/noExplicitAny: loose webview mock, cast at call sites
		const webview: any = {
			asWebviewUri: (u: { toString: () => string }) => ({ toString: () => `vsc:${u.toString()}` }),
			cspSource: "vscode-resource:",
			html: "",
			postMessage: vi.fn(),
			// Capture the handler so tests can drive it, and hand back a disposable.
			onDidReceiveMessage: (cb: (m: unknown) => void) => {
				webview._onMessage = cb;
				return { dispose: vi.fn() };
			},
		};
		return {
			webview,
			onDidDispose: (cb: () => void) => {
				disposeCbs.push(cb);
			},
			reveal: vi.fn(),
			title,
			dispose: vi.fn(),
		};
	});
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

	// Behaviour is pinned in the CLI's core/InlineScript.test.ts — this panel
	// shares that implementation rather than carrying its own copy.
	it("escapes < in the embedded graph data, including a <!-- comment opener", () => {
		const html = renderGraphHtml(TEMPLATE, { ...ASSETS, graphJson: '{"x":"</script>BAD"}' });
		expect(html).toContain("\\u003c/script");
		expect(html).not.toContain("</script>BAD");

		const commented = renderGraphHtml(TEMPLATE, { ...ASSETS, graphJson: '{"x":"<!--<script>"}' });
		expect(commented).not.toContain("<!--<script>");
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
		// host-bridge.js MUST be loaded (defines WikiHost.requestWikiBody, the webview's
		// on-demand body source) and BEFORE data.js. Dropping it from SCRIPT_FILES would
		// silently break "Open full wiki page" in the webview.
		expect(html).toContain("/assets/graph/js/host-bridge.js");
		expect(html.indexOf("/js/host-bridge.js")).toBeLessThan(html.indexOf("/js/data.js"));
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

		KnowledgeGraphPanel.show(extensionUri, "/kb", "repo-a", '{"a":1}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(1);
		const panelA = createWebviewPanel.mock.results[0].value;
		expect(panelA.title).toBe("Knowledge Graph — repo-a");

		// A different repo gets its own tab — it does NOT overwrite repo-a's.
		KnowledgeGraphPanel.show(extensionUri, "/kb", "repo-b", '{"b":2}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		const panelB = createWebviewPanel.mock.results[1].value;
		expect(panelB.title).toBe("Knowledge Graph — repo-b");
		expect(panelA.title).toBe("Knowledge Graph — repo-a"); // untouched

		// Re-showing repo-a reveals its existing tab, no new panel.
		KnowledgeGraphPanel.show(extensionUri, "/kb", "repo-a", '{"a":11}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		expect(panelA.reveal).toHaveBeenCalled();

		// After repo-a's tab is disposed, the next show for repo-a creates a fresh panel.
		disposeCbs[0]();
		KnowledgeGraphPanel.show(extensionUri, "/kb", "repo-a", '{"a":111}');
		expect(createWebviewPanel).toHaveBeenCalledTimes(3);
	});

	it("ignores a late dispose for an already-recreated repo tab (stale-instance guard)", () => {
		const extensionUri = makeExtensionDir() as never;
		KnowledgeGraphPanel.show(extensionUri, "/kb", "a", "{}"); // panel A1 (disposeCbs[0]), panels[a]=A1
		disposeCbs[0](); // dispose A1 -> panels[a] cleared (panels.get(a) === this TRUE)
		KnowledgeGraphPanel.show(extensionUri, "/kb", "a", "{}"); // panel A2 (disposeCbs[1]), panels[a]=A2
		expect(createWebviewPanel).toHaveBeenCalledTimes(2);
		disposeCbs[0](); // A1's dispose fires again -> panels.get(a)(A2) !== A1 -> no-op (FALSE branch)
		KnowledgeGraphPanel.show(extensionUri, "/kb", "a", "{}"); // A2 still live -> reused, no 3rd panel
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

	it("stringifies a non-Error throw in the open-time failure message", async () => {
		// Defensive String(err) branch: when whatever show() throws is not an
		// Error instance, the message must still render the raw value rather
		// than "[object Object]" / crash on a missing .message.
		const extensionUri = makeExtensionDir() as never;
		const kbParent = mkdtempSync(join(tmpdir(), "kg-kb-"));
		tmpDirs.push(kbParent);
		mkdirSync(join(kbParent, "repo-a", ".jolli", "graph"), { recursive: true });
		writeFileSync(join(kbParent, "repo-a", ".jolli", "graph", "graph.json"), '{"stats":{}}', "utf8");

		const spy = vi.spyOn(KnowledgeGraphPanel, "show").mockImplementation(() => {
			throw "raw-string-failure";
		});
		try {
			await openKnowledgeGraph(extensionUri, kbParent, "repo-a");
		} finally {
			spy.mockRestore();
		}
		expect(showErrorMessage).toHaveBeenCalledTimes(1);
		expect(showErrorMessage.mock.calls[0][0]).toContain("raw-string-failure");
	});
});

describe("readGraphWikiBody", () => {
	it("reads a valid slug's page and rejects missing / malformed / traversal slugs", () => {
		const kbParent = mkdtempSync(join(tmpdir(), "kg-rb-"));
		tmpDirs.push(kbParent);
		mkdirSync(join(kbParent, "repo-a", "_wiki"), { recursive: true });
		writeFileSync(join(kbParent, "repo-a", "_wiki", "topic--auth.md"), "BODY", "utf8");
		expect(readGraphWikiBody(kbParent, "repo-a", "auth")).toBe("BODY");
		expect(readGraphWikiBody(kbParent, "repo-a", "missing")).toBeUndefined();
		expect(readGraphWikiBody(kbParent, "repo-a", "../secret")).toBeUndefined();
		expect(readGraphWikiBody(kbParent, "repo-a", "Bad_Slug")).toBeUndefined();
	});
});

describe("KnowledgeGraphPanel — wiki body request handler", () => {
	it("serves _wiki/topic--<slug>.md over postMessage, error-answers a miss, ignores junk", () => {
		const extensionUri = makeExtensionDir() as never;
		const kbParent = mkdtempSync(join(tmpdir(), "kg-msg-"));
		tmpDirs.push(kbParent);
		mkdirSync(join(kbParent, "repo-a", "_wiki"), { recursive: true });
		writeFileSync(join(kbParent, "repo-a", "_wiki", "topic--auth.md"), "# Auth\n\nbody", "utf8");

		KnowledgeGraphPanel.show(extensionUri, kbParent, "repo-a", "{}");
		const panel = createWebviewPanel.mock.results[0].value;
		const onMessage = panel.webview._onMessage as (m: unknown) => void;
		const post = panel.webview.postMessage as ReturnType<typeof vi.fn>;

		// A hit → the body is posted back, keyed by the request id.
		onMessage({ type: "jolli-graph-wiki-request", requestId: "r1", slug: "auth" });
		expect(post).toHaveBeenLastCalledWith({
			type: "jolli-graph-wiki-body",
			requestId: "r1",
			slug: "auth",
			markdown: "# Auth\n\nbody",
		});

		// A missing topic → error, never a body.
		onMessage({ type: "jolli-graph-wiki-request", requestId: "r2", slug: "missing" });
		expect(post).toHaveBeenLastCalledWith({
			type: "jolli-graph-wiki-body",
			requestId: "r2",
			slug: "missing",
			error: "not-found",
		});

		// A traversal slug is blocked before it reaches disk → error.
		onMessage({ type: "jolli-graph-wiki-request", requestId: "r3", slug: "../secret" });
		expect(post).toHaveBeenLastCalledWith({
			type: "jolli-graph-wiki-body",
			requestId: "r3",
			slug: "../secret",
			error: "not-found",
		});

		// Unrelated / malformed messages are ignored (no extra posts).
		const before = post.mock.calls.length;
		onMessage({ type: "jolli-graph-other" });
		onMessage({ type: "jolli-graph-wiki-request", requestId: "r4" }); // no slug
		onMessage(null);
		expect(post.mock.calls.length).toBe(before);
	});

	it("re-reads _wiki from the NEW kbParent after the folder is re-targeted on re-show", () => {
		const extensionUri = makeExtensionDir() as never;
		const kb1 = mkdtempSync(join(tmpdir(), "kg-kb1-"));
		const kb2 = mkdtempSync(join(tmpdir(), "kg-kb2-"));
		tmpDirs.push(kb1, kb2);
		mkdirSync(join(kb1, "repo-a", "_wiki"), { recursive: true });
		mkdirSync(join(kb2, "repo-a", "_wiki"), { recursive: true });
		writeFileSync(join(kb1, "repo-a", "_wiki", "topic--auth.md"), "OLD FOLDER BODY", "utf8");
		writeFileSync(join(kb2, "repo-a", "_wiki", "topic--auth.md"), "NEW FOLDER BODY", "utf8");

		KnowledgeGraphPanel.show(extensionUri, kb1, "repo-a", "{}");
		// Re-show the SAME repo after the Memory Bank folder was re-targeted (kb1 → kb2).
		KnowledgeGraphPanel.show(extensionUri, kb2, "repo-a", "{}");
		expect(createWebviewPanel).toHaveBeenCalledTimes(1); // same panel reused
		const panel = createWebviewPanel.mock.results[0].value;
		const onMessage = panel.webview._onMessage as (m: unknown) => void;
		const post = panel.webview.postMessage as ReturnType<typeof vi.fn>;

		onMessage({ type: "jolli-graph-wiki-request", requestId: "r1", slug: "auth" });
		// Must serve from kb2 (the re-targeted folder), not the stale kb1.
		expect(post).toHaveBeenLastCalledWith({
			type: "jolli-graph-wiki-body",
			requestId: "r1",
			slug: "auth",
			markdown: "NEW FOLDER BODY",
		});
	});
});
