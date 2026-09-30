/* Regression tests for the v0.6.1 audit fixes:
 * A1. A below-LLOQ observation with a blank (null/NaN) concentration value must
 *     be KEPT in the fit (M3 uses only the censoring flag), and the fit must
 *     individualize instead of silently falling back to the population prior.
 * A2. Chart hover mapping honours a non-zero xMin (unit-level check of the
 *     coordinate formula change; the formula itself lives in chart.js).
 * B1. Spec-driven field conventions: obsValMax / targetRange / wtTooltip /
 *     diseaseNotes / assumptions present and per-drug where it matters.
 */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('audit regressions (A1/A2/B1)');

  // ---- A1: censored observation with no numeric value participates in MAP ----
  var doses = [{ t: 0, amt: 900 }, { t: 14, amt: 900 }];
  var base = { wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, lloq: 10, target: 75, seed: 42, mcmcIters: 200 };

  // Reference: the same BLQ sample WITH an arbitrary numeric value must give the
  // identical MAP (M3 likelihood does not use the value)…
  var withVal = await B.runFit(Object.assign({}, base, {
    obs: [{ t: 13.9, c: 3.0, lloq: true }]
  }), {});
  // …and with a blank value (what the UI now stores)…
  var withBlank = await B.runFit(Object.assign({}, base, {
    obs: [{ t: 13.9, c: null, lloq: true }]
  }), {});
  t.ok(withBlank.hasObs === true, 'blank-valued <LLOQ observation is kept (hasObs true)');
  t.ok(!!withBlank.map, 'fit individualizes on a blank-valued censored sample (MAP exists)');
  t.closeTo(withBlank.map.etaCL, withVal.map.etaCL, 1e-9, 'MAP identical with and without a numeric value for a BLQ sample (M3 uses only the flag)');
  t.closeTo(withBlank.map.etaV1, withVal.map.etaV1, 1e-9, 'etaV1 identical with and without a numeric value for a BLQ sample');

  // …and the result must differ from the no-observation population forecast.
  var noObs = await B.runFit(Object.assign({}, base, { obs: [] }), {});
  t.ok(noObs.map === null, 'no observations -> population prior (no MAP)');
  t.ok(Math.abs(withBlank.map.etaCL) > 1e-6, 'censored sample actually informs the MAP (etaCL shifted)');

  // quantified observations with a numeric value still work unchanged
  var quant = await B.runFit(Object.assign({}, base, {
    obs: [{ t: 13.9, c: 120, lloq: false }]
  }), {});
  t.ok(quant.hasObs && !!quant.map, 'quantified observation path unchanged');
  t.ok(Math.abs(quant.map.etaCL - withBlank.map.etaCL) > 1e-6, 'quantified vs censored sample yield different fits (as expected)');

  // NaN (legacy exports) also kept when flagged
  var nanObs = await B.runFit(Object.assign({}, base, {
    obs: [{ t: 13.9, c: NaN, lloq: true }]
  }), {});
  t.ok(nanObs.hasObs === true, 'legacy NaN-valued censored observation is also kept');

  // censored sample without an LLOQ value must fail loudly, not fit as c = 0
  var threw = false;
  try {
    await B.runFit(Object.assign({}, base, { lloq: 0, obs: [{ t: 13.9, c: null, lloq: true }] }), {});
  } catch (e) { threw = /LLOQ/.test(String(e.message)); }
  t.ok(threw, 'censored sample with lloq=0 throws a clear error (no silent c=0 fit)');

  // chart plotting: blank-valued censored samples must be excluded from obsPts
  // (replicating the renderChart filter: quantified samples only)
  var obsAll = [
    { t: 13.9, c: null, lloq: true },
    { t: 13.95, c: 120, lloq: false },
    { t: 13.7, c: 0, lloq: false }    // a true zero is plottable
  ];
  var plottable = obsAll.filter(function (o) { return o.c != null && isFinite(o.c) && o.c >= 0; });
  t.eq(plottable.length, 2, 'chart filter keeps quantified samples (incl. a true 0) and drops blank censored');
  t.ok(plottable.every(function (o) { return isFinite(o.c); }), 'no plottable point has a non-finite y');

  // ---- A2: hover coordinate mapping honours xMin ----
  // The formula under test: rel = xMin + (px - m.l)/iw * (xMax - xMin).
  // Regression guard: at the plot's left edge the reported day must be xMin,
  // not 0 (which broke steady-state mode where xMin < 0).
  function hoverRel(px, xMin, xMax) {
    var W = 960, m = { l: 62, r: 18 };
    var iw = W - m.l - m.r;
    return xMin + (px - m.l) / iw * (xMax - xMin);
  }
  t.closeTo(hoverRel(62, -28, 42), -28, 1e-9, 'hover at plot left edge reads xMin (steady-state fix)');
  t.closeTo(hoverRel(62, 0, 42), 0, 1e-9, 'hover at plot left edge reads 0 in full-schedule mode (unchanged)');
  t.closeTo(hoverRel(62 + (960 - 62 - 18) / 2, -28, 42), (-28 + 42) / 2, 1e-9, 'hover at plot centre reads the window midpoint');

  // ---- B1: spec-driven field conventions ----
  t.ok(M.spec('crovalimab').obsValMax === 10000, 'crovalimab obs field max 10000');
  t.ok(M.spec('eculizumab').obsValMax === 10000, 'eculizumab obs field max 10000');
  t.ok(M.spec('ravulizumab').obsValMax === 10000, 'ravulizumab obs field max 10000');
  ['eculizumab', 'ravulizumab', 'crovalimab'].forEach(function (id) {
    var s = M.spec(id);
    t.ok(s.targetRange && s.targetRange.min > 0 && s.targetRange.max > s.targetRange.min, id + ': targetRange defined');
    t.ok(typeof s.wtTooltip === 'string' && s.wtTooltip.length > 10, id + ': weight tooltip defined');
    if (id === 'crovalimab') {
      t.ok(s.assumptions && s.assumptions.length >= 3, 'crovalimab: assumptions documented (no-ADA, rich-sampling RUV, infusion duration, eta simplification)');
      t.ok(s.assumptions.some(function (a) { return /ADA/.test(a); }), 'crovalimab: no-ADA assumption explicitly documented');
    }
    if (id === 'eculizumab') {
      t.ok(s.diseaseNotes && s.diseaseNotes.PNH && s.diseaseNotes.aHUS, 'eculizumab: per-disease notes defined');
    }
  });

  return t.done();
}

module.exports = { name: 'audit regressions (A1/A2/B1)', run: run };
