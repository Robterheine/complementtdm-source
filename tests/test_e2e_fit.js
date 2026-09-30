'use strict';
/* v0.9.1 — end-to-end simulate-then-fit study for the full 6-eta engine.
 *
 * Design (seeded, deterministic):
 *   For each of N prior-simulated crovalimab patients (all six etas drawn from
 *   the run05 $OMEGA), generate 2 SC troughs + 1 SC peak from the true
 *   parameters with residual error, then run the complete pipeline
 *   (B.runFit: prior band → MAP → Laplace → MCMC → posterior band → troughs)
 *   exactly as the UI does, and check:
 *     1. every run completes without failure and with a valid Laplace fit;
 *     2. calibration of the 90% trough interval: the fraction of patients
 *        whose TRUE trough (noise-free, from the true parameters) falls
 *        inside the predicted 5–95% trough interval should be ≈ 90%;
 *     3. the median P(> target) of the last predicted trough is informative
 *        (not degenerate at 0 or 1 across patients);
 *     4. identifiability diagnostics are present and finite for every run.
 * Also reports eta(CL) posterior-interval coverage (~90% expected).
 */
const { M, B, T } = require('./util');

/* SCOPE OF THIS SUITE TEST (v0.13.0) — it is a SMOKE TEST, not calibration
 * evidence. At N = 24 the 95% binomial range around a true 90% coverage is
 * roughly 75–98%, so this design cannot distinguish 90% coverage from 99% and
 * must not be cited as proof that the intervals are calibrated. It exists to
 * catch a gross regression in the end-to-end pipeline quickly.
 * The real study is tools/calibration_study.mjs (N >= 300, several drugs and
 * sampling designs, production iteration counts) — run it with `npm run
 * calibration` when the engine changes. */
const N = 24;                 // patients (keeps the suite under ~2 min)
/* EMA PiaSky posology — 1000 mg IV loading, 340 mg SC weekly x4, then 680 mg
 * SC every 4 weeks. (Before v0.13.0 this study used a 3400 mg dose, which is
 * not a crovalimab dose at all.) */
const DOSES = [{ t: 0, amt: 1000, route: 'iv' }];
for (let d = 1; d <= 4; d++) DOSES.push({ t: 1 + d * 7, amt: 340, route: 'sc' });
DOSES.push({ t: 29, amt: 680, route: 'sc' });
DOSES.push({ t: 57, amt: 680, route: 'sc' });
const OBS_T = [33, 56.999, 84.999];   // SC peak (~4 d post-dose) + 2 troughs
const TARGET = 75;

