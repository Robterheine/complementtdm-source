'use strict';
/* M2 — Bayesian engine tests
 *   1. MAP recovery: simulate patients from the prior, fit sparse observations,
 *      check the eta errors stay small (bias < tolerance).
 *   2. Laplace 90%-interval coverage across simulated patients (~90%).
 *   3. MCMC sanity: acceptance in a healthy band, posterior medians track MAP.
 *   4. M3 (below-LLOQ) handling runs and returns finite results.
 *   5. runFit end-to-end with and without observations.
 * All randomized parts use a fixed seed for determinism.
 */
const { M, B, T } = require('./util');

const STANDARD_DOSES = [];
[[0, 600], [7, 600], [14, 600], [21, 600], [28, 900], [42, 900], [56, 900]]
  .forEach(s => STANDARD_DOSES.push({ t: s[0], amt: s[1] }));
const OBS_TIMES = [27.99, 28.05, 55.99]; // trough, early peak, trough

function makeObs(rng, p, times) {
  const g = B.gaussFactory(rng);
  const sim = M.simulate(STANDARD_DOSES, times, p, { rtol: 1e-8 });
  return sim.c.map(function (pred) {
    const v = M.SIGMA.ADD + M.SIGMA.PROP * pred * pred;
    const sd = Math.sqrt(v);
    return Math.max(0, pred + sd * g());
  });
}

