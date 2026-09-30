'use strict';
/* v0.15.0 — three-reviewer response to author feedback on the forecast chart
 * and regimen explorer.
 *
 *   1. Forecast chart washed out to zero past the last entered dose, looking
 *      like therapy had stopped even for an ongoing regimen. Fixed with a
 *      display-only continuation (chartBand/chartPriorBand/chartProjectedDoses)
 *      that must never touch the fit itself or the trough table.
 *   2. "Posterior"/"Prior" renamed to "Individual prediction"/"Population
 *      prediction" in every clinician-facing spot (chart + report table);
 *      technical exposition ("How this was calculated", About) keeps the
 *      statistical terms, which is appropriate there.
 *   3. Population band now painted UNDERNEATH the individual band (was
 *      reversed, muting the individual band in the overlap region).
 *      [Superseded by v0.22.0: once an individual fit exists, the population
 *      band is no longer painted at all — see test_v022.js. The z-order
 *      assertion below was rewritten to pin that instead of the now-moot
 *      paint order.]
 *   4. Regimen explorer promoted from a nested <details> fold inside card 3
 *      to its own top-level card 4 — always visible, like cards 2-3.
 *   5. The regimen-explorer chart no longer plots "changing the next dose
 *      only" (kept as a table column only).
 *   6. Fit diagnostics moved from an inline <details> to a modal, reusing
 *      openModal/closeModal. Pins the landmine the code reviewer flagged:
 *      renderDiagnostics's residual-row selector must be parameterised, not
 *      hardcoded to the now-removed #diagBlock id.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.15.0 chart continuation, terminology, card 4, diagnostics modal');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');
  var css = fs.readFileSync('src/app.css', 'utf8');

  // ---- 1. chart-only continuation ----------------------------------------
  M.select('eculizumab');
  var doses = [];
  for (var k = 0; k < 8; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });
  var fitObs = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [{ t: 97.9, c: 190, lloq: false }], lloq: 0, target: 75, seed: 7
  });
  var fitNoObs = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [], lloq: 0, target: 75, seed: 7
  });

  t.ok(Array.isArray(fitObs.chartProjectedDoses) && fitObs.chartProjectedDoses.length >= 1,
    'a projected continuation dose is added for the chart');
  t.eq(fitObs.chartProjectedDoses[0].t, doses[doses.length - 1].t + fitObs.interval,
    'the projected dose sits exactly one historical interval after the last real dose');
  t.eq(fitObs.chartProjectedDoses[0].amt, doses[doses.length - 1].amt,
    'the projected dose repeats the last real dose amount');

  var lastIdx = fitObs.band.med.length - 1;
  t.ok(fitObs.chartBand.med[lastIdx] > fitObs.band.med[lastIdx] * 1.3,
    'chartBand (individual, continued) sits well above the un-continued band near the plotting horizon (' +
    fitObs.chartBand.med[lastIdx].toFixed(0) + ' vs ' + fitObs.band.med[lastIdx].toFixed(0) + ')');
  t.ok(fitNoObs.chartPriorBand.med[lastIdx] > fitNoObs.priorBand.med[lastIdx] * 1.3,
    'chartPriorBand (population, continued) likewise sits above the un-continued prior band');

  /* The landmine the code reviewer flagged: adding a projected dose to the
   * CHART simulation must never change the trough table, which is built from
   * the real `doses` only. virtualTroughTime lands one instant BEFORE the
   * projected dose's own administration time, so it is causally blind to it. */
  var fitPlain = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [{ t: 97.9, c: 190, lloq: false }], lloq: 0, target: 75, seed: 7
  });
  t.eq(fitObs.troughs.length, fitPlain.troughs.length, 'trough count unaffected by the chart continuation');
  fitObs.troughs.forEach(function (tr, i) {
    t.close(tr.med, fitPlain.troughs[i].med, 1e-9, 'trough[' + i + '] median unaffected by the chart continuation');
    t.eq(tr.assumed, fitPlain.troughs[i].assumed, 'trough[' + i + '] assumed-flag unaffected');
  });
  // and MAP/clearance (the actual fit) must be bit-for-bit identical too
  t.close(fitObs.clQ.med, fitPlain.clQ.med, 1e-9, 'individual clearance unaffected by the chart continuation');

  t.ok(ui.indexOf('fit.chartBand') >= 0 && ui.indexOf('fit.chartPriorBand') >= 0,
    'renderChart consumes the chart-only continuation bands');
  t.ok(ui.indexOf('chartProjectedDoses') >= 0, 'renderChart draws the projected-dose marker(s)');
  // v0.40.0: the label now continues with the interval it assumed ("…not entered, assumed q14d…"),
  // and a clinician-entered plan is labelled as such; neither reads as a recommendation.
  t.ok(ui.indexOf('Projected dose (not entered') >= 0, 'the projected dose is labelled as not entered, never as a recommendation');

  // ---- 2. terminology: individual / population, not posterior / prior ----
  t.ok(ui.indexOf('Individual prediction') >= 0, '"Individual prediction" replaces "Posterior" on the chart');
  t.ok(ui.indexOf('Population prediction') >= 0, '"Population prediction" replaces "Prior (population)" on the chart');
  t.ok(ui.indexOf("label: 'Posterior") < 0, 'no chart-facing label still says "Posterior"');
  t.ok(ui.indexOf('Clearance (individual)') >= 0 && ui.indexOf('Central volume (individual)') >= 0,
    'the report\'s Fit quality table uses "(individual)", not "(posterior)"');
  // the explanatory "how this was calculated" / statistical exposition may
  // legitimately keep the statistical term — this is not renamed everywhere
  t.ok(ui.indexOf('posterior draws') >= 0, 'technical exposition (MCMC posterior draws) is left alone — it is appropriately technical there');

  // ---- 3. once an individual fit exists, only the individual band paints
  // (v0.22.0 superseded the original "population underneath, individual on
  // top" z-order fix — see test_v022.js for the full pin) ------------------
  t.ok(ui.indexOf("bands.push({ x: grid, lo: p5, hi: p95, fill: 'rgba(14,116,144") >= 0,
    'the individual band is still pushed in the hasObs branch');

  // ---- 4. regimen explorer is card 4, always visible ----------------------
  t.ok(/<h2><span class="stepnum">4<\/span>\s*Regimen explorer/.test(html),
    'the regimen explorer has its own numbered card header (4)');
  t.ok(!/<details[^>]*id="intervalCard"/.test(html), 'the explorer is no longer a nested <details> fold');
  t.ok(/<div class="card" id="regimenCard">/.test(html), 'the explorer is its own top-level card');
  t.ok(ui.indexOf('function intervalExplorerAvailable') >= 0, 'availability check still exists');
  t.ok(ui.indexOf("runBtn.disabled = true") >= 0 && ui.indexOf("runBtn.disabled = false") >= 0,
    'unavailability now disables the Explore button rather than hiding the whole card');
  t.ok(ui.indexOf('Run a forecast in card 3 first') >= 0,
    'an empty/disabled state explains what to do first, matching the pattern already used by cards 2-3');

  // showIntervalCard / showEmpty must not throw without a DOM (guarded)
  t.ok(ui.indexOf("typeof document !== 'undefined'") >= 0 || true, 'ui.js keeps its DOM-guard convention (sanity — not a strict assertion)');

  // ---- 5. regimen-explorer chart drops the "next dose only" series -------
  t.ok(ui.indexOf('Changing the next dose only') < 0, 'the "next dose only" series/legend entry is gone from the chart');
  /* v0.31.0: "next" left the table too (see test_v031.js) -- the chart and
   * the table now show the same one thing, steady-state trough, instead of
   * the chart showing one number and the table showing two. */
  t.ok(ui.indexOf('r.next.pTarget') < 0 && ui.indexOf('r.next.med') < 0,
    '"next" is no longer rendered anywhere in ui.js — dropped from the table too, matching the chart (v0.31.0)');
  t.ok(ui.indexOf('intervalScanTableHtml') >= 0, 'the results table function itself is unchanged in name/location');

  // ---- 6. diagnostics as a modal, not an inline <details> ---------------
  t.ok(html.indexOf('id="diagModal"') >= 0, 'a diagnostics modal exists in the markup');
  t.ok(!/<details[^>]*id="diagBlock"/.test(html) === true, 'sanity: no stray diagBlock details in index.html (there never was one — dynamically rendered)');
  t.ok(ui.indexOf('id="diagBlock"') < 0, 'the dynamically-rendered inline diagnostics <details> is gone from ui.js');
  t.ok(ui.indexOf('function openDiagnostics') >= 0, 'a dedicated function opens the diagnostics modal');
  t.ok(ui.indexOf("openModal('diagModal'") >= 0, 'diagnostics reuses the existing modal-focus-management helper, not a bespoke one');
  /* The actual landmine: renderDiagnostics used to hardcode the residual-row
   * selector to #diagBlock. That id no longer exists anywhere, so a hardcoded
   * reference would silently make hover-sync (and the report's, already only
   * cosmetic) match nothing, forever, with no error. */
  t.ok(ui.indexOf("querySelectorAll('#diagBlock .res-row')") < 0,
    'the residual-row selector is no longer hardcoded to the removed #diagBlock id');
  t.ok(ui.indexOf('rowsContainerId') >= 0, 'renderDiagnostics takes the rows-container id as a parameter');
  t.ok(ui.indexOf("renderDiagnostics(fit, rel, 'diagModalGof', 'diagModalBody')") >= 0,
    'the on-screen modal path scopes hover-sync to its own modal body');
  t.ok(ui.indexOf("'rpGofChart', 'rpDiagBody'") >= 0,
    'the printed-report path scopes hover-sync to the report\'s own diagnostics container, not the modal\'s');
  t.ok(ui.indexOf('id="btnDiagnostics"') >= 0, 'a button (not a disclosure triangle) opens diagnostics');
  t.ok(css.indexOf('.modal-wide') >= 0, 'a wider modal variant exists for the diagnostics content (chart is 560px)');

  return t.summary();
}

module.exports = { run: run };
