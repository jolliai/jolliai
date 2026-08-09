import { describe, expect, it } from "vitest";
import type { StorageProvider } from "./StorageProvider.js";
import { detectStoredMemories } from "./StoredMemories.js";

/** Only the two members the detector touches; the rest would never be called. */
const storage = (over: Partial<StorageProvider>): StorageProvider =>
	({
		kind: "sqlite",
		exists: async () => true,
		listFiles: async () => [],
		...over,
	}) as unknown as StorageProvider;

describe("detectStoredMemories", () => {
	it("reports `some` when summaries are stored", async () => {
		expect(await detectStoredMemories(storage({ listFiles: async () => ["summaries/a.json"] }))).toBe("some");
	});

	// The case `exists()` gets wrong past a cutover: the database opens and the
	// repo has a registry row from its first `jolli enable`, but holds nothing.
	it("reports `none` for an initialized backend with no summaries", async () => {
		expect(await detectStoredMemories(storage({ exists: async () => true, listFiles: async () => [] }))).toBe(
			"none",
		);
	});

	it("reports `none` without listing when the backend is not initialized", async () => {
		let listed = false;
		const result = await detectStoredMemories(
			storage({
				exists: async () => false,
				listFiles: async () => {
					listed = true;
					return ["summaries/a.json"];
				},
			}),
		);
		expect(result).toBe("none");
		expect(listed).toBe(false);
	});

	// The whole reason this is three-state: a read failure must not reach the
	// caller as "none", which is the branch that archives the user's folders.
	it("reports `unknown` when the listing throws", async () => {
		const result = await detectStoredMemories(
			storage({
				listFiles: async () => {
					throw new Error("SQLITE_CANTOPEN");
				},
			}),
		);
		expect(result).toBe("unknown");
	});

	it("reports `unknown` when the existence probe itself throws", async () => {
		const result = await detectStoredMemories(
			storage({
				exists: async () => {
					throw new Error("disk gone");
				},
			}),
		);
		expect(result).toBe("unknown");
	});
});
