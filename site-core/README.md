# @jolli.ai/site-core

Framework-agnostic core for Jolli documentation site generation. Hosts the pure-logic portion of the site pipeline — navigation parsing, content planning, the OpenAPI IR, and the Nextra emitter — so the CLI (`@jolli.ai/cli`) and the Jolli web tool can share one implementation.

This package contains **no file I/O and no subprocess spawning**. The consumer (CLI or web tool) provides those at the edge. Biome `noRestrictedImports` enforces this at lint time: `node:fs`, `node:fs/promises`, and `node:child_process` are forbidden in `src/**`.

## Status

Phase 0 — workspace bootstrap. Source files migrate from `cli/src/site/` in subsequent phases; the package currently exports only a `VERSION` constant.

## License

Apache-2.0
