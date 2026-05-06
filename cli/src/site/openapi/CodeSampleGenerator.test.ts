/**
 * Tests for CodeSampleGenerator.
 *
 * Ported from JOLLI-1392's nextra-generator. Same coverage: Python literal
 * encoding, Go string-literal escaping, end-to-end sample emission with
 * tricky content (strings containing `true`/`false`/`null`, payloads with
 * backticks). New helper-targeted tests added for query-string + auth
 * scheme branches that the original suite covered indirectly.
 */

import { describe, expect, it } from "vitest";
import { generateCodeSamples, goStringLiteral, toPythonLiteral } from "./CodeSampleGenerator.js";
import type { OpenApiOperation, OpenApiSecurityScheme } from "./Types.js";

function makeOp(overrides: Partial<OpenApiOperation> = {}): OpenApiOperation {
	return {
		method: "post",
		path: "/things",
		operationId: "createThing",
		tag: "things",
		summary: "",
		description: "",
		deprecated: false,
		parameters: [],
		responses: [],
		security: [],
		...overrides,
	} as OpenApiOperation;
}

const NO_SCHEMES: Record<string, OpenApiSecurityScheme> = {};

// ─── toPythonLiteral ─────────────────────────────────────────────────────────

describe("toPythonLiteral", () => {
	it("emits Python primitive constants for true/false/null/undefined", () => {
		expect(toPythonLiteral(true)).toBe("True");
		expect(toPythonLiteral(false)).toBe("False");
		expect(toPythonLiteral(null)).toBe("None");
		expect(toPythonLiteral(undefined)).toBe("None");
	});

	it("emits numbers verbatim and falls back to None for non-finite", () => {
		expect(toPythonLiteral(42)).toBe("42");
		expect(toPythonLiteral(3.14)).toBe("3.14");
		expect(toPythonLiteral(Number.NaN)).toBe("None");
		expect(toPythonLiteral(Number.POSITIVE_INFINITY)).toBe("None");
	});

	it("does NOT rewrite the words true/false/null when they appear inside strings", () => {
		const out = toPythonLiteral({ note: "this is true", flag: true, blank: null });
		expect(out).toContain('"note": "this is true"');
		expect(out).toContain('"flag": True');
		expect(out).toContain('"blank": None');
	});

	it("emits an empty list / dict literal compactly", () => {
		expect(toPythonLiteral([])).toBe("[]");
		expect(toPythonLiteral({})).toBe("{}");
	});

	it("formats nested objects with 4-space indents (PEP 8 friendly)", () => {
		const out = toPythonLiteral({ a: { b: 1 } });
		expect(out).toBe('{\n    "a": {\n        "b": 1\n    }\n}');
	});

	it("formats nested arrays with 4-space indents", () => {
		expect(toPythonLiteral([1, 2])).toBe("[\n    1,\n    2\n]");
	});

	it("escapes string special characters via JSON.stringify", () => {
		expect(toPythonLiteral('quote "inside"')).toBe('"quote \\"inside\\""');
	});
});

// ─── goStringLiteral ─────────────────────────────────────────────────────────

describe("goStringLiteral", () => {
	it("uses a raw string when the payload has no backticks", () => {
		expect(goStringLiteral('{"a":1}')).toBe('`{"a":1}`');
	});

	it("falls back to an escaped interpreted string when the payload contains a backtick", () => {
		const out = goStringLiteral('{"snippet": "use `npm` here"}');
		expect(out.startsWith('"')).toBe(true);
		expect(out.endsWith('"')).toBe(true);
		expect(out).toContain('\\"snippet\\"');
		expect(out).toContain("`npm`");
	});

	it("escapes backslashes and quotes in the interpreted-string fallback", () => {
		const out = goStringLiteral('a"b\\c`d');
		expect(out).toBe('"a\\"b\\\\c`d"');
	});

	it("preserves newlines as escape sequences in the fallback", () => {
		const out = goStringLiteral("line1\nline2`");
		expect(out).toContain("\\n");
		expect(out.includes("\n")).toBe(false);
	});

	it("preserves tabs and CRs as escape sequences in the fallback", () => {
		const out = goStringLiteral("a\tb\rc`");
		expect(out).toContain("\\t");
		expect(out).toContain("\\r");
	});
});

// ─── generateCodeSamples — body handling ─────────────────────────────────────

describe("generateCodeSamples — body handling", () => {
	it("emits a Python sample with True/False/None even when the example has those words in strings", () => {
		const op = makeOp({
			method: "post",
			path: "/feedback",
			requestBody: {
				required: true,
				contentType: "application/json",
				example: { note: "this is true", optedIn: true, dismissedAt: null },
			},
		});
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.python).toContain('"note": "this is true"');
		expect(samples.python).toContain('"optedIn": True');
		expect(samples.python).toContain('"dismissedAt": None');
		expect(samples.python).not.toContain('"this is True"');
	});

	it("emits a Go sample using a raw string when the body has no backticks", () => {
		const op = makeOp({
			requestBody: { required: true, contentType: "application/json", example: { name: "alice" } },
		});
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.go).toMatch(/strings\.NewReader\(`/);
	});

	it("emits a Go sample using an interpreted string when the body contains a backtick", () => {
		const op = makeOp({
			requestBody: {
				required: true,
				contentType: "application/json",
				example: { snippet: "use `npm install`" },
			},
		});
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.go).not.toMatch(/strings\.NewReader\(`/);
		expect(samples.go).toMatch(/strings\.NewReader\("/);
	});

	it("synthesises a body from schema when the spec has no explicit example", () => {
		const op = makeOp({
			requestBody: {
				required: true,
				contentType: "application/json",
				schema: { type: "object", properties: { name: { type: "string" } } },
			},
		});
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.curl).toContain('"name": "string"');
	});

	it("trims a trailing slash from the server URL so the path joins cleanly", () => {
		const op = makeOp({ method: "get", path: "/widgets" });
		const samples = generateCodeSamples(op, "https://api.example.com/", NO_SCHEMES);
		expect(samples.curl).toContain("https://api.example.com/widgets");
		expect(samples.curl).not.toContain("//widgets");
	});
});

