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

	it("emits exactly nine files under components/api/", () => {
		expect(files).toHaveLength(9);
		for (const f of files) {
			expect(f.path.startsWith("components/api/")).toBe(true);
		}
	});

	it("emits the describeType utility, the eight components, in expected paths", () => {
		const paths = new Set(files.map((f) => f.path));
		for (const file of [
			"components/api/describeType.ts",
			"components/api/EndpointMeta.tsx",
			"components/api/ParamTable.tsx",
			"components/api/SchemaBlock.tsx",
			"components/api/ResponseBlock.tsx",
			"components/api/AuthRequirements.tsx",
			"components/api/TryIt.tsx",
			"components/api/CodeSwitcher.tsx",
			"components/api/Endpoint.tsx",
		]) {
			expect(paths.has(file)).toBe(true);
		}
	});

	it('emits all components as client components ("use client" pragma)', () => {
		// The describeType utility is the only one that is a plain module.
		for (const file of files) {
			if (file.path === "components/api/describeType.ts") {
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

	it("TryIt.tsx persists auth values via sessionStorage (per-spec scoped)", () => {
		const tryIt = byPath.get("components/api/TryIt.tsx") ?? "";
		expect(tryIt).toContain("sessionStorage");
		expect(tryIt).toContain("jolli-tryit:");
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
			'import ResponseBlock from "./ResponseBlock"',
			'import AuthRequirements from "./AuthRequirements"',
			'import TryIt from "./TryIt"',
		]) {
			expect(endpoint).toContain(importLine);
		}
	});
});
