/**
 * Conflict pyramid Tier 1.5 + Tier 2 + Tier 3 (JOLLI-1316).
 *
 * Called by `SyncEngine.runRound` when `GitClient.pullRebase` returns
 * non-empty `conflicted`. For each conflicting path:
 *
 *   - **Tier 1.5** (NEW, JOLLI-1316 §3): when the path is one of the four
 *     `.jolli/<aggregate>.json` files, read stage 2 + stage 3, JSON.parse
 *     both, run the matching deterministic merge from `AggregateMerge`,
 *     write the merged envelope back, `git add`. No AI, no user prompt.
 *     If JSON parsing fails for either side we fall through to Tier 2/3 —
 *     the user shouldn't lose data because the aggregate got corrupted.
 *
 *   - **Tier 2**: AI merge via the injected `AiMergeProvider`. Reads
 *     `:1:` / `:2:` / `:3:` blob stages, builds a merge request, applies
 *     guards (no marker leaks, length window, JSON parseability, confidence
 *     threshold). On success: write merged blob, stage, count as `aiMerged`.
 *     When `ai === null` (user has no personal Anthropic key per decision 2),
 *     skip Tier 2 entirely.
 *
 *   - **Tier 3**: ask the injected `ConflictUi` for a binary pick.
 *     `mine` / `theirs` map to the `GitClient`'s vault-clone
 *     `checkoutOurs` / `checkoutTheirs` (which already swap the raw git
 *     flag for the rebase-semantics gotcha). `viewDiff` re-prompts.
 *     `skip` aborts the rebase and records the path in the report.
 *
 * After all paths are processed:
 *
 *   - If any `skip` was returned → `git rebase --abort`, return
 *     `rebaseAdvanced: false`. Caller transitions to `conflicts` UI state.
 *   - Otherwise → `git rebase --continue`, return `rebaseAdvanced: true`.
 *     Caller amends the resulting HEAD with the suggested merge message.
 */

import { writeFile as fsWriteFile } from "node:fs/promises";
import { createLogger } from "../Logger.js";
import { mergeBranches, mergeCatalog, mergeIndex, mergeManifest } from "./AggregateMerge.js";
import type { BranchesEnvelope, CatalogEnvelope, IndexEnvelope, ManifestEnvelope } from "./AggregateTypes.js";
import type { GitClient } from "./GitClient.js";
import { mergeRepoMapping, parseRepoMapping, REPO_MAPPING_PATH, serializeRepoMapping } from "./RepoMapping.js";

const log = createLogger("Sync:ConflictResolver");

export interface AiMergeRequest {
	readonly path: string;
	readonly base: string | null; // null when the file didn't exist on the merge base
	readonly ours: string;
	readonly theirs: string;
	readonly fileKind: "md" | "json";
}

export interface AiMergeResponse {
	readonly merged: string;
	readonly confidence: number; // 0..1
	readonly model: string; // for the [model=…] suffix in commit messages
}

export interface AiMergeProvider {
	merge(req: AiMergeRequest): Promise<AiMergeResponse>;
}

export type Tier3Pick = "mine" | "theirs" | "skip" | "viewDiff";

export interface ConflictUi {
	/**
	 * Prompts the user to pick a side for a single conflicting file. May be
	 * called multiple times for the same `path` when the user chooses
	 * `viewDiff`.
	 */
	promptBinaryPick(path: string, oursOid: string | null, theirsOid: string | null): Promise<Tier3Pick>;

	/** Opens the user's diff viewer in response to `viewDiff`. */
	showDiff?(path: string, ours: string, theirs: string): Promise<void>;
}

export interface ConflictResolutionReport {
	readonly resolved: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<string>;
	readonly aiMerged: ReadonlyArray<{ readonly path: string; readonly model: string }>;
	readonly binaryPicked: ReadonlyArray<{ readonly path: string; readonly pick: "mine" | "theirs" }>;
	/** Tier 1.5 — paths auto-merged by `AggregateMerge` without AI / user. */
	readonly aggregateMerged: ReadonlyArray<string>;
	/**
	 * Tier 1.6 — regenerable artifacts (`.jolli/graph/graph.json`) resolved
	 * deterministically by keeping the side with the newer embedded
	 * `generatedAt`. No AI / user prompt; the loser regenerates on the next
	 * ingest anyway.
	 */
	readonly regenerablePicked: ReadonlyArray<{ readonly path: string; readonly pick: "mine" | "theirs" }>;
	/** True when `git rebase --continue` succeeded; false when aborted. */
	readonly rebaseAdvanced: boolean;
}

