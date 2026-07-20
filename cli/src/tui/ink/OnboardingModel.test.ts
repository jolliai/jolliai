import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOnboardingModel, credentialLabel, type OnboardingInputs, siteHost } from "./OnboardingModel.js";

/**
 * `resolveLlmCredentialSource` reads `process.env.ANTHROPIC_API_KEY`, so these
 * tests pin it off by default and restore it afterwards — otherwise a developer
 * machine with the env var set would flip `canGenerate` and break assertions.
 */
const ORIGINAL_ANTHROPIC = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
	if (ORIGINAL_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC;
});

function inputs(over: Partial<OnboardingInputs> = {}): OnboardingInputs {
	return { signedIn: false, config: {}, enabled: false, summaryCount: 0, ...over };
}

const step = (m: ReturnType<typeof buildOnboardingModel>, id: string) => m.steps.find((s) => s.id === id);

describe("siteHost", () => {
	it("extracts host from a valid url", () => {
		expect(siteHost("https://app.jolli.ai/login")).toBe("app.jolli.ai");
	});
	it("returns undefined for missing or invalid url", () => {
		expect(siteHost(undefined)).toBeUndefined();
		expect(siteHost("not a url")).toBeUndefined();
	});
});

describe("credentialLabel", () => {
	it("names each source", () => {
		expect(credentialLabel("jolli-proxy")).toBe("Jolli API key");
		expect(credentialLabel("anthropic-config")).toBe("Anthropic key");
		expect(credentialLabel("anthropic-env")).toBe("Anthropic key");
		expect(credentialLabel(null)).toBe("none");
	});
});

describe("buildOnboardingModel — fresh repo", () => {
	const m = buildOnboardingModel(inputs());

	it("is a wizard layout in onboarding phase", () => {
		expect(m.phase).toBe("onboarding");
		expect(m.layout).toBe("wizard");
	});
	it("credential step's primary action is sign-in, with a k → jolli-key alt action", () => {
		const c = step(m, "credential");
		expect(c?.satisfied).toBe(false);
		expect(c?.action).toEqual({ kind: "signin" });
		expect(c?.actionKey).toBe("s");
		expect(c?.altHint).toMatch(/paste a Jolli key/);
		// The `k` fallback must be wired to an actual action, not just a hint.
		expect(c?.altActionKey).toBe("k");
		expect(c?.altAction).toEqual({ kind: "enter-jolli-key" });
	});
	it("both required steps are missing", () => {
		expect(m.missingRequired.map((s) => s.id)).toEqual(["credential", "enable"]);
		expect(m.requiredComplete).toBe(false);
		expect(m.canGenerate).toBe(false);
	});
});

describe("buildOnboardingModel — credential paths", () => {
	it("a Jolli key alone generates (default provider) → ready when enabled", () => {
		const m = buildOnboardingModel(inputs({ signedIn: true, config: { jolliApiKey: "sk-jol-x" }, enabled: true }));
		expect(m.canGenerate).toBe(true);
		expect(step(m, "credential")?.satisfied).toBe(true);
		expect(step(m, "credential")?.detail).toBe("Jolli API key");
		expect(m.phase).toBe("ready");
		expect(m.layout).toBe("dashboard");
	});

	it("signed in with Jolli key but provider=anthropic and no anthropic key → offers switch-to-jolli", () => {
		const m = buildOnboardingModel(
			inputs({ signedIn: true, config: { jolliApiKey: "sk-jol-x", aiProvider: "anthropic" } }),
		);
		expect(m.canGenerate).toBe(false);
		expect(step(m, "credential")?.action).toEqual({ kind: "switch-provider", provider: "jolli" });
		expect(step(m, "credential")?.actionKey).toBe("s");
	});

	it("signed in, no usable key, no jolli key → asks for an Anthropic key", () => {
		const m = buildOnboardingModel(inputs({ signedIn: true, config: {} }));
		expect(step(m, "credential")?.action).toEqual({ kind: "enter-anthropic-key" });
		expect(step(m, "credential")?.actionKey).toBe("k");
	});

	it("an Anthropic key in config generates", () => {
		const m = buildOnboardingModel(
			inputs({ config: { apiKey: "sk-ant-x", aiProvider: "anthropic" }, enabled: true }),
		);
		expect(m.canGenerate).toBe(true);
		expect(step(m, "credential")?.detail).toBe("Anthropic key");
	});

	it("honours ANTHROPIC_API_KEY from the environment", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-env";
		const m = buildOnboardingModel(inputs({ enabled: true }));
		expect(m.canGenerate).toBe(true);
	});
});

