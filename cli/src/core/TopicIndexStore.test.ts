import { describe, expect, it } from "vitest";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import { emptyTopicIndex, readTopicIndex, saveTopicIndex } from "./TopicIndexStore.js";
import type { TopicIndex } from "./TopicKBTypes.js";

function makeFakeStorage(initial: Record<string, string> = {}): StorageProvider {
	const files = new Map(Object.entries(initial));
	return {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFiles: async (fws: FileWrite[]) => {
			for (const f of fws) files.set(f.path, f.content);
		},
		listFiles: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
		exists: async () => true,
		ensure: async () => {},
	};
}

const sampleIndex: TopicIndex = {
	schemaVersion: 1,
	topics: [
		{
			stableSlug: "auth-origin-allowlist",
			title: "Auth & origin allowlist",
			summary: "Origin allowlist validation.",
			relatedBranches: ["main"],
			sourceRefs: [{ type: "summary", id: "abc", timestamp: "2026-01-01T00:00:00Z" }],
			lastUpdatedAt: "2026-01-02T00:00:00Z",
		},
	],
};

describe("TopicIndexStore", () => {
	it("returns an empty index when the file is absent", async () => {
		const idx = await readTopicIndex("/tmp/x", makeFakeStorage());
		expect(idx).toEqual(emptyTopicIndex());
	});

	it("round-trips through save/read", async () => {
		const storage = makeFakeStorage();
		await saveTopicIndex(sampleIndex, "/tmp/x", storage);
		const back = await readTopicIndex("/tmp/x", storage);
		expect(back).toEqual(sampleIndex);
	});

	it("returns empty index on unparseable JSON", async () => {
		const storage = makeFakeStorage({ "topics/index.json": "nope" });
		const idx = await readTopicIndex("/tmp/x", storage);
		expect(idx).toEqual(emptyTopicIndex());
	});

	it("defaults topics to an empty array when the field is absent", async () => {
		const storage = makeFakeStorage({ "topics/index.json": JSON.stringify({ schemaVersion: 1 }) });
		const idx = await readTopicIndex("/tmp/x", storage);
		expect(idx).toEqual(emptyTopicIndex());
		expect(idx.topics).toEqual([]);
	});
});
