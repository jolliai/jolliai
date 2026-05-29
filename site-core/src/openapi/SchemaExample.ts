/**
 * Builds a minimal example object from an OpenAPI schema. Recurses into
 * `properties` for objects and `items` for arrays. Used as the default
 * request-body sample when the spec doesn't ship one explicitly — the same
 * synthesized payload is shown in code samples and pre-filled in the Try It
 * widget so the user has something concrete to send. Conservative — emits
 * `{}` / `[]` / primitive defaults rather than guessing semantically.
 *
 * Known intentional gaps (documented in tests so we don't quietly regress):
 *   - $ref pointers are not followed (no refs map argument)
 *   - oneOf / anyOf / allOf composition is not understood
 *   - `enum`, `default`, and `nullable` are ignored
 */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
	if (depth > 4 || !schema || typeof schema !== "object") {
		return;
	}
	const s = schema as Record<string, unknown>;
	if (s.example !== undefined) {
		return s.example;
	}
	const type = s.type;
	if (type === "object" || (s.properties && !type)) {
		const out: Record<string, unknown> = {};
		const props = (s.properties ?? {}) as Record<string, unknown>;
		for (const [k, v] of Object.entries(props)) {
			const child = exampleFromSchema(v, depth + 1);
			if (child !== undefined) {
				out[k] = child;
			}
		}
		return out;
	}
	if (type === "array") {
		const item = exampleFromSchema(s.items, depth + 1);
		return item === undefined ? [] : [item];
	}
	if (type === "string") {
		return typeof s.format === "string" && s.format === "date-time" ? "2024-01-01T00:00:00Z" : "string";
	}
	if (type === "integer" || type === "number") {
		return 0;
	}
	if (type === "boolean") {
		return false;
	}
	return;
}
