/**
 * Combines the candidate workflow list, the machine's cloned-space ids, and the
 * pure {@link evaluateLocalRunEligibility} rule into the offer the local-run
 * recipe consumes: the set of workflows that can be run locally right now.
 *
 * The I/O is injected ({@link LocalRunOfferDeps}) so the branching is fully
 * unit-testable without a live backend or a real space-cli spawn. The command
 * surface (`local-run-workflows`) wires the real deps and prints the result.
 */

import { evaluateLocalRunEligibility, type WorkflowSummary } from "./LocalRunEligibility.js";

/** The combined install hint surfaced when space-cli is required but absent. */
export const SPACE_CLI_INSTALL_HINT = "npm i -g @jolli.ai/cli @jolli.ai/space-cli";

/** One offerable workflow: the id the recipe passes to `start_local_run`, plus its advisory auto-merge signal. */
export interface OfferableWorkflow {
	/** Carried verbatim from the backend (a numeric id) so it stays usable as the integer `start_local_run` expects. */
	readonly id: string | number;
	/**
	 * The workflow's human-readable name, when the backend supplied one, so the
	 * recipe can present a multi-workflow choice by name instead of an opaque id.
	 * Advisory display only — never a factor in what is offered.
	 */
	readonly name?: string;
	/** Whether an approved PR will auto-merge (`true`) or open for team review (`false`). */
	readonly autoMerges: boolean;
}

/**
 * Type-tagged offer outcome. `workflows` (possibly empty) is the normal success —
 * an empty list is a legitimate "nothing to offer" state (platform tools off, or
 * no eligible workflow), never an error. `space_cli_required` is a "needs input"
 * result (mirrors the `binding_required` idiom): space-cli must be installed
 * before eligibility can be computed.
 */
export type LocalRunOfferResult =
	| { readonly type: "workflows"; readonly workflows: OfferableWorkflow[] }
	| { readonly type: "space_cli_required"; readonly message: string; readonly install: string };

export interface LocalRunOfferDeps {
	/** Best-effort candidate workflow list (empty on any degrade; never throws). */
	readonly listWorkflows: () => Promise<WorkflowSummary[]>;
	/** The cloned-space keys (JRNs and/or slugs) on this machine, or `null` when space-cli is unavailable. */
	readonly readClonedSpaceKeys: () => Promise<Set<string> | null>;
}

/**
 * Resolves the offer. When there are no candidate workflows the result is an
 * empty offer WITHOUT consulting the clones — the blocker there is the absent
 * workflow list (platform tools off / none served), not space-cli, so surfacing
 * an install prompt would mislead. Only when candidates exist does a missing
 * space-cli become the `space_cli_required` needs-input result.
 */
export async function resolveLocalRunOffer(deps: LocalRunOfferDeps): Promise<LocalRunOfferResult> {
	const workflows = await deps.listWorkflows();
	if (workflows.length === 0) {
		return { type: "workflows", workflows: [] };
	}
	const clonedSpaceKeys = await deps.readClonedSpaceKeys();
	if (clonedSpaceKeys === null) {
		return {
			type: "space_cli_required",
			message: "Running a workflow locally needs the Jolli space-cli plugin. Install it with:",
			install: SPACE_CLI_INSTALL_HINT,
		};
	}
	const offerable = evaluateLocalRunEligibility(workflows, clonedSpaceKeys)
		.filter((verdict) => verdict.runnable)
		.map((verdict) => ({ id: verdict.id, name: verdict.name, autoMerges: verdict.autoMerges }));
	return { type: "workflows", workflows: offerable };
}

/**
 * Parses the cloned-space keys from `jolli space clones --json` output. Accepts a
 * bare array or a `{ clones: [...] }` envelope; each entry contributes its space
 * `jrn` and/or `slug` (whichever it exposes) as a string key, matched against a
 * workflow destination's JRN or its encoded slug. Defensive by contract: a
 * non-JSON body (a broken space-cli, a proxy page) yields an empty set — treated
 * as "no clones" (nothing runnable) rather than an error — and entries with no
 * usable string key are skipped.
 *
 * NOTE: the exact `jolli space clones --json` output shape is owned by
 * `@jolli.ai/space-cli` (a separate package). This parser keys on the space
 * identity the backend actually emits (JRN / slug), never a numeric id the
 * backend does not produce; a clones command that exposes neither yields no
 * matches (and must gain a JRN/slug key for local runs to be offerable).
 */
export function parseClonedSpaceKeys(stdout: string): Set<string> {
	const keys = new Set<string>();
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		return keys;
	}
	for (const entry of extractCloneArray(json)) {
		if (entry !== null && typeof entry === "object") {
			const { jrn, slug } = entry as { jrn?: unknown; slug?: unknown };
			if (typeof jrn === "string" && jrn.trim() !== "") {
				keys.add(jrn);
			}
			if (typeof slug === "string" && slug.trim() !== "") {
				keys.add(slug);
			}
		}
	}
	return keys;
}

/** Pulls the clone array out of the body — a bare array or a `{ clones: [...] }` envelope. */
function extractCloneArray(json: unknown): unknown[] {
	if (Array.isArray(json)) {
		return json;
	}
	if (json !== null && typeof json === "object") {
		const clones = (json as { clones?: unknown }).clones;
		if (Array.isArray(clones)) {
			return clones;
		}
	}
	return [];
}
