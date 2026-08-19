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
	/* Exported because the Skills pane's own charts label the SAME day keys, and a
	   second copy of this would drift exactly on the `new Date(key)` trap the comment
	   above exists to warn about. One spelling of a day, page-wide. */
	JD.dayLabel = dayLabel;

	/* The series palette holds FIVE colours and `JD.seriesColor` cycles them, so a
	   sixth series is drawn in the first one's colour and the stack stops being
	   readable back to a legend. Measured: `category` produces 10 series and
	   `branch` 23, i.e. every colour reused ~5x.

	   Extending the palette is not the fix. `--s1..--s5` reproduces a validated
	   categorical order chosen for colour-vision separation (see the comment on
	   `--s1` in main.css: the adjacent cat-1/cat-2 pair scores ΔE 2.3 under
	   deuteranopia against a floor of 15), and there is no supply of 23 colours
	   that stays distinguishable. Ranking and rolling up the tail is.

	   `limit` is therefore FOUR, not five: the roll-up bucket is itself a series
	   and needs the fifth colour. Five plus "Other" would wrap again — the exact
	   bug this removes.

	   It MERGES rather than truncates, and that is load-bearing: the Spend card's
	   headline is the sum of the bars it draws, so dropping the tail would make
	   the headline smaller than its own chart. The bucket keeps the total exact.

	   Returns the per-key totals too, so a legend never recomputes them from the
	   pre-roll-up keys — which would print an amount for a series that is no
	   longer drawn, and none for the bucket that replaced it. */
	var OTHER_KEY = "Other";
	/* The bucket's key is a display label that also has to be UNIQUE, and series
	   keys are user-controlled strings — a branch, a ticket or a repo really can
	   be named `Other`. Colliding is not a cosmetic tie: `byKey[OTHER_KEY] = 0`
	   overwrites that series' own total, the per-point `bySeries[OTHER_KEY]`
	   overwrites its daily value, and `kept.concat` then lists one key TWICE — so
	   the legend prints two identical swatches and `stackedBars`' `keys.forEach`
	   sums that segment twice, inflating every bar and the axis bound with it.
	   The Spend headline is computed before the roll-up, so the card would be back
	   to disagreeing with its own chart.

	   Suffixing until free is the whole fix. The loop runs zero times on every
	   real dataset, and in the case it does fire a legend reading `Other` and
	   `Other ` is strictly better than one series silently absorbing another. */
	var otherKeyFor = (totals) => {
		var key = OTHER_KEY;
		while (key in totals) key += " ";
		return key;
	};
	JD.topSeries = (series, keys, limit) => {
		var totals = Object.create(null);
		var read = (point, key) => (typeof point.bySeries[key] === "number" ? point.bySeries[key] : 0);
		keys.forEach((key) => {
			totals[key] = 0;
		});
		series.forEach((point) => {
			keys.forEach((key) => {
				totals[key] += read(point, key);
			});
		});
		if (keys.length <= limit) return { keys: keys, series: series, byKey: totals };
		/* Sorted by total, so the colours track magnitude rather than the server's
		   alphabetical key order — and the tie-break is the key itself, so two
		   equal series cannot swap places between renders of the same data. */
		var kept = keys
			.slice()
			.sort((a, b) => totals[b] - totals[a] || (a < b ? -1 : a > b ? 1 : 0))
			.slice(0, limit);
		var isKept = Object.create(null);
		kept.forEach((key) => {
			isKept[key] = true;
		});
		var otherKey = otherKeyFor(totals);
		var byKey = Object.create(null);
		kept.forEach((key) => {
			byKey[key] = totals[key];
		});
		byKey[otherKey] = 0;
		var rolled = series.map((point) => {
			var bySeries = Object.create(null);
			var other = 0;
			keys.forEach((key) => {
				var value = read(point, key);
				if (isKept[key]) bySeries[key] = value;
				else other += value;
			});
			bySeries[otherKey] = other;
			byKey[otherKey] += other;
			return { ...point, bySeries: bySeries };
		});
		return { keys: kept.concat([otherKey]), series: rolled, byKey: byKey };
	};

	/* An axis bound that divides into four ROUND ticks.
	 *
	 * The bound was the data maximum itself, quartered — so a token axis read
	 * `0 / 2.2M / 4.3M / 6.5M / 8.7M`, four arbitrary numbers whose only property
	 * was summing back to the tallest bar.
	 *
	 * The step comes off a 1/2/2.5/5/10 ladder and the bound is four of them, so
	 * the bound is always >= the data (a step is never smaller than max/4) and no
	 * bar can overflow the top gridline. That containment is why the ticks cannot
	 * simply be the issue's `0 / 2M / … / 8M` for a maximum of 8.7M: 8M would clip
	 * the tallest bar. The honest equivalent is `0 / 2.5M / 5M / 7.5M / 10M`.
	 *
	 * Scale-free by construction, because the same axis draws dollars: a $0.37 day
	 * gets a $0.10 step, not a $1 one that would flatten the whole chart. The bar
	 * loop used to seed `max = 1`, which defeated exactly that — a floor of "one
	 * token" means nothing in dollars, and every sub-$1 window was drawn against a
	 * $1 axis. The no-data case is seeded HERE instead, at 4, so its four ticks
	 * stay integers on the token axis rather than reading `0 / 0.25 / 0.5 / …`. */
	var niceAxisMax = (max) => {
		if (!(max > 0)) return 4;
		var raw = max / 4;
		var magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
		var frac = raw / magnitude;
		var step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * magnitude;
		return step * 4;
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
	 *
	 * **`fmt` formats the axis ticks AND that tooltip**, defaulting to
	 * `JD.fmtTokens` because this began as the token chart and Spend was later
	 * drawn with the same function — so a money axis read `0 / 17 / 34 / 50` with
	 * no `$`, cents rounded away, and a $1,200 day labelled `1.2k`: a token suffix
	 * on a currency. The caller owns the unit; this function never did.
	 */
	JD.stackedBars = (series, keys, valueLabel, fmt) => {
		var format = fmt || JD.fmtTokens;
		var W = 660;
		var bottom = 214;
		/* Baseline + room for the endpoint labels + the same 8px margin the right
		   edge uses. */
		var H = bottom + 24;
		var left = 42;
		var plotW = W - left - 8;
		var slot = plotW / Math.max(1, series.length);
		var barW = slot * 0.58;
		/* Seeded at 0, not 1 — `niceAxisMax` owns the no-data case. */
		var max = 0;
		/* Typed read, not `|| 0`: `topSeries` hands its INPUT series straight back
		   when the key count is within the limit, so `bySeries` here can still be
		   the JSON.parse'd object with a prototype. A series named `constructor`
		   then yields the inherited function on any day it is absent — `|| 0`
		   treats it as a value, and the bar geometry below becomes NaN. */
		var read = (point, key) => (typeof point.bySeries[key] === "number" ? point.bySeries[key] : 0);
		series.forEach((point) => {
			var total = 0;
			keys.forEach((key) => {
				total += read(point, key);
			});
			if (total > max) max = total;
		});
		/* The bars are scaled by this same bound, deliberately. Rounding only the
		   LABELS would leave a tallest bar that touches the top gridline while the
		   gridline claims a larger number. */
		max = niceAxisMax(max);
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
				format((max * g) / 4) +
				"</text>";
		}
		series.forEach((point, dayIndex) => {
			var x = left + dayIndex * slot + (slot - barW) / 2;
			var yCursor = bottom;
			keys.forEach((key, keyIndex) => {
				var value = read(point, key);
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
					JD.esc(point.date + " · " + key + " · " + format(value)) +
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

	/**
	 * One value per LOCAL DAY of the window, as the Skills pane's small charts.
	 *
	 * SVG, not the flex row of `<i>` divs this replaced, and the reason is the axis
	 * rather than the markup. These charts now span the whole window, so their bar
	 * count is the window's day count — and a flex row cannot survive that: at
	 * `min-width: 3px` with a 3px gap, 90 days needs 537px and a 366-day custom range
	 * needs 2193px, so the row overflowed its own pane and the right-hand days were
	 * simply not on screen while the axis label underneath still claimed them. A
	 * viewBox scales instead, which is exactly how `JD.stackedBars` above already
	 * survives 366 days in the band.
	 *
	 * `preserveAspectRatio="none"` with a CSS-fixed height: the bars stretch
	 * horizontally to whatever width the pane has and the chart keeps its 46px, so
	 * bar-to-gap ratio is constant at every range. Nothing here draws text — the two
	 * endpoint labels stay HTML in `.sk-axis`, because text under a `none` aspect
	 * ratio is text that has been stretched.
	 *
	 * A ZERO DAY IS A 6-UNIT STUB on `--heat-track`, never a skipped bar: a fortnight's
	 * gap has to read as measured absence. That is the same rule the flex version
	 * carried and the same rule the band follows by walking the window rather than the
	 * data.
	 *
	 * The flex version's 2px top corners are gone rather than ported: under a `none`
	 * aspect ratio an `rx` is scaled on one axis only, so a rounded corner becomes a
	 * visibly lopsided one — and at a range's real bar width (~18px at 30 days, under
	 * 5px at 90) there was nothing there to see anyway.
	 */
	JD.dayBars = (days, values, opts) => {
		var options = opts || {};
		/* `fmt` owns the WHOLE value, unit included, rather than taking a unit suffix
		   beside it: a suffix cannot inflect, so one bar in `" sessions"` read `1
		   sessions`. Same division of labour `JD.stackedBars` draws for its axis. */
		var format = options.fmt || JD.fmtTokens;
		/* One viewBox unit per day, so `slot` is 1 and the bar/gap split is the band's
		   0.58 — the two charts thin out together as the range grows. */
		var barW = 0.58;
		var max = 0;
		values.forEach((value) => {
			if (value > max) max = value;
		});
		var svg =
			'<svg class="sk-daybars" viewBox="0 0 ' +
			Math.max(1, days.length) +
			' 100" preserveAspectRatio="none" role="img" aria-label="' +
			JD.esc(options.label || "Daily values") +
			'">';
		days.forEach((day, index) => {
			var value = typeof values[index] === "number" ? values[index] : 0;
			/* Floors at 20 so a lone call on a busy skill's chart is still a visible bar
			   rather than a hairline indistinguishable from the empty stub. */
			var h = value > 0 ? Math.max(20, max > 0 ? (value / max) * 100 : 100) : 6;
			svg +=
				'<rect x="' +
				(index + (1 - barW) / 2).toFixed(3) +
				'" y="' +
				(100 - h).toFixed(2) +
				'" width="' +
				barW +
				'" height="' +
				h.toFixed(2) +
				'" fill="' +
				(value > 0 ? "var(--accent)" : "var(--heat-track)") +
				'"><title>' +
				JD.esc(dayLabel(day) + " · " + format(value)) +
				"</title></rect>";
		});
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

	/* No `JD.rankedBars` here, deliberately. It rendered `{key, tokens, cost}`
	   rows produced by a `rankRows` helper in stats.js, and nothing on any page
	   ever called it — so when the Spend card moved to per-day apportionment and
	   `rankRows` went away with it, the last thing that could ever fill `cost`
	   went too. What was left was a function whose every row would have printed
	   "—" for the estimate: an unwired renderer for a shape no code produces,
	   which is worse than no renderer at all. Every axis now draws through
	   `JD.stackedBars` + `JD.topSeries`. */

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
