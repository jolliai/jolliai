import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillInvocation, SkillUse } from "../../Types.js";
import {
	foldSkillUse,
	parseSkillMarkdownFromString,
	readSkillMarkdown,
	renderSkillMarkdown,
	SKILL_INVOCATION_CAP,
	type SkillFileContent,
	sanitizeSkillIdForPath,
	skillPath,
	writeSkillMarkdown,
} from "./SkillStore.js";

/**
 * Real skill ids, copied verbatim from `~/.claude/projects/**` transcripts and
 * from this repo's own plugin manifests. Three shapes are represented on
 * purpose: `<plugin>:<name>`, a one-letter plugin namespace, and an id with no
 * namespace at all — all three are live.
 */
const REAL_SKILL_IDS = [
	"superpowers:brainstorming",
	"superpowers:test-driven-development",
	"superpowers:subagent-driven-development",
	"j:specs-pr-review",
	"j:specs",
	"code-review:code-review",
	"claude-mem:mem-search",
	"jolli-init",
	"pr-review-toolkit:silent-failure-hunter",
];

function inv(at: string, extra: Partial<SkillInvocation> = {}): SkillInvocation {
	return { at, ok: true, ...extra };
}

function use(overrides: Partial<SkillUse> = {}): SkillUse {
	return {
		source: "claude",
		skill: "superpowers:brainstorming",
		plugin: "superpowers",
		entryPaths: ["tool"],
		invocations: [inv("2026-07-30T06:01:57.000Z")],
		sessionKey: "claude:sess-a",
		...overrides,
	};
}

describe("sanitizeSkillIdForPath", () => {
	it("strips every filesystem-unsafe byte from real skill ids", () => {
		for (const id of REAL_SKILL_IDS) {
			const stem = sanitizeSkillIdForPath(id);
			expect(stem, `stem for ${id}`).not.toMatch(/[:/\\]/);
			expect(stem, `stem for ${id}`).not.toContain("..");
			expect(stem.length, `stem for ${id}`).toBeGreaterThan(0);
		}
	});

	it("maps distinct skill ids to distinct stems", () => {
		// Injectivity is the property that matters, not any particular encoding: a
		// collision means two skills share one markdown file and each overwrites the
		// other's invocation history, while both registry rows keep claiming to exist.
		const stems = REAL_SKILL_IDS.map(sanitizeSkillIdForPath);
		expect(new Set(stems).size).toBe(REAL_SKILL_IDS.length);
	});

	it("keeps ids apart when they differ only where a separator would be substituted", () => {
		// `superpowers:brainstorming` vs a hypothetical skill literally named
		// `superpowers-brainstorming` — a plain `:` → `-` substitution collapses these
		// two onto one file. Same trap one level up for a `--` substitution.
		const pairs: ReadonlyArray<readonly [string, string]> = [
			["superpowers:brainstorming", "superpowers-brainstorming"],
			["superpowers:brainstorming", "superpowers--brainstorming"],
			["a:b:c", "a:b-c"],
		];
		for (const [left, right] of pairs) {
			expect(sanitizeSkillIdForPath(left), `${left} vs ${right}`).not.toBe(sanitizeSkillIdForPath(right));
		}
	});

	it("refuses to let a traversal sequence reach the path", () => {
		// Skill ids come from a host's transcript, so they are untrusted input at this
		// boundary even though no real id looks like this.
		for (const hostile of ["../../etc/passwd", "..", "a/../../b", "plugin:../escape"]) {
			const stem = sanitizeSkillIdForPath(hostile);
			expect(stem).not.toContain("..");
			expect(stem).not.toMatch(/[/\\]/);
		}
	});
});

