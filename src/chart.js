/* =========================================================================
 * mAb TDM — lightweight dependency-free SVG chart
 * ========================================================================= */
(function (root) {
  'use strict';
  var ECU = root.ECU = root.ECU || {};

  function niceTicks(min, max, n) {
    var span = max - min;
    if (span <= 0) return [min];
    var step0 = span / Math.max(1, n);
    var mag = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10));
    var norm = step0 / mag;
    var step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10);
    var t0 = Math.ceil(min / step) * step;
    var out = [];
    for (var t = t0; t <= max + 1e-9; t += step) out.push(+t.toFixed(10));
    return out;
  }

  /* 1-2-5 sequence within each decade, restricted to [lo, hi]. Used for the
   * optional logarithmic y-axis, where a linear tick set would crowd the low
   * end and leave the high end empty. */
  function logTicks(lo, hi) {
    var out = [];
    if (!(hi > 0)) return out;
    if (!(lo > 0)) lo = hi / 1000;
    var e0 = Math.floor(Math.log10(lo)) - 1, e1 = Math.ceil(Math.log10(hi)) + 1;
    for (var e = e0; e <= e1; e++) {
      var base = Math.pow(10, e);
      [1, 2, 5].forEach(function (mult) {
        var v = base * mult;
        if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(+v.toPrecision(12));
      });
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  function fmt(v) {
    if (!isFinite(v)) return '–';
    if (Math.abs(v) >= 100) return String(Math.round(v));
    if (Math.abs(v) >= 10) return v.toFixed(0);
    return v.toFixed(1);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* cfg: {
   *   xMax, yMax, xLabel, yLabel,
   *   bands: [{x[], lo[], hi[], fill, label}],
   *   hband: {lo, hi, fill, label},
   *   hlines: [{y, color, dash, label}],
   *   vlines: [{x, color, label}],
   *   series: [{x[], y[], color, dash, width, label}],
   *   points: [{x, y, color, label}],
   *   legend: [{label, color, dash, swatch:'line'|'band'|'dot'}],
   *   hover:  {times[], rows: [{label, color, values[]}]}
   * }
   */
  /* v0.17.0 — compact (phone) layout. Every chart here is one hand-built SVG
   * string with a fixed viewBox, scaled to its container via
   * style="width:100%": the same 12px axis text that is crisp at 960 units
   * wide becomes ~5 real screen pixels once that viewBox is squeezed into a
   * ~340px phone card. Continuously scaling one wide layout down cannot fix
   * this — the fix is a genuinely different, narrower layout with LARGER
   * text relative to the plot: bigger font sizes, fewer ticks, and the
   * legend moved below the plot (where it can wrap onto more than one row,
   * since it no longer fits as a single line at any font size that reads).
   * The caller (ui.js) decides `compact` from the container's actual pixel
   * width, not from chart.js — this module stays a pure cfg-in/SVG-out
   * renderer with no DOM reads of its own. */
  /* How many rows cfg.legend wraps onto at the given plot width and legend
   * font size, using the identical greedy left-to-right packing the actual
   * legend renderer below uses. Run once, before H is decided, so the
   * reserved bottom margin always fits the real legend — a 3-item chart and
   * a 6-item one (this app's charts range over that) get different heights
   * instead of one guessed constant that overflows for the longer one. */
  function countLegendRows(lg, iw, fsLegend) {
    var x = 0, rows = 1;
    (lg || []).forEach(function (it) {
      var wTxt = Math.min(iw, it.label.length * (fsLegend * 0.56) + 24);
      if (x + wTxt > iw && x > 0) { rows++; x = 0; }
      x += wTxt;
    });
    return rows;
  }

  function render(el, cfg) {
    var compact = !!cfg.compact;
    var W = cfg.width || (compact ? 340 : 960);
    var fs = {
      tick: compact ? 15 : 12,
      axisLabel: compact ? 15 : 12.5,
      legend: compact ? 14 : 11.5,
      hline: compact ? 13.5 : 11.5
    };
    // Compact: a fixed plot height, plus a bottom margin SIZED TO THE ACTUAL
    // LEGEND — x-ticks, the x-axis label, and N wrapped legend rows. The
    // rotated y-axis label is dropped when compact (decorative next to the
    // unit already spelled out in the legend/title) to give the y-tick
    // numbers more room in the narrower left margin. H is derived, not
    // caller-supplied, for compact charts — nothing to keep in sync as a
    // chart's legend content changes.
    var m, H;
    if (compact) {
      m = { l: 54, r: 10, t: 30, b: 0 };
      var compactIw = W - m.l - m.r;
      var legRows = countLegendRows(cfg.legend, compactIw, fs.legend);
      var plotH = cfg.plotHeight || 210;
      var tickBand = 20, axisLabelBand = 14 + fs.axisLabel, legendGap = 12, rowH = fs.legend + 10, pad = 10;
      m.b = tickBand + axisLabelBand + legendGap + legRows * rowH + pad;
      H = m.t + plotH + m.b;
    } else {
      m = { l: 62, r: 18, t: 40, b: 46 };
      H = cfg.height || 440;
    }
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var xMin = cfg.xMin || 0, xMax = cfg.xMax || 100;
    var yMax = cfg.yMax || 100;
    // Optional logarithmic y-axis: values are unchanged (still µg/mL at the
    // caller), only their vertical position is compressed. A positive yMin is
    // required and supplied by the caller; it defaults to a decade-guard
    // below the top so a stray call never produces NaN positions.
    var logY = !!cfg.logY;
    var yMin = cfg.yMin != null ? cfg.yMin : 0;
    if (logY && !(yMin > 0)) yMin = yMax / 1000;
    var yFloor = logY ? yMin : 0;
    var logSpan = logY ? (Math.log10(yMax) - Math.log10(yMin)) : 0;
    var xSpan = xMax - xMin;
    if (xSpan <= 0) xSpan = 1;
    function X(v) { return m.l + ((v - xMin) / xSpan) * iw; }
    function Y(v) {
      if (!isFinite(v)) v = yFloor;
      if (v < yFloor) v = yFloor;
      if (v > yMax) v = yMax;
      if (logY) {
        var f = logSpan > 0 ? (Math.log10(v) - Math.log10(yMin)) / logSpan : 0;
        return m.t + ih - f * ih;
      }
      return m.t + ih - (v / yMax) * ih;
    }

    function escT(x) {
      return String(x == null ? '' : x)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    var s = [];
    /* role="img" + <title>/<desc>: without them a screen-reader user got nothing
     * at all from the forecast. The trough table alongside carries the numbers,
     * so the description names the chart and points at it (v0.13.0). */
    var ttl = cfg.title || 'Concentration–time forecast';
    var dsc = cfg.desc || ('Predicted concentration over time with a shaded 90% credible interval. ' +
      'The numeric values are listed in the trough table below this chart.');
    s.push('<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" ' +
      'role="img" aria-label="' + escT(ttl) + '" ' +
      'style="width:100%;height:auto;display:block;font-family:inherit">');
    s.push('<title>' + escT(ttl) + '</title><desc>' + escT(dsc) + '</desc>');

    // plot background
    s.push('<rect x="' + m.l + '" y="' + m.t + '" width="' + iw + '" height="' + ih + '" fill="#fbfdfe" stroke="#e2e8f0"/>');

    // future region shading
    if (cfg.futureFrom != null && cfg.futureFrom > xMin && cfg.futureFrom < xMax) {
      var fx = X(cfg.futureFrom);
      s.push('<rect x="' + fx + '" y="' + m.t + '" width="' + Math.max(0, m.l + iw - fx) + '" height="' + ih + '" fill="rgba(251,191,36,.07)"/>');
    }

    // horizontal reference band (titration window)
    if (cfg.hband) {
      var yLo = Y(Math.min(cfg.hband.lo, yMax)), yHi = Y(Math.min(cfg.hband.hi, yMax));
      s.push('<rect x="' + m.l + '" y="' + yHi + '" width="' + iw + '" height="' + Math.max(0, yLo - yHi) +
        '" fill="' + cfg.hband.fill + '"/>');
    }

    // grid + y ticks (log decades when the log axis is requested)
    var yt = logY ? logTicks(yMin, yMax) : niceTicks(0, yMax, compact ? 4 : 6);
    for (var i = 0; i < yt.length; i++) {
      var yy = Y(yt[i]);
      s.push('<line x1="' + m.l + '" y1="' + yy + '" x2="' + (m.l + iw) + '" y2="' + yy + '" stroke="#e8eef4" stroke-width="1"/>');
      s.push('<text x="' + (m.l - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="' + fs.tick + '" fill="#64748b">' + fmt(yt[i]) + '</text>');
    }
    // x ticks
    var xt = niceTicks(xMin, xMax, compact ? 4 : 8);
    for (var j = 0; j < xt.length; j++) {
      var xx = X(xt[j]);
      s.push('<line x1="' + xx + '" y1="' + (m.t + ih) + '" x2="' + xx + '" y2="' + (m.t + ih + 5) + '" stroke="#94a3b8"/>');
      s.push('<text x="' + xx + '" y="' + (m.t + ih + 20) + '" text-anchor="middle" font-size="' + fs.tick + '" fill="#64748b">' + fmt(xt[j]) + '</text>');
    }
    // axis labels — the rotated y-axis label is dropped when compact (see
    // the note above render()); the x-axis label sits right under the ticks
    // in the taller reserved bottom margin instead of pinned to H-8, so the
    // legend rows below it have their own dedicated space.
    var xLabelY = compact ? (m.t + ih + tickBand + fs.axisLabel + 4) : (H - 8);
    s.push('<text x="' + (m.l + iw / 2) + '" y="' + xLabelY + '" text-anchor="middle" font-size="' + fs.axisLabel + '" fill="#475569">' + esc(cfg.xLabel || 'Time') + '</text>');
    if (!compact) {
      s.push('<text x="16" y="' + (m.t + ih / 2) + '" text-anchor="middle" font-size="' + fs.axisLabel + '" fill="#475569" transform="rotate(-90 16 ' + (m.t + ih / 2) + ')">' + esc(cfg.yLabel || 'Concentration') + '</text>');
    }

    // dose vlines
    (cfg.vlines || []).forEach(function (v) {
      var x = X(v.x);
      if (x < m.l - 1 || x > m.l + iw + 1) return;
      s.push('<line x1="' + x + '" y1="' + m.t + '" x2="' + x + '" y2="' + (m.t + ih) + '" stroke="' + (v.color || '#cbd5e1') + '" stroke-width="1" stroke-dasharray="' + (v.dash || '2 3') + '"/>');
    });

    // confidence bands
    (cfg.bands || []).forEach(function (b) {
      if (!b.x.length) return;
      var d = 'M';
      for (var i2 = 0; i2 < b.x.length; i2++) {
        d += X(b.x[i2]).toFixed(1) + ' ' + Y(Math.min(b.hi[i2], yMax)).toFixed(1) + (i2 < b.x.length - 1 ? ' L' : '');
      }
      for (var i3 = b.x.length - 1; i3 >= 0; i3--) {
        d += ' L' + X(b.x[i3]).toFixed(1) + ' ' + Y(Math.max(0, Math.min(b.lo[i3], yMax))).toFixed(1);
      }
      d += ' Z';
      s.push('<path d="' + d + '" fill="' + b.fill + '" stroke="none"/>');
    });

    // hlines (target)
    (cfg.hlines || []).forEach(function (h) {
      var y = Y(h.y);
      if (y < m.t || y > m.t + ih) return;
      s.push('<line x1="' + m.l + '" y1="' + y + '" x2="' + (m.l + iw) + '" y2="' + y + '" stroke="' + h.color + '" stroke-width="' + (h.width || 1.6) + '" stroke-dasharray="' + (h.dash || '7 5') + '"/>');
      // white halo so the label stays readable over troughs and points (review C2)
      s.push('<text x="' + (m.l + iw - 6) + '" y="' + (y - 5) + '" text-anchor="end" font-size="' + fs.hline + '" fill="' + h.color + '" font-weight="600" stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">' + esc(h.label || '') + '</text>');
    });

    // series
    (cfg.series || []).forEach(function (sr) {
      if (!sr.x.length) return;
      var start = 0;
      while (start < sr.x.length && sr.x[start] < xMin - 1e-9) start++;
      var pts = '';
      for (var i4 = start; i4 < sr.x.length; i4++) {
        if (sr.x[i4] > xMax) break;
        pts += X(sr.x[i4]).toFixed(1) + ',' + Y(Math.max(0, Math.min(sr.y[i4], yMax))).toFixed(1) + ' ';
      }
      s.push('<polyline points="' + pts.trim() + '" fill="none" stroke="' + sr.color + '" stroke-width="' + (sr.width || 2) + '"' +
        (sr.dash ? ' stroke-dasharray="' + sr.dash + '"' : '') + ' stroke-linejoin="round"/>');
    });

    // points
    (cfg.points || []).forEach(function (p) {
      if (p.x < xMin - 1e-9 || p.x > xMax) return;
      var x = X(p.x), y = Y(Math.min(p.y, yMax));
      var attrs = 'cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4.4" fill="' + p.color + '" stroke="#fff" stroke-width="1.6"';
      // v0.10.0: optional class + data hook (hover sync in the GOF panel)
      if (p.cls) attrs += ' class="' + p.cls + '"';
      if (p.data != null) attrs += ' data="' + p.data + '"';
      if (p.hollow) { attrs = attrs.replace('fill="' + p.color + '"', 'fill="#fbfdfe" stroke="' + p.color + '"'); }
      s.push('<circle ' + attrs + '/>');
    });

    // v0.10.0 errorBars: vertical intervals at each x — used by the EBE forest
    // panel (posterior 5-95% per parameter). bar: {x, lo, hi, color, width?, cap?}
    (cfg.errorBars || []).forEach(function (b) {
      if (!isFinite(b.x) || !isFinite(b.lo) || !isFinite(b.hi)) return;
      var x = X(b.x);
      var y1 = Y(Math.max(xMin, Math.min(b.lo, yMax))), y2 = Y(Math.max(xMin, Math.min(b.hi, yMax)));
      var cap = b.cap != null ? b.cap : 5;
      var col = b.color || '#0e7490';
      s.push('<line x1="' + x.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + col + '" stroke-width="' + (b.width || 2.4) + '" stroke-linecap="round"/>');
      s.push('<line x1="' + (x - cap) + '" y1="' + y1.toFixed(1) + '" x2="' + (x + cap) + '" y2="' + y1.toFixed(1) + '" stroke="' + col + '" stroke-width="' + (b.width || 2.4) + '" stroke-linecap="round"/>');
      s.push('<line x1="' + (x - cap) + '" y1="' + y2.toFixed(1) + '" x2="' + (x + cap) + '" y2="' + y2.toFixed(1) + '" stroke="' + col + '" stroke-width="' + (b.width || 2.4) + '" stroke-linecap="round"/>');
    });

    // legend
    var lg = cfg.legend || [];
    if (compact) {
      /* Compact: below the plot, left-aligned, WRAPPING onto as many rows as
       * it needs — the single-row right-to-left layout below can't be reused
       * here, since at any font size that's legible on a phone this app's
       * legends (up to 6 items: population/individual bands, observation,
       * dose, today, a projected-dose marker) do not fit one row at any
       * width. `countLegendRows` above already worked out exactly how many
       * rows this legend needs and sized `m.b` (and so `H`) for it, so this
       * loop's own wrapping decisions are guaranteed to have room. */
      var clx = m.l, cly = xLabelY + legendGap + fs.legend;
      var maxX = m.l + iw + m.r;
      lg.forEach(function (it) {
        var wTxt = it.label.length * (fs.legend * 0.56) + 24;
        if (clx + wTxt > maxX && clx > m.l) { clx = m.l; cly += rowH; }
        if (it.swatch === 'band') {
          s.push('<rect x="' + clx + '" y="' + (cly - 9) + '" width="13" height="11" fill="' + it.color + '" stroke="#94a3b8" stroke-width="0.5"/>');
        } else if (it.swatch === 'dot') {
          s.push('<circle cx="' + (clx + 6) + '" cy="' + (cly - 3.5) + '" r="4.6" fill="' + it.color + '" stroke="#fff" stroke-width="1.2"/>');
        } else {
          s.push('<line x1="' + clx + '" y1="' + (cly - 3.5) + '" x2="' + (clx + 14) + '" y2="' + (cly - 3.5) + '" stroke="' + it.color + '" stroke-width="2.6"' + (it.dash ? ' stroke-dasharray="' + it.dash + '"' : '') + '/>');
        }
        s.push('<text x="' + (clx + 18) + '" y="' + cly + '" font-size="' + fs.legend + '" fill="#334155">' + esc(it.label) + '</text>');
        clx += wTxt;
      });
    } else {
      // top-right, one row (unchanged)
      var lx = m.l + iw - 8, ly = m.t + 16;
      for (var L = lg.length - 1; L >= 0; L--) {
        var it2 = lg[L];
        var wTxt2 = it2.label.length * 6.4 + 20;
        lx -= wTxt2;
        if (it2.swatch === 'band') {
          s.push('<rect x="' + lx + '" y="' + (ly - 9) + '" width="13" height="11" fill="' + it2.color + '" stroke="#94a3b8" stroke-width="0.5"/>');
        } else if (it2.swatch === 'dot') {
          s.push('<circle cx="' + (lx + 6) + '" cy="' + (ly - 3.5) + '" r="4.2" fill="' + it2.color + '" stroke="#fff" stroke-width="1.2"/>');
        } else {
          s.push('<line x1="' + lx + '" y1="' + (ly - 3.5) + '" x2="' + (lx + 14) + '" y2="' + (ly - 3.5) + '" stroke="' + it2.color + '" stroke-width="2.4"' + (it2.dash ? ' stroke-dasharray="' + it2.dash + '"' : '') + '/>');
        }
        s.push('<text x="' + (lx + 18) + '" y="' + ly + '" font-size="11.5" fill="#334155">' + esc(it2.label) + '</text>');
      }
    }

    // hover guide (hidden initially)
    s.push('<line id="mab-hguide" x1="0" y1="' + m.t + '" x2="0" y2="' + (m.t + ih) + '" stroke="#0e7490" stroke-width="1" opacity="0"/>');

    // hover overlay
    s.push('<rect x="' + m.l + '" y="' + m.t + '" width="' + iw + '" height="' + ih + '" fill="transparent" id="mab-hoverrect"/>');
    s.push('</svg>');
    s.push('<div id="mab-tooltip" style="position:absolute;display:none;pointer-events:none;background:#0f172a;color:#f8fafc;font-size:12px;line-height:1.5;padding:7px 10px;border-radius:8px;white-space:nowrap;z-index:30;box-shadow:0 4px 14px rgba(2,6,23,.35)"></div>');

    el.innerHTML = s.join('');
    el.style.position = 'relative';

    // hover behaviour
    var hv = cfg.hover;
    if (hv && hv.times && hv.times.length) {
      var rect = el.querySelector('#mab-hoverrect');
      var guide = el.querySelector('#mab-hguide');
      var tip = el.querySelector('#mab-tooltip');
      var svgEl = el.querySelector('svg');
      rect.addEventListener('mousemove', function (evn) {
        var bb = svgEl.getBoundingClientRect();
        var px = (evn.clientX - bb.left) * (W / bb.width);
        // Map cursor to the data coordinate (accounting for a non-zero xMin,
        // e.g. the negative history days in steady-state mode).
        var rel = xMin + (px - m.l) / iw * xSpan;
        // nearest time (binary search)
        var lo = 0, hi = hv.times.length - 1;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (hv.times[mid] < rel) lo = mid + 1; else hi = mid;
        }
        var idx = lo;
        if (idx > 0 && Math.abs(hv.times[idx - 1] - rel) < Math.abs(hv.times[idx] - rel)) idx--;
        var t = hv.times[idx];
        guide.setAttribute('x1', X(t)); guide.setAttribute('x2', X(t));
        guide.setAttribute('opacity', 0.55);
        var html = '<b>Day ' + (Math.round(t * 10) / 10) + '</b>' +
          (cfg.hoverDate ? ' · ' + esc(cfg.hoverDate(t)) : '') + '<br>';
        hv.rows.forEach(function (r) {
          var v = r.values[idx];
          if (isFinite(v)) html += '<span style="color:' + r.color + '">&#9632;</span> ' + esc(r.label) + ': <b>' + fmt(v) + '</b><br>';
        });
        tip.innerHTML = html;
        tip.style.display = 'block';
        var host = el.getBoundingClientRect();
        var tx = (X(t) / W) * host.width + 14;
        // Two-sided clamp: the right-edge-only version could pin the tooltip
        // off the LEFT edge on a narrow card (host.width - tipW going small
        // or negative), which is exactly the width this app was redesigned
        // for (v0.17.0's phone layout). tipW is an estimate of the tooltip's
        // own (unstyled, content-sized) width, same figure the old clamp used.
        var tipW = 190;
        tip.style.left = Math.max(4, Math.min(tx, host.width - tipW - 4)) + 'px';
        tip.style.top = '10px';
      });
      rect.addEventListener('mouseleave', function () {
        guide.setAttribute('opacity', 0);
        tip.style.display = 'none';
      });
    }
  }

  ECU.chart = { render: render, niceTicks: niceTicks, logTicks: logTicks };
})(typeof window !== 'undefined' ? window : globalThis);
