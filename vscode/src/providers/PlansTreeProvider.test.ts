import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setExcluded } from "../../../cli/src/core/CommitSelectionStore.js";
import type { NoteInfo, PlanInfo } from "../Types.js";

const {
	executeCommand,
	TreeItem,
	ThemeIcon,
	ThemeColor,
	EventEmitter,
	MarkdownString,
} = vi.hoisted(() => {
	const executeCommand = vi.fn().mockResolvedValue(undefined);
	class TreeItem {
		label: string;
		collapsibleState: number;
		description?: string;
		iconPath?: unknown;
		contextValue?: string;
		tooltip?: unknown;
		command?: unknown;
		constructor(label: string, collapsibleState: number) {
			this.label = label;
			this.collapsibleState = collapsibleState;
		}
	}
	class ThemeIcon {
		readonly id: string;
		readonly color?: unknown;
		constructor(id: string, color?: unknown) {
			this.id = id;
			this.color = color;
		}
	}
	class ThemeColor {
		readonly id: string;
		constructor(id: string) {
			this.id = id;
		}
	}
	class EventEmitter {
		event = vi.fn();
		fire = vi.fn();
		dispose = vi.fn();
	}
	class MarkdownString {
		value: string;
		isTrusted = false;
		constructor(value = "") {
			this.value = value;
		}
		appendMarkdown(value: string): void {
			this.value += value;
		}
	}
	return {
		executeCommand,
		TreeItem,
		ThemeIcon,
		ThemeColor,
		EventEmitter,
		MarkdownString,
	};
});

vi.mock("vscode", () => ({
	TreeItem,
	TreeItemCollapsibleState: { None: 0 },
	ThemeIcon,
	ThemeColor,
	EventEmitter,
	MarkdownString,
	commands: {
		executeCommand,
	},
}));

import { PlansStore } from "../stores/PlansStore.js";
import type { ReferenceInfo } from "../Types.js";
import {
	ReferenceItem,
	NoteItem,
	PlanItem,
	PlansTreeProvider,
} from "./PlansTreeProvider.js";

/**
 * Test facade: real PlansStore + PlansTreeProvider with the legacy shim
 * surface (refresh / setEnabled) forwarded to the store.
 */
function makePlansProvider(bridge: unknown) {
	const store = new PlansStore(bridge as never);
	const provider = new PlansTreeProvider(store);
	const emitter = (
		provider as unknown as {
			_onDidChangeTreeData: {
				fire: ReturnType<typeof vi.fn>;
				dispose: () => void;
			};
		}
	)._onDidChangeTreeData;
	return {
		__store: store,
		__provider: provider,
		_onDidChangeTreeData: emitter,
		getTreeItem: provider.getTreeItem.bind(provider),
		getChildren: provider.getChildren.bind(provider),
		serialize: (
			provider as unknown as {
				serialize: () => ReadonlyArray<{
					id?: string;
					label?: string;
					iconKey?: string;
					iconColor?: string;
				}>;
			}
		).serialize?.bind(provider),
		onDidChangeTreeData: provider.onDidChangeTreeData,
		dispose: () => provider.dispose(),
		refresh: () => store.refresh(),
		setEnabled: (enabled: boolean) => store.setEnabled(enabled),
	};
}

function makePlan(overrides: Partial<PlanInfo> = {}): PlanInfo {
	return {
		slug: "plan-alpha",
		filename: "plan-alpha.md",
		filePath: "/repo/plan-alpha.md",
		title: "Alpha Plan",
		lastModified: "2026-03-30T10:00:00.000Z",
		addedAt: "2026-03-30T09:00:00.000Z",
		updatedAt: "2026-03-30T10:00:00.000Z",
		branch: "feature/test",
		editCount: 2,
		commitHash: null,
		...overrides,
	};
}

describe("PlanItem", () => {
	it("renders uncommitted plans with an edit command", () => {
		const item = new PlanItem(makePlan());

		expect(item.label).toBe("Alpha Plan");
		expect((item.iconPath as { id: string }).id).toBe("file-text");
		expect(item.command).toEqual({
			command: "jollimemory.editPlan",
			title: "Edit Plan",
			arguments: [item],
		});
		const tooltip = item.tooltip as { value: string; isTrusted: boolean };
		expect(tooltip.isTrusted).toBe(true);
		expect(tooltip.value).toContain("edited 2 times");
		expect(tooltip.value).toContain("command:jollimemory.editPlan");
		expect(tooltip.value).not.toContain("copyCommitHash");
	});

	it("renders committed plans with short hash and copy link", () => {
		const item = new PlanItem(
			makePlan({ commitHash: "abcdef1234567890", editCount: 1 }),
		);

		expect(item.label).toBe("abcdef12 · Alpha Plan");
		expect((item.iconPath as { id: string }).id).toBe("lock");
		const tooltip = item.tooltip as { value: string };
		expect(tooltip.value).toContain("$(git-commit) `abcdef12` $(copy)");
		expect(tooltip.value).toContain("Preview Plan");
		expect(tooltip.value).toContain("edited 1 time");
	});
});

