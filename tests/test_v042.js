'use strict';
/* v0.42.0 — text and report fixes from CONSTRUCTIVE_REVIEW_2026-09-29.md.
 *
 * Mostly tested on RENDERED output (reportHtml / ptaBadge / chart.render),
 * which the review asked for: these are all things the app prints, and
 * source-text checks had missed them.
 *   A1  (author's decision: keep P for the TRUE trough, no assay error) —
 *       say "true trough" in the column headers.
 *   A2  never print a zero-width Monte-Carlo interval ("0% (0–0%)").
 *   A3  print the lowest ESS and which parameter it belongs to.
 *   B4  residual error as SD (µg/mL) and CV (%), with the variances kept.
 *   C2  halo behind the target label.
 *   C3  short chart legend labels (the long v0.40.0 one ran off a phone).
 *   C5  chart caption built from what the chart actually draws.
 *   C6  trough time shown at the dose time, not a minute before it.
 *   C7  µg/mL must not be uppercased into "ΜG/ML".
 *   C8  Day column as whole days.
 *   C13 date in the chart tooltip.
 *   C14 convergence diagnostics in the printed report.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/chart.js');
require('../src/ui.js');

async function run() {
  var t = new T('v0.42.0 report and display text fixes');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var css = fs.readFileSync('src/app.css', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');
  M.select('eculizumab');

  // ---- a real fit with certain troughs (P exactly 0 or 1 at some rows) ----
  var doses = [0, 14, 28, 42, 56, 70, 84, 98].map(function (d) { return { t: d, amt: 900, route: 'iv' }; });
  var obs = [[56, 78], [70, 95], [84, 82], [98, 88]].map(function (x) { return { t: x[0] - 1e-6, c: x[1], lloq: false }; });
  var fit = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, obs: obs, lloq: 0, target: 75, seed: 20250907 });
  var t0 = Date.UTC(2026, 5, 1, 7, 0);   // 09:00 Amsterdam summer time
  fit.rel = { ssMode: false, t0ms: t0, dosesRel: doses, obsRel: obs, excludedObs: 0, nowRel: 99 };
  var snap = {
    patient: { code: 'X', wt: 70, age: null, disease: 'PNH' }, target: { value: 75 }, lloq: 0, errMult: 1,
    doses: doses.map(function (d) { return { t: t0 + d.t * 86400000, amt: 900 }; }),
    obs: obs.map(function (o) { return { t: t0 + o.t * 86400000, c: o.c, lloq: false }; }),
    fit: fit, report: { preparedBy: 'test', advice: '' }
  };
  var rep = ECU.reportHtml(snap);

  // A2 — no zero-width interval anywhere
  t.ok(fit.troughs.some(function (tr) { return tr.pCI && Math.round(tr.pCI[0] * 100) === Math.round(tr.pCI[1] * 100); }),
    'precondition: this fit has at least one row whose Monte-Carlo interval rounds to zero width');
  t.ok(!/\((\d+)–\1%\)/.test(rep), 'the report prints no "(x–x%)" zero-width interval');
  t.ok(/&lt; 1%|&gt; 99%/.test(rep), 'certain rows are printed as "< 1%" or "> 99%", not 0% or 100%');
  var b1 = ECU.ptaBadge(1, [1, 1]), b0 = ECU.ptaBadge(0, [0, 0]);
  t.ok(b1.indexOf('100–100') < 0 && b0.indexOf('0–0%') < 0, 'the badge tooltip has no zero-width interval');
  t.ok(/P &gt; 99%/.test(b1) && /P &lt; 1%/.test(b0), 'the badge reads "P > 99%" / "P < 1%" for certain outcomes');
  t.ok(/P 85%/.test(ECU.ptaBadge(0.85, [0.83, 0.88])) && /83–88%/.test(ECU.ptaBadge(0.85, [0.83, 0.88])),
    'an ordinary probability still shows its value and interval');

  // A1 — true trough in the headers
  t.ok(/P\(true trough &gt; 75/.test(rep), 'report column header says "true trough"');
  t.ok(/P\(true trough &gt; ' \+ state\.target\.value/.test(ui), 'on-screen trough table header says "true trough"');

  // A3 — lowest ESS and its parameter
  var minIdx = fit.essAll.indexOf(Math.min.apply(null, fit.essAll));
  var minName = fit.map.etaNames[minIdx];
  t.ok(rep.indexOf('lowest ESS ≈ ' + Math.round(fit.essAll[minIdx]) + ' (' + minName + ')') >= 0,
    'report prints the lowest ESS with its parameter (' + minName + ' ' + Math.round(fit.essAll[minIdx]) + ')');
  t.ok(rep.indexOf('ESS ≈ ' + Math.round(fit.essCL) + ',') < 0 || Math.round(fit.essCL) === Math.round(fit.essAll[minIdx]),
    'the clearance ESS is no longer printed as the headline figure');

  // B4 — residual error as SD and CV
  t.ok(rep.indexOf('additive SD 4.4 µg/mL') >= 0 && rep.indexOf('proportional CV 13.6%') >= 0,
    'residual error printed as additive SD 4.4 µg/mL and proportional CV 13.6%');
  t.ok(rep.indexOf('19.1') >= 0 && rep.indexOf('0.0185') >= 0, 'the NONMEM variances are kept for cross-checking');

  // C6 + C8 — trough row reads the dose time and whole days
  // (scoped to the trough table: the fixture's samples really are 0.1 s pre-dose)
  var trTable = rep.slice(rep.indexOf('Median trough [5–95%]'));
  trTable = trTable.slice(0, trTable.indexOf('</table>'));
  t.ok(trTable.length > 0 && trTable.indexOf('08:59') < 0 && trTable.indexOf('09:00') > 0,
    'trough rows print the 09:00 dose time, not 08:59');
  t.ok(/<td>14<\/td>/.test(rep) && !/<td>14\.0<\/td>/.test(rep), 'the Day column prints 14, not 14.0');

  // C14 — convergence in the report
  t.ok(/Convergence/.test(rep) && /R-hat/.test(rep), 'the report has a convergence row with R-hat');
  var bad = Object.assign({}, fit, { rhat: fit.rhat.map(function () { return 1.2; }), map: Object.assign({}, fit.map, { startGap: 3 }) });
  var repBad = ECU.reportHtml(Object.assign({}, snap, { fit: bad }));
  t.ok(/not converged|did not mix|above 1\.05/.test(repBad) && /different solutions/.test(repBad),
    'a poorly mixed chain and a start-point disagreement are printed in the report');

  // ---- chart ----
  // C2 halo, C3 legend fits, C13 tooltip date
  var chart = fs.readFileSync('src/chart.js', 'utf8');
  t.ok(/paint-order="stroke"/.test(chart), 'the target label has a white halo (paint-order stroke)');
  t.ok(/cfg\.hoverDate/.test(chart) && /hoverDate:/.test(ui), 'the tooltip shows a date next to the day number');
  var lg = ui.slice(ui.indexOf("legend.push({ label: fit.planned"), ui.indexOf("color: 'rgba(180,83,9,.55)', swatch: 'line', dash: '2 3' });"));
  var labels = lg.match(/'[^']+'/g) || [];
  t.ok(labels.length && labels.every(function (s) { return s.length <= 32; }), 'projected/planned legend labels are short enough for a phone (≤ 30 characters)');

  // C5 — caption built from what is drawn
  t.ok(html.indexOf('id="chartCaption"') > 0, 'the caption under the chart has an id');
  t.ok(html.indexOf('Population = model only, no patient data yet') < 0, 'the fixed caption text is gone from index.html');
  var rc = ui.slice(ui.indexOf('function chartCaption('), ui.indexOf('\n  }\n', ui.indexOf('function chartCaption(')));
  t.ok(/fit\.hasObs/.test(rc) && /chartProjectedDoses/.test(rc) && /planned/.test(rc), 'the caption depends on individual vs population, and on the projection');

  // C7 — µ must not be uppercased
  t.ok(/\.unit\s*\{[^}]*text-transform:\s*none/.test(css), 'a .unit class switches off uppercasing');
  t.ok(ui.indexOf('Conc (<span class="unit">µg/mL</span>)') > 0, 'the measurement table header wraps µg/mL in .unit');
  t.ok(/true trough &gt; ' \+ state\.target\.value \+ ' <span class="unit">µg\/mL<\/span>/.test(ui), 'the trough table header wraps µg/mL in .unit');

  return t.summary();
}

module.exports = { run: run };
