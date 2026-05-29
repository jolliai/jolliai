/**
 * CustomScripts (pure half).
 *
 * Constants and a path-predicate for the `.jolli/scripts/` custom-script
 * escape-hatch (JOLLI-1505). The I/O half — discovery via `readdir` and
 * bundling via `copyFile` — lives in `cli/src/site/CustomScripts.ts`.
 *
 * Web-tool consumers use these constants to validate uploaded scripts or
 * to display the same limits the CLI enforces.
 */

/**
 * Jolli's reserved repo namespace (relative to the content root) — tool-owned:
 * custom scripts (`.jolli/scripts/`), Jolli Memory (`.jolli/jollimemory/`), etc.
 * Files here are never mirrored as documentation content or scanned as OpenAPI
 * specs, so a customer (or our own tooling) dropping a `.md`/`.yaml` under
 * `.jolli/` can't leak into their docs.
 */
export const JOLLI_RESERVED_DIR = ".jolli";

/** Source folder (content-root-relative) holding the custom scripts/styles. */
export const CUSTOM_SCRIPT_FOLDER = ".jolli/scripts";

/** Only these extensions are bundled and injected. */
export const CUSTOM_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".css"]);

/** Output location under the build's `public/` dir; Next.js serves it at `/scripts/`. */
export const CUSTOM_SCRIPT_PUBLIC_DIR = "scripts";

/** Per-file size cap — skip anything larger so a stray bundle can't bloat the build. */
export const MAX_CUSTOM_SCRIPT_BYTES = 64 * 1024;

/** Max custom-script files bundled per build (sorted, deterministic). */
export const MAX_CUSTOM_SCRIPT_FILES = 20;

/**
 * True when a content-root-relative (posix) path lives under the reserved
 * `.jolli/` namespace. Lookalike prefixes (`.jolligotcha/…`) are not reserved.
 */
export function isReservedJolliPath(relativePath: string): boolean {
	return relativePath === JOLLI_RESERVED_DIR || relativePath.startsWith(`${JOLLI_RESERVED_DIR}/`);
}
