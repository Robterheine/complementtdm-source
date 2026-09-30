'use strict';
/* v0.22.0 — the population prediction band is no longer shown once an
 * individual fit exists.
 *
 * Before this release, renderChart() drew BOTH bands whenever fit.hasObs was
 * true: the population 5-95% band underneath, the narrower individual band on
 * top (v0.15.0's z-order fix). Direct author feedback: once a fit has used
 * this patient's own measured concentrations, the population range is no
 * longer the relevant uncertainty for that patient and should not be shown
 * alongside the individual one — only the individual band belongs on screen.
 * The population band remains exactly as before when NO concentration data
 * have been added (fit.hasObs === false): that is a pure population forecast
 * and the population band is the only thing there is to show.
 *
 * fit.hasObs (src/bayes.js) is `obsFit.length > 0` — true precisely when an
 * individual fit was actually performed on at least one fitted observation —
 * so it is the correct, already-existing gate; no new state was needed.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.22.0 population band hidden once an individual fit exists');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  // ======================= 1. source-level pin ============================
  function bodyOf(name) {
    var start = ui.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = ui.indexOf('\n  }', start);
    return end < 0 ? ui.slice(start) : ui.slice(start, end + 4);
  }
  var rc = bodyOf('renderChart');
  t.ok(rc.length > 0, 'renderChart() found in src/ui.js');

  var ifStart = rc.indexOf('if (fit.hasObs) {');
  var elseStart = rc.indexOf('} else {', ifStart);
  t.ok(ifStart >= 0 && elseStart > ifStart, 'renderChart branches on fit.hasObs');
  var hasObsBranch = rc.slice(ifStart, elseStart);
  // the else branch ends at the next top-level statement following it
  // (rows.push({ label: 'Observed' ...), shared by both branches
  var afterElse = rc.indexOf("rows.push({ label: 'Observed'", elseStart);
  t.ok(afterElse > elseStart, 'found the statement shared by both branches, to bound the else branch');
  var noObsBranch = rc.slice(elseStart, afterElse);

  // the population band (pm5/pm95) must not be pushed at all when hasObs
  t.ok(hasObsBranch.indexOf('pm5') < 0 && hasObsBranch.indexOf('pm95') < 0,
    'when an individual fit exists, the population band (pm5/pm95) is not referenced at all');
  t.ok(hasObsBranch.indexOf("legend.push({ label: 'Population prediction") < 0,
    'and no "Population prediction" legend entry is added');
  // the individual band must still be there
  t.ok(hasObsBranch.indexOf('Individual prediction') >= 0,
    'the individual band and its legend entry are still drawn when hasObs');
  t.ok(hasObsBranch.indexOf("bands.push({ x: grid, lo: p5, hi: p95") >= 0,
    'the individual 5-95% band is still pushed');

  // the no-data branch is UNCHANGED: population band is the only thing shown
  t.ok(noObsBranch.indexOf('pm5') >= 0 && noObsBranch.indexOf('pm95') >= 0,
    'with no measured concentrations, the population band is still drawn');
  t.ok(noObsBranch.indexOf("legend.push({ label: 'Population prediction") >= 0,
    'and still labelled "Population prediction" — the only thing there is to show');
  t.ok(noObsBranch.indexOf('Individual prediction') < 0,
    'the no-data branch never mentions an individual prediction (there is none)');

  // ======================= 2. axis scaling follows the same rule ==========
  // once the population band is not drawn, it must not silently still widen
  // the y-axis it no longer appears on
  var preBranch = rc.slice(0, ifStart);
  t.ok(/if\s*\(!fit\.hasObs\)\s*pm95\.forEach\(consider\)/.test(preBranch),
    'the y-axis max only folds in the population band when it is actually drawn');
  t.ok(/if\s*\(!fit\.hasObs\)\s*pm5\.forEach\(considerLo\)/.test(preBranch),
    'the log-axis floor only folds in the population band when it is actually drawn');
  t.ok(/p95\.forEach\(consider\);(?!\s*pm95)/.test(preBranch),
    'the individual band unconditionally sets the axis max, regardless of hasObs');

  // ======================= 3. end-to-end: engine bands vs what is drawn ===
  /* This does not touch the DOM (ui.js requires one) — it drives the same
   * engine output renderChart consumes and checks that the individual band
   * (chartBand) differs from the population band (chartPriorBand) once a fit
   * has used real data, so "only individual is shown" is not vacuous — there
   * is genuinely different information being withheld from the screen. */
  M.select('eculizumab');
  var doses = [];
  for (var k = 0; k < 4; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });

  var fitNoObs = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [], lloq: 0, target: 75, seed: 3
  });
  t.eq(fitNoObs.hasObs, false, 'no observations -> hasObs false (population-only forecast)');

  var fitObs = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [{ t: 41.9, c: 55, lloq: false }], lloq: 0, target: 75, seed: 3
  });
  t.eq(fitObs.hasObs, true, 'a fitted observation -> hasObs true (individual fit performed)');
  t.ok(fitObs.chartBand && fitObs.chartPriorBand, 'a fit with obs still carries both bands internally');
  t.ok(fitObs.chartBand.med.some(function (v, i) { return Math.abs(v - fitObs.chartPriorBand.med[i]) > 1e-6; }),
    'the individual and population medians genuinely differ once a fit used real data — ' +
    'hiding the population band is hiding real (different) information, not a no-op');

  return t.summary();
}

module.exports = { run: run };
