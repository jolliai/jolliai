import { beforeEach, describe, expect, it, vi } from "vitest";

const { item, createStatusBarItem, ThemeColor } = vi.hoisted(() => {
	const item = {
		command: undefined as string | undefined,
		tooltip: undefined as string | undefined,
		text: "",
		backgroundColor: undefined as unknown,
		color: undefined as unknown,
		show: vi.fn(),
		dispose: vi.fn(),
	};
	const createStatusBarItem = vi.fn(() => item);
	class ThemeColor {
		readonly id: string;
		constructor(id: string) {
			this.id = id;
		}
	}
	return { item, createStatusBarItem, ThemeColor };
});

vi.mock("vscode", () => ({
	StatusBarAlignment: { Left: 1 },
	ThemeColor,
	window: {
		createStatusBarItem,
	},
}));

import { StatusBarManager } from "./StatusBarManager.js";

describe("StatusBarManager", () => {
	beforeEach(() => {
		item.command = undefined;
		item.tooltip = undefined;
		item.text = "";
		item.backgroundColor = undefined;
		item.color = undefined;
		item.show.mockClear();
		item.dispose.mockClear();
		createStatusBarItem.mockClear();
	});

	it("creates and shows the status bar item on construction", () => {
		new StatusBarManager();

		expect(createStatusBarItem).toHaveBeenCalledWith(1, 100);
		expect(item.command).toBe("jollimemory.focusSidebar");
		expect(item.tooltip).toBe("Jolli Memory — click to open sidebar");
		expect(item.show).toHaveBeenCalled();
	});

	it("renders disabled and enabled states", () => {
		const manager = new StatusBarManager();

		manager.update(false);
		expect(item.text).toBe("$(circle-outline) Jolli Memory (disabled)");
		expect((item.backgroundColor as { id: string }).id).toBe(
			"statusBarItem.warningBackground",
		);

		manager.update(true);
		expect(item.text).toBe("Jolli Memory");
		expect(item.backgroundColor).toBeUndefined();
		expect(item.color).toBeUndefined();
	});

	it("disposes the underlying item", () => {
		const manager = new StatusBarManager();

		manager.dispose();
		expect(item.dispose).toHaveBeenCalled();
	});
});
