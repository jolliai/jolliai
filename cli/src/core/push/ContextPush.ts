/**
 * ContextPush — the generic push engine over {@link getContextKinds}.
 *
 * Four operations that used to be written once per context kind (and then a
 * second time in the VS Code extension):
 *
 *  - {@link assignOwnedContext}      ← the per-kind winners loops + owned/seed map pairs
 *  - {@link pushContextAttachments}  ← `pushPlanList` / `pushNoteList` / `pushReferenceList`
 *  - {@link applyPublishedUrls}      ← `applyPlanUrls` / `applyNoteUrls` / `applyReferenceUrls`
 *  - {@link buildContextBatchAttachments} ← the per-kind blocks inside `buildOneBatchItem`
 *
 * Every behavioural rule they encoded is preserved verbatim — the winner rule,
 * seed propagation, the env-key document-id reuse gate, best-effort-per-item with
 * a fatal set that propagates, and the live outbound-opt-out re-read before EVERY
 * send. Only the duplication is gone.
 */

import { createLogger } from "../../Logger.js";
import type { CommitSummary } from "../../Types.js";
import { buildBranchRelativePath } from "../GitRemoteUtils.js";
import { resolveArticleUrl } from "../JolliApiUtils.js";
import {
	type BatchPushAttachment,
	DocTypeNotAllowedError,
	type JolliMemoryPushClient,
} from "../JolliMemoryPushClient.js";
import { isOutboundPushAllowed, PushDisabledError } from "../PushControl.js";
import { isRepoWideRefusal } from "../PushRefusal.js";
import type { StorageProvider } from "../StorageProvider.js";
import type { AnyContextKind, ContextBodyCtx } from "./ContextKindDefinition.js";
import {
	baseKeyOfItem,
	clientKeyPrefixOf,
	docIdOf,
	docUrlOf,
	entryKeyOf,
	getContextKinds,
	hasField,
	isSummaryScoped,
	linksInMarkdown,
	recencyOf,
	replaceItems,
	selectItems,
	storedDocOf,
	withDoc,
	withDocUrl,
	withSeedDoc,
	withSummaryDoc,
} from "./ContextKindRegistry.js";
import { canReuseDocId } from "./DocIdReuse.js";

const log = createLogger("ContextPush");

/**
 * Everything a push needs that isn't on the summary itself.
 *
 * Lives here rather than in `JolliMemoryPushOrchestrator` (which re-exports it for
 * its existing importers) so this module does not import the orchestrator — that
 * would close a cycle through the kind definitions.
 */
export interface PushContext {
	/** Worktree root — attachment bodies and the summary write-back are scoped to this. */
	readonly cwd: string;
	/** Resolved site base URL (the API key's `u`); article links are `${baseUrl}/articles?doc=<id>`. */
	readonly baseUrl: string;
	/** Kept for interface parity with the VS Code `PushContext`; unused — `client` carries its own auth. */
	readonly apiKey?: string;
	readonly repoUrl: string;
	readonly client: JolliMemoryPushClient;
	readonly storage?: StorageProvider;
}

/**
 * Items to push per docType. **A missing key means "push none of that kind"**, not
 * "fall back to the summary's own" — that tri-state is what the old named-field
 * `AttachmentSelection` encoded (`attachments ? attachments.references ?? [] :
 * summary.references ?? []`), and inverting it would silently either push nothing
 * or push an un-deduped duplicate set. "Use the summary's own items" is expressed
 * by passing no selection at all.
 */
export type ContextSelection = ReadonlyMap<string, ReadonlyArray<unknown>>;

/** One published attachment article. */
export interface PublishedContextDoc {
	/** The item's per-commit entry identity (its kind's `entryKey`). */
	readonly entryKey: string;
	/** Its cross-commit identity, for callers that resolve a shared article across commits. */
	readonly baseKey: string;
	readonly title: string;
	readonly url: string;
	readonly docId: number;
}

/** Published articles keyed by docType. */
export type PublishedContext = ReadonlyMap<string, ReadonlyArray<PublishedContextDoc>>;

