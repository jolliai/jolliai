/**
 * Hand-rolled per-language code samples for an OpenAPI operation. Five
 * languages are emitted — cURL, JavaScript (fetch), TypeScript (fetch with
 * inline types), Python (requests), Go (net/http). Each sample is built at
 * generation time so it ends up in the static MDX output (SEO-indexed,
 * visible without JS).
 *
 * Each generator:
 * - Substitutes path parameters with `{name}` placeholders so the user
 *   sees the spec's variable names verbatim.
 * - Builds a request body from `requestBody.example` when present, else
 *   from a synthesised example off the schema (`exampleFromSchema`).
 * - Adds the first matching security scheme as a header / query placeholder.
 *
 * Why hand-rolled vs a library: openapi-snippet pulls in httpsnippet's full
 * transitive tree (har-validator, etc.) for relatively little gain over
 * five focused templates. Five languages × ~30 lines is small, testable,
 * and avoids a heavy install footprint.
 */

import { exampleFromSchema } from "./SchemaExample.js";
import type { OpenApiCodeSamples, OpenApiOperation, OpenApiParameter, OpenApiSecurityScheme } from "./Types.js";

export function generateCodeSamples(
	operation: OpenApiOperation,
	serverUrl: string,
	securitySchemes: Record<string, OpenApiSecurityScheme>,
): OpenApiCodeSamples {
	const ctx = buildSampleContext(operation, serverUrl, securitySchemes);
	return {
		curl: emitCurl(ctx),
		js: emitJs(ctx),
		ts: emitTs(ctx),
		python: emitPython(ctx),
		go: emitGo(ctx),
	};
}

/**
 * Pre-resolved bits every per-language generator needs. Built once so the
 * generators stay focused on string templating, not on logic.
 */
interface SampleContext {
	method: string;
	url: string;
	pathParams: OpenApiParameter[];
	queryParams: OpenApiParameter[];
	headerParams: OpenApiParameter[];
	authHeaders: Array<{ name: string; placeholder: string }>;
	authQuery: Array<{ name: string; placeholder: string }>;
	body?: unknown;
	hasBody: boolean;
	bodyContentType: string;
}

function buildSampleContext(
	operation: OpenApiOperation,
	serverUrl: string,
	securitySchemes: Record<string, OpenApiSecurityScheme>,
): SampleContext {
	const method = operation.method.toUpperCase();
	const cleanServer = serverUrl.replace(/\/$/, "");
	const url = `${cleanServer}${operation.path}`;

	const pathParams = operation.parameters.filter((p) => p.in === "path");
	const queryParams = operation.parameters.filter((p) => p.in === "query");
	const headerParams = operation.parameters.filter((p) => p.in === "header");

	const authHeaders: Array<{ name: string; placeholder: string }> = [];
	const authQuery: Array<{ name: string; placeholder: string }> = [];
	// `security[0]` is the first SecurityRequirement; its keys are AND-ed
	// together (per the spec — "Each name MUST correspond to a security
	// scheme... The list of values includes alternative security requirement
	// objects that can be used. Only one of the security requirement objects
	// need to be satisfied to authorize a request"). So we take the first
	// requirement (one alternative the customer can choose) but emit ALL its
	// schemes — matching what an auth-requirements component would render.
	const security = operation.security?.[0];
	if (security) {
		for (const schemeName of Object.keys(security)) {
			const scheme = securitySchemes[schemeName];
			if (!scheme) {
				continue;
			}
			if (scheme.type === "http" && scheme.scheme === "bearer") {
				authHeaders.push({ name: "Authorization", placeholder: "Bearer YOUR_TOKEN" });
			} else if (scheme.type === "http" && scheme.scheme === "basic") {
				authHeaders.push({ name: "Authorization", placeholder: "Basic YOUR_CREDENTIALS_BASE64" });
			} else if (scheme.type === "apiKey" && scheme.name) {
				const placeholder = "YOUR_API_KEY";
				if (scheme.in === "header") {
					authHeaders.push({ name: scheme.name, placeholder });
				} else if (scheme.in === "query") {
					authQuery.push({ name: scheme.name, placeholder });
				}
			} else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
				authHeaders.push({ name: "Authorization", placeholder: "Bearer YOUR_ACCESS_TOKEN" });
			}
		}
	}

	const body = operation.requestBody?.example ?? exampleFromSchema(operation.requestBody?.schema);
	const hasBody = operation.requestBody !== undefined;
	const bodyContentType = operation.requestBody?.contentType ?? "application/json";

	return {
		method,
		url,
		pathParams,
		queryParams,
		headerParams,
		authHeaders,
		authQuery,
		body,
		hasBody,
		bodyContentType,
	};
}

