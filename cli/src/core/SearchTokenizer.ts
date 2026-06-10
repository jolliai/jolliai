/**
 * CJK-aware Orama tokenizer for the local search index.
 *
 * Orama's default tokenizer splits on the English rule
 * `/[^A-Za-zàèéìòóù0-9_'-]+/`, which treats every CJK character as a separator —
 * so a Chinese/Japanese/Korean body yields ZERO tokens and is unsearchable. We
 * wrap the default tokenizer (keeping its Latin lowercasing + English stemming)
 * and additionally emit n-grams for each maximal CJK run: every character as a
 * unigram (so single-character queries match) plus every adjacent pair as a
 * bigram (so multi-character queries score on contiguity). The same tokenizer is
 * applied at index AND query time, so the n-gram sets line up for BM25 matching.
 *
 * No dictionary segmentation (no extra dependency, no Node-version constraints) —
 * n-grams trade some precision for guaranteed recall, which is the right default
 * for a small local memory index.
 */

import type { Tokenizer } from "@orama/orama";
import { tokenizer as oramaTokenizer } from "@orama/orama/components";

/**
 * Maximal runs of CJK script: Unified Ideographs + Ext A, Compatibility
 * Ideographs, Hiragana, Katakana, and Hangul syllables. Latin/digits are left to
 * the default tokenizer.
 */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;

/** Unigrams + adjacent bigrams for one CJK run (e.g. "认证超" → 认,证,超,认证,证超). */
function cjkNGrams(text: string): string[] {
	const grams: string[] = [];
	for (const match of text.matchAll(CJK_RUN)) {
		const run = match[0];
		for (let i = 0; i < run.length; i++) {
			grams.push(run[i]);
			if (i + 1 < run.length) grams.push(run.slice(i, i + 2));
		}
	}
	return grams;
}

/**
 * A {@link Tokenizer} that tokenizes Latin text via Orama's default and augments
 * each CJK run with unigram + bigram tokens. Must be applied to BOTH a freshly
 * built db (via `create({ components: { tokenizer } })`) and a restored db (whose
 * tokenizer reverts to default — reassign `db.tokenizer`), so index-time and
 * query-time tokenization agree.
 */
export function createSearchTokenizer(): Tokenizer {
	const base = oramaTokenizer.createTokenizer();
	const baseTokenize = base.tokenize.bind(base);
	base.tokenize = (raw, language, prop, withCache) => {
		const latin = baseTokenize(raw, language, prop, withCache);
		if (typeof raw !== "string") return latin;
		const grams = cjkNGrams(raw.toLowerCase());
		return grams.length ? Array.from(new Set([...latin, ...grams])) : latin;
	};
	return base;
}
