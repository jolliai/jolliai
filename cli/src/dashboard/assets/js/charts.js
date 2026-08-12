window.JD = window.JD || {};

((JD) => {
	/* 14-day stacked bar chart. series: [{date, bySeries}], keys: series names. */
	JD.stackedBars = (series, keys, valueLabel) => {
		var W = 660;
		var H = 240;
		var left = 42;
		var bottom = 214;
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
			if (dayIndex % 2 === 0) {
				svg +=
					'<text x="' +
					(x + barW / 2).toFixed(2) +
					'" y="232" text-anchor="middle" font-size="10.5" fill="var(--muted)">' +
					JD.esc(point.date.slice(8)) +
					"</text>";
			}
		});
		return svg + "</svg>";
	};

	/* Recall card's bar strip — three FIXED, semantic fills, never the generic
	   series palette: accent is "the model used it", muted is "set aside"
	   because recall came back with nothing to work with, and a hatch is
	   "called, outcome never recorded" (see RecallDayPoint.estimated). The
	   hatch is deliberately not a fourth solid color: that value is a LOWER
	   BOUND, and a solid bar beside two exact ones claims a precision it does
	   not have.

	   **No date axis, deliberately — that is the design.** The mockup carries
	   none: it gets its readability from few, wide bars (a 7-day window), and
	   30 thin bars under 30 tick labels is more crowded than the strip it is
	   meant to be. What replaces the axis for the sparse case is per-day
	   identification on HOVER: every day has a `<title>`, including the empty
	   ones, so a lone bar in a 30-day window can still be placed by pointing at
	   it. The empty-day ticks and the `sinceDate` boundary carry the rest —
	   without them a window whose data starts partway through (the normal case
	   for a young `recall_receipts` table, and permanently the case for the days
	   before it existed) read as a broken chart rather than as "only this day
	   has data". */
	JD.recallBars = (daily, sinceDate) => {
		var W = 640;
		var H = 64;
		var bottom = 58;
		var slot = W / Math.max(1, daily.length);
		var barW = Math.max(2, slot * 0.6);
		var max = 1;
		daily.forEach((d) => {
			/* `estimated` joins the scale even though it is never stacked with the
			   other two (a day has receipts or an estimate, never both — the query
			   zeroes the estimate per day). Leaving it out let an estimate-only
			   window scale against max=1 and clip every bar to full height. */
			var total = Math.max(d.used + d.setAside, d.estimated || 0);
			if (total > max) max = total;
		});
		var sinceIndex = -1;
		if (sinceDate) {
			daily.forEach((d, i) => {
				if (sinceIndex < 0 && d.date >= sinceDate) sinceIndex = i;
			});
		}
		var svg =
			'<svg viewBox="0 0 ' +
			W +
			" " +
			H +
			'" width="100%" role="img" aria-label="Daily recall calls, used vs set aside">' +
			/* Hatch for the estimated bars. One pattern definition, referenced by
			   every such bar — `--muted` at low opacity so it reads as "less
			   certain" beside the two solid fills rather than as another category. */
			'<defs><pattern id="recallEstHatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">' +
			'<rect width="4" height="4" fill="var(--heat-track)"/>' +
			'<line x1="0" y1="0" x2="0" y2="4" stroke="var(--muted)" stroke-width="1.2" opacity="0.55"/>' +
			"</pattern></defs>";
		/* The pre-recording stretch, painted BEFORE the bars so it sits behind
		   them: a faint block plus the day recording began. This is the element
		   that turns "29 empty days" from a defect into a fact. */
		if (sinceIndex > 0) {
			svg +=
				'<rect x="0" y="0" width="' +
				(sinceIndex * slot).toFixed(2) +
				'" height="' +
				bottom +
				'" fill="var(--heat-track)" opacity="0.45"/>' +
				'<line x1="' +
				(sinceIndex * slot).toFixed(2) +
				'" y1="0" x2="' +
				(sinceIndex * slot).toFixed(2) +
				'" y2="' +
				bottom +
				'" stroke="var(--grid)" stroke-width="1" stroke-dasharray="2 2"/>' +
				'<text x="2" y="11" font-size="10" fill="var(--muted)">' +
				JD.esc("recording starts " + sinceDate.slice(5)) +
				"</text>";
		}
		daily.forEach((d, i) => {
			var x = i * slot + (slot - barW) / 2;
			var y = bottom;
			if (d.used > 0) {
				var usedH = ((bottom - 4) * d.used) / max;
				y -= usedH;
				svg +=
					'<rect x="' +
					x.toFixed(2) +
					'" y="' +
					y.toFixed(2) +
					'" width="' +
					barW.toFixed(2) +
					'" height="' +
					Math.max(1, usedH).toFixed(2) +
					'" rx="1" fill="var(--accent)"><title>' +
					JD.esc(d.date + " · " + d.used + " used") +
					"</title></rect>";
			}
			if (d.setAside > 0) {
				var asideH = ((bottom - 4) * d.setAside) / max;
				y -= asideH;
				svg +=
					'<rect x="' +
					x.toFixed(2) +
					'" y="' +
					y.toFixed(2) +
					'" width="' +
					barW.toFixed(2) +
					'" height="' +
					Math.max(1, asideH).toFixed(2) +
					'" rx="1" fill="var(--muted)"><title>' +
					JD.esc(d.date + " · " + d.setAside + " set aside") +
					"</title></rect>";
			}
			/* Estimated bars never stack onto the two above: the query zeroes the
			   estimate on any day that has a receipt, precisely so this cannot
			   double-count one call. So this is an `else if` in effect, and the
			   tooltip states the uncertainty rather than leaving the hatch to carry
			   it alone. */
			if (d.estimated > 0) {
				var estH = ((bottom - 4) * d.estimated) / max;
				y -= estH;
				svg +=
					'<rect x="' +
					x.toFixed(2) +
					'" y="' +
					y.toFixed(2) +
					'" width="' +
					barW.toFixed(2) +
					'" height="' +
					Math.max(1, estH).toFixed(2) +
					'" rx="1" fill="url(#recallEstHatch)"><title>' +
					JD.esc(d.date + " · at least " + d.estimated + " called, outcome not recorded") +
					"</title></rect>";
			}
			/* A day with nothing gets a 2px stub on the baseline. "Counted, and it
			   was zero" and "outside the window" are different facts, and without a
			   stub they looked identical — which is what made a single-bar chart
			   read as broken. With no date axis (see the header) the stub is also
			   the only hover target such a day has, and therefore the only way to
			   name it — so it is load-bearing here, not decoration. */
			if (d.used === 0 && d.setAside === 0 && !d.estimated) {
				svg +=
					'<rect x="' +
					x.toFixed(2) +
					'" y="' +
					(bottom - 2) +
					'" width="' +
					barW.toFixed(2) +
					'" height="2" fill="var(--grid)"><title>' +
					JD.esc(d.date + " · no recall calls") +
					"</title></rect>";
			}
		});
		svg += '<line x1="0" y1="' + bottom + '" x2="' + W + '" y2="' + bottom + '" stroke="var(--grid)" stroke-width="1"/>';
		return svg + "</svg>";
	};
})(window.JD);
