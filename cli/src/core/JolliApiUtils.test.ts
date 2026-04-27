import { describe, expect, it } from "vitest";
import { assertJolliOriginAllowed, parseBaseUrl, parseJolliApiKey } from "./JolliApiUtils";

describe("JolliApiUtils", () => {
	describe("parseBaseUrl", () => {
		it("should parse origin from simple URL", () => {
			const result = parseBaseUrl("https://jolli.dev");
			expect(result.origin).toBe("https://jolli.dev");
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
			const result = parseBaseUrl("https://jolli.dev/");
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
			const meta = { t: "tenant1", u: "https://tenant1.jolli.dev" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const key = `sk-jol-${encoded}.randomsecretbytes`;
			const result = parseJolliApiKey(key);
			expect(result).toEqual({ t: "tenant1", u: "https://tenant1.jolli.dev" });
		});

		it("should parse key with org slug", () => {
			const meta = { t: "tenant1", u: "https://tenant1.jolli.dev", o: "engineering" };
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			const key = `sk-jol-${encoded}.randomsecretbytes`;
			const result = parseJolliApiKey(key);
			expect(result).toEqual({ t: "tenant1", u: "https://tenant1.jolli.dev", o: "engineering" });
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

		it("should parse JWT-shape key (meta in segment 1)", () => {
			// sk-jol-<header>.<payload>.<sig> — the actual meta lives in the
			// middle segment, not the first.
			const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
			const payload = Buffer.from(
				JSON.stringify({ t: "tenant1", u: "https://tenant1.jolli.dev", o: "eng" }),
			).toString("base64url");
			const sig = "signatureBytesHere";
			const key = `sk-jol-${header}.${payload}.${sig}`;
			expect(parseJolliApiKey(key)).toEqual({
				t: "tenant1",
				u: "https://tenant1.jolli.dev",
				o: "eng",
			});
		});

		it("should return null when no JWT segment carries t/u fields", () => {
			const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
			const payload = Buffer.from(JSON.stringify({ sub: "someone", iat: 1 })).toString("base64url");
			const sig = "signatureBytesHere";
			expect(parseJolliApiKey(`sk-jol-${header}.${payload}.${sig}`)).toBeNull();
		});
	});

	describe("assertJolliOriginAllowed", () => {
		it("accepts https://app.jolli.ai", () => {
			expect(() => assertJolliOriginAllowed("https://app.jolli.ai")).not.toThrow();
		});

		it("accepts apex https://jolli.ai", () => {
			expect(() => assertJolliOriginAllowed("https://jolli.ai")).not.toThrow();
		});

		it("accepts https://tenant.jolli.dev", () => {
			expect(() => assertJolliOriginAllowed("https://tenant.jolli.dev")).not.toThrow();
		});

		it("accepts https://admin.jolli.cloud", () => {
			expect(() => assertJolliOriginAllowed("https://admin.jolli.cloud")).not.toThrow();
		});

		it("accepts apex https://jolli.cloud", () => {
			expect(() => assertJolliOriginAllowed("https://jolli.cloud")).not.toThrow();
		});

		it("accepts https://jolli-local.me for local development", () => {
			expect(() => assertJolliOriginAllowed("https://jolli-local.me")).not.toThrow();
		});

		it("accepts https://sub.jolli-local.me subdomain", () => {
			expect(() => assertJolliOriginAllowed("https://sub.jolli-local.me")).not.toThrow();
		});

		it("accepts https with non-default port on allowed host", () => {
			expect(() => assertJolliOriginAllowed("https://app.jolli.ai:8443")).not.toThrow();
		});

		it("rejects https://evil.com with origin in the error", () => {
			expect(() => assertJolliOriginAllowed("https://evil.com")).toThrow(/evil\.com/);
		});

		it("rejects suffix-boundary host https://evil-jolli.ai", () => {
			expect(() => assertJolliOriginAllowed("https://evil-jolli.ai")).toThrow(/Rejected/);
		});

		it("rejects suffix-extended host https://app.jolli.ai.evil.com", () => {
			expect(() => assertJolliOriginAllowed("https://app.jolli.ai.evil.com")).toThrow(/Rejected/);
		});

		it("rejects http scheme on allowed host", () => {
			expect(() => assertJolliOriginAllowed("http://app.jolli.ai")).toThrow(/Rejected/);
		});

		it("rejects unparseable input", () => {
			expect(() => assertJolliOriginAllowed("not-a-url")).toThrow(/unparseable/);
		});

		it("rejects credentials-in-url disguising attacker host", () => {
			expect(() => assertJolliOriginAllowed("https://app.jolli.ai@evil.com")).toThrow(/evil\.com/);
		});
	});
});