/**
 * Decision strategy for the Tier 3 fallback. Mirrors `JolliMemoryConfig.
 * syncConflictPolicy`; see that field's docstring for product-level rationale.
 *
 * Tier 3 is the rare tail — Tier 1.5 / 2 / 2.7 absorb the vast majority of
 * real-world conflicts losslessly. This enum controls only what happens
 * for the residual handful that none of the upper tiers can resolve.
 *
 * Earlier drafts included a `"newest"` policy that compared committer
 * timestamps of `ORIG_HEAD` vs `HEAD`. It was removed: the engine always
 * makes a "reconcile" commit a few milliseconds before `pull --rebase`,
 * so `mineTs` is effectively `Date.now()` and always wins — `"newest"`
 * degenerated to `"mine"` in production while sounding semantically
 * different to users. A future engine variant that supports user-driven
 * vault commits (no implicit reconcile) could resurrect a meaningful
 * `"newest"`; until then, omit it rather than ship a misleading option.
 */
export type ConflictPolicy = "prompt" | "mine" | "theirs";

export interface ConflictResolverOpts {
	readonly client: GitClient;
	readonly ai: AiMergeProvider | null;
	readonly ui: ConflictUi;
	/** Test seam — defaults to `node:fs/promises.writeFile`. */
	readonly writeFile?: (path: string, contents: string) => Promise<void>;
	/** Lookup absolute path inside the vault for a given relative path. */
	readonly resolveVaultPath?: (relative: string) => string;
	/** Tier 2 confidence threshold; defaults to 0.6. */
	readonly minConfidence?: number;
	/**
	 * Tier 3 strategy. Defaults to `"prompt"` — surfaced verbatim from
	 * `SyncBootstrap` which reads `config.syncConflictPolicy` (also
	 * defaulting to `"prompt"` when unset or when the saved value isn't
	 * a recognized member of the current `ConflictPolicy` union). The
	 * resolver never reads config itself so tests can drive the policy
	 * directly.
	 */
	readonly policy?: ConflictPolicy;
	/**
	 * Round author. Threaded into `rebaseContinue` so the rebased commit's
	 * committer matches `commit()` rather than the host's git config (which is
	 * absent in CI and stale on dev machines).
	 */
	readonly author?: { readonly name: string; readonly email: string };
}

const MARKER_REGEX = /^(<<<<<<<|=======|>>>>>>>)/m;
const DEFAULT_MIN_CONFIDENCE = 0.6;
// Output guard: merged length must be in [0.5×max, 4×max] of input sizes.
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 4;

export class ConflictResolver {
	private readonly client: GitClient;
	private readonly ai: AiMergeProvider | null;
	private readonly ui: ConflictUi;
	private readonly writeFile: (path: string, contents: string) => Promise<void>;
	private readonly resolveVaultPath: (relative: string) => string;
	private readonly minConfidence: number;
	private readonly policy: ConflictPolicy;
	private readonly author: { readonly name: string; readonly email: string } | undefined;

	constructor(opts: ConflictResolverOpts) {
		this.client = opts.client;
		this.ai = opts.ai;
		this.ui = opts.ui;
		this.writeFile = opts.writeFile ?? ((p, c) => fsWriteFile(p, c));
		this.resolveVaultPath = opts.resolveVaultPath ?? ((p) => p);
		this.minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
		// Default to `"prompt"` so a caller that forgets to specify policy
		// gets the safest behavior (ask the user, never silently pick).
		// `SyncBootstrap` likewise defaults to `"prompt"` after narrowing
		// the on-disk `syncConflictPolicy` against the current union — so
		// legacy values like `"newest"` from older configs don't sneak in.
		this.policy = opts.policy ?? "prompt";
		this.author = opts.author;
	}

