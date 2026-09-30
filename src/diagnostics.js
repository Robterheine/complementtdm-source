/* =========================================================================
 * mAb TDM — individual fit diagnostics (v0.10.0)
 *
 * Two panels, both pure functions over the runFit result:
 *
 *  1. gofPanel(fit, spec)  — observed vs individual prediction scatter with
 *     identity line and a ±2 SD residual band (per-point SD from the drug's
 *     error model: SD = sqrt(ADD + PROP * ipred^2)), plus a residual strip
 *     (one row per measurement with colour-coded relative residual).
 *  2. ebePanel(fit, spec)  — forest-style departure plot: posterior median
 *     [5-95%] for CL and V1 vs the covariate-adjusted population typical
 *     value for THIS patient (eta = 0 at the patient's weight/age).
 *
 * Residual colour thresholds: green |rel| <= 30%, amber 30-60%, red > 60%
 * (typical mAb proportional error is 24-30%, so <=30% is "within assay+model
 * noise"). Censored (<LLOQ) samples have no numeric ipred comparison and are
 * shown as censored rows only.
 *
 * No calculation here individualizes anything — all numbers come from
 * bayes.runFit; this module only shapes them for display.
 * ========================================================================= */
(function (root) {
  'use strict';
  var ECU = root.ECU = root.ECU || {};

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function fmtC(v) {
    if (!isFinite(v)) return '–';
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return v.toFixed(0);
    return v.toFixed(2);
  }
  function relLevel(r) { var a = Math.abs(r); return a <= 0.3 ? 'ok' : (a <= 0.6 ? 'warn' : 'bad'); }

  /* Residual strip rows: [{i, t, obs, ipred, rel, level, lloq}] */
  function residualRows(fit, lloq) {
    if (!fit || !fit.obsData) return [];
    return fit.obsData.map(function (o, i) {
      var row = { i: i, t: o.t, c: o.c, lloq: !!o.lloq, ipred: NaN, rel: NaN, level: '' };
      if (o.lloq) return row;                       // censored: no numeric comparison
      var ip = o.ipred;
      if (!isFinite(ip) || ip <= 0) { row.level = 'bad'; return row; }
      row.ipred = ip;
      row.rel = (o.c - ip) / ip;
      row.level = relLevel(row.rel);
      return row;
    });
  }

  /* Chart config: obs vs ipred with identity line + ±2SD band. */
  function gofChart(fit, spec) {
    var obs = (fit.obsData || [])
      .map(function (o, i) { return Object.assign({}, o, { i: i }); })
      .filter(function (o) { return !o.lloq && isFinite(o.ipred) && o.ipred > 0; });
    if (!obs.length) return null;
    var pts = obs.map(function (o) { return { x: o.ipred, y: o.c }; });
    var xs = pts.map(function (p) { return p.x; }).concat(pts.map(function (p) { return p.y; }));
    var hi = Math.max.apply(null, xs);
    var lo = Math.min.apply(null, xs);
    var pad = (hi - lo) * 0.08 + hi * 0.04;
    var top = hi + pad;
    var SIG = spec.SIGMA;
    // ±2 SD band around the identity line, sampled over the x range
    var bx = [], bLo = [], bHi = [];
    for (var k = 0; k <= 20; k++) {
      var v = lo + (top - lo) * k / 20;
      var sd = Math.sqrt(SIG.ADD + SIG.PROP * v * v);
      bx.push(v); bLo.push(Math.max(0, v - 2 * sd)); bHi.push(v + 2 * sd);
    }
    var bandPts = bx.map(function (v, i) { return { x: v, lo: bLo[i], hi: bHi[i] }; });
    return {
      xMax: top, yMax: top,
      xLabel: 'Individual predicted concentration (µg/mL)',
      yLabel: 'Observed concentration (µg/mL)',
      bands: [{
        x: bandPts.map(function (p) { return p.x; }),
        lo: bandPts.map(function (p) { return p.lo; }),
        hi: bandPts.map(function (p) { return p.hi; }),
        fill: 'rgba(14,116,144,.10)',
        label: '±2 SD residual band'
      }],
      series: [{ x: [0, top], y: [0, top], color: '#0e7490', width: 2, label: 'identity' }],
      points: obs.map(function (o) {
        return { x: o.ipred, y: o.c, color: '#155e75', cls: 'gof-pt', data: o.i };
      }),
      legend: [
        { label: 'measurement', color: '#155e75', swatch: 'dot' },
        { label: 'identity', color: '#0e7490', swatch: 'line' },
        { label: '±2 SD', color: 'rgba(14,116,144,.10)', swatch: 'band' }
      ]
    };
  }

  /* Forest config: one error bar per parameter. Values in native units
   * (CL L/day, V1 L); the chart normalizes each row to % departure from the
   * population typical value so both parameters share one x axis. */
  function ebeChart(fit, spec) {
    if (!fit || !fit.popTypical || !fit.clPostDraws) return null;
    function statsOf(arr) {
      var a = arr.slice().sort(function (p, q) { return p - q; });
      function q(p) {
        var pos = (a.length - 1) * p, l = Math.floor(pos), h = Math.ceil(pos);
        return l === h ? a[l] : a[l] + (a[h] - a[l]) * (pos - l);
      }
      return { p5: q(0.05), med: q(0.5), p95: q(0.95) };
    }
    var rows = [
      { name: 'CL (L/day)', unit: 'L/day', typ: fit.popTypical.cl, st: statsOf(fit.clPostDraws) },
      { name: 'V1 (L)', unit: 'L', typ: fit.popTypical.v1, st: statsOf(fit.v1PostDraws) }
    ].map(function (r) {
      // express as % of the population typical value
      return {
        name: r.name, typ: r.typ, st: r.st,
        medPct: (r.st.med - r.typ) / r.typ * 100,
        loPct: (r.st.p5 - r.typ) / r.typ * 100,
        hiPct: (r.st.p95 - r.typ) / r.typ * 100
      };
    });
    var lim = 0;
    rows.forEach(function (r) { lim = Math.max(lim, Math.abs(r.loPct), Math.abs(r.hiPct), 40); });
    lim = Math.ceil(lim / 10) * 10;
    return { rows: rows, lim: lim };
  }

  /* ---- HTML builders (called from ui.js) -------------------------------- */

  /* hostId: the report renders a SECOND copy of this panel. Both used to emit
   * id="gofChart", so document.getElementById always resolved the on-screen one
   * and the report's box was left empty in every printout (fixed v0.13.0). */
  function gofPanel(fit, spec, fmtDateFn, hostId) {
    var rows = residualRows(fit);
    var chart = gofChart(fit, spec);
    var h = '';
    if (chart) {
      h += '<div class="diag-chart" id="' + (hostId || 'gofChart') + '"></div>';
      h += '<div class="legend-note">Each point is one measured concentration against the model\u2019s individual prediction at the same time. Points on the diagonal line = the model reproduces the sample. The shaded band is the \u00b12 SD measurement-noise range implied by the assay error model (open points = below LLOQ, handled as censored).</div>';
    }
    // Found while verifying the phone/desktop chart work: this table had no
    // scroll wrapper either (same gap as the trough and regimen-explorer
    // tables), so it clipped silently inside the (narrow, scrollable)
    // diagnostics modal on a phone. overflow-x:auto is inert for print.
    h += '<div class="tbl-wrap"><table class="data diag-res"><thead><tr><th>Sample</th><th>Day</th><th>Date</th><th class="num">Observed</th><th class="num">Indiv. pred</th><th class="num">Rel. residual</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var lvl = r.lloq ? '' : relLevel(r.rel);
      h += '<tr class="res-row" data-obs-idx="' + r.i + '">' +
        '<td><span class="res-dot ' + (r.lloq ? '' : lvl) + '" title="' +
        (r.lloq ? 'Below LLOQ — handled as censored (M3 method)' :
          'Relative residual ' + Math.round(r.rel * 100) + '%') + '"></span>' + (r.i + 1) + '</td>' +
        '<td>' + (isFinite(r.t) ? r.t.toFixed(1) : '–') + '</td>' +
        '<td>' + (fmtDateFn ? fmtDateFn(r.t) : '') + '</td>' +
        '<td class="num">' + (r.lloq ? '&lt; LLOQ' : fmtC(r.c)) + '</td>' +
        '<td class="num">' + (r.lloq ? 'censored' : fmtC(r.ipred)) + '</td>' +
        '<td class="num">' + (r.lloq ? '—' : (isFinite(r.rel) ? (r.rel > 0 ? '+' : '') + Math.round(r.rel * 100) + '%' : '–')) + '</td>' +
        '</tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="legend-note">Residual = (observed − predicted) / predicted. <span class="sk-ok">Green \u2264 30%</span> (within assay + model noise) · <span class="sk-warn">amber 30\u201360%</span> · <span class="sk-bad">red &gt; 60%</span> — a red residual flags a sample the model does not explain; check the dose history or sampling time first.</div>';
    return h;
  }

  function ebePanel(fit, spec) {
    var fc = ebeChart(fit, spec);
    if (!fc) return '<div class="note">No individualization — EBEs require measurements.</div>';
    var h = '<div class="ebe-rows">';
    fc.rows.forEach(function (r) {
      var dep = r.medPct;
      var lo = Math.min(r.loPct, r.hiPct), hi = Math.max(r.loPct, r.hiPct);
      // colour: green = posterior interval inside ±1 population range proxy
      // (±40%, roughly the population 5-95% for these models); amber = median
      // outside but interval overlapping; red = interval fully outside.
      var lv = (lo >= -40 && hi <= 40) ? 'ok' : ((lo > 40 || hi < -40) ? 'bad' : 'warn');
      h += '<div class="ebe-row" title="' + esc(r.name) + ': population typical ' + fmtC(r.typ) +
        ' (covariate-adjusted for this patient); this patient ' + fmtC(r.st.med) +
        ' [5\u201395% ' + fmtC(r.st.p5) + '\u2013' + fmtC(r.st.p95) + '] — ' +
        (dep >= 0 ? '+' : '') + Math.round(dep) + '% vs population. Interval colour: green = within typical population variability, amber/red = deviates more than that.">' +
        '<span class="ebe-name">' + esc(r.name) + '</span>' +
        '<span class="ebe-track"><span class="ebe-zero"></span>' +
        '<span class="ebe-bar ' + lv + '" style="left:' + ebePos(lo, fc.lim) + '%;width:' + (ebePos(hi, fc.lim) - ebePos(lo, fc.lim)) + '%"></span>' +
        '<span class="ebe-med ' + lv + '" style="left:' + ebePos(r.medPct, fc.lim) + '%"></span></span>' +
        '<span class="ebe-val ' + lv + '">' + fmtC(r.st.med) + ' <i>(' + (dep >= 0 ? '+' : '') + Math.round(dep) + '%)</i></span>' +
        '</div>';
    });
    h += '</div>';
    h += '<div class="legend-note">Bars = posterior 5\u201395% range for this patient; the vertical tick inside is the median; the grey centre line is the population typical value adjusted for this patient\u2019s weight (and age where it is a covariate). <span class="sk-ok">Green = within population variability (\u00b140%)</span> · <span class="sk-warn">amber = median outside, interval overlapping</span> · <span class="sk-bad">red = clearly outside</span>. Cross-check with the shrinkage bars above: a short interval on a parameter with low shrinkage reflects the prior, not the samples.</div>';
    return h;
  }

  function ebePos(pct, lim) {
    var c = Math.max(-lim, Math.min(lim, pct));
    return (c + lim) / (2 * lim) * 100;
  }

  /* Summary hint for the collapsed <details> line: worst residual level. */
  function summaryHint(fit) {
    var rows = residualRows(fit).filter(function (r) { return !r.lloq; });
    if (!rows.length) return null;
    var worst = '';
    rows.forEach(function (r) {
      if (r.level === 'bad') worst = 'bad';
      else if (r.level === 'warn' && worst !== 'bad') worst = 'warn';
    });
    if (worst === 'bad') return 'check sample(s) with large residual';
    if (worst === 'warn') return 'moderate residuals';
    return 'good';
  }

  ECU.diagnostics = {
    residualRows: residualRows,
    gofChart: gofChart,
    ebeChart: ebeChart,
    gofPanel: gofPanel,
    ebePanel: ebePanel,
    summaryHint: summaryHint
  };
})(typeof window !== 'undefined' ? window : globalThis);
