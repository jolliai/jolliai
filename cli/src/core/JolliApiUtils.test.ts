import { describe, expect, it } from "vitest";
import { parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils";

describe("JolliApiUtils", () => {
	describe("parseBaseUrl", () => {
		it("should parse origin from simple URL", () => {
			const result = parseBaseUrl("https://jolli.app");
			expect(result.origin).toBe("https://jolli.app");
			expect(result.tenantSlug).toBeUndefined();
		});

		it("should extract tenant slug from path", () => {
			const result = parseBaseUrl("https://jolli-local.me/test1/");
			expect(result.origin).toBe("https://jolli-local.me");
			expect(result.tenantSlug).toBe("test1");
		});

		it("should handle URL without trailing slash", () => {
			const result = parseBaseUrl("https://jolli-local.me/tenant");
			expect(result.tenantSlug).toBe("tenant");
		});

		it("should handle URL with port", () => {
			const result = parseBaseUrl("https://localhost:8034/dev");
			expect(result.origin).toBe("https://localhost:8034");
			expect(result.tenantSlug).toBe("dev");
		});

		it("should handle URL with only root path", () => {
			const result = parseBaseUrl("https://jolli.app/");
			expect(result.tenantSlug).toBeUndefined();
		});
	});

	describe("parseJolliApiKey", () => {
		it("should return null for non-jolli key", () => {
			expect(parseJolliApiKey("sk-ant-12345")).toBeNull();
		});

		it("should return null for old format key without dot", () => {
			expect(parseJolliApiKey("sk-jol-abcdef1234567890abcdef1234567890")).toBeNull();
		});

		it("should parse valid new-format key", () => {
			const meta = { t: "tenant1", u: "https://tenant1.jolli.app" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const key = `sk-jol-${encoded}.randomsecretbytes`;
			const result = parseJolliApiKey(key);
			expect(result).toEqual({ t: "tenant1", u: "https://tenant1.jolli.app" });
		});

		it("should parse key with org slug", () => {
			const meta = { t: "tenant1", u: "https://tenant1.jolli.app", o: "engineering" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const key = `sk-jol-${encoded}.randomsecretbytes`;
			const result = parseJolliApiKey(key);
			expect(result).toEqual({ t: "tenant1", u: "https://tenant1.jolli.app", o: "engineering" });
		});

		it("should return null for invalid base64 in key", () => {
			expect(parseJolliApiKey("sk-jol-!!!invalid!!!.secret")).toBeNull();
		});

		it("should return null for valid base64 but missing required fields", () => {
			const meta = { x: "not t or u" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			expect(parseJolliApiKey(`sk-jol-${encoded}.secret`)).toBeNull();
		});

		it("should return null for empty key", () => {
			expect(parseJolliApiKey("")).toBeNull();
		});
	});
});
