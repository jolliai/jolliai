import { describe, expect, it, vi } from "vitest";

vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn() }));
vi.mock("./TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));

import type { StorageProvider } from "./StorageProvider.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";
import { renderTopicKBWiki } from "./TopicWikiRenderer.js";

const page = (slug: string) => ({
	schemaVersion: 1 as const,
	stableSlug: slug,
	title: slug,
	content: "b",
	relatedBranches: [] as string[],
	sourceRefs: [] as never[],
	lastUpdatedAt: "2026-01-01T00:00:00Z",
});
const idxEntry = (slug: string) => ({
	stableSlug: slug,
	title: slug,
	summary: "s",
	relatedBranches: [] as string[],
	sourceRefs: [] as never[],
	lastUpdatedAt: "2026-01-01T00:00:00Z",
});

describe("renderTopicKBWiki", () => {
	it("reads pages named by the authoritative index and calls storage.renderTopicWiki", async () => {
		vi.mocked(readTopicIndex).mockResolvedValue({
			schemaVersion: 1,
			topics: [idxEntry("auth"), idxEntry("storage")],
		});
		vi.mocked(readTopicPage).mockImplementation(async (slug) => page(slug));
		const renderTopicWiki = vi.fn(async () => {});
		const storage = { renderTopicWiki } as unknown as StorageProvider;
		await renderTopicKBWiki("/tmp/x", storage);
		expect(renderTopicWiki).toHaveBeenCalledTimes(1);
		const call0 = renderTopicWiki.mock.calls[0] as unknown as [unknown[]];
		expect(call0).toBeDefined();
		expect(call0[0].map((p) => (p as { stableSlug: string }).stableSlug)).toEqual(["auth", "storage"]);
	});

	it("routes the storage.renderTopicWiki write through the provided writeGuard", async () => {
		// The visible-wiki render is one bulk write; the QueueWorker wraps it in the
		// per-vault lock so it can't land mid-sync. The guard must wrap the actual
		// renderTopicWiki call, and the reads (index/pages) must precede it.
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [idxEntry("auth")] });
		vi.mocked(readTopicPage).mockImplementation(async (slug) => page(slug));
		const order: string[] = [];
		const renderTopicWiki = vi.fn(async () => {
			order.push("render");
		});
		const writeGuard = vi.fn(async (fn: () => Promise<void>): Promise<void> => {
			order.push("guard-enter");
			await fn();
			order.push("guard-exit");
		});
		await renderTopicKBWiki("/tmp/x", { renderTopicWiki } as unknown as StorageProvider, writeGuard);
		expect(writeGuard).toHaveBeenCalledTimes(1);
		expect(renderTopicWiki).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["guard-enter", "render", "guard-exit"]);
	});

	it("skips index entries whose page file is missing", async () => {
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [idxEntry("auth"), idxEntry("gone")] });
		vi.mocked(readTopicPage).mockImplementation(async (slug) => (slug === "gone" ? null : page(slug)));
		const renderTopicWiki = vi.fn(async () => {});
		await renderTopicKBWiki("/tmp/x", { renderTopicWiki } as unknown as StorageProvider);
		const call0b = renderTopicWiki.mock.calls[0] as unknown as [unknown[]];
		expect(call0b).toBeDefined();
		expect(call0b[0].map((p) => (p as { stableSlug: string }).stableSlug)).toEqual(["auth"]);
	});

	it("no-ops when the provider has no renderTopicWiki (orphan-only)", async () => {
		// Returns before reading the index when the method is absent, so no index mock is needed.
		vi.mocked(readTopicIndex).mockClear();
		const storage = {} as StorageProvider; // no renderTopicWiki
		await expect(renderTopicKBWiki("/tmp/x", storage)).resolves.toBeUndefined();
		expect(vi.mocked(readTopicIndex)).not.toHaveBeenCalled();
	});
});
