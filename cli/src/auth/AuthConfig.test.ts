import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
	saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

import {
	clearAuthCredentials,
	getJolliUrl,
	loadAuthToken,
	resolveSignInJolliUrl,
	saveAuthCredentials,
	saveAuthToken,
	shouldRequestFreshApiKey,
} from "./AuthConfig.js";

describe("AuthConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.JOLLI_URL;
		delete process.env.JOLLI_AUTH_TOKEN;
	});

	describe("getJolliUrl", () => {
		it("should return default URL when no env var is set", () => {
			expect(getJolliUrl()).toBe("https://auth.jolli.ai");
		});

		it("should return JOLLI_URL env var when set", () => {
			process.env.JOLLI_URL = "https://custom.jolli.ai";
			expect(getJolliUrl()).toBe("https://custom.jolli.ai");
		});

		it("should trim whitespace from JOLLI_URL", () => {
			process.env.JOLLI_URL = "  https://custom.jolli.ai  ";
			expect(getJolliUrl()).toBe("https://custom.jolli.ai");
		});

		it("should return default when JOLLI_URL is empty", () => {
			process.env.JOLLI_URL = "   ";
			expect(getJolliUrl()).toBe("https://auth.jolli.ai");
		});

		it("should accept a staging jolli.dev host with trailing slash stripped", () => {
			process.env.JOLLI_URL = "https://staging.jolli.dev/";
			expect(getJolliUrl()).toBe("https://staging.jolli.dev");
		});

		it("should throw when JOLLI_URL points off the allowlist", () => {
			process.env.JOLLI_URL = "https://evil.com";
			expect(() => getJolliUrl()).toThrow(/evil\.com/);
		});

		it("should throw when JOLLI_URL uses http scheme", () => {
			process.env.JOLLI_URL = "http://app.jolli.ai";
			expect(() => getJolliUrl()).toThrow(/Rejected/);
		});
	});

	describe("saveAuthToken", () => {
		it("should save token via saveConfig", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthToken("test-token-123");
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "test-token-123" });
		});
	});

	describe("loadAuthToken", () => {
		it("should return env var when JOLLI_AUTH_TOKEN is set", async () => {
			process.env.JOLLI_AUTH_TOKEN = "env-token-abc";
			const token = await loadAuthToken();
			expect(token).toBe("env-token-abc");
			expect(mockLoadConfig).not.toHaveBeenCalled();
		});

		it("should trim JOLLI_AUTH_TOKEN env var", async () => {
			process.env.JOLLI_AUTH_TOKEN = "  env-token-abc  ";
			const token = await loadAuthToken();
			expect(token).toBe("env-token-abc");
		});

		it("should load from config when no env var is set", async () => {
			mockLoadConfig.mockResolvedValue({ authToken: "config-token" });
			const token = await loadAuthToken();
			expect(token).toBe("config-token");
			expect(mockLoadConfig).toHaveBeenCalled();
		});

		it("should return undefined when no token exists", async () => {
			mockLoadConfig.mockResolvedValue({});
			const token = await loadAuthToken();
			expect(token).toBeUndefined();
		});
	});

	describe("clearAuthCredentials", () => {
		it("should clear both authToken and jolliApiKey via saveConfig", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await clearAuthCredentials();
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: undefined, jolliApiKey: undefined });
		});

		it("rolls back aiProvider when it was auto-set to 'jolli' on sign-in", async () => {
			// `saveAuthCredentials` writes `aiProvider: "jolli"` as part of the
			// sign-in contract. Leaving it after logout pins the dispatcher to
			// the proxy with no credentials — silent commit failures, especially
			// for VS Code users who don't see the CLI logout copy.
			mockLoadConfig.mockResolvedValue({ aiProvider: "jolli" });
			mockSaveConfig.mockResolvedValue(undefined);
			await clearAuthCredentials();
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: undefined,
				jolliApiKey: undefined,
				aiProvider: undefined,
			});
		});

		it("preserves an explicit aiProvider='anthropic' choice across logout", async () => {
			// Only the sign-in-time auto-write of aiProvider is rolled back.
			// A deliberate Settings-UI choice survives unrelated logout actions.
			mockLoadConfig.mockResolvedValue({ aiProvider: "anthropic" });
			mockSaveConfig.mockResolvedValue(undefined);
			await clearAuthCredentials();
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: undefined,
				jolliApiKey: undefined,
			});
		});

		it("does not clear jolliUrl, so the on-disk merge preserves it across logout", async () => {
			// `jolliUrl` is intentionally retained on logout so closed-source
			// consumers (space-cli, IDE plugins) can still resolve the tenant
			// when the user signs in again. Regression-guarding this: the
			// saveConfig payload must omit `jolliUrl` entirely (not set it to
			// undefined), so SessionTracker.saveConfigScoped's spread-merge
			// keeps the existing on-disk value untouched.
			mockLoadConfig.mockResolvedValue({ jolliUrl: "https://tenant.jolli.ai" });
			mockSaveConfig.mockResolvedValue(undefined);
			await clearAuthCredentials();
			const payload = mockSaveConfig.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
			expect(payload).toBeDefined();
			expect("jolliUrl" in (payload as Record<string, unknown>)).toBe(false);
		});
	});

	describe("saveAuthCredentials", () => {
		/** Builds a valid new-format sk-jol key whose embedded meta is the given object. */
		function buildNewFormatKey(meta: Record<string, unknown>): string {
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			return `sk-jol-${encoded}.secretbytes`;
		}

		// Valid new-format key: meta is {t:"tenant1",u:"https://tenant1.jolli.ai"} base64url-encoded.
		// The embedded `u` origin must match TEST_JOLLI_URL — the new
		// cross-allowlist tenant symmetry check in `saveAuthCredentials`
		// rejects a server-returned key whose tenant differs from `jolliUrl`.
		const VALID_KEY = "sk-jol-eyJ0IjoidGVuYW50MSIsInUiOiJodHRwczovL3RlbmFudDEuam9sbGkuYWkifQ.secret";

		const TEST_JOLLI_URL = "https://tenant1.jolli.ai";

		it("should save authToken, jolliUrl, jolliApiKey, and aiProvider in a single saveConfig call", async () => {
			// `aiProvider: "jolli"` is part of the auth-success contract: clicking
			// "Sign in to Jolli" in the onboarding panel (or running `jolli auth
			// login`) is the user's explicit declaration of provider intent.
			// Persisting it alongside the credentials keeps the dispatcher's
			// `resolveLlmCredentialSource` aligned with the user's choice.
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: VALID_KEY, jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledTimes(1);
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				jolliApiKey: VALID_KEY,
				aiProvider: "jolli",
			});
		});

		it("should still write aiProvider and jolliUrl when jolliApiKey is not provided", async () => {
			// Even without a jolliApiKey (server didn't issue one, or is missing
			// in a stale-key cross-tenant scenario), `jolliUrl` is the fallback
			// that lets closed-source consumers still resolve the tenant.
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				aiProvider: "jolli",
			});
		});

		it("should omit jolliApiKey when explicitly undefined but still write aiProvider and jolliUrl", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: undefined, jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				aiProvider: "jolli",
			});
		});

		it("should persist a new-format key whose embedded origin is on the allowlist", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			const key = buildNewFormatKey({ t: "tenant1", u: "https://tenant1.jolli.ai" });
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: key, jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				jolliApiKey: key,
				aiProvider: "jolli",
			});
		});

		it("preserves an explicit aiProvider='anthropic' choice across a Jolli sign-in", async () => {
			// A user who deliberately picked Anthropic in Settings should outlast
			// a sign-in (e.g. they sign in only to push memories, not to switch
			// providers). Symmetric with the rollback path in
			// `clearAuthCredentials`: the "explicit anthropic survives a Jolli
			// round-trip" property holds end-to-end.
			mockLoadConfig.mockResolvedValue({ aiProvider: "anthropic" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: VALID_KEY, jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledTimes(1);
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				jolliApiKey: VALID_KEY,
			});
		});

		it("preserves an explicit aiProvider='local-agent' choice across a Jolli sign-in", async () => {
			// The Claude Code plugin defaults to local-agent (memories run through the
			// user's local `claude` subscription). Signing in to Jolli — done to bind
			// and share a Space, NOT to change the summary engine — must leave that
			// choice alone; otherwise summary generation would silently redirect to
			// the Jolli proxy. Symmetric with the anthropic case above.
			mockLoadConfig.mockResolvedValue({ aiProvider: "local-agent" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: VALID_KEY, jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledTimes(1);
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				jolliApiKey: VALID_KEY,
			});
		});

		it("re-asserts aiProvider='jolli' when current is already 'jolli' (idempotent)", async () => {
			// Repeated sign-ins (e.g. after token expiry) keep the choice stable.
			mockLoadConfig.mockResolvedValue({ aiProvider: "jolli" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: VALID_KEY, jolliUrl: TEST_JOLLI_URL });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: TEST_JOLLI_URL,
				jolliApiKey: VALID_KEY,
				aiProvider: "jolli",
			});
		});

		it("strips a trailing slash from jolliUrl before persisting", async () => {
			// Matches the canonical form `getJolliUrl()` produces — without this
			// normalization, callers comparing `config.jolliUrl === getJolliUrl()`
			// would see a spurious mismatch when the user pasted the URL with a
			// trailing slash into JOLLI_URL.
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliUrl: "https://tenant1.jolli.ai/" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: "https://tenant1.jolli.ai",
				aiProvider: "jolli",
			});
		});

		it("strips multiple trailing slashes from jolliUrl", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliUrl: "https://tenant1.jolli.ai///" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-abc",
				jolliUrl: "https://tenant1.jolli.ai",
				aiProvider: "jolli",
			});
		});

		it("last-write-wins for jolliUrl across successive logins (cross-tenant switch)", async () => {
			// Cross-tenant re-login scenario: the user signs into tenant X, then
			// signs into tenant Y. Each call hands a partial update to
			// `saveConfig`, which spread-merges it onto disk — Y must overwrite
			// X cleanly. Asserting the second call's payload contains the new
			// URL pins this contract at the AuthConfig layer; the underlying
			// merge semantics live in SessionTracker's `saveConfigScoped`.
			mockLoadConfig.mockResolvedValue({});
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-x", jolliUrl: "https://tenant-x.jolli.ai" });
			await saveAuthCredentials({ token: "tk-y", jolliUrl: "https://tenant-y.jolli.ai" });
			expect(mockSaveConfig).toHaveBeenNthCalledWith(1, {
				authToken: "tk-x",
				jolliUrl: "https://tenant-x.jolli.ai",
				aiProvider: "jolli",
			});
			expect(mockSaveConfig).toHaveBeenNthCalledWith(2, {
				authToken: "tk-y",
				jolliUrl: "https://tenant-y.jolli.ai",
				aiProvider: "jolli",
			});
		});

		it("clears a stale jolliApiKey on cross-tenant re-login when the callback issues no new key", async () => {
			// The user is signed into tenant-A with an auto-generated key, then
			// re-authenticates against tenant-B. Per openSignInPage the second
			// sign-in does NOT request a fresh key (one already exists on disk),
			// so the callback returns no jolliApiKey. Without active clearing
			// here, `resolveLlmCredentialSource` and `BackendClient` would keep
			// extracting tenant-A's origin from the stale key and silently
			// route LLM / sync traffic to the wrong tenant. Passing
			// `jolliApiKey: undefined` through to saveConfig makes the
			// spread-merge in `saveConfigScoped` drop the field — the same
			// mechanism `clearAuthCredentials` relies on.
			const tenantAKey = buildNewFormatKey({ t: "tenant-a", u: "https://tenant-a.jolli.ai" });
			mockLoadConfig.mockResolvedValue({ jolliApiKey: tenantAKey, jolliUrl: "https://tenant-a.jolli.ai" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-b", jolliUrl: "https://tenant-b.jolli.ai" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-b",
				jolliUrl: "https://tenant-b.jolli.ai",
				jolliApiKey: undefined,
				aiProvider: "jolli",
			});
		});

		it("preserves a matching jolliApiKey on same-tenant re-login when the callback issues no new key", async () => {
			// Repeat sign-in against the same tenant (token refresh, re-consent,
			// etc.): the existing key is still valid and should be left alone.
			// Asserting `jolliApiKey` is NOT in the payload (instead of asserting
			// it is undefined) is the contract — we only want to disturb the
			// on-disk key when it's actually stale.
			const tenantAKey = buildNewFormatKey({ t: "tenant-a", u: "https://tenant-a.jolli.ai" });
			mockLoadConfig.mockResolvedValue({ jolliApiKey: tenantAKey, jolliUrl: "https://tenant-a.jolli.ai" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-a2", jolliUrl: "https://tenant-a.jolli.ai" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-a2",
				jolliUrl: "https://tenant-a.jolli.ai",
				aiProvider: "jolli",
			});
		});

		it("preserves an existing key when both jolliUrl and meta.u carry the same tenant slug", async () => {
			// Path-based tenant: `https://jolli-local.me/dev` is a distinct
			// tenant from `https://jolli-local.me/prod` — the first path segment
			// flows downstream as the `x-tenant-slug` routing header. When the
			// stored key and the target jolliUrl agree on `(origin, tenantSlug)`,
			// the stale-key clear must not fire.
			const sameTenantKey = buildNewFormatKey({ t: "dev", u: "https://jolli-local.me/dev" });
			mockLoadConfig.mockResolvedValue({ jolliApiKey: sameTenantKey });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-refresh", jolliUrl: "https://jolli-local.me/dev" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-refresh",
				jolliUrl: "https://jolli-local.me/dev",
				aiProvider: "jolli",
			});
		});

		it("clears a stale jolliApiKey on cross-tenant re-login when only the path segment differs", async () => {
			// Regression: comparing `new URL(...).origin` alone would treat
			// `/dev` and `/prod` on the same host as the same tenant, leave the
			// old key on disk, and let `resolveLlmCredentialSource` /
			// `BackendClient` keep routing to the prior slug via the key's
			// embedded `meta.u`. `apiKeyMatchesTenant` compares the full
			// `(origin, tenantSlug)` tuple to close that path.
			const devKey = buildNewFormatKey({ t: "dev", u: "https://jolli-local.me/dev" });
			mockLoadConfig.mockResolvedValue({ jolliApiKey: devKey, jolliUrl: "https://jolli-local.me/dev" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-prod", jolliUrl: "https://jolli-local.me/prod" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-prod",
				jolliUrl: "https://jolli-local.me/prod",
				jolliApiKey: undefined,
				aiProvider: "jolli",
			});
		});

		it("clears a stale jolliApiKey when migrating from a path-based tenant to the bare origin", async () => {
			// Upgrade case: a pre-PR install only had `jolliApiKey` (no persisted
			// `jolliUrl`) whose `meta.u` carried a path-encoded tenant slug. The
			// user then signs into the bare origin — they're switching tenants,
			// and the old key is stale even though the origins match.
			const slugKey = buildNewFormatKey({ t: "tenant-a", u: "https://app.jolli.dev/tenant-a" });
			mockLoadConfig.mockResolvedValue({ jolliApiKey: slugKey });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-bare", jolliUrl: "https://app.jolli.dev" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-bare",
				jolliUrl: "https://app.jolli.dev",
				jolliApiKey: undefined,
				aiProvider: "jolli",
			});
		});

		it("preserves an existing key whose embedded `u` is unparseable (config manually corrupted)", async () => {
			// The catch branch in `apiKeyMatchesTenant` defends against a
			// config.json that was hand-edited after the save-time
			// `validateJolliApiKey` allowlist check. Without the catch a
			// bogus `meta.u` would propagate out of saveAuthCredentials and
			// abort sign-in entirely — preserving the key (and letting the
			// next legitimate sign-in replace it) is the safer default.
			const bogusKey = buildNewFormatKey({ t: "x", u: "not a url" });
			mockLoadConfig.mockResolvedValue({ jolliApiKey: bogusKey });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-new", jolliUrl: "https://tenant-z.jolli.ai" });
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-new",
				jolliUrl: "https://tenant-z.jolli.ai",
				aiProvider: "jolli",
			});
		});

		it("preserves an undecodable existing jolliApiKey (legacy / hand-typed) on re-login", async () => {
			// Legacy `sk-jol-<hex>` keys have no embedded meta, so
			// `parseJolliApiKey` returns null. We can't prove they're stale,
			// and silently wiping a key the user typed in would surprise them.
			// The next sign-in that actually mints a fresh key will replace it.
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "sk-jol-legacyhex32chars" });
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-new", jolliUrl: "https://tenant-z.jolli.ai" });
			// jolliApiKey is NOT in the payload — saveConfig's spread-merge
			// leaves the existing legacy key untouched on disk.
			expect(mockSaveConfig).toHaveBeenCalledWith({
				authToken: "tk-new",
				jolliUrl: "https://tenant-z.jolli.ai",
				aiProvider: "jolli",
			});
		});

		it("should reject a new-format key whose embedded origin is off the allowlist", async () => {
			const key = buildNewFormatKey({ t: "x", u: "https://evil.com" });
			await expect(
				saveAuthCredentials({ token: "tk-abc", jolliApiKey: key, jolliUrl: TEST_JOLLI_URL }),
			).rejects.toThrow(/evil\.com/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a server-returned key whose tenant differs from jolliUrl (cross-allowlist mismatch)", async () => {
			// Defense in depth: validateJolliApiKey only checks that the key's
			// embedded origin is on the allowlist. A buggy / compromised server
			// that emits a key whose `meta.u` points at a different ALLOWLISTED
			// tenant than the one the user signed into would otherwise be
			// silently persisted; the next LLM / sync call would route to that
			// third tenant instead of `jolliUrl`. We refuse rather than trust
			// the server's choice.
			mockLoadConfig.mockResolvedValue({});
			const mismatchedKey = buildNewFormatKey({ t: "x", u: "https://jolli.dev" });
			await expect(
				saveAuthCredentials({
					token: "tk-abc",
					jolliApiKey: mismatchedKey,
					jolliUrl: "https://app.jolli.ai",
				}),
			).rejects.toThrow(/different tenant/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject an off-allowlist jolliUrl (save-time boundary check)", async () => {
			// Symmetric with the off-allowlist `jolliApiKey` rejection above:
			// `saveAuthCredentials` runs `assertJolliOriginAllowed(jolliUrl)`
			// before any write so a future caller that bypasses `getJolliUrl()`
			// can't slip an attacker-supplied origin onto disk. Trailing-slash
			// normalization happens first, so a value like `"https://evil.com/"`
			// is rejected identically.
			mockLoadConfig.mockResolvedValue({});
			await expect(saveAuthCredentials({ token: "tk-abc", jolliUrl: "https://evil.com" })).rejects.toThrow(
				/evil\.com/,
			);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject an unparseable jolliUrl at the boundary instead of reaching apiKeyMatchesTenant", async () => {
			// Pins the contract that `apiKeyMatchesTenant`'s `jolliUrl`-bad
			// catch is now dead code in the normal flow: the boundary check
			// stops a malformed URL before the stale-key comparison can run.
			// Keeps the catch defensive without leaving an untested path.
			mockLoadConfig.mockResolvedValue({});
			await expect(saveAuthCredentials({ token: "tk-abc", jolliUrl: "not a url" })).rejects.toThrow(/Rejected/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a key that cannot be decoded (wrong prefix)", async () => {
			await expect(
				saveAuthCredentials({ token: "tk-abc", jolliApiKey: "sf-jol-garbage", jolliUrl: TEST_JOLLI_URL }),
			).rejects.toThrow(/cannot be decoded/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a legacy-shape key with no embedded meta", async () => {
			await expect(
				saveAuthCredentials({
					token: "tk-abc",
					jolliApiKey: "sk-jol-legacyhex32chars",
					jolliUrl: TEST_JOLLI_URL,
				}),
			).rejects.toThrow(/cannot be decoded/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a key with non-ASCII characters (e.g. pasted garbage)", async () => {
			await expect(
				saveAuthCredentials({
					token: "tk-abc",
					jolliApiKey: "sk-jol-windows大大大大",
					jolliUrl: TEST_JOLLI_URL,
				}),
			).rejects.toThrow(/cannot be decoded/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});
	});

	describe("shouldRequestFreshApiKey", () => {
		// Pins the contract that gates `generate_api_key=true` on the login URL.
		// Mirrors the cross-tenant logic in `saveAuthCredentials::apiKeyMatchesTenant`
		// — the two halves of the sign-in flow must agree on what "stale" means.
		const buildKey = (meta: Record<string, string>) =>
			`sk-jol-${Buffer.from(JSON.stringify(meta)).toString("base64url")}.secret`;

		it("returns true when no key is on disk (fresh install / post-logout)", () => {
			expect(shouldRequestFreshApiKey(undefined, "https://tenant1.jolli.ai")).toBe(true);
		});

		it("returns false when the existing key's tenant matches the target jolliUrl", () => {
			const key = buildKey({ t: "tenant1", u: "https://tenant1.jolli.ai" });
			expect(shouldRequestFreshApiKey(key, "https://tenant1.jolli.ai")).toBe(false);
		});

		it("returns true when the existing key targets a different tenant", () => {
			// Cross-tenant switch must request a fresh key so the user lands on
			// tenant B in a single sign-in instead of two.
			const key = buildKey({ t: "tenant1", u: "https://tenant1.jolli.ai" });
			expect(shouldRequestFreshApiKey(key, "https://tenant2.jolli.ai")).toBe(true);
		});

		it("returns true when the existing key's tenant slug differs from the target (path-based)", () => {
			// Same origin, different path segment = different tenant. Without
			// the tenant-slug check the helper would say "key matches", the
			// stale-clear in saveAuthCredentials wouldn't fire, and the user
			// would stay pinned to the old slug.
			const key = buildKey({ t: "dev", u: "https://jolli-local.me/dev" });
			expect(shouldRequestFreshApiKey(key, "https://jolli-local.me/prod")).toBe(true);
		});

		it("returns false when the existing key's tenant slug matches the target (path-based)", () => {
			const key = buildKey({ t: "dev", u: "https://jolli-local.me/dev" });
			expect(shouldRequestFreshApiKey(key, "https://jolli-local.me/dev")).toBe(false);
		});

		it("returns false when the existing key is undecodable (legacy / hand-typed)", () => {
			// Documented behavior: undecodable keys are treated as matching any
			// tenant. We can't prove staleness, and silently dropping a key the
			// user just typed in would surprise them.
			expect(shouldRequestFreshApiKey("sk-jol-legacyhandtyped", "https://tenant1.jolli.ai")).toBe(false);
		});

		it("returns false when the existing key's embedded `u` is unparseable as a URL", () => {
			// Defends apiKeyMatchesTenant's inner try/catch — meta exists but new
			// URL(meta.u) throws. Same "can't prove stale" verdict as the
			// undecodable case above.
			const key = buildKey({ t: "tenant", u: "not a url" });
			expect(shouldRequestFreshApiKey(key, "https://tenant1.jolli.ai")).toBe(false);
		});
	});

	describe("resolveSignInJolliUrl", () => {
		/** Builds a valid new-format sk-jol key whose embedded meta is the given object. */
		function buildKey(meta: Record<string, unknown>): string {
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			return `sk-jol-${encoded}.secret`;
		}

		it("returns the key's embedded tenant when a decodable key is present", () => {
			// The core P1 fix: a user signing in at the auth hub gets a key for
			// their real tenant; the persisted jolliUrl must be that tenant, not
			// the hub origin we signed into.
			const key = buildKey({ t: "tenant1", u: "https://tenant1.jolli.ai" });
			expect(resolveSignInJolliUrl(key, "https://auth.jolli.ai")).toBe("https://tenant1.jolli.ai");
		});

		it("falls back to the sign-in origin when no key was issued", () => {
			expect(resolveSignInJolliUrl(undefined, "https://auth.jolli.ai")).toBe("https://auth.jolli.ai");
		});

		it("falls back to the sign-in origin for a legacy / hand-typed key with no embedded tenant", () => {
			// `sk-jol-<hex>` (no dot) decodes to null — can't derive a tenant.
			expect(resolveSignInJolliUrl("sk-jol-deadbeef", "https://tenant1.jolli.ai")).toBe(
				"https://tenant1.jolli.ai",
			);
		});

		it("preserves a path-based tenant slug from the key", () => {
			const key = buildKey({ t: "dev", u: "https://jolli-local.me/dev" });
			expect(resolveSignInJolliUrl(key, "https://auth.jolli.ai")).toBe("https://jolli-local.me/dev");
		});

		it("falls back to the sign-in origin when the key's tenant is off the allowlist", () => {
			// The helper must never emit an off-allowlist origin, even to a caller
			// that doesn't route its result through `saveAuthCredentials`'s
			// validation. A buggy/compromised server emitting an off-allowlist
			// `meta.u` falls back to the already-validated sign-in origin.
			const key = buildKey({ t: "evil", u: "https://evil.example.com" });
			expect(resolveSignInJolliUrl(key, "https://auth.jolli.ai")).toBe("https://auth.jolli.ai");
		});
	});
});
