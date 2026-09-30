/* Empty-defaults regression (v0.7.1): every data field starts blank.
 * 1. runFit rejects null/blank weight (would otherwise silently simulate
 *    with zero allometric clearance) and a non-finite target.
 * 2. A population forecast run with an explicitly omitted (blank) target
 *    falls back to the drug's targetDefault and stays sane (no NaN,
 *    plausible band ordering, probabilities within [0,1]).
 * 3. Per-drug default targets apply: crovalimab blank target → 75,
 *    ravulizumab → 150 (its spec value).
 */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('empty fields policy (blank defaults)');

  var DOSES = [
    { t: 0, amt: 900 }, { t: 7, amt: 900 }, { t: 14, amt: 900 },
    { t: 21, amt: 900 }, { t: 28, amt: 900 }, { t: 35, amt: 900 }
  ];

  // ---- 1. engine rejects blank weight / garbage target instead of simulating ----
  var threw = false;
  try { await B.runFit({ wt: null, disease: 'PNH', doses: DOSES.slice(), obs: [], lloq: 0, target: 75 }); }
  catch (e) { threw = /weight/i.test(e.message); }
  t.ok(threw, 'null weight rejected by the engine (no zero-clearance simulation)');

  threw = false;
  try { await B.runFit({ wt: NaN, disease: 'PNH', doses: DOSES.slice(), obs: [], lloq: 0, target: 75 }); }
  catch (e) { threw = /weight/i.test(e.message); }
  t.ok(threw, 'NaN weight rejected by the engine');

  threw = false;
  try { await B.runFit({ wt: 70, disease: 'PNH', doses: DOSES.slice(), obs: [], lloq: 0, target: NaN }); }
  catch (e) { threw = /target/i.test(e.message); }
  t.ok(threw, 'NaN target rejected by the engine');

  // ---- 2. blank (omitted) target → drug default, sane population band ----
  var f = await B.runFit({ wt: 70, disease: 'PNH', doses: DOSES.slice(), obs: [], lloq: 0, seed: 7, mcmcIters: 600 });
  t.ok(f.troughs.length > 0, 'population forecast with blank fields produces troughs');
  var allFinite = f.troughs.every(function (tr) {
    return isFinite(tr.med) && isFinite(tr.p5) && isFinite(tr.p95) && isFinite(tr.pTarget);
  });
  t.ok(allFinite, 'no NaN leaks into trough statistics when fields are blank');
  t.ok(f.troughs[0].p5 > 0 && f.troughs[0].p95 > f.troughs[0].p5, 'band is ordered and positive');
  t.eq(f.target, 75, 'blank target falls back to the eculizumab default (75)');
  t.ok(f.troughs.every(function (tr) { return tr.pTarget >= 0 && tr.pTarget <= 1; }), 'probabilities within [0,1]');

  // ---- 3. per-drug default targets with blank target field ----
  var fc = await B.runFit({ wt: 70, age: 40, drug: 'crovalimab', disease: 'PNH',
    doses: [{ t: 0, amt: 1000, route: 'iv' }, { t: 14, amt: 680, route: 'sc' }, { t: 28, amt: 680, route: 'sc' }],
    obs: [], lloq: 0, seed: 7, mcmcIters: 600 });
  t.eq(fc.target, 75, 'crovalimab blank target falls back to 75 µg/mL');

  var fr = await B.runFit({ wt: 70, drug: 'ravulizumab', disease: 'PNH',
    doses: [{ t: 0, amt: 1000 }, { t: 28, amt: 3200 }, { t: 84, amt: 3200 }],
    obs: [], lloq: 0, seed: 7, mcmcIters: 600 });
  t.eq(fr.target, 150, 'ravulizumab blank target falls back to 150 µg/mL');

  return t.summary();
}

module.exports = { run: run };
