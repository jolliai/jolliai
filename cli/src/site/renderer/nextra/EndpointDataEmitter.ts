/**
 * Emits the per-operation JSON sidecar imported by the endpoint MDX shim.
 *
 * Captures everything `<Endpoint>` reads to render the left column plus the
 * props `<TryIt>` needs to construct a request — but **not** the per-language
 * code samples or response examples. Those stay as MDX-fenced code blocks in
 * the shim so Nextra's MDX → Shiki pipeline can highlight them.
 *
 * Why a JSON file rather than inlining onto the MDX as a JS literal: Next.js
 * compiles every MDX page in the content tree, and large JS literals inside
 * MDX dramatically inflate per-page compile cost. JSON sidecars are read once
 * at static-render time and don't enter the JSX tree, so the MDX itself stays
 * small and the build scales much better with operation count.
 */

import { exampleFromSchema } from "../../openapi/SchemaExample.js";
import type { OpenApiOperation, OpenApiParameterLocation, ParsedSpec } from "../../openapi/Types.js";
import { endpointDataPath } from "./Paths.js";
import type { TemplateFile } from "./Types.js";

// ─── Types matching the JSON shape the <Endpoint> component reads ────────────

interface OperationParameter {
	name: string;
	required: boolean;
	description?: string;
	schema?: unknown;
}

interface OperationResponse {
	status: string;
	description?: string;
	contentType?: string;
	schema?: unknown;
}

interface AuthScheme {
	name: string;
	scheme: { type: string; scheme?: string; in?: string; name?: string; description?: string };
	scopes: string[];
}

interface OperationData {
	specName: string;
	operationId: string;
	method: string;
	path: string;
	title: string;
	tags: string[];
	deprecated: boolean;
	servers: ParsedSpec["servers"];
	tryItParameters: Array<{ name: string; in: OpenApiParameterLocation; required: boolean; description?: string }>;
	parameters: {
		path: OperationParameter[];
		query: OperationParameter[];
		header: OperationParameter[];
		cookie: OperationParameter[];
	};
	authSchemes: AuthScheme[];
	tryItAuthSchemes: Array<{ name: string; scheme: AuthScheme["scheme"] }>;
	requestBody?: { contentType: string; required: boolean; schema?: unknown; example?: unknown };
	responses: OperationResponse[];
}

// ─── Public emitter ──────────────────────────────────────────────────────────

export function emitEndpointData(specName: string, operation: OpenApiOperation, parsed: ParsedSpec): TemplateFile {
	const data = buildOperationData(specName, operation, parsed);
	return {
		path: endpointDataPath(specName, operation),
		content: `${JSON.stringify(data, null, 2)}\n`,
	};
}

function buildOperationData(specName: string, operation: OpenApiOperation, parsed: ParsedSpec): OperationData {
	const title = operation.summary || `${operation.method.toUpperCase()} ${operation.path}`;
	const tags = operation.tag === "default" ? [] : [operation.tag];
	const authSchemes = resolveAuthSchemes(operation, parsed);
	const tryItAuthSchemes = authSchemes.map((a) => ({ name: a.name, scheme: a.scheme }));
	const tryItParameters = operation.parameters.map((p) => {
		const entry: OperationData["tryItParameters"][number] = {
			name: p.name,
			in: p.in,
			required: p.required,
		};
		if (p.description !== undefined) {
			entry.description = p.description;
		}
		return entry;
	});
	const parameters = groupParametersByLocation(operation);
	const responses = operation.responses.map<OperationResponse>((r) => {
		const entry: OperationResponse = { status: r.status };
		if (r.description !== undefined) {
			entry.description = r.description;
		}
		if (r.contentType !== undefined) {
			entry.contentType = r.contentType;
		}
		if (r.schema !== undefined) {
			entry.schema = r.schema;
		}
		return entry;
	});

	const data: OperationData = {
		specName,
		operationId: operation.operationId,
		method: operation.method,
		path: operation.path,
		title,
		tags,
		deprecated: operation.deprecated,
		servers: operation.servers ?? parsed.servers,
		tryItParameters,
		parameters,
		authSchemes,
		tryItAuthSchemes,
		responses,
	};

	if (operation.requestBody) {
		// Pre-fill payload for the Try It textarea: prefer the spec's literal
		// example, otherwise synthesize one from the schema. Either way the
		// user lands on a sendable body instead of an empty textarea.
		const example =
			operation.requestBody.example !== undefined
				? operation.requestBody.example
				: exampleFromSchema(operation.requestBody.schema);
		const body: NonNullable<OperationData["requestBody"]> = {
			contentType: operation.requestBody.contentType,
			required: operation.requestBody.required,
		};
		if (operation.requestBody.schema !== undefined) {
			body.schema = operation.requestBody.schema;
		}
		if (example !== undefined) {
			body.example = example;
		}
		data.requestBody = body;
	}

	return data;
}

/**
 * Resolves the operation's `security` requirements into a flat list with the
 * actual scheme definitions inlined — so `<AuthRequirements>` and `<TryIt>`
 * don't need to look anything up at render time.
 */
function resolveAuthSchemes(operation: OpenApiOperation, parsed: ParsedSpec): AuthScheme[] {
	const out: AuthScheme[] = [];
	const seen = new Set<string>();
	for (const requirement of operation.security) {
		for (const [name, scopes] of Object.entries(requirement)) {
			if (seen.has(name)) {
				continue;
			}
			const scheme = parsed.securitySchemes[name];
			if (!scheme) {
				continue;
			}
			seen.add(name);
			const cleanScheme: AuthScheme["scheme"] = { type: scheme.type };
			if (scheme.scheme) {
				cleanScheme.scheme = scheme.scheme;
			}
			if (scheme.in) {
				cleanScheme.in = scheme.in;
			}
			if (scheme.name) {
				cleanScheme.name = scheme.name;
			}
			if (scheme.description) {
				cleanScheme.description = scheme.description;
			}
			out.push({ name, scheme: cleanScheme, scopes: Array.isArray(scopes) ? scopes : [] });
		}
	}
	return out;
}

function groupParametersByLocation(operation: OpenApiOperation): OperationData["parameters"] {
	const out: OperationData["parameters"] = { path: [], query: [], header: [], cookie: [] };
	const locations: OpenApiParameterLocation[] = ["path", "query", "header", "cookie"];
	for (const p of operation.parameters) {
		if (!locations.includes(p.in)) {
			continue;
		}
		const entry: OperationParameter = { name: p.name, required: p.required };
		if (p.description !== undefined) {
			entry.description = p.description;
		}
		if (p.schema !== undefined) {
			entry.schema = p.schema;
		}
		out[p.in].push(entry);
	}
	return out;
}