	async resolveAll(paths: ReadonlyArray<string>): Promise<ConflictResolutionReport> {
		const resolved: string[] = [];
		const skipped: string[] = [];
		const aiMerged: { path: string; model: string }[] = [];
		const binaryPicked: { path: string; pick: "mine" | "theirs" }[] = [];
		const aggregateMerged: string[] = [];
		const regenerablePicked: { path: string; pick: "mine" | "theirs" }[] = [];

		for (const path of paths) {
			const ours = await this.client.readIndexStage(path, 2);
			const theirs = await this.client.readIndexStage(path, 3);
			const base = await this.client.readIndexStage(path, 1);

			// Tier 1.5 — JOLLI-1316 aggregate file auto-merge. Pure, deterministic;
			// no AI / user prompt. Aggregate files (`.jolli/<file>.json`,
			// including `repos.json`) are engine-managed — they must NEVER
			// reach Tier 3. When one stage is null (add/delete conflict,
			// typically: one device modified the file while another
			// regenerated it from scratch), treat that side as an empty
			// envelope of the matching shape so the merge resurrects the
			// peer's content rather than asking the user to "Use my edit /
			// Use remote version" on a file they didn't author.
			if (isAggregatePath(path)) {
				const oursForMerge = ours ?? emptyAggregateEnvelope(path);
				const theirsForMerge = theirs ?? emptyAggregateEnvelope(path);
				const merged = tryAggregateMerge(path, oursForMerge, theirsForMerge);
				if (merged !== null) {
					await this.writeFile(this.resolveVaultPath(path), merged);
					await this.client.addPath(path);
					resolved.push(path);
					aggregateMerged.push(path);
					continue;
				}
				// Parse failure → fall through to Tier 2/3 so the user can
				// recover manually instead of losing the file. This is rare
				// (means on-disk JSON is corrupt) and the loud UI prompt is
				// the right signal.
			}

			// Tier 1.6 — regenerable artifact (`.jolli/graph/graph.json`). The
			// knowledge graph is rewritten on every ingest (new `generatedAt`,
			// reordered content), so two devices reliably diverge it into a
			// conflict. It is NOT structurally mergeable, but it IS regenerable:
			// keeping the side with the newer embedded `generatedAt` is a
			// deterministic, lossless choice (the loser rebuilds on its next
			// ingest). This must run BEFORE Tier 2 (AI) and Tier 3 (prompt) so a
			// generated file never burns an LLM call or asks the user to pick a
			// side on a machine-authored artifact.
			if (isRegenerableGraphPath(path)) {
				const pick = pickNewerByGeneratedAt(ours, theirs);
				if (pick !== null) {
					if (pick === "mine") await this.client.checkoutOurs(path);
					else await this.client.checkoutTheirs(path);
					resolved.push(path);
					regenerablePicked.push({ path, pick });
					log.info("Tier 1.6 resolved regenerable %s via newest generatedAt (%s)", path, pick);
					continue;
				}
				// Both sides missing/unparseable — degenerate/corrupt; fall
				// through to Tier 2/3 rather than guess.
			}

			// Tier 2.7 — safe deterministic heuristics. All rules are lossless
			// (when both sides have content) or base-aware (when one side is
			// missing — respect deletes, not just modifications).
			//
			// Runs BEFORE Tier 2 (AI merge) on purpose: the heuristic rules
			// are O(file-size) string compares (~100 ms even on big files),
			// while Tier 2 is a Sonnet call that takes 1–3 minutes per file
			// and produces output the parser then often rejects (the
			// `BEGIN_MERGED_<token>` markers drift on long inputs). Empirically
			// (see plan §… in the sidebar-sync PR) a vault with 5 whitespace-
			// only divergences spent ~15 minutes on Tier 2 calls that were
			// thrown away, then Tier 2.7 resolved each in <30 ms. Putting 2.7
			// first kills that waste outright.
			//
			// Also runs BEFORE Tier 3 so even `policy: "prompt"` users skip
			// the dialog on obvious cases.
			const safeMerge = this.trySafeHeuristics(path, base, ours, theirs);
			if (safeMerge !== null) {
				if (safeMerge.kind === "merged") {
					await this.writeFile(this.resolveVaultPath(path), safeMerge.merged);
					await this.client.addPath(path);
				} else {
					// Propagate the delete to the working tree + index.
					await this.client.removePath(path);
				}
				resolved.push(path);
				log.info("Tier 2.7 resolved %s via %s", path, safeMerge.via);
				continue;
			}

			// Tier 2 — AI merge (only when a provider is wired AND we have at
			// least the two sides; if either is missing, drop straight to Tier 3
			// since the guards below would all fail anyway).
			if (this.ai !== null && ours !== null && theirs !== null) {
				const aiResult = await this.tryAiMerge(path, base, ours, theirs);
				if (aiResult !== null) {
					await this.writeFile(this.resolveVaultPath(path), aiResult.merged);
					await this.client.addPath(path);
					resolved.push(path);
					aiMerged.push({ path, model: aiResult.model });
					continue;
				}
			}

			// Tier 3 — fallback: policy-driven auto-pick OR human prompt.
			// `runTier3` decides which based on `this.policy` and may call
			// the UI's `promptBinaryPick` (policy=prompt) or return a
			// deterministic pick without touching the UI.
			const pick = await this.runTier3(path, ours, theirs);
			if (pick === "skip") {
				skipped.push(path);
				continue;
			}
			if (pick === "mine") await this.client.checkoutOurs(path);
			else await this.client.checkoutTheirs(path);
			resolved.push(path);
			binaryPicked.push({ path, pick });
		}

		if (skipped.length > 0) {
			await this.client.rebaseAbort();
			return {
				resolved,
				skipped,
				aiMerged,
				binaryPicked,
				aggregateMerged,
				regenerablePicked,
				rebaseAdvanced: false,
			};
		}

		await this.client.rebaseContinue(this.author);
		return { resolved, skipped, aiMerged, binaryPicked, aggregateMerged, regenerablePicked, rebaseAdvanced: true };
	}