describe("foldSkillUse", () => {
	it("counts a first capture from the invocations it was given", () => {
		const folded = foldSkillUse(
			use({ invocations: [inv("2026-07-30T06:05:00.000Z"), inv("2026-07-30T06:01:00.000Z")] }),
			undefined,
		);
		expect(folded.invocationCount).toBe(2);
		expect(folded.firstUsedAt).toBe("2026-07-30T06:01:00.000Z");
		expect(folded.lastUsedAt).toBe("2026-07-30T06:05:00.000Z");
	});

	it("orders invocation detail newest-first", () => {
		const folded = foldSkillUse(
			use({ invocations: [inv("2026-07-30T06:01:00.000Z"), inv("2026-07-30T06:09:00.000Z")] }),
			undefined,
		);
		expect(folded.invocations.map((i) => i.at)).toEqual(["2026-07-30T06:09:00.000Z", "2026-07-30T06:01:00.000Z"]);
	});

	it("does not inflate the count when a scan re-reads an invocation it already has", () => {
		// Reachable on a cursor rewind or a catch-up pass; `at` is the invocation identity.
		const first = foldSkillUse(use({ invocations: [inv("2026-07-30T06:01:00.000Z")] }), undefined);
		const second = foldSkillUse(use({ invocations: [inv("2026-07-30T06:01:00.000Z")] }), first);
		expect(second.invocationCount).toBe(1);
		expect(second.invocations).toHaveLength(1);
	});

	it("completes a fragment recorded before its tool_result arrived", () => {
		// The scanner reports a tool_use whose result is still in flight, then rewinds
		// its cursor so the next pass re-reads the finished triple. First-write-wins
		// discarded that second reading entirely, so the fragment's gaps — no bodyChars,
		// the default ok:true — were frozen on the row forever.
		const at = "2026-07-30T06:01:00.000Z";
		const fragment = foldSkillUse(
			use({ invocations: [inv(at, { entryPath: "tool", outcomeObserved: false })] }),
			undefined,
		);
		expect(fragment.invocations[0].bodyChars).toBeUndefined();

		const completed = foldSkillUse(
			use({ invocations: [inv(at, { bodyChars: 10280, ok: false, entryPath: "tool", outcomeObserved: true })] }),
			fragment,
		);
		expect(completed.invocations[0].bodyChars).toBe(10280);
		expect(completed.invocations[0].ok).toBe(false);
		expect(completed.invocations[0].entryPath).toBe("tool");
		expect(completed.invocations[0].outcomeObserved).toBe(true);
		// An upgrade is not a new entry.
		expect(completed.invocationCount).toBe(1);
		expect(completed.invocations).toHaveLength(1);
	});

	it("keeps an observed failure when a later reading carries the optimistic default", () => {
		// `ok: true` is what an unresolved entry defaults to, so it must never overwrite
		// a false that was actually read off a tool_result.
		const at = "2026-07-30T06:01:00.000Z";
		const failed = foldSkillUse(use({ invocations: [inv(at, { ok: false, outcomeObserved: true })] }), undefined);
		const reread = foldSkillUse(use({ invocations: [inv(at, { outcomeObserved: false })] }), failed);
		expect(reread.invocations[0].ok).toBe(false);
		expect(reread.invocations[0].outcomeObserved).toBe(true);
	});

	it("does not lose a field the re-read pass no longer reports", () => {
		// Absent means "not seen in this window", never "measured as nothing" — a pass
		// that resumes past the body record must not blank out a stored bodyChars.
		const at = "2026-07-30T06:01:00.000Z";
		const full = foldSkillUse(use({ invocations: [inv(at, { bodyChars: 10280, args: "specs" })] }), undefined);
		const partial = foldSkillUse(use({ invocations: [inv(at)] }), full);
		expect(partial.invocations[0].bodyChars).toBe(10280);
		expect(partial.invocations[0].args).toBe("specs");
	});

	it("accumulates a genuinely new invocation onto the prior count", () => {
		const first = foldSkillUse(use({ invocations: [inv("2026-07-30T06:01:00.000Z")] }), undefined);
		const second = foldSkillUse(use({ invocations: [inv("2026-07-30T07:00:00.000Z")] }), first);
		expect(second.invocationCount).toBe(2);
		expect(second.invocations.map((i) => i.at)).toEqual(["2026-07-30T07:00:00.000Z", "2026-07-30T06:01:00.000Z"]);
		expect(second.firstUsedAt).toBe("2026-07-30T06:01:00.000Z");
		expect(second.lastUsedAt).toBe("2026-07-30T07:00:00.000Z");
	});

	it("keeps the exact total when invocation detail overflows the cap", () => {
		const many = Array.from({ length: SKILL_INVOCATION_CAP + 5 }, (_, i) =>
			inv(`2026-07-30T06:${String(i).padStart(2, "0")}:00.000Z`),
		);
		const folded = foldSkillUse(use({ invocations: many }), undefined);
		expect(folded.invocations).toHaveLength(SKILL_INVOCATION_CAP);
		expect(folded.invocationCount).toBe(SKILL_INVOCATION_CAP + 5);
		expect(folded.trimmed).toBe(true);
	});

	it("keeps firstUsedAt at the oldest invocation even after the detail list is trimmed", () => {
		// The cap drops the OLDEST rows, so deriving firstUsedAt from the retained
		// list would silently walk it forward and make a long-running skill look
		// like it started recently.
		const many = Array.from({ length: SKILL_INVOCATION_CAP + 5 }, (_, i) =>
			inv(`2026-07-30T06:${String(i).padStart(2, "0")}:00.000Z`),
		);
		const folded = foldSkillUse(use({ invocations: many }), undefined);
		expect(folded.firstUsedAt).toBe("2026-07-30T06:00:00.000Z");
		expect(folded.lastUsedAt).toBe(`2026-07-30T06:${String(SKILL_INVOCATION_CAP + 4).padStart(2, "0")}:00.000Z`);
	});

	it("keeps firstUsedAt from a prior file whose oldest rows are already gone", () => {
		// Second pass: the prior file was already trimmed, so its oldest invocation is
		// no longer in the detail list — only its frontmatter still remembers it.
		const trimmedPrior: SkillFileContent = {
			source: "claude",
			skill: "superpowers:brainstorming",
			entryPaths: ["tool"],
			invocations: [inv("2026-07-30T20:00:00.000Z")],
			invocationCount: 40,
			firstUsedAt: "2026-07-30T01:00:00.000Z",
			lastUsedAt: "2026-07-30T20:00:00.000Z",
			trimmed: true,
		};
		const folded = foldSkillUse(use({ invocations: [inv("2026-07-30T21:00:00.000Z")] }), trimmedPrior);
		expect(folded.firstUsedAt).toBe("2026-07-30T01:00:00.000Z");
		expect(folded.lastUsedAt).toBe("2026-07-30T21:00:00.000Z");
	});

	it("keeps the trim notice sticky once a file has ever overflowed", () => {
		// A later pass that happens not to overflow must not un-announce the trim —
		// the detail list is still incomplete.
		const overflowed: SkillFileContent = {
			source: "claude",
			skill: "superpowers:brainstorming",
			entryPaths: ["tool"],
			invocations: [inv("2026-07-30T06:00:00.000Z")],
			invocationCount: 99,
			firstUsedAt: "2026-07-30T06:00:00.000Z",
			lastUsedAt: "2026-07-30T06:00:00.000Z",
			trimmed: true,
		};
		const folded = foldSkillUse(use({ invocations: [inv("2026-07-30T08:00:00.000Z")] }), overflowed);
		expect(folded.trimmed).toBe(true);
		expect(folded.invocationCount).toBe(100);
	});

	it("unions entry paths across passes", () => {
		// One skill can be both agent-invoked and user-invoked; neither path may
		// displace the other.
		const first = foldSkillUse(use({ entryPaths: ["tool"] }), undefined);
		const second = foldSkillUse(
			use({ entryPaths: ["command"], invocations: [inv("2026-07-30T07:00:00.000Z")] }),
			first,
		);
		expect([...second.entryPaths].sort()).toEqual(["command", "tool"]);
	});

	it("retains a prior attributed usage when this pass could not attribute", () => {
		const attributed = foldSkillUse(
			use({ usage: { input: 10387, output: 8935, cached: 46606, confidence: "attributed" } }),
			undefined,
		);
		const later = foldSkillUse(
			use({ invocations: [inv("2026-07-30T07:00:00.000Z")], usage: undefined }),
			attributed,
		);
		expect(later.usage).toEqual({ input: 10387, output: 8935, cached: 46606, confidence: "attributed" });
	});

	it("ignores a usage figure that names no session", () => {
		// Usage cannot join the per-session split without a session to key it on, and
		// folding it in as an unnamed total would make the next real session's fold
		// either double-count it or silently erase it. Dropping it is the only reading
		// that keeps the split authoritative — every scanner that reports usage must
		// report its sessionKey too.
		const folded = foldSkillUse(
			use({ sessionKey: undefined, usage: { input: 9, cached: 9, output: 9, confidence: "attributed" } }),
			undefined,
		);
		expect(folded.usage).toBeUndefined();
		expect(folded.usageBySession).toBeUndefined();
	});

	it("keeps an earlier session's total when a later pass names no session", () => {
		const first = foldSkillUse(
			use({ usage: { input: 1, cached: 2, output: 3, confidence: "attributed" } }),
			undefined,
		);
		const second = foldSkillUse(
			use({ sessionKey: undefined, usage: { input: 99, cached: 99, output: 99, confidence: "attributed" } }),
			first,
		);
		expect(second.usage).toEqual({ input: 1, cached: 2, output: 3, confidence: "attributed" });
	});

	it("degrades confidence to estimated when any contributing session was estimated", () => {
		// A total mixing an attributed session with an estimated one is only as
		// trustworthy as the estimate; reporting it as attributed overstates it.
		const first = foldSkillUse(
			use({ sessionKey: "claude:a", usage: { input: 10, cached: 0, output: 10, confidence: "attributed" } }),
			undefined,
		);
		const second = foldSkillUse(
			use({
				sessionKey: "claude:b",
				invocations: [inv("2026-07-30T09:00:00.000Z")],
				usage: { input: 5, cached: 0, output: 5, confidence: "estimated" },
			}),
			first,
		);
		expect(second.usage).toEqual({ input: 15, cached: 0, output: 15, confidence: "estimated" });
	});

	it("lets a fresh usage number replace a stale one", () => {
		const stale = foldSkillUse(
			use({ usage: { input: 1, output: 1, cached: 1, confidence: "estimated" } }),
			undefined,
		);
		const fresh = foldSkillUse(
			use({
				invocations: [inv("2026-07-30T07:00:00.000Z")],
				usage: { input: 20, output: 30, cached: 40, confidence: "attributed" },
			}),
			stale,
		);
		expect(fresh.usage).toEqual({ input: 20, output: 30, cached: 40, confidence: "attributed" });
	});
	it("keeps a heuristic detection mark once a pass has set it", () => {
		// Sticky like `trimmed`: a later pass that happens not to say "inferred" is not
		// evidence the capture became observed, so downgrading would overstate it.
		const first = foldSkillUse(use({ detection: "heuristic" }), undefined);
		expect(first.detection).toBe("heuristic");

		const second = foldSkillUse(use({ invocations: [inv("2026-07-30T07:00:00.000Z")] }), first);
		expect(second.detection).toBe("heuristic");
	});

	it("keeps the prior plugin when a later pass reports none", () => {
		const first = foldSkillUse(use(), undefined);
		const second = foldSkillUse(use({ plugin: undefined, invocations: [inv("2026-07-30T07:00:00.000Z")] }), first);
		expect(second.plugin).toBe("superpowers");
	});

	it("lets a NEWER pass overwrite originRoot — the opposite of detection's sticky rule", () => {
		// A skill genuinely moves between roots: a repo gains `.cursor/skills/` the
		// moment `.agents/skills/` stops supplying it. Pinning the first observation
		// would keep naming a root the host has stopped loading from.
		const first = foldSkillUse(use({ originRoot: "repo-agents" }), undefined);
		expect(first.originRoot).toBe("repo-agents");

		const second = foldSkillUse(
			use({ originRoot: "repo-cursor", invocations: [inv("2026-07-30T07:00:00.000Z")] }),
			first,
		);
		expect(second.originRoot).toBe("repo-cursor");
	});

	it("keeps the prior originRoot when a later pass reports none", () => {
		// Not-sticky is not the same as erasable: a source that reports no path at all
		// must not wipe what a source that does report one already established.
		const first = foldSkillUse(use({ originRoot: "cursor-global" }), undefined);
		const second = foldSkillUse(use({ invocations: [inv("2026-07-30T07:00:00.000Z")] }), first);
		expect(second.originRoot).toBe("cursor-global");
	});

	it("leaves originRoot absent when no pass has ever reported one", () => {
		// Absent means "this source does not report a path", which is every source but
		// Cursor. A default would claim a root nobody observed.
		expect(foldSkillUse(use(), undefined).originRoot).toBeUndefined();
	});

	it("walks firstUsedAt backwards when a catch-up pass finds older invocations", () => {
		// The prior file's bound is a candidate, not a floor: a rewound cursor can
		// surface rows older than anything the file has ever seen.
		const first = foldSkillUse(use({ invocations: [inv("2026-07-30T06:00:00.000Z")] }), undefined);
		const second = foldSkillUse(
			use({ invocations: [inv("2026-07-29T05:00:00.000Z"), inv("2026-07-31T08:00:00.000Z")] }),
			first,
		);
		expect(second.firstUsedAt).toBe("2026-07-29T05:00:00.000Z");
		expect(second.lastUsedAt).toBe("2026-07-31T08:00:00.000Z");
	});

	it("yields empty bounds for a fold with nothing to date it by", () => {
		// No scanner emits this today. The folder is exported, so it must degrade to
		// empty strings rather than writing `undefined` into the frontmatter.
		const folded = foldSkillUse(use({ invocations: [] }), undefined);
		expect(folded.firstUsedAt).toBe("");
		expect(folded.lastUsedAt).toBe("");
		expect(folded.invocationCount).toBe(0);
	});
});

