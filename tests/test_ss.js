/* Steady-state mode engine tests.
 * The UI synthesizes a schedule in which the latest dose (anchor) sits at
 * day 0, earlier cycles are simulated back to steady state (negative days),
 * and the regimen continues forward. These tests exercise runFit with exactly
 * such schedules and with negative-time observations. */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

/* Build the same kind of schedule the UI's steady-state mode synthesizes:
 * K back-cycles before the anchor at day 0, plus `ahead` continuing cycles. */
function ssSchedule(I, K, ahead) {
  var D = 900, doses = [];
  for (var k = K; k >= 1; k--) doses.push({ t: -k * I, amt: D });
  doses.push({ t: 0, amt: D });
  for (var j = 1; j <= ahead; j++) doses.push({ t: j * I, amt: D });
  return doses;
}

async function run() {
  var t = new T('steady-state engine');

  // 1) SS forecast with negative-time obs individualizes and returns sane troughs
  {
    var doses = ssSchedule(14, 26, 3);
    var obs = [
      { t: -28, c: 128, lloq: false },
      { t: -14, c: 141, lloq: false },
      { t: 0.02, c: 305, lloq: false }
    ];
    var fit = await B.runFit({ wt: 70, disease: 'PNH', doses: doses, obs: obs,
      lloq: 0, target: 75, seed: 1, mcmcIters: 600, windowStart: -30 }, {});
    t.ok(fit.hasObs, 'ss: fit individualizes with negative-time obs');
    t.ok(fit.map && isFinite(fit.map.etaCL) && isFinite(fit.map.etaV1), 'ss: MAP finite');
    t.ok(fit.troughs.length >= 4, 'ss: trough rows include history + future (got ' + fit.troughs.length + ')');
    var neg = fit.troughs.filter(function (tr) { return tr.t < 0; });
    var pos = fit.troughs.filter(function (tr) { return tr.t > 0; });
    t.ok(neg.length > 0 && pos.length > 0, 'ss: troughs span negative and positive days');
    pos.forEach(function (tr) {
      t.ok(isFinite(tr.med) && tr.med > 10 && tr.med < 1000, 'ss: future trough med plausible (' + tr.med + ')');
      t.ok(tr.pTarget >= 0 && tr.pTarget <= 1, 'ss: pTarget in [0,1]');
    });
  }

  // 2) Steady state is actually reached: troughs before the anchor must already sit
  //    on the repeating cycle. Deterministic check on the typical (eta=0) curve
  //    after a long pre-roll: successive troughs agree to within ~0.2%.
  {
    var doses2 = ssSchedule(14, 24, 2);   // 336 d pre-roll -> converged to <0.1%/cycle
    var pTyp = M.indivParams(70, 'PNH', 0, 0);
    var sim = M.simulate(doses2, [-42 - 1e-6, -28 - 1e-6, -14 - 1e-6, 14 - 1e-6],
      pTyp, { rtol: 1e-8 });
    t.ok(!sim.failed && sim.c.every(function (v) { return isFinite(v); }), 'ss: typical sim ok');
    t.close(sim.c[2], sim.c[3], 0.002, 'ss: future trough == converged history (typical)');
    t.close(sim.c[0], sim.c[2], 0.002, 'ss: history already at steady state (typical)');

    // Posterior predictive (no obs -> prior): trough rows exist on both sides of
    // day 0 and agree loosely (MCMC/quantile noise allowed).
    var fit2 = await B.runFit({ wt: 70, disease: 'PNH', doses: doses2, obs: [],
      lloq: 0, target: 75, seed: 2, mcmcIters: 300, windowStart: -43 }, {});
    var byDay = {};
    fit2.troughs.forEach(function (tr) { byDay[Math.round(tr.t)] = tr.med; });
    t.ok(isFinite(byDay[-42]) && isFinite(byDay[-14]) && isFinite(byDay[14]),
      'ss: trough medians present at -42, -14, +14');
    var drift = Math.abs(byDay[-42] - byDay[14]) / byDay[-42];
    t.ok(drift < 0.08, 'ss: prior-predictive future matches history (' + (100 * drift).toFixed(1) + '% drift)');
  }

  // 3) The engine horizon covers the continuing regimen (last virtual dose + 1.5x interval)
  {
    var doses3 = ssSchedule(21, 8, 3);
    var fit3 = await B.runFit({ wt: 70, disease: 'PNH', doses: doses3, obs: [],
      lloq: 0, target: 75, seed: 3, mcmcIters: 200, windowStart: -30 }, {});
    t.ok(fit3.horizon >= 3 * 21 + 1.5 * 21 - 1e-9, 'ss: horizon covers continuing regimen');
    t.ok(fit3.grid[fit3.grid.length - 1] >= fit3.horizon - 0.6, 'ss: grid reaches horizon');
  }

  // 4) Obs well before the synthesized history must not break the fit
  {
    var doses4 = [{ t: -84, amt: 900 }, { t: -42, amt: 900 }, { t: 0, amt: 900 }];
    var obs4 = [{ t: -200, c: 120, lloq: false }];
    var fit4 = await B.runFit({ wt: 70, disease: 'PNH', doses: doses4, obs: obs4,
      lloq: 0, target: 75, seed: 4, mcmcIters: 200, windowStart: -200 }, {});
    t.ok(fit4.hasObs && isFinite(fit4.map.ofv), 'ss: ancient obs does not break the fit');
  }

  // 5) aHUS prior in steady-state mode: folded IOV keeps bands finite
  {
    var doses5 = ssSchedule(14, 12, 2);
    var fit5 = await B.runFit({ wt: 70, disease: 'aHUS', doses: doses5, obs: [],
      lloq: 0, target: 75, seed: 5, mcmcIters: 200, windowStart: -28 }, {});
    t.ok(isFinite(fit5.band.p95[Math.floor(fit5.band.p95.length / 2)]), 'ss aHUS: prior band finite');
    t.ok(fit5.clQ.p95 > fit5.clQ.p5, 'ss aHUS: CL quantiles ordered');
  }

  var s = t.summary();
  return s;
}

module.exports = { run: run };