	private async tryAiMerge(
		path: string,
		base: string | null,
		ours: string,
		theirs: string,
	): Promise<{ merged: string; model: string } | null> {
		const fileKind = path.toLowerCase().endsWith(".json") ? "json" : "md";
		try {
			const response = await this.requireAi().merge({ path, base, ours, theirs, fileKind });
			if (!this.passesGuards(response, ours, theirs, fileKind)) {
				return null;
			}
			return { merged: response.merged, model: response.model };
		} catch (e) {
			// LLM rejected / network blip / quota exhausted → fall through to Tier 3.
			// Without a log line a prod-only failure (auth, prompt-builder TypeError,
			// parseModelOutput shape mismatch) is invisible — Tier 3 just silently
			// gets the path. Keep at `warn`: this is recoverable (Tier 3 will still
			// resolve the conflict) but the user-installed Anthropic key being
			// rejected is worth surfacing in the debug log on first occurrence.
			log.warn("Tier 2 AI merge failed for %s: %s", path, (e as Error).message);
			return null;
		}
	}

	/* v8 ignore next 3 -- defensive: tryAiMerge gates on this.ai !== null already */
	private requireAi(): AiMergeProvider {
		if (this.ai === null) throw new Error("ConflictResolver.tryAiMerge called with ai=null");
		return this.ai;
	}

	private passesGuards(response: AiMergeResponse, ours: string, theirs: string, fileKind: "md" | "json"): boolean {
		if (response.confidence < this.minConfidence) return false;
		if (MARKER_REGEX.test(response.merged)) return false;
		const maxLen = Math.max(ours.length, theirs.length);
		const len = response.merged.length;
		if (len < maxLen * MIN_LENGTH_RATIO) return false;
		if (len > maxLen * MAX_LENGTH_RATIO) return false;
		if (fileKind === "json") {
			try {
				JSON.parse(response.merged);
			} catch {
				return false;
			}
		}
		return true;
	}

