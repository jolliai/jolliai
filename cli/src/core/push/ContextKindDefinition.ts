/**
 * ContextKindDefinition — the declarative contract for one kind of pushable
 * commit-context artifact (plan / note / reference / skill / …).
 *
 * **Why a definition table at all.** Before this existed, every context kind
 * repeated the same pattern in ~10 places: a `docType` union member, an
 * `applyXUrls`, an `xBaseKey`, a winners loop in `assignOwnedAttachments`, an
 * `ownedX` + `seedXDocIds` map pair, an `AttachmentSelection.x` field, a
 * `pushXList`, a batch attachment block plus a write-back branch, and ownership
 * plumbing through `PushExecutor` — and then the VS Code extension carried its
 * own copy of most of it. Adding a fourth kind meant writing the same code a
 * fourth and fifth time. With a definition, the push path is generic and a new
 * kind is one definition file plus one line in `kinds/index.ts`.
 *
 * **Why this shape.** Deliberately modelled on `SourceDefinition` +
 * `BUILTIN_DEFINITIONS` + `SourceDefinitionRegistry` (the reference-source
 * layer), which solves the same "one more variant" problem for twelve sources.
 * Reusing that shape means a reviewer already knows how to read this.
 *
 * **Identity is DATA, behaviour is functions.** `field` / `entryKey` / `baseKey` /
 * `recency` / the doc-state field names are names rather than accessors, so the
 * registry can validate them and so a new kind declares rather than implements
 * them. Only `title` and `body` are functions, because a body has to be read out
 * of storage and a title has to be escaped — neither is expressible as data.
 *
 * **Every item-level name is typed {@link ItemField}**, i.e. checked against the
 * definition's own item type. That matters because a name that does not exist
 * fails SILENTLY: `ContextKindRegistry`'s `readString` returns `""` for an absent
 * field — deliberately, since stored JSON may predate a field — so a typo here, or
 * a rename in `Types.ts` that misses this file, degrades the winner rule rather
 * than throwing. Runtime validation cannot catch it either: a definition is data,
 * and `""` is the only thing a string check can reject. `AnyContextKind` keeps
 * plain `string`, so nothing downstream of {@link defineContextKind} is affected.
 * `field` is the one exception, and stays a `string`: it names a `CommitSummary`
 * array rather than an item property, and the synthetic kinds the coverage tests
 * rely on declare fields no `CommitSummary` has.
 *
 * **Why field NAMES rather than accessor functions.** The stored JSON already
 * fixes these names (`jolliPlanDocId`, `jolliNoteDocUrl`, …), and they differ per
 * kind for historical reasons. Declaring the name lets a legacy kind keep its
 * on-disk shape with zero data migration, while a NEW kind omits the declaration
 * and gets the uniform {@link DEFAULT_DOC_ID_FIELD} / {@link DEFAULT_DOC_URL_FIELD}
 * for free. That is what makes the table "auto-compatible" going forward.
 */

import type { CommitSummary } from "../../Types.js";
import type { StorageProvider } from "../StorageProvider.js";

/** The push-state field names a kind gets by declaring none of its own — see the file header. */
export const DEFAULT_DOC_ID_FIELD = "jolliDocId";
export const DEFAULT_DOC_URL_FIELD = "jolliDocUrl";

/**
 * A property name of a context kind's item type — what every item-level name in a
 * {@link ContextKindDefinition} is checked against. Exported because those declared
 * types reference it.
 */
export type ItemField<T> = Extract<keyof T, string>;

/** What a definition's {@link ContextKindDefinition.body} needs to read an item's article body. */
export interface ContextBodyCtx {
	/** Worktree root — orphan-branch reads are scoped to this. */
	readonly cwd: string;
	readonly storage?: StorageProvider;
}

/**
 * How to derive an item's cross-commit identity: join these fields with `:`, and
 * optionally strip a trailing archive stamp.
 *
 * `stripArchiveSuffix` uses the shared `REF_HASH_SUFFIX` so this agrees with
 * `RefMerge.baseKeyOf` — a drift between the two would have the push path group
 * archived snapshots that the merge path keeps apart.
 *
 * `F` narrows `fields` to the item's own property names at the authoring site; the
 * erased form held by {@link AnyContextKind} keeps the default `string`.
 */
export interface ContextBaseKeySpec<F extends string = string> {
	readonly fields: ReadonlyArray<F>;
	readonly stripArchiveSuffix?: boolean;
}

