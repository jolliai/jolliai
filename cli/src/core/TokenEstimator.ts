/**
 * TokenEstimator — shared token-count estimator for LLM context budgeting.
 *
 * Lives in its own module so search/recall/future consumers can depend on
 * estimation without inheriting ContextCompiler's recall-specific surface.
 *
 * Estimation model: ~1.5 tokens per CJK character, ~0.25 tokens per ASCII
 * character. Accurate enough for budget heuristics (which always overshoot
 * slightly to leave headroom).
 */

const CJK_RANGE = /[一-鿿㐀-䶿豈-﫿\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}぀-ゟ゠-ヿ가-힯]/u;

/**
 * Estimates token count for mixed CJK/ASCII text.
 * CJK characters ~1.5 tokens each, ASCII ~0.25 tokens/char.
 */
export function estimateTokens(text: string): number {
	let cjkChars = 0;
	let asciiChars = 0;
	for (const ch of text) {
		if (CJK_RANGE.test(ch)) {
			cjkChars++;
		} else {
			asciiChars++;
		}
	}
	return Math.ceil(cjkChars * 1.5 + asciiChars * 0.25);
}