function makeNote(overrides: Partial<NoteInfo> = {}): NoteInfo {
	return {
		id: "note-alpha",
		title: "Alpha Note",
		format: "snippet",
		lastModified: "2026-03-30T11:00:00.000Z",
		addedAt: "2026-03-30T09:00:00.000Z",
		updatedAt: "2026-03-30T11:00:00.000Z",
		branch: "feature/test",
		commitHash: null,
		filename: "note-alpha.md",
		...overrides,
	};
}

describe("NoteItem", () => {
	it("renders uncommitted snippet note with comment icon", () => {
		const item = new NoteItem(makeNote());

		expect(item.label).toBe("Alpha Note");
		expect((item.iconPath as { id: string }).id).toBe("comment");
		expect(item.contextValue).toBe("note");
		expect(item.command).toEqual({
			command: "jollimemory.editNote",
			title: "Edit Note",
			arguments: [item],
		});
		const tooltip = item.tooltip as { value: string; isTrusted: boolean };
		expect(tooltip.isTrusted).toBe(true);
		expect(tooltip.value).toContain("$(comment) Text snippet");
		expect(tooltip.value).toContain("command:jollimemory.editNote");
	});

	it("renders uncommitted markdown note with note icon", () => {
		const item = new NoteItem(makeNote({ format: "markdown" }));

		expect((item.iconPath as { id: string }).id).toBe("note");
		const tooltip = item.tooltip as { value: string };
		expect(tooltip.value).toContain("$(note) Markdown file");
	});

	it("renders committed note with short hash and lock icon", () => {
		const item = new NoteItem(makeNote({ commitHash: "abcdef1234567890" }));

		expect(item.label).toBe("abcdef12 · Alpha Note");
		expect((item.iconPath as { id: string }).id).toBe("lock");
		const tooltip = item.tooltip as { value: string };
		expect(tooltip.value).toContain("$(git-commit) `abcdef12` $(copy)");
		expect(tooltip.value).toContain("command:jollimemory.copyCommitHash");
	});

	it("uses note.id as display name when filename is undefined", () => {
		const item = new NoteItem(makeNote({ filename: undefined }));

		const tooltip = item.tooltip as { value: string };
		expect(tooltip.value).toContain("note-alpha");
	});
});

function makeReference(overrides: Partial<ReferenceInfo> = {}): ReferenceInfo {
	// Field names taken from Types.ts ReferenceInfo — uses sourcePath (not
	// filename / filePath like PlanInfo / NoteInfo) and requires `ignored`,
	// `sourceToolName`, `source`, `nativeId`, and `mapKey`.
	return {
		kind: "reference",
		source: "linear",
		nativeId: "PROJ-1528",
		mapKey: "linear:PROJ-1528",
		title: "Sample Issue",
		url: "https://linear.app/test/issue/PROJ-1528",
		sourcePath: "/repo/.jolli/jollimemory/references/linear/PROJ-1528.md",
		lastModified: "2026-03-30T11:00:00.000Z",
		addedAt: "2026-03-30T09:00:00.000Z",
		updatedAt: "2026-03-30T11:00:00.000Z",
		branch: "feature/test",
		commitHash: null,
		ignored: false,
		sourceToolName: "mcp__linear__get_issue",
		...overrides,
	};
}

