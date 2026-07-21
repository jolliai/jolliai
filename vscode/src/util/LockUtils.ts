/**
 * LockUtils.ts — Shared lock file utilities for the JolliMemory VSCode extension.
 *
 * The implementation now lives in the CLI core (`cli/src/core/LiveStatus.ts`) so
 * the Jolli TUI and this extension share one copy. The extension bundles
 * `cli/src/**` at build time, so this re-export resolves at esbuild time (same
 * pattern as the other cross-package imports). `isWorkerBusy` remains the sole
 * gate for Commit / Squash; `readIngestPhase` drives the cosmetic sidebar pill.
 */

export { type IngestPhaseLabel, isWorkerBusy, readIngestPhase } from "../../../cli/src/core/LiveStatus.js";
