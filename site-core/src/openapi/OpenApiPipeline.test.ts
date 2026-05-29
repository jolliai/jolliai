/**
 * Tests for OpenApiPipeline.buildPipeline — end-to-end orchestration.
 *
 * Verifies that:
 *   - parseFullSpec is called and its result is in the output
 *   - one EndpointDossier is emitted per operation
 *   - code samples use the spec-level server URL by default
 *   - operation-level servers override the spec-level URL in code samples
 *   - a fallback URL is used when no servers are declared
 *   - security schemes flow through to code samples
 */

import { describe, expect, it } from "vitest";
import { buildPipeline } from "./OpenApiPipeline.js";
import type { OpenApiDocument } from "./Types.js";

function makeDoc(overrides: Partial<OpenApiDocument> = {}): OpenApiDocument {
	return {
		openapi: "3.1.0",
		info: { title: "Pet Store", version: "1.0.0" },
		...overrides,
	} as OpenApiDocument;
}

describe("buildPipeline", () => {
	it("returns a ParsedSpec and one dossier per operation", () => {
		const doc = makeDoc({
			paths: {
				"/pets": { get: { operationId: "listpets" }, post: { operationId: "createpet" } },
			},
		});
		const result = buildPipeline(doc);
		expect(result.spec.info.title).toBe("Pet Store");
		expect(result.dossiers).toHaveLength(2);
		expect(result.dossiers.map((d) => d.operation.operationId)).toEqual(["listpets", "createpet"]);
	});

	it("populates all five language code samples for each dossier", () => {
		const doc = makeDoc({ paths: { "/x": { get: {} } } });
		const result = buildPipeline(doc);
		const samples = result.dossiers[0].codeSamples;
		expect(samples.curl).toMatch(/curl -X GET/);
		expect(samples.js).toMatch(/await fetch/);
		expect(samples.ts).toMatch(/interface ApiResponse/);
		expect(samples.python).toMatch(/import requests/);
		expect(samples.go).toMatch(/package main/);
	});

	it("uses the first spec-level server URL in code samples", () => {
		const doc = makeDoc({
			servers: [{ url: "https://api.example.com/v1" }],
			paths: { "/things": { get: {} } },
		});
		const result = buildPipeline(doc);
		expect(result.dossiers[0].codeSamples.curl).toContain("https://api.example.com/v1/things");
	});

	it("operation-level servers override the spec-level server in code samples", () => {
		const doc = makeDoc({
			servers: [{ url: "https://default.example.com" }],
			paths: {
				"/x": { get: { servers: [{ url: "https://override.example.com" }] } },
			},
		});
		const result = buildPipeline(doc);
		expect(result.dossiers[0].codeSamples.curl).toContain("https://override.example.com");
		expect(result.dossiers[0].codeSamples.curl).not.toContain("https://default.example.com");
	});

	it("uses a fallback URL when neither the spec nor the operation declares servers", () => {
		const doc = makeDoc({ paths: { "/x": { get: {} } } });
		const result = buildPipeline(doc);
		expect(result.dossiers[0].codeSamples.curl).toContain("https://api.example.com");
	});

	it("threads security schemes through to the code-sample auth headers", () => {
		const doc = makeDoc({
			components: {
				securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
			},
			paths: { "/me": { get: { security: [{ bearerAuth: [] }] } } },
		});
		const result = buildPipeline(doc);
		expect(result.dossiers[0].codeSamples.curl).toContain("Authorization: Bearer YOUR_TOKEN");
	});

	it("returns no dossiers when the spec has no paths", () => {
		const result = buildPipeline(makeDoc({}));
		expect(result.dossiers).toEqual([]);
		expect(result.spec.operations).toEqual([]);
	});

	it("propagates a parser collision error rather than swallowing it", () => {
		const doc = makeDoc({
			paths: {
				"/a": { get: { operationId: "list", tags: ["users"] } },
				"/b": { post: { operationId: "list", tags: ["users"] } },
			},
		});
		expect(() => buildPipeline(doc)).toThrow(/OpenAPI spec collision/);
	});
});
