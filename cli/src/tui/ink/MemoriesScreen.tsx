/**
 * MemoriesScreen — the read-only memory workspace, rendered as TWO tabs from one
 * component (see `variant`):
 *   • memories    — the CURRENT BRANCH's committed memories: a list + detail;
 *                   `f` instant search, `Enter` expands the detail pane.
 *   • memory-bank — the WHOLE REPO's compiled topics: a topic list + the selected
 *                   topic's readable content (its `content` markdown) + a Sources
 *                   footer; `Enter` expands the content pane.
 * Recall is intentionally NOT a browse view — it's an agent-facing command
 * (`/recall` in the palette) that compiles context for an AI to consume, not a
 * human reading surface. Actions (graph export, backfill) run from the `/`
 * command palette. Key hints live in the shell StatusBar (`onHints`); the search
 * box reports capture so global keys don't fire while typing.
 */
import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import type { MemoryListItem } from "../../core/MemoryBankModel.js";
import type { SearchHitResult } from "../../core/SearchIndex.js";
import type { TopicDetail } from "../../mcp/McpTools.js";
import {
	buildMemoryDetail,
	type MemoryDetailView,
	memoryDetailLines,
	short,
	topicDetailLines,
} from "./MemoriesModel.js";
import { cursorWindow, More, ScrollView, wrapLines } from "./Scrollable.js";
import type { TuiDeps } from "./TuiDeps.js";
import { type TuiStateStore, useKeptState } from "./TuiState.js";
import { fillRows, useTerminalSize } from "./useTerminalSize.js";

/** Two tabs, one component. `memories` = the current branch's committed memories
 *  (browse); `memory-bank` = the repo-wide compiled topics (readable content).
 *  Splitting the scope into two tabs mirrors the VS Code Current-Branch vs
 *  Memory-Bank distinction; each variant is a single view (no sub-nav). State is
 *  namespaced per variant so the two don't collide. */
export type MemoriesVariant = "memories" | "memory-bank";