describe("buildOnboardingModel — returning users also get the wizard", () => {
	it("has memories but credential lapsed → wizard (not a degraded dashboard)", () => {
		const m = buildOnboardingModel(inputs({ enabled: true, summaryCount: 42, config: {} }));
		expect(m.phase).toBe("onboarding");
		expect(m.layout).toBe("wizard");
		expect(m.missingRequired.map((s) => s.id)).toEqual(["credential"]);
	});

	it("disabled with existing memories → wizard, missingRequired has enable", () => {
		const m = buildOnboardingModel(
			inputs({ enabled: false, summaryCount: 5, config: { apiKey: "sk-ant-x", aiProvider: "anthropic" } }),
		);
		expect(m.layout).toBe("wizard");
		expect(m.missingRequired.map((s) => s.id)).toEqual(["enable"]);
		expect(step(m, "enable")?.action).toEqual({ kind: "enable" });
	});

	it("logged out but a usable Anthropic key remains → ready dashboard (still generatable)", () => {
		const m = buildOnboardingModel(
			inputs({
				signedIn: false,
				enabled: true,
				summaryCount: 5,
				config: { apiKey: "sk-ant-x", aiProvider: "anthropic" },
			}),
		);
		expect(m.phase).toBe("ready");
		expect(m.layout).toBe("dashboard");
		expect(m.signedIn).toBe(false);
	});
});

describe("buildOnboardingModel — passive & optional steps", () => {
	it("first-memory reflects the count and is passive", () => {
		const zero = buildOnboardingModel(inputs());
		expect(step(zero, "first-memory")?.satisfied).toBe(false);
		expect(step(zero, "first-memory")?.detail).toMatch(/first memory/);
		expect(step(zero, "first-memory")?.cls).toBe("passive");

		const one = buildOnboardingModel(inputs({ summaryCount: 1 }));
		expect(step(one, "first-memory")?.detail).toBe("1 memory");
		const many = buildOnboardingModel(inputs({ summaryCount: 3 }));
		expect(step(many, "first-memory")?.detail).toBe("3 memories");
	});

	it("cloud-sync becomes actionable whenever a Jolli key is present (OAuth not required)", () => {
		const off = buildOnboardingModel(inputs());
		expect(step(off, "cloud-sync")?.action).toEqual({ kind: "none" });

		const on = buildOnboardingModel(inputs({ signedIn: true, config: { jolliApiKey: "sk-jol-x" }, enabled: true }));
		expect(step(on, "cloud-sync")?.satisfied).toBe(true);
		expect(step(on, "cloud-sync")?.action).toEqual({ kind: "cloud-sync" });
		expect(step(on, "cloud-sync")?.cls).toBe("optional");

		// Key-only (never OAuth-signed-in): the sync path only needs the key, so
		// the step must still be actionable — else these users lose the [c] bind
		// affordance even though runCloudSync works.
		const keyOnly = buildOnboardingModel(
			inputs({ signedIn: false, config: { jolliApiKey: "sk-jol-x" }, enabled: true }),
		);
		expect(step(keyOnly, "cloud-sync")?.satisfied).toBe(true);
		expect(step(keyOnly, "cloud-sync")?.action).toEqual({ kind: "cloud-sync" });
	});

	it("cloud-sync drives sign-in for a generate-capable, signed-out user (dashboard has no other entry)", () => {
		// Anthropic key present → credential step is satisfied, so the shell is the
		// dashboard, where the credential step no longer offers sign-in. Without a
		// Jolli key the Space row must still expose `[c]` → sign-in, or such a user
		// can never reach the cloud/sync path from the dashboard.
		const anthropic = buildOnboardingModel(
			inputs({ signedIn: false, config: { apiKey: "sk-ant-x", aiProvider: "anthropic" }, enabled: true }),
		);
		expect(anthropic.layout).toBe("dashboard");
		expect(step(anthropic, "cloud-sync")?.satisfied).toBe(false);
		expect(step(anthropic, "cloud-sync")?.action).toEqual({ kind: "signin" });

		// Fresh repo (no credential at all) stays a no-op here: the wizard's
		// credential step owns sign-in, so this must not add a second `c` for it.
		const fresh = buildOnboardingModel(inputs());
		expect(fresh.layout).toBe("wizard");
		expect(step(fresh, "cloud-sync")?.action).toEqual({ kind: "none" });
	});
});