// ─── generateCodeSamples — parameters & auth ─────────────────────────────────

describe("generateCodeSamples — parameters and auth", () => {
	it("renders query parameters as <placeholder> tokens in every language's URL", () => {
		const op = makeOp({
			method: "get",
			path: "/items",
			parameters: [{ name: "limit", in: "query", required: false }],
		});
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.curl).toContain("limit=<limit>");
		expect(samples.js).toContain("limit=<limit>");
		expect(samples.python).toContain('"limit": "<limit>"');
		expect(samples.go).toContain("limit=<limit>");
	});

	it("renders header parameters as `-H` lines / fetch headers / requests dicts", () => {
		const op = makeOp({
			method: "get",
			path: "/items",
			parameters: [{ name: "X-Trace-Id", in: "header", required: false }],
		});
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.curl).toContain("-H 'X-Trace-Id: <X-Trace-Id>'");
		expect(samples.js).toContain("'X-Trace-Id': '<X-Trace-Id>'");
		expect(samples.python).toContain('"X-Trace-Id": "<X-Trace-Id>"');
		expect(samples.go).toContain('req.Header.Set("X-Trace-Id", "<X-Trace-Id>")');
	});

	it("emits a Bearer Authorization header for `http+bearer` security", () => {
		const op = makeOp({
			method: "get",
			path: "/me",
			security: [{ bearerAuth: [] }],
		});
		const samples = generateCodeSamples(op, "https://api.example.com", {
			bearerAuth: { type: "http", scheme: "bearer" },
		});
		expect(samples.curl).toContain("Authorization: Bearer YOUR_TOKEN");
	});

	it("emits a Basic Authorization header for `http+basic` security", () => {
		const op = makeOp({ method: "get", path: "/me", security: [{ basicAuth: [] }] });
		const samples = generateCodeSamples(op, "https://api.example.com", {
			basicAuth: { type: "http", scheme: "basic" },
		});
		expect(samples.curl).toContain("Authorization: Basic YOUR_CREDENTIALS_BASE64");
	});

	it("emits an apiKey header when the scheme's `in` is `header`", () => {
		const op = makeOp({ method: "get", path: "/me", security: [{ apiKey: [] }] });
		const samples = generateCodeSamples(op, "https://api.example.com", {
			apiKey: { type: "apiKey", name: "X-API-Key", in: "header" },
		});
		expect(samples.curl).toContain("X-API-Key: YOUR_API_KEY");
	});

	it("emits an apiKey query param when the scheme's `in` is `query`", () => {
		const op = makeOp({ method: "get", path: "/me", security: [{ apiKey: [] }] });
		const samples = generateCodeSamples(op, "https://api.example.com", {
			apiKey: { type: "apiKey", name: "api_key", in: "query" },
		});
		expect(samples.curl).toContain("api_key=YOUR_API_KEY");
	});

	it("emits a Bearer Authorization header for oauth2 / openIdConnect security", () => {
		const oauthOp = makeOp({ method: "get", path: "/me", security: [{ oauth2: ["read"] }] });
		const oauthSamples = generateCodeSamples(oauthOp, "https://api.example.com", {
			oauth2: { type: "oauth2" },
		});
		expect(oauthSamples.curl).toContain("Bearer YOUR_ACCESS_TOKEN");

		const oidcOp = makeOp({ method: "get", path: "/me", security: [{ oidc: [] }] });
		const oidcSamples = generateCodeSamples(oidcOp, "https://api.example.com", {
			oidc: { type: "openIdConnect" },
		});
		expect(oidcSamples.curl).toContain("Bearer YOUR_ACCESS_TOKEN");
	});

	it("silently drops auth schemes that aren't in the securitySchemes map", () => {
		const op = makeOp({ method: "get", path: "/me", security: [{ ghost: [] }] });
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.curl).not.toContain("Authorization");
	});
});

// ─── generateCodeSamples — emit sanity ───────────────────────────────────────

describe("generateCodeSamples — emit sanity", () => {
	it("never embeds a trailing backslash on the last cURL line", () => {
		const op = makeOp({ method: "get", path: "/items" });
		const samples = generateCodeSamples(op, "https://api.example.com", NO_SCHEMES);
		expect(samples.curl.trimEnd().endsWith("\\")).toBe(false);
	});

	it("emits a Go sample with `strings` import only when there's a body", () => {
		const noBody = generateCodeSamples(
			makeOp({ method: "get", path: "/x" }),
			"https://api.example.com",
			NO_SCHEMES,
		);
		expect(noBody.go).not.toContain('"strings"');

		const withBody = generateCodeSamples(
			makeOp({ requestBody: { required: true, contentType: "application/json", example: {} } }),
			"https://api.example.com",
			NO_SCHEMES,
		);
		expect(withBody.go).toContain('"strings"');
	});
});
