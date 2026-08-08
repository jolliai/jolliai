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