describe("renderSkillMarkdown / parseSkillMarkdownFromString", () => {
	it("round-trips the heuristic detection mark", () => {
		// The mark is what tells the UI a capture was inferred rather than observed;
		// losing it on the round-trip would silently promote every reloaded skill.
		const content = foldSkillUse(use({ detection: "heuristic" }), undefined);
		expect(renderSkillMarkdown(content)).toContain('detection: "heuristic"');
		expect(parseSkillMarkdownFromString(renderSkillMarkdown(content))?.detection).toBe("heuristic");
	});

	it("round-trips originRoot", () => {
		const content = foldSkillUse(use({ originRoot: "repo-agents" }), undefined);
		expect(renderSkillMarkdown(content)).toContain('originRoot: "repo-agents"');
		expect(parseSkillMarkdownFromString(renderSkillMarkdown(content))?.originRoot).toBe("repo-agents");
	});

	it("drops an originRoot the union does not contain", () => {
		// This file is hand-editable, so an unrecognised value must degrade to absent —
		// which reads as "the source reports no path" — rather than flowing into the
		// panel as a root that does not exist.
		const rendered = renderSkillMarkdown(foldSkillUse(use({ originRoot: "repo-agents" }), undefined)).replace(
			'originRoot: "repo-agents"',
			'originRoot: "invented-root"',
		);
		expect(parseSkillMarkdownFromString(rendered)?.originRoot).toBeUndefined();
	});

	it("ignores a frontmatter line that carries no key/value separator", () => {
		// A stray blank or continuation line inside the frontmatter block. `indexOf`
		// also returns 0 for a line that opens with the separator, which is not a key.
		const parsed = parseSkillMarkdownFromString(
			["---", "", ": orphan", 'source: "claude"', 'skill: "a:b"', "---", ""].join("\n"),
		);
		expect(parsed?.skill).toBe("a:b");
	});

	it("drops an unparseable body count but keeps the invocation", () => {
		// A half-written row still identifies a real invocation by its timestamp; only
		// the field that cannot be read is discarded.
		const parsed = parseSkillMarkdownFromString(
			["---", 'source: "claude"', 'skill: "a:b"', "---", "", "- 2026-07-30T06:35:21.000Z · body: n/a"].join("\n"),
		);
		expect(parsed?.invocations).toEqual([{ at: "2026-07-30T06:35:21.000Z", ok: true }]);
	});

	it("treats an unknown invocation mechanism as absent", () => {
		// Skill files are user-editable and may outlive the reader that wrote them. An
		// unfamiliar value must not be cast into the closed entry-path union.
		const parsed = parseSkillMarkdownFromString(
			["---", 'source: "claude"', 'skill: "a:b"', "---", "", "- 2026-07-30T06:35:21.000Z · via: future"].join(
				"\n",
			),
		);
		expect(parsed?.invocations).toEqual([{ at: "2026-07-30T06:35:21.000Z", ok: true }]);
	});

	it("parses both known invocation mechanisms", () => {
		const parsed = parseSkillMarkdownFromString(
			[
				"---",
				'source: "claude"',
				'skill: "a:b"',
				"---",
				"",
				"- 2026-07-30T06:35:21.000Z · via: tool",
				"- 2026-07-30T06:36:21.000Z · via: command",
			].join("\n"),
		);
		expect(parsed?.invocations.map((invocation) => invocation.entryPath)).toEqual(["tool", "command"]);
	});

	it("round-trips a fully populated skill file", () => {
		const content = foldSkillUse(
			use({
				invocations: [
					inv("2026-07-30T06:35:21.000Z", { args: "408", bodyChars: 15651 }),
					inv("2026-07-30T06:01:57.000Z", { bodyChars: 10280, ok: false }),
				],
				usage: { input: 79, output: 33944, cached: 59796, confidence: "attributed" },
			}),
			undefined,
		);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed).toEqual(content);
	});

	it("round-trips an argument containing the field separator", () => {
		// `args` is host-supplied free text. The rendered row is separator-delimited,
		// so an argument that itself contains " · " must not be torn in half — the
		// naive split loses everything after the embedded separator.
		const content = foldSkillUse(
			use({ invocations: [inv("2026-07-30T06:35:21.000Z", { args: "plan · build · now" })] }),
			undefined,
		);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed?.invocations[0]?.args).toBe("plan · build · now");
	});

	it("round-trips an argument containing quotes and newlines", () => {
		const content = foldSkillUse(
			use({ invocations: [inv("2026-07-30T06:35:21.000Z", { args: 'say "hi"\nthen stop' })] }),
			undefined,
		);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed?.invocations[0]?.args).toBe('say "hi"\nthen stop');
	});

	it("does not read a field name out of the middle of an argument value", () => {
		// An argument that happens to contain the exact text of another field must not
		// be mistaken for that field — otherwise a user typing "body: 999" into a
		// slash command rewrites the recorded body size, and "failed" marks a
		// successful invocation as failed.
		const content = foldSkillUse(
			use({
				invocations: [inv("2026-07-30T06:35:21.000Z", { args: "body: 999 · failed", bodyChars: 12 })],
			}),
			undefined,
		);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed?.invocations[0]).toEqual({
			at: "2026-07-30T06:35:21.000Z",
			args: "body: 999 · failed",
			bodyChars: 12,
			ok: true,
		});
	});

	it("round-trips a failed invocation", () => {
		const content = foldSkillUse(use({ invocations: [inv("2026-07-30T06:35:21.000Z", { ok: false })] }), undefined);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed?.invocations[0]?.ok).toBe(false);
	});

	it("round-trips whether each invocation had an observed outcome", () => {
		const content = foldSkillUse(
			use({
				invocations: [
					inv("2026-07-30T06:35:21.000Z", { entryPath: "tool", outcomeObserved: false }),
					inv("2026-07-30T06:36:21.000Z", { entryPath: "tool", outcomeObserved: true }),
				],
			}),
			undefined,
		);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed?.invocations.map((invocation) => invocation.outcomeObserved)).toEqual([true, false]);
	});

	it("omits an absent plugin rather than writing a null", () => {
		const content = foldSkillUse(use({ skill: "jolli-init", plugin: undefined }), undefined);
		const rendered = renderSkillMarkdown(content);
		expect(rendered).not.toContain("plugin:");
		expect(parseSkillMarkdownFromString(rendered)?.plugin).toBeUndefined();
	});

	it("preserves the sticky trim notice through a round-trip", () => {
		const many = Array.from({ length: SKILL_INVOCATION_CAP + 2 }, (_, i) =>
			inv(`2026-07-30T06:${String(i).padStart(2, "0")}:00.000Z`),
		);
		const content = foldSkillUse(use({ invocations: many }), undefined);
		const parsed = parseSkillMarkdownFromString(renderSkillMarkdown(content));
		expect(parsed?.trimmed).toBe(true);
		expect(parsed?.invocationCount).toBe(SKILL_INVOCATION_CAP + 2);
	});

	it("returns null for content with no frontmatter", () => {
		expect(parseSkillMarkdownFromString("just some prose")).toBeNull();
	});

	it("returns null when the required identity fields are missing", () => {
		expect(parseSkillMarkdownFromString('---\nplugin: "superpowers"\n---\n')).toBeNull();
	});

	it("keeps the file usable when one frontmatter line is corrupt", () => {
		// A half-written line must not void an otherwise readable history.
		const corrupt = [
			"---",
			'source: "claude"',
			'skill: "superpowers:brainstorming"',
			"invocationCount: {not json",
			'firstUsedAt: "2026-07-30T06:00:00.000Z"',
			'lastUsedAt: "2026-07-30T06:00:00.000Z"',
			"---",
			"",
			"- 2026-07-30T06:00:00.000Z · body: 10",
			"",
		].join("\n");
		const parsed = parseSkillMarkdownFromString(corrupt);
		expect(parsed?.skill).toBe("superpowers:brainstorming");
		expect(parsed?.invocations).toHaveLength(1);
		// Falls back to the retained detail length rather than reporting zero.
		expect(parsed?.invocationCount).toBe(1);
	});

	it("ignores body lines that are not invocation rows", () => {
		const withProse = [
			"---",
			'source: "claude"',
			'skill: "j:specs"',
			"---",
			"",
			"some stray prose a user typed",
			"- 2026-07-30T06:00:00.000Z · body: 10",
			"- not a timestamp · body: 10",
			"",
		].join("\n");
		expect(parseSkillMarkdownFromString(withProse)?.invocations).toHaveLength(1);
	});
});

