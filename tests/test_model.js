'use strict';
/* M1 — model core tests
 *   1. golden vectors: JS solver vs independent Python RK4 reference (tests/golden.json)
 *   2. analytic 2-compartment bolus solution with Vmax = 0
 *   3. article-consistency sanity anchors (steady-state trough/peak ranges)
 */
const fs = require('fs');
const path = require('path');
const { M, T } = require('./util');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden.json'), 'utf8'));

async function run() {
  const t = new T('test_model');

  // ---- 1. golden vectors ----
  for (const sc of GOLDEN) {
    const p = M.indivParams(sc.wt, sc.disease, 0, 0);
    if (sc.vmax0) p.vmax = 0; // allow the vmax=0 reference scenario
    const sim = M.simulate(sc.doses, sc.times, p, { rtol: 1e-9, atol: 1e-12 });
    t.ok(!sim.failed, sc.name + ': solver did not fail');
    let maxRel = 0, meanRel = 0;
    for (let i = 0; i < sc.times.length; i++) {
      const denom = Math.max(1, Math.abs(sc.c[i]));
      const rel = Math.abs(sim.c[i] - sc.c[i]) / denom;
      maxRel = Math.max(maxRel, rel);
      meanRel += rel;
    }
    meanRel /= Math.max(1, sc.times.length);
    t.info(sc.name + ': max rel err vs Python RK4 = ' + maxRel.toExponential(3) +
      ' (mean ' + meanRel.toExponential(3) + ')');
    t.ok(maxRel < 1e-5, sc.name + ': max relative error < 1e-5 (got ' + maxRel.toExponential(2) + ')');
  }

  // ---- 2. analytic 2-compartment bolus (linear only, Vmax = 0) ----
  const p0 = M.indivParams(70, 'PNH', 0, 0);
  p0.vmax = 0;
  const D = 1000;
  const kel = p0.cl / p0.v1, k12 = p0.q / p0.v1, k21 = p0.q / p0.v2;
  const sum = kel + k12 + k21, prod = kel * k21;
  const disc = Math.sqrt(sum * sum - 4 * prod);
  const alpha = (sum + disc) / 2, beta = (sum - disc) / 2;
  const A = (alpha - k21) / (alpha - beta), Bc = (k21 - beta) / (alpha - beta);
  function analytic(tt) {
    const c = (D / p0.v1) * (A * Math.exp(-alpha * tt) + Bc * Math.exp(-beta * tt));
    // + reflection of the same dose given as bolus at t=0 (already included)
    return c;
  }
  const times = [0.05, 0.5, 1, 3, 7, 14, 30, 60];
  const simB = M.simulate([{ t: 0, amt: D, bolus: true }], times, p0, { rtol: 1e-10, atol: 1e-12 });
  let m2 = 0;
  for (let i = 0; i < times.length; i++) {
    const denom = Math.max(1, Math.abs(analytic(times[i])));
    m2 = Math.max(m2, Math.abs(simB.c[i] - analytic(times[i])) / denom);
  }
  t.info('analytic bolus 2-cmt (Vmax=0): max rel err = ' + m2.toExponential(3));
  t.ok(m2 < 1e-6, 'analytic linear 2-cmt bolus matches to < 1e-6 (got ' + m2.toExponential(2) + ')');

  // linear clearance rate check: at Vmax=0, DADT1 = -kel*A1 ...
  // (covered implicitly by the analytic test above)

  // ---- 3. article-consistency sanity anchors ----
  // Typical PNH patient, wt 83 kg (article median), standard regimen 600 q1w x4
  // then 900 q2w. Observed medians in the article: trough 153, peak 327 ug/mL.
  const doses83 = [];
  [[0, 600], [7, 600], [14, 600], [21, 600], [28, 900], [42, 900], [56, 900]].forEach(s => doses83.push({ t: s[0], amt: s[1] }));
  const p83 = M.indivParams(83, 'PNH', 0, 0);
  const a83 = M.simulate(doses83, [55.99, 28.04, 98], p83, { rtol: 1e-8 });
  const trough83 = a83.c[0], peak83 = a83.c[1];
  t.info('wt83 steady-state trough (day 56) = ' + trough83.toFixed(1) + ', peak = ' + peak83.toFixed(1) +
    ' ug/mL (article observed medians: 153 / 327)');
  t.ok(trough83 > 90 && trough83 < 180, 'wt83 trough within plausible steady-state range (got ' + trough83.toFixed(1) + ')');
  t.ok(peak83 > 230 && peak83 < 370, 'wt83 peak within plausible range (got ' + peak83.toFixed(1) + ')');

  // typical wt 70 kg at the same fixed dose: trough higher than at 83 kg
  const p70 = M.indivParams(70, 'PNH', 0, 0);
  const a70 = M.simulate(doses83, [55.99], p70, { rtol: 1e-8 });
  t.info('wt70 steady-state trough (day 56) = ' + a70.c[0].toFixed(1) + ' ug/mL');
  t.ok(a70.c[0] > 110 && a70.c[0] < 210, 'wt70 trough plausible (got ' + a70.c[0].toFixed(1) + ')');

  // elimination after stop: negligible by day +200
  const aEnd = M.simulate([{ t: 0, amt: 900 }, { t: 14, amt: 900 }], [200], p70, { rtol: 1e-6 });
  t.ok(aEnd.c[0] < 1, 'concentration ~0 well after last dose (got ' + aEnd.c[0].toFixed(4) + ')');

  return t.summary();
}

module.exports = { run: run };
