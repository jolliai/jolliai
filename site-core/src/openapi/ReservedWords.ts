/**
 * Reserved-words utility for safe slug generation.
 *
 * Detects JavaScript reserved words, TypeScript keywords, and a small set of
 * problematic identifiers that would break Nextra (or any framework that
 * compiles MDX paths into JS modules) when used verbatim as slugs.
 */

const JS_RESERVED = new Set([
	// Keywords
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"null",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	// Strict-mode reserved words
	"arguments",
	"eval",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"await",
	"enum",
]);

const TS_KEYWORDS = new Set([
	"abstract",
	"any",
	"as",
	"asserts",
	"async",
	"bigint",
	"boolean",
	"declare",
	"get",
	"infer",
	"is",
	"keyof",
	"module",
	"namespace",
	"never",
	"number",
	"object",
	"override",
	"readonly",
	"require",
	"set",
	"string",
	"symbol",
	"type",
	"undefined",
	"unique",
	"unknown",
]);

const PROBLEMATIC = new Set([
	"__proto__",
	"prototype",
	"constructor",
	// Nextra reserves `index` for the home page; using it as a slug clobbers
	// the root route.
	"index",
]);

/**
 * Returns `true` if `slug` is a reserved word or a known problematic
 * identifier and therefore needs sanitisation before use as a route slug.
 *
 * @param slug - The slug to check (lowercase recommended).
 */
export function isReservedSlug(slug: string): boolean {
	return JS_RESERVED.has(slug) || TS_KEYWORDS.has(slug) || PROBLEMATIC.has(slug);
}
