import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const {
	aggregateConversationTokenBreakdown,
	aggregateConversationTokens,
	aggregateStats,
	aggregateTurns,
	formatDurationLabel,
	resolveDiffStats,
} = vi.hoisted(() => {
	// Recursive node shape for the token aggregators (types are compile-time
	// only, so this local declaration is fine inside the hoisted factory).
	interface TokNode {
		conversationTokens?: number;
		conversationTokenBreakdown?: { input: number; output: number; cached: number };
		children?: ReadonlyArray<TokNode>;
	}
	// Mirror the real SummaryTree aggregators: the token meter now sums the whole
	// consolidation tree (not the root's own scalar), so the mock must recurse or
	// the meter tests can't exercise the amend/squash-folded-children case.
	const sumTokens = (node: TokNode): number =>
		(node.children ?? []).reduce((a, c) => a + sumTokens(c), node.conversationTokens ?? 0);
	const sumBreakdown = (node: TokNode): { input: number; output: number; cached: number } => {
		const raw = node.conversationTokenBreakdown;
		return (node.children ?? []).reduce(
			(acc, c) => {
				const ch = sumBreakdown(c);
				return { input: acc.input + ch.input, output: acc.output + ch.output, cached: acc.cached + ch.cached };
			},
			{ input: raw?.input ?? 0, output: raw?.output ?? 0, cached: raw?.cached ?? 0 },
		);
	};
	return {
		aggregateConversationTokens: vi.fn(sumTokens),
		aggregateConversationTokenBreakdown: vi.fn(sumBreakdown),
		aggregateStats: vi.fn(() => ({
			insertions: 10,
			deletions: 5,
			filesChanged: 3,
		})),
		aggregateTurns: vi.fn(() => 0),
		formatDurationLabel: vi.fn(() => "2 hours"),
		// resolveDiffStats: new canonical display-stats helper.
		// Default impl mirrors the real helper's fallback: node.diffStats →
		// node.stats → zeros. Source-commit rows with stats-less leaves render
		// as +0 −0, matching the old production behavior.
		resolveDiffStats: vi.fn((node: { diffStats?: unknown; stats?: unknown }) => {
			if (node.diffStats) return node.diffStats;
			if (node.stats) return node.stats;
			return { insertions: 0, deletions: 0, filesChanged: 0 };
		}),
	};
});

const { buildCss } = vi.hoisted(() => ({
	buildCss: vi.fn(() => "/* css */"),
}));

const { buildScript } = vi.hoisted(() => ({
	buildScript: vi.fn(() => "// script"),
}));

const {
	collectSortedTopics,
	escAttr,
	escHtml,
	estimateConversationCostUsd,
	formatDate,
	formatFullDate,
	formatProviderLabel,
	formatSonnetCostEstimate,
	formatTokensCompact,
	getDisplayDate,
	padIndex,
	renderCalloutText,
	timeAgo,
} = vi.hoisted(() => {
	// Mirrors the real TokenCost.ts constants — used only inside the
	// estimateConversationCostUsd mock below.
	const SONNET_INPUT_PER_TOKEN = 3 / 1_000_000;
	const SONNET_OUTPUT_PER_TOKEN = 15 / 1_000_000;
	const SONNET_CACHE_WRITE_PER_TOKEN = 3.75 / 1_000_000;
	return {
		collectSortedTopics: vi.fn(
			(): {
				topics: Array<unknown>;
				sourceNodes: Array<unknown>;
			} => ({
				topics: [],
				sourceNodes: [],
			}),
		),
		escAttr: vi.fn((s: string) => s),
		escHtml: vi.fn((s: string) => s),
		// Mirrors the real TokenCost.ts implementation — these format visible
		// token-meter output the tests assert on, so a stub would break every
		// assertion checking for "1.4M"/"96k"/"≈$X.XX" text in the rendered HTML.
		estimateConversationCostUsd: vi.fn(
			(b: { input: number; output: number; cached: number } | undefined, total: number) =>
				b
					? b.input * SONNET_INPUT_PER_TOKEN +
						b.output * SONNET_OUTPUT_PER_TOKEN +
						b.cached * SONNET_CACHE_WRITE_PER_TOKEN
					: total * SONNET_INPUT_PER_TOKEN,
		),
		formatDate: vi.fn(() => "Jan 1, 2026"),
		formatFullDate: vi.fn(() => "January 1, 2026 at 12:00 PM"),
		// Default to undefined so existing footer assertions stay stable; tests
		// that exercise provider attribution override via .mockReturnValueOnce.
		formatProviderLabel: vi.fn((): string | undefined => undefined),
		formatSonnetCostEstimate: vi.fn((costUsd: number) =>
			costUsd >= 0.01 ? `≈$${costUsd.toFixed(2)}` : "<$0.01",
		),
		formatTokensCompact: vi.fn((n: number) => {
			if (n >= 999_500) {
				return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
			}
			if (n >= 1_000) {
				return `${Math.round(n / 1_000)}k`;
			}
			return String(n);
		}),
		getDisplayDate: vi.fn(
			(e: { generatedAt?: string; commitDate: string }) =>
				e.generatedAt || e.commitDate,
		),
		padIndex: vi.fn((i: number) => String(i + 1).padStart(2, "0")),
		renderCalloutText: vi.fn((s: string) => s),
		timeAgo: vi.fn(() => "3 hours ago"),
	};
});

// ─── vi.mock declarations ───────────────────────────────────────────────────

vi.mock("../../../cli/src/core/SummaryTree.js", () => ({
	aggregateConversationTokenBreakdown,
	aggregateConversationTokens,
	aggregateStats,
	aggregateTurns,
	formatDurationLabel,
	resolveDiffStats,
}));

vi.mock("./SummaryCssBuilder.js", () => ({
	buildCss,
}));

vi.mock("./SummaryScriptBuilder.js", () => ({
	buildScript,
}));

vi.mock("./SummaryUtils.js", () => ({
	collectSortedTopics,
	escAttr,
	escHtml,
	estimateConversationCostUsd,
	formatDate,
	formatFullDate,
	formatProviderLabel,
	formatSonnetCostEstimate,
	formatTokensCompact,
	getDisplayDate,
	padIndex,
	renderCalloutText,
	timeAgo,
}));

// ─── Import SUT ─────────────────────────────────────────────────────────────

import type {
	CommitSummary,
	E2eTestScenario,
	ReferenceCommitRef,
	NoteReference,
	PlanReference,
} from "../../../cli/src/Types.js";
import {
	buildConversationsSection,
	buildContextPanel,
	buildE2eTestSection,
	buildHtml,
	buildJolliRow,
	buildPageTitleAndMetaStrip,
	buildPlansAndNotesSection,
	buildPropTable,
	buildRecapSection,
	buildShipBar,
	buildTokenMeter,
	buildTopicsSection,
	renderTopic,
} from "./SummaryHtmlBuilder.js";
import type { TopicWithDate } from "./SummaryUtils.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Combines the two header-building functions the way `buildHtml` composes them (minus the token meter it inserts between them), for tests that pin the combined header/prop-table output. */
function buildHeader(
	summary: CommitSummary,
	totalFiles: number,
	transcriptHashSet?: ReadonlySet<string>,
): string {
	return `
${buildPageTitleAndMetaStrip(summary)}
${buildPropTable(summary, totalFiles, transcriptHashSet)}`;
}

function makeSummary(overrides?: Partial<CommitSummary>): CommitSummary {
	return {
		version: 3,
		commitHash: "abcdef1234567890abcdef1234567890abcdef12",
		commitMessage: "feat: add new feature",
		commitAuthor: "Test Author",
		commitDate: "2026-01-15T10:00:00Z",
		branch: "feature/test-branch",
		generatedAt: "2026-01-15T10:05:00Z",
		stats: { filesChanged: 3, insertions: 10, deletions: 5 },
		topics: [],
		...overrides,
	};
}

function makeTopic(overrides?: Partial<TopicWithDate>): TopicWithDate {
	return {
		title: "Test Topic",
		trigger: "Something triggered this",
		response: "Here is the response",
		decisions: "Decided to do X",
		...overrides,
	};
}

function makePlan(overrides?: Partial<PlanReference>): PlanReference {
	return {
		slug: "test-plan",
		title: "Test Plan",
		addedAt: "2026-01-15T10:00:00Z",
		updatedAt: "2026-01-15T10:05:00Z",
		...overrides,
	};
}

function makeNote(overrides?: Partial<NoteReference>): NoteReference {
	return {
		id: "test-note",
		title: "Test Note",
		format: "snippet",
		addedAt: "2026-01-15T10:00:00Z",
		updatedAt: "2026-01-15T10:05:00Z",
		...overrides,
	};
}

function makeLinear(
	overrides?: Partial<ReferenceCommitRef> & { ticketId?: string },
): ReferenceCommitRef {
	const { ticketId, archivedKey: archivedKeyOverride, nativeId: nativeIdOverride, ...rest } = overrides ?? {};
	const nativeId = ticketId ?? nativeIdOverride ?? "PROJ-1";
	const archivedKey = archivedKeyOverride
		? (archivedKeyOverride.startsWith("linear:") ? archivedKeyOverride : `linear:${archivedKeyOverride}`)
		: `linear:${nativeId}-abcdef12`;
	return {
		source: "linear",
		title: "Test Linear Issue",
		url: "https://linear.app/jolliai/issue/PROJ-1/test-linear-issue",
		referencedAt: "2026-01-15T10:00:00Z",
		sourceToolName: "mcp__linear__get_issue",
		...rest,
		archivedKey,
		nativeId,
	};
}