	/**
	 * Tier 2.7 — safe deterministic heuristics applied BEFORE Tier 3. Each
	 * rule must respect user intent:
	 *
	 *   - Lossless when both sides have content (merge / union both).
	 *   - Base-aware when one side is missing — distinguish "the user
	 *     deleted on this side" (respect the delete) from "this side
	 *     never had it" (accept the other side's content).
	 *
	 * Rules tried in order; first hit wins. Returns null when no rule
	 * proves a safe outcome so Tier 3 takes over. Visible for testing.
	 */
	private trySafeHeuristics(
		path: string,
		base: string | null,
		ours: string | null,
		theirs: string | null,
	): SafeHeuristicResult | null {
		// Rule 1: empty / whitespace-only side. One device wrote real content,
		// the other left the file empty (typically a machine accident — write
		// truncated, OOM kill, or a third-party tool truncating between writes).
		// The non-empty side is strictly more information.
		if (ours !== null && theirs !== null) {
			if (isWhitespaceOnly(ours) && !isWhitespaceOnly(theirs)) {
				return { kind: "merged", merged: theirs, via: "empty-mine" };
			}
			if (isWhitespaceOnly(theirs) && !isWhitespaceOnly(ours)) {
				return { kind: "merged", merged: ours, via: "empty-theirs" };
			}

			// Rule 2: identical after normalization (line endings + trailing
			// whitespace). The semantic content is the same — taking either
			// side is correct. Prefer `ours` so the working tree doesn't
			// churn line endings unnecessarily.
			if (normalizeForCompare(ours) === normalizeForCompare(theirs)) {
				return { kind: "merged", merged: ours, via: "identical-after-normalize" };
			}
		}

		// Rule 3: base-aware delete-vs-modify. Stage missing on one side,
		// present on the other. The previous "modification always wins"
		// version silently revived files the user had deleted on the other
		// device — losing the user's delete intent. Three-way compare with
		// the merge base disambiguates:
		//
		//   - base matches the non-null side → that side is "unchanged",
		//     null side is "new delete" → respect the delete (remove the file).
		//   - base is null → file is new on the non-null side, never existed
		//     on null side → accept the new content (no delete to respect).
		//   - base differs from the non-null side → both sides changed
		//     (one deleted, one modified content) → genuine conflict, fall
		//     through to Tier 3 so the user / policy decides.
		if (ours === null && theirs !== null) {
			return classifyDeleteVsModify(base, theirs, "mine-deleted");
		}
		if (theirs === null && ours !== null) {
			return classifyDeleteVsModify(base, ours, "theirs-deleted");
		}

		// Rule 4: Memory Bank summary / plan markdown union. Path patterns
		// `<repo>/<branch>/<file>.md` (3+ segments) under the vault are
		// append-only by product design — each file is a per-commit
		// summary or per-session plan that's never edited in place. Two
		// devices producing different content for the same path means
		// they ran the summarizer on the same commit with different
		// prompts / models / contexts. Concatenating with an explicit
		// "synced from peer" separator preserves BOTH versions losslessly
		// and is markdown-safe (no broken syntax). The user can review
		// later and prune; never loses material.
		if (ours !== null && theirs !== null && isMemoryBankAppendOnlyPath(path)) {
			return { kind: "merged", merged: unionMarkdown(ours, theirs), via: "memory-bank-summary-union" };
		}

		return null;
	}

	/**
	 * Tier 3 — policy-driven fallback. Three behaviors keyed off `this.policy`:
	 *
	 *   - `"prompt"`: classic `promptBinaryPick` re-prompt loop. The user
	 *     drives every decision; `viewDiff` re-enters the loop without a
	 *     cap (a hard 8-attempt cap was removed when the persisted
	 *     conflicts backlog landed — the previous silent-skip-after-eighth
	 *     behavior lost user picks).
	 *   - `"mine"` / `"theirs"`: unconditional. The UI is never called.
	 *
	 * An earlier `"newest"` option was removed (see `ConflictPolicy`
	 * docstring); `SyncBootstrap` narrows legacy on-disk values back to
	 * `"prompt"` so this method only ever sees a current union member.
	 *
	 * Visible for testing.
	 */
	private async runTier3(
		path: string,
		ours: string | null,
		theirs: string | null,
	): Promise<"mine" | "theirs" | "skip"> {
		if (this.policy === "mine") return "mine";
		if (this.policy === "theirs") return "theirs";
		// policy === "prompt" — only remaining branch by exhaustiveness.
		while (true) {
			const pick = await this.ui.promptBinaryPick(path, ours, theirs);
			if (pick !== "viewDiff") return pick;
			if (this.ui.showDiff && ours !== null && theirs !== null) {
				await this.ui.showDiff(path, ours, theirs);
			}
		}
	}
}

/**
 * Discriminated outcome of `trySafeHeuristics`. `"merged"` writes the
 * content (and `addPath` to stage it); `"delete"` removes the path
 * (`git rm -f`) to propagate a respected delete from base-aware Rule 3.
 */
export type SafeHeuristicResult =
	| { readonly kind: "merged"; readonly merged: string; readonly via: string }
	| { readonly kind: "delete"; readonly via: string };

/**
 * Base-aware classifier for the "one side null, other side present"
 * shape. Encodes Rule 3's three-way logic:
 *
 *   - `base !== null && normalize(base) === normalize(present)`:
 *     the present side is the unchanged historical state; the null
 *     side is a fresh delete. Respect the delete.
 *   - `base === null`: the file is brand-new on the present side;
 *     the null side never saw it (no delete to respect). Accept the
 *     new content.
 *   - otherwise: both sides changed (one to delete, one to modify) —
 *     genuine conflict. Return `null` so Tier 3 / policy handles it.
 *
 * `tag` discriminates which physical side held the delete for logging.
 * Visible for testing.
 */
