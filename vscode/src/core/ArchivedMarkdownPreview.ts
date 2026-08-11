/**
 * ArchivedMarkdownPreview
 *
 * One virtual-document scheme backing every read-only markdown preview whose body is
 * *rendered in memory* rather than read from a file on disk: the skills aggregate and
 * archived reference snapshots.
 *
 * Why not an untitled document (what these surfaces used to open): an untitled buffer
 * has no name and no backing file, so VS Code titles it `Untitled-1` and treats it as
 * dirty from birth — closing it prompts to save content the user never authored. And
 * `showTextDocument` on it lands on raw markdown source, not the rendered table the
 * clicked row promises.
 *
 * Why not a real file: these snapshots must never be re-materialized on the user's
 * disk. The orphan branch is the system of record; the Memory Bank's visible layer is
 * absent in orphan-branch-only storage mode and for a foreign repo whose folder this
 * machine may never have seen.
 *
 * A `TextDocumentContentProvider` is the only option that gets all three: a named tab,
 * a document VS Code knows is provider-backed (never dirty, no save prompt), and a URI
 * that `markdown.showPreview` accepts.
 *
 * **The URI is the whole state.** An untitled buffer's content is backed up and
 * restored by VS Code's hot exit; a provider-backed one's is not — VS Code restores
 * the preview *tab* after a window reload and asks this provider for the body again,
 * long after the extension host that cached it died. So the URI query carries a
 * self-describing {@link ArchivedSnapshotRef} rather than an opaque cache key, and a
 * miss is re-read through the resolver registered by `activate`. Every body served
 * here is recomputable (the working skill registry, a summary, the orphan branch),
 * which is also what makes the LRU cap below safe.
 *
 * Mirrors the plan / note preview providers in `Extension.ts`, which read their bodies
 * from the orphan branch and so keep their own scheme per entity.
 */

import * as vscode from "vscode";
import { log } from "../util/Logger.js";
import {
	decodePreviewRef,
	encodePreviewRef,
	type PreviewRef,
	sanitizeTitleForUriPath,
} from "./PreviewUri.js";

export const ARCHIVED_MARKDOWN_SCHEME = "jollimemory-archived";

/**
 * Everything needed to re-render a snapshot from scratch, carried in the URI.
 *
 * Deliberately no `repoName` on `skills`: `previewCommittedSkills` resolves a
 * commit through `getSummaryAnyRepoWithSource`, which already searches every known
 * repo by hash. Only the reference namespace needs provenance to find its storage.
 */
export type ArchivedSnapshotRef =
	/** The working skill registry — not yet committed, so keyed by nothing. */
	| { readonly ns: "skills-live" }
	/** The skills table archived onto one commit. */
	| { readonly ns: "skills"; readonly commitHash: string }
	/** One archived reference snapshot on the orphan branch. */
	| {
			readonly ns: "reference";
			readonly source: string;
			readonly archivedKey: string;
			readonly repoName?: string;
			readonly remoteUrl?: string;
	  }
	/**
	 * One ACTIVE (uncommitted) reference, still a real file on disk under
	 * `.jolli/jollimemory/references/`.
	 *
	 * It gets a virtual document rather than a preview of the file itself for the same
	 * reason the archived shape does: `markdown.showPreview` on the real file renders
	 * through `markdown-it-front-matter`, whose empty renderer makes the whole
	 * frontmatter block — title, url, and every display field — invisible. A
	 * bookmark-shaped reference then shows a body talking about a link the reader
	 * cannot see. `renderReferenceForPreview` lifts those into a visible header, and
	 * that rewrite needs a document whose content we own.
	 *
	 * Keyed by `mapKey`, NOT by the file path: the key survives into the URI query and
	 * is re-read by the resolver after a window reload, so a path there would mean the
	 * provider reads an arbitrary filesystem location out of a restored URI. Resolving
	 * a mapKey through the registry is also what every other reference command does.
	 */
	| { readonly ns: "reference-live"; readonly mapKey: string };