describe("ReferenceItem", () => {
	it("renders nativeId · title with date-only description (status intentionally omitted)", () => {
		// buildEntityDescription returns the relative date alone — the
		// captured status field is dropped from the row text because it
		// can drift from the live upstream value (we don't poll), so
		// surfacing it risked misleading users with stale labels. Tooltip
		// retains the status for hover-inspection of captured state.
		const item = new ReferenceItem(makeReference({ status: undefined }));

		expect(item.label).toBe("PROJ-1528 — Sample Issue");
		expect(item.contextValue).toBe("reference");
		expect(item.description).not.toContain("undefined");
		// Linear / Jira / GitHub use the codicon "issues" glyph. The
		// brand-specific tint was rejected in earlier iterations to keep
		// rows visually uniform.
		expect((item.iconPath as { id: string }).id).toBe("issues");
		expect(item.command).toEqual({
			command: "jollimemory.openReferenceMarkdown",
			title: "Open Reference Markdown",
			arguments: [item],
		});
	});

	it("Notion entities render title-only label and file-text icon", () => {
		// Notion page ids are 32-hex blobs — meaningless to users — so the
		// label drops the nativeId prefix. The icon is `file-text` (matches
		// the "Notion page" mental model) instead of the issue glyph used
		// for Linear / Jira / GitHub.
		const item = new ReferenceItem(
			makeReference({
				source: "notion",
				nativeId: "abc123def4567890",
				title: "Design Spec",
				mapKey: "notion:abc123def4567890",
				url: "https://www.notion.so/abc123def4567890",
			}),
		);
		expect(item.label).toBe("Design Spec");
		expect((item.iconPath as { id: string }).id).toBe("file-text");
		expect(item.contextValue).toBe("reference");
	});

	it("Jira and GitHub entities use the issues icon with prefixed labels", () => {
		const jira = new ReferenceItem(
			makeReference({
				source: "jira",
				nativeId: "KAN-5",
				title: "Plan auto-discovery",
				mapKey: "jira:KAN-5",
			}),
		);
		const github = new ReferenceItem(
			makeReference({
				source: "github",
				nativeId: "owner/repo#42",
				title: "Track regressions",
				mapKey: "github:owner/repo#42",
			}),
		);
		expect(jira.label).toBe("KAN-5 — Plan auto-discovery");
		expect((jira.iconPath as { id: string }).id).toBe("issues");
		expect(github.label).toBe("owner/repo#42 — Track regressions");
		expect((github.iconPath as { id: string }).id).toBe("issues");
	});

	it("never includes status in the row description even when status is present", () => {
		const item = new ReferenceItem(
			makeReference({
				status: "In Progress",
				priority: "High",
				labels: ["bug", "frontend"],
				description: "A short description of the issue.",
			}),
		);

		expect(item.description).not.toContain("In Progress");
		expect(item.description).not.toContain("·");
		// Plain-text tooltip (not MarkdownString) — the panel webview renders
		// TreeItem tooltips via textContent, which would surface markdown
		// source verbatim if we used a MarkdownString here.
		const tooltip = item.tooltip as string;
		expect(typeof tooltip).toBe("string");
		expect(tooltip).toContain("Status: In Progress");
		expect(tooltip).toContain("Priority: High");
		expect(tooltip).toContain("Labels: bug, frontend");
		expect(tooltip).toContain("https://linear.app/test/issue/PROJ-1528");
		expect(tooltip).toContain("A short description");
		expect(tooltip).not.toContain("\\-");
		expect(tooltip).not.toContain("\\#");
		expect(tooltip).not.toContain("**");
		expect(tooltip).not.toContain("$(link-external)");
	});

	it("tooltip emits the metadata separator when ONLY labels are set (covers the labels-only short-circuit)", () => {
		// Triple-OR short-circuit: status / priority / labels-length. The
		// previous tests hit the status-true and status-undefined paths; this
		// one pins the labels-only branch so the comparator's third operand
		// is exercised in isolation.
		const item = new ReferenceItem(
			makeReference({
				status: undefined,
				priority: undefined,
				labels: ["bug"],
			}),
		);
		const tooltip = item.tooltip as string;
		expect(tooltip).toContain("Labels: bug");
		expect(tooltip).not.toContain("Status:");
		expect(tooltip).not.toContain("Priority:");
	});

	it("Notion-source tooltip omits the nativeId prefix and the metadata block when no status/priority/labels are set", () => {
		// Pins the buildEntityTooltip Notion branch + the hasMeta short-circuit.
		// Notion entities have no native id worth surfacing — the first line is
		// just the title. With no status / priority / labels, the metadata
		// separator line is suppressed so the tooltip stays tight.
		const item = new ReferenceItem(
			makeReference({
				source: "notion",
				nativeId: "abcdef0123456789",
				title: "Roadmap",
				mapKey: "notion:abcdef0123456789",
				url: "https://www.notion.so/abcdef0123456789",
				status: undefined,
				priority: undefined,
				labels: undefined,
				description: undefined,
			}),
		);
		const tooltip = item.tooltip as string;
		expect(tooltip.split("\n")[0]).toBe("Roadmap");
		expect(tooltip).not.toContain("abcdef0123456789 —");
		expect(tooltip).not.toContain("Status:");
		expect(tooltip).not.toContain("Priority:");
		expect(tooltip).not.toContain("Labels:");
		expect(tooltip).toContain("https://www.notion.so/abcdef0123456789");
	});

	it("truncates descriptions longer than 200 chars with an ellipsis in the plain-text tooltip", () => {
		// Pins the description-length branch in buildEntityTooltip (the
		// activity-bar TreeView fallback). The webview hover-card no longer
		// surfaces the description preview at all — users open the upstream
		// link if they want the full body.
		const longDescription = "X".repeat(250);
		const item = new ReferenceItem(
			makeReference({ description: longDescription }),
		);

		const tooltip = item.tooltip as string;
		expect(tooltip).toContain("…");
		expect(tooltip).not.toContain("X".repeat(201));
	});

	it("exposes structured referenceHover data for the webview hover-card renderer", () => {
		// The activity-bar TreeView ignores `referenceHover` (it reads tooltip),
		// but the webview's SidebarSerialize picks this field off the item and
		// forwards it on the wire so renderEntityHoverCard can produce the
		// codicon-rich popover. `source` is the new field driving per-provider
		// badges / Open-in-<X> link labels.
		const item = new ReferenceItem(
			makeReference({
				status: "In Progress",
				priority: "High",
				labels: ["bug", "frontend"],
				description: "A short description of the issue.",
			}),
		);

		const hover = (item as unknown as { referenceHover: Record<string, unknown> })
			.referenceHover;
		expect(hover.title).toBe("PROJ-1528 — Sample Issue");
		expect(hover.source).toBe("linear");
		expect(hover.status).toBe("In Progress");
		expect(hover.priority).toBe("High");
		expect(hover.labels).toBe("bug, frontend");
		expect(hover.url).toBe("https://linear.app/test/issue/PROJ-1528");
		// descriptionPreview was removed — even when the source has a
		// description, the field must NOT appear on the wire payload.
		expect("descriptionPreview" in hover).toBe(false);
	});

	it("omits optional fields in referenceHover when the source ReferenceInfo lacks them", () => {
		// Pins the conditional spread shape: missing status / priority / labels
		// must NOT appear as undefined keys on the wire (the JSON would still
		// serialize them, but consumers would have to null-check).
		const item = new ReferenceItem(makeReference({ status: undefined }));

		const hover = (item as unknown as { referenceHover: Record<string, unknown> })
			.referenceHover;
		expect("status" in hover).toBe(false);
		expect("priority" in hover).toBe(false);
		expect("labels" in hover).toBe(false);
		expect(hover.title).toBeDefined();
		expect(hover.url).toBeDefined();
		expect(hover.source).toBe("linear");
	});
});

