'use strict';
/* Stress / robustness tests (engine level)
 *  - no-dose guard
 *  - extreme weights, doses and measured concentrations
 *  - observation exactly at a dose time (must equal the pre-dose trough)
 *  - multi-year dosing history -> rolling display window, no horizon truncation
 *  - observations far before the window still inform the fit
 *  - censored-only (all <LLOQ) data
 *  - duplicate observation times, degenerate MAP targets
 */
const { M, B, T } = require('./util');

async function run() {
  const t = new T('test_stress');

  // 1. no-dose guard
  let threw = false;
  try { await B.runFit({ wt: 70, disease: 'PNH', doses: [], obs: [{ t: 3, c: 150, lloq: false }] }); }
  catch (e) { threw = /dose/i.test(e.message); }
  t.ok(threw, 'runFit with no doses throws a clear error');

  // 2. extreme single doses at extreme weights
  for (const wt of [35, 200]) {
    const p = M.indivParams(wt, 'PNH', 0, 0);
    const sim = M.simulate([{ t: 0, amt: 4000 }], [1, 7, 28], p, { rtol: 1e-8 });
    t.ok(!sim.failed && sim.c.every(v => isFinite(v) && v > 0),
      'single 4000 mg dose, wt ' + wt + ' kg → finite positive concentrations');
  }

  // 3. observation exactly at a dose time equals the pre-dose trough
  const doses2 = [{ t: 0, amt: 900 }, { t: 14, amt: 900 }];
  const p2 = M.indivParams(70, 'PNH', 0, 0);
  const atDose = M.simulate(doses2, [14], p2, { rtol: 1e-8 }).c[0];
  const justBefore = M.simulate(doses2, [14 - 1e-6], p2, { rtol: 1e-8 }).c[0];
  t.close(atDose, justBefore, 1e-6, 'obs exactly at dose time equals pre-dose trough');
  t.ok(atDose > 0 && atDose < 400, 'pre-dose trough magnitude sane (got ' + atDose.toFixed(1) + ')');

  // 4. multi-year history → rolling window, no 400-day truncation
  const dosesLong = [];
  for (let i = 0; i < 104; i++) dosesLong.push({ t: 14 * i, amt: 900 }); // ~4 years q2w
  const lastDose = dosesLong[dosesLong.length - 1].t; // 1442
  const obsLong = [
    { t: 100, c: 130, lloq: false },            // early history (still informs the fit)
    { t: lastDose - 1e-6, c: 120, lloq: false },
    { t: lastDose - 14 + 0.1, c: 300, lloq: false }
  ];
  const fitLong = await B.runFit({ wt: 70, disease: 'PNH', doses: dosesLong, obs: obsLong, target: 75, seed: 3, mcmcIters: 800 });
  t.info('long history: lastDose ' + lastDose + ', windowStart ' + fitLong.windowStart +
    ', horizon ' + fitLong.horizon.toFixed(0) + ', grid points ' + fitLong.grid.length +
    ', troughs listed ' + fitLong.troughs.length);
  t.close(fitLong.windowStart, Math.max(0, lastDose - 365), 1e-9, 'windowStart = last dose − 365 d');
  t.ok(fitLong.grid[0] === fitLong.windowStart, 'grid starts at windowStart');
  t.ok(fitLong.horizon >= lastDose + 14, 'horizon extends past the last dose (no 400-d truncation)');
  t.ok(fitLong.grid.length > 500 && fitLong.grid.length < 5000, 'grid bounded');
  t.ok(fitLong.troughs.every(tr => tr.t >= fitLong.windowStart - 1e-6), 'only window troughs listed');
  t.ok(fitLong.band.med.every(isFinite), 'posterior bands finite over the window');
  t.ok(isFinite(fitLong.clQ.med) && fitLong.clQ.med > 0.01 && fitLong.clQ.med < 5, 'CL estimate sane');

  // 5. extreme measured concentrations (far above achievable) → still finite, sane
  const fitExt = await B.runFit({
    wt: 60, disease: 'PNH',
    doses: [{ t: 0, amt: 900 }, { t: 14, amt: 900 }, { t: 28, amt: 900 }],
    obs: [{ t: 0.1, c: 2000, lloq: false }, { t: 14, c: 2000, lloq: false }, { t: 28, c: 2000, lloq: false }],
    target: 75, seed: 4, mcmcIters: 600
  });
  t.ok(isFinite(fitExt.map.etaCL) && isFinite(fitExt.clQ.med) && fitExt.clQ.med > 1e-6 && fitExt.clQ.med < 5 &&
    isFinite(fitExt.clQ.p95),
    'extreme 2000 µg/mL obs → finite, stable output (CL med ' + fitExt.clQ.med.toExponential(2) + ')');

  // 6. censored-only observations (all <LLOQ, M3)
  const fitCens = await B.runFit({
    wt: 70, disease: 'PNH',
    doses: [{ t: 0, amt: 900 }, { t: 14, amt: 900 }, { t: 28, amt: 900 }],
    obs: [{ t: 14, c: 0, lloq: true }, { t: 28, c: 0, lloq: true }],
    lloq: 10, target: 75, seed: 5, mcmcIters: 600
  });
  t.ok(fitCens.hasObs && isFinite(fitCens.map.etaCL) && fitCens.nDraws > 50,
    'censored-only obs handled (M3) — draws ' + fitCens.nDraws);

  // 7. duplicate observation times
  const fitDup = await B.runFit({
    wt: 70, disease: 'aHUS',
    doses: [{ t: 0, amt: 1200 }, { t: 14, amt: 1200 }],
    obs: [{ t: 14, c: 150, lloq: false }, { t: 14, c: 152, lloq: false }, { t: 0.1, c: 320, lloq: false }],
    target: 75, seed: 6, mcmcIters: 600
  });
  t.ok(isFinite(fitDup.map.etaCL), 'duplicate observation times handled (aHUS mode)');

  // 8. extreme (unreachable / trivial) trough targets stay finite in runFit
  const fHi = await B.runFit({ wt: 200, disease: 'PNH',
    doses: [{ t: 0, amt: 900 }, { t: 14, amt: 900 }], obs: [], lloq: 0,
    target: 2000, seed: 8, mcmcIters: 200 });
  const fLo = await B.runFit({ wt: 35, disease: 'PNH',
    doses: [{ t: 0, amt: 900 }, { t: 14, amt: 900 }], obs: [], lloq: 0,
    target: 1, seed: 9, mcmcIters: 200 });
  t.ok(fHi.troughs.length > 0 && fHi.troughs.every(function (x) { return x.pTarget === 0 && isFinite(x.med); }),
    'unreachable target → P(target) 0, finite trough');
  t.ok(fLo.troughs.length > 0 && fLo.troughs.every(function (x) { return x.pTarget === 1 && isFinite(x.med); }),
    'trivial target → P(target) 1, finite trough');

  // 9. OFV finite across a wide eta sweep (degenerate-parameter guard)
  const ctx = {
    wt: 70, disease: 'PNH',
    doses: [{ t: 0, amt: 900 }, { t: 14, amt: 900 }],
    obs: [{ t: 14, c: 150, lloq: false }, { t: 0.2, c: 300, lloq: false }],
    lloq: 0, omega: M.priorOmega('PNH'), rtol: 1e-6
  };
  const ofv = B.makeOfv(ctx);
  let allFinite = true;
  for (const a of [-3, -1.5, 0, 1.5, 3]) {
    for (const b of [-3, -1.5, 0, 1.5, 3]) {
      if (!isFinite(ofv([a, b]))) allFinite = false;
    }
  }
  t.ok(allFinite, 'OFV finite across eta ∈ [-3, 3]²');

  // 10. weekly 600 mg × 52 with MCMC stays fast enough and stable
  const dosesW = [];
  for (let i = 0; i < 52; i++) dosesW.push({ t: 7 * i, amt: 600 });
  const fitW = await B.runFit({
    wt: 80, disease: 'PNH', doses: dosesW,
    obs: [{ t: 7 * 51 + 0.05, c: 320, lloq: false }, { t: 7 * 51 - 1e-6, c: 120, lloq: false }],
    target: 75, seed: 8, mcmcIters: 600
  });
  t.ok(isFinite(fitW.map.etaCL) && fitW.runtimeMs < 60000, 'yearly weekly regimen fits (runtime ' + Math.round(fitW.runtimeMs) + ' ms)');

  return t.summary();
}

module.exports = { run: run };
