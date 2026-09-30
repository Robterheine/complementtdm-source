#!/usr/bin/env node
/* Simulate-then-fit CALIBRATION STUDY (v0.13.0).
 *
 * The in-suite test (tests/test_e2e_fit.js) runs 24 crovalimab patients so the
 * suite stays under two minutes. That is a smoke test: at n = 24 the 95%
 * binomial range around a true 90% coverage is ~75–98%, so it cannot tell 90%
 * from 99% and must never be cited as calibration evidence.
 *
 * This tool is the real instrument. For each scenario it draws N patients from
 * the drug's own prior, simulates observations with residual error, runs the
 * COMPLETE pipeline exactly as the UI does (prior band -> MAP -> Laplace ->
 * MCMC -> posterior band -> troughs) at production iteration counts, and then
 * reports, per scenario:
 *
 *   - coverage of the nominal 90% trough interval, with an exact binomial 95%
 *     confidence interval, and a PASS/FAIL against that interval containing 0.90;
 *   - coverage of the nominal 90% eta(CL) interval;
 *   - a PIT (probability integral transform) histogram of the true trough
 *     within its posterior predictive, which detects bias and over/under-
 *     dispersion that a single coverage number hides. A calibrated forecast
 *     gives a flat PIT histogram.
 *
 * Over-wide intervals are a failure here, not a success: coverage materially
 * above 90% means the reported uncertainty is too conservative.
 *
 * Usage:  node tools/calibration_study.mjs [--n 300] [--scenario <name>]
 *         npm run calibration
 * Exit code 1 if any scenario's coverage CI excludes 0.90.
 */
'use strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

globalThis.ECU = {};
require('../src/model.js');
require('../src/bayes.js');
const M = ECU.model, B = ECU.bayes;

// ------------------------------- CLI ---------------------------------------
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
}
const N = parseInt(arg('n', '300'), 10);
const ONLY = arg('scenario', null);

// ---------------------------- scenarios ------------------------------------
/* Each scenario exercises a different drug, sampling design and covariate set.
 * `obsT` are sample times in days; `troughAt` is the trough whose interval is
 * scored (the last one the app would report). */
const SCENARIOS = [
  {
    name: 'crovalimab-sc-peak+troughs',
    drug: 'crovalimab', wt: 75, age: 40, disease: 'PNH', target: 75,
    doses: (() => {
      const d = [{ t: 0, amt: 1000, route: 'iv' }];
      for (let k = 1; k <= 4; k++) d.push({ t: 1 + k * 7, amt: 340, route: 'sc' });
      d.push({ t: 29, amt: 680, route: 'sc' });
      d.push({ t: 57, amt: 680, route: 'sc' });
      return d;
    })(),
    obsT: [33, 56.999, 84.999]
  },
  {
    name: 'crovalimab-sc-troughs-only',   // sparse, the hard identifiability case
    drug: 'crovalimab', wt: 75, age: 40, disease: 'PNH', target: 75,
    doses: (() => {
      const d = [{ t: 0, amt: 1000, route: 'iv' }];
      for (let k = 1; k <= 4; k++) d.push({ t: 1 + k * 7, amt: 340, route: 'sc' });
      d.push({ t: 29, amt: 680, route: 'sc' });
      d.push({ t: 57, amt: 680, route: 'sc' });
      return d;
    })(),
    obsT: [56.999, 84.999]
  },
  {
    name: 'eculizumab-pnh-troughs',
    drug: 'eculizumab', wt: 70, age: null, disease: 'PNH', target: 75,
    doses: (() => {
      const d = [];
      for (let k = 0; k < 6; k++) d.push({ t: k * 14, amt: 900, route: 'iv' });
      return d;
    })(),
    obsT: [41.999, 69.999]
  },
  {
    name: 'eculizumab-ahus-troughs',      // IOV folded into the CL prior
    drug: 'eculizumab', wt: 70, age: null, disease: 'aHUS', target: 75,
    doses: (() => {
      const d = [];
      for (let k = 0; k < 6; k++) d.push({ t: k * 14, amt: 900, route: 'iv' });
      return d;
    })(),
    obsT: [41.999, 69.999]
  },
  {
    name: 'ravulizumab-iv-troughs',
    drug: 'ravulizumab', wt: 70, age: null, disease: 'PNH', target: 100,
    doses: [{ t: 0, amt: 3000, route: 'iv' }, { t: 56, amt: 3000, route: 'iv' },
            { t: 112, amt: 3000, route: 'iv' }],
    obsT: [55.999, 111.999]
  }
];

// --------------------------- binomial CI -----------------------------------
/* Wilson score interval — well behaved near 0 and 1, unlike the normal
 * approximation, and adequate at the sample sizes used here. */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, z2 = z * z;
  const den = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / den;
  const half = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function pitHistogram(pits, bins = 10) {
  const h = new Array(bins).fill(0);
  for (const u of pits) {
    let b = Math.floor(u * bins);
    if (b < 0) b = 0; if (b >= bins) b = bins - 1;
    h[b]++;
  }
  return h;
}

/* Chi-square statistic against a flat PIT histogram, and its rough p-value via
 * the Wilson-Hilferty transform (adequate for a diagnostic). */