/** The winner revision of a recurring item + which commit owns its push. */
interface Winner {
	readonly item: unknown;
	readonly ownerCommit: string;
	/** A known docId for this item (from any commit's prior push) so the push updates in place. */
	readonly seedDocId?: number;
	/** Article URL the `seedDocId` was minted with — rides with the id so the reuse gate can tell which backend it belongs to. */
	readonly seedDocUrl?: string;
}

/** Per-kind result of {@link assignOwnedContext}. */
export interface OwnedContextForKind {
	/** owner commit hash → the items that commit owns pushing. */
	readonly owned: ReadonlyMap<string, ReadonlyArray<unknown>>;
	/** baseKey → a known docId, for callers that pre-seed a cross-commit resolution map. */
	readonly seeds: ReadonlyMap<string, number>;
}

/** Owned attachments for every registered kind, keyed by docType. */
export type OwnedContext = ReadonlyMap<string, OwnedContextForKind>;

/**
 * Cross-commit dedup for every registered kind: pick the winner revision per
 * `baseKey`, remember the owner commit plus any known docId to reuse, and assign
 * each winner (docId injected) to its owner commit.
 *
 * The winner rule, unchanged from the per-kind loops it replaces:
 *
 *  - Newest `recency` wins, **compared as a string** — deliberate, since it avoids
 *    `Date.parse`'s NaN-on-malformed-date pitfall and stays deterministic.
 *  - First-seen is kept on a tie, unless the kind supplies a `tiebreak` (only plan
 *    does, on slug, to match `latestPlanPerName`'s own ordering — a disagreement
 *    would push one snapshot but weave the URL against another).
 *  - A LOSING (older) revision may only **fill in a missing** seed docId. It must
 *    never overwrite the winner's own: doing so would push the latest content to an
 *    older article and orphan (leak) the winner's real one.
 */
export function assignOwnedContext(subjectSummaries: ReadonlyArray<CommitSummary>): OwnedContext {
	const result = new Map<string, OwnedContextForKind>();
	for (const kind of getContextKinds()) {
		const winners = new Map<string, Winner>();
		for (const summary of subjectSummaries) {
			for (const item of selectItems(kind, summary)) {
				const key = baseKeyOfItem(kind, item);
				const prev = winners.get(key);
				const itemDocId = docIdOf(kind, item);
				if (prev === undefined || itemWins(kind, item, prev.item)) {
					// This revision wins (or is the first seen). Its own docId is
					// authoritative for the latest article; fall back to a docId a prior
					// revision surfaced only when this one carries none. The URL tracks
					// whichever revision actually supplied the docId.
					const seedDocId = itemDocId ?? prev?.seedDocId;
					const seedDocUrl = itemDocId !== undefined ? docUrlOf(kind, item) : prev?.seedDocUrl;
					winners.set(key, { item, ownerCommit: summary.commitHash, seedDocId, seedDocUrl });
				} else if (prev.seedDocId === undefined && itemDocId !== undefined) {
					winners.set(key, { ...prev, seedDocId: itemDocId, seedDocUrl: docUrlOf(kind, item) });
				}
			}
		}

		const owned = new Map<string, unknown[]>();
		const seeds = new Map<string, number>();
		for (const [key, w] of winners) {
			const item = w.seedDocId ? withSeedDoc(kind, w.item, w.seedDocId, w.seedDocUrl) : w.item;
			const arr = owned.get(w.ownerCommit);
			if (arr) arr.push(item);
			else owned.set(w.ownerCommit, [item]);
			if (w.seedDocId) seeds.set(key, w.seedDocId);
		}
		result.set(kind.docType, { owned, seeds });
	}
	return result;
}

/** True when `item` should displace `prev` as the winner revision. */
function itemWins(kind: AnyContextKind, item: unknown, prev: unknown): boolean {
	const a = recencyOf(kind, item);
	const b = recencyOf(kind, prev);
	if (a !== b) return a > b;
	// Equal recency: first-seen stays unless the kind defines a deterministic order.
	return kind.tiebreak !== undefined && kind.tiebreak(item, prev) < 0;
}

