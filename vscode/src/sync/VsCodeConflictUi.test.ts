/**
 * Tests for VsCodeConflictUi — Quick Pick + diff view.
 *
 * The `vscode` module is fully mocked. We assert on what was passed to
 * `showQuickPick` and `vscode.diff` rather than the rendered UI itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeQuickPickItem {
	label: string;
	key: "mine" | "theirs" | "viewDiff" | "skip";
	description?: string;
}

const { showQuickPick, openTextDocument, executeCommand, parseUri } =
	vi.hoisted(() => ({
		showQuickPick: vi.fn(),
		openTextDocument: vi.fn(),
		executeCommand: vi.fn(),
		parseUri: vi.fn((s: string) => ({
			toString: () => s,
			scheme: "untitled",
			fsPath: s,
		})),
	}));

vi.mock("vscode", () => ({
	window: { showQuickPick, showInformationMessage: vi.fn() },
	workspace: { openTextDocument },
	commands: { executeCommand },
	Uri: { parse: parseUri },
}));

import { VsCodeConflictUi } from "./VsCodeConflictUi.js";

beforeEach(() => {
	showQuickPick.mockReset();
	openTextDocument.mockReset();
	executeCommand.mockReset();
	parseUri.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("VsCodeConflictUi.promptBinaryPick", () => {
	it("maps the picked item's key to a Tier3Pick", async () => {
		showQuickPick.mockResolvedValueOnce({
			label: "$(check) Use my edit",
			key: "mine",
		});
		const ui = new VsCodeConflictUi();
		const pick = await ui.promptBinaryPick("a.md", null, null);
		expect(pick).toBe("mine");
	});

	it("returns skip when the user dismisses the picker (undefined)", async () => {
		showQuickPick.mockResolvedValueOnce(undefined);
		const ui = new VsCodeConflictUi();
		expect(await ui.promptBinaryPick("a.md", null, null)).toBe("skip");
	});

	it("presents all four choices and embeds the path in the placeholder", async () => {
		showQuickPick.mockResolvedValueOnce({
			label: "$(close) Skip — resolve later",
			key: "skip",
		});
		const ui = new VsCodeConflictUi();
		await ui.promptBinaryPick("notes/foo.md", null, null);
		const firstCall = showQuickPick.mock.calls[0];
		if (!firstCall) throw new Error("showQuickPick never called");
		const [items, opts] = firstCall;
		const keys = (items as ReadonlyArray<FakeQuickPickItem>).map((i) => i.key);
		expect(keys).toEqual(["mine", "theirs", "viewDiff", "skip"]);
		expect((opts as { placeHolder?: string }).placeHolder).toContain(
			"notes/foo.md",
		);
		expect((opts as { ignoreFocusOut?: boolean }).ignoreFocusOut).toBe(true);
	});

	it("each value of pick (mine/theirs/viewDiff/skip) round-trips", async () => {
		const ui = new VsCodeConflictUi();
		for (const k of ["mine", "theirs", "viewDiff", "skip"] as const) {
			showQuickPick.mockResolvedValueOnce({ key: k, label: k });
			expect(await ui.promptBinaryPick("x", null, null)).toBe(k);
		}
	});
});

describe("VsCodeConflictUi.showDiff", () => {
	it("opens both blobs as text documents and invokes vscode.diff", async () => {
		const oursDoc = {
			uri: { toString: () => "untitled:mine", fsPath: "/mine" },
		};
		const theirsDoc = {
			uri: { toString: () => "untitled:theirs", fsPath: "/theirs" },
		};
		openTextDocument.mockResolvedValueOnce(oursDoc);
		openTextDocument.mockResolvedValueOnce(theirsDoc);

		const ui = new VsCodeConflictUi();
		await ui.showDiff("notes/foo.md", "ours-body", "theirs-body");

		expect(openTextDocument).toHaveBeenCalledWith({
			content: "ours-body",
			language: "markdown",
		});
		expect(openTextDocument).toHaveBeenCalledWith({
			content: "theirs-body",
			language: "markdown",
		});
		expect(executeCommand).toHaveBeenCalledWith(
			"vscode.diff",
			oursDoc.uri,
			theirsDoc.uri,
			expect.stringContaining("notes/foo.md"),
			expect.objectContaining({ preview: true }),
		);
	});
});
