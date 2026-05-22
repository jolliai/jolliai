import { describe, expect, it, vi } from "vitest";

// Hoisted listener registry so the EventEmitter mock can resolve to the
// listener that `provider.onDidChangeFileDecorations(...)` registered.
const { listeners } = vi.hoisted(() => ({
	listeners: [] as Array<(arg: unknown) => void>,
}));

vi.mock("vscode", () => ({
	EventEmitter: class {
		event = (cb: (arg: unknown) => void) => {
			listeners.push(cb);
			return { dispose: vi.fn() };
		};
		fire = (arg: unknown) => {
			for (const listener of listeners) listener(arg);
		};
		dispose = vi.fn();
	},
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p, scheme: "file" })),
	},
}));

import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import * as vscode from "vscode";
import { MemoryFileDecorationProvider } from "./MemoryFileDecorationProvider.js";

describe("MemoryFileDecorationProvider", () => {
	it("returns a badge decoration for diverged Memory Bank md", async () => {
		const bridge = {
			isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(true),
		} as unknown as JolliMemoryBridge;
		const provider = new MemoryFileDecorationProvider(bridge);
		const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.md");

		const result = await provider.provideFileDecoration(uri, {} as never);

		expect(result?.badge).toBe("✎");
		expect(result?.tooltip).toMatch(/edited on disk/i);
	});

	it("returns undefined for non-diverged files", async () => {
		const bridge = {
			isMemoryFileDivergedOnDisk: vi.fn().mockResolvedValue(false),
		} as unknown as JolliMemoryBridge;
		const provider = new MemoryFileDecorationProvider(bridge);
		const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.md");

		const result = await provider.provideFileDecoration(uri, {} as never);

		expect(result).toBeUndefined();
	});

	it("does not call the bridge for non-md files", async () => {
		const bridge = {
			isMemoryFileDivergedOnDisk: vi.fn(),
		} as unknown as JolliMemoryBridge;
		const provider = new MemoryFileDecorationProvider(bridge);
		const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.txt");

		const result = await provider.provideFileDecoration(uri, {} as never);

		expect(result).toBeUndefined();
		expect(bridge.isMemoryFileDivergedOnDisk).not.toHaveBeenCalled();
	});

	it("emits onDidChangeFileDecorations when refreshUri is called", () => {
		const bridge = {
			isMemoryFileDivergedOnDisk: vi.fn(),
		} as unknown as JolliMemoryBridge;
		const provider = new MemoryFileDecorationProvider(bridge);
		const uri = vscode.Uri.file("/tmp/kb/repo/main/foo.md");
		const listener = vi.fn();
		provider.onDidChangeFileDecorations(listener);

		provider.refreshUri(uri);

		expect(listener).toHaveBeenCalledWith(uri);
	});

	it("emits onDidChangeFileDecorations with undefined when refreshAll is called", () => {
		const bridge = {
			isMemoryFileDivergedOnDisk: vi.fn(),
		} as unknown as JolliMemoryBridge;
		const provider = new MemoryFileDecorationProvider(bridge);
		const listener = vi.fn();
		provider.onDidChangeFileDecorations(listener);

		provider.refreshAll();

		expect(listener).toHaveBeenCalledWith(undefined);
	});

	it("dispose tears down the internal emitter without throwing", () => {
		const bridge = {
			isMemoryFileDivergedOnDisk: vi.fn(),
		} as unknown as JolliMemoryBridge;
		const provider = new MemoryFileDecorationProvider(bridge);

		expect(() => provider.dispose()).not.toThrow();
	});
});
