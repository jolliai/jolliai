import { describe, expect, it } from "vitest";
import { buildNextMemoryScript } from "./NextMemoryScriptBuilder.js";

describe("buildNextMemoryScript", () => {
	it("parses as valid JavaScript (smoke test)", () => {
		// Mirrors the SidebarScriptBuilder / SummaryScriptBuilder convention: a
		// `new Function` parse check catches syntax errors (e.g. an accidental
		// backtick truncating the template literal) that string assertions miss.
		expect(() => new Function(buildNextMemoryScript())).not.toThrow();
	});

	it("contains no backtick (builder template-literal trap)", () => {
		expect(buildNextMemoryScript().includes("`")).toBe(false);
	});

	it("listens for the same branch:*Data messages the sidebar renders from", () => {
		const js = buildNextMemoryScript();
		for (const type of ["branch:conversationsData", "branch:plansData", "branch:changesData"]) {
			expect(js).toContain(type);
		}
	});

	it("renders a conversation row with the per-source brand icon, title, and message count", () => {
		const js = buildNextMemoryScript();
		// Brand glyph (matches the sidebar), not a text badge.
		expect(js).toContain("convSourceIcon(item.source)");
		expect(js).toContain("conv-source-icon");
		expect(js).toContain("item.messageCount) + ' msgs'");
		// The "N msgs" count is marked hide-on-hover so the ✕ exclude toggle
		// overlay covers it on hover instead of peeking out beside it.
		expect(js).toContain("'r-meta hide-on-hover'");
	});

	it("renders excluded rows struck-through rather than omitting them", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("item.isSelected ? '' : ' excluded'");
	});

	it("renders context rows with a kb-tag badge keyed by contextValue", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("mem-ctx-badge");
	});

	it("derives the reference badge from referenceHover.source, not the codicon iconKey", () => {
		// Regression: passing item.iconKey (e.g. 'device-camera-video' for a
		// zoom-meeting) into ctxBadge misses SOURCE_META and falls back to a
		// neutral 'D' badge; the sidebar keys off referenceHover.source ('Z').
		const js = buildNextMemoryScript();
		expect(js).toContain("item.referenceHover ? item.referenceHover.source");
		expect(js).not.toContain("ctxBadge(item.contextValue, item.iconKey)");
	});

	it("renders file rows with the git-status letter", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("'gs gs-' + item.gitStatus");
	});

	it("sets exact token-bar segment widths via the style property, not an inline style attribute (CSP-safe)", () => {
		const js = buildNextMemoryScript();
		// Widths are exact percentages set as a JS property write (allowed under
		// CSP), replacing the old 10%-bucket width classes (which hid sub-10%
		// segments). No inline style="…" attribute is ever emitted.
		expect(js).toContain("s.style.width = pct + '%'");
		expect(js).not.toContain("seg--w");
		expect(js).not.toContain("style=");
	});

	it("handles preview:title including the failure-degraded state", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("preview:title");
		expect(js).toContain("Couldn't generate a title");
	});

	it("handles preview:tokenStats", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("preview:tokenStats");
	});

	it("merges a preview:ticket message into the cached title (no full title re-render from the host)", () => {
		const js = buildNextMemoryScript();
		// The detected ticket arrives on its own message (a reference toggle
		// recomputes it without re-running the LLM title), so the client caches the
		// last title and re-renders it with the merged ticket.
		expect(js).toContain("preview:ticket");
		expect(js).toContain("lastTitleMsg");
	});

	it("humanizes token counts (k / M) instead of printing the raw number", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("function formatTokens(n)");
		expect(js).toContain("formatTokens(msg.total)");
		expect(js).toContain("formatTokens(msg.input)");
		// The raw String(msg.total) form must be gone from the meter.
		expect(js).not.toContain("String(msg.total)");
	});

	it("renders the meta-strip branch pill + NOT COMMITTED status dot", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("meta-branch");
		expect(js).toContain("'led'");
		expect(js).toContain("NOT COMMITTED");
	});

	it("renders the Target-commit line in the proposed-title env-grid", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("Target commit ");
		expect(js).toContain("next on ");
	});

	it("renders the footer commit-explainer copy above Commit Memory", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("cc-body");
		expect(js).toContain("included files");
		expect(js).toContain("Local-first");
	});

	it("Context + opens the same anchored dropdown as the sidebar (Add Plan/Note/Snippet)", () => {
		const js = buildNextMemoryScript();
		// In-webview anchored menu (showContextMenu + #context-menu), NOT a native
		// QuickPick command — matching the sidebar's add menu.
		expect(js).toContain("function showContextMenu");
		expect(js).toContain("getElementById('context-menu')");
		expect(js).toContain("command: 'jollimemory.addPlan'");
		expect(js).toContain("command: 'jollimemory.addMarkdownNote'");
		expect(js).toContain("command: 'jollimemory.addTextSnippet'");
	});

	it("uses the plans-specific empty copy for the Context section", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("No plans or notes yet. Click + to add a plan or note.");
	});

	it("has no Regenerate button in the success-state title panel (mockup parity)", () => {
		const js = buildNextMemoryScript();
		// Regenerate survives only in the degraded/error state as a retry
		// affordance — so exactly one "Regenerate" label remains, not two.
		const count = (js.match(/text: 'Regenerate'/g) ?? []).length;
		expect(count).toBe(1);
	});

	it("handles preview:diffstat", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("preview:diffstat");
	});

	it("wraps each row's hover actions in a .row-actions overlay (no in-flow reflow)", () => {
		const js = buildNextMemoryScript();
		// The ✕/+ toggle is wrapped via rowActions() so it renders in the
		// absolutely-positioned .row-actions overlay rather than in the row flow.
		expect(js).toContain("function rowActions(children)");
		expect(js).toContain("className: 'row-actions'");
		expect(js).toContain("rowActions([excludeToggle(");
	});

});

