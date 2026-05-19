import { describe, expect, it } from "vitest";
import { withPlatform } from "./withPlatform.js";

describe("withPlatform", () => {
	it("returns the sync result and restores process.platform", () => {
		const before = process.platform;
		const result = withPlatform("win32", () => {
			expect(process.platform).toBe("win32");
			return 42;
		});
		expect(result).toBe(42);
		expect(process.platform).toBe(before);
	});

	it("restores process.platform when sync fn throws", () => {
		const before = process.platform;
		expect(() =>
			withPlatform("darwin", () => {
				expect(process.platform).toBe("darwin");
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(process.platform).toBe(before);
	});

	it("awaits async fn and restores process.platform after it resolves", async () => {
		const before = process.platform;
		const result = await withPlatform("linux", async () => {
			expect(process.platform).toBe("linux");
			return "ok";
		});
		expect(result).toBe("ok");
		expect(process.platform).toBe(before);
	});

	it("restores process.platform when async fn rejects", async () => {
		const before = process.platform;
		await expect(
			withPlatform("win32", async () => {
				expect(process.platform).toBe("win32");
				throw new Error("async boom");
			}),
		).rejects.toThrow("async boom");
		expect(process.platform).toBe(before);
	});
});