/**
 * The items one commit should push for `kind`: the caller's selection, or the
 * summary's own (reduced) — then the kind's `aggregate`, if it declares one.
 *
 * `aggregate` runs on BOTH branches on purpose, unlike `reduce`. `reduce` is
 * skipped for an explicit selection because the cross-commit winner rule has
 * already collapsed revisions; an aggregate is a per-commit presentation decision
 * that no selection can make, so skipping it on the selection branch would leave
 * the branch-push path (which always selects) publishing the un-aggregated set.
 */
export function itemsToPush(
	kind: AnyContextKind,
	summary: CommitSummary,
	selection: ContextSelection | undefined,
): ReadonlyArray<unknown> {
	const selected = selectedItems(kind, summary, selection);
	return kind.aggregate !== undefined && selected.length > 0 ? kind.aggregate(selected, summary) : selected;
}

function selectedItems(
	kind: AnyContextKind,
	summary: CommitSummary,
	selection: ContextSelection | undefined,
): ReadonlyArray<unknown> {
	if (selection !== undefined) return selection.get(kind.docType) ?? [];
	const own = selectItems(kind, summary);
	return kind.reduce !== undefined ? kind.reduce(own) : own;
}

/** Builds a per-commit {@link ContextSelection} out of {@link assignOwnedContext}'s output. */
export function selectionForCommit(owned: OwnedContext, commitHash: string): ContextSelection {
	const selection = new Map<string, ReadonlyArray<unknown>>();
	for (const [docType, forKind] of owned) {
		selection.set(docType, forKind.owned.get(commitHash) ?? []);
	}
	return selection;
}

// ─── Legacy named-field shapes ───────────────────────────────────────────────

/**
 * The docTypes the legacy named-field shapes can express — the three kinds that
 * predate the registry.
 *
 * **The single source of this list.** It used to be spelled inline in three
 * adapters (both orchestrators' `toContextSelection` plus `toOwnedContext`), which
 * is one hard-coded kind list per surface — the exact shape of the bug that made
 * the branch-share path skip `skill`: a named selection is a COMPLETE answer
 * ("push none of every kind I did not name"), so an outdated literal is silent.
 * Keeping it here means the list is visible from the registry's own module and
 * cannot drift between surfaces.
 */
export const LEGACY_NAMED_DOC_TYPES: ReadonlyArray<string> = ["plan", "note", "reference"];

/** The legacy `{ plans, notes, references? }` selection shape, structurally typed for both surfaces. */
export interface LegacyNamedSelection {
	readonly plans: ReadonlyArray<unknown>;
	readonly notes: ReadonlyArray<unknown>;
	readonly references?: ReadonlyArray<unknown>;
}

/** The legacy `{ ownedPlans, ownedNotes, ownedReferences }` ownership shape. */
export interface LegacyNamedOwnership {
	readonly ownedPlans: ReadonlyMap<string, ReadonlyArray<unknown>>;
	readonly ownedNotes: ReadonlyMap<string, ReadonlyArray<unknown>>;
	readonly ownedReferences: ReadonlyMap<string, ReadonlyArray<unknown>>;
}

/**
 * Guards the one way a legacy adapter can break SILENTLY: a registered kind
 * renaming its `docType` away from a name this list still spells. The adapter would
 * keep emitting an entry no kind matches, so that kind would push nothing through
 * every legacy caller — with no type error, since the keys are strings.
 *
 * Bidirectional by design, like `check-no-direct-llm-http.sh`: the list must not
 * name a kind that is gone, which forces it to shrink in the same change that
 * retires one. It cannot check the other direction (a NEW kind absent from the
 * list) — that is not an error but the whole point: a kind the legacy shape cannot
 * name is deliberately expanded to "push none", which is the only safe default
 * (falling back to the summary's own items would double-publish a kind that dedupes
 * across commits).
 */
function assertLegacyDocTypesRegistered(): void {
	const registered = new Set(getContextKinds().map((kind) => kind.docType));
	const gone = LEGACY_NAMED_DOC_TYPES.filter((docType) => !registered.has(docType));
	if (gone.length > 0) {
		throw new Error(
			`LEGACY_NAMED_DOC_TYPES names unregistered docType(s) ${JSON.stringify(gone)} — a context kind was renamed or removed without updating the legacy named-shape adapters.`,
		);
	}
}

