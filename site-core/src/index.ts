/**
 * @jolli.ai/site-core — framework-agnostic core for Jolli documentation
 * site generation.
 *
 * This package will host the pure-logic portion of the site pipeline:
 * navigation parsing, content planning, the OpenAPI IR, and the Nextra
 * emitter. File I/O and subprocess spawning stay in the consumer (CLI
 * or web tool).
 *
 * Phase 0 placeholder — real exports land in subsequent phases as files
 * migrate from `cli/src/site/`.
 */

/** Current package version. Bumped per release; read by consumers for diagnostics. */
export const VERSION = "0.0.0";