describe("PlansTreeProvider", () => {
	beforeEach(() => {
		executeCommand.mockClear();
	});

	it("refreshes plans and updates the empty context", async () => {
		const plans = [
			makePlan(),
			makePlan({ slug: "plan-beta", title: "Beta Plan" }),
		];
		const bridge = {
			listPlans: vi.fn(async () => plans),
			listNotes: vi.fn(async () => []),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);

		await provider.refresh();

		expect(bridge.listPlans).toHaveBeenCalled();
		expect(executeCommand).toHaveBeenCalledWith(
			"setContext",
			"jollimemory.plans.empty",
			false,
		);
		const children = provider.getChildren() as Array<PlanItem>;
		expect(children.map((item) => item.plan.slug)).toEqual([
			"plan-alpha",
			"plan-beta",
		]);
		expect(provider.getTreeItem(children[0])).toBeInstanceOf(PlanItem);
	});

	it("clears plans immediately when disabled", async () => {
		const bridge = {
			listPlans: vi.fn(async () => [makePlan()]),
			listNotes: vi.fn(async () => []),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);

		provider.setEnabled(false);
		await provider.refresh();

		expect(bridge.listPlans).not.toHaveBeenCalled();
		expect(provider.getChildren()).toEqual([]);
	});

	it("sets plans.empty context to true when both plans and notes are empty", async () => {
		const bridge = {
			listPlans: vi.fn(async () => []),
			listNotes: vi.fn(async () => []),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);

		await provider.refresh();

		expect(executeCommand).toHaveBeenCalledWith(
			"setContext",
			"jollimemory.plans.empty",
			true,
		);
		expect(provider.getChildren()).toEqual([]);
	});

	it("merges plans and notes sorted by lastModified descending", async () => {
		const plans = [
			makePlan({
				slug: "older-plan",
				lastModified: "2026-03-29T08:00:00.000Z",
			}),
		];
		const notes = [
			makeNote({ id: "newer-note", lastModified: "2026-03-30T12:00:00.000Z" }),
		];
		const bridge = {
			listPlans: vi.fn(async () => plans),
			listNotes: vi.fn(async () => notes),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);

		await provider.refresh();

		const children = provider.getChildren();
		expect(children).toHaveLength(2);
		// Newer note should come first
		expect(children[0]).toBeInstanceOf(NoteItem);
		expect(children[1]).toBeInstanceOf(PlanItem);
	});

	it("returns empty when disabled even after getChildren call", () => {
		const bridge = {
			listPlans: vi.fn(async () => [makePlan()]),
			listNotes: vi.fn(async () => [makeNote()]),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);
		provider.setEnabled(false);

		expect(provider.getChildren()).toEqual([]);
	});

	it("does not fire tree change when setEnabled is called with the same value", () => {
		const bridge = {
			listPlans: vi.fn(async () => []),
			listNotes: vi.fn(async () => []),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);
		const emitter = (
			provider as unknown as {
				_onDidChangeTreeData: { fire: ReturnType<typeof vi.fn> };
			}
		)._onDidChangeTreeData;

		// Default is enabled=true, so setting true again should NOT fire
		emitter.fire.mockClear();
		provider.setEnabled(true);
		expect(emitter.fire).not.toHaveBeenCalled();

		// Now set to false (different value → fires)
		provider.setEnabled(false);
		expect(emitter.fire).toHaveBeenCalled();

		// Set to false again (same value → does NOT fire)
		emitter.fire.mockClear();
		provider.setEnabled(false);
		expect(emitter.fire).not.toHaveBeenCalled();
	});

	it("disposes its event emitter", () => {
		const provider = makePlansProvider({ listPlans: vi.fn() } as never);
		const emitter = (
			provider as unknown as {
				_onDidChangeTreeData: { dispose: ReturnType<typeof vi.fn> };
			}
		)._onDidChangeTreeData;

		provider.dispose();
		expect(emitter.dispose).toHaveBeenCalled();
	});

	it("serialize() returns SerializedTreeItem[] mapped from getChildren", async () => {
		const plans = [
			makePlan({ slug: "plan-alpha", title: "Alpha Plan" }),
			makePlan({
				slug: "plan-beta",
				title: "Beta Plan",
				commitHash: "abcdef1234567890",
			}),
		];
		const notes = [makeNote({ id: "note-alpha", title: "Alpha Note" })];
		const bridge = {
			listPlans: vi.fn(async () => plans),
			listNotes: vi.fn(async () => notes),
			listReferences: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);

		await provider.refresh();

		const out = provider.serialize?.();

		expect(Array.isArray(out)).toBe(true);
		expect(out?.length).toBeGreaterThan(0);
		expect(out?.[0]).toMatchObject({
			id: expect.any(String),
			label: expect.any(String),
		});
		// Check that icon colors are preserved for committed items
		const committedItem = out?.find((item) =>
			(item.label ?? "").includes("abcdef12"),
		);
		if (committedItem) {
			expect(committedItem.iconKey).toBe("lock");
			expect(committedItem.iconColor).toBe("charts.green");
		}
	});

	describe("serialize", () => {
		it("uses plan.slug as id for plan items", async () => {
			const plans = [makePlan({ slug: "feature-x", title: "Feature X" })];
			const bridge = {
				listPlans: vi.fn(async () => plans),
				listNotes: vi.fn(async () => []),
				listReferences: vi.fn(async () => []),
			};
			const provider = makePlansProvider(bridge as never);

			await provider.refresh();

			const items = provider.serialize?.();
			expect(items?.[0]?.id).toBe("feature-x");
		});

		it("uses note.id as id for note items", async () => {
			const notes = [makeNote({ id: "note-abc", title: "Note A" })];
			const bridge = {
				listPlans: vi.fn(async () => []),
				listNotes: vi.fn(async () => notes),
				listReferences: vi.fn(async () => []),
			};
			const provider = makePlansProvider(bridge as never);

			await provider.refresh();

			const items = provider.serialize?.();
			expect(items?.[0]?.id).toBe("note-abc");
		});
	});

	describe("entity rows", () => {
		// Entity rendering exercises the third arm of getChildren() + serialize()
		// (lines 235 / 250 in PlansTreeProvider.ts). Before the ReferenceItem
		// refactor these were `linearIssue` paths with their own LinearIssueItem
		// tests; the merge is now uniform across providers, so a single test
		// covering the entity arm is enough.
		it("getChildren() yields an ReferenceItem for each entity in the store snapshot", async () => {
			const entity: ReferenceInfo = makeReference();
			const bridge = {
				listPlans: vi.fn(async () => []),
				listNotes: vi.fn(async () => []),
				listReferences: vi.fn(async () => [entity]),
			};
			const provider = makePlansProvider(bridge as never);
			await provider.refresh();

			const children = provider.getChildren();
			expect(children).toHaveLength(1);
			expect(children[0]).toBeInstanceOf(ReferenceItem);
		});

		it("serialize() uses entity.mapKey as id and defaults isSelected=true with no exclusion present", async () => {
			const entity: ReferenceInfo = makeReference({ mapKey: "jira:KAN-7" });
			const bridge = {
				listPlans: vi.fn(async () => []),
				listNotes: vi.fn(async () => []),
				listReferences: vi.fn(async () => [entity]),
			};
			const provider = makePlansProvider(bridge as never);
			await provider.refresh();

			const items = provider.serialize?.();
			expect(items).toHaveLength(1);
			expect(items?.[0].id).toBe("jira:KAN-7");
			// Without an entry in `exclusions.entities`, the row reads as selected.
			expect(
				(items?.[0] as { isSelected?: boolean }).isSelected,
			).toBe(true);
		});
	});

	describe("isSelected via exclusions cache", () => {
		/**
		 * Build a PlansStore+PlansTreeProvider pair with the given plan slugs
		 * rooted at cwd. The store is pre-populated via an initial refresh() call.
		 */
		async function makePlansProviderWithCwd(
			slugs: readonly string[],
			cwd: string,
		) {
			const plans = slugs.map((slug) => makePlan({ slug, title: slug }));
			const bridge = {
				listPlans: vi.fn(async () => plans),
				listNotes: vi.fn(async () => []),
				listReferences: vi.fn(async () => []),
			};
			const store = new PlansStore(bridge as never);
			const provider = new PlansTreeProvider(store, cwd);
			// Populate the store before serializing
			await store.refresh();
			return provider;
		}

		it("stamps isSelected=false on a plan row whose slug is in the exclusion set", async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jolli-test-"));
			try {
				await setExcluded(cwd, "plans", "plan-skip", true);

				const provider = await makePlansProviderWithCwd(
					["plan-keep", "plan-skip"],
					cwd,
				);
				await provider.refreshExclusions();
				const items = provider.serialize();

				const skip = items.find(
					(i) => typeof i.id === "string" && i.id.endsWith("plan-skip"),
				);
				const keep = items.find(
					(i) => typeof i.id === "string" && i.id.endsWith("plan-keep"),
				);
				expect(skip?.isSelected).toBe(false);
				expect(keep?.isSelected).toBe(true);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});

		it("stamps isSelected=true by default when no exclusion file is present", async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jolli-test-"));
			try {
				const provider = await makePlansProviderWithCwd(["plan-alpha"], cwd);
				await provider.refreshExclusions();
				const items = provider.serialize();

				for (const item of items) {
					expect(item.isSelected).toBe(true);
				}
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});

		it("stamps isSelected=false on an entity row whose mapKey is in the exclusion set", async () => {
			const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jolli-test-"));
			try {
				await setExcluded(cwd, "references", "jira:KAN-7", true);

				// Build a PlansStore with one Linear and one Jira entity; only
				// the Jira mapKey is excluded.
				const keepEntity: ReferenceInfo = makeReference({ mapKey: "linear:LIN-1" });
				const skipEntity: ReferenceInfo = makeReference({ mapKey: "jira:KAN-7" });
				const bridge = {
					listPlans: vi.fn(async () => []),
					listNotes: vi.fn(async () => []),
					listReferences: vi.fn(async () => [keepEntity, skipEntity]),
				};
				const store = new PlansStore(bridge as never);
				const provider = new PlansTreeProvider(store, cwd);
				await store.refresh();
				await provider.refreshExclusions();

				const items = provider.serialize();
				const skip = items.find((i) => i.id === "jira:KAN-7");
				const keep = items.find((i) => i.id === "linear:LIN-1");
				expect(skip?.isSelected).toBe(false);
				expect(keep?.isSelected).toBe(true);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});
