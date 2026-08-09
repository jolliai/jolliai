/**
 * InlineScript — the one hardening applied to JSON embedded in an inline
 * `<script>` block. Kept dependency-free on purpose: three surfaces inline
 * model JSON into a page (the dashboard server, the standalone graph export,
 * and the VS Code webview panel), and each used to carry its own copy of this
 * function. Three copies of a security primitive is three chances to fix one
 * and miss two — which is exactly what happened: all three neutralized
 * `</script` and missed `<!--`.
 */

/**
 * Escapes every `<` in already-serialized JSON as `<`, plus the two raw JS
 * line terminators U+2028/U+2029 that `JSON.stringify` leaves unescaped.
 *
 * Escaping the character rather than the `</script` sequence is what makes this
 * complete. The HTML tokenizer has THREE ways out of a script block, and the
 * sequence-based version only closed one of them:
 *
 *   - `</script`  — closes the element.
 *   - `<!--`      — enters script-data-escaped state, after which the block's
 *                   own `</script>` no longer closes it. A commit message
 *                   containing `<!--<script>` therefore swallowed every script
 *                   inlined after the data block (blank page), and with a
 *                   matching `-->` it was an injection primitive.
 *   - `<script`   — inside the escaped state, escalates one level further.
 *
 * All three start with `<`, and `<` is the same string to a JSON parser,
 * so one substitution covers the whole class with no per-sequence reasoning.
 * `>` and `&` are deliberately NOT escaped: neither can move the tokenizer out
 * of script-data state, so escaping them would only inflate the payload.
 *
 * Input MUST be the output of `JSON.stringify` (or equivalent). This is safe
 * for a JSON document precisely because every `<` in one is inside a string
 * literal; applied to arbitrary JS it would corrupt a `a < b` comparison.
 */
export function escapeForInlineScript(json: string): string {
	return json
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}
