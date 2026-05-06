/**
 * Nextra OpenAPI emitter — orchestrator.
 *
 * Builds the per-spec MDX output for an array of `OpenApiSpecInput`s.
 * The 9 React components live one level up — they're scaffolding written
 * once by `NextraRenderer.initProject` via `generateApiComponents`, not
 * regenerated per render.
 *
 * Each spec lives in its own top-level folder (`content/api-{spec}/`) so
 * Nextra binds it as an independent page-tab and the sidebar scopes to
 * a single spec at a time.
 */

import { generateCodeSamples } from "../../openapi/CodeSampleGenerator.js";
import type { OpenApiPipelineResult } from "../../openapi/Types.js";
import type { OpenApiSpecInput } from "../SiteRenderer.js";
import { emitEndpointData } from "./EndpointDataEmitter.js";
import { emitEndpointPage, emitRefsFile } from "./EndpointPageEmitter.js";
import { emitOverviewPage } from "./OverviewPageEmitter.js";
import { emitSidebarMetas } from "./SidebarMetaEmitter.js";
import type { TemplateFile } from "./Types.js";

export { generateApiComponents } from "./Components.js";
export { emitEndpointData } from "./EndpointDataEmitter.js";
export { emitEndpointPage, emitRefsFile } from "./EndpointPageEmitter.js";
export { emitOverviewPage } from "./OverviewPageEmitter.js";
export { emitSidebarMetas } from "./SidebarMetaEmitter.js";
export type { TemplateFile } from "./Types.js";

// ─── Per-spec emission ───────────────────────────────────────────────────────

/**
 * Generates the MDX-per-endpoint output for one OpenAPI spec: overview
 * page, every endpoint page + JSON sidecar, the spec-wide refs map, and
 * sidebar `_meta.ts` files. Components are NOT included — the caller
 * emits them once for the whole site.
 *
 * Code samples are taken from the pre-built dossier when present; if the
 * dossier is missing one, samples are computed inline so this function is
 * usable with a minimal `OpenApiPipelineResult` (e.g. constructed in a
 * test that didn't run the full pipeline).
 */
export function emitNextraOpenApiForSpec(specName: string, pipeline: OpenApiPipelineResult): TemplateFile[] {
	const files: TemplateFile[] = [];
	files.push(emitOverviewPage(specName, pipeline.spec));
	// One `_refs.ts` per spec, shared by every endpoint page.
	files.push(emitRefsFile(specName, pipeline.spec));

	const samplesByOpId = new Map<string, OpenApiPipelineResult["dossiers"][number]["codeSamples"]>();
	for (const dossier of pipeline.dossiers) {
		samplesByOpId.set(dossier.operation.operationId, dossier.codeSamples);
	}

	const fallbackServer = pipeline.spec.servers[0]?.url ?? "https://api.example.com";
	for (const operation of pipeline.spec.operations) {
		const cached = samplesByOpId.get(operation.operationId);
		const samples =
			cached ??
			generateCodeSamples(
				operation,
				operation.servers?.[0]?.url ?? fallbackServer,
				pipeline.spec.securitySchemes,
			);
		// Two files per operation: a thin MDX shim (rendering delegated to
		// `<Endpoint>`) plus its JSON sidecar with all the data the component
		// reads.
		files.push(emitEndpointData(specName, operation, pipeline.spec));
		files.push(emitEndpointPage(specName, operation, samples));
	}

	files.push(...emitSidebarMetas(specName, pipeline.spec));
	return files;
}

// ─── Top-level emission ──────────────────────────────────────────────────────

/**
 * Generates the per-spec output for API reference rendering. Components
 * are NOT included here — they are scaffolding and get written once by
 * `NextraRenderer.initProject` (see `generateApiComponents`).
 */
export function emitNextraOpenApiFiles(specs: OpenApiSpecInput[]): TemplateFile[] {
	const files: TemplateFile[] = [];
	for (const spec of specs) {
		files.push(...emitNextraOpenApiForSpec(spec.specName, spec.pipeline));
	}
	return files;
}