/**
 * Re-renders a snapshot whose body is no longer cached. Registered once by
 * `activate`, which owns the bridge and workspace root this needs.
 *
 * Returns `undefined` when the snapshot genuinely no longer exists (squashed
 * commit, unarchived reference); the provider then serves the explanatory body.
 */
export type ArchivedSnapshotResolver = (
	ref: ArchivedSnapshotRef,
) => Promise<string | undefined>;

/**
 * How many snapshot bodies stay in memory.
 *
 * Bounded because reference snapshots are one per commit per source and a
 * Confluence or Notion body can be large — browsing the Timeline would otherwise
 * pin every visited snapshot in the extension host for the whole session. Safe to
 * evict precisely because a miss re-reads: the cost of being wrong is one
 * `git show`, not a dead tab.
 */
export const MAX_CACHED_SNAPSHOT_BODIES = 24;

/** Served when the body is neither cached nor recoverable. */
const UNAVAILABLE_BODY = [
	"# Snapshot no longer available",
	"",
	"This preview's content could not be re-read. That is expected after the",
	"memory it belongs to was squashed, amended, or removed.",
	"",
	"Open the row again from the Jolli Memory sidebar to render a fresh preview.",
	"",
].join("\n");

/**
 * Bodies keyed by the URI query, in least-recently-used order (a `Map` iterates in
 * insertion order, and every use re-inserts). Module-level rather than per-panel:
 * `SummaryWebviewPanel` is disposed and recreated freely, and a preview tab outlives
 * the panel that opened it — VS Code will re-ask the provider for content long after.
 */
const contents = new Map<string, string>();

/**
 * The URI each cached body was opened under, so {@link refreshArchivedMarkdownPreview}
 * can re-fire `onDidChange` for a tab it did not build the URI for.
 *
 * A separate map rather than a field on the body, because the two have different
 * lifetimes: the provider caches a body it re-read from a URI VS Code handed it, while
 * a refresh needs the URI *before* any provider call. {@link cacheBody} keys both on
 * the query and evicts the pair together, so a URI never outlives its body. The
 * converse is deliberately allowed: {@link refreshArchivedMarkdownPreview} drops the
 * body and KEEPS the URI, because that URI is what it fires `onDidChange` with and what
 * VS Code then re-asks the provider for.
 *
 * Only `showArchivedMarkdownPreview` fills it. A tab restored after a window reload
 * therefore has no entry until it is re-opened, which is correct: nothing in this
 * window has told the user it is showing a live file.
 */
const openUris = new Map<string, vscode.Uri>();

/**
 * The live registration, or `undefined` before `activate` and after dispose.
 *
 * Held as one object rather than loose module variables so a repeat registration
 * cannot half-replace it. The previous shape overwrote the emitter while leaving the
 * first registration alive, and disposing the first handle then nulled the emitter out
 * from under the second — `fire` silently short-circuited and every open preview froze
 * on the body it was first opened with.
 */
let state:
	| {
			readonly handle: vscode.Disposable;
			readonly emitter: vscode.EventEmitter<vscode.Uri>;
			resolver: ArchivedSnapshotResolver;
	  }
	| undefined;

/** The URI query for `ref` — also its cache key, so the two can never disagree. */
export function archivedRefToQuery(ref: ArchivedSnapshotRef): string {
	return encodePreviewRef(ref as PreviewRef);
}

/**
 * Rebuilds an {@link ArchivedSnapshotRef} from a URI query, or `undefined` if the
 * query is absent, truncated, or names a namespace this module does not serve.
 */
