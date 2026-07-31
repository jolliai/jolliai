/**
 * Real `part.data` rows for OpenCode skill invocations, copied verbatim out of
 * `~/.local/share/opencode/opencode.db` with only the body text truncated.
 *
 * OpenCode is the one non-Claude host with a FIRST-CLASS skill tool, so its
 * invocation is machine-identifiable with no heuristics — but its shape differs
 * from Claude's in ways that a from-memory fixture would have got wrong:
 *
 *   - the injected body is INLINE in `state.output`, wrapped in a
 *     `<skill_content name="…">` element, not in a separate record;
 *   - `state.metadata` carries the resolved on-disk `dir` and a `truncated` flag;
 *   - `state.time.start` / `.end` are epoch MILLISECONDS, not ISO strings;
 *   - skill names are FLAT — no `plugin:name` namespace anywhere in the corpus;
 *   - the top-level `metadata` key is present on older rows and absent on newer
 *     ones, so nothing may depend on it.
 */

/** Older row shape: carries a top-level `metadata` (provider item id). */
export const OC_SKILL_WITH_TOP_METADATA =
	'{"type":"tool","tool":"skill","callID":"call_CmMnF4DXOeTnXMs7haokuDxu","state":{"status":"completed","input":{"name":"comprehensive-review-full-review"},"output":"<skill_content name=\\"comprehensive-review-full-review\\">\\n# Skill: comprehensive-review-full-review\\n\\n## Use this skill when\\n\\n- Working on comprehensive ","metadata":{"name":"comprehensive-review-full-review","dir":"/Users/flyer/.agents/skills/comprehensive-review-full-review","truncated":false},"title":"Loaded skill: comprehensive-review-full-review","time":{"start":1779005748620,"end":1779005748641}},"metadata":{"openai":{"itemId":"fc_029de1a9a6954d30016a0979346dfc81919f612a2732ab0eef"}}}';

/** Newer row shape: no top-level `metadata` at all. */
export const OC_SKILL_NO_TOP_METADATA =
	'{"type":"tool","tool":"skill","callID":"call_a0d984da877148ac902f33bd","state":{"status":"completed","input":{"name":"jolli"},"output":"<skill_content name=\\"jolli\\">\\n# Skill: jolli\\n\\n# Jolli\\n\\nThe single umbrella action menu for Jolli. It ties together the standalone Jolli\\nskills and what","metadata":{"name":"jolli","dir":"/Users/flyer/jolli/code/jolli/.agents/skills/jolli","truncated":false},"title":"Loaded skill: jolli","time":{"start":1785216878468,"end":1785216878490}}}';

/** A non-skill tool row, for the filter. */
export const OC_NON_SKILL_TOOL =
	'{"type":"tool","tool":"read","callID":"call_read1","state":{"status":"completed","input":{"filePath":"/tmp/x.ts"},"output":"contents","title":"/tmp/x.ts","time":{"start":1785216878468,"end":1785216878490}}}';

/**
 * Real assistant `message.data` token shape.
 *
 * `cache.read` is CUMULATIVE — measured across one real session it ran
 * 0 → 25344 → 25472 → 31488 → … → 63360 — and `total` INCLUDES it, so `total` is
 * likewise polluted and unusable. Genuine new spend per turn is
 * `input + output + reasoning + cache.write`.
 */
export const OC_ASSISTANT_MESSAGE =
	'{"parentID":"msg_p","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/repo","root":"/repo"},"cost":0,"tokens":{"total":31728,"input":89,"output":47,"reasoning":104,"cache":{"write":0,"read":31488}},"modelID":"deepseek-v4-flash-free","providerID":"opencode","time":{"created":1785416541376,"completed":1785416544095}}';

export const OC_USER_MESSAGE = '{"role":"user","time":{"created":1785416541000}}';
