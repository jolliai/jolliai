/**
 * Tests for the `skill` context kind.
 *
 * The generic engine's behaviour (winner rule, seed propagation, the env reuse
 * gate, per-item skip, kind-wide refusal) is covered once in `ContextPush.test.ts`
 * and is NOT re-tested per kind — that is the point of the table. What is specific
 * to skill, and therefore tested here:
 *
 *  - `aggregate`: ONE article per commit rather than one per skill, and the reason
 *    its identity is borrowed from a real ref rather than invented,
 *  - the article title and the `hash8` segment that keeps per-commit articles
 *    distinguishable,
 *  - the per-commit-increment figure rule: every number in the body must match what
 *    the VS Code panel renders for the SAME commit,
 *  - per-commit `baseKey` (this is the only kind that does not dedupe across
 *    commits) and the uniform doc-state field names,
 *  - `linksInMarkdown: false`.
 *
 * Storage is deliberately NOT mocked here any more: this kind's body reads nothing.
 * A `vi.mock` of `SummaryStore` would now assert only that an unused module stayed
 * unused, and would hide the fact that the body is pure.
 */

import { describe, expect, it } from "vitest";
import type { CommitSummary, SkillCommitRef } from "../../../Types.js";
import type { AnyContextKind } from "../ContextKindDefinition.js";
import {
	baseKeyOfItem,
	docIdFieldOf,
	docIdOf,
	docUrlFieldOf,
	entryKeyOf,
	isSummaryScoped,
	linksInMarkdown,
} from "../ContextKindRegistry.js";
import { CONTEXT_KIND_DEFINITIONS } from "./index.js";

/** The `skill` definition, looked up from the registry list it is declared in. */
const skillKind = CONTEXT_KIND_DEFINITIONS.find((k) => k.docType === "skill") as AnyContextKind;

const CWD = "/repo";

function ref(overrides: Partial<SkillCommitRef> = {}): SkillCommitRef {
	return {
		archivedKey: "claude:superpowers:brainstorming-a1b2c3d4",
		source: "claude",
		skill: "superpowers:brainstorming",
		plugin: "superpowers",
		entryPaths: ["tool"],
		invocationCount: 1,
		firstUsedAt: "2026-08-01T10:00:00.000Z",
		lastUsedAt: "2026-08-05T10:00:00.000Z",
		...overrides,
	};
}

/** Only the field the title reads — the kind never touches the rest of the summary. */
function summary(commitHash = "a1b2c3d4e5f6789012345678901234567890abcd"): CommitSummary {
	return { commitHash } as CommitSummary;
}

describe("declaration", () => {
	it("keeps its published id on the COMMIT, under names that cannot collide with the memory's", () => {
		// Summary-scoped because the article covers the commit. The names are overridden
		// rather than inherited precisely because the defaults (`jolliDocId` /
		// `jolliDocUrl`) are the MEMORY article's own fields on a summary — taking them
		// would overwrite the memory's published identity with its attachment's.
		expect(isSummaryScoped(skillKind)).toBe(true);
		expect(docIdFieldOf(skillKind)).toBe("jolliSkillsDocId");
		expect(docUrlFieldOf(skillKind)).toBe("jolliSkillsDocUrl");
	});

	it("does not link in the summary markdown, so a batch push mints no placeholder", () => {
		// The Context section shows ONE unlinked aggregate row for all skills, so there
		// is no site in the body for a per-skill URL.
		expect(linksInMarkdown(skillKind)).toBe(false);
	});

	it("is best-effort, so one failed skill article cannot abort a strict branch share", () => {
		// Auto-extracted context, like a reference: the VS Code orchestrator collects a
		// non-best-effort failure into `failures`, and LiveShareController throws
		// AttachmentPushError on a non-empty set — mid-loop, after earlier summaries
		// already published. Nothing lets a user attach a skill, so that is the wrong
		// tier for it. Pinned because the flag is invisible on the CLI path (which
		// logs-and-skips every kind) and the cost of omitting it only shows up once the
		// server has docType `skill` enabled.
		expect(skillKind.bestEffortPush).toBe(true);
	});

	it("is the ONE kind whose baseKey is per-commit, so it never dedupes across commits", () => {
		const r = ref();
		expect(entryKeyOf(skillKind, r)).toBe("claude:superpowers:brainstorming-a1b2c3d4");
		// Equal to the entryKey, i.e. one article per (skill, commit). It used to be the
		// registry mapKey `claude:superpowers:brainstorming`, which collapsed every
		// commit's record into one article — and a single shared document can only
		// report CUMULATIVE figures, while the VS Code panel renders the same record per
		// commit. One commit then showed two different token totals depending on the
		// surface. A skill record is a measurement of one commit's work, not a revision
		// of a shared artifact, so unlike plan/note/reference there is nothing to merge.
		expect(baseKeyOfItem(skillKind, r)).toBe("claude:superpowers:brainstorming-a1b2c3d4");
		expect(baseKeyOfItem(skillKind, r)).toBe(entryKeyOf(skillKind, r));
	});

	it("gives two commits' records of one skill distinct identities", () => {
		const first = ref({ archivedKey: "claude:superpowers:brainstorming-a1b2c3d4" });
		const second = ref({ archivedKey: "claude:superpowers:brainstorming-deadbeef" });
		expect(baseKeyOfItem(skillKind, first)).not.toBe(baseKeyOfItem(skillKind, second));
	});
});

