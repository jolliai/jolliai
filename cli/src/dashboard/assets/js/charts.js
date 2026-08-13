window.JD = window.JD || {};

((JD) => {
	/* `Jul 25` from a `YYYY-MM-DD` day key.
	 *
	 * Formatted from the STRING, never through `new Date(key)`: that parses a bare
	 * day key as UTC midnight while `getMonth`/`getDate` read local, so west of
	 * UTC every label renders one day early. The key is already the right day —
	 * the payload bucketed it in its own zone — so there is nothing to convert,
	 * only to spell. (The range calendar in `shell.js` carries the same warning
	 * for the same reason, from the opposite direction.) */
	var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	var dayLabel = (key) => {
		var parts = String(key).split("-");
		var month = MONTHS[Number(parts[1]) - 1];
		return month && parts[2] ? month + " " + Number(parts[2]) : String(key);
	};

	/* Tokens' and Spend's daily chart.
	 *
	 * **The date axis is the two ENDPOINTS, not a tick per bar.** It used to label
	 * every other bar with its bare day-of-month: fine over 7 days, but at 30 and
	 * especially 90 it was a row of numbers too dense to read and too sparse to
	 * count along, and with no month on any of them `12` could be this month's or
	 * last quarter's. Two labelled ends state the window exactly, in the space the
	 * ticks were wasting, and they do not get denser as the range grows.
	 *
	 * Between the ends, per-bar identification is the same affordance
	 * `JD.recallBars` relies on: every segment carries a `<title>` with its full
	 * date, series key and value.
	 */
	JD.stackedBars = (series, keys, valueLabel) => {
		var W = 660;
		var bottom = 214;
		/* Baseline + room for the endpoint labels + the same 8px margin the right
		   edge uses. */
		var H = bottom + 24;
		var left = 42;
		var plotW = W - left - 8;
		var slot = plotW / Math.max(1, series.length);
		var barW = slot * 0.58;
		var max = 1;
		series.forEach((point) => {
			var total = 0;
			keys.forEach((key) => {
				total += point.bySeries[key] || 0;
			});
			if (total > max) max = total;
		});
		var svg =
			'<svg viewBox="0 0 ' +
			W +
			" " +
			H +
			'" width="100%" role="img" aria-label="Daily ' +
			JD.esc(valueLabel) +
			', stacked bars">';
		for (var g = 0; g <= 4; g++) {
			var y = bottom - (g * (bottom - 10)) / 4;
			svg +=
				'<line x1="' +
				left +
				'" y1="' +
				y +
				'" x2="' +
				(W - 8) +
				'" y2="' +
				y +
				'" stroke="var(--grid)" stroke-width="1"></line>' +
				'<text x="' +
				(left - 8) +
				'" y="' +
				(y + 4) +
				'" text-anchor="end" font-size="11" fill="var(--muted)" class="num">' +
				JD.fmtTokens(Math.round((max * g) / 4)) +
				"</text>";
		}
		series.forEach((point, dayIndex) => {
			var x = left + dayIndex * slot + (slot - barW) / 2;
			var yCursor = bottom;
			keys.forEach((key, keyIndex) => {
				var value = point.bySeries[key] || 0;
				if (value <= 0) return;
				var h = ((bottom - 10) * value) / max;
				yCursor -= h;
				svg +=
					'<rect x="' +
					x.toFixed(2) +
					'" y="' +
					yCursor.toFixed(2) +
					'" width="' +
					barW.toFixed(2) +
					'" height="' +
					Math.max(1, h).toFixed(2) +
					'" fill="' +
					JD.seriesColor(keyIndex) +
					'"><title>' +
					JD.esc(point.date + " · " + key + " · " + JD.fmtTokens(value)) +
					"</title></rect>";
			});
		});
		/* The two endpoints, anchored to the plot's own edges rather than to their
		   bars' centres — at 90 days a centred label overhangs the axis, and the
		   window's bounds are what these state, not where two particular bars sit.
		   A single-day window prints one label: the same day twice, at both ends,
		   would read as a range that is not one. */
		if (series.length > 0) {
			var axis = (x, anchor, key) =>
				'<text x="' +
				x +
				'" y="' +
				(bottom + 18) +
				'" text-anchor="' +
				anchor +
				'" font-size="10.5" fill="var(--muted)">' +
				JD.esc(dayLabel(key)) +
				"</text>";
			svg += axis(left, "start", series[0].date);
			if (series.length > 1) svg += axis(W - 8, "end", series[series.length - 1].date);
		}
		return svg + "</svg>";
	};

	/* The heatmap's 5-step scale, exported so the card's legend renders the SAME
	   swatches the cells use — a legend with its own copy of the palette is a
	   guaranteed future drift. */
	var HEAT_FILLS = ["var(--heat-track)", "#9ec5f4", "#5598e7", "#2a78d6", "#1c5cab"];
	JD.heatColor = (level) => HEAT_FILLS[Math.max(0, Math.min(HEAT_FILLS.length - 1, level))];

	/* 12-week activity heatmap. cells: [{date, sessions, commits, tokens}] oldest→newest. */
	JD.heatmap = (cells) => {
		var cols = Math.ceil(cells.length / 7);
		var size = 13;
		var gap = 3;
		var W = 30 + cols * (size + gap);
		var H = 7 * (size + gap) + 4;
		var max = 1;
		cells.forEach((cell) => {
			var v = cell.sessions + cell.commits;
			if (v > max) max = v;
		});
		var svg =
			'<svg viewBox="0 0 ' +
			W +
			" " +
			H +
			'" width="100%" style="max-width:' +
			W * 1.6 +
			'px" role="img" aria-label="Activity heatmap, 12 weeks">';
		/* Row labels are derived from the FIRST cell's weekday, not assumed.
		   `cells` is 84 consecutive days ending today, so row 0 is whatever weekday
		   that window happens to start on — a fixed M/W/F/S ladder was right on one
		   day in seven and silently mislabelled the grid on the other six. Parsed as
		   UTC (the key is a bare local `YYYY-MM-DD`, and only the weekday is wanted,
		   so a zone shift would be the only thing able to move it). */
		var DOW = ["S", "M", "T", "W", "T", "F", "S"];
		var firstDow = cells.length > 0 ? new Date(cells[0].date + "T00:00:00Z").getUTCDay() : 1;
		for (var r = 0; r < 7; r += 2) {
			svg +=
				'<text x="0" y="' +
				(11 + r * (size + gap)) +
				'" font-size="9.5" fill="var(--muted)">' +
				DOW[(firstDow + r) % 7] +
				"</text>";
		}
		cells.forEach((cell, index) => {
			var week = Math.floor(index / 7);
			var day = index % 7;
			var value = cell.sessions + cell.commits;
			var level = value === 0 ? 0 : Math.min(4, 1 + Math.floor((3 * value) / max));
			svg +=
				'<rect x="' +
				(30 + week * (size + gap)) +
				'" y="' +
				day * (size + gap) +
				'" width="' +
				size +
				'" height="' +
				size +
				'" rx="2.5" fill="' +
				JD.heatColor(level) +
				'"><title>' +
				JD.esc(cell.date + " · " + cell.sessions + " sessions · " + cell.commits + " commits") +
				"</title></rect>";
		});
		return svg + "</svg>";
	};

	/* Hour-of-day histogram. hours: [{hour, sessions}] for 0..23. */
	JD.hourBars = (hours) => {
		var W = 320;
		var H = 56;
		var slot = W / 24;
		var barW = slot * 0.8;
		var max = 1;
		hours.forEach((h) => {
			if (h.sessions > max) max = h.sessions;
		});
		var peak = hours.reduce(
			(best, h) => (h.sessions > best.sessions ? h : best),
			hours[0] || { hour: 0, sessions: 0 },
		);
		var svg =
			'<svg viewBox="0 0 ' +
			W +
			" " +
			H +
			'" width="100%" style="max-width:420px" role="img" aria-label="Sessions by hour of day">';
		hours.forEach((h) => {
			var height = h.sessions === 0 ? 1.5 : 4 + (38 * h.sessions) / max;
			var fill = h.hour === peak.hour && h.sessions > 0 ? "var(--s1)" : "var(--grid)";
			svg +=
				'<rect x="' +
				(h.hour * slot).toFixed(2) +
				'" y="' +
				(42 - height).toFixed(2) +
				'" width="' +
				barW.toFixed(2) +
				'" height="' +
				height.toFixed(2) +
				'" rx="1.5" fill="' +
				fill +
				'"><title>' +
				JD.esc(h.hour + ":00 · " + h.sessions + " sessions") +
				"</title></rect>";
		});
		[0, 6, 12, 18, 23].forEach((hour) => {
			svg +=
				'<text x="' +
				(hour * slot + barW / 2).toFixed(2) +
				'" y="54" font-size="9" text-anchor="middle" fill="var(--muted)" class="num">' +
				hour +
				"</text>";
		});
		return svg + "</svg>";
	};

	/* Ranked horizontal bars — the mockup's rendering for every non-model axis
	   (agent / project / branch / ticket / category), where a stacked-by-day
	   chart would be noise: what matters is the ordering of totals. */
	JD.rankedBars = (rows) => {
		var max = 1;
		rows.forEach((r) => {
			if (r.tokens > max) max = r.tokens;
		});
		var html = '<div class="ranked">';
		rows.forEach((row, index) => {
			html +=
				'<div class="rrow">' +
				'<span class="lbl mono">' +
				JD.esc(row.key) +
				"</span>" +
				'<span class="track"><span class="bar" style="width:' +
				((row.tokens / max) * 100).toFixed(1) +
				"%;background:" +
				JD.seriesColor(index) +
				'"></span></span>' +
				'<span class="val num">' +
				JD.fmtTokens(row.tokens) +
				'<span class="meta">' +
				(row.cost > 0 ? JD.fmtUsd(row.cost) + " est" : "—") +
				"</span></span>" +
				"</div>";
		});
		return html + "</div>";
	};

	/* Per-day cost table — the mockup's `table view` toggle. One column per
	   series key plus a total, so the chart's numbers are readable exactly. */
	JD.seriesTable = (series, keys) => {
		var html = '<table class="ttable"><thead><tr><th>Day</th>';
		keys.forEach((key) => {
			html += '<th class="r mono">' + JD.esc(key) + "</th>";
		});
		html += '<th class="r">Total</th></tr></thead><tbody>';
		series.forEach((point) => {
			var total = 0;
			var cells = "";
			keys.forEach((key) => {
				var value = point.bySeries[key] || 0;
				total += value;
				cells += '<td class="r num">' + (value > 0 ? JD.fmtTokens(value) : "—") + "</td>";
			});
			html +=
				"<tr><td>" +
				JD.esc(point.date.slice(5)) +
				"</td>" +
				cells +
				'<td class="r num"><b>' +
				(total > 0 ? JD.fmtTokens(total) : "—") +
				"</b></td></tr>";
		});
		return html + "</tbody></table>";
	};

	/* Sparkline, ported from the mockup's `spark()`: a polyline over N values
	   with the latest point marked. Flat series (max === min) render as a
	   mid-height line rather than dividing by zero. */
	JD.spark = (values, w, h, varName) => {
		if (!values || values.length < 2) return "";
		var max = Math.max.apply(null, values);
		var min = Math.min.apply(null, values);
		var span = max - min || 1;
		var points = values.map((v, i) => [
			((i / (values.length - 1)) * (w - 8) + 4).toFixed(1),
			(h - 5 - ((v - min) / span) * (h - 12)).toFixed(1),
		]);
		var last = points[points.length - 1];
		var color = "var(" + (varName || "--s1") + ")";
		return (
			'<svg viewBox="0 0 ' +
			w +
			" " +
			h +
			'" width="' +
			w +
			'" height="' +
			h +
			'" aria-hidden="true">' +
			'<polyline points="' +
			points.map((p) => p.join(",")).join(" ") +
			'" fill="none" stroke="' +
			color +
			'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
			'<circle cx="' +
			last[0] +
			'" cy="' +
			last[1] +
			'" r="3.5" fill="' +
			color +
			'"/></svg>'
		);
	};
})(window.JD);
