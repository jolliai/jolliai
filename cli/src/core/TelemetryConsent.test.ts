import { describe, expect, it } from "vitest";
import {
	type ConsentInput,
	isTelemetryEnabled,
	resolveTelemetryConsent,
	shouldShowTelemetryNotice,
} from "./TelemetryConsent.js";

const input = (over: Partial<ConsentInput> = {}): ConsentInput => ({
	config: {},
	env: {},
	...over,
});

describe("resolveTelemetryConsent", () => {
	it("is on by default (empty config, no signals)", () => {
		expect(resolveTelemetryConsent(input())).toEqual({ enabled: true, reason: "on" });
	});

	it("DO_NOT_TRACK opts out for any truthy value but not '0'/empty", () => {
		expect(resolveTelemetryConsent(input({ env: { DO_NOT_TRACK: "1" } })).reason).toBe("do-not-track");
		expect(resolveTelemetryConsent(input({ env: { DO_NOT_TRACK: "true" } })).enabled).toBe(false);
		expect(resolveTelemetryConsent(input({ env: { DO_NOT_TRACK: " 1 " } })).enabled).toBe(false);
		expect(resolveTelemetryConsent(input({ env: { DO_NOT_TRACK: "0" } })).enabled).toBe(true);
		expect(resolveTelemetryConsent(input({ env: { DO_NOT_TRACK: "" } })).enabled).toBe(true);
	});

	it("honors a host-platform opt-out (VS Code isTelemetryEnabled=false)", () => {
		expect(resolveTelemetryConsent(input({ platformDisabled: true }))).toEqual({
			enabled: false,
			reason: "platform-off",
		});
		expect(resolveTelemetryConsent(input({ platformDisabled: false })).enabled).toBe(true);
	});

	it("honors config telemetry:'off'", () => {
		expect(resolveTelemetryConsent(input({ config: { telemetry: "off" } }))).toEqual({
			enabled: false,
			reason: "config-off",
		});
		expect(resolveTelemetryConsent(input({ config: { telemetry: "on" } })).enabled).toBe(true);
	});

	it("DO_NOT_TRACK wins over the config and platform signals (most authoritative)", () => {
		const result = resolveTelemetryConsent(
			input({ env: { DO_NOT_TRACK: "1" }, platformDisabled: true, config: { telemetry: "off" } }),
		);
		expect(result.reason).toBe("do-not-track");
	});

	it("platform opt-out wins over config-off", () => {
		const result = resolveTelemetryConsent(input({ platformDisabled: true, config: { telemetry: "off" } }));
		expect(result.reason).toBe("platform-off");
	});

	it("defaults env to process.env when omitted", () => {
		const saved = process.env.DO_NOT_TRACK;
		try {
			process.env.DO_NOT_TRACK = "1";
			expect(resolveTelemetryConsent({ config: {} }).enabled).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.DO_NOT_TRACK;
			else process.env.DO_NOT_TRACK = saved;
		}
	});
});

describe("isTelemetryEnabled", () => {
	it("mirrors resolveTelemetryConsent().enabled", () => {
		expect(isTelemetryEnabled(input())).toBe(true);
		expect(isTelemetryEnabled(input({ config: { telemetry: "off" } }))).toBe(false);
	});
});

describe("shouldShowTelemetryNotice", () => {
	it("shows once when enabled and not yet shown", () => {
		expect(shouldShowTelemetryNotice(input())).toBe(true);
	});

	it("does not show again once recorded", () => {
		expect(shouldShowTelemetryNotice(input({ config: { telemetryNoticeShown: true } }))).toBe(false);
	});

	it("does not show when telemetry is disabled", () => {
		expect(shouldShowTelemetryNotice(input({ config: { telemetry: "off" } }))).toBe(false);
		expect(shouldShowTelemetryNotice(input({ env: { DO_NOT_TRACK: "1" } }))).toBe(false);
	});
});
