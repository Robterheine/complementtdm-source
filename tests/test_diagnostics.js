'use strict';
/* v0.10.0 — tests for the individual fit diagnostics module (src/diagnostics.js)
 * and the new engine exports (obsData.ipred, popTypical, posterior CL/V draws).
 *
 * Checks:
 *  1. Engine exports: ipred finite at obs times, popTypical = covariate-adjusted
 *     typical params (eta = 0), posterior draw arrays reproduce clQ/v1Q quantiles.
 *  2. gofChart: identity line spans the axis, ±2 SD band widens with
 *     concentration (proportional error), band half-width matches the error model.
 *  3. residualRows: threshold levels ok/warn/bad, censored rows flagged.
 *  4. ebeChart: median/percentile conversion, % departures vs popTypical.
 *  5. summaryHint: good/warn/bad buckets.
 *  6. End-to-end: fit a noise-free simulated patient — residuals small, GOF
 *     points on the identity line.
 */

var util = require('./util.js');
var M = util.M, B = util.B, T = util.T;

require('../src/diagnostics.js');
var D = ECU.diagnostics;

var DAY = 86400000;

async function run() {
  var t = new T('fit diagnostics (v0.10.0: GOF + EBE)');

  var now = Date.now() / DAY;
  var doses = [
    { t: now - 21, amt: 1000, route: 'iv' },
    { t: now - 7, amt: 680, route: 'sc' }
  ];

  // ---- 1. engine exports -------------------------------------------------
  var fit = await B.runFit({
    wt: 75, age: 45, disease: 'PNH', drug: 'crovalimab',
    doses: doses,
    obs: [{ t: now - 1.2, c: 60, lloq: false }, { t: now - 0.5, c: 62, lloq: false }],
    lloq: 0, target: 75, seed: 42, mcmcIters: 600
  });
  t.ok(fit.obsData.length === 2 && isFinite(fit.obsData[0].ipred) && fit.obsData[0].ipred > 0,
    'engine: ipred finite and positive at obs times');
  t.ok(fit.popTypical && isFinite(fit.popTypical.cl) && isFinite(fit.popTypical.v1),
    'engine: popTypical (covariate-adjusted) present');
  // popTypical must equal indivParams at eta = 0
  var zero = M.indivParams(75, 'PNH', [0, 0, 0, 0, 0, 0], 'crovalimab', 45);
  t.close(fit.popTypical.cl, zero.cl, 1e-9, 'engine: popTypical CL = eta0 params');
  t.close(fit.popTypical.v1, zero.v1, 1e-9, 'engine: popTypical V1 = eta0 params');
  // posterior draws must reproduce the clQ/v1Q quantiles
  var sorted = fit.clPostDraws.slice().sort(function (a, b) { return a - b; });
  function qs(a, q) { var pos = (a.length - 1) * q; var l = Math.floor(pos), h = Math.ceil(pos); return l === h ? a[l] : a[l] + (a[h] - a[l]) * (pos - l); }
  t.close(qs(sorted, 0.5), fit.clQ.med, 0.02, 'engine: clPostDraws median = clQ.med');
  t.close(qs(sorted, 0.95), fit.clQ.p95, 0.02, 'engine: clPostDraws p95 = clQ.p95');
  t.ok(fit.clPostDraws.length === fit.draws.length, 'engine: one CL draw per posterior draw');

  // ---- 2. gofChart geometry ----------------------------------------------
  var spec = M.drug();
  var cfg = D.gofChart(fit, spec);
  t.ok(cfg && cfg.series && cfg.series.length === 1, 'gofChart: identity series present');
  t.ok(cfg.series[0].x[0] === 0 && cfg.series[0].y[0] === 0, 'gofChart: identity starts at origin');
  t.ok(Math.abs(cfg.series[0].x[1] - cfg.series[0].y[1]) < 1e-9, 'gofChart: identity is 45 degrees');
  t.ok(cfg.bands.length === 1 && cfg.bands[0].x.length === 21, 'gofChart: 2 SD band sampled');
  // band half-width at the top of the range must exceed that near zero
  // (proportional error dominates at high concentrations)
  var n = cfg.bands[0].x.length;
  var hwTop = cfg.bands[0].hi[n - 1] - cfg.bands[0].x[n - 1];
  var hwLow = cfg.bands[0].hi[2] - cfg.bands[0].x[2];
  t.ok(hwTop > hwLow, 'gofChart: band widens with concentration (proportional error)');
  var vTop = cfg.bands[0].x[n - 1];
  var sdTop = Math.sqrt(spec.SIGMA.ADD + spec.SIGMA.PROP * vTop * vTop);
  t.close(hwTop, 2 * sdTop, 1e-6, 'gofChart: band half-width = 2*sqrt(ADD+PROP*v^2)');
  t.ok(cfg.points.length === 2, 'gofChart: one point per quantified sample');

  // ---- 3. residualRows thresholds ----------------------------------------
  var rows = D.residualRows(fit);
  t.ok(rows.length === 2 && isFinite(rows[0].rel), 'residuals: computed for quantified samples');
  // synthetic threshold check
  var fakeFit = { obsData: [
    { t: 0, c: 100, ipred: 100, lloq: false },   // 0%   -> ok
    { t: 1, c: 140, ipred: 100, lloq: false },   // +40% -> warn
    { t: 2, c: 200, ipred: 100, lloq: false },   // +100% -> bad
    { t: 3, c: 70, ipred: 100, lloq: false },    // -30% -> ok boundary
    { t: 4, c: null, ipred: NaN, lloq: true }    // censored
  ] };
  var frows = D.residualRows(fakeFit);
  t.ok(frows[0].level === 'ok' && frows[1].level === 'warn' && frows[2].level === 'bad',
    'residuals: ok/warn/bad thresholds at 30%/60%');
  t.ok(frows[3].level === 'ok', 'residuals: -30% sits on the ok boundary');
  t.ok(frows[4].lloq && !isFinite(frows[4].rel), 'residuals: censored row has no numeric residual');

  // ---- 4. ebeChart --------------------------------------------------------
  var fc = D.ebeChart(fit, spec);
  t.ok(fc && fc.rows.length === 2 && fc.rows[0].name.indexOf('CL') === 0, 'ebeChart: CL and V1 rows');
  var clRow = fc.rows[0];
  t.close(clRow.medPct, (fit.clQ.med - fit.popTypical.cl) / fit.popTypical.cl * 100, 0.05,
    'ebeChart: CL median % departure vs popTypical');
  t.ok(fc.lim >= 40, 'ebeChart: axis limit at least ±40%');
  // posterior median from chart rows must equal clQ medians
  t.close(clRow.st.med, fit.clQ.med, 0.02, 'ebeChart: chart median = clQ.med');

  // ---- 5. summaryHint ------------------------------------------------------
  t.eq(D.summaryHint({ obsData: [{ t: 0, c: 100, ipred: 105, lloq: false }] }), 'good',
    'summaryHint: small residuals -> good');
  t.ok(D.summaryHint({ obsData: [{ t: 0, c: 100, ipred: 60, lloq: false }] }).indexOf('check') === 0,
    'summaryHint: 40% residual -> check message');
  t.ok(D.summaryHint({ obsData: [{ t: 0, c: 100, ipred: 30, lloq: false }] }).indexOf('check') === 0,
    'summaryHint: 70% residual -> check message');
  t.eq(D.summaryHint({ obsData: [{ t: 0, c: null, ipred: NaN, lloq: true }] }), null,
    'summaryHint: only censored samples -> null');

  // ---- 6. end-to-end noise-free recovery ----------------------------------
  // Simulate a patient with known etas (no residual error), fit, residuals ~ 0.
  var etaTrue = [0.15, -0.1, 0.05, -0.05, 0.1, 0.05];
  var pTrue = M.indivParams(75, 'PNH', etaTrue, 'crovalimab', 45);
  var obsT = [now - 1.0, now - 0.4];
  var simTrue = M.simulate(doses, obsT, pTrue, { rtol: 1e-8, id: 'crovalimab' });
  var obsNF = obsT.map(function (tt, k) { return { t: tt, c: simTrue.c[k], lloq: false }; });
  var fitNF = await B.runFit({
    wt: 75, age: 45, disease: 'PNH', drug: 'crovalimab',
    doses: doses, obs: obsNF, lloq: 0, target: 75, seed: 7, mcmcIters: 500
  });
  var rowsNF = D.residualRows(fitNF).filter(function (r) { return !r.lloq; });
  var maxRel = Math.max.apply(null, rowsNF.map(function (r) { return Math.abs(r.rel); }));
  t.ok(maxRel < 0.05, 'end-to-end: noise-free fit residuals < 5% (got ' + (maxRel * 100).toFixed(1) + '%)');
  var cfgNF = D.gofChart(fitNF, spec);
  t.ok(cfgNF && cfgNF.points.every(function (p) { return Math.abs(p.y - p.x) / p.x < 0.05; }),
    'end-to-end: GOF points sit on the identity line for a noise-free fit');
  t.ok(D.summaryHint(fitNF) === 'good', 'end-to-end: hint reports good for noise-free fit');

  // ---- 7. population fit (no obs): panels degrade gracefully --------------
  var fitPop = await B.runFit({
    wt: 75, disease: 'PNH', drug: 'crovalimab',
    doses: doses, obs: [], lloq: 0, target: 75, seed: 3, priorDraws: 50
  });
  t.eq(D.gofChart(fitPop, spec), null, 'population fit: gofChart null');
  t.eq(D.ebeChart(fitPop, spec), null, 'population fit: ebeChart null');
  t.eq(D.summaryHint(fitPop), null, 'population fit: hint null');

  return t.summary();
}

module.exports = { run: run };