/**
 * Expands a legacy named-field selection into a full {@link ContextSelection}: one
 * entry per REGISTERED kind, taking the caller's array for the legacy docTypes and
 * an explicit empty array for every other kind.
 *
 * Iterating the registry rather than emitting three fixed entries is what makes the
 * "push none of that kind" decision explicit for a new kind instead of emergent
 * from an absent key — the two are equivalent downstream (see {@link itemsToPush}),
 * but only the loop is visible when a fourth kind is registered, and only the loop
 * runs {@link assertLegacyDocTypesRegistered}.
 *
 * Deliberately NOT extended for a new context kind: pass a {@link ContextSelection}.
 */
export function legacyNamedSelection(named: LegacyNamedSelection): ContextSelection {
	assertLegacyDocTypesRegistered();
	const byDocType = new Map<string, ReadonlyArray<unknown>>([
		["plan", named.plans],
		["note", named.notes],
		["reference", named.references ?? []],
	]);
	const selection = new Map<string, ReadonlyArray<unknown>>();
	for (const kind of getContextKinds()) {
		selection.set(kind.docType, byDocType.get(kind.docType) ?? []);
	}
	return selection;
}

/** The {@link legacyNamedSelection} counterpart for the ownership shape — same expansion, same rationale. */
export function legacyNamedOwnership(named: LegacyNamedOwnership): OwnedContext {
	assertLegacyDocTypesRegistered();
	const byDocType = new Map<string, ReadonlyMap<string, ReadonlyArray<unknown>>>([
		["plan", named.ownedPlans],
		["note", named.ownedNotes],
		["reference", named.ownedReferences],
	]);
	const owned = new Map<string, OwnedContextForKind>();
	const noSeeds = new Map<string, number>();
	for (const kind of getContextKinds()) {
		owned.set(kind.docType, { owned: byDocType.get(kind.docType) ?? new Map(), seeds: noSeeds });
	}
	return owned;
}

// ─── Document-id reuse gate ──────────────────────────────────────────────────

/**
 * Errors that must ABORT an attachment loop instead of being collected per item:
 * every {@link isRepoWideRefusal} (see `PushRefusal.ts` — the shared, three-surface
 * source of truth for that membership), plus `BindingRequiredError`, which is
 * fatal *here* because these loops cannot run the binding chooser themselves and
 * so must propagate to the caller that can.
 */
export function isFatalAttachmentError(err: unknown): boolean {
	return isRepoWideRefusal(err) || (err instanceof Error && err.name === "BindingRequiredError");
}

/**
 * Re-reads the per-repo opt-out immediately before an outbound send.
 *
 * The entry gates check once, up front — that is what makes a disabled repo cheap
 * to refuse. But a branch push is a LOOP of network calls that can run for many
 * seconds, and spec 306 requires the flag be read LIVE: a user who disables push
 * mid-run must stop the REMAINING sends, not merely the next run. Cheap by
 * construction — the repo identity is memoized per-cwd in `PushControl`, so each
 * extra read is a file read, not a git spawn.
 */
export async function assertOutboundStillAllowed(cwd: string): Promise<void> {
	if (!(await isOutboundPushAllowed(cwd))) throw new PushDisabledError();
}

// ─── Push ────────────────────────────────────────────────────────────────────

/**
 * Uploads every kind's attachments for one summary, in registry order, returning
 * the published articles per docType.
 *
 * Per-item failures are logged and skipped ({@link isFatalAttachmentError} ones
 * propagate). A {@link DocTypeNotAllowedError} is a third tier: the server has no
 * config row for that docType, so every remaining item of the SAME kind would fail
 * identically — the kind is short-circuited for the rest of this call with ONE
 * actionable log line, while other kinds continue. Without that, a dozen skills
 * would emit a dozen identical errors that read like transient failures rather
 * than a configuration problem.
 */
