import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { CreatePrDiffContentProvider } from "./CreatePrDiffContentProvider.js";

/** Minimal URI shape parsePrDiffUri reads: `path` + `query`. */
const uri = (path: string, query: string) => ({ path, query }) as never;

describe("CreatePrDiffContentProvider", () => {
	it("reads the file at the URI's ref + path via the injected reader", async () => {
		const read = vi.fn().mockResolvedValue("file body");
		const provider = new CreatePrDiffContentProvider(read);
		const content = await provider.provideTextDocumentContent(uri("/vscode/src/a.ts", "ref=abc"));
		expect(content).toBe("file body");
		expect(read).toHaveBeenCalledWith("abc", "vscode/src/a.ts");
	});

	it("returns an empty document without hitting the reader when the ref is missing", async () => {
		const read = vi.fn();
		const provider = new CreatePrDiffContentProvider(read);
		expect(await provider.provideTextDocumentContent(uri("/a.ts", ""))).toBe("");
		expect(read).not.toHaveBeenCalled();
	});

	it("returns an empty document without hitting the reader when the path is missing", async () => {
		const read = vi.fn();
		const provider = new CreatePrDiffContentProvider(read);
		expect(await provider.provideTextDocumentContent(uri("/", "ref=abc"))).toBe("");
		expect(read).not.toHaveBeenCalled();
	});
});
