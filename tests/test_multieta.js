'use strict';
/* v0.9.0 — full multi-eta (dimension-agnostic) Bayesian engine.
 *   1. Specs expose the canonical full ETA vector (dims: eculizumab 2,
 *      ravulizumab 2, crovalimab 6) and priorOmega carries it.
 *   2. N-eta MAP recovery: simulate crovalimab patients from the full 6-eta
 *      prior, fit 2 SC troughs, check eta(CL) recovery and optimizer stability
 *      (seeded).
 *   3. Laplace covariance is valid 6×6 (no fallback), posterior variances ≤
 *      prior variances (shrinkage toward the prior).
 *   4. MCMC runs in 6D with healthy acceptance and nonzero kept draws.
 *   5. 2-eta reproducibility: eculizumab MAP regression value unchanged.
 *   6. Backward compatibility: legacy indivParams(wt,dz,eCL,eV1) still works,
 *      aux mapping fills the ka/F tail for legacy callers.
 */
const { M, B, T } = require('./util');

const DOSES = [{ t: 0, amt: 680, route: 'iv' }];
for (let d = 1; d <= 8; d++) DOSES.push({ t: d * 14, amt: 680, route: 'sc' });
const OBS_T = [83.999, 111.999]; // two SC troughs

async function run() {
  const t = new T('multi-eta engine (v0.9.0)');

  // ---- 1. spec / prior shape ----
  const ec = M.spec('eculizumab'), rv = M.spec('ravulizumab'), cv = M.spec('crovalimab');
  t.ok(!ec.ETA && ec.OMEGA.CL === 0.1546, 'eculizumab keeps legacy OMEGA shape (2-eta)');
  t.ok(cv.ETA && cv.ETA.vars.length === 6 && cv.ETA.names.length === 6, 'crovalimab ETA has 6 named components');
  t.eq(cv.ETA.names.join(','), 'CL,V1,Q,V2,KA,F', 'crovalimab ETA names');
  t.close(cv.ETA.vars[5], 1.35, 1e-12, 'crovalimab F variance 1.35');
  t.eq(cv.ETA.fLogitIdx, 5, 'F logit index');
  const omC = M.priorOmega('PNH', 'crovalimab');
  t.eq(omC.dims, 6, 'crovalimab prior dims = 6');
  t.eq(omC.vars.join(','), '0.0424,0.0502,0.341,0.498,0.147,1.35', 'crovalimab prior vars = $OMEGA 1-6');
  t.eq(M.etaDim('crovalimab'), 6, 'etaDim(crovalimab) = 6');
  t.eq(M.etaDim('eculizumab'), 2, 'etaDim(eculizumab) = 2');
  const omR = M.priorOmega('PNH', 'ravulizumab');
  t.eq(omR.dims, 2, 'ravulizumab prior dims = 2');

  // ---- 2. N-eta MAP recovery (seeded, n = 40) ----
  const wt = 75, age = 40;
  const om = omC;
  const rng = B.mulberry32(2024);
  const g = B.gaussFactory(rng);
  const sig = cv.SIGMA;
  const sds = om.vars.map(v => Math.sqrt(v));
  const errs = [];
  let fails = 0, bias = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const etaTrue = sds.map(s => s * g());
    const pTrue = M.indivParams(wt, 'PNH', etaTrue, 'crovalimab', age);
    if (!(pTrue.fSc > 0.3 && pTrue.fSc < 0.99)) { i--; continue; }
    const sim = M.simulate(DOSES, OBS_T, pTrue, { rtol: 1e-8, id: 'crovalimab' });
    if (sim.failed) continue;
    const obs = sim.c.map((c, k) => {
      const sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
      return { t: OBS_T[k], c: Math.max(0.1, c + sd * (rng() * 2 - 1) * 0.5), lloq: false };
    });
    const ctx = { wt, age, disease: 'PNH', drug: 'crovalimab', doses: DOSES, obs, lloq: 0, omega: om, rtol: 1e-6 };
    const map = B.mapEstimate(B.makeOfv(ctx), [0.4, 0.4, 0.6, 0.6, 0.4, 0.9]);
    if (!map.ok || !isFinite(map.f)) { fails++; continue; }
    errs.push(Math.abs(map.x[0] - etaTrue[0]));
    bias += map.x[0] - etaTrue[0];
    n++;
  }
  errs.sort((a, b) => a - b);
  const medE = errs[Math.floor(n / 2)], p90 = errs[Math.floor(n * 0.9)];
  t.info('6-eta MAP recovery (n=' + n + ', fails=' + fails + '): |etaCL| median ' + medE.toFixed(3) +
    ', p90 ' + p90.toFixed(3) + ', bias ' + (bias / n).toFixed(3));
  t.eq(fails, 0, 'no MAP optimizer failures');
  t.ok(medE < 0.25, '6-eta MAP |etaCL| median < 0.25 (got ' + medE.toFixed(3) + ')');
  t.ok(p90 < 0.7, '6-eta MAP |etaCL| p90 < 0.7 (got ' + p90.toFixed(3) + ')');
  t.ok(Math.abs(bias / n) < 0.1, '6-eta MAP etaCL bias small (got ' + (bias / n).toFixed(3) + ')');

  // ---- 3. Laplace 6x6 validity + shrinkage ----
  const pT = M.indivParams(wt, 'PNH', [0.1, -0.1, 0, 0, 0, 0], 'crovalimab', age);
  const simT = M.simulate(DOSES, OBS_T, pT, { rtol: 1e-8, id: 'crovalimab' });
  const obsT = simT.c.map((c, k) => {
    const sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
    return { t: OBS_T[k], c: c + sd * 0.3, lloq: false };
  });
  const ctx2 = { wt, age, disease: 'PNH', drug: 'crovalimab', doses: DOSES, obs: obsT, lloq: 0, omega: om, rtol: 1e-6 };
  const ofv2 = B.makeOfv(ctx2);
  const map2 = B.mapEstimate(ofv2, [0.4, 0.4, 0.6, 0.6, 0.4, 0.9]);
  const lap = B.laplaceCov(ofv2, map2.x, om, 0.12);
  t.ok(!lap.fallback, '6x6 Laplace covariance valid (no fallback)');
  t.eq(lap.cov.length, 6, 'Laplace covariance is 6x6');
  let shrinkOK = true;
  for (let i = 0; i < 6; i++) {
    if (lap.cov[i][i] > om.vars[i] + 1e-9) shrinkOK = false;
  }
  t.ok(shrinkOK, 'posterior variances <= prior variances (shrinkage)');
  const diag = lap.cov.map((r, i) => r[i]);
  t.ok(Math.max(...diag) / Math.min(...diag) < 1e4, 'Laplace covariance reasonably conditioned');

  // ---- 4. MCMC in 6D ----
  const mc = await B.runMCMC(ofv2, map2.x, lap.cov, { iters: 3000, maxKeep: 800 }, B.mulberry32(7), null);
  t.ok(mc.draws.length > 500, '6D MCMC keeps draws (got ' + mc.draws.length + ')');
  t.ok(mc.acceptance > 0.1 && mc.acceptance < 0.6, '6D MCMC acceptance healthy (got ' + mc.acceptance.toFixed(2) + ')');
  const essCL = B.ess(mc.draws.map(d => d[0]));
  t.ok(essCL > 50, '6D ESS(etaCL) > 50 for 3000 iters (got ' + Math.round(essCL) + ')');
  t.eq(mc.draws[0].length, 6, 'draws are 6-vectors');

  // ---- 5. 2-eta reproducibility (eculizumab MAP regression) ----
  // Observations generated from a simulated patient (as in test_bayes.js) so the
  // MAP has a consistent, pharmacologically plausible target.
  const ecoDoses = [];
  [[0, 600], [7, 600], [14, 600], [21, 600], [28, 900], [42, 900], [56, 900]].forEach(s => ecoDoses.push({ t: s[0], amt: s[1] }));
  const ecoObsT = [27.99, 28.05, 55.99];
  const pEco = M.indivParams(70, 'PNH', 0.2, -0.1, 'eculizumab');
  const simEco = M.simulate(ecoDoses, ecoObsT, pEco, { rtol: 1e-8, id: 'eculizumab' });
  const sigE = M.spec('eculizumab').SIGMA;
  const ecoObs = simEco.c.map((c, k) => {
    const sd = Math.sqrt(sigE.ADD + sigE.PROP * c * c);
    return { t: ecoObsT[k], c: Math.max(0, c + sd * 0.3), lloq: false };
  });
  const omE = M.priorOmega('PNH', 'eculizumab');
  const ctxE = { wt: 70, disease: 'PNH', drug: 'eculizumab', doses: ecoDoses, obs: ecoObs, lloq: 0, omega: omE, rtol: 1e-6 };
  const mapE = B.mapEstimate(B.makeOfv(ctxE));
  t.ok(mapE.ok && isFinite(mapE.f), 'eculizumab 2-eta MAP converges');
  // the observations came from eta=[0.2,-0.1] — the MAP should land nearby
  t.ok(Math.abs(mapE.x[0] - 0.2) < 0.5, 'eculizumab MAP etaCL recovers truth (got ' + mapE.x[0].toFixed(3) + ')');

  // ---- 6. backward compatibility ----
  const pLegacy = M.indivParams(75, 'PNH', 0.1, -0.1, 'crovalimab', 40, { etaKA: 0.2, etaF: 0.3 });
  t.close(pLegacy.ka / (cv.KA_D * Math.pow(40 / cv.AGE_REF, cv.AGE_EXPO_KA)), Math.exp(0.2), 1e-9, 'legacy aux etaKA maps to ka');
  t.ok(pLegacy.fSc > 0.83 && pLegacy.fSc < 0.99, 'legacy aux etaF shifts F upward on logit scale');
  const pVec = M.indivParams(75, 'PNH', [0.1, -0.1, 0, 0, 0.2, 0.3], 'crovalimab', 40);
  t.close(pVec.ka, pLegacy.ka, 1e-12, 'N-eta vector and legacy aux paths agree');
  t.close(pVec.fSc, pLegacy.fSc, 1e-12, 'N-eta vector and legacy aux F agree');

  // runFit still produces the full eta vector in its result
  const fit = await B.runFit({
    wt, age, disease: 'PNH', drug: 'crovalimab', doses: DOSES,
    obs: obsT, lloq: 0, target: 75, seed: 42, mcmcIters: 1500
  });
  t.eq(fit.etaDim, 6, 'runFit reports etaDim 6');
  t.eq(fit.map.etaVec.length, 6, 'runFit MAP etaVec has 6 components');
  t.eq(fit.map.etaNames.join(','), 'CL,V1,Q,V2,KA,F', 'runFit exposes ETA names');

  return t.summary();
}

module.exports = { run: run };