export function classifyDeleteVsModify(
	base: string | null,
	present: string,
	tag: "mine-deleted" | "theirs-deleted",
): SafeHeuristicResult | null {
	if (base !== null && normalizeForCompare(base) === normalizeForCompare(present)) {
		return { kind: "delete", via: `respect-${tag}` };
	}
	if (base === null) {
		return { kind: "merged", merged: present, via: `accept-add-when-${tag}` };
	}
	return null;
}

/** Strips trailing whitespace per line + trailing newlines so CRLF/LF, trailing-newline-on-save, etc. compare equal. */
function normalizeForCompare(s: string): string {
	return s
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n+$/, "");
}

function isWhitespaceOnly(s: string): boolean {
	return s.trim().length === 0;
}

/**
 * Vault-relative path is one of:
 *
 *   - `<repoFolder>/<branch>/<file>.md`  — per-commit summary
 *   - `<repoFolder>/<branch>/plan--*.md` — per-plan history file
 *
 * I.e. at least 3 path segments, ends in `.md`, NOT under `.jolli/` (which
 * holds engine-managed aggregates already covered by Tier 1.5). User-edited
 * Markdown files at the bank root (e.g. `<localFolder>/notes.md`) are NOT
 * append-only and are excluded here.
 *
 * Visible for testing.
 */
export function isMemoryBankAppendOnlyPath(path: string): boolean {
	if (!path.toLowerCase().endsWith(".md")) return false;
	const segments = path.split("/").filter((s) => s.length > 0);
	if (segments.length < 3) return false;
	if (segments.includes(".jolli")) return false;
	return true;
}

/**
 * Append `theirs` onto `ours` with a visible separator so a human reviewer
 * can later prune. Lossless: every byte of both sides is preserved.
 *
 * Idempotent under repeated application: if `theirs` is already present
 * verbatim as a suffix of `ours` (e.g. an earlier round already unioned
 * them), no further append happens.
 *
 * Visible for testing.
 */
export function unionMarkdown(ours: string, theirs: string): string {
	const oursTrimmed = ours.replace(/\s+$/, "");
	const theirsTrimmed = theirs.replace(/\s+$/, "");
	if (oursTrimmed.includes(theirsTrimmed)) return ours;
	if (theirsTrimmed.includes(oursTrimmed)) return theirs;
	return `${oursTrimmed}\n\n---\n\n*Synced from another device:*\n\n${theirsTrimmed}\n`;
}

/**
 * Set of basenames that identify a per-repo aggregate file. Any path of the
 * form `<repoFolder>/.jolli/<basename>` (or the bare `.jolli/<basename>` at
 * the root, pre-§0.13) is governed by deterministic merge.
 */
const AGGREGATE_BASENAMES = new Set(["manifest.json", "index.json", "branches.json", "catalog.json"]);

/**
 * True if `path` (vault-relative, forward-slash) is one of the aggregate
 * files governed by deterministic merge:
 *
 *   - `.jolli/repos.json` — global per-bank mapping; exactly one per
 *     `<memoryBankRoot>`. Lives at the root.
 *   - `<repoFolder>/.jolli/{manifest,index,branches,catalog}.json` — per-repo
 *     aggregate files. Plan §0.13 / §0.10 placed these under each
 *     repoFolder; the older root-level form (`.jolli/manifest.json` with no
 *     prefix) is still recognized so any legacy state on the orphan branch
 *     continues to merge cleanly.
 *
 * `.jolli/summaries/<hash>.json` is intentionally excluded — those are
 * content-addressed and should not produce a conflict at all; if one does
 * appear, falling through to Tier 2/3 surfaces the bug to the user.
 *
 * Exported for testing.
 */
export function isAggregatePath(path: string): boolean {
	if (path === REPO_MAPPING_PATH) return true;
	const segments = path.split("/");
	if (segments.length < 2) return false;
	/* v8 ignore start -- `segments[length - 1]` / `segments[length - 2]` are guaranteed non-undefined past the `length < 2` guard above; the `?? ""` fallbacks are defensive against future refactors that change the guard */
	const basename = segments[segments.length - 1] ?? "";
	const parent = segments[segments.length - 2] ?? "";
	/* v8 ignore stop */
	return parent === ".jolli" && AGGREGATE_BASENAMES.has(basename);
}

