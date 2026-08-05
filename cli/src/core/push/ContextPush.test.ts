/**
 * Tests for the generic context push engine and the kind registry.
 *
 * Two jobs beyond ordinary coverage:
 *
 *  1. **Feed the definition defaults.** The three built-in kinds all OVERRIDE
 *     `docIdField`/`docUrlField`, all link in markdown, and only plan carries
 *     `reduce`/`tiebreak` — so the default paths (`jolliDocId`, `jolliDocUrl`,
 *     `linksInMarkdown: false`) are unreachable through them. The synthetic
 *     `gadget` kind below exists to walk every one of those defaults; without it
 *     they are dead branches and the coverage gate fails.
 *  2. **Pin the invariants the generic loop must not lose**: the live opt-out
 *     re-read before EVERY send (spec 306), and the docType-wide short-circuit
 *     for `doctype_not_allowed`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../Types.js";

vi.mock("../PushControl.js", async (orig) => ({
	...(await orig<typeof import("../PushControl.js")>()),
	isOutboundPushAllowed: vi.fn(),
}));
// The kind index is mocked so the engine sees the synthetic kind alongside a
// real-shaped plan kind. Everything else in the registry chain stays real.
vi.mock("./kinds/index.js", async () => {
	const { defineContextKind } = await import("./ContextKindDefinition.js");
	const gadget = defineContextKind<GadgetItem>({
		docType: "gadget",
		field: "gadgets",
		entryKey: "gid",
		baseKey: { fields: ["gid"] },
		recency: "at",
		// docIdField / docUrlField omitted → the uniform jolliDocId / jolliDocUrl defaults.
		linksInMarkdown: false,
		title: (g) => `Gadget ${g.gid}`,
		body: async (g) => g.body,
	});
	const widget = defineContextKind<WidgetItem>({
		docType: "widget",
		field: "widgets",
		entryKey: "slug",
		baseKey: { fields: ["slug"], stripArchiveSuffix: true },
		recency: "updatedAt",
		docIdField: "widgetDocId",
		docUrlField: "widgetDocUrl",
		title: (w) => `Widget ${w.slug}`,
		body: async (w) => w.body,
		reduce: (items) => items.filter((w) => w.keep !== false),
		tiebreak: (a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
	});
	return { CONTEXT_KIND_DEFINITIONS: [widget, gadget] };
});

import { DocTypeNotAllowedError, type JolliMemoryPushClient } from "../JolliMemoryPushClient.js";
import { isOutboundPushAllowed, PushDisabledError } from "../PushControl.js";
import { defineContextKind } from "./ContextKindDefinition.js";
import { clientKeyPrefixOf, validateContextKindsForTest } from "./ContextKindRegistry.js";
import {
	applyPublishedUrls,
	assignOwnedContext,
	buildContextBatchAttachments,
	legacyNamedOwnership,
	legacyNamedSelection,
	type PushContext,
	pushContextAttachments,
	reduceOwnItems,
	selectionForCommit,
} from "./ContextPush.js";

interface GadgetItem {
	readonly gid: string;
	readonly at: string;
	readonly body?: string;
	readonly jolliDocId?: number;
	readonly jolliDocUrl?: string;
}

interface WidgetItem {
	readonly slug: string;
	readonly updatedAt: string;
	readonly body?: string;
	readonly keep?: boolean;
	readonly widgetDocId?: number;
	readonly widgetDocUrl?: string;
}

const BASE = "https://acme.jolli.ai";
const ENV_KEY = "https://acme.jolli.ai";

interface TestSummary extends CommitSummary {
	readonly gadgets?: ReadonlyArray<GadgetItem>;
	readonly widgets?: ReadonlyArray<WidgetItem>;
}

function summary(overrides: Partial<TestSummary> = {}): TestSummary {
	return {
		version: 3,
		commitHash: "abc1234567890",
		commitMessage: "feat: add feature",
		commitAuthor: "dev",
		commitDate: "2026-01-01T00:00:00.000Z",
		generatedAt: "2026-01-01T00:00:00.000Z",
		branch: "feature/x",
		topics: [],
		...overrides,
	} as TestSummary;
}

function fakeClient(push?: (payload: { docType: string }) => Promise<unknown>): JolliMemoryPushClient {
	return {
		push: vi.fn(push ?? (async () => ({ url: "", docId: 42, jrn: "jrn:1", created: true }))),
		resolveEnvKey: vi.fn(async () => ENV_KEY),
	} as unknown as JolliMemoryPushClient;
}

function ctxOf(client: JolliMemoryPushClient): PushContext {
	return { cwd: "/repo", baseUrl: BASE, repoUrl: "https://github.com/jolliai/jolli", client };
}

beforeEach(() => {
	vi.mocked(isOutboundPushAllowed).mockReset().mockResolvedValue(true);
});

// ─── Registry validation ─────────────────────────────────────────────────────

describe("validateContextKinds", () => {
	const valid = defineContextKind<GadgetItem>({
		docType: "g",
		field: "gadgets",
		entryKey: "gid",
		baseKey: { fields: ["gid"] },
		recency: "at",
		title: () => "t",
		body: async () => "b",
	});

	it("accepts a well-formed list", () => {
		expect(validateContextKindsForTest([valid])).toEqual([valid]);
	});

	it("rejects a duplicate docType", () => {
		expect(() => validateContextKindsForTest([valid, valid])).toThrow(/duplicate docType/);
	});

	it.each([
		["docType", { ...valid, docType: "" }, /docType must be/],
		["field", { ...valid, field: "" }, /field must be/],
		["entryKey", { ...valid, entryKey: "" }, /entryKey must be/],
		["recency", { ...valid, recency: "" }, /recency must be/],
		["baseKey.fields", { ...valid, baseKey: { fields: [] } }, /baseKey.fields/],
		["clientKeyPrefix", { ...valid, clientKeyPrefix: "" }, /clientKeyPrefix must be/],
	])("rejects an empty %s", (_name, def, pattern) => {
		expect(() => validateContextKindsForTest([def])).toThrow(pattern);
	});

	it("rejects two kinds that would emit the same batch clientKey prefix", () => {
		// Distinct docTypes, so the docType guard above passes — but the batch index
		// restarts per kind, so both would emit `dup-0` in one request and the server
		// would map two attachments onto one key.
		const other = { ...valid, docType: "other", clientKeyPrefix: "g" };
		expect(() => validateContextKindsForTest([valid, other])).toThrow(/duplicate clientKeyPrefix/);
	});

	it("lets a kind pin a clientKey prefix that differs from its docType", () => {
		const pinned = { ...valid, clientKeyPrefix: "gee" };
		expect(clientKeyPrefixOf(pinned)).toBe("gee");
		expect(clientKeyPrefixOf(valid)).toBe("g");
	});
});

// ─── Ownership ───────────────────────────────────────────────────────────────

describe("assignOwnedContext", () => {
	it("assigns the newest revision to its commit and seeds a missing docId from an older one", () => {
		const older = summary({
			commitHash: "1111111111111",
			gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z", jolliDocId: 7, jolliDocUrl: `${BASE}/articles?doc=7` }],
		});
		const newer = summary({
			commitHash: "2222222222222",
			gadgets: [{ gid: "g1", at: "2026-02-01T00:00:00Z" }],
		});
		const owned = assignOwnedContext([older, newer]).get("gadget");
		expect(owned?.owned.get("1111111111111")).toBeUndefined();
		const winner = owned?.owned.get("2222222222222")?.[0] as GadgetItem;
		// Default docIdField: the seed lands on the uniform `jolliDocId` name.
		expect(winner.jolliDocId).toBe(7);
		expect(winner.jolliDocUrl).toBe(`${BASE}/articles?doc=7`);
		expect(owned?.seeds.get("g1")).toBe(7);
	});

	it("never lets an older revision overwrite the winner's own docId", () => {
		const winner = summary({
			commitHash: "2222222222222",
			gadgets: [{ gid: "g1", at: "2026-02-01T00:00:00Z", jolliDocId: 9, jolliDocUrl: `${BASE}/articles?doc=9` }],
		});
		const older = summary({
			commitHash: "1111111111111",
			gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z", jolliDocId: 7, jolliDocUrl: `${BASE}/articles?doc=7` }],
		});
		const owned = assignOwnedContext([winner, older]).get("gadget");
		expect((owned?.owned.get("2222222222222")?.[0] as GadgetItem).jolliDocId).toBe(9);
	});

	it("applies the kind's tiebreak on an equal-recency tie", () => {
		const s = summary({
			widgets: [
				{ slug: "bbb", updatedAt: "2026-01-01T00:00:00Z" },
				{ slug: "aaa", updatedAt: "2026-01-01T00:00:00Z" },
			],
		});
		// Same base key is required for a tie to matter; use distinct keys here to
		// check ordering is per-key (both survive), then a shared key below.
		const owned = assignOwnedContext([s]).get("widget");
		expect(owned?.owned.get(s.commitHash)).toHaveLength(2);

		const tied = summary({
			widgets: [
				{ slug: "w-11112222", updatedAt: "2026-01-01T00:00:00Z", body: "later-listed" },
				{ slug: "w-33334444", updatedAt: "2026-01-01T00:00:00Z", body: "earlier-alpha" },
			],
		});
		// Both slugs strip to base "w"; the tiebreak picks the alphabetically
		// smaller slug (w-11112222), not merely the first seen.
		const tiedOwned = assignOwnedContext([tied]).get("widget");
		const kept = tiedOwned?.owned.get(tied.commitHash) as WidgetItem[];
		expect(kept).toHaveLength(1);
		expect(kept[0].slug).toBe("w-11112222");
	});

	it("the legacy named shapes refuse to expand when a legacy docType is no longer registered", () => {
		// This file's registry is mocked to widget + gadget, so NONE of plan/note/
		// reference exists — exactly the state a docType rename would produce. The
		// adapters must fail loudly instead of emitting three entries no kind matches,
		// which would silently stop every legacy caller pushing that kind (the keys are
		// strings, so nothing type-checks it).
		expect(() => legacyNamedSelection({ plans: [], notes: [] })).toThrow(/unregistered docType/);
		expect(() =>
			legacyNamedOwnership({ ownedPlans: new Map(), ownedNotes: new Map(), ownedReferences: new Map() }),
		).toThrow(/LEGACY_NAMED_DOC_TYPES/);
	});

	it("selectionForCommit projects every kind, with explicit empty arrays for unowned kinds", () => {
		const s = summary({ gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z" }] });
		const selection = selectionForCommit(assignOwnedContext([s]), s.commitHash);
		expect(selection.get("gadget")).toHaveLength(1);
		// The widget kind owns nothing for this commit — the key still exists and is
		// empty, preserving the "missing key = push none" tri-state downstream.
		expect(selection.get("widget")).toEqual([]);
	});
});

// ─── Push loop ───────────────────────────────────────────────────────────────

describe("pushContextAttachments", () => {
	it("re-reads the outbound opt-out before EVERY send, stopping mid-loop (spec 306)", async () => {
		const client = fakeClient();
		const s = summary({
			gadgets: [
				{ gid: "g1", at: "2026-01-01T00:00:00Z", body: "b1" },
				{ gid: "g2", at: "2026-01-02T00:00:00Z", body: "b2" },
			],
		});
		// Allowed for the first send, disabled for the second: the remaining upload
		// must be refused — checking once at loop entry would let it leak.
		vi.mocked(isOutboundPushAllowed).mockResolvedValueOnce(true).mockResolvedValue(false);
		await expect(pushContextAttachments(s, ctxOf(client), ENV_KEY, undefined)).rejects.toBeInstanceOf(
			PushDisabledError,
		);
		expect(client.push).toHaveBeenCalledTimes(1);
	});

	it("short-circuits ONE kind on doctype_not_allowed while other kinds keep pushing", async () => {
		const pushed: string[] = [];
		const client = fakeClient(async (payload) => {
			pushed.push(payload.docType);
			if (payload.docType === "gadget") throw new DocTypeNotAllowedError("gadget");
			return { url: "", docId: 42, jrn: "jrn:1", created: true };
		});
		const s = summary({
			widgets: [{ slug: "w1", updatedAt: "2026-01-01T00:00:00Z", body: "wb" }],
			gadgets: [
				{ gid: "g1", at: "2026-01-01T00:00:00Z", body: "b1" },
				{ gid: "g2", at: "2026-01-02T00:00:00Z", body: "b2" },
			],
		});
		const published = await pushContextAttachments(s, ctxOf(client), ENV_KEY, undefined);
		// ONE gadget request, not one per item — the kind is refused wholesale.
		expect(pushed.filter((d) => d === "gadget")).toHaveLength(1);
		// The widget kind is unaffected.
		expect(published.get("widget")).toHaveLength(1);
		expect(published.get("gadget")).toEqual([]);
	});

	it("skips an item with no body and logs-and-continues on a transient failure", async () => {
		const client = fakeClient(async (payload: { docType: string; title?: string }) => {
			if ((payload as { title: string }).title === "Gadget g2") throw new Error("HTTP 500");
			return { url: "", docId: 42, jrn: "jrn:1", created: true };
		});
		const s = summary({
			gadgets: [
				{ gid: "g0", at: "2026-01-01T00:00:00Z" }, // no body → skipped, no request
				{ gid: "g2", at: "2026-01-02T00:00:00Z", body: "boom" },
				{ gid: "g3", at: "2026-01-03T00:00:00Z", body: "ok" },
			],
		});
		const published = await pushContextAttachments(s, ctxOf(client), ENV_KEY, undefined);
		expect(published.get("gadget")?.map((d) => d.entryKey)).toEqual(["g3"]);
	});

	it("reuses a stored docId only for the same env (uniform-field kind)", async () => {
		const payloads: Array<{ docId?: number }> = [];
		const client = fakeClient(async (payload) => {
			payloads.push(payload as { docId?: number });
			return { url: "", docId: 42, jrn: "jrn:1", created: true };
		});
		const s = summary({
			gadgets: [
				{
					gid: "same",
					at: "2026-01-01T00:00:00Z",
					body: "b",
					jolliDocId: 7,
					jolliDocUrl: `${BASE}/articles?doc=7`,
				},
				{
					gid: "other",
					at: "2026-01-01T00:00:00Z",
					body: "b",
					jolliDocId: 8,
					jolliDocUrl: "https://other.jolli.ai/articles?doc=8",
				},
			],
		});
		await pushContextAttachments(s, ctxOf(client), ENV_KEY, undefined);
		expect(payloads[0].docId).toBe(7);
		expect(payloads[1].docId).toBeUndefined();
	});
});

// ─── Weaving + reduction ─────────────────────────────────────────────────────

describe("applyPublishedUrls / reduceOwnItems", () => {
	it("weaves onto the default jolliDocId/jolliDocUrl fields, matched by entryKey", () => {
		const s = summary({
			gadgets: [
				{ gid: "g1", at: "2026-01-01T00:00:00Z" },
				{ gid: "g2", at: "2026-01-02T00:00:00Z" },
			],
		});
		const woven = applyPublishedUrls(
			s,
			new Map([["gadget", [{ entryKey: "g2", url: `${BASE}/articles?doc=9`, docId: 9 }]]]),
		) as TestSummary;
		expect(woven.gadgets?.[0].jolliDocId).toBeUndefined();
		expect(woven.gadgets?.[1]).toMatchObject({ jolliDocId: 9, jolliDocUrl: `${BASE}/articles?doc=9` });
	});

	it("urlOnly weaves the URL but never the docId (batch placeholder path)", () => {
		const s = summary({ gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z" }] });
		const woven = applyPublishedUrls(
			s,
			new Map([["gadget", [{ entryKey: "g1", url: "{{jolli:doc:gadget-0}}" }]]]),
			{
				urlOnly: true,
			},
		) as TestSummary;
		expect(woven.gadgets?.[0].jolliDocUrl).toBe("{{jolli:doc:gadget-0}}");
		expect(woven.gadgets?.[0].jolliDocId).toBeUndefined();
	});

	it("returns the summary by identity when nothing was published for its kinds", () => {
		const s = summary({ gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z" }] });
		expect(applyPublishedUrls(s, new Map())).toBe(s);
		// An EMPTY published list for a kind is the same no-op as an absent one.
		expect(applyPublishedUrls(s, new Map([["gadget", []]]))).toBe(s);
		// So is a published list for a kind whose field the summary does not carry.
		expect(applyPublishedUrls(summary(), new Map([["gadget", [{ entryKey: "g1", url: "u", docId: 1 }]]]))).toEqual(
			summary(),
		);
	});

	it("reduceOwnItems applies only the kinds that declare a reduce", () => {
		const s = summary({
			widgets: [
				{ slug: "keep", updatedAt: "2026-01-01T00:00:00Z" },
				{ slug: "drop", updatedAt: "2026-01-01T00:00:00Z", keep: false },
			],
			gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z" }],
		});
		const reduced = reduceOwnItems(s) as TestSummary;
		expect(reduced.widgets?.map((w) => w.slug)).toEqual(["keep"]);
		expect(reduced.gadgets).toHaveLength(1);
	});
});

// ─── Batch assembly ──────────────────────────────────────────────────────────

describe("buildContextBatchAttachments", () => {
	const placeholder = (clientKey: string) => `{{jolli:doc:${clientKey}}}`;

	it("mints placeholders for linking kinds but NOT for linksInMarkdown:false kinds", async () => {
		const s = summary({
			widgets: [{ slug: "w1", updatedAt: "2026-01-01T00:00:00Z", body: "wb" }],
			gadgets: [{ gid: "g1", at: "2026-01-01T00:00:00Z", body: "gb" }],
		});
		const built = await buildContextBatchAttachments(s, ctxOf(fakeClient()), ENV_KEY, undefined, placeholder);
		expect(built.attachments.map((a) => a.clientKey)).toEqual(["widget-0", "gadget-0"]);
		expect(built.attachmentKeys.get("gadget-0")).toEqual({ docType: "gadget", key: "g1" });
		// widget links in markdown → placeholder minted; gadget does not → none.
		expect(built.placeholders.get("widget")).toEqual([{ entryKey: "w1", url: "{{jolli:doc:widget-0}}" }]);
		expect(built.placeholders.has("gadget")).toBe(false);
	});

	it("skips bodyless items without burning a clientKey index", async () => {
		const s = summary({
			gadgets: [
				{ gid: "empty", at: "2026-01-01T00:00:00Z" },
				{ gid: "full", at: "2026-01-02T00:00:00Z", body: "b" },
			],
		});
		const built = await buildContextBatchAttachments(s, ctxOf(fakeClient()), ENV_KEY, undefined, placeholder);
		expect(built.attachments).toHaveLength(1);
		expect(built.attachments[0].clientKey).toBe("gadget-0");
		expect(built.attachmentKeys.get("gadget-0")?.key).toBe("full");
	});

	it("carries a stored docId through the env gate (default fields)", async () => {
		const s = summary({
			gadgets: [
				{
					gid: "g1",
					at: "2026-01-01T00:00:00Z",
					body: "b",
					jolliDocId: 7,
					jolliDocUrl: `${BASE}/articles?doc=7`,
				},
			],
		});
		const built = await buildContextBatchAttachments(s, ctxOf(fakeClient()), ENV_KEY, undefined, placeholder);
		expect(built.attachments[0].docId).toBe(7);
	});
});
