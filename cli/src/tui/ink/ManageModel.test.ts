import { describe, expect, it } from "vitest";
import type { StatusInfo } from "../../Types.js";
import { buildSourceRows } from "./ManageModel.js";

const status = (over: Partial<StatusInfo> = {}): StatusInfo => ({ enabled: true, ...over }) as StatusInfo;
const rowOn = (rows: ReturnType<typeof buildSourceRows>, host: string): boolean =>
	rows.find((r) => r.host === host)?.on ?? false;

describe("buildSourceRows", () => {
	it("marks a source on when detected and not explicitly disabled", () => {
		const rows = buildSourceRows(status({ claudeDetected: true, codexDetected: true, codexEnabled: false }));
		expect(rowOn(rows, "claude")).toBe(true); // detected, enabled by default
		expect(rowOn(rows, "codex")).toBe(false); // detected but disabled
		expect(rowOn(rows, "gemini")).toBe(false); // not detected
	});

	it("marks Claude off when installed but explicitly disabled (claudeEnabled: false)", () => {
		// Regression: the row must honor claudeEnabled, not just the filesystem
		// detector — otherwise a disabled-but-installed Claude reads as on.
		const rows = buildSourceRows(status({ claudeDetected: true, claudeEnabled: false }));
		expect(rowOn(rows, "claude")).toBe(false);
	});

	it("keeps Claude on when installed and not disabled (claudeEnabled undefined)", () => {
		const rows = buildSourceRows(status({ claudeDetected: true }));
		expect(rowOn(rows, "claude")).toBe(true);
	});
});
