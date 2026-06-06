import { describe, expect, it } from "vitest";
import type { FileWrite } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";
import type { TopicPage } from "./TopicKBTypes.js";
import { listTopicPageSlugs, purgeTopicPagesExcept, readTopicPage, saveTopicPage } from "./TopicPageStore.js";

function makeFakeStorage(initial: Record<string, string> = {}): StorageProvider {
	const files = new Map(Object.entries(initial));
	return {
		readFile: async (p: string) => files.get(p) ?? null,
		writeFiles: async (fws: FileWrite[]) => {
			for (const f of fws) {
				if (f.delete) files.delete(f.path);
				else files.set(f.path, f.content);
			}
		},
		listFiles: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
		exists: async () => true,
		ensure: async () => {},
	};
}

const page: TopicPage = {
	schemaVersion: 1,
	stableSlug: "auth-origin-allowlist",
	title: "Auth & origin allowlist",
	content: "Body.",
	relatedBranches: ["main"],
	sourceRefs: [{ type: "summary", id: "abc", timestamp: "2026-01-01T00:00:00Z" }],
	lastUpdatedAt: "2026-01-02T00:00:00Z",
};

describe("TopicPageStore", () => {
	it("returns null for a missing page", async () => {
		expect(await readTopicPage("auth-origin-allowlist", "/tmp/x", makeFakeStorage())).toBeNull();
	});

	it("round-trips through save/read at topics/<slug>.json", async () => {
		const storage = makeFakeStorage();
		await saveTopicPage(page, "/tmp/x", storage);
		expect(await readTopicPage("auth-origin-allowlist", "/tmp/x", storage)).toEqual(page);
	});

	it("lists page slugs excluding index.json and processed.json", async () => {
		const storage = makeFakeStorage({
			"topics/index.json": "{}",
			"topics/processed.json": "{}",
			"topics/auth-origin-allowlist.json": "{}",
			"topics/storage-providers.json": "{}",
		});
		const slugs = await listTopicPageSlugs("/tmp/x", storage);
		expect([...slugs].sort()).toEqual(["auth-origin-allowlist", "storage-providers"]);
	});

	it("returns null on unparseable page JSON", async () => {
		const storage = makeFakeStorage({ "topics/bad.json": "{nope" });
		expect(await readTopicPage("bad", "/tmp/x", storage)).toBeNull();
	});

	it("refuses to read an unsafe (path-traversal) slug, returning null without touching storage", async () => {
		let reads = 0;
		const storage = makeFakeStorage();
		const tracking: StorageProvider = {
			...storage,
			readFile: async (p: string) => {
				reads++;
				return storage.readFile(p);
			},
		};
		expect(await readTopicPage("../config", "/tmp/x", tracking)).toBeNull();
		expect(await readTopicPage("a/b", "/tmp/x", tracking)).toBeNull();
		expect(await readTopicPage("", "/tmp/x", tracking)).toBeNull();
		expect(reads).toBe(0); // guarded before any storage access
	});

	it("throws when saving a page with an unsafe slug", async () => {
		const storage = makeFakeStorage();
		const bad: TopicPage = { ...page, stableSlug: "../escape" };
		await expect(saveTopicPage(bad, "/tmp/x", storage)).rejects.toThrow(/unsafe slug/);
		expect(await storage.listFiles("topics/")).toEqual([]); // nothing written
	});

	it("purges orphaned topic pages not in the keep set (the --rebuild leftover bug)", async () => {
		const storage = makeFakeStorage({
			"topics/index.json": "{}",
			"topics/processed.json": "{}",
			"topics/keep-me.json": "{}",
			"topics/orphan-one.json": "{}",
			"topics/orphan-two.json": "{}",
		});
		const purged = await purgeTopicPagesExcept(["keep-me"], "/tmp/x", storage);
		expect(purged.sort()).toEqual(["orphan-one", "orphan-two"]);
		// reserved files are never touched; the kept page survives.
		expect([...(await listTopicPageSlugs("/tmp/x", storage))].sort()).toEqual(["keep-me"]);
		expect(await storage.readFile("topics/index.json")).toBe("{}");
	});

	it("is a no-op (issues no delete commit) when every page is in the keep set", async () => {
		const base = makeFakeStorage({ "topics/a.json": "{}", "topics/b.json": "{}" });
		let writeCalls = 0;
		const storage: StorageProvider = {
			...base,
			writeFiles: async (fws: FileWrite[], message: string) => {
				writeCalls++;
				return base.writeFiles(fws, message);
			},
		};
		const purged = await purgeTopicPagesExcept(["a", "b", "extra"], "/tmp/x", storage);
		expect(purged).toEqual([]);
		expect(writeCalls).toBe(0);
	});
});
