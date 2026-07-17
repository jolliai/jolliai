import { describe, expect, it } from "vitest";
import { isPlatformToolsEnabled, PLATFORM_TOOLS_ENV_FLAG } from "./PlatformTools.js";

describe("isPlatformToolsEnabled", () => {
	it("is true when the config flag is explicitly true", () => {
		expect(isPlatformToolsEnabled({ mcpPlatformToolsEnabled: true }, {})).toBe(true);
	});

	it("is true when both the config flag and env flag are absent (on by default)", () => {
		expect(isPlatformToolsEnabled({}, {})).toBe(true);
	});

	it("is true when the env flag is exactly '1', even when config opts out", () => {
		expect(isPlatformToolsEnabled({}, { [PLATFORM_TOOLS_ENV_FLAG]: "1" })).toBe(true);
		// The env escape hatch force-enables even over an explicit `false`.
		expect(isPlatformToolsEnabled({ mcpPlatformToolsEnabled: false }, { [PLATFORM_TOOLS_ENV_FLAG]: "1" })).toBe(
			true,
		);
	});

	it("is false only when the config flag is explicitly false and the env flag is unset", () => {
		expect(isPlatformToolsEnabled({ mcpPlatformToolsEnabled: false }, {})).toBe(false);
	});

	it("does not treat a truthy-but-non-'1' env value as enabling when config opts out (strict === '1')", () => {
		expect(isPlatformToolsEnabled({ mcpPlatformToolsEnabled: false }, { [PLATFORM_TOOLS_ENV_FLAG]: "true" })).toBe(
			false,
		);
		expect(isPlatformToolsEnabled({ mcpPlatformToolsEnabled: false }, { [PLATFORM_TOOLS_ENV_FLAG]: "0" })).toBe(
			false,
		);
		expect(isPlatformToolsEnabled({ mcpPlatformToolsEnabled: false }, { [PLATFORM_TOOLS_ENV_FLAG]: "" })).toBe(
			false,
		);
	});
});
