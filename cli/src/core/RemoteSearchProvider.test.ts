import { describe, expect, it } from "vitest";
import { RemoteSearchProvider } from "./RemoteSearchProvider.js";

describe("RemoteSearchProvider", () => {
	it("identifies its source as remote", () => {
		const provider = new RemoteSearchProvider();
		expect(provider.source).toBe("remote");
	});

	it("buildCatalog throws a not-implemented error", async () => {
		const provider = new RemoteSearchProvider();
		await expect(provider.buildCatalog({ query: "anything" })).rejects.toThrow(/Team search/);
	});

	it("loadHits throws a not-implemented error", async () => {
		const provider = new RemoteSearchProvider();
		await expect(provider.loadHits({ query: "q", hashes: ["abc"] })).rejects.toThrow(/Team search/);
	});
});