async function run() {
  const t = new T('simulate-then-fit E2E (v0.9.1)');

  const cv = M.spec('crovalimab');
  const om = M.priorOmega('PNH', 'crovalimab');
  const sig = cv.SIGMA;
  const rng = B.mulberry32(777);
  const g = B.gaussFactory(rng);
  const sds = om.vars.map(v => Math.sqrt(v));

  let nDone = 0, nFail = 0, nIn90 = 0, nCLIn90 = 0;
  const pTargets = [], shrKA = [], shrF = [], trMedians = [];
  const t0 = Date.now();

  for (let i = 0; i < N; i++) {
    const etaTrue = sds.map(s => s * g());
    const pTrue = M.indivParams(75, 'PNH', etaTrue, 'crovalimab', 40);
    if (!(pTrue.fSc > 0.3 && pTrue.fSc < 0.99)) { i--; continue; }

    // noisy observations from the true patient
    const simT = M.simulate(DOSES, OBS_T, pTrue, { rtol: 1e-8, id: 'crovalimab' });
    if (simT.failed) { i--; continue; }
    const obs = simT.c.map((c, k) => {
      const sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
      return { t: OBS_T[k], c: Math.max(0.1, c + sd * g()), lloq: false };
    });

    let fit;
    try {
      fit = await B.runFit({
        wt: 75, age: 40, disease: 'PNH', drug: 'crovalimab', doses: DOSES,
        obs, lloq: 0, target: TARGET, seed: 1000 + i, mcmcIters: 3000
      }, { progress: () => {} });
    } catch (e) {
      nFail++;
      t.msgs.push('info: patient ' + i + ' fit failed: ' + e.message);
      continue;
    }
    nDone++;

    // last predicted trough (virtual next dose at last dose + modal interval)
    const lastTr = fit.troughs[fit.troughs.length - 1];
    /* The truth is taken at the time the app actually predicted. v0.45.0: this
     * used to be a hard-coded day 69.999 ("last dose day 56 + 14"), but the
     * schedule's last dose is day 57 and the old q7d guess (modalInterval read
     * the loading spacing) put the assumed trough at day 64, which only
     * happened to sit near day 70. With the interval now read correctly (q28d)
     * the assumed trough is at day 85, so the comparison has to follow it. */
    const trueTrough = M.simulate(DOSES, [lastTr.t], pTrue, { rtol: 1e-8, id: 'crovalimab' }).c[0];
    if (lastTr.p5 <= trueTrough && trueTrough <= lastTr.p95) nIn90++;
    pTargets.push(lastTr.pTarget);
    trMedians.push(lastTr.med);

    // eta(CL) 90% posterior-interval coverage (draw quantiles)
    const clDraws = fit.draws.map(d => d[0]).sort((a, b) => a - b);
    const q5 = clDraws[Math.floor(clDraws.length * 0.05)];
    const q95 = clDraws[Math.floor(clDraws.length * 0.95)];
    if (q5 <= etaTrue[0] && etaTrue[0] <= q95) nCLIn90++;

    // diagnostics present + finite
    if (fit.etaInformation && fit.etaInformation.length === 6 &&
        fit.etaInformation.every(v => isFinite(v) && v >= 0 && v <= 1)) {
      shrKA.push(fit.etaInformation[4]);
      shrF.push(fit.etaInformation[5]);
    }
  }

  const cov90 = nIn90 / nDone;
  const covCL = nCLIn90 / nDone;
  const pMean = pTargets.reduce((a, c) => a + c, 0) / pTargets.length;
  const pSpread = Math.sqrt(pTargets.reduce((a, c) => a + (c - pMean) * (c - pMean), 0) / pTargets.length);
  const meanKA = shrKA.reduce((a, c) => a + c, 0) / Math.max(1, shrKA.length);
  const meanF = shrF.reduce((a, c) => a + c, 0) / Math.max(1, shrF.length);

  t.info('N=' + nDone + ' patients (fails=' + nFail + ') in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  t.info('90% trough-interval coverage: ' + (cov90 * 100).toFixed(0) + '% (95% binomial range for p=0.9, n=' + nDone + ': 75–98%)');
  t.info('SMOKE TEST ONLY — n=' + nDone + ' cannot distinguish 90% coverage from 99%; run `npm run calibration` for the real study');
  t.info('eta(CL) 90% posterior coverage: ' + (covCL * 100).toFixed(0) + '%');
  const trMean = trMedians.reduce((a, c) => a + c, 0) / trMedians.length;
  const trSD = Math.sqrt(trMedians.reduce((a, c) => a + (c - trMean) * (c - trMean), 0) / trMedians.length);
  t.info('last-trough P(>75): mean ' + pMean.toFixed(2) + ', SD ' + pSpread.toFixed(2));
  t.info('predicted trough median: mean ' + trMean.toFixed(0) + ' µg/mL, between-patient SD ' + trSD.toFixed(0) + ' (' + (trSD / trMean * 100).toFixed(0) + '% CV)');
  t.info('mean shrinkage: KA ' + meanKA.toFixed(2) + ', F ' + meanF.toFixed(2));

  t.eq(nFail, 0, 'no pipeline failures');
  t.ok(nDone === N, 'all ' + N + ' patients processed');
  t.ok(cov90 >= 0.75 && cov90 <= 1.0, '90% trough interval calibrated (got ' + (cov90 * 100).toFixed(0) + '%)');
  t.ok(covCL >= 0.6 && covCL <= 1.0, 'eta(CL) 90% interval reasonable (got ' + (covCL * 100).toFixed(0) + '%)');
  t.ok(trSD / trMean > 0.1, 'individualization propagates: between-patient trough CV > 10% (got ' + (trSD / trMean * 100).toFixed(0) + '%)');
  t.ok(shrKA.length === nDone && shrF.length === nDone, 'shrinkage diagnostics finite for every patient');
  t.ok(meanKA < 0.5 && meanF < 0.8, 'ka/F weakly-but-partially informed (KA ' + meanKA.toFixed(2) + ', F ' + meanF.toFixed(2) + ')');

  return t.summary();
}

module.exports = { run: run };
