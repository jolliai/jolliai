/**
 * OnboardingModel — the PURE guidance model behind the Home screen's wizard.
 *
 * From three already-loaded inputs (auth token presence, the global config, and
 * the repo's enable/summary status) it derives the ordered setup steps and
 * whether the required ones are done (`phase`). Whenever a required item is
 * missing — a brand-new repo, or a returning user who logged out + wiped config
 * or disabled — the shell is the full-screen wizard (`layout: "wizard"`); once
 * setup is complete it's the tabbed dashboard. No Ink, no I/O — so the whole
 * decision tree that used to live in the plain-text `runGuidedFrontDoor` is
 * unit-testable here.
 */

import { resolveLlmCredentialSource } from "../../core/LlmClient.js";
import type { JolliMemoryConfig, LlmCredentialSource } from "../../Types.js";

/** Steps in the order the wizard presents them. `credential` folds sign-in and
 *  key entry into one "connect an AI model" step (sign-in is its primary action). */
export type SetupStepId = "credential" | "enable" | "first-memory" | "cloud-sync";

/** What pressing Enter on a step does. `none` = already satisfied / passive. */
export type SetupStepAction =
	| { readonly kind: "signin" }
	| { readonly kind: "enter-anthropic-key" }
	| { readonly kind: "enter-jolli-key" }
	| { readonly kind: "switch-provider"; readonly provider: "jolli" | "anthropic" }
	| { readonly kind: "enable" }
	| { readonly kind: "cloud-sync" }
	| { readonly kind: "none" };

/** How a step counts toward "setup complete". */
export type SetupStepClass = "required" | "passive" | "optional";

export interface SetupStep {
	readonly id: SetupStepId;
	readonly label: string;
	readonly detail: string;
	readonly satisfied: boolean;
	readonly cls: SetupStepClass;
	/** Optional single-key accelerator (Enter on the highlighted step is primary). */
	readonly actionKey?: string;
	readonly action: SetupStepAction;
	/** Secondary hint shown under the primary action (e.g. "or press k to paste a key"). */
	readonly altHint?: string;
	/** Optional secondary accelerator + its action (e.g. `k` → paste a Jolli key,
	 *  alongside the primary `s` → browser sign-in). Advertised by `altHint`. */
	readonly altActionKey?: string;
	readonly altAction?: SetupStepAction;
}

export interface OnboardingModel {
	readonly steps: SetupStep[];
	readonly requiredComplete: boolean;
	readonly phase: "onboarding" | "ready";
	/** Which shell to present. `wizard` whenever a required item is missing
	 *  (new repo OR returning user who logged out + wiped / disabled); else
	 *  `dashboard`. Equivalent to `phase`, kept as an explicit UI concept. */
	readonly layout: "wizard" | "dashboard";
	/** Unsatisfied required steps — the wizard's remaining-steps list. */
	readonly missingRequired: SetupStep[];
	readonly allSatisfied: boolean;
	readonly canGenerate: boolean;
	readonly signedIn: boolean;
}

export interface OnboardingInputs {
	/** Whether an auth token is present (env-first `JOLLI_AUTH_TOKEN` or config). */
	readonly signedIn: boolean;
	readonly config: Pick<JolliMemoryConfig, "apiKey" | "jolliApiKey" | "aiProvider" | "jolliUrl">;
	readonly enabled: boolean;
	readonly summaryCount: number;
}

/** Extracts the host from a saved Jolli site URL, if any (for the Sign-in row). */
export function siteHost(jolliUrl: string | undefined): string | undefined {
	if (!jolliUrl) return undefined;
	try {
		return new URL(jolliUrl).host;
	} catch {
		return undefined;
	}
}

/** Human label for the resolved credential source (Credential row / step detail). */
export function credentialLabel(source: LlmCredentialSource | null): string {
	switch (source) {
		case "jolli-proxy":
			return "Jolli API key";
		case "anthropic-config":
		case "anthropic-env":
			return "Anthropic key";
		default:
			return "none";
	}
}

/**
 * Picks the credential step's primary action from the current state — the
 * declarative form of the old `promptSetup` / `promptGenerationFix` decision
 * tree. Order matters: already-usable short-circuits to `none`.
 */