/**
 * True if `path` (vault-relative, forward-slash) is the regenerable
 * knowledge-graph data file — `<repoFolder>/.jolli/graph/graph.json` (or the
 * bare `.jolli/graph/graph.json` at the root, for symmetry with
 * `isAggregatePath`). GraphArtifactStore writes exactly this one file; it is
 * device-regenerated and non-deterministic, so it is resolved by Tier 1.6
 * (newest-`generatedAt` wins) rather than the structural aggregate merge.
 *
 * Exported for testing.
 */
export function isRegenerableGraphPath(path: string): boolean {
	const segments = path.split("/");
	if (segments.length < 3) return false;
	const basename = segments[segments.length - 1];
	const parent = segments[segments.length - 2];
	const grandparent = segments[segments.length - 3];
	return grandparent === ".jolli" && parent === "graph" && basename === "graph.json";
}

/**
 * Picks the side of a regenerable graph conflict to keep, by comparing the
 * embedded `generatedAt` ISO timestamp — "keep the newest, overwrite the
 * older". Returns:
 *
 *   - `"mine"` / `"theirs"` — the side with the newer `generatedAt` (ties go
 *     to `"mine"`, deterministically). When one side is missing (add/delete
 *     conflict) or unparseable, the other side wins so a delete/corruption
 *     never clobbers a good graph.
 *   - `null` — both sides are missing/unparseable (degenerate); caller falls
 *     through to Tier 2/3.
 *
 * Unlike the removed committer-timestamp `"newest"` policy, this reads the
 * timestamp from the file *content*, so the engine's implicit reconcile
 * commit can't skew it.
 *
 * Exported for testing.
 */
export function pickNewerByGeneratedAt(ours: string | null, theirs: string | null): "mine" | "theirs" | null {
	const oursTs = parseGeneratedAt(ours);
	const theirsTs = parseGeneratedAt(theirs);
	if (oursTs === null && theirsTs === null) return null;
	if (theirsTs === null) return "mine";
	if (oursTs === null) return "theirs";
	return oursTs >= theirsTs ? "mine" : "theirs";
}

/**
 * Parses a graph blob and returns its `generatedAt` as epoch-ms, or `null`
 * when the blob is missing, unparseable, or has no valid ISO `generatedAt`.
 */
function parseGeneratedAt(blob: string | null): number | null {
	if (blob === null) return null;
	const doc = parseJson(blob);
	if (doc === null || typeof doc !== "object") return null;
	const generatedAt = (doc as { generatedAt?: unknown }).generatedAt;
	if (typeof generatedAt !== "string") return null;
	const ts = Date.parse(generatedAt);
	return Number.isNaN(ts) ? null : ts;
}

/**
 * Parses `ours` + `theirs` as the matching aggregate envelope, runs the
 * deterministic merge, and returns the serialized envelope. Returns `null`
 * when either side fails to parse or the envelope shape is unrecognized —
 * caller falls back to Tier 2/3 in that case.
 *
 * Dispatches on basename (not full path) so the per-repo path layout
 * introduced in §0.13 (`<repoFolder>/.jolli/manifest.json`) reaches the
 * same merge function as a legacy root-level `.jolli/manifest.json`.
 *
 * Exported for testing.
 */
export function tryAggregateMerge(path: string, ours: string, theirs: string): string | null {
	const oursDoc = parseJson(ours);
	const theirsDoc = parseJson(theirs);
	if (oursDoc === null || theirsDoc === null) return null;

	if (path === REPO_MAPPING_PATH) {
		return mergeRepoMappingDoc(ours, theirs);
	}
	/* v8 ignore start -- `.pop()` on a non-empty array (path always has ≥1 segment); ?? fallback is defensive */
	const basename = path.split("/").pop() ?? "";
	/* v8 ignore stop */
	if (basename === "manifest.json") return mergeManifestDoc(oursDoc, theirsDoc);
	if (basename === "index.json") return mergeIndexDoc(oursDoc, theirsDoc);
	if (basename === "branches.json") return mergeBranchesDoc(oursDoc, theirsDoc);
	if (basename === "catalog.json") return mergeCatalogDoc(oursDoc, theirsDoc);
	/* v8 ignore start -- isAggregatePath gates the caller; this is defense in depth */
	return null;
	/* v8 ignore stop */
}

