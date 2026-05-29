/**
 * OpenApiPipeline — orchestrates the framework-agnostic IR build.
 *
 * Takes a raw `OpenApiDocument` (Phase 1's `tryParseOpenApi` output) and
 * returns the `ParsedSpec` plus per-operation `EndpointDossier`s with
 * pre-rendered code samples. Emitters consume this output verbatim — they
 * do not call `parseFullSpec` or `generateCodeSamples` directly.
 *
 * Single entry point keeps emitters from accidentally feeding pre-walk
 * data into a sample generator that expects post-walk operations.
 */

import { generateCodeSamples } from "./CodeSampleGenerator.js";
import { parseFullSpec } from "./SpecParser.js";
import type { EndpointDossier, OpenApiDocument, OpenApiPipelineResult } from "./Types.js";

/** Server URL used when the spec declares no `servers[]`. */
const FALLBACK_SERVER_URL = "https://api.example.com";

/**
 * Picks the server URL used to render code samples. Operation-level
 * `servers[]` overrides the spec-level array; both fall back to a
 * generic example so code samples always have a concrete URL.
 */
function resolveSampleServerUrl(
	specServers: ReadonlyArray<{ url: string }>,
	operationServers: ReadonlyArray<{ url: string }> | undefined,
): string {
	if (operationServers && operationServers.length > 0) {
		return operationServers[0].url;
	}
	if (specServers.length > 0) {
		return specServers[0].url;
	}
	return FALLBACK_SERVER_URL;
}

/**
 * Builds the full IR — parses the spec, then attaches code samples per
 * operation. The result is what every emitter consumes.
 */
export function buildPipeline(doc: OpenApiDocument): OpenApiPipelineResult {
	const spec = parseFullSpec(doc);

	const dossiers: EndpointDossier[] = spec.operations.map((operation) => {
		const serverUrl = resolveSampleServerUrl(spec.servers, operation.servers);
		const codeSamples = generateCodeSamples(operation, serverUrl, spec.securitySchemes);
		return { operation, codeSamples };
	});

	return { spec, dossiers };
}
