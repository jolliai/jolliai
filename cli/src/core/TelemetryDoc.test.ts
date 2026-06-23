import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateTelemetryMarkdown } from "./TelemetryDoc.js";
import { TELEMETRY_EVENTS } from "./TelemetryEvents.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const docPath = join(repoRoot, "TELEMETRY.md");

describe("TelemetryDoc", () => {
	it("documents every registered event", () => {
		const md = generateTelemetryMarkdown();
		for (const name of Object.keys(TELEMETRY_EVENTS)) {
			expect(md, `TELEMETRY.md must list ${name}`).toContain(`\`${name}\``);
		}
	});

	it("covers the privacy contract (off switches + what is never collected)", () => {
		const md = generateTelemetryMarkdown();
		expect(md).toContain("DO_NOT_TRACK");
		expect(md).toContain("jolli telemetry off");
		expect(md).toContain("never collect");
		expect(md).toContain("installId");
	});

	it("the committed root TELEMETRY.md is up to date (run `npm run gen:telemetry-doc`)", () => {
		const onDisk = readFileSync(docPath, "utf-8");
		expect(onDisk).toBe(generateTelemetryMarkdown());
	});
});