describe("aggregate", () => {
	it("publishes ONE article for a commit's whole skill set", () => {
		// The mismatch this exists to fix: every local surface shows a commit's skills as
		// ONE artifact (`skills--<hash8>.md`, one "Skills used" Context row), so a commit
		// whose Context listed a single file used to arrive at the backend as N documents.
		const refs = [
			ref({ archivedKey: "claude:a-a1b2c3d4", skill: "a" }),
			ref({ archivedKey: "claude:b-a1b2c3d4", skill: "b" }),
		];
		expect(skillKind.aggregate?.(refs, summary())).toHaveLength(1);
	});

	it("takes its identity from the COMMIT, so no change to the skill set can move it", () => {
		// `skills--<hash8>`, the same key the Memory Bank names the local aggregate with.
		// Deriving it from a representative ref instead made the article's identity
		// depend on which skills the commit happened to hold — a squash that folds three
		// refs into one, or a skill entered after the first push, silently re-pointed it.
		const refs = [ref({ archivedKey: "claude:b-a1b2c3d4" }), ref({ archivedKey: "claude:a-a1b2c3d4" })];
		const [aggregated] = skillKind.aggregate?.(refs, summary()) ?? [];
		expect(entryKeyOf(skillKind, aggregated)).toBe("skills--a1b2c3d4");
		const fewer = skillKind.aggregate?.([refs[0]], summary()) ?? [];
		expect(entryKeyOf(skillKind, fewer[0])).toBe("skills--a1b2c3d4");
	});

	it("carries no per-ref docId, so nothing can mistake a stale id for the article's", () => {
		// The published id lives on the summary (`docScope: "summary"`). A legacy id left
		// on the carrier ref would be a second, stale answer to "which article is this?".
		const refs = [{ ...ref(), jolliDocId: 501, jolliDocUrl: "https://acme.jolli.ai/articles?doc=501" }];
		const [aggregated] = skillKind.aggregate?.(refs, summary()) ?? [];
		expect((aggregated as { jolliDocId?: number }).jolliDocId).toBeUndefined();
		expect((aggregated as { jolliDocUrl?: string }).jolliDocUrl).toBeUndefined();
		// And the engine's own reader finds nothing either — it looks at the summary.
		expect(docIdOf(skillKind, aggregated)).toBeUndefined();
	});

	it("leaves an empty set empty, so a commit with no skills pushes nothing", () => {
		expect(skillKind.aggregate?.([], summary())).toEqual([]);
	});
});

describe("title", () => {
	it("names the COMMIT, not a skill — one article covers all of them", () => {
		// Deliberately the same wording as `buildSkillsAggregateMarkdown`'s heading and
		// the Memory Bank's `skills--<hash8>.md`: the pushed article and the local file
		// are the same document and must not be findable under two names.
		expect(skillKind.title(ref(), summary())).toBe("Skills used — a1b2c3d4");
	});

	it("distinguishes two commits' aggregates, which a flat branch folder needs", () => {
		// Per-commit articles are siblings in one flat folder, so without the hash8 a
		// branch would show N indistinguishable "Skills used" entries.
		const first = skillKind.title(ref(), summary("a1b2c3d4000000000000000000000000000000ff"));
		const second = skillKind.title(ref(), summary("deadbeef000000000000000000000000000000ff"));
		expect(first).toContain("— a1b2c3d4");
		expect(second).toContain("— deadbeef");
		expect(first).not.toBe(second);
	});

	it("takes the hash from the summary, not the archivedKey's stamp", () => {
		// The two diverge after a squash: the ref is re-anchored onto the new root while
		// the orphan file keeps its original name. The commit a reader is holding is the
		// one VS Code titles the record with (`# Skills used — <hash8>`).
		const title = skillKind.title(
			ref({ archivedKey: "claude:superpowers:brainstorming-deadbeef" }),
			summary("a1b2c3d4000000000000000000000000000000ff"),
		);
		expect(title).toContain("— a1b2c3d4");
		expect(title).not.toContain("deadbeef");
	});
});

