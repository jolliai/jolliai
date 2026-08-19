window.JD = window.JD || {};

((JD) => {
	JD.esc = (text) =>
		String(text == null ? "" : text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			// Single quotes too: no page interpolates into a '-delimited
			// attribute today, but this page holds the dashboard token, so a
			// future one would turn a hostile commit message into an
			// authenticated call against the mutating /api routes.
			.replace(/'/g, "&#39;");

	/**
	 * An ATTRIBUTE-READY href for an EXTERNAL url, or null when the url is not one
	 * this page will navigate to.
	 *
	 * The `Attr` is in the name because the return value is already escaped, which
	 * a caller cannot see from the argument: it goes straight between the quotes
	 * of `href="…"` and must NOT be passed through `JD.esc` again (double-escaped)
	 * or used in a context that escapes differently.
	 *
	 * Escaping alone is not enough for an `href`: `javascript:…` survives every
	 * replacement above intact, and this page holds the dashboard token, so a
	 * hostile url reaching a link would run authenticated against the mutating
	 * /api routes. The url comes from an archived MCP reference — a third party's
	 * string — so the scheme is allowlisted rather than filtered.
	 *
	 * The allowlist is narrower than the web but not narrower than the DATA: every
	 * builtin reference source (Linear, Jira, Confluence, Slack, Notion, Zoom,
	 * Asana, monday, context7) stores an https url, including the ones whose apps
	 * also have a private scheme — so nothing is being swallowed today. Adding a
	 * `zoommtg:`-style scheme here later is a decision about what this page will
	 * hand to the OS, and should come with the row still rendering (unlinked) when
	 * the answer is no.
	 *
	 * The check runs on a PROBE rather than on the url itself, because a browser
	 * does not read a scheme byte-for-byte: it removes tab/LF/CR from anywhere in
	 * a url and trims leading C0-or-space before it looks, so `java\nscript:`
	 * navigates. The probe mirrors exactly those two rules and nothing else, while
	 * the ESCAPED ORIGINAL is what gets rendered — so a url is emitted only when
	 * the browser would read an allowed scheme out of that same original.
	 *
	 * Dropping every C0-or-space (the first spelling of this) was not a hole, and
	 * why it wasn't is worth keeping: the probe only ever decides, it never becomes
	 * the href, and a raw url the browser cannot read a scheme from is a RELATIVE
	 * one — it resolves against this origin, so `http s://x` renders as a dead
	 * same-origin link rather than escalating into a new scheme. What the superset
	 * did cost is accuracy: it admitted spellings no browser reads as https, which
	 * can only ever be that dead link.
	 */
	JD.safeHref = (url) => {
		var raw = String(url == null ? "" : url).trim();
		var probe = raw
			.replace(/[\t\n\r]/g, "")
			.replace(/^[\u0000-\u0020]+/, "")
			.toLowerCase();
		return /^(https?:|mailto:)/.test(probe) ? raw : null;
	};

	/**
	 * The same decision, escaped for an HTML attribute.
	 *
	 * The two are split because one caller asks the QUESTION without wanting the
	 * markup answer: the Context viewer's link bridge (`wireContextNav` in
	 * memories.js) uses this to reject a url before it considers navigating, where
	 * an HTML-escaped string would be wrong.
	 *
	 * That caller does NOT then open this function's return value, and the reason
	 * belongs here so nobody "simplifies" it back: `window.open` is a sink CodeQL
	 * tracks, this function is assigned onto the global `JD` in another asset file,
	 * and no static analysis can tie the call to the allowlist above — so the
	 * scanner sees an unguarded redirect and flags it (it did). The bridge
	 * therefore re-parses with `new URL` inline and opens the PARSER's output. This
	 * check is the intent; that one guards the navigation.
	 */
	JD.safeHrefAttr = (url) => {
		var raw = JD.safeHref(url);
		return raw === null ? null : JD.esc(raw);
	};

	/* Markdown rendering for LLM-written prose (topic trigger/decisions/
	   response/todo, recap). Ported from the VS Code webview's
	   `renderCalloutText` / `inlineBold` (vscode/src/views/SummaryUtils.ts) so
	   the same stored summary reads the same on both surfaces — the fields are
	   markdown, and escaping them into one <p> collapsed every bullet list into
	   a run-on paragraph.

	   Deliberately the SAME narrow subset as the webview, not a real markdown
	   parser: `- ` / `* ` list lines and inline `**bold**`. Backticks stay
	   literal on both surfaces. Escaping happens FIRST and the only tags this
	   emits are ones it wrote itself, so agent-authored text can never inject
	   markup. */

	/** Inline `**bold**` -> <strong>. Input must already be HTML-escaped. */
	JD.mdInline = (html) => String(html == null ? "" : html).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

	/** Renders one prose field: `- ` lines collapse into <ul>, the rest joins with <br>. */
	JD.mdText = (raw) => {
		var lines = String(raw == null ? "" : raw).split("\n");
		var parts = [];
		var items = [];
		var flush = () => {
			if (items.length > 0) {
				parts.push("<ul>" + items.map((li) => "<li>" + li + "</li>").join("") + "</ul>");
				items = [];
			}
		};
		for (var i = 0; i < lines.length; i++) {
			var m = lines[i].match(/^[-*]\s+(.*)/);
			if (m) {
				items.push(JD.mdInline(JD.esc(m[1])));
				continue;
			}
			flush();
			var trimmed = lines[i].trim();
			if (trimmed.length > 0) parts.push(JD.mdInline(JD.esc(trimmed)));
		}
		flush();
		return parts.join("<br>");
	};

	/** Recap rendering: blank-line-separated paragraphs, mirroring the webview's recap section. */
	JD.mdParagraphs = (raw) =>
		String(raw == null ? "" : raw)
			.split(/\n\n+/)
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => "<p>" + JD.mdInline(JD.esc(p)) + "</p>")
			.join("");

	JD.fmtTokens = (n) => {
		if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
		return String(n);
	};

	JD.fmtUsd = (n) => "$" + (n || 0).toFixed(2);

	JD.relTime = (ms, nowMs) => {
		var diff = Math.max(0, (nowMs || Date.now()) - ms);
		var min = Math.round(diff / 60000);
		if (min < 1) return "just now";
		if (min < 60) return min + "m ago";
		var hours = Math.round(min / 60);
		if (hours < 24) return hours + "h ago";
		return Math.round(hours / 24) + "d ago";
	};

	JD.timeOfDay = (ms, timeZone) => {
		try {
			return new Intl.DateTimeFormat(undefined, {
				timeZone: timeZone,
				hour: "2-digit",
				minute: "2-digit",
				hourCycle: "h23",
			}).format(ms);
		} catch (e) {
			return new Date(ms).toISOString().slice(11, 16);
		}
	};

	/* "Tue, Jul 28" — the standup context strip's date, in the model's zone so it
	   agrees with the day buckets the server computed. */
	JD.weekdayDate = (ms, timeZone) => {
		try {
			return new Intl.DateTimeFormat("en-US", {
				timeZone: timeZone,
				weekday: "short",
				month: "short",
				day: "numeric",
			}).format(ms);
		} catch (e) {
			return new Date(ms).toISOString().slice(0, 10);
		}
	};

	/* "August 19, 2026 at 10:49 AM" — the memory footer's generation stamp.
	   Same option set as `formatFullDate` in cli/src/core/SummaryFormat.ts, which
	   is what the editor panel and the Markdown export print, so one memory reads
	   the same on every surface. "en-US" is pinned for that reason rather than
	   left to the viewer's locale: the other two callers pass it explicitly. */
	JD.fullDateTime = (ms, timeZone) => {
		try {
			return new Intl.DateTimeFormat("en-US", {
				timeZone: timeZone,
				year: "numeric",
				month: "long",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			}).format(ms);
		} catch (e) {
			return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
		}
	};

	/* Local `YYYY-MM-DD` in the model's zone — the same key the server buckets
	   days by. "en-CA" is what yields ISO order; DashboardQuery uses the same
	   locale for exactly that reason, so the two agree on the day boundary. */
	JD.dayKey = (ms, timeZone) => {
		try {
			return new Intl.DateTimeFormat("en-CA", {
				timeZone: timeZone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(ms);
		} catch (e) {
			return new Date(ms).toISOString().slice(0, 10);
		}
	};

	/* Stable series color per key: s1..s5 tokens, cycled. */
	JD.seriesColor = (index) => "var(--s" + ((index % 5) + 1) + ")";
})(window.JD);
