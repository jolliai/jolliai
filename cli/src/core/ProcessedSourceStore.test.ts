import { describe, expect, it } from "vitest";
import type { FileWrite } from "../Types.js";
import {
	addProcessed,
	emptyProcessedSet,
	hasProcessed,
	readProcessedSet,
	saveProcessedSet,
} from "./ProcessedSourceStore.js";
import type { StorageProvider } from "./StorageProvider.js";
import type { SourceRef } from "./TopicKBTypes.js";

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

const ref = (type: SourceRef["type"], id: string): SourceRef => ({ type, id, timestamp: "2026-01-01T00:00:00Z" });

describe("ProcessedSourceStore", () => {
	it("returns an empty set when the file is absent", async () => {
		const set = await readProcessedSet("/tmp/x", makeFakeStorage());
		expect(set).toEqual(emptyProcessedSet());
	});

	it("hasProcessed reflects membership by type+id", () => {
		const set = addProcessed(emptyProcessedSet(), [ref("summary", "abc"), ref("plan", "p1")]);
		expect(hasProcessed(set, ref("summary", "abc"))).toBe(true);
		expect(hasProcessed(set, ref("plan", "p1"))).toBe(true);
		expect(hasProcessed(set, ref("summary", "p1"))).toBe(false); // same id, wrong type
		expect(hasProcessed(set, ref("note", "abc"))).toBe(false);
	});

	it("addProcessed is idempotent and immutable", () => {
		const base = emptyProcessedSet();
		const once = addProcessed(base, [ref("summary", "abc")]);
		const twice = addProcessed(once, [ref("summary", "abc")]);
		expect(twice.processed.summary).toEqual(["abc"]);
		expect(base.processed.summary).toEqual([]); // original untouched
	});

	it("round-trips through save/read", async () => {
		const storage = makeFakeStorage();
		const set = addProcessed(emptyProcessedSet(), [ref("userfile", "a.md@deadbeef")]);
		await saveProcessedSet(set, "/tmp/x", storage);
		const back = await readProcessedSet("/tmp/x", storage);
		expect(back).toEqual(set);
	});

	it("normalizes a partial on-disk shape to all four buckets", async () => {
		const storage = makeFakeStorage({
			"topics/processed.json": JSON.stringify({ schemaVersion: 1, processed: { summary: ["x"] } }),
		});
		const set = await readProcessedSet("/tmp/x", storage);
		expect(set.processed).toEqual({ summary: ["x"], plan: [], note: [], userfile: [] });
	});

	it("returns empty on unparseable JSON", async () => {
		const storage = makeFakeStorage({ "topics/processed.json": "{not json" });
		const set = await readProcessedSet("/tmp/x", storage);
		expect(set).toEqual(emptyProcessedSet());
	});

	it("normalizes valid JSON with no `processed` key to all four empty buckets", async () => {
		const storage = makeFakeStorage({ "topics/processed.json": JSON.stringify({ schemaVersion: 1 }) });
		const set = await readProcessedSet("/tmp/x", storage);
		expect(set).toEqual(emptyProcessedSet());
	});
});
