/**
 * Tests for the `skill` context kind.
 *
 * The generic engine's behaviour (winner rule, seed propagation, the env reuse
 * gate, per-item skip, kind-wide refusal) is covered once in `ContextPush.test.ts`
 * and is NOT re-tested per kind — that is the point of the table. What is specific
 * to skill, and therefore tested here:
 *
 *  - the article title, its collision-avoidance shape, and the `hash8` segment that
 *    keeps per-commit articles distinguishable,
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
import { baseKeyOfItem, docIdFieldOf, docUrlFieldOf, entryKeyOf, linksInMarkdown } from "../ContextKindRegistry.js";
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
	it("uses the uniform doc-state field names (the first kind to take the defaults)", () => {
		expect(docIdFieldOf(skillKind)).toBe("jolliDocId");
		expect(docUrlFieldOf(skillKind)).toBe("jolliDocUrl");
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

describe("title", () => {
	it("is namespaced by `Skill`, the host label, and the commit's hash8", () => {
		// The host segment is required for uniqueness, not decoration: the registry key
		// is `<source>:<skill>`, so two hosts can hold the same skill id as two rows.
		// Colons become spaces because sanitizeTitle strips them from document titles.
		expect(skillKind.title(ref(), summary())).toBe("Skill · Claude Code · superpowers brainstorming — a1b2c3d4");
	});

	it("distinguishes the same skill on two commits, which a flat branch folder needs", () => {
		// Per-commit articles are siblings in one flat folder, so without the hash8 a
		// skill used on four commits would show four indistinguishable entries.
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

	it("distinguishes the same skill id captured from different hosts", () => {
		const claude = skillKind.title(ref({ source: "claude" }), summary());
		const codex = skillKind.title(ref({ source: "codex" }), summary());
		expect(claude).not.toBe(codex);
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
		expect(body).toContain("| superpowers:brainstorming | 1 | 24.9k | 50 | 24.9k | 0 |");
	});

	it("includes the host, plugin and entry paths", async () => {
		const body = await skillKind.body(ref(), { cwd: CWD });
		expect(body).toContain("**Host:** Claude Code");
		expect(body).toContain("**Plugin:** superpowers");
		expect(body).toContain("**Entered via:** tool");
	});

	it("renders the token table through the shared skills-table renderer", async () => {
		const body = await skillKind.body(
			ref({ usage: { input: 12300, cached: 76500, output: 5000, confidence: "attributed" } }),
			{ cwd: CWD },
		);
		expect(body).toContain("| Skill | × | Tokens | Input | Output | Cached |");
		// 12300 + 76500 + 5000 = 93.8k, formatted by buildSkillsTable.
		expect(body).toContain("93.8k");
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
		expect(body).toContain("**Host:** Claude Code");
	});

	it("marks an inferred skill and omits an absent plugin", async () => {
		const body = await skillKind.body(ref({ plugin: undefined, detection: "heuristic", usage: undefined }), {
			cwd: CWD,
		});
		expect(body).not.toContain("**Plugin:**");
		// The dagger + footnote come from the shared table; an unattributed row shows
		// em dashes rather than zeros.
		expect(body).toContain("†");
		expect(body).toContain("—");
	});

	it("omits `Entered via` when the ref records no entry path", async () => {
		const body = await skillKind.body(ref({ entryPaths: [] }), { cwd: CWD });
		expect(body).not.toContain("**Entered via:**");
	});

	it("omits `Plugin` for an empty-string plugin, not just an absent one", async () => {
		const body = await skillKind.body(ref({ plugin: "" }), { cwd: CWD });
		expect(body).not.toContain("**Plugin:**");
	});
});