/**
 * Where a kind's published id/URL live, as a discriminated pair of field names.
 *
 * **`"item"` (the default) — one article per item.** The names are checked against
 * the item type, so a typo or a `Types.ts` rename is a compile error rather than a
 * silent degradation (see the file header). Omitting them takes the uniform
 * {@link DEFAULT_DOC_ID_FIELD} / {@link DEFAULT_DOC_URL_FIELD}.
 *
 * **`"summary"` — ONE article per commit**, so its id belongs to the commit and the
 * names are checked against `CommitSummary` instead. Today only `skill`, via
 * {@link ContextKindDefinition.aggregate}.
 *
 * Parking a commit-level id on a representative item is not a harmless shortcut,
 * which is why this is a scope rather than a convention: the item then travels
 * through that kind's own per-item merge rules (for skills, `mergeSkillRef`'s fold
 * by `<source>:<skill>`), which inherit, displace and register-for-deletion an id
 * under rules written for per-item articles. A squash whose root and child had each
 * been pushed ended up with TWO refs carrying an id from two different aggregate
 * articles: the push reused whichever sorted first — retitling another commit's
 * article in place — and the other became an orphan no cleanup path could see,
 * since `supersededDocIds` only fires when both sides of ONE fold carry an id.
 *
 * Both names are REQUIRED under `"summary"`, deliberately: the uniform defaults are
 * `CommitSummary.jolliDocId` / `jolliDocUrl`, i.e. the memory article's own fields,
 * and inheriting them would overwrite it.
 */
export type ContextKindDocState<T> =
	| {
			readonly docScope?: "item";
			readonly docIdField?: ItemField<T>;
			readonly docUrlField?: ItemField<T>;
	  }
	| {
			readonly docScope: "summary";
			readonly docIdField: ItemField<CommitSummary>;
			readonly docUrlField: ItemField<CommitSummary>;
	  };

/** One kind of pushable commit-context artifact, written against its real item type. */
export type ContextKindDefinition<T> = ContextKindBase<T> & ContextKindDocState<T>;

/** The scope-independent half of a {@link ContextKindDefinition}. */
interface ContextKindBase<T> {
	/** Wire `docType` tag, and the registry key. Must be unique across definitions. */
	readonly docType: string;
	/** The `CommitSummary` array field holding these items, e.g. `"plans"`. Deliberately unchecked — see the file header. */
	readonly field: string;
	/**
	 * Per-commit entry identity — the field a published URL is woven back onto.
	 * Distinct from {@link baseKey} on purpose: an item recurring across commits
	 * dedupes on the base key but only the entry that actually pushed receives
	 * the URL.
	 */
	readonly entryKey: ItemField<T>;
	/** Cross-commit dedup identity — see {@link ContextBaseKeySpec}. */
	readonly baseKey: ContextBaseKeySpec<ItemField<T>>;
	/** Field holding the recency used to pick the winner revision (compared as a STRING, newest wins). */
	readonly recency: ItemField<T>;
	/** Article title. Must be sanitized for a document title by the definition. */
	readonly title: (item: T, summary: CommitSummary) => string;
	/** Article body. `undefined` means "skip this item" (unreadable or empty content) — never an error. */
	readonly body: (item: T, ctx: ContextBodyCtx) => Promise<string | undefined>;
	/**
	 * Optional per-summary reduction applied before pushing a summary's OWN items
	 * (only plans need it, to collapse same-named archived snapshots).
	 */
	readonly reduce?: (items: ReadonlyArray<T>) => ReadonlyArray<T>;
	/**
	 * Optional N→1 (or N→M) collapse applied to the items ONE commit is about to
	 * push, whichever path selected them. Only `skill` needs it, to publish one
	 * aggregate article per commit instead of one per skill.
	 *
	 * **Deliberately not {@link reduce}.** The two run at different points and mean
	 * different things:
	 *
	 *   - `reduce` runs only on a summary's OWN items, and `reduceOwnItems` applies
	 *     the same call to the copy the summary markdown is rendered from — because
	 *     for a plan the collapse is a statement about which items EXIST for that
	 *     commit. A skill aggregate is not: every skill still exists and the Context
	 *     section still summarises all of them, so folding it into the rendered copy
	 *     would delete rows from the memory itself.
	 *   - `reduce` is skipped when a caller passes an explicit selection, since the
	 *     cross-commit winner rule has already done that job. An aggregate must run
	 *     on BOTH paths, or the branch-push path (which always selects) would keep
	 *     publishing one article per skill.
	 *
	 * The returned items must be assignable to `T` and must carry the identity the
	 * engine reads off them (`entryKey`, `docIdField`, `docUrlField`) from a REAL
	 * item of the group, so the published URL/docId weaves back onto an entry the
	 * summary actually holds — otherwise every push mints a fresh article instead of
	 * updating the one it minted last time.
	 */
	readonly aggregate?: (items: ReadonlyArray<T>, summary: CommitSummary) => ReadonlyArray<T>;
	/** Optional deterministic tiebreak when two revisions share a `recency` value. */
	readonly tiebreak?: (a: T, b: T) => number;
	/**
	 * Whether the summary markdown renders a link to these items. Defaults to true.
	 *
	 * `false` suppresses batch placeholder minting: a placeholder exists ONLY to
	 * mark where an attachment's final URL goes in the summary body, and
	 * `docUrlPlaceholder` is a byte-for-byte lockstep contract with the server's
	 * substituter. Minting one for a kind the body never links would send a token
	 * the server has no rule for, risking the literal string being persisted.
	 */
	readonly linksInMarkdown?: boolean;
	/**
	 * Whether these items are auto-extracted context rather than user-attached
	 * content. Defaults to false.
	 *
	 * Drives the VS Code orchestrator's failure semantics: a failed push of
	 * user-attached content (plan/note) is COLLECTED and, on the strict
	 * branch-share path, aborts the share — the user chose to attach it, so
	 * silently shipping without it would misrepresent the share. A failed push of
	 * auto-extracted context (reference, skill) is logged and skipped; one item the
	 * server rejects must not abort a share the user never attached it to.
	 * The CLI path logs-and-skips everything, so it ignores this flag.
	 */
	readonly bestEffortPush?: boolean;
	/**
	 * Prefix of the batch `clientKey` (`<prefix>-<index>`). Defaults to `docType`.
	 *
	 * Exists only so `reference` can keep emitting the historical `ref-N`. The
	 * clientKey is echoed by the server and is the payload of `docUrlPlaceholder`,
	 * whose token format is a byte-for-byte lockstep contract with the server's
	 * substituter — so deriving it from `docType` quietly renamed a value that
	 * crosses the wire. A NEW kind should omit this and take its docType.
	 */
	readonly clientKeyPrefix?: string;
}

