import { describe, expect, it } from "vitest";
import {
	assertJolliOriginAllowed,
	deriveJolliBackendKey,
	deriveJolliBackendKeyFromApiKey,
	deriveJolliEnvKey,
	deriveJolliEnvKeyFromApiKey,
	parseBaseUrl,
	parseJolliApiKey,
	resolveArticleUrl,
} from "./JolliApiUtils";

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

	describe("deriveJolliEnvKey", () => {
		it("is the lowercased origin, ignoring any tenant path segment", () => {
			expect(deriveJolliEnvKey("https://Tenant1.jolli.dev/acme")).toBe("https://tenant1.jolli.dev");
		});

		it("keys on origin so different backends differ but same-origin orgs collapse", () => {
			expect(deriveJolliEnvKey("https://jolli-local.me")).toBe("https://jolli-local.me");
			expect(deriveJolliEnvKey("https://jolli.ai")).toBe("https://jolli.ai");
			// Same origin, different tenant path → same backend key (org/tenant intentionally ignored).
			expect(deriveJolliEnvKey("https://jolli.ai/org-a")).toBe(deriveJolliEnvKey("https://jolli.ai/org-b"));
		});

		it("returns undefined when there is no base URL", () => {
			expect(deriveJolliEnvKey(undefined)).toBeUndefined();
		});
	});

	describe("deriveJolliEnvKeyFromApiKey", () => {
		function keyWith(meta: Record<string, unknown>): string {
			return `sk-jol-${Buffer.from(JSON.stringify(meta)).toString("base64url")}.secret`;
		}

		it("derives the env key from the key's embedded `.u` claim alone", () => {
			const key = keyWith({ t: "t1", u: "https://tenant1.jolli.dev/acme", o: "engineering" });
			expect(deriveJolliEnvKeyFromApiKey(key)).toBe("https://tenant1.jolli.dev");
		});

		it("returns undefined for an absent or undecodable key (no base URL to key on)", () => {
			expect(deriveJolliEnvKeyFromApiKey(undefined)).toBeUndefined();
			expect(deriveJolliEnvKeyFromApiKey("sk-jol-plain")).toBeUndefined();
		});
	});

	describe("deriveJolliBackendKey", () => {
		it("strips the tenant subdomain to the registrable domain (all tenants of a backend collapse)", () => {
			expect(deriveJolliBackendKey("https://acme.jolli.ai")).toBe("https://jolli.ai");
			expect(deriveJolliBackendKey("https://beta.jolli.ai/o/x/articles/y-5")).toBe("https://jolli.ai");
			expect(deriveJolliBackendKey("https://acme.jolli.ai")).toBe(deriveJolliBackendKey("https://beta.jolli.ai"));
		});

		it("keeps a bare registrable domain, dot-less hosts, and IPv4 whole; preserves port", () => {
			expect(deriveJolliBackendKey("https://jolli-local.me/7o423e4x/share/x")).toBe("https://jolli-local.me");
			expect(deriveJolliBackendKey("http://localhost:8034/dev")).toBe("http://localhost:8034");
			expect(deriveJolliBackendKey("https://192.168.0.1:9000/x")).toBe("https://192.168.0.1:9000");
		});

		it("returns undefined for a missing or unparseable input", () => {
			expect(deriveJolliBackendKey(undefined)).toBeUndefined();
			expect(deriveJolliBackendKey("not-a-url")).toBeUndefined();
		});
	});

	describe("deriveJolliBackendKeyFromApiKey", () => {
		it("derives the backend key from the key's embedded `.u` claim (subdomain stripped)", () => {
			const key = `sk-jol-${Buffer.from(JSON.stringify({ t: "t1", u: "https://tenant1.jolli.dev/acme" })).toString("base64url")}.secret`;
			expect(deriveJolliBackendKeyFromApiKey(key)).toBe("https://jolli.dev");
		});

		it("returns undefined for an absent or undecodable key", () => {
			expect(deriveJolliBackendKeyFromApiKey(undefined)).toBeUndefined();
			expect(deriveJolliBackendKeyFromApiKey("sk-jol-plain")).toBeUndefined();
		});
	});

	describe("resolveArticleUrl", () => {
		const base = "https://jolli-local.me/7o423e4x";

		it("resolves the server-returned relative slug path against the display base (matches the web app)", () => {
			expect(resolveArticleUrl(base, "/o/default/articles/my-summary-839", 839)).toBe(
				"https://jolli-local.me/7o423e4x/o/default/articles/my-summary-839",
			);
			// org-less slug path (backend before it adds /o/<org>) still resolves.
			expect(resolveArticleUrl(base, "/articles/my-summary-839", 839)).toBe(
				"https://jolli-local.me/7o423e4x/articles/my-summary-839",
			);
		});

		it("uses an already-absolute server url verbatim", () => {
			expect(resolveArticleUrl(base, "https://jolli.ai/x/articles/s-5", 5)).toBe(
				"https://jolli.ai/x/articles/s-5",
			);
		});

		it("falls back to the ?doc=<id> deep-link when the server url is missing", () => {
			expect(resolveArticleUrl(base, "", 839)).toBe("https://jolli-local.me/7o423e4x/articles?doc=839");
		});
	});
});