function makeScenario(overrides?: Partial<E2eTestScenario>): E2eTestScenario {
	return {
		title: "Test Scenario",
		steps: ["Step 1", "Step 2"],
		expectedResults: ["Result 1"],
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SummaryHtmlBuilder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Restore default mock implementations
		aggregateStats.mockReturnValue({
			insertions: 10,
			deletions: 5,
			filesChanged: 3,
		});
		// Re-install the per-node default impl (clearAllMocks above cleared it).
		resolveDiffStats.mockImplementation(
			(node: { diffStats?: unknown; stats?: unknown }) => {
				if (node.diffStats) return node.diffStats as object;
				if (node.stats) return node.stats as object;
				return { insertions: 0, deletions: 0, filesChanged: 0 };
			},
		);
		aggregateTurns.mockReturnValue(0);
		formatDurationLabel.mockReturnValue("2 hours");
		buildCss.mockReturnValue("/* css */");
		buildScript.mockReturnValue("// script");
		collectSortedTopics.mockReturnValue({
			topics: [],
			sourceNodes: [],
		});
		escAttr.mockImplementation((s: string) => s);
		escHtml.mockImplementation((s: string) => s);
		formatDate.mockReturnValue("Jan 1, 2026");
		formatFullDate.mockReturnValue("January 1, 2026 at 12:00 PM");
		padIndex.mockImplementation((i: number) => String(i + 1).padStart(2, "0"));
		renderCalloutText.mockImplementation((s: string) => s);
		timeAgo.mockReturnValue("3 hours ago");
	});

	// ─── buildHtml ────────────────────────────────────────────────────────────

	describe("buildHtml", () => {
		it("renders a top-level Conversations section and no private drawer", () => {
			const html = buildHtml(makeSummary(), {
				transcriptHashSet: new Set(["t1"]),
			});
			expect(html).toContain("Conversations");
			// 1b: the demoted bottom 'All Conversations' PRIVATE drawer is gone.
			expect(html).not.toContain('id="privateDrawer"');
			expect(html).not.toContain("PRIVATE");
		});

		it("returns a valid HTML document structure", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain('<html lang="en">');
			expect(html).toContain("<head>");
			expect(html).toContain("</head>");
			expect(html).toContain("<body>");
			expect(html).toContain("</body>");
			expect(html).toContain("</html>");
			expect(html).toContain("<title>Commit Memory</title>");
		});

		it("shows a Back-filled badge only for back-filled summaries, with a method-specific tooltip", () => {
			expect(buildHtml(makeSummary())).not.toContain("Back-filled"); // live summary → no badge

			const fileOverlap = buildHtml(makeSummary({ backfilled: true, backfillMethod: "file-overlap" }));
			expect(fileOverlap).toContain('class="meta-backfill"');
			expect(fileOverlap).toContain(">Back-filled<");
			expect(fileOverlap).toContain("conversation that edited these files");

			expect(buildHtml(makeSummary({ backfilled: true, backfillMethod: "time-window" }))).toContain(
				"matched by timing",
			);
			expect(buildHtml(makeSummary({ backfilled: true, backfillMethod: "branch-match" }))).toContain(
				"matched by the branch you were working on",
			);
			expect(buildHtml(makeSummary({ backfilled: true, backfillMethod: "diff-only" }))).toContain(
				"written from the code changes alone",
			);
		});

		it("includes CSS from buildCss() in a style tag", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("<style>/* css */</style>");
			expect(buildCss).toHaveBeenCalled();
		});

		it("includes script from buildScript()", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("<script>// script</script>");
			expect(buildScript).toHaveBeenCalled();
		});

		// Guards the redesign's load-bearing invariant: the presentation re-skin
		// must preserve every element id the client script + replaceSection
		// refresh handlers bind to. A future refactor that drops or renames one
		// of these would silently break push / regenerate / section refreshes.
		it("preserves the structural ids the refresh handlers + redesign depend on", () => {
			const html = buildHtml(makeSummary({ recap: "A recap." }), {
				transcriptHashSet: new Set(["t1"]),
			});
			// New presentation wrappers
			for (const id of [
				"jolliCard",
				"propTable",
				"detailsToggle",
				"memoryPanel",
				"e2ePanel",
				"contextPanel",
			]) {
				expect(html).toContain(`id="${id}"`);
			}
			// The old collapsible-card wrappers are gone (flat Context panel).
			expect(html).not.toContain('id="attachmentsPanel"');
			expect(html).not.toContain('id="plansCard"');
			expect(html).not.toContain('id="sourceCard"');
			// The Create PR flow lives in its own pane (CreatePrHtmlBuilder); the
			// detail panel no longer hosts a PR card.
			expect(html).not.toContain('id="prCard"');
			// privateDrawer is gone; conversations are now a .panel with inline rows
			expect(html).not.toContain('id="privateDrawer"');
			expect(html).toContain("conversations-panel");
			expect(html).toContain('id="conversationsBody"');
			expect(html).toContain('class="ship-bar"');
			expect(html).toContain('class="meta-strip"');
			// Refresh-target sections must keep their ids (replaceSection contract)
			for (const id of [
				"recapSection",
				"topicsSection",
				"e2eTestSection",
				"allConversationsSection",
			]) {
				expect(html).toContain(`id="${id}"`);
			}
			// Relocated controls keep their ids (handlers bind by id, not position)
			expect(html).toContain('id="pushJolliBtn"');
			expect(html).toContain('id="regenerateSummaryBtn"');
			// Sections still emit the trailing <hr class="separator"> that
			// replaceSection relies on as nextElementSibling.
			expect(html).toContain('<hr class="separator"');
		});

		it("includes CSP meta tag when nonce is provided", () => {
			const html = buildHtml(makeSummary(), { nonce: "abc123" });
			expect(html).toContain('http-equiv="Content-Security-Policy"');
			expect(html).toContain("'nonce-abc123'");
			expect(html).toContain("style-src 'nonce-abc123'");
			expect(html).toContain("script-src 'nonce-abc123'");
			expect(html).toContain('<style nonce="abc123">');
			expect(html).toContain('<script nonce="abc123">');
		});

		it("does not include CSP when nonce is undefined", () => {
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("Content-Security-Policy");
			expect(html).not.toContain("nonce=");
		});

		// Codicon font wiring — the redesign uses codicons (ship card,
		// conversation detach, …). The webview never had a codicon
		// stylesheet before this task, so those icons rendered empty.
		// Mirrors SidebarWebviewProvider/HtmlBuilder's working approach:
		// the host computes an asWebviewUri for assets/codicons/codicon.css
		// and threads it in; buildHtml emits the <link> and widens the CSP
		// so the stylesheet (and the .ttf font it loads) are allowed.
		it("emits the codicon <link> tag when codiconCssUri is provided", () => {
			const html = buildHtml(makeSummary(), {
				codiconCssUri: "https://file+.vscode-resource.vscode-cdn.net/ext/assets/codicons/codicon.css",
			});
			expect(html).toContain(
				'<link rel="stylesheet" href="https://file+.vscode-resource.vscode-cdn.net/ext/assets/codicons/codicon.css" />',
			);
		});

		it("omits the codicon <link> tag when codiconCssUri is not provided", () => {
			const html = buildHtml(makeSummary());
			expect(html).not.toContain('<link rel="stylesheet"');
		});

		it("widens the CSP with font-src and the codicon stylesheet source when both nonce and codiconCssUri are provided", () => {
			const html = buildHtml(makeSummary(), {
				nonce: "abc123",
				codiconCssUri: "https://cdn/codicon.css",
				cspSource: "https://cdn",
			});
			expect(html).toContain("style-src 'nonce-abc123' https://cdn");
			expect(html).toContain("font-src https://cdn");
			// nonce script/style CSP must remain intact.
			expect(html).toContain("script-src 'nonce-abc123'");
			expect(html).toContain('<style nonce="abc123">');
		});

		// Whole-panel section order (mockup alignment).
		it("full panel renders sections in mockup order top-to-bottom", () => {
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.ai/x", conversationTokens: 143000 }),
				{ transcriptHashSet: new Set(["a"]) },
			);
			const order = [
				"page-title",
				"meta-strip",
				"tmeter",
				"propTable",
				"ship-bar",
				"memoryPanel",
				"e2ePanel",
				"Conversations",
				"Context",
				"Files",
				"transcript-privacy",
			];
			let last = -1;
			for (const marker of order) {
				const i = html.indexOf(marker);
				expect(i, marker).toBeGreaterThan(last);
				last = i;
			}
		});

		// ─── Foreign-repo read-only mode ──────────────────────────────────────
		// When the panel renders a summary that came from a non-current repo
		// (Memory Bank cross-repo lookup), every destructive control must be
		// removed from the UI rather than just denied at the message layer —
		// users should never see a Push / Edit / Delete affordance they can't
		// actually use. SummaryHtmlBuilder exposes a hook class
		// `foreign-readonly` on the .page root; SummaryCssBuilder owns the
		// matching `display: none` rules. The default (no foreignRepoName)
		// path stays free of foreign markup so non-foreign panels are
		// untouched.
		describe("foreign-repo read-only mode", () => {
			it("adds the foreign-readonly hook class on the .page root when foreignRepoName is set", () => {
				const html = buildHtml(makeSummary(), {
					foreignRepoName: "other-repo",
				});
				expect(html).toMatch(/class="page foreign-readonly"/);
			});

			it("renders no foreign-readonly markup when foreignRepoName is omitted", () => {
				const html = buildHtml(makeSummary());
				expect(html).not.toContain("foreign-readonly");
			});

			// The old modal-based "Manage"/"View" conversations flow is gone
			// (Task 7 inline rows). Conversations are now inline .row elements
			// rendered client-side; the panel shell is identical in both modes,
			// and per-row detach is gated in the client + host, not the markup.
			// So neither mode emits the modal / Manage / View chip anymore.
			it("neither mode emits the retired modal / Manage / View conversations chrome", () => {
				const foreign = buildHtml(makeSummary(), {
					foreignRepoName: "other-repo",
					transcriptHashSet: new Set(["t1"]),
				});
				const local = buildHtml(makeSummary(), {
					transcriptHashSet: new Set(["t1"]),
				});
				for (const html of [foreign, local]) {
					expect(html).not.toContain('id="openTranscriptsBtn"');
					expect(html).not.toContain('id="transcriptModal"');
					expect(html).not.toContain('id="modalCloseBtn"');
					expect(html).not.toContain('id="modalSaveBtn"');
					expect(html).not.toContain('id="deleteTranscriptsBtn"');
					expect(html).not.toContain(">Manage<");
					expect(html).not.toContain("private-zone");
				}
			});

			it("Regenerate is header-gated: present locally, dropped in foreign mode", () => {
				const local = buildHtml(makeSummary(), {
					transcriptHashSet: new Set(["t1"]),
				});
				expect(local).toContain('id="regenerateSummaryBtn"');
				const foreign = buildHtml(makeSummary(), {
					foreignRepoName: "other-repo",
					transcriptHashSet: new Set(["t1"]),
				});
				// Regenerate writes the orphan branch of the wrong repo cross-repo,
				// so it's dropped from the DOM (the Memory panel header omits it
				// when isForeign — see buildMemoryPanel).
				expect(foreign).not.toContain('id="regenerateSummaryBtn"');
			});

			it("adds the stale-readonly hook class and stale banner when staleRewrittenInto is set", () => {
				// Pins SummaryHtmlBuilder.ts L95 (pageClasses push) and L114
				// (staleBannerHtml ternary TRUE arm). Existing tests cover the
				// FALSE arm via the default `makeSummary()` call.
				const newHash = "1234567890abcdef1234567890abcdef12345678";
				const html = buildHtml(makeSummary(), {
					staleRewrittenInto: newHash,
				});
				expect(html).toMatch(/class="page stale-readonly"/);
				expect(html).toContain('class="stale-banner"');
				expect(html).toContain("12345678");
			});

			it("does NOT mark the Share button foreign-safe, so read-only modes hide it", () => {
				// The share modal's close button is not foreign-safe, so a Share
				// trigger left clickable in a read-only mode would open a modal the
				// user can't dismiss via its X. Sharing is also server-denied for
				// foreign commits and guarded for stale ones, so the trigger must be
				// hidden in read-only modes — i.e. it must NOT carry data-foreign-safe
				// (the .{foreign,stale,regenerating}-readonly CSS then hides it).
				const html = buildHtml(makeSummary(), { foreignRepoName: "other-repo" });
				const shareBtnTag = html.match(/<button[^>]*id="metaShareBtn"[^>]*>/)?.[0] ?? "";
				expect(shareBtnTag).toContain('id="metaShareBtn"');
				expect(shareBtnTag).not.toContain("data-foreign-safe");
			});

			it("emits both foreign-readonly and stale-readonly when both options are set", () => {
				// Cross-product: foreign repo whose source commit was also
				// rewritten. The class list must include both hooks so the
				// CSS rules at SummaryCssBuilder pick up either selector.
				const html = buildHtml(makeSummary(), {
					foreignRepoName: "other-repo",
					staleRewrittenInto: "feedface0000000000000000000000000000face",
				});
				expect(html).toMatch(/class="page foreign-readonly stale-readonly"/);
			});

			// ─── Task 4–10 new-control gating (Task 11 verification) ────────────
			// Destructive/write controls added by prior tasks must NOT carry
			// data-foreign-safe, so the existing CSS rule
			// `.page.foreign-readonly button:not([data-foreign-safe])` (and the
			// stale-readonly twin) hides them. `.conv-detach` is rendered
			// client-side (SummaryScriptBuilder), so it is asserted against the
			// script source rather than buildHtml's output.
			it("Context panel's + Add button does not carry data-foreign-safe (destructive: adds plan/note/snippet)", () => {
				const html = buildHtml(makeSummary());
				expect(html).toMatch(
					/<button class="action-btn panel-add add-dropdown-toggle" data-action="toggleAddMenu" title="[^"]*"><span class="codicon codicon-add"><\/span><\/button>/,
				);
			});

			it("plan/note/reference remove buttons in the Context panel do not carry data-foreign-safe", () => {
				const html = buildHtml(
					makeSummary({
						plans: [makePlan()],
						notes: [makeNote()],
						references: [makeLinear()],
					}),
				);
				const removeButtons = html.match(/<button class="icon-btn topic-action-btn plan-remove-btn"[^>]*>/g) ?? [];
				expect(removeButtons.length).toBeGreaterThan(0);
				for (const btn of removeButtons) {
					expect(btn).not.toContain("data-foreign-safe");
				}
			});

			// Read-only controls that must stay usable in foreign/stale mode: the
			// `?` token-usage help popover is a pure client-side toggle (no
			// postMessage — see SummaryScriptBuilder's tok-help handler), so it
			// belongs on the safe list alongside Details/Export/Copy.
			it("token-meter help toggle (tok-help) carries data-foreign-safe so it stays visible in foreign/stale mode", () => {
				const html = buildHtml(makeSummary({ conversationTokens: 1000 }));
				expect(html).toMatch(/<button class="tok-help" type="button" data-foreign-safe>/);
			});
		});

		// `SourceId` is now `string`, so `getSourceMeta` will hand back the raw id
		// as the label for an unknown source. That raw id never reaches the DOM
		// here because `referencesBySourceOrder` renders only the four known
		// sources — the source-allowlist, not escaping, is what keeps a crafted
		// source string (from a tampered orphan branch / shared Memory Bank) out
		// of the webview. Pin that invariant so a future refactor that drops the
		// allowlist can't silently turn the bare source label into an injection.
		it("drops an unknown reference source from the HTML view (source allowlist)", () => {
			const html = buildHtml(
				makeSummary({
					references: [makeLinear({ source: 'x"><img src=x onerror=alert(1)>', archivedKey: "x:PROJ-9" })],
				}),
			);
			// Absent in ANY form — raw or escaped. (If the allowlist were dropped
			// the row would render; the source label is escaped, but "onerror"
			// itself has no escapable chars, so it would still surface as text.)
			expect(html).not.toContain("onerror");
		});

		it('shows "No topics available" message when topics are empty', () => {
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [],
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("No topics available for this commit.");
		});

		it("renders topics without timeline for a single topic", () => {
			const topic = makeTopic();
			collectSortedTopics.mockReturnValue({
				topics: [topic],
				sourceNodes: [makeSummary()],
			});
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("timeline");
			// renderTopic is called directly — verify by checking for toggle structure
			expect(html).toContain("toggle");
		});

		it("renders multiple topics as a flat list (no timeline grouping)", () => {
			const topics = [
				makeTopic({ title: "Topic 1", commitDate: "2026-01-15T10:00:00Z" }),
				makeTopic({ title: "Topic 2", commitDate: "2026-01-14T10:00:00Z" }),
			];
			collectSortedTopics.mockReturnValue({
				topics,
				sourceNodes: [makeSummary(), makeSummary()],
			});
			const html = buildHtml(makeSummary());
			// Flat-list mode: no timeline-group / timeline-header markup.
			expect(html).not.toContain("timeline-group");
			expect(html).not.toContain("timeline-header");
			expect(html).toContain("toggle");
		});

		it('shows correct section header count — "1 topic" for singular', () => {
			collectSortedTopics.mockReturnValue({
				topics: [makeTopic()],
				sourceNodes: [makeSummary()],
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("Topic");
			expect(html).toContain("1 topic extracted from this commit");
		});

		it('shows correct section header count — "3 topics" for plural', () => {
			collectSortedTopics.mockReturnValue({
				topics: [makeTopic(), makeTopic(), makeTopic()],
				sourceNodes: [makeSummary()],
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("Topics");
			expect(html).toContain("3 topics extracted from this commit");
		});

		it("header includes commit hash, branch, author, date", () => {
			const summary = makeSummary({
				commitHash: "deadbeef12345678deadbeef12345678deadbeef",
				branch: "main",
				commitAuthor: "Jane Doe",
				commitDate: "2026-03-01T08:00:00Z",
			});
			const html = buildHtml(summary);
			// Hash is substring(0,8)
			expect(html).toContain("deadbeef");
			expect(html).toContain("main");
			expect(html).toContain("Jane Doe");
			// timeAgo and formatFullDate are mocked
			expect(html).toContain("3 hours ago");
			expect(html).toContain("January 1, 2026 at 12:00 PM");
		});

		it("does not show a turns badge in the header regardless of turn count", () => {
			// The header redesign drops the inline turns badge entirely — the
			// Details table's "Linked" row now reports conversation *count*
			// (transcriptHashSet.size), not turn count. The "All Conversations"
			// section below the header still exists and is unaffected.
			aggregateTurns.mockReturnValue(5);
			const html = buildHtml(makeSummary());
			expect(html).toContain("Conversations");
			expect(html).not.toContain("stat-turns");
		});

		it("shows Jolli Memory row when jolliDocUrl is set", () => {
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123" }),
			);
			expect(html).toContain("Jolli Memory");
			expect(html).toContain("https://jolli.app/memory/123");
			expect(html).toContain('id="jolliRow"');
		});

		it("does not show Jolli Memory row when jolliDocUrl is undefined", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: undefined }));
			expect(html).not.toContain("jolliRow");
		});

		it("shows Jolli Memory row with published plans links", () => {
			const plans: Array<PlanReference> = [
				makePlan({
					slug: "plan-a",
					title: "Plan A",
					jolliPlanDocUrl: "https://jolli.app/plan/a",
				}),
				makePlan({
					slug: "plan-b",
					title: "Plan B",
					jolliPlanDocUrl: undefined,
				}),
			];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", plans }),
			);
			expect(html).toContain("https://jolli.app/plan/a");
			expect(html).toContain("jolli-plans-block");
		});

		it("shows push label 'Update on Jolli' when jolliDocUrl exists", () => {
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123" }),
			);
			expect(html).toContain("Update on Jolli");
		});

		it("the synced button carries no data-jolli-open (it pushes/updates, never opens)", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: "https://jolli.app/memory/123" }));
			expect(html).toMatch(/id="pushJolliBtn"/);
			expect(html).not.toContain("data-jolli-open");
		});

		it("shows push label 'Push to Jolli' when jolliDocUrl is undefined", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: undefined }));
			expect(html).toContain("Push to Jolli");
		});

		it("omits data-jolli-open when not yet synced (button pushes, not opens)", () => {
			const html = buildHtml(makeSummary({ jolliDocUrl: undefined }));
			expect(html).not.toContain("data-jolli-open");
		});

		it("shows commit message tooltip in Jolli Memory row", () => {
			const html = buildHtml(
				makeSummary({
					jolliDocUrl: "https://jolli.app/memory/123",
					commitMessage: "feat: something",
				}),
			);
			expect(html).toContain("feat: something");
		});

		it("shows 'View on Jolli' tooltip when commitMessage is empty", () => {
			const html = buildHtml(
				makeSummary({
					jolliDocUrl: "https://jolli.app/memory/123",
					commitMessage: "",
				}),
			);
			expect(html).toContain("View on Jolli");
		});

		it("shows Jolli Memory row without plans block when no published plan URLs", () => {
			const plans = [makePlan({ jolliPlanDocUrl: undefined })];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", plans }),
			);
			expect(html).toContain("jolliRow");
			expect(html).not.toContain("jolli-plans-block");
		});

		it("shows Jolli Memory row with published notes links", () => {
			const notes = [
				makeNote({
					id: "note-a",
					title: "Note A",
					jolliNoteDocUrl: "https://jolli.app/note/a",
				}),
				makeNote({ id: "note-b", title: "Note B", jolliNoteDocUrl: undefined }),
			];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", notes }),
			);
			expect(html).toContain("https://jolli.app/note/a");
			expect(html).toContain("jolli-plans-block");
			expect(html).toContain('<span class="jolli-plans-label">Context</span>');
		});

		it("omits notes block when no published note URLs", () => {
			const notes = [makeNote({ jolliNoteDocUrl: undefined })];
			const html = buildHtml(
				makeSummary({ jolliDocUrl: "https://jolli.app/memory/123", notes }),
			);
			// Should not show a notes block, only jolli row
			const jolliSection = html.slice(
				html.indexOf("jolliRow"),
				html.indexOf("jolliRow") + 500,
			);
			expect(jolliSection).not.toContain("jolli-plans-label");
		});

		it("plans section is always present with 'No plans or notes' placeholder when empty", () => {
			const html = buildHtml(makeSummary({ plans: undefined }));
			expect(html).toContain("plansAndNotesSection");
			expect(html).toContain(
				"No plans or notes associated with this commit yet.",
			);
			expect(html).toContain('<span class="codicon codicon-add"></span>');
		});

		it("plans section renders plan items", () => {
			const plans = [
				makePlan({ slug: "my-plan", title: "My Plan" }),
			];
			// collectSortedTopics returns empty topics, but the plans appear via buildPlansSection
			const html = buildHtml(makeSummary({ plans }));
			expect(html).toContain("my-plan");
			expect(html).toContain("My Plan");
			expect(html).toContain("my-plan.md");
			expect(html).not.toContain("edited");
		});

		it("notes section renders snippet note with content preview", () => {
			const notes = [
				makeNote({
					id: "snip-1",
					title: "My Snippet",
					format: "snippet",
					content: "Hello world",
				}),
			];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain("snip-1");
			expect(html).toContain("My Snippet");
			expect(html).toContain("snippet");
			expect(html).toContain("Hello world");
		});

		it("notes section renders markdown note with filename fallback", () => {
			const notes = [
				makeNote({ id: "md-1", title: "My Markdown", format: "markdown" }),
			];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain("md-1");
			expect(html).toContain("My Markdown");
			expect(html).toContain("markdown");
			expect(html).toContain("md-1.md");
		});

		it("notes section includes remove button with data attributes", () => {
			const notes = [makeNote({ id: "rm-note", title: "Remove Me" })];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain('data-action="removeNote"');
			expect(html).toContain('data-note-id="rm-note"');
			expect(html).toContain('data-note-title="Remove Me"');
		});

		it("linear issues section renders ticketId, title, and upstream URL", () => {
			// Linear issue rows are auto-captured by QueueWorker; the WebView
			// needs to surface them under the same "Plans & Notes" header so
			// reviewers see them alongside plans/notes when reading a commit.
			const linearIssues = [
				makeLinear({
					archivedKey: "PROJ-1528-786c5330",
					ticketId: "PROJ-1528",
					title: "Treat referenced Linear issues as a first-class panel item",
					url: "https://linear.app/jolliai/issue/PROJ-1528/treat-referenced-linear-issues-as-a-first-class-panel-item-and",
				}),
			];
			const html = buildHtml(makeSummary({ references: linearIssues }));

			expect(html).toContain("PROJ-1528");
			expect(html).toContain(
				"Treat referenced Linear issues as a first-class panel item",
			);
			expect(html).toContain(
				"https://linear.app/jolliai/issue/PROJ-1528/treat-referenced-linear-issues-as-a-first-class-panel-item-and",
			);
			// Post-Task-2.13 the row id is namespaced by source so multi-source
			// rows can coexist without collisions.
			expect(html).toContain('id="reference-linear-PROJ-1528-786c5330"');
		});

		it("entity rows wire the full Plan-parity action set (Choice A: no Linear-specific message names)", () => {
			// Every entity row now exposes the source-agnostic *Entity data-
			// actions so the SummaryScriptBuilder click delegation routes
			// Linear / Jira / GitHub / Notion through the same code path.
			// Removing any of these data-action names would silently break
			// the button it backs.
			const linearIssues = [
				makeLinear({
					archivedKey: "PROJ-9-aaaaaaaa",
					ticketId: "PROJ-9",
					url: "https://linear.app/x/issue/PROJ-9/test",
				}),
			];
			const html = buildHtml(makeSummary({ references: linearIssues }));

			// The 6 actions emitted on every row (translate is conditional):
			// previewReference, openReferenceExternal, loadReferenceContent,
			// saveReferenceEdit, cancelReferenceEdit, removeReference.
			expect(html).toContain('data-action="previewReference"');
			expect(html).toContain('data-action="openReferenceExternal"');
			expect(html).toContain('data-action="loadReferenceContent"');
			expect(html).toContain('data-action="saveReferenceEdit"');
			expect(html).toContain('data-action="cancelReferenceEdit"');
			expect(html).toContain('data-action="removeReference"');

			// data-reference-* attributes carry the dispatch payload. legacyLinear-
			// IssuesToReferenceCommitRefs prepends the `linear:` source prefix to
			// the archivedKey before it reaches the renderer.
			expect(html).toContain('data-reference-key="linear:PROJ-9-aaaaaaaa"');
			expect(html).toContain('data-reference-source="linear"');
			expect(html).toContain('data-reference-native-id="PROJ-9"');
			expect(html).toContain(
				'data-reference-url="https://linear.app/x/issue/PROJ-9/test"',
			);

			// Choice A: the 3 legacy Linear-specific data-actions are gone.
			expect(html).not.toContain('data-action="openLinearIssue"');
			expect(html).not.toContain('data-action="openLinearIssueMarkdown"');
			expect(html).not.toContain('data-action="removeLinearIssue"');
		});

		it("renders a Linear entity with a legacy bare archivedKey (no `linear:` prefix)", () => {
			// Pins the bare-key FALSE arm of buildReferenceRow's prefix-strip:
			// when an old summary stored its archivedKey in the pre-multi-
			// source bare form (`PROJ-7-aaaa1111` without `linear:`), the
			// renderer keeps the DOM id keyed off the bare form. The
			// data-reference-key carries the exact archivedKey as stored so the
			// host can round-trip it back to readReferenceFromBranch.
			const entities: ReadonlyArray<ReferenceCommitRef> = [
				{
					archivedKey: "PROJ-7-aaaa1111",
					source: "linear",
					nativeId: "PROJ-7",
					title: "Bare-key linear",
					url: "https://linear.app/x/issue/PROJ-7/bare",
					referencedAt: "2026-01-15T10:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				},
			];
			const html = buildHtml(makeSummary({ references: entities }));
			expect(html).toContain('id="reference-linear-PROJ-7-aaaa1111"');
			expect(html).toContain('data-reference-key="PROJ-7-aaaa1111"');
			// Must NOT introduce the `linear:` prefix where the source data
			// didn't have one.
			expect(html).not.toContain("entity-linear-linear:PROJ-7");
		});

		it("renders multi-source entities (linear → jira → github → notion → slack) with grouped order", () => {
			// Multi-source replacement for the legacy linearIssues path: the
			// renderer consumes summary.entities and groups by source so the
			// row order is deterministic across regenerations.
			const entities: ReadonlyArray<ReferenceCommitRef> = [
				{
					archivedKey: "notion:abcdef12-aaaa1111",
					source: "notion",
					nativeId: "abcdef12",
					title: "Notion page",
					url: "https://notion.so/abcdef12",
					referencedAt: "2026-01-15T10:00:00Z",
					sourceToolName: "mcp__claude_ai_Notion__notion-fetch",
				},
				{
					archivedKey: "jira:KAN-5-aaaa1111",
					source: "jira",
					nativeId: "KAN-5",
					title: "Jira ticket",
					url: "https://example.atlassian.net/browse/KAN-5",
					referencedAt: "2026-01-15T10:00:00Z",
					sourceToolName: "mcp__claude_ai_Atlassian__getJiraIssue",
				},
				{
					archivedKey: "linear:PROJ-7-aaaa1111",
					source: "linear",
					nativeId: "PROJ-7",
					title: "Linear ticket",
					url: "https://linear.app/x/issue/PROJ-7/linear-ticket",
					referencedAt: "2026-01-15T10:00:00Z",
					sourceToolName: "mcp__linear__get_issue",
				},
				{
					archivedKey: "github:owner/repo#42-aaaa1111",
					source: "github",
					nativeId: "owner/repo#42",
					title: "GitHub issue",
					url: "https://github.com/owner/repo/issues/42",
					referencedAt: "2026-01-15T10:00:00Z",
					sourceToolName: "mcp__github__issue_read",
				},
				{
					archivedKey: "slack:1704067200.000100-aaaa1111",
					source: "slack",
					nativeId: "1704067200.000100",
					title: "Slack message",
					url: "https://example.slack.com/archives/C123456/p1704067200000100",
					referencedAt: "2026-01-15T10:00:00Z",
					sourceToolName: "mcp__claude_ai_Slack__slack_read_thread",
				},
			];
			const html = buildHtml(makeSummary({ references: entities }));

			// DOM id form: the `<source>:` prefix is stripped uniformly across
			// every source so the id reads `reference-<source>-<bareKey>`.
			expect(html).toContain('id="reference-linear-PROJ-7-aaaa1111"');
			expect(html).toContain('id="reference-jira-KAN-5-aaaa1111"');
			expect(html).toContain('id="reference-github-owner/repo#42-aaaa1111"');
			expect(html).toContain('id="reference-notion-abcdef12-aaaa1111"');
			expect(html).toContain('id="reference-slack-1704067200.000100-aaaa1111"');

			// Order: linear < jira < github < notion < slack regardless of input order.
			const iLinear = html.indexOf("reference-linear-");
			const iJira = html.indexOf("reference-jira-");
			const iGithub = html.indexOf("reference-github-");
			const iNotion = html.indexOf("reference-notion-");
			const iSlack = html.indexOf("reference-slack-");
			expect(iLinear).toBeGreaterThan(-1);
			expect(iJira).toBeGreaterThan(iLinear);
			expect(iGithub).toBeGreaterThan(iJira);
			expect(iNotion).toBeGreaterThan(iGithub);
			expect(iSlack).toBeGreaterThan(iNotion);

			// Every row now goes through previewEntity (title click) +
			// openEntityExternal (🌍 button) — the upstream URL flows as
			// data-reference-url instead of as an anchor href, so the click is
			// intercepted by the host (which validates the http(s) scheme).
			expect(html).toContain(
				'data-reference-url="https://example.atlassian.net/browse/KAN-5"',
			);
			expect(html).toContain(
				'data-reference-url="https://github.com/owner/repo/issues/42"',
			);
			expect(html).toContain('data-reference-url="https://notion.so/abcdef12"');
			expect(html).toContain(
				'data-reference-url="https://example.slack.com/archives/C123456/p1704067200000100"',
			);

			// The r-title leads with the nativeId only for the issue trackers.
			// escHtml leaves the em-dash literal (it is not an HTML metachar).
			expect(html).toContain(">PROJ-7 — Linear ticket</a>");
			expect(html).toContain(">owner/repo#42 — GitHub issue</a>");
			// Notion / Slack lead with the title alone (machine-id nativeId dropped
			// from the r-title — and the `<nativeId> (Source)` metaline is omitted too).
			expect(html).toContain(">Notion page</a>");
			expect(html).toContain(">Slack message</a>");
				// The `<nativeId> (Source)` metaline is kept only for the trackers;
				// omitted entirely for machine-id sources (Notion / Slack).
				expect(html).toContain(">PROJ-7 (Linear)</div>");
				expect(html).not.toContain("(Notion)");
				expect(html).not.toContain("(Slack)");
			expect(html).not.toContain("abcdef12 — Notion page");
			expect(html).not.toContain("1704067200.000100 — Slack message");
		});

		it("linear issues count rolls into the section header count badge", () => {
			// Header reads "Plans & Notes (N)" where N = plans + notes + linears
			// (≥2 triggers the badge). Without the fold-in, the badge would
			// undercount and look inconsistent with the rendered rows.
			const html = buildHtml(
				makeSummary({
					plans: [makePlan({ slug: "p1" })],
					references: [
						makeLinear({
							archivedKey: "PROJ-1-aaaaaaaa",
							ticketId: "PROJ-1",
						}),
						makeLinear({
							archivedKey: "PROJ-2-aaaaaaaa",
							ticketId: "PROJ-2",
						}),
					],
				}),
			);

			expect(html).toContain('<span class="section-count">3</span>');
		});

		it("plans section shows count badge when more than 1 plan", () => {
			const plans = [makePlan({ slug: "p1" }), makePlan({ slug: "p2" })];
			const html = buildHtml(makeSummary({ plans }));
			expect(html).toContain('class="section-count">2</span>');
		});

		it("plans section omits count badge when exactly 1 plan", () => {
			const plans = [makePlan()];
			const html = buildHtml(makeSummary({ plans }));
			// The Plans section title should not contain section-count
			const plansHeader = html.slice(
				html.indexOf("Plans"),
				html.indexOf("Plans") + 100,
			);
			expect(plansHeader).not.toContain("section-count");
		});

		it("note titles are clickable preview links", () => {
			const notes = [makeNote({ id: "preview-note", title: "Preview Me" })];
			const html = buildHtml(makeSummary({ notes }));
			expect(html).toContain('data-action="previewNote"');
			expect(html).toContain('data-note-id="preview-note"');
			expect(html).toContain("plan-title-link");
		});

		it("note items show translate button when id is in noteTranslateSet", () => {
			const notes = [makeNote({ id: "translate-note" })];
			const noteTranslateSet = new Set(["translate-note"]);
			const html = buildHtml(makeSummary({ notes }), { noteTranslateSet });
			expect(html).toContain("note-translate-btn");
			expect(html).toContain("Translate to English");
		});

		it("note items do not show translate button when id is not in noteTranslateSet", () => {
			const notes = [makeNote({ id: "no-translate" })];
			const noteTranslateSet = new Set(["other-note"]);
			const html = buildHtml(makeSummary({ notes }), { noteTranslateSet });
			expect(html).not.toContain("note-translate-btn");
		});

		it("plan items show translate button when slug is in planTranslateSet", () => {
			const plans = [makePlan({ slug: "translate-me" })];
			const translateSet = new Set(["translate-me"]);
			const html = buildHtml(makeSummary({ plans }), {
				planTranslateSet: translateSet,
			});
			expect(html).toContain("plan-translate-btn");
			expect(html).toContain("Translate to English");
		});

		it("plan items do not show translate button when slug is not in planTranslateSet", () => {
			const plans = [makePlan({ slug: "no-translate" })];
			const translateSet = new Set(["other-slug"]);
			const html = buildHtml(makeSummary({ plans }), {
				planTranslateSet: translateSet,
			});
			expect(html).not.toContain("plan-translate-btn");
		});

		it("E2E test section with no scenarios shows generate button", () => {
			const html = buildHtml(makeSummary({ e2eTestGuide: undefined }));
			expect(html).toContain("e2eTestSection");
			expect(html).toContain("generateE2eBtn");
			expect(html).toContain("Generate");
		});

		it("E2E test section with scenarios shows section toolbar (collapse-all + regen + delete)", () => {
			const scenarios = [makeScenario()];
			const html = buildHtml(makeSummary({ e2eTestGuide: scenarios }));
			// Section toolbar: collapse-all + regen + delete (no bulk-edit anymore).
			expect(html).toContain("toggleAllE2eBtn");
			expect(html).toContain("regenE2eBtn");
			expect(html).toContain("deleteE2eBtn");
			expect(html).not.toContain("editE2eBtn");
			// Per-scenario actions live on the scenario row.
			expect(html).toContain("e2e-edit-btn");
			expect(html).toContain("e2e-delete-btn");
		});

		// Source Commits was dropped entirely from the redesigned Context panel
		// (mockup has no Source Commits section). buildHtml no longer renders it
		// regardless of how many sourceNodes collectSortedTopics returns.
		it("never renders Source Commits, even for multi-source summaries", () => {
			const source1 = makeSummary({
				commitHash: "aaaa1111bbbb2222cccc3333dddd4444eeee5555",
				commitMessage: "first commit",
				conversationTurns: 3,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
			});
			const source2 = makeSummary({
				commitHash: "ffff6666aaaa7777bbbb8888cccc9999dddd0000",
				commitMessage: "second commit",
				stats: { filesChanged: 2, insertions: 8, deletions: 1 },
			});
			collectSortedTopics.mockReturnValue({
				topics: [],
				sourceNodes: [source1, source2],
			});
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("Source Commits");
			expect(html).not.toContain("commit-list");
		});

		describe("context panel (buildContextPanel)", () => {
			it("context panel is flat rows with kb-tags and no collapsible cards or source commits", () => {
				const html = buildContextPanel(
					makeSummary({ plans: [makePlan()], references: [makeLinear()] }),
				);
				expect(html).toContain('class="panel"');
				expect(html).toContain("Context");
				expect(html).toContain("kb-tag t-plan");
				expect(html).toContain("kb-tag t-ref");
				expect(html).toContain('<span class="codicon codicon-add"></span>');
				expect(html).not.toContain("attach-card");
				expect(html).not.toContain("Source Commits");
			});

			it("keeps the #plansAndNotesSection id re-parented into the flat panel", () => {
				const html = buildContextPanel(makeSummary({ plans: [makePlan()] }));
				expect(html).toContain('id="plansAndNotesSection"');
			});

			it("panel header shows the sec-count chip totalling plans + notes + references", () => {
				const html = buildContextPanel(
					makeSummary({
						plans: [makePlan()],
						notes: [makeNote()],
						references: [makeLinear()],
					}),
				);
				expect(html).toContain('<span class="sec-count">3</span>');
			});

			it("renders the translate button for a reference in the referenceTranslateSet", () => {
				const ref = makeLinear();
				const html = buildContextPanel(
					makeSummary({ references: [ref] }),
					undefined,
					undefined,
					new Set([ref.archivedKey]),
				);
				// showTranslate === true arm: the 🌐 translate button is emitted.
				expect(html).toContain("reference-translate-btn");
				expect(html).toContain('data-action="translateReference"');
			});

			it("renders a reference with no url (defensive — no shipping source emits one) with an empty data-reference-url", () => {
				// ReferenceCommitRef.url is optional in the type but every shipping
				// source requires it, so this is a defensive case — buildReferenceRow
				// must not blow up or emit the literal string "undefined" into the
				// Open-in-<Source> button's data attribute.
				const html = buildHtml(makeSummary({ references: [makeLinear({ url: undefined })] }));
				expect(html).toContain('data-reference-url=""');
				expect(html).not.toContain('data-reference-url="undefined"');
			});

			it("does not render a plansCard or sourceCard wrapper id", () => {
				const html = buildContextPanel(makeSummary({ plans: [makePlan()] }));
				expect(html).not.toContain('id="plansCard"');
				expect(html).not.toContain('id="sourceCard"');
			});

			it("inlines an AI-excluded item as a read-only row (Excluded chip + reason, no actions)", () => {
				const html = buildContextPanel(
					makeSummary({
						excludedContext: [
							{ kind: "note", key: "n1", title: "Cursor Support", reason: "unrelated to graph change", tier: "low" },
						],
					}),
				);
				// Inline row replaces the old collapsed "AI excluded N" details block.
				expect(html).not.toContain("AI excluded 1 unrelated context item(s)");
				expect(html).toContain('class="row plan-item ai-ex-row"');
				expect(html).toContain("Cursor Support");
				expect(html).toContain("unrelated to graph change");
				expect(html).toContain('class="ctx-tier ctx-tier--ex"');
				// Read-only: no preview link, no edit/remove actions on the row.
				const row = html.slice(html.indexOf("ai-ex-row"), html.indexOf("snippet-form"));
				expect(row).not.toContain("data-action=");
			});

			it("renders the Context section for an excluded-only summary (no kept rows)", () => {
				const html = buildContextPanel(
					makeSummary({
						excludedContext: [{ kind: "plan", key: "p1", title: "Old Plan", reason: "different subsystem" }],
					}),
				);
				expect(html).toContain("ai-ex-row");
				expect(html).not.toContain("No plans or notes associated with this commit yet");
			});

			it("excluded reference rows derive their badge letter from the key's source segment", () => {
				const html = buildContextPanel(
					makeSummary({
						excludedContext: [
							{ kind: "reference", key: "linear:ENG-1", title: "ENG-1 — Fix", reason: "unrelated" },
						],
					}),
				);
				expect(html).toContain('class="kb-tag t-ref"');
			});

			it("omits AI rows entirely when there is no excludedContext", () => {
				const html = buildContextPanel(makeSummary({ plans: [makePlan()] }));
				expect(html).not.toContain("ai-ex-row");
			});

			it("kept rows show a tier chip + reason from contextRelevance (archive-suffix keys resolve)", () => {
				const html = buildContextPanel(
					makeSummary({
						plans: [makePlan({ slug: "graph-plan-ab12cd34" })],
						contextRelevance: [
							// Working-area key (no archive suffix) still matches the archived slug.
							{ kind: "plan", key: "graph-plan", tier: "high", reason: "plan lists the changed files" },
						],
					}),
				);
				expect(html).toContain('class="ctx-tier ctx-tier--high"');
				expect(html).toContain("plan lists the changed files");
			});

			it("kept rows without a persisted verdict render no relevance line (legacy summaries)", () => {
				const html = buildContextPanel(makeSummary({ plans: [makePlan()] }));
				expect(html).not.toContain("ctx-rel");
			});

			it("an empty-reason verdict renders no relevance line (fabricated fail-open entry)", () => {
				const html = buildContextPanel(
					makeSummary({
						plans: [makePlan()],
						contextRelevance: [{ kind: "plan", key: "test-plan", tier: "high", reason: "" }],
					}),
				);
				expect(html).not.toContain("ctx-rel");
				expect(html).not.toContain("ctx-tier--high");
			});
		});

		it("Conversations panel renders the shell + Loading placeholder (rows fill client-side)", () => {
			const html = buildHtml(makeSummary());
			// The panel title is now "Conversations" (top-level, no PRIVATE badge).
			expect(html).toContain("Conversations");
			expect(html).toContain('id="conversationsBody"');
			expect(html.toLowerCase()).toContain("loading");
			expect(html).not.toContain("PRIVATE");
		});

		it("Conversations panel emits the same shell regardless of transcript count", () => {
			const empty = buildHtml(makeSummary(), { transcriptHashSet: new Set() });
			const withData = buildHtml(makeSummary(), {
				transcriptHashSet: new Set(["hash1", "hash2"]),
			});
			for (const html of [empty, withData]) {
				expect(html).toContain('id="conversationsBody"');
				// No modal / manage / private-zone chrome anymore.
				expect(html).not.toContain("Manage");
				expect(html).not.toContain("openTranscriptsBtn");
				expect(html).not.toContain("transcriptModal");
				expect(html).not.toContain("modalSaveBtn");
			}
		});

		it("Linked row shows singular file count when filesChanged is 1", () => {
			resolveDiffStats.mockReturnValue({
				insertions: 1,
				deletions: 1,
				filesChanged: 1,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("1 file");
		});

		it("Linked row shows plural file count for multiple file changes", () => {
			resolveDiffStats.mockReturnValue({
				insertions: 10,
				deletions: 5,
				filesChanged: 3,
			});
			const html = buildHtml(makeSummary());
			expect(html).toContain("3 files");
		});

		it("drops the Duration row from the details table", () => {
			const html = buildHtml(makeSummary());
			expect(html).not.toContain(">Duration<");
			expect(formatDurationLabel).not.toHaveBeenCalled();
		});

		it("includes footer with 'Generated by Jolli Memory'", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("Generated by Jolli Memory");
			expect(html).toContain("page-footer");
		});

		it("appends a `· via <provider>` segment in its own .footer-provider span when formatProviderLabel returns a value", () => {
			formatProviderLabel.mockReturnValueOnce("Anthropic");
			const html = buildHtml(makeSummary());
			expect(html).toContain('class="footer-provider"');
			expect(html).toContain("&middot; via Anthropic");
		});

		it("omits the .footer-provider span for legacy summaries with no provider label", () => {
			// Default formatProviderLabel mock returns undefined — pinned here so
			// pre-`source`-field summaries keep their original two-segment footer.
			const html = buildHtml(makeSummary());
			expect(html).not.toContain("footer-provider");
			expect(html).not.toContain("&middot; via");
		});

		it("footer shows the transcript privacy note and keeps the attribution", () => {
			const html = buildHtml(makeSummary(), {
				transcriptHashSet: new Set(["t1", "t2"]),
			});
			expect(html).toContain("stay in your repo");
			expect(html).toContain("transcript-privacy");
			expect(html).toContain("Full conversation transcripts (2)");
			expect(html).toContain("Generated by Jolli Memory"); // attribution kept
		});

		it("footer privacy note counts zero linked conversations when transcriptHashSet is absent", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("Full conversation transcripts (0)");
		});

		it("includes toggleAllBtn", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("toggleAllBtn");
			expect(html).toContain("Collapse All");
		});

		it("includes copyMdBtn and pushJolliBtn", () => {
			const html = buildHtml(makeSummary());
			expect(html).toContain("copyMdBtn");
			expect(html).toContain("pushJolliBtn");
		});

		it("includes hash copy button with full hash in data attribute", () => {
			const hash = "abcdef1234567890abcdef1234567890abcdef12";
			const html = buildHtml(makeSummary({ commitHash: hash }));
			expect(html).toContain(`data-hash="${hash}"`);
			expect(html).toContain("hash-copy");
		});

	});

	// ─── buildHeader ─────────────────────────────────────────────────────────

	describe("buildHeader", () => {
		it("meta strip carries Share and Export and drops author/changes inline", () => {
			const html = buildHeader(makeSummary(), 3);
			expect(html).toContain("meta-share");
			expect(html).toContain("meta-export");
			expect(html).toContain("details-toggle"); // dotted Details toggle kept
			// Author / date / ± changes move out of the strip entirely — only
			// hash · branch · time remain inline before Details/Share/Export.
			expect(html).not.toContain("meta-author");
			expect(html).not.toContain("meta-changes");
		});

		it("Share and Export carry the mockup's leading icons (share SVG + codicon-book/chevron)", () => {
			const html = buildHeader(makeSummary(), 3);
			// Share: inline upload SVG (mockup `.sico`), not text-only.
			expect(html).toMatch(/meta-share[^>]*>\s*<svg class="sico"/);
			// Export: codicon-book leading glyph + codicon-chevron-down (replacing
			// the old &#x25BE; text triangle).
			expect(html).toContain('<span class="codicon codicon-book"></span>');
			expect(html).toContain('<span class="codicon codicon-chevron-down"></span>');
		});

		it("Export is a standalone toggle button, not a two-button split-button fragment", () => {
			const html = buildHeader(makeSummary(), 3);
			// Export must render as a single "action-btn meta-export" button —
			// the old split-btn-group/split-toggle skeleton (designed for a
			// glued two-button pair) must not wrap or decorate it, or the
			// !important split-toggle rules crush its corners/padding.
			expect(html).not.toContain("split-btn-group");
			expect(html).not.toContain("split-toggle");
			expect(html).toContain('<button class="action-btn meta-export" id="exportMenuToggle"');
			// The dropdown itself (and its wiring ids) must still be present.
			expect(html).toContain('class="split-menu" id="exportMenu"');
			expect(html).toContain('id="copyMdBtn"');
			expect(html).toContain('id="downloadMdBtn"');
		});

		it("details table keeps #propTable id and shows the four mem-details rows", () => {
			const html = buildHeader(
				makeSummary({ llm: { model: "claude-sonnet-4-6", inputTokens: 1500, outputTokens: 600 } }),
				3,
			);
			expect(html).toContain('id="propTable"');
			expect(html).toContain("Summary by");
			expect(html).toContain("Linked");
			expect(html).not.toContain(">Duration<");
		});

		it("details table has exactly four .md-row rows: Commit, Author, Summary by, Linked", () => {
			const html = buildHeader(makeSummary(), 3);
			expect(html).toContain("mem-details");
			const rowMatches = html.match(/class="md-row"/g) ?? [];
			expect(rowMatches).toHaveLength(4);
			expect(html).toContain(">Commit<");
			expect(html).toContain(">Author<");
			expect(html).toContain(">Summary by<");
			expect(html).toContain(">Linked<");
			expect(html).not.toContain(">Branch<");
			expect(html).not.toContain(">Date<");
			expect(html).not.toContain(">Changes<");
		});

		it("Summary by row omits the token span when summary.llm is absent", () => {
			const html = buildHeader(makeSummary({ llm: undefined }), 3);
			expect(html).not.toContain("tok-bd");
		});

		it("guards a partial/legacy llm object so the token count never renders NaN", () => {
			// The orphan branch is append-only, so an old record can carry an `llm`
			// block predating inputTokens/outputTokens. Summing undefined fields
			// would render "NaN tokens" without the per-field ?? 0 guard.
			const html = buildHeader(makeSummary({ llm: { model: "claude-sonnet-4-6" } as never }), 3);
			expect(html).toContain("tok-bd");
			expect(html).not.toContain("NaN");
			expect(html).toContain("0 tokens");
		});

		it("Summary by row shows model + token count when summary.llm is present", () => {
			const html = buildHeader(
				makeSummary({ llm: { model: "claude-sonnet-4-6", inputTokens: 1500, outputTokens: 600, apiLatencyMs: 1000, stopReason: null } }),
				3,
			);
			expect(html).toContain("claude-sonnet-4-6");
			expect(html).toContain("tok-bd");
			expect(html).toContain("2,100");
		});

		it("Linked row counts conversations from transcriptHashSet, context from plans+notes+references, files from totalFiles", () => {
			const html = buildHeader(
				makeSummary({
					plans: [makePlan()],
					notes: [makeNote()],
					references: [makeLinear()],
				}),
				3,
				new Set(["t1", "t2"]),
			);
			expect(html).toContain("2 conversations");
			expect(html).toContain("3 context");
			expect(html).toContain("3 files");
		});

		it("Linked row uses totalFiles for the file count (no commit-level filesAffected field)", () => {
			const html = buildHeader(makeSummary(), 7);
			expect(html).toContain("7 files");
		});

		it("Export menu retains #copyMdBtn and #downloadMdBtn (Regenerate moved to the Memory panel header)", () => {
			const html = buildHeader(makeSummary(), 3);
			expect(html).toContain('id="copyMdBtn"');
			expect(html).toContain('id="downloadMdBtn"');
			// Regenerate no longer lives in the Export menu — it moved to the
			// Memory panel header (see buildMemoryPanel). The header fragment
			// buildHeader renders therefore carries no #regenerateSummaryBtn.
			expect(html).not.toContain('id="regenerateSummaryBtn"');
		});

		it("keeps the .hash-copy button with data-hash in the Commit row", () => {
			const hash = "abcdef1234567890abcdef1234567890abcdef12";
			const html = buildHeader(makeSummary({ commitHash: hash }), 3);
			expect(html).toContain("hash-copy");
			expect(html).toContain(`data-hash="${hash}"`);
		});

		it("shows the branch after the hash in the Commit row (mockup: '<hash> · <branch>')", () => {
			// The mockup's Commit row is `269d1089e3 · feature/…`; the branch renders
			// as a .md-branch span alongside the hash + copy button.
			const html = buildHeader(makeSummary({ branch: "feature/memory-panel-ux-redesign" }), 3);
			expect(html).toContain("md-branch");
			expect(html).toContain("feature/memory-panel-ux-redesign");
		});
	});

	// ─── buildTokenMeter ─────────────────────────────────────────────────────

	describe("buildTokenMeter", () => {
		it("token meter shows total + segmented bar when a breakdown exists", () => {
			const html = buildTokenMeter(makeSummary({
				conversationTokens: 1443000,
				conversationTokenBreakdown: { input: 96000, output: 47000, cached: 1300000 },
			}));
			expect(html).toContain("tmeter");
			expect(html).toContain("seg-in");
			expect(html).toContain("seg-out");
			expect(html).toContain("seg-cache");
			expect(html).toContain("tmeter-legend");
			expect(html).not.toContain("tmeter na");
		});

		it("segment widths always fill the bar (sum to 100%) even when the breakdown sums to less than the aggregate total", () => {
			// Regression: `conversationTokens` (the tree-wide scalar total) can exceed
			// the sum of the breakdown fields when some folded sessions report only a
			// scalar with no usageBreakdown. Dividing each segment by the scalar total
			// underfilled the bar (here it would fill only ~15%). The segments must be
			// proportions of the breakdown's OWN sum, with the last absorbing rounding.
			const html = buildTokenMeter(makeSummary({
				conversationTokens: 2_000_000,
				conversationTokenBreakdown: { input: 100000, output: 100000, cached: 100000 },
			}));
			const pcts = [...html.matchAll(/data-pct="(\d+)"/g)].map((m) => Number(m[1]));
			expect(pcts).toHaveLength(3);
			expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);
			// The headline still shows the full tree-wide total, not the breakdown sum.
			expect(html).toContain("2M");
		});

		it("token meter renders the na state when usage is unreported", () => {
			const html = buildTokenMeter(makeSummary({ conversationTokens: undefined }));
			expect(html).toContain("tmeter na");
			expect(html).toContain("Task usage not reported");
			expect(html).not.toContain("tmeter-bar");
		});

		it("token meter degrades to a total-only single segment when breakdown is absent but tokens exist", () => {
			const html = buildTokenMeter(makeSummary({
				conversationTokens: 5000,
				conversationTokenBreakdown: undefined,
			}));
			expect(html).toContain("tmeter-bar");
			expect(html).toContain("seg-in");
			expect(html).not.toContain("seg-out");
			expect(html).not.toContain("seg-cache");
			expect(html).not.toContain("tmeter-legend");
			expect(html).not.toContain("tmeter na");
		});

		it("token meter treats conversationTokens of 0 as unreported", () => {
			const html = buildTokenMeter(makeSummary({ conversationTokens: 0 }));
			expect(html).toContain("tmeter na");
			expect(html).toContain("Task usage not reported");
		});

		// Regression: a consolidated (squash/amend/rebase) memory carries its
		// conversation tokens on the folded child commits, with the root's OWN
		// scalar 0/undefined. The meter must aggregate the whole tree — the same
		// basis the sidebar row uses (aggregateConversationTokens) — or it shows
		// "Task usage not reported" for a memory the sidebar reports as e.g. 12.4M.
		it("token meter aggregates across children when the root's own scalar is empty", () => {
			const child = makeSummary({
				commitHash: "c0ffee001122334455667788990011223344abcd",
				conversationTokens: 12400000,
				conversationTokenBreakdown: { input: 281000, output: 1500000, cached: 10619000 },
			});
			const html = buildTokenMeter(
				makeSummary({
					conversationTokens: undefined,
					conversationTokenBreakdown: undefined,
					children: [child],
				}),
			);
			expect(html).not.toContain("Task usage not reported");
			expect(html).not.toContain("tmeter na");
			expect(html).toContain("seg-in");
			expect(html).toContain("seg-out");
			expect(html).toContain("seg-cache");
			expect(html).toContain("12.4M");
		});

		it("formats small token counts (< 1000) without a k/M suffix", () => {
			const html = buildTokenMeter(makeSummary({
				conversationTokens: 500,
				conversationTokenBreakdown: { input: 300, output: 150, cached: 50 },
			}));
			expect(html).toContain(">500<");
		});

		it("shows a <$0.01 floor for very small cost estimates", () => {
			const html = buildTokenMeter(makeSummary({
				conversationTokens: 10,
				conversationTokenBreakdown: { input: 6, output: 3, cached: 1 },
			}));
			expect(html).toContain("<$0.01");
		});

		it("is inserted in buildHtml right after the meta strip and before buildShipBar", () => {
			const html = buildHtml(makeSummary({ conversationTokens: undefined }));
			const headerIdx = html.indexOf("meta-strip");
			const tmeterIdx = html.indexOf("tmeter");
			const shipBarIdx = html.indexOf("ship-bar");
			expect(headerIdx).toBeGreaterThan(-1);
			expect(tmeterIdx).toBeGreaterThan(headerIdx);
			expect(shipBarIdx).toBeGreaterThan(tmeterIdx);
		});
	});

	// ─── buildShipBar ────────────────────────────────────────────────────────

	describe("buildShipBar", () => {
		it("ship bar renders a single Jolli card and no PR card", () => {
			const html = buildShipBar(makeSummary({ jolliDocUrl: "https://jolli.ai/x" }));
			expect(html).toContain('class="ship-card"');
			expect(html).not.toContain('id="prCard"');
			expect(html).toContain("codicon-arrow-swap");
			expect(html).toContain(">Jolli<"); // name, not "Jolli Memory"
			expect(html).toContain("Update on Jolli");
		});

		it("ship bar shows LOCAL chip + Push when not synced", () => {
			const html = buildShipBar(makeSummary({ jolliDocUrl: undefined }));
			expect(html).toContain("local-chip");
			expect(html).toContain("Push to Jolli");
		});
	});

	// ─── buildRecapSection ───────────────────────────────────────────────────

	describe("buildRecapSection", () => {
		it("renders State 1 (placeholder + Generate button) when recap is undefined", () => {
			const html = buildRecapSection(undefined);
			expect(html).toContain('id="recapSection"');
			expect(html).toContain('id="generateRecapBtn"');
			expect(html).toContain("Quick recap");
			expect(html).toContain("recap-placeholder");
			// State 1 has no Edit / Regenerate / data-raw / recap-body
			expect(html).not.toContain('id="editRecapBtn"');
			expect(html).not.toContain('id="regenerateRecapBtn"');
			expect(html).not.toContain("data-raw=");
			expect(html).not.toContain("recap-body");
		});

		it("renders State 1 when recap is whitespace-only (treated as empty)", () => {
			const html = buildRecapSection("   \n  \t  ");
			expect(html).toContain('id="generateRecapBtn"');
			expect(html).not.toContain('id="editRecapBtn"');
		});

		it("renders State 2 (recap body with Edit + Regenerate buttons) when recap is present", () => {
			const html = buildRecapSection("This commit added a recap field.");
			expect(html).toContain('id="recapSection"');
			expect(html).toContain("Quick recap");
			expect(html).toContain('id="editRecapBtn"');
			expect(html).toContain('id="regenerateRecapBtn"');
			expect(html).toContain('class="recap-body"');
			expect(html).toContain("This commit added a recap field.");
			expect(html).not.toContain('id="generateRecapBtn"');
			expect(html.trimEnd().endsWith('<hr class="separator" />')).toBe(true);
		});

		it("stashes the raw recap text in data-raw for editor restore", () => {
			const html = buildRecapSection("Recap with <html> & special chars");
			// data-raw uses escAttr (mocked to identity here), the body uses escHtml.
			// The point of the assertion is that data-raw exists and carries the value.
			expect(html).toContain('data-raw="Recap with <html> & special chars"');
		});

		it("splits multi-paragraph recaps on blank lines into separate <p> elements", () => {
			const html = buildRecapSection("First paragraph.\n\nSecond paragraph.");
			// Two <p> tags inside the body, each holding one paragraph
			expect(html).toContain("<p>First paragraph.</p>");
			expect(html).toContain("<p>Second paragraph.</p>");
		});

		it("collapses 3+ consecutive newlines to a single paragraph break", () => {
			const html = buildRecapSection("A.\n\n\n\nB.");
			expect(html).toContain("<p>A.</p>");
			expect(html).toContain("<p>B.</p>");
		});
	});

	// ─── buildHtml recap ordering ────────────────────────────────────────────

	describe("buildHtml recap ordering", () => {
		// Redesign v2: the Ship bar (the Jolli card is the hero outbound action)
		// sits at the top of the page; the Quick recap now lives inside the
		// Memory panel below it. Order is intentionally ship-bar-then-recap.
		it("renders the Jolli ship card above the Quick recap", () => {
			const html = buildHtml(makeSummary({ recap: "A short recap." }));
			const shipIdx = html.indexOf('id="jolliCard"');
			const recapIdx = html.indexOf("recapSection");
			expect(shipIdx).toBeGreaterThan(0);
			expect(recapIdx).toBeGreaterThan(0);
			expect(shipIdx).toBeLessThan(recapIdx);
		});

		it("renders the State 1 placeholder when summary has no recap (so Generate button is reachable)", () => {
			const html = buildHtml(makeSummary({ recap: undefined }));
			// recapSection is always present now; what differs between states is
			// which buttons appear and whether recap-body / data-raw exist.
			expect(html).toContain('id="recapSection"');
			expect(html).toContain('id="generateRecapBtn"');
			expect(html).not.toContain('id="editRecapBtn"');
			expect(html).not.toContain('id="regenerateRecapBtn"');
		});
	});

	// ─── buildE2eTestSection ─────────────────────────────────────────────────

	describe("buildE2eTestSection", () => {
		it("shows placeholder with Generate button when no scenarios", () => {
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: undefined }),
			);
			expect(html).toContain("e2eTestSection");
			expect(html).toContain("e2e-placeholder");
			expect(html).toContain("generateE2eBtn");
			expect(html).toContain("Generate");
			expect(html).not.toContain("editE2eBtn");
		});

		it("shows placeholder when scenarios is empty array", () => {
			const html = buildE2eTestSection(makeSummary({ e2eTestGuide: [] }));
			expect(html).toContain("generateE2eBtn");
		});

		it("renders each scenario with steps and expected results", () => {
			const scenarios = [
				makeScenario({
					title: "Login flow",
					steps: ["Go to login", "Enter credentials"],
					expectedResults: ["User is logged in"],
				}),
				makeScenario({
					title: "Logout flow",
					steps: ["Click logout"],
					expectedResults: ["User sees login page"],
				}),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("Login flow");
			expect(html).toContain("Logout flow");
			expect(html).toContain("Go to login");
			expect(html).toContain("Enter credentials");
			expect(html).toContain("User is logged in");
			expect(html).toContain("Click logout");
			expect(html).toContain("User sees login page");
			// Count badge
			expect(html).toContain(`<span class="section-count">2</span>`);
		});

		it("shows section toolbar (collapse-all + regen + delete) when scenarios exist", () => {
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: [makeScenario()] }),
			);
			expect(html).toContain("toggleAllE2eBtn");
			expect(html).toContain("regenE2eBtn");
			expect(html).toContain("deleteE2eBtn");
			expect(html).not.toContain("editE2eBtn");
		});

		it("renders per-scenario edit/delete buttons with scenario index", () => {
			const html = buildE2eTestSection(
				makeSummary({
					e2eTestGuide: [
						makeScenario({ title: "A" }),
						makeScenario({ title: "B" }),
					],
				}),
			);
			// Each scenario gets its own edit/delete with data-scenario-index.
			expect(html).toContain('e2e-edit-btn" data-scenario-index="0"');
			expect(html).toContain('e2e-delete-btn" data-scenario-index="0"');
			expect(html).toContain('e2e-edit-btn" data-scenario-index="1"');
			expect(html).toContain('e2e-delete-btn" data-scenario-index="1"');
		});

		it("embeds scenario data on the toggle as data-scenario JSON", () => {
			const html = buildE2eTestSection(
				makeSummary({
					e2eTestGuide: [
						makeScenario({
							title: "Edit me",
							preconditions: "ready",
							steps: ["one", "two"],
							expectedResults: ["pass"],
						}),
					],
				}),
			);
			// data-scenario carries title + preconditions + newline-joined arrays
			// so the inline edit form can populate textareas without an extra round-trip.
			expect(html).toContain("data-scenario=");
			expect(html).toContain("Edit me");
			expect(html).toContain("ready");
		});

		it("renders preconditions block when preconditions are set", () => {
			const scenarios = [
				makeScenario({ preconditions: "Must be logged in as admin" }),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("Preconditions");
			expect(html).toContain("Must be logged in as admin");
			expect(html).toContain("preconditions");
		});

		it("does not render preconditions block when preconditions are absent", () => {
			const scenarios = [makeScenario({ preconditions: undefined })];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).not.toContain("Preconditions");
		});

		it("renders scenario toggle with correct ID and padded index", () => {
			const scenarios = [makeScenario({ title: "Scenario A" })];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain('id="e2e-scenario-0"');
			expect(html).toContain("e2e-scenario");
			expect(padIndex).toHaveBeenCalledWith(0);
		});

		it("renders steps in an ordered list", () => {
			const scenarios = [
				makeScenario({ steps: ["First step", "Second step"] }),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("<ol>");
			expect(html).toContain("<li>First step</li>");
			expect(html).toContain("<li>Second step</li>");
		});

		it("renders expected results in an unordered list", () => {
			const scenarios = [
				makeScenario({
					expectedResults: ["Sees success message", "Data is saved"],
				}),
			];
			const html = buildE2eTestSection(
				makeSummary({ e2eTestGuide: scenarios }),
			);
			expect(html).toContain("<ul>");
			expect(html).toContain("<li>Sees success message</li>");
			expect(html).toContain("<li>Data is saved</li>");
		});
	});

	// ─── renderTopic ────────────────────────────────────────────────────────

	describe("renderTopic", () => {
		it("renders toggle with correct ID based on displayIndex", () => {
			const html = renderTopic(makeTopic(), 5);
			expect(html).toContain('id="topic-5"');
		});

		it("uses treeIndex for edit/delete when available", () => {
			const topic = makeTopic({ treeIndex: 42 });
			const html = renderTopic(topic, 5);
			expect(html).toContain('id="topic-42"');
			expect(html).toContain('data-topic-index="42"');
		});

		it("falls back to displayIndex when treeIndex is undefined", () => {
			const topic = makeTopic({ treeIndex: undefined });
			const html = renderTopic(topic, 7);
			expect(html).toContain('id="topic-7"');
			expect(html).toContain('data-topic-index="7"');
		});

		it("shows category pill when category is set", () => {
			const html = renderTopic(makeTopic({ category: "feature" }), 0);
			expect(html).toContain("cat-pill");
			expect(html).toContain("cat-feature");
			expect(html).toContain("feature");
		});

		it("does not show category pill when category is undefined", () => {
			const html = renderTopic(makeTopic({ category: undefined }), 0);
			expect(html).not.toContain("cat-pill");
		});

		it('adds "minor" class when importance is minor', () => {
			const html = renderTopic(makeTopic({ importance: "minor" }), 0);
			expect(html).toContain("toggle-header minor");
		});

		it('does not add "minor" class when importance is major', () => {
			const html = renderTopic(makeTopic({ importance: "major" }), 0);
			expect(html).not.toContain("toggle-header minor");
		});

		it('does not add "minor" class when importance is undefined', () => {
			const html = renderTopic(makeTopic({ importance: undefined }), 0);
			expect(html).not.toContain("toggle-header minor");
		});

		it("embeds topic data as JSON in data-topic attribute", () => {
			const topic = makeTopic({
				title: "My Title",
				trigger: "My Trigger",
				response: "My Response",
				decisions: "My Decisions",
				todo: "My Todo",
				filesAffected: ["file1.ts", "file2.ts"],
			});
			const html = renderTopic(topic, 0);
			expect(html).toContain("data-topic=");
			// Verify the JSON structure via escAttr mock (pass-through)
			const jsonStr = JSON.stringify({
				title: "My Title",
				trigger: "My Trigger",
				response: "My Response",
				decisions: "My Decisions",
				todo: "My Todo",
				filesAffected: "file1.ts\nfile2.ts",
			});
			expect(escAttr).toHaveBeenCalledWith(jsonStr);
		});

		it("embeds topic data with empty todo and filesAffected when absent", () => {
			const topic = makeTopic({ todo: undefined, filesAffected: undefined });
			const html = renderTopic(topic, 0);
			expect(html).toContain("data-topic=");
			const jsonStr = JSON.stringify({
				title: "Test Topic",
				trigger: "Something triggered this",
				response: "Here is the response",
				decisions: "Decided to do X",
				todo: "",
				filesAffected: "",
			});
			expect(escAttr).toHaveBeenCalledWith(jsonStr);
		});

		it("renders callout blocks for trigger, decisions, and response", () => {
			const html = renderTopic(
				makeTopic({ trigger: "trig", decisions: "dec", response: "resp" }),
				0,
			);
			expect(html).toContain('data-field="trigger"');
			expect(html).toContain('data-field="decisions"');
			expect(html).toContain('data-field="response"');
			expect(renderCalloutText).toHaveBeenCalledWith("trig");
			expect(renderCalloutText).toHaveBeenCalledWith("dec");
			expect(renderCalloutText).toHaveBeenCalledWith("resp");
		});

		it("hides todo block when no todo", () => {
			const html = renderTopic(makeTopic({ todo: undefined }), 0);
			expect(html).toContain('data-field="todo"');
			// The todo block should have the hidden class
			expect(html).toMatch(/callout todo.*hidden/);
		});

		it("shows todo block when todo exists", () => {
			const html = renderTopic(makeTopic({ todo: "Fix this later" }), 0);
			expect(html).toContain('data-field="todo"');
			// Should NOT have the hidden class on todo
			const todoMatch = html.match(/class="callout todo[^"]*"/);
			expect(todoMatch).toBeTruthy();
			expect(todoMatch?.[0]).not.toContain("hidden");
			expect(renderCalloutText).toHaveBeenCalledWith("Fix this later");
		});

		it("hides files block when no files", () => {
			const html = renderTopic(makeTopic({ filesAffected: undefined }), 0);
			expect(html).toMatch(/callout files.*hidden/);
		});

		it("hides files block when filesAffected is empty array", () => {
			const html = renderTopic(makeTopic({ filesAffected: [] }), 0);
			expect(html).toMatch(/callout files.*hidden/);
		});

		it("shows files block when filesAffected has entries", () => {
			const html = renderTopic(
				makeTopic({ filesAffected: ["src/App.ts", "src/Main.ts"] }),
				0,
			);
			const filesMatch = html.match(/class="callout files[^"]*"/);
			expect(filesMatch).toBeTruthy();
			expect(filesMatch?.[0]).not.toContain("hidden");
			expect(html).toContain("files-affected-item");
			expect(html).toContain("src/App.ts");
			expect(html).toContain("src/Main.ts");
		});

		it("renders padded display index", () => {
			const html = renderTopic(makeTopic(), 0);
			expect(padIndex).toHaveBeenCalledWith(0);
			expect(html).toContain("01");
		});

		it("renders title through escHtml", () => {
			const html = renderTopic(makeTopic({ title: "Important Change" }), 0);
			expect(escHtml).toHaveBeenCalledWith("Important Change");
			expect(html).toContain("Important Change");
		});

		it("renders edit and delete action buttons", () => {
			const html = renderTopic(makeTopic(), 3);
			expect(html).toContain("topic-edit-btn");
			expect(html).toContain("topic-delete-btn");
			expect(html).toContain('data-topic-index="3"');
		});

		it("maps all category types to correct CSS classes", () => {
			const categoryMap: Record<string, string> = {
				feature: "cat-feature",
				ux: "cat-feature",
				bugfix: "cat-bugfix",
				security: "cat-bugfix",
				refactor: "cat-refactor",
				performance: "cat-refactor",
				"tech-debt": "cat-infra",
				devops: "cat-infra",
				test: "cat-docs",
				docs: "cat-docs",
			};
			for (const [category, expectedClass] of Object.entries(categoryMap)) {
				const html = renderTopic(
					makeTopic({ category: category as TopicWithDate["category"] }),
					0,
				);
				expect(html).toContain(expectedClass);
			}
		});
	});
});