function pitUniformity(hist, n) {
  const bins = hist.length, expect = n / bins;
  let chi2 = 0;
  for (const o of hist) chi2 += (o - expect) * (o - expect) / expect;
  const df = bins - 1;
  const z = Math.pow(chi2 / df, 1 / 3) - (1 - 2 / (9 * df));
  const zz = z / Math.sqrt(2 / (9 * df));
  const p = 0.5 * erfc(zz / Math.SQRT2);
  return { chi2, df, p };
}
function erfc(x) {   // Abramowitz & Stegun 7.1.26, adequate for a diagnostic
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const y = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

// ------------------------------ the study ----------------------------------
async function runScenario(sc) {
  const spec = M.spec(sc.drug);
  const om = M.priorOmega(sc.disease, sc.drug);
  const sig = spec.SIGMA;
  const rng = B.mulberry32(20260912);
  const g = B.gaussFactory(rng);
  const sds = om.vars.map(v => Math.sqrt(v));

  let done = 0, fail = 0, in90 = 0, clIn90 = 0;
  const pits = [];
  const t0 = Date.now();

  for (let i = 0; i < N; i++) {
    const etaTrue = sds.map(s => s * g());
    const pTrue = M.indivParams(sc.wt, sc.disease, etaTrue, sc.drug, sc.age);
    const simT = M.simulate(sc.doses, sc.obsT, pTrue, { rtol: 1e-8, id: sc.drug });
    if (simT.failed) { fail++; continue; }

    const obs = simT.c.map(c => {
      const sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
      return { t: 0, c: Math.max(0.01, c + sd * g()), lloq: false };
    });
    sc.obsT.forEach((tt, k) => { obs[k].t = tt; });

    let fit;
    try {
      fit = await B.runFit({
        wt: sc.wt, age: sc.age, disease: sc.disease, drug: sc.drug,
        doses: sc.doses, obs, lloq: 0, target: sc.target, seed: 4242 + i
      });
    } catch (e) { fail++; continue; }

    const tr = fit.troughs[fit.troughs.length - 1];
    if (!tr) { fail++; continue; }

    // TRUE (noise-free) trough at the same time, from the true parameters
    const truth = M.simulate(sc.doses, [tr.t], pTrue, { rtol: 1e-8, id: sc.drug });
    if (truth.failed) { fail++; continue; }
    const cTrue = truth.c[0];

    if (cTrue >= tr.p5 && cTrue <= tr.p95) in90++;

    // PIT: the posterior-predictive CDF evaluated at the truth. Needs the raw
    // draws, so recompute the trough across the kept posterior draws.
    if (fit.draws && fit.draws.length) {
      let below = 0, tot = 0;
      for (let d = 0; d < fit.draws.length; d += Math.max(1, Math.floor(fit.draws.length / 200))) {
        const pd = M.indivParams(sc.wt, sc.disease, fit.draws[d], sc.drug, sc.age);
        const s2 = M.simulate(sc.doses, [tr.t], pd, { rtol: 1e-6, id: sc.drug });
        if (s2.failed) continue;
        tot++; if (s2.c[0] <= cTrue) below++;
      }
      if (tot > 5) pits.push(below / tot);
    }

    const clTrue = pTrue.cl;
    if (fit.clQ && clTrue >= fit.clQ.p5 && clTrue <= fit.clQ.p95) clIn90++;
    done++;
    if (done % 25 === 0) process.stdout.write(`    ${done}/${N}\r`);
  }

  const cov = done ? in90 / done : 0;
  const ci = wilson(in90, done);
  const covCL = done ? clIn90 / done : 0;
  const hist = pitHistogram(pits);
  const uni = pits.length ? pitUniformity(hist, pits.length) : null;
  const pass = ci[0] <= 0.90 && ci[1] >= 0.90;

  console.log(`\n== ${sc.name} ==`);
  console.log(`   n = ${done} (failures ${fail}) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`   90% trough-interval coverage : ${(cov * 100).toFixed(1)}%  ` +
              `[95% CI ${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%]  ` +
              `${pass ? 'PASS' : 'FAIL — CI excludes 90%'}`);
  console.log(`   90% eta(CL)-interval coverage: ${(covCL * 100).toFixed(1)}%`);
  if (uni) {
    console.log(`   PIT histogram (10 bins, flat = calibrated): ${hist.join(' ')}`);
    console.log(`   PIT uniformity: chi2 = ${uni.chi2.toFixed(1)} on ${uni.df} df, p ${uni.p < 0.001 ? '< 0.001' : '= ' + uni.p.toFixed(3)}` +
                `${uni.p < 0.01 ? '   <-- PIT is not flat: bias or mis-scaled spread' : ''}`);
  }
  if (cov > 0.95 && done > 50) {
    console.log('   NOTE: coverage well above nominal — intervals are conservative (too wide), not "better".');
  }
  return pass;
}

(async () => {
  console.log(`Calibration study — N = ${N} per scenario, production MCMC settings.`);
  console.log('A scenario PASSES when the 95% CI for its coverage contains 0.90.\n');
  let allPass = true;
  for (const sc of SCENARIOS) {
    if (ONLY && sc.name !== ONLY) continue;
    allPass = (await runScenario(sc)) && allPass;
  }
  console.log(allPass ? '\nALL SCENARIOS CALIBRATED' : '\nSOME SCENARIOS NOT CALIBRATED');
  process.exit(allPass ? 0 : 1);
})();
