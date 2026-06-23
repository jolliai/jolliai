#!/usr/bin/env node
/**
 * Writes the repo-root TELEMETRY.md from the telemetry event registry.
 * Run via `npm run gen:telemetry-doc`. The drift-guard test
 * (cli/src/core/TelemetryDoc.test.ts) fails CI if the committed file is stale.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTelemetryMarkdown } from "../src/core/TelemetryDoc.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = join(repoRoot, "TELEMETRY.md");
writeFileSync(target, generateTelemetryMarkdown(), "utf-8");
console.log(`Wrote ${target}`);