/**
 * A definition with its item type erased, as stored in the registry.
 *
 * A heterogeneous array of `ContextKindDefinition<T>` cannot be typed directly
 * (the function parameters make `T` invariant in practice), so the registry holds
 * this erased form and {@link defineContextKind} does the one narrowing cast.
 * Sound in use because of a single invariant: **an item is only ever handed back
 * to the definition that selected it**, so the `unknown` can only ever be the `T`
 * that definition was written against.
 */
export interface AnyContextKind {
	readonly docType: string;
	readonly field: string;
	readonly entryKey: string;
	readonly baseKey: ContextBaseKeySpec;
	readonly recency: string;
	readonly docScope?: "item" | "summary";
	readonly docIdField?: string;
	readonly docUrlField?: string;
	readonly title: (item: unknown, summary: CommitSummary) => string;
	readonly body: (item: unknown, ctx: ContextBodyCtx) => Promise<string | undefined>;
	readonly reduce?: (items: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
	readonly aggregate?: (items: ReadonlyArray<unknown>, summary: CommitSummary) => ReadonlyArray<unknown>;
	readonly tiebreak?: (a: unknown, b: unknown) => number;
	readonly linksInMarkdown?: boolean;
	readonly bestEffortPush?: boolean;
	readonly clientKeyPrefix?: string;
}

/**
 * Erases a definition's item type for storage in the registry, keeping the
 * authoring site fully typed. This is the ONLY place items are cast — see
 * {@link AnyContextKind} for the invariant that makes it safe.
 */
export function defineContextKind<T>(def: ContextKindDefinition<T>): AnyContextKind {
	const reduce = def.reduce;
	const aggregate = def.aggregate;
	const tiebreak = def.tiebreak;
	return {
		docType: def.docType,
		field: def.field,
		entryKey: def.entryKey,
		baseKey: def.baseKey,
		recency: def.recency,
		...(def.docScope !== undefined && { docScope: def.docScope }),
		...(def.docIdField !== undefined && { docIdField: def.docIdField }),
		...(def.docUrlField !== undefined && { docUrlField: def.docUrlField }),
		title: (item, summary) => def.title(item as T, summary),
		body: (item, ctx) => def.body(item as T, ctx),
		...(reduce !== undefined && { reduce: (items: ReadonlyArray<unknown>) => reduce(items as ReadonlyArray<T>) }),
		...(aggregate !== undefined && {
			aggregate: (items: ReadonlyArray<unknown>, summary: CommitSummary) =>
				aggregate(items as ReadonlyArray<T>, summary),
		}),
		...(tiebreak !== undefined && { tiebreak: (a: unknown, b: unknown) => tiebreak(a as T, b as T) }),
		...(def.linksInMarkdown !== undefined && { linksInMarkdown: def.linksInMarkdown }),
		...(def.bestEffortPush !== undefined && { bestEffortPush: def.bestEffortPush }),
		...(def.clientKeyPrefix !== undefined && { clientKeyPrefix: def.clientKeyPrefix }),
	};
}