describe("buildTopicsSection", () => {
	it("wraps topics in a section element with id='topicsSection'", () => {
		const summary = makeSummary({
			topics: [makeTopic({ title: "Sample topic" })],
		});
		const html = buildTopicsSection(summary);
		expect(html).toMatch(/<div class="section" id="topicsSection"/);
	});

	it("produces output that is byte-equal to the corresponding region inside buildHtml", () => {
		const summary = makeSummary({
			topics: [makeTopic({ title: "Sample topic" })],
		});
		const pageHtml = buildHtml(summary);
		const sectionHtml = buildTopicsSection(summary);
		expect(pageHtml).toContain(sectionHtml.trim());
	});

	it("renders the empty-state placeholder when topics is empty", () => {
		const html = buildTopicsSection(makeSummary({ topics: [] }));
		expect(html).toContain('id="topicsSection"');
		expect(html).toContain("No topics available for this commit.");
	});

	it("renders failure empty-state when topics are empty due to LLM failure (summaryError)", () => {
		const html = buildTopicsSection(makeSummary({ topics: [], summaryError: "llm-failed" }));
		expect(html).toContain("Summary generation failed");
		expect(html).toContain("Click Regenerate above");
		expect(html).not.toContain("No topics available for this commit.");
	});

	it("renders failure empty-state for legacy summaries with stopReason='error'", () => {
		const html = buildTopicsSection(
			makeSummary({
				topics: [],
				llm: { model: "claude", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "error" },
			}),
		);
		expect(html).toContain("Summary generation failed");
	});

	it("keeps the healthy empty-state when topics are empty without a failure marker", () => {
		const html = buildTopicsSection(makeSummary({ topics: [] }));
		expect(html).toContain("No topics available for this commit.");
		expect(html).not.toContain("Summary generation failed");
	});

	it("readOnly failure empty-state drops the 'Click Regenerate above' CTA", () => {
		// In foreign-readonly / stale-readonly the Regenerate button is hidden;
		// the empty-state shouldn't promise a click action it can't deliver.
		const html = buildTopicsSection(
			makeSummary({ topics: [], summaryError: "llm-failed" }),
			{ readOnly: true },
		);
		expect(html).toContain("Summary generation failed");
		expect(html).not.toContain("Click Regenerate above");
	});

	it("non-readOnly failure empty-state keeps the 'Click Regenerate above' CTA", () => {
		const html = buildTopicsSection(makeSummary({ topics: [], summaryError: "llm-failed" }), { readOnly: false });
		expect(html).toContain("Click Regenerate above");
	});
});

