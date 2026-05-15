import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type { LinearIssueInfo } from "../Types.js";
import {
	LinearIssueItem,
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

function makeLinearIssue(
	overrides: Partial<LinearIssueInfo> = {},
): LinearIssueInfo {
	return {
		kind: "linearissue",
		mapKey: "JOLLI-1528",
		ticketId: "JOLLI-1528",
		title: "Sample Issue",
		url: "https://linear.app/test/issue/JOLLI-1528",
		filename: "JOLLI-1528.md",
		filePath: "/repo/.jolli/jollimemory/linear-issues/JOLLI-1528.md",
		lastModified: "2026-03-30T11:00:00.000Z",
		addedAt: "2026-03-30T09:00:00.000Z",
		updatedAt: "2026-03-30T11:00:00.000Z",
		branch: "feature/test",
		commitHash: null,
		...overrides,
	};
}

describe("LinearIssueItem", () => {
	it("renders ticketId · title with date-only description (status intentionally omitted)", () => {
		// `buildLinearIssueDescription` now ALWAYS returns the relative date
		// alone — the captured status field was dropped from the row text
		// because it can drift from the live Linear value (we don't poll), so
		// surfacing it risked misleading users with stale labels. Tooltip
		// retains the status for hover-inspection of captured state.
		const item = new LinearIssueItem(makeLinearIssue({ status: undefined }));

		expect(item.label).toBe("JOLLI-1528 — Sample Issue");
		expect(item.contextValue).toBe("linearissue");
		expect(item.description).not.toContain("undefined");
		// Icon is the GitHub-style "issue-opened" codicon tinted with the
		// Linear brand purple (linearIssue.iconColor). Earlier iterations
		// used `circle-large-filled` (semantically meaningless dot) and an
		// inlined SVG of the Linear logo (failed to render legibly at 16x16).
		expect((item.iconPath as { id: string }).id).toBe("issue-opened");
		expect(item.command).toEqual({
			command: "jollimemory.openLinearIssueMarkdown",
			title: "Open Linear Issue Markdown",
			arguments: [item],
		});
	});

	it("never includes status in the row description even when status is present", () => {
		// Regression guard: prior to the stale-data fix this row read
		// `In Progress · 2 days ago`. Status now lives only in the tooltip.
		const item = new LinearIssueItem(
			makeLinearIssue({
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
		// source verbatim if we used a MarkdownString here. See the
		// buildLinearIssueTooltip docstring for the full reasoning.
		const tooltip = item.tooltip as string;
		expect(typeof tooltip).toBe("string");
		expect(tooltip).toContain("Status: In Progress");
		expect(tooltip).toContain("Priority: High");
		expect(tooltip).toContain("Labels: bug, frontend");
		expect(tooltip).toContain("https://linear.app/test/issue/JOLLI-1528");
		expect(tooltip).toContain("A short description");
		// No backslash escapes and no markdown markers — the previous
		// MarkdownString version emitted `**JOLLI\-1528**` etc. that the
		// webview rendered as literal text.
		expect(tooltip).not.toContain("\\-");
		expect(tooltip).not.toContain("\\#");
		expect(tooltip).not.toContain("**");
		expect(tooltip).not.toContain("$(link-external)");
	});

	it("truncates descriptions longer than 200 chars with an ellipsis in the plain-text tooltip", () => {
		// Pins the description-length branch in `buildLinearIssueTooltip`
		// (the activity-bar TreeView fallback). The webview hover-card no
		// longer surfaces the description preview at all — see the
		// LinearIssueItem comment for why; users open the upstream Linear
		// link if they want the full body.
		const longDescription = "X".repeat(250);
		const item = new LinearIssueItem(
			makeLinearIssue({ description: longDescription }),
		);

		const tooltip = item.tooltip as string;
		expect(tooltip).toContain("…");
		expect(tooltip).not.toContain("X".repeat(201));
	});

	it("exposes structured linearHover data for the webview hover-card renderer", () => {
		// The activity-bar TreeView ignores `linearHover` (it reads tooltip),
		// but the webview's SidebarSerialize picks this field off the item and
		// forwards it on the wire so renderLinearHoverCard can produce the
		// codicon-rich popover. No descriptionPreview — the field was dropped
		// to keep the hover card concise.
		const item = new LinearIssueItem(
			makeLinearIssue({
				status: "In Progress",
				priority: "High",
				labels: ["bug", "frontend"],
				description: "A short description of the issue.",
			}),
		);

		const hover = (item as unknown as { linearHover: Record<string, unknown> })
			.linearHover;
		expect(hover.title).toBe("JOLLI-1528 — Sample Issue");
		expect(hover.status).toBe("In Progress");
		expect(hover.priority).toBe("High");
		expect(hover.labels).toBe("bug, frontend");
		expect(hover.url).toBe("https://linear.app/test/issue/JOLLI-1528");
		// descriptionPreview was removed from LinearIssueHover — even when
		// the source issue has a description, the field must NOT appear
		// on the wire payload.
		expect("descriptionPreview" in hover).toBe(false);
	});

	it("omits optional fields in linearHover when the source LinearIssueInfo lacks them", () => {
		// Pins the conditional spread shape: missing status / priority / labels
		// must NOT appear as undefined keys on the wire (the JSON would still
		// serialize them, but consumers would have to null-check).
		const item = new LinearIssueItem(makeLinearIssue({ status: undefined }));

		const hover = (item as unknown as { linearHover: Record<string, unknown> })
			.linearHover;
		expect("status" in hover).toBe(false);
		expect("priority" in hover).toBe(false);
		expect("labels" in hover).toBe(false);
		expect(hover.title).toBeDefined();
		expect(hover.url).toBeDefined();
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
			listLinearIssues: vi.fn(async () => []),
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
			listLinearIssues: vi.fn(async () => []),
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
			listLinearIssues: vi.fn(async () => []),
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
			listLinearIssues: vi.fn(async () => []),
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
			listLinearIssues: vi.fn(async () => []),
		};
		const provider = makePlansProvider(bridge as never);
		provider.setEnabled(false);

		expect(provider.getChildren()).toEqual([]);
	});

	it("does not fire tree change when setEnabled is called with the same value", () => {
		const bridge = {
			listPlans: vi.fn(async () => []),
			listNotes: vi.fn(async () => []),
			listLinearIssues: vi.fn(async () => []),
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
			listLinearIssues: vi.fn(async () => []),
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
				listLinearIssues: vi.fn(async () => []),
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
				listLinearIssues: vi.fn(async () => []),
			};
			const provider = makePlansProvider(bridge as never);

			await provider.refresh();

			const items = provider.serialize?.();
			expect(items?.[0]?.id).toBe("note-abc");
		});
	});
});