/**
 * Returns a serialized empty envelope for the given aggregate path. Used by
 * Tier 1.5 to replace a `null` stage (add/delete conflict where one side
 * deleted the file) so the merge proceeds against an empty other-side
 * instead of dropping to Tier 3. The shape must satisfy each merger's
 * structural check (`Array.isArray(...)` on the right field) so the
 * deterministic merge can run.
 */
export function emptyAggregateEnvelope(path: string): string {
	if (path === REPO_MAPPING_PATH) return '{"version":1,"mappings":[]}';
	/* v8 ignore start -- `.pop()` on a non-empty array (path always has ≥1 segment); ?? fallback is defensive */
	const basename = path.split("/").pop() ?? "";
	/* v8 ignore stop */
	if (basename === "manifest.json") return '{"version":1,"files":[]}';
	if (basename === "index.json") return '{"version":3,"entries":[]}';
	if (basename === "branches.json") return '{"version":1,"mappings":[]}';
	if (basename === "catalog.json") return '{"version":1,"entries":[]}';
	/* v8 ignore start -- isAggregatePath gates the caller; this is defense in depth */
	return "{}";
	/* v8 ignore stop */
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function mergeManifestDoc(oursDoc: unknown, theirsDoc: unknown): string | null {
	const ours = oursDoc as ManifestEnvelope;
	const theirs = theirsDoc as ManifestEnvelope;
	if (!Array.isArray(ours.files) || !Array.isArray(theirs.files)) return null;
	const merged: ManifestEnvelope = {
		version: 1,
		files: mergeManifest(ours.files, theirs.files),
	};
	return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeIndexDoc(oursDoc: unknown, theirsDoc: unknown): string | null {
	const ours = oursDoc as IndexEnvelope;
	const theirs = theirsDoc as IndexEnvelope;
	/* v8 ignore next -- shape guard: defensive against corrupted aggregate JSON. `tryAggregateMerge` already gated on `parseJson` succeeding for both sides, so reaching here with a non-array `.entries` requires a JSON-parseable but schema-violating envelope (e.g. older or future version with different field shape) — the test fixtures only stage valid v3 envelopes */
	if (!Array.isArray(ours.entries) || !Array.isArray(theirs.entries)) return null;
	const merged: IndexEnvelope = {
		version: 3,
		entries: mergeIndex(ours.entries, theirs.entries),
	};
	return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeBranchesDoc(oursDoc: unknown, theirsDoc: unknown): string | null {
	const ours = oursDoc as BranchesEnvelope;
	const theirs = theirsDoc as BranchesEnvelope;
	/* v8 ignore next -- same shape-guard rationale as `mergeIndexDoc` */
	if (!Array.isArray(ours.mappings) || !Array.isArray(theirs.mappings)) return null;
	const merged: BranchesEnvelope = {
		version: 1,
		mappings: mergeBranches(ours.mappings, theirs.mappings),
	};
	return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeCatalogDoc(oursDoc: unknown, theirsDoc: unknown): string | null {
	const ours = oursDoc as CatalogEnvelope;
	const theirs = theirsDoc as CatalogEnvelope;
	/* v8 ignore next -- same shape-guard rationale as `mergeIndexDoc` */
	if (!Array.isArray(ours.entries) || !Array.isArray(theirs.entries)) return null;
	const merged: CatalogEnvelope = {
		version: 1,
		entries: mergeCatalog(ours.entries, theirs.entries),
	};
	return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Merge handler for `.jolli/repos.json`. Delegates to `RepoMapping`'s
 * dedicated `mergeRepoMapping` (which knows the `version: 1` envelope, the
 * dedupe-by-`repoIdentity` rule, and the folder-collision tiebreak).
 *
 * Returns null when either side fails to parse so the caller falls back to
 * Tier 2/3 — losing the mapping file is bad, but blocking the rebase
 * outright is worse; a user prompt at least preserves user agency.
 */
function mergeRepoMappingDoc(ours: string, theirs: string): string | null {
	const oursDoc = parseRepoMapping(ours);
	const theirsDoc = parseRepoMapping(theirs);
	if (oursDoc === null || theirsDoc === null) return null;
	// `mergeRepoMapping` may report folder-collision conflicts (P2#3).
	// They're logged + surfaced at the engine layer via a separate
	// `findRepoMappingConflicts` pass that runs after the merged file
	// has been written; merging the JSON content here only needs the
	// `merged` half so we drop `conflicts`.
	const { merged } = mergeRepoMapping(oursDoc, theirsDoc);
	return serializeRepoMapping(merged);
}