function buildQueryString(ctx: SampleContext): string {
	const parts: string[] = [];
	for (const q of ctx.queryParams) {
		parts.push(`${q.name}=<${q.name}>`);
	}
	for (const q of ctx.authQuery) {
		parts.push(`${q.name}=${q.placeholder}`);
	}
	return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function emitCurl(ctx: SampleContext): string {
	const escapedUrl = `${ctx.url}${buildQueryString(ctx)}`.replace(/'/g, "'\\''");
	const lines: string[] = [`curl -X ${ctx.method} '${escapedUrl}'`];
	for (const h of ctx.headerParams) {
		lines.push(`  -H '${h.name}: <${h.name}>'`);
	}
	for (const h of ctx.authHeaders) {
		lines.push(`  -H '${h.name}: ${h.placeholder}'`);
	}
	if (ctx.hasBody) {
		lines.push(`  -H 'Content-Type: ${ctx.bodyContentType}'`);
		const bodyJson = JSON.stringify(ctx.body ?? {}, null, 2);
		lines.push(`  -d '${bodyJson.replace(/'/g, "'\\''")}'`);
	}
	return lines.join(" \\\n");
}

function emitJs(ctx: SampleContext): string {
	const headers: string[] = [];
	if (ctx.hasBody) {
		headers.push(`  'Content-Type': '${ctx.bodyContentType}'`);
	}
	for (const h of ctx.headerParams) {
		headers.push(`  '${h.name}': '<${h.name}>'`);
	}
	for (const h of ctx.authHeaders) {
		headers.push(`  '${h.name}': '${h.placeholder}'`);
	}
	const headerBlock = headers.length === 0 ? "" : `,\n  headers: {\n  ${headers.join(",\n  ")}\n  }`;
	const bodyBlock = ctx.hasBody ? `,\n  body: JSON.stringify(${JSON.stringify(ctx.body ?? {}, null, 2)})` : "";
	return `const response = await fetch('${ctx.url}${buildQueryString(ctx)}', {
  method: '${ctx.method}'${headerBlock}${bodyBlock}
});

const data = await response.json();
console.log(data);`;
}

function emitTs(ctx: SampleContext): string {
	const headers: string[] = [];
	if (ctx.hasBody) {
		headers.push(`  'Content-Type': '${ctx.bodyContentType}'`);
	}
	for (const h of ctx.headerParams) {
		headers.push(`  '${h.name}': '<${h.name}>'`);
	}
	for (const h of ctx.authHeaders) {
		headers.push(`  '${h.name}': '${h.placeholder}'`);
	}
	const headerBlock = headers.length === 0 ? "" : `,\n  headers: {\n  ${headers.join(",\n  ")}\n  }`;
	const bodyBlock = ctx.hasBody ? `,\n  body: JSON.stringify(${JSON.stringify(ctx.body ?? {}, null, 2)})` : "";
	return `interface ApiResponse {
  // shape your response here
}

const response: Response = await fetch('${ctx.url}${buildQueryString(ctx)}', {
  method: '${ctx.method}'${headerBlock}${bodyBlock}
});

const data = (await response.json()) as ApiResponse;
console.log(data);`;
}

/**
 * Recursively serialise an example value into Python literal syntax.
 * Replaces an earlier approach of post-processing `JSON.stringify` output
 * via regex (which corrupted string values containing the literal phrases
 * `true`, `false`, or `null`). Strings reuse JSON's quoting since Python
 * accepts double-quoted strings with the same escape sequences.
 */
export function toPythonLiteral(value: unknown, indent = 0): string {
	const pad = "    ".repeat(indent);
	const padNext = "    ".repeat(indent + 1);
	if (value === null || value === undefined) {
		return "None";
	}
	if (value === true) {
		return "True";
	}
	if (value === false) {
		return "False";
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : "None";
	}
	if (typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return "[]";
		}
		const items = value.map((v) => `${padNext}${toPythonLiteral(v, indent + 1)}`).join(",\n");
		return `[\n${items}\n${pad}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			return "{}";
		}
		const items = entries
			.map(([k, v]) => `${padNext}${JSON.stringify(k)}: ${toPythonLiteral(v, indent + 1)}`)
			.join(",\n");
		return `{\n${items}\n${pad}}`;
	}
	return JSON.stringify(value);
}

function emitPython(ctx: SampleContext): string {
	const lines: string[] = ["import requests", "", `url = "${ctx.url}"`];
	if (ctx.queryParams.length > 0 || ctx.authQuery.length > 0) {
		const params: string[] = [];
		for (const q of ctx.queryParams) {
			params.push(`    "${q.name}": "<${q.name}>"`);
		}
		for (const q of ctx.authQuery) {
			params.push(`    "${q.name}": "${q.placeholder}"`);
		}
		lines.push("params = {", params.join(",\n"), "}");
	}
	const headers: string[] = [];
	if (ctx.hasBody) {
		headers.push(`    "Content-Type": "${ctx.bodyContentType}"`);
	}
	for (const h of ctx.headerParams) {
		headers.push(`    "${h.name}": "<${h.name}>"`);
	}
	for (const h of ctx.authHeaders) {
		headers.push(`    "${h.name}": "${h.placeholder}"`);
	}
	if (headers.length > 0) {
		lines.push("headers = {", headers.join(",\n"), "}");
	}
	if (ctx.hasBody) {
		lines.push(`payload = ${toPythonLiteral(ctx.body ?? {})}`);
	}
	const callArgs: string[] = [`"${ctx.method.toLowerCase()}"`, "url"];
	if (ctx.queryParams.length > 0 || ctx.authQuery.length > 0) {
		callArgs.push("params=params");
	}
	if (headers.length > 0) {
		callArgs.push("headers=headers");
	}
	if (ctx.hasBody) {
		callArgs.push("json=payload");
	}
	lines.push("", `response = requests.request(${callArgs.join(", ")})`);
	lines.push("print(response.json())");
	return lines.join("\n");
}

/**
 * Encode a JSON string as a Go string literal. Defaults to a raw string
 * for readability; falls back to a quoted/escaped interpreted string when
 * the payload contains a backtick (Go raw strings cannot contain
 * backticks and have no escape mechanism — concatenating fragments works
 * but is gnarlier to read than just escaping).
 */
export function goStringLiteral(jsonStr: string): string {
	if (!jsonStr.includes("`")) {
		return `\`${jsonStr}\``;
	}
	const escaped = jsonStr
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	return `"${escaped}"`;
}

function emitGo(ctx: SampleContext): string {
	const headerLines: string[] = [];
	if (ctx.hasBody) {
		headerLines.push(`	req.Header.Set("Content-Type", "${ctx.bodyContentType}")`);
	}
	for (const h of ctx.headerParams) {
		headerLines.push(`	req.Header.Set("${h.name}", "<${h.name}>")`);
	}
	for (const h of ctx.authHeaders) {
		headerLines.push(`	req.Header.Set("${h.name}", "${h.placeholder}")`);
	}
	const bodyVar = ctx.hasBody
		? `\tbody := strings.NewReader(${goStringLiteral(JSON.stringify(ctx.body ?? {}, null, 2))})\n`
		: "";
	const bodyArg = ctx.hasBody ? "body" : "nil";
	const stringsImport = ctx.hasBody ? '	"strings"\n' : "";
	return `package main

import (
	"fmt"
	"io"
	"net/http"
${stringsImport})

func main() {
${bodyVar}	req, err := http.NewRequest("${ctx.method}", "${ctx.url}${buildQueryString(ctx)}", ${bodyArg})
	if err != nil {
		panic(err)
	}
${headerLines.join("\n")}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()

	out, _ := io.ReadAll(resp.Body)
	fmt.Println(string(out))
}`;
}
