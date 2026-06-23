import { describe, expect, it } from "vitest";
import {
	isTelemetryEventName,
	TELEMETRY_EVENT_NAME_PATTERN,
	TELEMETRY_EVENTS,
	type TelemetryEventName,
} from "./TelemetryEvents.js";

describe("TelemetryEvents", () => {
	it("registers at least the v1 catalog and every name is documented", () => {
		const names = Object.keys(TELEMETRY_EVENTS);
		expect(names.length).toBeGreaterThanOrEqual(19);
		for (const [name, doc] of Object.entries(TELEMETRY_EVENTS)) {
			expect(doc, `${name} must have a one-line description`).toBeTruthy();
			expect(doc.trim()).toBe(doc);
		}
	});

	it("every name follows the object_action convention", () => {
		for (const name of Object.keys(TELEMETRY_EVENTS)) {
			expect(name, `${name} must match object_action`).toMatch(TELEMETRY_EVENT_NAME_PATTERN);
		}
	});

	it("the naming pattern rejects malformed names", () => {
		for (const bad of ["Recall", "recall", "recall_", "_recall", "recall__performed", "recall performed"]) {
			expect(bad).not.toMatch(TELEMETRY_EVENT_NAME_PATTERN);
		}
		for (const good of ["recall_performed", "signin_completed", "app_installed", "ai_source_detected"]) {
			expect(good).toMatch(TELEMETRY_EVENT_NAME_PATTERN);
		}
	});

	it("isTelemetryEventName accepts registered names and rejects everything else", () => {
		const known: TelemetryEventName = "recall_performed";
		expect(isTelemetryEventName(known)).toBe(true);
		expect(isTelemetryEventName("signin_completed")).toBe(true);
		expect(isTelemetryEventName("not_a_real_event")).toBe(false);
		expect(isTelemetryEventName("")).toBe(false);
		// Inherited Object members must not be mistaken for registered events.
		expect(isTelemetryEventName("toString")).toBe(false);
		expect(isTelemetryEventName("constructor")).toBe(false);
	});
});
