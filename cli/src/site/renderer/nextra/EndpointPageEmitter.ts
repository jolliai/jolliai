/**
 * Emits the per-endpoint MDX **shim** plus the spec-wide `_refs.ts` schema
 * map. The shim used to inline the entire left-column rendering as MDX/JSX
 * (10–20 KB per endpoint, forcing Next.js to compile a JSX tree that scaled
 * linearly with the spec). It now delegates rendering to a single
 * `<Endpoint>` component that reads a JSON sidecar at
 * `content/api-{spec}/_data/{operationId}.json`. The MDX file shrinks to
 * ~2–4 KB.
 *
 * The shim contains:
 *   1. Front-matter (title + per-page theme override)
 *   2. Imports for `<Endpoint>`, `<CodeSwitcher>`, the data sidecar, and
 *      the spec-wide refs map
 *   3. `<EndpointDescription>` (when the spec has a description) — wraps
 *      inline MDX so Nextra's MDX → Shiki pipeline still renders any
 *      markdown / fenced code the spec author included
 *   4. `<EndpointSamples>` — request and response code switchers, kept as
 *      MDX-fenced code blocks so Nextra's existing Shiki pipeline highlights
 *      them at site-build time
 *
 * Layout (`api-endpoint-grid`) and section ordering live inside `<Endpoint>`.
 */

import { escapeHtml, escapeMdxText, escapeYaml } from "../../openapi/Escape.js";
import { exampleFromSchema } from "../../openapi/SchemaExample.js";
import type { OpenApiCodeSamples, OpenApiOperation, ParsedSpec } from "../../openapi/Types.js";
import { endpointDataImportSpecifier, endpointPagePath } from "./Paths.js";
import type { TemplateFile } from "./Types.js";

// ─── _refs.ts emitter ────────────────────────────────────────────────────────

/**
 * Emits the `_refs.ts` sidecar at `content/api-{spec}/_refs.ts` — the
 * spec-wide schema map (`#/components/schemas/*`) exported as a default
 * const that every endpoint page imports. Hoisting it here means the
 * schemas live in the repo exactly once per spec instead of once per
 * `<SchemaBlock>` / `<ResponseBlock>` call.
 *
 * The leading underscore matches Nextra's convention for files that should
 * be importable but skipped from the page tree (same as `_meta.ts`).
 */
export function emitRefsFile(specName: string, parsed: ParsedSpec): TemplateFile {
	const schemasJson = JSON.stringify(parsed.componentSchemas, null, 2);
	return {
		path: `content/api-${specName}/_refs.ts`,
		content: `// Auto-generated. Schema definitions for the "${specName}" OpenAPI spec —
// imported by every endpoint MDX page so the schemas live here once instead
// of inlined into every <SchemaBlock> / <ResponseBlock> call.

const REFS: Record<string, unknown> = ${schemasJson};

export default REFS;
`,
	};
}

// ─── Endpoint MDX shim emitter ───────────────────────────────────────────────

export function emitEndpointPage(
	specName: string,
	operation: OpenApiOperation,
	samples: OpenApiCodeSamples,
): TemplateFile {
	const path = endpointPagePath(specName, operation);
	const fallbackTitle = `${operation.method.toUpperCase()} ${operation.path}`;

	// `@/*` is the project-root path alias defined in the generated
	// tsconfig. Using it (rather than `../../../components/api/...`)
	// keeps the import valid if the MDX directory layout ever changes.
	const importBlock = [
		'import Endpoint, { EndpointDescription, EndpointSamples } from "@/components/api/Endpoint";',
		'import CodeSwitcher from "@/components/api/CodeSwitcher";',
		'import REFS from "../_refs";',
		`import data from "${endpointDataImportSpecifier(operation)}";`,
	].join("\n");

	const lines: string[] = [
		// `theme.toc: false` hides the TOC for this page; `layout: full` removes
		// Nextra's max-width clamp so the two-column grid uses the available
		// width.
		`---\ntitle: ${escapeYaml(operation.summary || fallbackTitle)}\ntheme:\n  toc: false\n  layout: full\n---\n`,
		importBlock,
		"",
		"<Endpoint data={data} refs={REFS}>",
		"",
	];

	if (operation.description) {
		// `data-slot` is what `<Endpoint>` matches on to find this child —
		// matching on component identity or displayName fails during SSR
		// because the children of a client component arrive with `type` set
		// to the opaque RSC client reference, not the actual function.
		lines.push('<EndpointDescription data-slot="description">');
		lines.push("");
		// `escapeMdxText` here protects against bare `<` characters in the
		// spec's description (comparison operators like `<= 10`) being
		// parsed as JSX tag starts. Curly braces are also escaped so spec
		// authors can write `{value}` literally without it becoming an
		// MDX expression.
		lines.push(escapeMdxText(operation.description.trim()));
		lines.push("");
		lines.push("</EndpointDescription>");
		lines.push("");
	}

	lines.push('<EndpointSamples data-slot="samples">');
	lines.push("");
	lines.push(buildCodeSampleSwitcher(samples));
	lines.push("");
	const responseSwitcher = buildResponseExampleSwitcher(operation);
	if (responseSwitcher) {
		lines.push(responseSwitcher);
		lines.push("");
	}
	lines.push("</EndpointSamples>");
	lines.push("");
	lines.push("</Endpoint>");
	lines.push("");

	return { path, content: lines.join("\n") };
}

