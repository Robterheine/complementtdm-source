/* Multi-drug registry tests.
 * 1. Ravulizumab spec: control-stream (hour-based) values converted exactly to
 *    the app's per-day time base; structural flags (no MM term, no IOV,
 *    proportional-only residual, 2.5-h infusion, allometric exponents).
 * 2. Correlated IIV (ravulizumab $OMEGA BLOCK(2)) respected by prior sampling.
 * 3. Ravulizumab steady state (q8w maintenance) reached and plausible.
 * 4. MAP recovery with simulated ravulizumab data (drug-aware runFit).
 * 5. Explicit spec argument overrides the selected drug (deterministic calls).
 * Always restores the default drug (eculizumab) afterwards. */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('multi-drug registry');

  // ---- 1. spec conversion + structural flags ----
  M.select('ravulizumab');
  var r = M.drug();
  t.close(r.THETA.CL, 0.00342 * 24, 1e-12, 'ravulizumab CL (L/day) = control-stream L/h × 24');
  t.close(r.THETA.Q, 0.0162 * 24, 1e-12, 'ravulizumab Q (L/day) = control-stream L/h × 24');
  t.close(r.THETA.V1, 3.43, 1e-12, 'ravulizumab V1 (L) unchanged');
  t.close(r.INFUSION_D, 2.5 / 24, 1e-12, 'ravulizumab infusion = 2.5 h in days');
  t.eq(r.EXPO.CLQ, 0.833, 'ravulizumab allometric exponent CL/Q = 0.833');
  t.eq(r.EXPO.V, 0.62, 'ravulizumab allometric exponent V = 0.62');
  t.eq(r.THETA.VMAX, 0, 'ravulizumab: no Michaelis–Menten term');
  t.ok(r.SIGMA.ADD === 0 && Math.abs(r.SIGMA.PROP - 0.0239) < 1e-12, 'ravulizumab: proportional-only residual (2.39e-2)');
  t.close(r.OMEGA.CL, 0.0569, 1e-12, 'ravulizumab omega CL');
  t.close(r.OMEGA.V1, 0.0264, 1e-12, 'ravulizumab omega V1');
  t.close(r.OMEGA.COV, 0.0161, 1e-12, 'ravulizumab omega covariance (BLOCK(2))');
  var omP = M.priorOmega('PNH', 'ravulizumab'), omA = M.priorOmega('aHUS', 'ravulizumab');
  t.eq(omP.cl, omA.cl, 'ravulizumab: no IOV — identical prior for PNH and aHUS');
  t.eq(omA.cov, 0.0161, 'ravulizumab prior carries the covariance');
  t.eq(r.diseaseCovariate, false, 'ravulizumab: disease is not a covariate (UI hides the disease selector)');
  t.eq(r.targetDefault, 150, 'ravulizumab trough-target default = 150 µg/mL');
  t.ok(/150/.test(r.targetHint), 'ravulizumab target hint mentions the 150 µg/mL default');
  t.eq(M.drugs.eculizumab.diseaseCovariate, true, 'eculizumab: disease remains a covariate (IOV in aHUS)');
  t.eq(M.drugs.eculizumab.targetDefault, 75, 'eculizumab trough-target default = 75 µg/mL');

  // ---- 1b. FDA-review provenance links (shown in the About dialog) ----
  t.eq(M.drugs.ravulizumab.reviewUrl,
    'https://www.accessdata.fda.gov/drugsatfda_docs/nda/2018/761108Orig1s000TOC.html',
    'ravulizumab review reference URL (NDA 761108)');
  t.ok(/simplified version from FDA review documents/.test(M.drugs.ravulizumab.reviewRef || ''),
    'ravulizumab reviewRef states it is a simplified version');
  t.eq(M.drugs.crovalimab.reviewUrl,
    'https://www.accessdata.fda.gov/drugsatfda_docs/nda/2024/761388Orig1s000TOC.html',
    'crovalimab review reference URL (NDA 761388)');
  t.ok(/FDA review documents/.test(M.drugs.crovalimab.reviewRef || ''),
    'crovalimab reviewRef present');
  t.ok(!M.drugs.eculizumab.reviewUrl,
    'eculizumab carries no FDA-review URL (it is cited from the journal article)');

  // eculizumab reference unchanged by the refactor
  M.select('eculizumab');
  var e = M.drug();
  t.close(e.THETA.CL, 0.1626, 1e-12, 'eculizumab CL untouched');
  t.ok(M.priorOmega('aHUS').cl > M.priorOmega('PNH').cl, 'eculizumab aHUS IOV folding intact');
  t.eq(M.priorOmega('PNH').cov, 0, 'eculizumab prior covariance zero');

  // ---- 2. correlated prior sampling reproduces the omega block ----
  var om = M.priorOmega('PNH', 'ravulizumab');
  var n = 60000;
  var draws = B.priorDraws(n, om, B.mulberry32(4242));
  var m0 = 0, m1 = 0;
  draws.forEach(function (d) { m0 += d[0]; m1 += d[1]; });
  m0 /= n; m1 /= n;
  var v0 = 0, v1 = 0, cv = 0;
  draws.forEach(function (d) {
    v0 += (d[0] - m0) * (d[0] - m0); v1 += (d[1] - m1) * (d[1] - m1); cv += (d[0] - m0) * (d[1] - m1);
  });
  v0 /= n - 1; v1 /= n - 1; cv /= n - 1;
  t.close(v0, om.cl, 0.1, 'prior draws: var(etaCL) ~ omega CL');
  t.close(v1, om.v1, 0.1, 'prior draws: var(etaV1) ~ omega V1');
  t.close(cv, om.cov, 0.15, 'prior draws: cov(etaCL, etaV1) ~ omega block covariance');

  // ---- 3. ravulizumab steady state, q8w maintenance ----
  M.select('ravulizumab');
  var pTyp = M.indivParams(80, 'PNH', 0, 0);
  var I8 = 56, D8 = 3000, K = 20, doses = [], trTimes = [];
  for (var k = 0; k < K; k++) doses.push({ t: k * I8, amt: D8 });
  trTimes.push((K - 2) * I8 - 1e-6, (K - 1) * I8 - 1e-6);
  var sim = M.simulate(doses, trTimes, pTyp, { rtol: 1e-8 });
  t.ok(!sim.failed && sim.c.every(function (v) { return isFinite(v) && v > 0; }), 'ravulizumab q8w simulation finite');
  t.close(sim.c[0], sim.c[1], 0.005, 'ravulizumab q8w troughs at steady state (80 kg, 3000 mg)');
  t.ok(sim.c[0] > 100 && sim.c[0] < 900, 'ravulizumab steady-state trough plausible (' + sim.c[0].toFixed(0) + ' µg/mL)');
  // infusion peak sits at/after the 2.5-h infusion end
  var pk = M.simulate([{ t: 0, amt: 3000 }], [2.5 / 24 + 1e-4, 3 / 24], pTyp, { rtol: 1e-8 }).c;
  t.ok(pk[0] > 0 && pk[1] < pk[0] * 1.05, 'ravulizumab peak near the end of the 2.5-h infusion');

  // ---- 4. MAP recovery with simulated ravulizumab data ----
  var rng = B.mulberry32(99);
  var g = B.gaussFactory(rng);
  var etaTrue = [-0.35, 0.25];
  var pTrue = M.indivParams(80, 'aHUS', etaTrue[0], etaTrue[1]);
  var dAll = [];
  for (var kk = 0; kk < 3; kk++) dAll.push({ t: kk * I8, amt: D8 });
  var obsTimes = [I8 - 1e-6, I8 - 0.5, I8 + 2.5 / 24 + 0.02, 2 * I8 - 1e-6];
  var sTrue = M.simulate(dAll, obsTimes, pTrue, { rtol: 1e-8 }).c;
  var sig = M.drug().SIGMA;
  var obs = sTrue.map(function (c, i) {
    var sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
    return { t: obsTimes[i], c: Math.max(1e-6, c + sd * g() / Math.sqrt(3)), lloq: false };
  });
  var fit = await B.runFit({ wt: 80, disease: 'aHUS', drug: 'ravulizumab',
    doses: dAll, obs: obs, lloq: 0, target: 100, seed: 5, mcmcIters: 800 }, {});
  t.ok(fit.hasObs && isFinite(fit.map.ofv), 'ravulizumab MAP finite');
  t.ok(Math.abs(fit.map.etaCL - etaTrue[0]) < 0.55 && Math.abs(fit.map.etaV1 - etaTrue[1]) < 0.55,
    'ravulizumab MAP recovers simulated etas (got ' + fit.map.etaCL.toFixed(2) + ', ' + fit.map.etaV1.toFixed(2) + ')');
  t.ok(fit.clQ.med > 0 && fit.clQ.med < 0.2, 'ravulizumab CL posterior in a sensible range (' + fit.clQ.med.toFixed(3) + ' L/day)');

  // ---- 5. explicit spec argument wins over the selected drug ----
  M.select('eculizumab');
  var pRav = M.indivParams(70, 'PNH', 0, 0, 'ravulizumab');
  t.close(pRav.cl, 0.00342 * 24, 1e-12, 'indivParams with explicit ravulizumab id while eculizumab selected');
  var s2 = M.simulate([{ t: 0, amt: 3000 }], [3 / 24], pRav, { rtol: 1e-8, id: 'ravulizumab' });
  t.ok(isFinite(s2.c[0]) && s2.c[0] > 0, 'simulate with explicit id works under another selected drug');

  // restore default
  M.select('eculizumab');
  t.eq(M.drug().id, 'eculizumab', 'default drug restored after the suite');
  t.ok(M.listDrugs().length >= 2, 'drug list exposes eculizumab and ravulizumab');

  return t.summary();
}

module.exports = { run: run };
