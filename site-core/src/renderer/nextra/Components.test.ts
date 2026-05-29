/**
 * Tests for the Nextra OpenAPI component-tree emitter. These check that the
 * shape of the emitted output matches what the per-endpoint MDX shim imports
 * — file paths and the public exports each component declares.
 */

import { describe, expect, it } from "vitest";
import { generateApiComponents } from "./Components.js";

describe("generateApiComponents", () => {
	const files = generateApiComponents();
	const byPath = new Map(files.map((f) => [f.path, f.content]));

	it("emits exactly twenty files under components/api/", () => {
		expect(files).toHaveLength(20);
		for (const f of files) {
			expect(f.path.startsWith("components/api/")).toBe(true);
		}
	});

	it("emits the utilities and components in expected paths", () => {
		const paths = new Set(files.map((f) => f.path));
		for (const file of [
			// Shared utility + plain (.ts) modules
			"components/api/describeType.ts",
			"components/api/requestSnippets.ts",
			"components/api/tryItHistory.ts",
			"components/api/jsonHighlight.ts",
			"components/api/serverVars.ts",
			"components/api/paramSchema.ts",
			// React components
			"components/api/EndpointMeta.tsx",
			"components/api/ParamTable.tsx",
			"components/api/SchemaBlock.tsx",
			"components/api/ResponseBlock.tsx",
			"components/api/ResponseTabs.tsx",
			"components/api/AuthRequirements.tsx",
			"components/api/TryIt.tsx",
			"components/api/TryItContext.tsx",
			"components/api/CodeSwitcher.tsx",
			"components/api/CodeEditor.tsx",
			"components/api/TypedInput.tsx",
			"components/api/RequestSample.tsx",
			"components/api/HistoryItem.tsx",
			"components/api/Endpoint.tsx",
		]) {
			expect(paths.has(file)).toBe(true);
		}
	});

	it('emits all React components as client components ("use client" pragma)', () => {
		// The plain (.ts) utility modules are the only ones without the pragma.
		const plainModules = new Set([
			"components/api/describeType.ts",
			"components/api/requestSnippets.ts",
			"components/api/tryItHistory.ts",
			"components/api/jsonHighlight.ts",
			"components/api/serverVars.ts",
			"components/api/paramSchema.ts",
		]);
		for (const file of files) {
			if (plainModules.has(file.path)) {
				expect(file.content.startsWith('"use client";')).toBe(false);
				continue;
			}
			expect(file.content.startsWith('"use client";')).toBe(true);
		}
	});

	it("Endpoint.tsx exports the slot markers EndpointDescription and EndpointSamples", () => {
		const endpoint = byPath.get("components/api/Endpoint.tsx") ?? "";
		expect(endpoint).toContain("export function EndpointDescription");
		expect(endpoint).toContain("export function EndpointSamples");
	});

	it("CodeSwitcher.tsx is a default-exported function component", () => {
		const switcher = byPath.get("components/api/CodeSwitcher.tsx") ?? "";
		expect(switcher).toContain("export default function CodeSwitcher");
	});

	it("SchemaBlock.tsx detects circular $refs to avoid unbounded React trees", () => {
		const schemaBlock = byPath.get("components/api/SchemaBlock.tsx") ?? "";
		expect(schemaBlock).toContain("(circular)");
	});

	it("TryItContext.tsx persists auth values via sessionStorage (per-spec scoped)", () => {
		const ctx = byPath.get("components/api/TryItContext.tsx") ?? "";
		expect(ctx).toContain("sessionStorage");
		expect(ctx).toContain("jolli-tryit:");
	});

	it("tryItHistory.ts logs sent requests to localStorage", () => {
		const hist = byPath.get("components/api/tryItHistory.ts") ?? "";
		expect(hist).toContain("localStorage");
		expect(hist).toContain("jolli-tryit-history:");
	});

	it("serverVars.ts resolves templated server URLs", () => {
		const sv = byPath.get("components/api/serverVars.ts") ?? "";
		expect(sv).toContain("export function resolveServerUrl");
		expect(sv).toContain("export function serverVariablesFor");
	});

	it("paramSchema.ts derives the input control from a schema", () => {
		const ps = byPath.get("components/api/paramSchema.ts") ?? "";
		expect(ps).toContain("export function inputKind");
		expect(ps).toContain("export function primaryType");
	});

	it("describeType handles array items and $ref shorthand", () => {
		const helper = byPath.get("components/api/describeType.ts") ?? "";
		expect(helper).toContain("export function describeType");
		expect(helper).toContain("$ref");
		expect(helper).toContain("array");
	});

	it("Endpoint.tsx imports each of its child components from the same folder", () => {
		const endpoint = byPath.get("components/api/Endpoint.tsx") ?? "";
		for (const importLine of [
			'import EndpointMeta from "./EndpointMeta"',
			'import ParamTable from "./ParamTable"',
			'import SchemaBlock from "./SchemaBlock"',
			'import ResponseTabs from "./ResponseTabs"',
			'import AuthRequirements from "./AuthRequirements"',
			'import TryIt from "./TryIt"',
			'import RequestSample from "./RequestSample"',
			'import { TryItProvider } from "./TryItContext"',
		]) {
			expect(endpoint).toContain(importLine);
		}
		// The vertical ResponseBlock stack was replaced by the tabbed ResponseTabs.
		expect(endpoint).not.toContain('import ResponseBlock from "./ResponseBlock"');
	});
});