describe("writeSkillMarkdown", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "skill-store-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("writes a new skill file under the source directory and reports its path", async () => {
		const result = await writeSkillMarkdown(use(), tempDir);
		expect(result.sourcePath).toBe(
			skillPath(tempDir, "claude", sanitizeSkillIdForPath("superpowers:brainstorming")),
		);
		const onDisk = await readSkillMarkdown(result.sourcePath);
		expect(onDisk?.skill).toBe("superpowers:brainstorming");
		expect(onDisk?.invocationCount).toBe(1);
	});

	it("reports both the usage total and its per-session split back to the caller", async () => {
		// Same reason as the detection mark: the registry row is assembled from this
		// return value, and the split is what a later detach subtracts from.
		const usage = { input: 79, output: 33944, cached: 59796, confidence: "attributed" } as const;
		const result = await writeSkillMarkdown(use({ usage }), tempDir);
		expect(result.usage).toEqual(usage);
		expect(result.usageBySession).toEqual({ "claude:sess-a": usage });
	});

	it("reports the detection mark back to the caller, not just to disk", async () => {
		// The registry row is built from this return value, so a mark that only reached
		// the markdown would leave the sidebar claiming the capture was observed.
		const result = await writeSkillMarkdown(use({ detection: "heuristic" }), tempDir);
		expect(result.detection).toBe("heuristic");
		expect((await readSkillMarkdown(result.sourcePath))?.detection).toBe("heuristic");
	});

	it("folds a second pass into the file already on disk", async () => {
		await writeSkillMarkdown(use({ invocations: [inv("2026-07-30T06:01:00.000Z")] }), tempDir);
		const second = await writeSkillMarkdown(use({ invocations: [inv("2026-07-30T07:00:00.000Z")] }), tempDir);
		expect(second.invocationCount).toBe(2);
		const onDisk = await readSkillMarkdown(second.sourcePath);
		expect(onDisk?.invocations.map((i) => i.at)).toEqual(["2026-07-30T07:00:00.000Z", "2026-07-30T06:01:00.000Z"]);
	});

	it("does not touch mtime when the folded bytes are unchanged", async () => {
		const first = await writeSkillMarkdown(use(), tempDir);
		const before = await stat(first.sourcePath);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await writeSkillMarkdown(use(), tempDir);
		const after = await stat(second.sourcePath);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(second.contentHash).toBe(first.contentHash);
	});

	it("changes the content hash once a new invocation lands", async () => {
		// The hash is the archive guard: a skill re-entered after archival must read
		// as changed, or the new invocations would never be re-archived.
		const first = await writeSkillMarkdown(use({ invocations: [inv("2026-07-30T06:01:00.000Z")] }), tempDir);
		const second = await writeSkillMarkdown(use({ invocations: [inv("2026-07-30T07:00:00.000Z")] }), tempDir);
		expect(second.contentHash).not.toBe(first.contentHash);
	});

	it("treats an unreadable existing file as no prior history", async () => {
		// The sibling `.keep` makes the skill DIRECTORY exist while the skill file does
		// not, so the read fails with the parent already in place — a different arm from
		// "nothing on disk at all". Built with `dirname`, not by regex-stripping the last
		// segment: `[^/\\]+$` backtracks quadratically on a long separator-free path,
		// which CodeQL flags as polynomial ReDoS (js/polynomial-redos) even in a test.
		const path = skillPath(tempDir, "claude", sanitizeSkillIdForPath("superpowers:brainstorming"));
		await writeFile(join(dirname(path), ".keep"), "", "utf-8").catch(() => undefined);
		const result = await writeSkillMarkdown(use(), tempDir);
		expect(result.invocationCount).toBe(1);
	});

	it("rebuilds from scratch when the existing file is corrupt", async () => {
		const first = await writeSkillMarkdown(use(), tempDir);
		await writeFile(first.sourcePath, "totally not markdown", "utf-8");
		const second = await writeSkillMarkdown(use({ invocations: [inv("2026-07-30T09:00:00.000Z")] }), tempDir);
		expect(second.invocationCount).toBe(1);
		expect((await readFile(second.sourcePath, "utf-8")).startsWith("---")).toBe(true);
	});

	it("keeps two different skills in separate files", async () => {
		const a = await writeSkillMarkdown(use({ skill: "superpowers:brainstorming" }), tempDir);
		const b = await writeSkillMarkdown(use({ skill: "superpowers:test-driven-development" }), tempDir);
		expect(a.sourcePath).not.toBe(b.sourcePath);
		expect((await readSkillMarkdown(a.sourcePath))?.skill).toBe("superpowers:brainstorming");
		expect((await readSkillMarkdown(b.sourcePath))?.skill).toBe("superpowers:test-driven-development");
	});

	it("keeps the same skill from different sources in separate files", async () => {
		const claude = await writeSkillMarkdown(use({ source: "claude" }), tempDir);
		const opencode = await writeSkillMarkdown(use({ source: "opencode" }), tempDir);
		expect(claude.sourcePath).not.toBe(opencode.sourcePath);
	});

	it("returns null from readSkillMarkdown for a path that does not exist", async () => {
		expect(await readSkillMarkdown(join(tempDir, "nope.md"))).toBeNull();
	});
});