function queryToArchivedRef(query: string): ArchivedSnapshotRef | undefined {
	const raw = decodePreviewRef(query);
	if (!raw) return undefined;
	if (raw.ns === "skills-live") return { ns: "skills-live" };
	if (raw.ns === "skills") {
		return raw.commitHash ? { ns: "skills", commitHash: raw.commitHash } : undefined;
	}
	if (raw.ns === "reference") {
		if (!raw.source || !raw.archivedKey) return undefined;
		return {
			ns: "reference",
			source: raw.source,
			archivedKey: raw.archivedKey,
			...(raw.repoName ? { repoName: raw.repoName } : {}),
			...(raw.remoteUrl ? { remoteUrl: raw.remoteUrl } : {}),
		};
	}
	if (raw.ns === "reference-live") {
		return raw.mapKey ? { ns: "reference-live", mapKey: raw.mapKey } : undefined;
	}
	return undefined;
}

/** Stores `body` under `query` as the most recently used entry, evicting past the cap. */
function cacheBody(query: string, body: string): void {
	contents.delete(query);
	contents.set(query, body);
	while (contents.size > MAX_CACHED_SNAPSHOT_BODIES) {
		// `keys().next()` is the least recently used: every read and write re-inserts.
		const oldest = contents.keys().next();
		/* v8 ignore start -- unreachable: the loop condition already proves size > 0, so the iterator always yields. */
		if (oldest.done) break;
		/* v8 ignore stop */
		contents.delete(oldest.value);
		openUris.delete(oldest.value);
	}
}

/**
 * Drops the cached body for `ref` and asks VS Code to re-render the tab showing it,
 * so an already-open preview picks up a change to whatever it was rendered from.
 *
 * Needed because this scheme serves a body we own rather than a file: the built-in
 * markdown preview re-renders a `file:` URI on save by itself, which is exactly what
 * the live-reference preview gave up when it moved here to make the frontmatter
 * visible. Its two siblings (`openPlanForPreview` / `openNoteForPreview`) still
 * preview the real file and still refresh for free, so without this a reference is
 * the one Context row whose preview goes stale after an edit.
 *
 * A no-op when this window never opened `ref` — there is no tab to refresh, and the
 * next open re-reads anyway. Deleting the body before firing is the load-bearing half:
 * `provideTextDocumentContent` answers from the cache first, so firing alone would
 * re-serve the stale body.
 */
export function refreshArchivedMarkdownPreview(ref: ArchivedSnapshotRef): void {
	const query = archivedRefToQuery(ref);
	const uri = openUris.get(query);
	if (uri === undefined) return;
	contents.delete(query);
	state?.emitter.fire(uri);
}

/**
 * True when this window has an open preview in namespace `ns` — i.e. when a
 * {@link refreshArchivedMarkdownPreview} call for one could actually do something.
 *
 * Exists so a caller watching for out-of-band writes can decide whether to pay for the
 * lookup that turns a changed file into a ref. `refreshArchivedMarkdownPreview` is
 * already a no-op for a ref this window never opened, but *reaching* it means resolving
 * the ref's identity first, and for the live-reference namespace that costs a registry
 * read on a path that fires on every write.
 *
 * Answered by scanning {@link openUris}, whose size tracks the previews this window
 * opened — pruned by {@link cacheBody}'s eviction, so it stays on the order of
 * {@link MAX_CACHED_SNAPSHOT_BODIES} rather than growing with session length. Not a
 * hard cap (a refresh drops a body while keeping its URI, so the two maps can diverge
 * until the tab re-reads), which is why this is a scan and not an index.
 *
 * Decodes each query rather than matching its prefix: the encoding is base64url of
 * sorted JSON, so a substring test would depend on the payload's byte layout.
 */
export function hasOpenArchivedMarkdownPreviewIn(
	ns: ArchivedSnapshotRef["ns"],
): boolean {
	for (const query of openUris.keys()) {
		if (queryToArchivedRef(query)?.ns === ns) return true;
	}
	return false;
}