describe("click-to-open parity with the sidebar Working Memory rows", () => {
	it("opens a conversation row via branch:openConversation with the sidebar's field shape", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("function attachRowOpen(row, open)");
		expect(js).toContain("type: 'branch:openConversation'");
		// Same field set the host's branch:openConversation validator requires.
		expect(js).toContain("transcriptPath: item.transcriptPath");
		expect(js).toContain("title: item.title || '(untitled)'");
	});

	it("skips opening a conversation row with no messages", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("if (!item.messageCount || item.messageCount <= 0) return;");
	});

	it("opens context rows via branch:openPlan / openNote / openReferencePreview by kind", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("type: 'branch:openPlan', planId: item.id");
		expect(js).toContain("type: 'branch:openNote', noteId: item.id");
		expect(js).toContain("type: 'branch:openReferencePreview', mapKey: item.id");
	});

	it("opens a file row via branch:openChange with filePath / relativePath / statusCode", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("type: 'branch:openChange'");
		expect(js).toContain("relativePath: item.description || ''");
		expect(js).toContain("statusCode: item.gitStatus || ''");
	});

	it("guards row-open against clicks that land on the .row-actions overlay", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("closest('.row-actions')");
	});
});

describe("footer + message contract parity", () => {
	it("renders a footer with the privacy note and a Commit Memory button", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("stay in your repo");
		expect(js).toContain("Commit Memory");
	});

	it("Commit Memory dispatches the exact same command the sidebar body button uses", () => {
		const js = buildNextMemoryScript();
		// Must match SidebarScriptBuilder.ts's body-commit dispatch verbatim —
		// both buttons must trigger the identical host command, not a lookalike.
		expect(js).toContain("command: 'jollimemory.commitAI'");
	});

	it("disables Commit Memory while worker:busy, mirroring the sidebar's isWorkerBlocking gate", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("'worker:busy'");
		expect(js).toContain("commitBtn.disabled = ");
	});

	it("gates Commit Memory on the included-file count (empty / all-discarded list disables it)", () => {
		const js = buildNextMemoryScript();
		// The button's disabled state must factor in the included-file count, not
		// just worker:busy — mirrors renderCommitReviewBar's
		// `disabled = selectedCount === 0 || isWorkerBlocking()`.
		expect(js).toContain("function updateCommitEnabled()");
		expect(js).toContain("commitBtn.disabled = selectedCount === 0 || isBusy;");
		// And the files-changed path must re-evaluate it, or discarding every file
		// would leave the button enabled with nothing to commit.
		expect(js).toMatch(/case 'branch:changesData':[\s\S]*renderFiles\(\);[\s\S]*updateCommitEnabled\(\);/);
	});

	it("posts branch:toggle* messages with the exact field names the sidebar posts", () => {
		const js = buildNextMemoryScript();
		// Pinned against SidebarScriptBuilder.ts's change-handler payloads
		// (source/sessionId/selected, planId/selected, noteId/selected,
		// mapKey/selected, filePath/selected) — both emitters feed the same
		// SidebarWebviewProvider.handleOutbound switch, so a field-name
		// mismatch here would silently no-op instead of erroring.
		expect(js).toContain("source: item.source");
		expect(js).toContain("sessionId: item.sessionId");
		expect(js).toContain("planId: item.id");
		expect(js).toContain("noteId: item.id");
		expect(js).toContain("mapKey: item.id");
		// File toggle keys on the RELATIVE path (item.description) because
		// FilesStore.selectedPaths is relative-keyed — sending item.id (absolute)
		// silently no-ops the ✕ click. Mirrors the sidebar's data-rel-path||data-id.
		expect(js).toContain("filePath: item.description || item.id");
	});
});

describe("row destructive actions (discard on files, remove on context)", () => {
	it("file rows post branch:discardFile with the raw porcelain columns bridge.discardFiles needs", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("codicon-discard");
		expect(js).toContain("type: 'branch:discardFile'");
		// filePath is absolute (item.id); relativePath rides on item.description.
		expect(js).toContain("filePath: item.id");
		expect(js).toContain("relativePath: item.description || ''");
		// indexStatus + worktreeStatus MUST travel — the collapsed gitStatus letter
		// alone breaks untracked / added / renamed discards on the host.
		expect(js).toContain("indexStatus: item.indexStatus || ''");
		expect(js).toContain("worktreeStatus: item.worktreeStatus || ''");
	});

	it("context rows post the same remove command the sidebar's inline trash dispatches", () => {
		const js = buildNextMemoryScript();
		expect(js).toContain("codicon-trash");
		// plan → removePlan, note → removeNote, reference → ignoreReference.
		expect(js).toContain("'jollimemory.removePlan'");
		expect(js).toContain("'jollimemory.removeNote'");
		expect(js).toContain("'jollimemory.ignoreReference'");
		expect(js).toContain("command: removeCmd, args: [item.id]");
	});

	it("puts the destructive action to the LEFT of the ✕/+ toggle in .row-actions", () => {
		const js = buildNextMemoryScript();
		// The trash/discard rowIconButton is appended before excludeToggle in the
		// rowActions cluster, matching the sidebar's [discard/remove] [✕] order.
		expect(js).toContain("function rowIconButton(icon, title, onClick)");
		expect(js).toContain("className: 'row-act-btn'");
	});
});
