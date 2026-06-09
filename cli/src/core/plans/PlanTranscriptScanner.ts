/**
 * PlanTranscriptScanner — per-agent "read transcript → plan candidates" parsing.
 *
 * The plan-discovery pipeline mirrors the reference pipeline (see
 * TranscriptEnvelopeParser): the upsert into plans.json is source-agnostic, and
 * the one genuinely source-specific concern is HOW a transcript line announces
 * "the AI wrote/edited a markdown plan file". This interface isolates that
 * concern so the shared driver (TranscriptPlanDiscovery.scanPlansFrom) stays
 * identical across Claude, Codex, and any future agent.
 *
 * A scanner turns raw transcript lines into a PlanScanResult: canonical
 * plan-mode slugs (`~/.claude/plans/<slug>`), absolute external `.md` paths
 * (UNFILTERED — the shared isExternalPlanCandidate policy is applied by the
 * driver), and the total lines traversed (the cursor target). No import cycle:
 * the scanners import only the types below.
 */

import type { TranscriptSource } from "../../Types.js";
import { claudePlanScanner } from "./ClaudePlanScanner.js";
import { codexPlanScanner } from "./CodexPlanScanner.js";

export interface PlanScanResult {
	/** Canonical plan-mode slugs (`~/.claude/plans/<slug>`). Claude-only; Codex emits an empty set. */
	readonly slugs: Set<string>;
	/**
	 * Absolute `.md` paths discovered outside `~/.claude/plans/`. UNFILTERED:
	 * `isExternalPlanCandidate` is a shared policy applied by the driver so Codex
	 * inherits the same README/AGENTS.md/CHANGELOG exclusions as Claude.
	 */
	readonly externalPlans: Set<string>;
	/** 1-based count of the last line traversed (the cursor target). */
	readonly totalLines: number;
}

export interface PlanTranscriptScanner {
	/**
	 * Scan only lines with line number `> fromLine && <= toLine`. `toLine`
	 * defaults to Number.POSITIVE_INFINITY (scan to EOF). The upper bound exists
	 * for the Codex shared-cursor path: Codex caps plan scanning at the reference
	 * safe cursor (which can stop before EOF on an in-flight fetch), so a plan is
	 * never processed twice and plans.json is never churned. Claude callers omit
	 * `toLine` → byte-equivalent to the pre-refactor behaviour.
	 */
	scan(transcriptPath: string, fromLine: number, cwd: string, toLine?: number): Promise<PlanScanResult>;
}

/**
 * Resolve the plan scanner for a transcript source. Unknown/other sources fall
 * back to the Claude scanner (its prefix pre-filters simply produce no results
 * on a non-Claude transcript, preserving a "no plans" outcome).
 */
export function getPlanScanner(source: TranscriptSource = "claude"): PlanTranscriptScanner {
	switch (source) {
		case "codex":
			return codexPlanScanner;
		default:
			return claudePlanScanner;
	}
}