// ─── Internal switcher builders ──────────────────────────────────────────────

interface SwitcherPane {
	value: string;
	label: string;
	lang: string;
	body: string;
}

/**
 * Picks an MDX fence one backtick longer than the longest backtick run found
 * in the body, with a floor of three. CommonMark allows fences of any length
 * ≥ 3 as long as the run inside is shorter than the fence — so a body
 * containing literal ` ``` ` (e.g. an inline markdown example in an OpenAPI
 * sample) won't close the fence early.
 */
function pickFence(body: string): string {
	const longestRun = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
	return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * Emits a `<CodeSwitcher>` block with one pane per option. Each pane wraps
 * a fenced code block in a `<div data-pane="...">` so Nextra's MDX → Shiki
 * pipeline still runs over the fence content; the switcher only handles
 * picker + copy, never re-highlights the code itself.
 */
function buildSwitcher(label: string, panes: SwitcherPane[]): string {
	const optionsLiteral = JSON.stringify(panes.map((p) => ({ value: p.value, label: p.label })));
	const blocks = panes
		.map((p) => {
			const fence = pickFence(p.body);
			return `<div data-pane="${escapeHtml(p.value)}">\n\n${fence}${p.lang}\n${p.body}\n${fence}\n\n</div>`;
		})
		.join("\n");
	return `<CodeSwitcher label=${jsonAttr(label)} options={${optionsLiteral}}>\n${blocks}\n</CodeSwitcher>`;
}

/**
 * Renders the five language samples behind a single dropdown. Fence
 * languages match Shiki's grammar names so highlighting works:
 *   - `bash` for cURL, `js` for JavaScript fetch, `ts` for TypeScript,
 *     `python` for Python, `go` for Go.
 */
function buildCodeSampleSwitcher(samples: OpenApiCodeSamples): string {
	const panes: SwitcherPane[] = [
		{ value: "curl", label: "cURL", lang: "bash", body: samples.curl },
		{ value: "javascript", label: "JavaScript", lang: "js", body: samples.js },
		{ value: "typescript", label: "TypeScript", lang: "ts", body: samples.ts },
		{ value: "python", label: "Python", lang: "python", body: samples.python },
		{ value: "go", label: "Go", lang: "go", body: samples.go },
	];
	return buildSwitcher("Request", panes);
}

/**
 * Builds the response-examples switcher — one pane per response status
 * code, each containing a fenced JSON code block with a synthesised example
 * body. Falls back to the spec's literal `example` value when present;
 * otherwise walks the schema to produce a minimal payload.
 *
 * Returns an empty string when no response has a schema or example —
 * showing an empty picker would just be visual clutter.
 */
function buildResponseExampleSwitcher(operation: OpenApiOperation): string {
	const panes: SwitcherPane[] = [];
	for (const resp of operation.responses) {
		const example = resp.example !== undefined ? resp.example : exampleFromSchema(resp.schema);
		if (example === undefined) {
			continue;
		}
		const json = JSON.stringify(example, null, 2);
		const labelSuffix = resp.description ? ` — ${resp.description}` : "";
		panes.push({
			value: resp.status,
			label: `${resp.status}${labelSuffix}`,
			lang: "json",
			body: json,
		});
	}
	if (panes.length === 0) {
		return "";
	}
	return buildSwitcher("Response", panes);
}

/**
 * Stringify for use as a JSX attribute value. Returns the **expression form**
 * (`{"..."}`) rather than the string form (`"..."`) so OpenAPI path
 * templates like `/store/order/{orderId}` round-trip safely.
 */
function jsonAttr(value: string): string {
	return `{${JSON.stringify(value)}}`;
}