describe("body", () => {
	it("prints THIS COMMIT's increment, matching what the VS Code panel shows", async () => {
		// The reversal this kind exists to fix: the body used to prefer the orphan
		// snapshot's frontmatter, whose counters are the registry row's running total
		// across every commit. A reader comparing the article against the same memory in
		// VS Code (which renders `summary.skills`, i.e. the increment) saw two different
		// numbers, and the article's was the larger.
		const body = await skillKind.body(
			ref({ invocationCount: 1, usage: { input: 50, cached: 0, output: 24900, confidence: "attributed" } }),
			{ cwd: CWD },
		);
		expect(body).toContain("| superpowers:brainstorming | Claude Code | 1 | 24.9k | 50 | 24.9k | 0 |");
	});

	it("includes the host, plugin and entry paths", async () => {
		const body = await skillKind.body(ref(), { cwd: CWD });
		expect(body).toContain("Host: Claude Code");
		expect(body).toContain("Plugin: superpowers");
		expect(body).toContain("Entered via: tool");
	});

	it("renders the token table through the shared skills-table renderer", async () => {
		const body = await skillKind.body(
			ref({ usage: { input: 12300, cached: 76500, output: 5000, confidence: "attributed" } }),
			{ cwd: CWD },
		);
		expect(body).toContain("| Skill | Agent | × | Tokens | Input | Output | Cached |");
		// 12300 + 76500 + 5000 = 93.8k, formatted by buildSkillsTable.
		expect(body).toContain("93.8k");
	});

	it("carries the host into the pushed table's Agent cell, not just the details list", async () => {
		// `buildSkillsPushMarkdown` PICKS fields rather than spreading the ref, so a
		// column added to the shared table renders as an em dash in the pushed article
		// until it is named there too — silently, since the table still lines up.
		const body = await skillKind.body(ref(), { cwd: CWD });
		expect(body).toContain("| superpowers:brainstorming | Claude Code |");
		expect(body).not.toContain("| superpowers:brainstorming | — |");
	});

	it("omits the three cumulative fields it used to carry", async () => {
		const body = await skillKind.body(ref(), { cwd: CWD });
		// All three contradicted a per-commit table beside them, and no VS Code surface
		// renders any of them:
		//  - the invocation list is cumulative (and capped), so it listed four entries
		//    under `Invocations: 1`;
		//  - `First used` / `Last used` are stamped from the registry ROW, so an August
		//    commit's article read `First used: July 30`;
		//  - the `Invocations:` bullet duplicated the table's `×` column.
		expect(body).not.toContain("## Invocations");
		expect(body).not.toContain("**Invocations:**");
		expect(body).not.toContain("**First used:**");
		expect(body).not.toContain("**Last used:**");
	});

	it("needs no storage read at all — the ref carries every figure it prints", async () => {
		// A ref with no archive stamp used to be the "no orphan file" case. There is no
		// such case now: the body is pure, so pre-archival and foreign data render
		// identically to anything else.
		const body = await skillKind.body(ref({ archivedKey: "claude:superpowers:brainstorming" }), { cwd: CWD });
		expect(body).toContain("Host: Claude Code");
	});

	it("marks an inferred skill and omits an absent plugin", async () => {
		const body = await skillKind.body(ref({ plugin: undefined, detection: "heuristic", usage: undefined }), {
			cwd: CWD,
		});
		expect(body).not.toContain("Plugin:");
		// The dagger + footnote come from the shared table; an unattributed row shows
		// em dashes rather than zeros.
		expect(body).toContain("†");
		expect(body).toContain("—");
	});

	it("omits `Entered via` when the ref records no entry path", async () => {
		const body = await skillKind.body(ref({ entryPaths: [] }), { cwd: CWD });
		expect(body).not.toContain("Entered via:");
	});

	it("omits `Plugin` for an empty-string plugin, not just an absent one", async () => {
		const body = await skillKind.body(ref({ plugin: "" }), { cwd: CWD });
		expect(body).not.toContain("Plugin:");
	});

	it("lists EVERY skill of the commit — one table plus one detail line each", async () => {
		const refs = [
			ref({ archivedKey: "claude:a-a1b2c3d4", skill: "a" }),
			ref({ archivedKey: "claude:b-a1b2c3d4", skill: "b", source: "codex", plugin: undefined }),
		];
		const [aggregated] = skillKind.aggregate?.(refs, summary()) ?? [];
		const body = await skillKind.body(aggregated, { cwd: CWD });
		expect(body).toContain("| a | Claude Code | 1 |");
		expect(body).toContain("| b | Codex | 1 |");
		// The detail list keeps the rest of each skill's identity after host became a
		// table column; it is per-skill, so two hosts on one commit both survive.
		expect(body).toContain("## Skill details");
		expect(body).toContain("- **a** — Host: Claude Code");
		expect(body).toContain("- **b** — Host: Codex");
	});
});