describe("buildAllConversationsSection — Regenerate button", () => {
	it("renders an enabled Regenerate button when transcripts exist", () => {
		const summary = makeSummary();
		const html = buildHtml(summary, {
			transcriptHashSet: new Set([summary.commitHash]),
		});
		expect(html).toContain('id="regenerateSummaryBtn"');
		expect(html).not.toMatch(/id="regenerateSummaryBtn"[^>]*disabled/);
	});

	it("renders exactly one Regenerate button even in the empty-transcript branch", () => {
		const summary = makeSummary();
		const html = buildHtml(summary); // no transcriptHashSet → empty branch
		const matches = html.match(/id="regenerateSummaryBtn"/g) ?? [];
		expect(matches.length).toBe(1);
		expect(html).not.toMatch(/id="regenerateSummaryBtn"[^>]*disabled/);
	});

	// ── Partial-refresh support (Option B): exported section builders + the
	//    stable #allConversationsSection wrapper the webview replaces in place. ──
	describe("partial-refresh section builders", () => {
		it("buildPlansAndNotesSection is exported and renders the #plansAndNotesSection container", () => {
			const html = buildPlansAndNotesSection(
				undefined,
				undefined,
				[],
				new Set(),
				new Set(),
				new Set(),
			);
			expect(html).toContain('id="plansAndNotesSection"');
		});

		it("marks only the newest of same-named plan snapshots as Latest and renders it first", () => {
			const older = makePlan({
				slug: "refactor-auth-1111aaaa",
				title: "Refactor auth",
				updatedAt: "2026-01-10T10:00:00Z",
			});
			const newer = makePlan({
				slug: "refactor-auth-2222bbbb",
				title: "Refactor auth",
				updatedAt: "2026-01-12T10:00:00Z",
			});
			const html = buildPlansAndNotesSection(
				[older, newer],
				undefined,
				[],
			);
			// Exactly one Latest badge.
			expect(html.match(/plan-latest-badge/g)).toHaveLength(1);
			// The badge sits on the newer snapshot, and the newer item is rendered first.
			const newerIdx = html.indexOf('id="plan-refactor-auth-2222bbbb"');
			const olderIdx = html.indexOf('id="plan-refactor-auth-1111aaaa"');
			expect(newerIdx).toBeGreaterThanOrEqual(0);
			expect(newerIdx).toBeLessThan(olderIdx);
			// The superseded (older) snapshot is dimmed.
			expect(html).toContain('class="row plan-item plan-older" id="plan-refactor-auth-1111aaaa"');
			// Every plan item carries a relative date.
			expect(html.match(/plan-date/g)).toHaveLength(2);
		});

		it("does not render a Latest badge for a single (non-duplicated) plan", () => {
			const html = buildPlansAndNotesSection([makePlan()], undefined, []);
			expect(html).not.toContain("plan-latest-badge");
			expect(html).toContain("plan-date");
		});

		it("renders an inline Jolli link only for a plan with jolliPlanDocUrl", () => {
			const pushed = makePlan({
				slug: "pushed-plan",
				jolliPlanDocUrl: "https://jolli.ai/articles?doc=42",
			});
			const unpushed = makePlan({ slug: "unpushed-plan" });
			const html = buildPlansAndNotesSection([pushed, unpushed], undefined, []);
			expect(html).toContain(
				'class="jolli-link plan-jolli-link" href="https://jolli.ai/articles?doc=42"',
			);
			// Only one inline link — the unpushed plan has none.
			expect(html.match(/plan-jolli-link/g)).toHaveLength(1);
		});

		it("shows the inline Jolli link only on the latest of same-named snapshots", () => {
			const url = "https://jolli.ai/very/articles?doc=2570";
			const latest = makePlan({
				slug: "dup-2222bbbb",
				title: "Dup",
				updatedAt: "2026-01-12T00:00:00Z",
				jolliPlanDocUrl: url,
			});
			const older = makePlan({
				slug: "dup-1111aaaa",
				title: "Dup",
				updatedAt: "2026-01-10T00:00:00Z",
				jolliPlanDocUrl: url,
			});
			const html = buildPlansAndNotesSection([older, latest], undefined, []);
			// Both snapshots share one Jolli doc, so only the latest links out.
			expect(html.match(/plan-jolli-link/g)).toHaveLength(1);
		});

		it("buildJolliRow is exported: returns '' without a url, renders #jolliRow with one", () => {
			expect(buildJolliRow(undefined, "msg", undefined, undefined)).toBe("");
			const withUrl = buildJolliRow(
				"https://jolli.ai/x",
				"msg",
				undefined,
				undefined,
			);
			expect(withUrl).toContain('id="jolliRow"');
		});

		it("buildJolliRow lists a shared plan doc URL only once", () => {
			const url = "https://jolli.ai/very/articles?doc=2570";
			const p1 = makePlan({ slug: "dup-2222bbbb", title: "Dup", jolliPlanDocUrl: url });
			const p2 = makePlan({ slug: "dup-1111aaaa", title: "Dup", jolliPlanDocUrl: url });
			const html = buildJolliRow(
				"https://jolli.ai/very/articles?doc=2571",
				"msg",
				[p1, p2],
				undefined,
			);
			// Two snapshots, one doc — the Plans & Notes block lists it once.
			expect(html.match(/jolli-plan-item/g)).toHaveLength(1);
		});

		it("buildJolliRow lists a shared note doc URL only once (note dedup by URL)", () => {
			const url = "https://jolli.ai/note/shared-2570";
			const n1 = makeNote({ id: "note-a", title: "Shared", jolliNoteDocUrl: url });
			const n2 = makeNote({ id: "note-b", title: "Shared", jolliNoteDocUrl: url });
			const html = buildJolliRow("https://jolli.ai/memory/x", "msg", undefined, [n1, n2]);
			// Two note snapshots, one doc — the second is a seen-URL dupe and is skipped.
			expect(html.match(/jolli-plan-item/g)).toHaveLength(1);
		});

		it("buildConversationsSection keeps the stable #allConversationsSection refresh wrapper", () => {
			// count === 0 (empty) branch
			const empty = buildConversationsSection(new Set(), false);
			expect(empty).toContain('id="allConversationsSection"');
			// count > 0 branch — still the same wrapper, no modal
			const withData = buildConversationsSection(new Set(["h1"]), false);
			expect(withData).toContain('id="allConversationsSection"');
			expect(withData).not.toContain('id="transcriptModal"');
		});

		it("buildHtml embeds the #allConversationsSection wrapper", () => {
			expect(buildHtml(makeSummary())).toContain(
				'id="allConversationsSection"',
			);
		});
	});

	// ─── Conversations → inline rows (mockup alignment, Task 7) ──────────────
	describe("buildConversationsSection — inline rows panel", () => {
		it("renders a .panel with a Conversations header and count chip, not a modal private-zone", () => {
			const html = buildConversationsSection(new Set(["h1", "h2"]), false);
			expect(html).toContain("panel conversations-panel");
			expect(html).toContain('class="panel-header"');
			expect(html).toContain("Conversations");
			expect(html).toContain('class="sec-count"');
			// The modal + manage/save/delete flow is gone.
			expect(html).not.toContain("private-zone");
			expect(html).not.toContain('id="transcriptModal"');
			expect(html).not.toContain('id="openTranscriptsBtn"');
			expect(html).not.toContain('id="modalSaveBtn"');
			expect(html).not.toContain('id="deleteTranscriptsBtn"');
		});

		it("renders a build-time Loading placeholder body populated at runtime", () => {
			const html = buildConversationsSection(new Set(["h1"]), false);
			// Body container that the client fills on conversationsData.
			expect(html).toContain('id="conversationsBody"');
			expect(html.toLowerCase()).toContain("loading");
		});

		it("count chip reflects the transcript hash count at build time", () => {
			expect(buildConversationsSection(new Set(["h1", "h2", "h3"]), false)).toContain(
				'class="sec-count">3<',
			);
			expect(buildConversationsSection(new Set(), false)).toContain(
				'class="sec-count">0<',
			);
		});
	});
});