export async function pushContextAttachments(
	summary: CommitSummary,
	ctx: PushContext,
	envKey: string,
	selection: ContextSelection | undefined,
): Promise<PublishedContext> {
	const displayBase = ctx.baseUrl.replace(/\/+$/, "");
	const bodyCtx: ContextBodyCtx = { cwd: ctx.cwd, storage: ctx.storage };
	const published = new Map<string, PublishedContextDoc[]>();
	for (const kind of getContextKinds()) {
		const results: PublishedContextDoc[] = [];
		for (const item of itemsToPush(kind, summary, selection)) {
			const entryKey = entryKeyOf(kind, item);
			const content = await kind.body(item, bodyCtx);
			if (content === undefined || content === "") {
				log.info("%s %s: no content found, skipping", kind.docType, entryKey);
				continue;
			}
			const title = kind.title(item, summary);
			const stored = storedDocOf(kind, summary, item);
			try {
				// Live re-read of the opt-out before EVERY send — see assertOutboundStillAllowed.
				await assertOutboundStillAllowed(ctx.cwd);
				const pushResult = await ctx.client.push({
					title,
					content,
					commitHash: summary.commitHash,
					docType: kind.docType,
					branch: summary.branch,
					...(stored.docId !== undefined && canReuseDocId(stored.docUrl, envKey) && { docId: stored.docId }),
					repoUrl: ctx.repoUrl,
					relativePath: buildBranchRelativePath(summary.branch),
				});
				results.push({
					entryKey,
					baseKey: baseKeyOfItem(kind, item),
					title,
					url: resolveArticleUrl(displayBase, pushResult.url, pushResult.docId),
					docId: pushResult.docId,
				});
			} catch (err) {
				if (isFatalAttachmentError(err)) throw err;
				if (err instanceof DocTypeNotAllowedError) {
					logDocTypeNotAllowed(kind.docType, err.message);
					break;
				}
				log.error(
					"%s %s push FAILED: %s",
					kind.docType,
					entryKey,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		published.set(kind.docType, results);
	}
	return published;
}

/** One actionable line for an unconfigured docType, in place of one error per item. */
function logDocTypeNotAllowed(docType: string, message: string): void {
	log.warn(
		"The server does not have docType \"%s\" enabled, so none of this commit's %s articles were pushed. Enable it in the server's supported-docType configuration. (%s)",
		docType,
		docType,
		message,
	);
}

// ─── URL write-back ──────────────────────────────────────────────────────────

/**
 * Weaves published URLs/docIds into a summary's context arrays, matched per kind by
 * `entryKey` — the exact per-commit array entry, so an item recurring across commits
 * only updates the entry that actually pushed.
 *
 * A **summary-scoped** kind writes onto the summary's own fields instead: its article
 * covers the commit, so there is no entry that owns it (see `ContextKindDocState`).
 *
 * `opts.urlOnly` writes the URL but not the docId: the batch path uses it to weave
 * server-substituted PLACEHOLDER urls into the copy the markdown and summaryJson
 * are built from, where a placeholder string in a numeric docId field would break
 * the sidecar schema.
 *
 * Kinds absent from `published`, or whose field the summary does not carry at all,
 * are left untouched — so an unchanged summary is returned by identity and callers
 * can keep using `!==` to detect "nothing was woven".
 */
export function applyPublishedUrls(
	summary: CommitSummary,
	published: ReadonlyMap<string, ReadonlyArray<{ entryKey: string; url: string; docId?: number }>>,
	opts?: { readonly urlOnly?: boolean },
): CommitSummary {
	let out = summary;
	for (const kind of getContextKinds()) {
		const docs = published.get(kind.docType);
		if (docs === undefined || docs.length === 0) continue;
		if (isSummaryScoped(kind)) {
			// One article for the whole commit, so there is no entry to match: the id/URL
			// go on the summary itself. `docs` holds exactly one doc for such a kind (its
			// `aggregate` produced one item), and taking the first keeps that assumption
			// visible rather than silently letting a later doc win.
			const doc = docs[0];
			out = withSummaryDoc(kind, out, doc.url, opts?.urlOnly === true ? undefined : doc.docId);
			continue;
		}
		if (!hasField(kind, out)) continue;
		const byEntryKey = new Map(docs.map((d) => [d.entryKey, d]));
		const items = selectItems(kind, out).map((item) => {
			const hit = byEntryKey.get(entryKeyOf(kind, item));
			if (hit === undefined) return item;
			return opts?.urlOnly === true || hit.docId === undefined
				? withDocUrl(kind, item, hit.url)
				: withDoc(kind, item, hit.url, hit.docId);
		});
		out = replaceItems(kind, out, items);
	}
	return out;
}

/**
 * Applies a kind's per-summary `reduce` to the summary's own items, without pushing
 * anything. The push path needs this for the copy the markdown is rendered from:
 * only the reduced set was uploaded, so the rendered body must list the same set.
 */
export function reduceOwnItems(summary: CommitSummary): CommitSummary {
	let out = summary;
	for (const kind of getContextKinds()) {
		if (kind.reduce === undefined || !hasField(kind, out)) continue;
		out = replaceItems(kind, out, kind.reduce(selectItems(kind, out)));
	}
	return out;
}

// ─── Batch assembly ──────────────────────────────────────────────────────────

/** Identity of one batch attachment for the post-push URL write-back. */
export interface BatchAttachmentKey {
	readonly docType: string;
	/** The item's `entryKey` — plan slug / note id / reference or skill archivedKey. */
	readonly key: string;
}

/** What {@link buildContextBatchAttachments} produced for one commit. */
export interface BuiltContextAttachments {
	readonly attachments: ReadonlyArray<BatchPushAttachment>;
	readonly attachmentKeys: ReadonlyMap<string, BatchAttachmentKey>;
	/** Placeholder URLs to weave into the markdown copy, keyed by docType then entryKey. */
	readonly placeholders: ReadonlyMap<string, ReadonlyArray<{ entryKey: string; url: string }>>;
}

/**
 * Builds the batch attachments for one commit across every kind, assigning
 * `<clientKeyPrefix ?? docType>-<index>` clientKeys and minting a URL placeholder
 * per item. The prefix is a declared value rather than the docType outright
 * because the clientKey crosses the wire (see `clientKeyPrefix`).
 *
 * A kind with `linksInMarkdown: false` gets NO placeholder: a placeholder exists
 * only to mark where the final URL goes in the summary body, and
 * `docUrlPlaceholder` is a byte-for-byte lockstep contract with the server's
 * substituter — minting a token the server has no rule for risks the literal
 * string being persisted, which is worse than the absent URL it would replace.
 * The post-push write-back still records the real id either way.
 *
 * Unreadable/empty bodies are skipped exactly as in the individual path, so their
 * placeholder is never minted and the woven copy keeps whatever URL state the item
 * already had.
 */
export async function buildContextBatchAttachments(
	summary: CommitSummary,
	ctx: PushContext,
	envKey: string,
	selection: ContextSelection | undefined,
	docUrlPlaceholder: (clientKey: string) => string,
): Promise<BuiltContextAttachments> {
	const attachments: BatchPushAttachment[] = [];
	const attachmentKeys = new Map<string, BatchAttachmentKey>();
	const placeholders = new Map<string, Array<{ entryKey: string; url: string }>>();
	const relativePath = buildBranchRelativePath(summary.branch);
	const bodyCtx: ContextBodyCtx = { cwd: ctx.cwd, storage: ctx.storage };

	for (const kind of getContextKinds()) {
		const forKind: Array<{ entryKey: string; url: string }> = [];
		let index = 0;
		for (const item of itemsToPush(kind, summary, selection)) {
			const entryKey = entryKeyOf(kind, item);
			const content = await kind.body(item, bodyCtx);
			if (content === undefined || content === "") {
				log.info("%s %s: no content found, skipping", kind.docType, entryKey);
				continue;
			}
			const clientKey = `${clientKeyPrefixOf(kind)}-${index}`;
			index++;
			const stored = storedDocOf(kind, summary, item);
			attachments.push({
				clientKey,
				docType: kind.docType,
				title: kind.title(item, summary),
				content,
				relativePath,
				...(stored.docId !== undefined && canReuseDocId(stored.docUrl, envKey) && { docId: stored.docId }),
			});
			attachmentKeys.set(clientKey, { docType: kind.docType, key: entryKey });
			if (linksInMarkdown(kind)) forKind.push({ entryKey, url: docUrlPlaceholder(clientKey) });
		}
		if (forKind.length > 0) placeholders.set(kind.docType, forKind);
	}
	return { attachments, attachmentKeys, placeholders };
}
