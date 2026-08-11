/**
 * Unit test for `assets/js/format.js`'s `JD.safeHrefAttr` — the scheme allowlist
 * standing between an archived third party's url and an `href` on a page that
 * holds the dashboard token.
 *
 * Same rationale as `MemoriesAsset.test.ts` / `FeedCardAsset.test.ts`, and it
 * applies harder to a security decision than to a renderer: the asset scripts
 * are plain JS bundled verbatim into the served page, so tsc never checks them
 * and the coverage floor cannot see them either (`vite.config.ts` excludes
 * `src/dashboard/assets/**`). An allowlist that stops holding — a scheme
 * quietly added, a probe that stops matching the browser — has no other signal.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Control characters by code point, not as escapes: what is under test IS the
 * handling of these bytes, so the literals must not be able to arrive as the
 * two-character sequences an unescaping source transform would leave behind.
 */
const ch = (code: number) => String.fromCharCode(code);
const TAB = ch(9);
const LF = ch(10);
const CR = ch(13);
/** A C0 control that is NOT JS whitespace, so `String.trim()` does not remove it. */
const SOH = ch(1);

function loadSafeHrefAttr(): (url: unknown) => string | null {
	const win = { JD: {} } as Record<string, unknown>;
	const src = readFileSync(new URL("./assets/js/format.js", import.meta.url), "utf8");
	// format.js touches nothing but `window` at load time.
	new Function("window", src)(win);
	return (win.JD as { safeHrefAttr: (url: unknown) => string | null }).safeHrefAttr;
}

const safeHrefAttr = loadSafeHrefAttr();

describe("format.js — JD.safeHrefAttr", () => {
	it("passes an allowlisted scheme through", () => {
		expect(safeHrefAttr("https://linear.app/x/issue/ABC-1")).toBe("https://linear.app/x/issue/ABC-1");
		expect(safeHrefAttr("http://localhost:3000/x")).toBe("http://localhost:3000/x");
		expect(safeHrefAttr("mailto:someone@example.com")).toBe("mailto:someone@example.com");
	});

	it("suppresses a javascript: url", () => {
		expect(safeHrefAttr("javascript:alert(1)")).toBeNull();
		expect(safeHrefAttr("JavaScript:alert(1)")).toBeNull();
		expect(safeHrefAttr("  javascript:alert(1)")).toBeNull();
	});

	it("suppresses the control-character spellings a browser would still navigate", () => {
		// A browser removes tab/LF/CR from anywhere in a url before it reads the
		// scheme, so each of these IS `javascript:` as far as navigation goes.
		expect(safeHrefAttr(`java${LF}script:alert(1)`)).toBeNull();
		expect(safeHrefAttr(`java${TAB}script:alert(1)`)).toBeNull();
		expect(safeHrefAttr(`java${CR}script:alert(1)`)).toBeNull();
		expect(safeHrefAttr(`${SOH}javascript:alert(1)`)).toBeNull();
	});

	it("suppresses anything outside the allowlist rather than filtering known-bad", () => {
		// The point of an allowlist is that this list does not have to be complete.
		expect(safeHrefAttr("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(safeHrefAttr("vbscript:msgbox(1)")).toBeNull();
		expect(safeHrefAttr("zoommtg://zoom.us/join?confno=1")).toBeNull();
		expect(safeHrefAttr("//evil.example/x")).toBeNull();
	});

	it("returns an attribute-escaped value, because the caller interpolates it raw", () => {
		const out = safeHrefAttr('https://x.example/?q="><img src=y onerror=alert(1)>');
		expect(out).toBe("https://x.example/?q=&quot;&gt;&lt;img src=y onerror=alert(1)&gt;");
	});

	it("suppresses a missing url", () => {
		expect(safeHrefAttr(undefined)).toBeNull();
		expect(safeHrefAttr(null)).toBeNull();
		expect(safeHrefAttr("")).toBeNull();
		expect(safeHrefAttr("   ")).toBeNull();
	});

	it("mirrors the browser's own stripping rather than a superset of it", () => {
		// Removed anywhere, so this one IS https to a browser and is allowed…
		expect(safeHrefAttr(`ht${TAB}tps://x.example/a`)).toBe(`ht${TAB}tps://x.example/a`);
		// …trimmed only at the front, so this one is too.
		expect(safeHrefAttr(`${SOH}https://x.example/a`)).toBe(`${SOH}https://x.example/a`);
		// But a C0 control INSIDE the scheme is not removed by any browser: this
		// is not a url anything reads as https, so nothing should call it one.
		// (The earlier spelling of the probe dropped every C0-or-space and let it
		// through — harmless, since the raw form renders as a dead relative link,
		// but not what the check claims to answer.)
		expect(safeHrefAttr(`h${SOH}ttps://x.example/a`)).toBeNull();
	});
});