async function run() {
  const t = new T('test_bayes');
  const wt = 70, disease = 'PNH', omega = M.priorOmega(disease);

  // ---- 1. MAP recovery (n = 80, seeded) ----
  const rng1 = B.mulberry32(1234);
  const g1 = B.gaussFactory(rng1);
  const sCL = Math.sqrt(omega.cl), sV1 = Math.sqrt(omega.v1);
  const errs = [];
  const covs = [];
  const obsT = OBS_TIMES;
  const nRec = 80;
  for (let i = 0; i < nRec; i++) {
    const etaTrue = [sCL * g1(), sV1 * g1()];
    const pTrue = M.indivParams(wt, disease, etaTrue[0], etaTrue[1]);
    const obs = makeObs(rng1, pTrue, obsT).map(function (c, k) { return { t: obsT[k], c: c, lloq: false }; });
    const ctx = { wt: wt, disease: disease, doses: STANDARD_DOSES, obs: obs, lloq: 0, omega: omega, rtol: 1e-6 };
    const ofv = B.makeOfv(ctx);
    const map = B.mapEstimate(ofv);
    if (!map.ok || !isFinite(map.f)) { t.fail++; t.msgs.push('FAIL: MAP diverged at patient ' + i); continue; }
    errs.push([map.x[0] - etaTrue[0], map.x[1] - etaTrue[1]]);
    const lap = B.laplaceCov(ofv, map.x, omega, 0.12);
    t.ok(lap.cov && lap.cov.length === 2, 'laplaceCov returns {cov,...} shape');
    covs.push(lap.cov);
  }
  errs.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
  const eAbs = errs.map(e => Math.abs(e[0]));
  const medE = eAbs[Math.floor(eAbs.length / 2)];
  const p90 = eAbs[Math.floor(eAbs.length * 0.9)];
  const v1Abs = errs.map(e => Math.abs(e[1])).sort((a, b) => a - b);
  const medV1 = v1Abs[Math.floor(v1Abs.length / 2)];
  const p90V1 = v1Abs[Math.floor(v1Abs.length * 0.9)];
  t.info('MAP recovery (n=' + nRec + '): |etaCL| median ' + medE.toFixed(3) + ', p90 ' + p90.toFixed(3) +
    ' | |etaV1| median ' + medV1.toFixed(3) + ', p90 ' + p90V1.toFixed(3));
  t.ok(medE < 0.15, 'MAP etaCL median abs error < 0.15 (got ' + medE.toFixed(3) + ')');
  t.ok(p90 < 0.6, 'MAP etaCL p90 abs error < 0.6 (got ' + p90.toFixed(3) + ')');
  t.ok(medV1 < 0.3, 'MAP etaV1 median abs error < 0.3 (got ' + medV1.toFixed(3) + ')');

  // ---- 2. Laplace 90% interval coverage ----
  let inCL = 0, inV1 = 0;
  for (let i = 0; i < nRec; i++) {
    const z = 1.6449;
    if (Math.abs(errs[i][0]) <= z * Math.sqrt(Math.max(covs[i][0][0], 1e-6))) inCL++;
    if (Math.abs(errs[i][1]) <= z * Math.sqrt(Math.max(covs[i][1][1], 1e-6))) inV1++;
  }
  const covCL = inCL / nRec, covV1 = inV1 / nRec;
  t.info('Laplace 90%-CI coverage: etaCL ' + (covCL * 100).toFixed(0) + '%, etaV1 ' + (covV1 * 100).toFixed(0) + '%');
  t.ok(covCL >= 0.72 && covCL <= 0.99, 'etaCL coverage ~90% (got ' + covCL.toFixed(2) + ')');
  t.ok(covV1 >= 0.72 && covV1 <= 0.99, 'etaV1 coverage ~90% (got ' + covV1.toFixed(2) + ')');

  // ---- 3. MCMC sanity (n = 12, fixed seed) ----
  const rng2 = B.mulberry32(99);
  const g2 = B.gaussFactory(rng2);
  let accSum = 0, medDiff = 0;
  const nMcmc = 12;
  for (let i = 0; i < nMcmc; i++) {
    const etaTrue = [sCL * g2(), sV1 * g2()];
    const pTrue = M.indivParams(wt, disease, etaTrue[0], etaTrue[1]);
    const obs = makeObs(rng2, pTrue, obsT).map(function (c, k) { return { t: obsT[k], c: c, lloq: false }; });
    const ctx = { wt: wt, disease: disease, doses: STANDARD_DOSES, obs: obs, lloq: 0, omega: omega, rtol: 1e-6 };
    const ofv = B.makeOfv(ctx);
    const map = B.mapEstimate(ofv);
    const covR = B.laplaceCov(ofv, map.x, omega, 0.12);
    const mc = await B.runMCMC(ofv, map.x, covR.cov, { iters: 1200, maxKeep: 400 }, B.mulberry32(7 + i), null);
    accSum += mc.acceptance;
    let s0 = 0;
    mc.draws.forEach(d => s0 += d[0]);
    const postMed = s0 / Math.max(1, mc.draws.length);
    medDiff += Math.abs(postMed - map.x[0]);
  }
  const accMean = accSum / nMcmc;
  const diffMean = medDiff / nMcmc;
  t.info('MCMC: mean acceptance ' + accMean.toFixed(2) + ', mean |posterior median etaCL - MAP| ' + diffMean.toFixed(3));
  t.ok(accMean > 0.1 && accMean < 0.6, 'MCMC acceptance in healthy band (got ' + accMean.toFixed(2) + ')');
  t.ok(diffMean < 0.3, 'posterior median tracks MAP (got ' + diffMean.toFixed(3) + ')');

  // ---- 4. M3 / below-LLOQ handling ----
  const rng3 = B.mulberry32(5);
  const p3 = M.indivParams(70, 'PNH', 0.1, 0);
  const lloq = 10;
  const censObs = [
    { t: 27.99, c: 0, lloq: true },
    { t: 55.99, c: 0, lloq: true },
    { t: 28.05, c: M.simulate(STANDARD_DOSES, [28.05], p3, { rtol: 1e-8 }).c[0] * (1 + 0.1 * (rng3() - 0.5)), lloq: false }
  ];
  const ctx3 = { wt: 70, disease: 'PNH', doses: STANDARD_DOSES, obs: censObs, lloq: lloq, omega: omega, rtol: 1e-6 };
  const ofv3 = B.makeOfv(ctx3);
  const map3 = B.mapEstimate(ofv3);
  t.ok(isFinite(map3.f) && map3.ok, 'MAP finite with M3 censored observations');
  t.info('MAP with censored obs: etaCL=' + map3.x[0].toFixed(3) + ', etaV1=' + map3.x[1].toFixed(3));

  // ---- 5. runFit end-to-end ----
  // 5a. with observations
  const obsA = makeObs(B.mulberry32(31), M.indivParams(70, 'PNH', 0.2, -0.1), obsT)
    .map(function (c, k) { return { t: obsT[k], c: c, lloq: false }; });
  const fitA = await B.runFit({
    wt: 70, disease: 'PNH', doses: STANDARD_DOSES, obs: obsA, lloq: 0, target: 75, seed: 42, mcmcIters: 1200
  });
  t.ok(fitA.hasObs, 'runFit: hasObs true');
  t.ok(fitA.map && isFinite(fitA.map.etaCL), 'runFit: MAP produced');
  t.ok(fitA.draws.length > 100, 'runFit: posterior draws > 100 (got ' + fitA.draws.length + ')');
  t.ok(fitA.troughs.length >= 4, 'runFit: troughs computed (got ' + fitA.troughs.length + ')');
  const pt = fitA.troughs[fitA.troughs.length - 1];
  t.ok(pt.pTarget >= 0 && pt.pTarget <= 1, 'runFit: pTarget in [0,1]');
  t.ok(fitA.band.med.length === fitA.grid.length, 'runFit: predictive band aligned to grid');
  t.info('runFit w/ obs: CL med ' + fitA.clQ.med.toFixed(3) + ' [' + fitA.clQ.p5.toFixed(3) + '-' + fitA.clQ.p95.toFixed(3) + ']' +
    ', acceptance ' + fitA.acceptance.toFixed(2) + ', runtime ' + Math.round(fitA.runtimeMs) + ' ms');

  // 5b. no observations → prior-only forecast
  const fitB = await B.runFit({ wt: 70, disease: 'PNH', doses: STANDARD_DOSES, obs: [], target: 75, seed: 42 });
  t.ok(!fitB.hasObs && fitB.map === null, 'runFit: no obs → prior forecast, no MAP');
  t.ok(fitB.draws.length > 0 && fitB.priorBand.med.length === fitB.grid.length, 'runFit: prior predictive present');

  // 5c. aHUS uses the folded IOV prior (wider)
  const fitC = await B.runFit({ wt: 70, disease: 'aHUS', doses: STANDARD_DOSES, obs: [], target: 75, seed: 42 });
  t.close(fitC.omega.cl, 0.1546 + 0.112, 1e-9, 'aHUS omega.cl = IIV + IOV folded');

  return t.summary();
}

module.exports = { run: run };