async function provideTextDocumentContent(uri: { query: string }): Promise<string> {
	const cached = contents.get(uri.query);
	if (cached !== undefined) {
		// Reading counts as a use: without this the tab the user is actually looking
		// at is the one most likely to be evicted, having been rendered longest ago.
		cacheBody(uri.query, cached);
		return cached;
	}
	const ref = queryToArchivedRef(uri.query);
	if (!ref || !state) {
		log.info("cmd", `provideTextDocumentContent (archived): unrecoverable query`);
		return UNAVAILABLE_BODY;
	}
	log.info("cmd", `provideTextDocumentContent (archived): re-reading ${ref.ns}`);
	try {
		const body = await state.resolver(ref);
		if (body === undefined) return UNAVAILABLE_BODY;
		cacheBody(uri.query, body);
		return body;
	} catch (e) {
		log.warn(
			"cmd",
			`provideTextDocumentContent (archived): re-read failed — ${String(e)}`,
		);
		return UNAVAILABLE_BODY;
	}
}

/**
 * Registers the scheme. Call once from `activate`; push the result onto subscriptions.
 *
 * A repeat call REPLACES the live registration rather than stacking a second one:
 * VS Code does not swap providers for you, so two registrations on one scheme would
 * simply coexist with VS Code picking a winner. The previous shape overwrote the
 * module-level emitter while leaving the first registration alive, which meant
 * disposing the first handle nulled the emitter out from under the second — `fire`
 * silently short-circuited and every open preview froze on its first body.
 *
 * Handles are self-checking, so disposing a superseded one (or the same one twice)
 * is a no-op rather than tearing down the live registration.
 */
export function registerArchivedMarkdownPreview(
	resolver: ArchivedSnapshotResolver,
): vscode.Disposable {
	state?.handle.dispose();
	const emitter = new vscode.EventEmitter<vscode.Uri>();
	const registration = vscode.workspace.registerTextDocumentContentProvider(
		ARCHIVED_MARKDOWN_SCHEME,
		{ onDidChange: emitter.event, provideTextDocumentContent },
	);
	const handle: vscode.Disposable = {
		dispose(): void {
			// Guard the double-dispose: `context.subscriptions` and a test teardown can
			// both hold this handle.
			if (state?.handle !== handle) return;
			state = undefined;
			registration.dispose();
			emitter.dispose();
			contents.clear();
			openUris.clear();
		},
	};
	state = { handle, emitter, resolver };
	return handle;
}

/**
 * Opens `content` as a rendered, read-only markdown preview titled `title`.
 *
 * `ref` identifies the snapshot and is what the provider re-reads from after a
 * reload. Re-opening the same ref rewrites its cache entry and fires `onDidChange`,
 * so an already-open preview refreshes in place rather than serving the body it was
 * first opened with — load-bearing for the uncommitted skills table, whose rows keep
 * growing during a session.
 */
export async function showArchivedMarkdownPreview(
	ref: ArchivedSnapshotRef,
	title: string,
	content: string,
): Promise<void> {
	const query = archivedRefToQuery(ref);
	// Uri.from() correctly separates query from path (Uri.parse treats ?key=val as path
	// for opaque URIs).
	const uri = vscode.Uri.from({
		scheme: ARCHIVED_MARKDOWN_SCHEME,
		path: `/${sanitizeTitleForUriPath(title)}.md`,
		query,
	});
	cacheBody(query, content);
	// After cacheBody, so an eviction triggered by this very insert cannot drop the
	// entry we are about to add.
	openUris.set(query, uri);
	state?.emitter.fire(uri);
	try {
		// Load the virtual document (triggers provideTextDocumentContent) without
		// showing a raw text tab, then open only the rendered preview.
		await vscode.workspace.openTextDocument(uri);
		await vscode.commands.executeCommand("markdown.showPreview", uri);
	} catch (e) {
		// `markdown.showPreview` belongs to the built-in markdown-language-features
		// extension. A user who disabled it would otherwise get a bare
		// "command 'markdown.showPreview' not found".
		log.warn("cmd", `showArchivedMarkdownPreview failed — ${String(e)}`);
		void vscode.window.showErrorMessage(
			"Could not open the Markdown preview. The built-in Markdown extension may be disabled.",
		);
	}
}
