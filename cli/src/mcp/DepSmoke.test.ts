import { describe, expect, it } from "vitest";

describe("dependency smoke test", () => {
	it("imports @orama/orama core fns", async () => {
		const orama = await import("@orama/orama");
		expect(typeof orama.create).toBe("function");
		expect(typeof orama.search).toBe("function");
		expect(typeof orama.insertMultiple).toBe("function");
	});

	it("imports @orama/plugin-data-persistence", async () => {
		const p = await import("@orama/plugin-data-persistence");
		expect(typeof p.persist).toBe("function");
		expect(typeof p.restore).toBe("function");
	});

	it("imports MCP SDK Server + stdio transport", async () => {
		const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
		const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
		expect(typeof Server).toBe("function");
		expect(typeof StdioServerTransport).toBe("function");
	});
});