// Fallback windowed row budgets, used only when the terminal height is unknown
// (tests / height-less streams). On a real terminal every pane GROWS to fill the
// height and shrinks on a short one (see fillRows). MEM_CHROME ≈ the non-list
// rows around a view (tab bar, the bottom command bar, and the status line).
const LIST_ROWS = 8; // browse memory items visible at once
const HITS_ROWS = 12; // search-hit rows
const TOPIC_ROWS = 12; // memory-bank topic rows
const DETAIL_ROWS = 16; // expanded (focused) right-pane rows: memory / topic detail
const DETAIL_MAX_W = 72; // comfortable reading cap for the expanded detail width
const MEM_CHROME = 9;

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function MemoriesScreen({
	deps,
	variant = "memories",
	onCapture,
	onHints,
	active = true,
	store,
	reloadKey = 0,
}: {
	deps: TuiDeps;
	/** Which tab this instance renders — `memories` (browse) or `memory-bank`
	 *  (topics). Defaults to `memories`. */
	variant?: MemoriesVariant;
	onCapture?: (capturing: boolean) => void;
	onHints?: (hints: string) => void;
	/** When false (a shell overlay is open), this screen's keys are paused. */
	active?: boolean;
	/** Shell store so navigation state survives tab switches (see TuiState). */
	store?: TuiStateStore;
	/** Bumped by the shell when a palette command that mutates stored memories
	 *  finishes (e.g. `/backfill --generate`, `/compile`) — these run OUTSIDE the
	 *  post-commit queue worker, so the busy→idle poll never sees them. Each change
	 *  forces a re-read of the list + current detail. */
	reloadKey?: number;
}): ReactElement {
	const isBrowse = variant === "memories";
	// Namespace the kept state so the two tabs' cursors/scroll don't collide.
	const K = isBrowse ? "memories" : "memoryBank";
	// Browse: cursor over the memory list. Topics: topicCursor over the topic list.
	const [cursor, setCursor] = useKeptState(store, `${K}.cursor`, 0);
	const [query, setQuery] = useKeptState<string | null>(store, `${K}.query`, null);
	const [topicCursor, setTopicCursor] = useKeptState(store, `${K}.topicCursor`, 0);
	// Right-pane expand/scroll: `Enter` focuses the detail pane so its `↑↓` scrolls
	// it and its full content is reachable; `esc` collapses. Shared by both variants
	// (each is a separate mounted instance with its own namespaced state).
	const [detailFocused, setDetailFocused] = useKeptState(store, `${K}.detailFocused`, false);
	const [detailScroll, setDetailScroll] = useKeptState(store, `${K}.detailScroll`, 0);
	// Data is reloaded on remount (kept local) — fresh reads are the intent.
	const [items, setItems] = useState<MemoryListItem[] | null>(null);
	const [detail, setDetail] = useState<MemoryDetailView | null>(null);
	const [hits, setHits] = useState<SearchHitResult[]>([]);
	const [topics, setTopics] = useState<ReadonlyArray<string> | null>(null);
	const [topicDetail, setTopicDetail] = useState<TopicDetail | null>(null);
	// `error` is the CORE list-load failure only (full-screen, shown when there's
	// nothing to display). Secondary per-pane loads (detail / search) surface a
	// non-fatal `paneError` inline and keep the last-good view — a transient pane
	// hiccup must never blank the whole screen. One writer each.
	const [error, setError] = useState<string | null>(null);
	const [paneError, setPaneError] = useState<string | null>(null);
	// Search is browse-only and overlays the list while the detail pane is still
	// live, so it gets its OWN error state — closing search only clears the search
	// error, never a live detail error.
	const [searchError, setSearchError] = useState<string | null>(null);

	// Row budgets GROW to fill a tall terminal and shrink to fit a short one (see
	// fillRows). The *_ROWS constants are now just the fallback used when the row
	// count is unknown (tests / height-less streams); on a real terminal every
	// pane expands to the space left after MEM_CHROME.
	const { rows, columns } = useTerminalSize();
	const listRows = fillRows(rows, MEM_CHROME, LIST_ROWS);
	const hitsRows = fillRows(rows, MEM_CHROME, HITS_ROWS);
	const topicRows = fillRows(rows, MEM_CHROME, TOPIC_ROWS);
	const detailRows = fillRows(rows, MEM_CHROME, DETAIL_ROWS);
	// Column budget for the expanded detail pane. Capped at a comfortable reading
	// width so it doesn't sprawl edge-to-edge on a wide terminal; long lines are
	// wrapped to this (see paneLines / PaneExpanded), so long lines show in full
	// across rows instead of being truncated.
	const detailWidth = Math.min(DETAIL_MAX_W, Math.max(24, (columns ?? 80) - 42));

	// ── Browse (memories): load the committed-memory list on mount + reloadKey ──
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount + reloadKey re-load; deps closed over
	useEffect(() => {
		if (!isBrowse) return;
		let alive = true;
		void deps
			.listMemories()
			.then((list) => {
				if (!alive) return;
				setItems(list);
				setError(null);
			})
			.catch((e) => {
				if (alive) setError((e as Error).message);
			});
		return () => {
			alive = false;
		};
	}, [deps, reloadKey, isBrowse]);

	// Browse: auto-refresh the list when summary generation settles (busy→idle edge).
	const wasGenerating = useRef(false);
	useEffect(() => {
		if (!isBrowse) return;
		let alive = true;
		const id = setInterval(() => {
			void deps
				.getQueueStatus()
				.then((q) => {
					if (!alive) return undefined;
					const generating = q.workerBusy || q.active > 0;
					const settled = wasGenerating.current && !generating;
					wasGenerating.current = generating;
					if (!settled) return undefined;
					return deps.listMemories().then((list) => {
						if (!alive) return;
						setItems(list);
						setError(null);
					});
				})
				.catch(() => {
					/* transient read error — keep the last-good list, no red screen */
				});
		}, 2500);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [deps, isBrowse]);

	// ── Memory Bank (topics): load the topic list on mount + reloadKey ──
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey forces a re-load
	useEffect(() => {
		if (isBrowse) return;
		let alive = true;
		void deps
			.listTopics()
			.then((t) => {
				if (!alive) return;
				setTopics(t);
				// Preserve the reader's topic selection across a reloadKey refresh;
				// clamp only, so a shrunk list can't leave the cursor out of range.
				setTopicCursor((c) => Math.min(c, Math.max(0, t.length - 1)));
				setError(null);
			})
			.catch((e) => {
				if (alive) setError((e as Error).message);
			});
		return () => {
			alive = false;
		};
	}, [deps, reloadKey, isBrowse, setTopicCursor]);

	const searching = query !== null && query.trim() !== "";
	const selectedHash = searching ? hits[cursor]?.hash : items?.[cursor]?.hash;

	// Keep the browse cursor in range after the list reloads (reloadKey / busy→idle
	// poll), and re-home it into the browse list when search closes. Gated on
	// `!searching` because `cursor` is SHARED with the search-hit list — those hits
	// span the whole index, not just this branch's heads, so clamping to the shorter
	// browse list mid-search would yank the reader's search selection.
	useEffect(() => {
		if (!isBrowse || searching || items === null) return;
		setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
	}, [items, searching, isBrowse, setCursor]);

	// Browse: load the selected memory's detail. `reloadKey` is a dep so an
	// out-of-queue mutation (`/backfill`, `/compile`) that rewrites the SAME
	// selection's content — without changing its hash (the effect's identity key)
	// — still forces a re-read; otherwise the pane would keep the stale body until
	// the reader manually moved off the entry and back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual refresh trigger, not read in the body
	useEffect(() => {
		if (!isBrowse) return;
		let alive = true;
		if (!selectedHash) {
			setDetail(null);
			return;
		}
		void deps
			.getMemoryDetail(selectedHash)
			.then((s) => {
				if (!alive) return;
				setDetail(s ? buildMemoryDetail(s) : null);
				setPaneError(null);
			})
			.catch((e) => alive && setPaneError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [deps, selectedHash, isBrowse, reloadKey]);

	// Memory Bank: load the selected topic's readable detail (content + timeline).
	// `reloadKey` is a dep for the same reason as the browse detail above: `/compile`
	// regenerates a topic's content while keeping its slug (the effect's identity
	// key) unchanged, so without this the content pane would stay stale.
	const currentTopic = !isBrowse ? topics?.[topicCursor] : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual refresh trigger, not read in the body
	useEffect(() => {
		if (isBrowse) return;
		let alive = true;
		if (!currentTopic) {
			setTopicDetail(null);
			return;
		}
		void deps
			.getTopicDetail(currentTopic)
			.then((d) => {
				if (!alive) return;
				setTopicDetail(d);
				setPaneError(null);
			})
			.catch((e) => alive && setPaneError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [deps, currentTopic, isBrowse, reloadKey]);

	useEffect(() => {
		onCapture?.(query !== null);
	}, [query, onCapture]);

	// Report context-specific key hints to the shell StatusBar.
	useEffect(() => {
		onHints?.(hints(variant, query !== null, detailFocused));
	}, [variant, query, detailFocused, onHints]);

	// Browse: BM25 instant search.
	useEffect(() => {
		if (!isBrowse || query === null || query.trim() === "") {
			setHits([]);
			setSearchError(null);
			return;
		}
		let alive = true;
		void deps
			.searchMemories(query)
			.then((h) => {
				if (!alive) return;
				setHits(h);
				setSearchError(null);
			})
			.catch((e) => alive && setSearchError((e as Error).message));
		return () => {
			alive = false;
		};
	}, [deps, query, isBrowse]);

	// The lines the expanded pane scrolls — memory detail (browse) or topic
	// content + sources (memory-bank). Word-wrapped to the pane width so long
	// lines show in FULL across rows (vertical scroll) instead of being truncated
	// and panned; the wrap here keeps the scroll bound (maxRow) in lockstep with
	// what PaneExpanded renders. Also gates whether `Enter` can expand.
	const rawPaneLines = isBrowse
		? detail
			? memoryDetailLines(detail)
			: []
		: topicDetail
			? topicDetailLines(topicDetail)
			: [];
	const paneLines = wrapLines(rawPaneLines, detailWidth);

	useInput(
		(input, key) => {
			// Browse search field.
			if (query !== null) {
				if (key.escape) {
					setQuery(null);
					setCursor(0);
				} else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
				else if (key.downArrow) setCursor((c) => Math.min(Math.max(0, hits.length - 1), c + 1));
				else if (key.backspace || key.delete) {
					setQuery((q) => (q ?? "").slice(0, -1));
					setCursor(0);
				} else if (input && !key.ctrl && !key.meta && !key.return && !key.tab) {
					setQuery((q) => (q ?? "") + input);
					setCursor(0);
				}
				return;
			}
			// Expanded detail pane: ↑↓ scroll, esc collapses. Content is wrapped, so
			// there is no horizontal pan — the full text is reachable by scrolling.
			if (detailFocused) {
				if (key.escape) return setDetailFocused(false);
				const maxRow = Math.max(0, paneLines.length - detailRows);
				if (key.upArrow || input === "k") setDetailScroll((s) => Math.max(0, s - 1));
				else if (key.downArrow || input === "j") setDetailScroll((s) => Math.min(maxRow, s + 1));
				return;
			}
			// Enter expands the detail pane so its full content is scrollable.
			if (key.return) {
				if (paneLines.length > 0) {
					setDetailScroll(0);
					setDetailFocused(true);
				}
				return;
			}
			if (isBrowse) {
				// `f` (find) opens search — `/` is reserved for the global command palette.
				if (input === "f") {
					setQuery("");
					setCursor(0);
				} else if (items && items.length > 0) {
					if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
					else if (key.downArrow || input === "j") setCursor((c) => Math.min(items.length - 1, c + 1));
				}
			} else if (topics && topics.length > 0) {
				if (key.upArrow || input === "k") setTopicCursor((c) => Math.max(0, c - 1));
				else if (key.downArrow || input === "j") setTopicCursor((c) => Math.min(topics.length - 1, c + 1));
			}
		},
		{ isActive: active },
	);

	// Full-screen error ONLY when the core list couldn't load and there's nothing
	// to show; once a list exists, a later failure keeps the last-good view.
	const listLoaded = isBrowse ? items !== null : topics !== null;
	if (error && !listLoaded) {
		return (
			<Text color="red">
				Failed to load {isBrowse ? "memories" : "topics"}: {error}
			</Text>
		);
	}
	if (!listLoaded) return <Text dimColor>loading…</Text>;

	return (
		<Box flexDirection="column">
			{isBrowse ? (
				<BrowseView
					items={items ?? []}
					cursor={cursor}
					detail={detail}
					query={query}
					hits={hits}
					searching={searching}
					listRows={listRows}
					hitsRows={hitsRows}
					detailFocused={detailFocused}
					detailScroll={detailScroll}
					detailRows={detailRows}
					detailWidth={detailWidth}
				/>
			) : (
				<TopicsView
					topics={topics ?? []}
					topicCursor={topicCursor}
					topicDetail={topicDetail}
					topicRows={topicRows}
					detailFocused={detailFocused}
					detailScroll={detailScroll}
					detailRows={detailRows}
					detailWidth={detailWidth}
				/>
			)}
			{/* Non-fatal per-pane load error — inline, keeps the rest of the screen.
			    Search error while search is open, otherwise the current pane error. */}
			{(query !== null ? searchError : paneError) && (
				<Text color="red">⚠ {query !== null ? searchError : paneError}</Text>
			)}
			{/* Key hints live in the shell StatusBar (reported via onHints). */}
		</Box>
	);
}

/** Context-specific key hints for the shell StatusBar (globals appended there). */
function hints(variant: MemoriesVariant, searchOpen: boolean, expanded: boolean): string {
	if (searchOpen) return "[esc] close search · type to filter";
	if (expanded) return "[↑↓] scroll · [esc] collapse";
	if (variant === "memories") return "[↑↓] move · [f] search · [Enter] open";
	return "[↑↓] topic · [Enter] open"; // memory-bank topics
}

function BrowseView({
	items,
	cursor,
	detail,
	query,
	hits,
	searching,
	listRows,
	hitsRows,
	detailFocused,
	detailScroll,
	detailRows,
	detailWidth,
}: {
	items: MemoryListItem[];
	cursor: number;
	detail: MemoryDetailView | null;
	query: string | null;
	hits: SearchHitResult[];
	searching: boolean;
	listRows: number;
	hitsRows: number;
	detailFocused: boolean;
	detailScroll: number;
	detailRows: number;
	detailWidth: number;
}): ReactElement {
	const itemW = cursorWindow(items.length, listRows, cursor);
	const hitW = cursorWindow(hits.length, hitsRows, cursor);
	return (
		<Box flexDirection="row">
			<Box flexDirection="column" width={36} marginRight={2}>
				{query !== null && (
					<Text>
						<Text color="cyan">/ </Text>
						{query}
						<Text color="cyan">▊</Text>
					</Text>
				)}
				{searching ? (
					hits.length === 0 ? (
						<Text dimColor>no matches</Text>
					) : (
						<>
							<More n={hitW.above} up />
							{hits.slice(hitW.start, hitW.start + hitsRows).map((h, k) => {
								const i = hitW.start + k;
								return (
									<Text key={h.id} color={i === cursor ? "cyan" : undefined}>
										{i === cursor ? "● " : "○ "}
										{truncate(h.title, 30)}
									</Text>
								);
							})}
							<More n={hitW.below} up={false} />
						</>
					)
				) : items.length === 0 ? (
					<Text dimColor>No committed memories on this branch yet.</Text>
				) : (
					<>
						<More n={itemW.above} up />
						{items.slice(itemW.start, itemW.start + listRows).map((it, k) => {
							const i = itemW.start + k;
							return (
								<Box key={it.hash} flexDirection="column">
									<Text color={i === cursor ? "cyan" : undefined}>
										{i === cursor ? "● " : "○ "}
										{truncate(it.title, 30)}
									</Text>
									<Text dimColor>
										{"  "}
										{short(it.hash)} · {it.topicsCount} topics
									</Text>
								</Box>
							);
						})}
						<More n={itemW.below} up={false} />
					</>
				)}
			</Box>
			<Box flexDirection="column" flexGrow={1}>
				{detail ? (
					detailFocused ? (
						<PaneExpanded
							lines={memoryDetailLines(detail)}
							height={detailRows}
							offset={detailScroll}
							width={detailWidth}
						/>
					) : (
						<DetailPane view={detail} maxRows={detailRows} />
					)
				) : (
					<Text dimColor>—</Text>
				)}
			</Box>
		</Box>
	);
}

/** Memory Bank: a topic list + the selected topic's readable content (its page
 *  `content` markdown) with a Sources footer. Collapsed shows the title + a
 *  preview + `[Enter] open`; expanded scrolls the full content (PaneExpanded). */
function TopicsView({
	topics,
	topicCursor,
	topicDetail,
	topicRows,
	detailFocused,
	detailScroll,
	detailRows,
	detailWidth,
}: {
	topics: ReadonlyArray<string>;
	topicCursor: number;
	topicDetail: TopicDetail | null;
	topicRows: number;
	detailFocused: boolean;
	detailScroll: number;
	detailRows: number;
	detailWidth: number;
}): ReactElement {
	if (topics.length === 0) return <Text dimColor>No topics yet.</Text>;
	const w = cursorWindow(topics.length, topicRows, topicCursor);
	const lines = topicDetail ? topicDetailLines(topicDetail) : [];
	// Collapsed preview budget: leave room for the title + the `[Enter] open` hint.
	const PREVIEW = Math.max(3, detailRows - 2);
	return (
		<Box flexDirection="row">
			<Box flexDirection="column" width={30} marginRight={2}>
				<More n={w.above} up />
				{topics.slice(w.start, w.start + topicRows).map((t, k) => {
					const i = w.start + k;
					return (
						<Text key={t} color={i === topicCursor ? "cyan" : undefined}>
							{i === topicCursor ? "● " : "○ "}
							{truncate(t, 26)}
						</Text>
					);
				})}
				<More n={w.below} up={false} />
			</Box>
			<Box flexDirection="column" flexGrow={1}>
				{!topicDetail ? (
					<Text dimColor>loading…</Text>
				) : detailFocused ? (
					<Box flexDirection="column">
						<Text bold>{truncate(topicDetail.title, 52)}</Text>
						<PaneExpanded lines={lines} height={detailRows} offset={detailScroll} width={detailWidth} />
					</Box>
				) : (
					<Box flexDirection="column">
						<Text bold>{truncate(topicDetail.title, 52)}</Text>
						{lines.slice(0, PREVIEW).map((l, i) => (
							<Text key={`${i}-${l.slice(0, 16)}`}>
								{truncate(l, detailWidth) === "" ? " " : truncate(l, detailWidth)}
							</Text>
						))}
						{lines.length > PREVIEW && <Text color="cyan">[Enter] open ({lines.length} lines)</Text>}
					</Box>
				)}
			</Box>
		</Box>
	);
}

/** Expanded (focused) right pane: a scrollable window over pre-flattened lines,
 *  with a focus banner. Shared by the browse detail and topic content panes so
 *  the full body the collapsed panes preview is reachable. Long lines are
 *  word-wrapped to `width` (vertical scroll only) so the full text is visible
 *  across rows instead of being horizontally truncated. */
function PaneExpanded({
	lines,
	height,
	offset,
	width,
}: {
	lines: string[];
	height: number;
	offset: number;
	/** Wrap width for the pane; omit to render lines unwrapped. */
	width?: number;
}): ReactElement {
	const wrapped = typeof width === "number" ? wrapLines(lines, width) : lines;
	return (
		<Box flexDirection="column">
			<Text color="cyan">▾ expanded — [↑↓] scroll · [esc] collapse</Text>
			<ScrollView lines={wrapped} height={height} offset={offset} />
		</Box>
	);
}

// Fallback preview counts used only when the terminal height is unknown (tests /
// height-less streams). On a real terminal DetailPane grows both sections to fill
// the available height (see `maxRows`) instead of leaving a gap below a fixed 4/6.
const DETAIL_DECISIONS = 4;
const DETAIL_FILES = 6;
// Non-list rows in the collapsed pane: title, subtitle, each section's top-margin
// + header (×2), and the [Enter] expand-all line. The two lists share the rest.
const DETAIL_CHROME = 8;

/**
 * How many decisions/files the collapsed DetailPane shows, and whether it is
 * still truncated (→ `[Enter] expand all`). Pure so it is unit-testable without a
 * terminal. The per-section counts GROW to fill `maxRows` (biased toward files,
 * the original 4:6 ratio), each capped at its own content length so an empty
 * section frees its share for the other. `maxRows` undefined (tests / height-less
 * streams) falls back to the fixed 4/6.
 */
export function detailPreviewBudget(
	decisionsLen: number,
	filesLen: number,
	maxRows?: number,
): { decShown: number; filShown: number; overflow: boolean } {
	const budget = maxRows ? Math.max(DETAIL_DECISIONS + DETAIL_FILES, maxRows - DETAIL_CHROME) : undefined;
	const decCap = budget ? Math.max(2, Math.round(budget * 0.4)) : DETAIL_DECISIONS;
	const decShown = Math.min(decisionsLen, decCap);
	const filCap = budget ? Math.max(2, budget - decShown) : DETAIL_FILES;
	const filShown = Math.min(filesLen, filCap);
	return { decShown, filShown, overflow: decisionsLen > decShown || filesLen > filShown };
}

function DetailPane({ view, maxRows }: { view: MemoryDetailView; maxRows?: number }): ReactElement {
	// Collapsed pane: show as much of each section as the height allows. Instead of
	// an unreachable "N more", a single reachable `[Enter] expand all` when either
	// section is still truncated — the expanded pane (PaneExpanded) is fully
	// scrollable.
	const { decShown, filShown, overflow } = detailPreviewBudget(view.decisions.length, view.files.length, maxRows);
	return (
		<Box flexDirection="column">
			<Text bold>{truncate(view.title, 52)}</Text>
			<Text dimColor>{view.subtitle}</Text>
			{view.decisions.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>Decisions</Text>
					{view.decisions.slice(0, decShown).map((d, i) => (
						<Text key={`${i}-${d.slice(0, 8)}`}>· {truncate(d, 60)}</Text>
					))}
				</Box>
			)}
			{view.files.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text bold>Files ({view.files.length})</Text>
					{view.files.slice(0, filShown).map((f) => (
						<Text key={f} dimColor>
							{truncate(f, 58)}
						</Text>
					))}
				</Box>
			)}
			{overflow && (
				<Box marginTop={1}>
					<Text color="cyan">[Enter] expand all</Text>
				</Box>
			)}
		</Box>
	);
}