function credentialStep(inp: OnboardingInputs, signedIn: boolean, canGenerate: boolean): SetupStep {
	const base = { id: "credential" as const, label: "Connect an AI model", cls: "required" as const };
	if (canGenerate) {
		const source = resolveLlmCredentialSource(inp.config);
		return { ...base, detail: credentialLabel(source), satisfied: true, action: { kind: "none" } };
	}
	if (!signedIn) {
		return {
			...base,
			detail: "so Jolli can write your memories for you",
			satisfied: false,
			actionKey: "s",
			action: { kind: "signin" },
			altHint: "or press k to paste a Jolli key",
			altActionKey: "k",
			altAction: { kind: "enter-jolli-key" },
		};
	}
	// Signed in but the chosen provider has no usable key. If a Jolli key exists,
	// the cheapest fix is switching provider; otherwise ask for an Anthropic key.
	if (inp.config.jolliApiKey && inp.config.aiProvider !== "jolli") {
		return {
			...base,
			detail: "signed in — switch to Jolli to start generating",
			satisfied: false,
			actionKey: "s",
			action: { kind: "switch-provider", provider: "jolli" },
		};
	}
	return {
		...base,
		detail: "signed in — add an Anthropic key to generate",
		satisfied: false,
		actionKey: "k",
		action: { kind: "enter-anthropic-key" },
	};
}

export function buildOnboardingModel(inp: OnboardingInputs): OnboardingModel {
	const signedIn = inp.signedIn;
	const canGenerate = resolveLlmCredentialSource(inp.config) !== null;

	const credential = credentialStep(inp, signedIn, canGenerate);

	const enable: SetupStep = {
		id: "enable",
		label: "Enable Jolli in this repo",
		detail: inp.enabled ? "enabled" : "installs git + agent hooks",
		satisfied: inp.enabled,
		cls: "required",
		actionKey: "a",
		action: inp.enabled ? { kind: "none" } : { kind: "enable" },
	};

	const hasMemory = inp.summaryCount > 0;
	const firstMemory: SetupStep = {
		id: "first-memory",
		label: "Make your first memory",
		detail: hasMemory
			? `${inp.summaryCount} ${inp.summaryCount === 1 ? "memory" : "memories"}`
			: "your next commit becomes your first memory",
		satisfied: hasMemory,
		cls: "passive",
		action: { kind: "none" },
	};

	// A jolliApiKey is the sole credential the sync path (runSpaceSyncStep) and
	// the binding cache actually need — an OAuth token is not required. Gating on
	// the key alone (not `signedIn && key`) keeps the `[c]` bind/re-check
	// affordance available to key-only users, matching what runCloudSync can do.
	const canSync = Boolean(inp.config.jolliApiKey);
	// Without a Jolli key the step can't bind yet, but a generate-capable user
	// (e.g. Anthropic key only) lands on the DASHBOARD — where the credential step
	// is already satisfied and no longer offers sign-in. So drive sign-in from
	// here: `[c]` starts browser login, which mints a Jolli key; the reload then
	// flips this step to the `cloud-sync` action. In the wizard (`!canGenerate`)
	// the credential step owns sign-in, so leave this a no-op to avoid a second,
	// unadvertised `c` accelerator for the same thing.
	const syncAction: SetupStepAction = canSync
		? { kind: "cloud-sync" }
		: canGenerate
			? { kind: "signin" }
			: { kind: "none" };
	const cloudSync: SetupStep = {
		id: "cloud-sync",
		label: "Sync to a Jolli Space",
		detail: canSync ? "ready to sync" : "sign in to sync memories to a Space",
		satisfied: canSync,
		cls: "optional",
		actionKey: "c",
		action: syncAction,
	};

	const steps: SetupStep[] = [credential, enable, firstMemory, cloudSync];
	const missingRequired = steps.filter((s) => s.cls === "required" && !s.satisfied);
	const requiredComplete = missingRequired.length === 0;
	const phase = requiredComplete ? "ready" : "onboarding";
	// Any missing required item → wizard, regardless of existing memories/history.
	const layout = phase === "onboarding" ? "wizard" : "dashboard";

	return {
		steps,
		requiredComplete,
		phase,
		layout,
		missingRequired,
		allSatisfied: steps.every((s) => s.satisfied),
		canGenerate,
		signedIn,
	};
}
