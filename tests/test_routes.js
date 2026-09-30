/* SC/depot route machinery + pending-drug guard tests.
 * 1. Pending specs (crovalimab placeholder): indivParams/simulate/runFit refuse
 *    to compute and throw a clear error instead of producing nonsense.
 * 2. SC depot absorption (first-order ka, bioavailability F) using a test-only
 *    spec: delayed peak vs IV, correct F scaling of exposure, mixed IV+SC
 *    schedules, and the ka=0 guard for IV-only drugs.
 * The temporary test spec is removed afterwards so other suites are unaffected.
 */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('routes & pending drugs');

  // ---- 1. pending spec guard (synthetic placeholder; crovalimab is now a
  //      real spec — see test_crovalimab.js) ----
  M.drugs.pendingtest = {
    id: 'pendingtest', label: 'PendingTest', pending: true,
    article: 'test-only', info: 'test-only placeholder',
    THETA: null, EXPO: null, OMEGA: null, IOV_CL: 0, IOV_DISEASES: [],
    SIGMA: null, INFUSION_D: null, KA_D: null, BIOAVAIL_SC: 1,
    adminRoutes: { first: 'iv', subsequent: 'sc' },
    samplePeak: '', dose: { min: 1, max: 10000, step: 1, default: 0 },
    ssIntervalDefault: 14, diseaseCovariate: false, targetDefault: 75, targetHint: ''
  };
  t.ok(M.drugs.pendingtest.pending === true, 'synthetic pending spec present');
  var threw;
  threw = false;
  try { M.indivParams(70, 'PNH', 0, 0, 'pendingtest'); } catch (e) { threw = /not yet available/.test(String(e.message)); }
  t.ok(threw, 'indivParams on a pending spec throws a clear error');
  threw = false;
  try {
    M.simulate([{ t: 0, amt: 1000 }], [1], M.indivParams(70, 'PNH', 0, 0), { id: 'pendingtest' });
  } catch (e) { threw = /not yet available/.test(String(e.message)); }
  t.ok(threw, 'simulate on a pending spec throws a clear error (indivParams or simulate)');
  threw = false;
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'pendingtest', doses: [{ t: 0, amt: 1000 }], obs: [], lloq: 0, target: 100 }, {});
  } catch (e) { threw = /not yet available/.test(String(e.message)); }
  t.ok(threw, 'runFit on a pending spec throws a clear error');
  M.select('eculizumab');   // runFit selects the requested drug; restore the default
  delete M.drugs.pendingtest;

  // ---- 2. SC depot machinery on a temporary test spec ----
  M.drugs.testsc = {
    id: 'testsc', label: 'TestSC',
    article: 'test-only spec', info: 'test-only',
    THETA: { CL: 0.1626, V1: 4.299, VMAX: 0, KM: 1, V2: 2.63, Q: 0.6243 },
    EXPO: { CLQ: 0.75, V: 1 },
    OMEGA: { CL: 0.1546, V1: 0.0812, COV: 0 },
    IOV_CL: 0, IOV_DISEASES: [],
    SIGMA: { ADD: 19.1, PROP: 0.0185 },
    INFUSION_D: 30 / 1440,
    KA_D: 0.8,          // 1/day — fast-ish absorption
    BIOAVAIL_SC: 0.75,
    samplePeak: '', dose: { min: 1, max: 10000, step: 1, default: 900 },
    ssIntervalDefault: 14, diseaseCovariate: false, targetDefault: 75, targetHint: ''
  };
  var p = M.indivParams(70, 'PNH', 0, 0, 'testsc');
  t.close(p.ka, 0.8, 1e-12, 'testsc params carry ka from the spec');
  t.close(p.fSc, 0.75, 1e-12, 'testsc params carry F from the spec');

  // SC dose peaks later than the same amount given as an IV infusion
  var times = [0.01, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 4, 8];
  var iv = M.simulate([{ t: 0, amt: 900 }], times, p, { id: 'testsc' }).c;
  var sc = M.simulate([{ t: 0, amt: 900, route: 'sc' }], times, p, { id: 'testsc' }).c;
  function argmax(a) { var m = 0; for (var i = 1; i < a.length; i++) if (a[i] > a[m]) m = i; return m; }
  t.ok(argmax(sc) > argmax(iv), 'SC peak occurs later than IV peak (depot absorption)');
  t.ok(sc[argmax(sc)] < iv[argmax(iv)], 'SC peak concentration lower than IV peak (flip-flop)');

  // AUC over a long window scales with bioavailability (~0.75, minus tail truncation)
  var longT = [1, 2, 4, 8, 16, 32, 64, 128];
  var ivL = M.simulate([{ t: 0, amt: 900 }], longT, p, { id: 'testsc' }).c;
  var scL = M.simulate([{ t: 0, amt: 900, route: 'sc' }], longT, p, { id: 'testsc' }).c;
  function trapz(ts, cs) { var a = 0; for (var i = 1; i < ts.length; i++) a += (cs[i] + cs[i - 1]) / 2 * (ts[i] - ts[i - 1]); return a; }
  var ratio = trapz(longT, scL) / trapz(longT, ivL);
  t.ok(ratio > 0.6 && ratio < 0.9, 'SC/IV AUC ratio reflects bioavailability F=0.75 (got ' + ratio.toFixed(2) + ')');

  // Mixed schedule: IV loading followed by SC maintenance doses
  var mixed = M.simulate(
    [{ t: 0, amt: 900 }, { t: 14, amt: 900, route: 'sc' }, { t: 28, amt: 900, route: 'sc' }],
    [14 - 1e-6, 28 - 1e-6, 42 - 1e-6], p, { id: 'testsc' }).c;
  t.ok(mixed.every(function (v) { return isFinite(v) && v > 0; }), 'mixed IV+SC schedule simulates finitely');
  t.ok(mixed[1] > mixed[0] * 0.3, 'SC maintenance keeps exposure above zero after the IV loading');

  // ka = 0 (IV-only drug): SC doses are rejected with a clear error
  M.drugs.testsc.KA_D = 0;
  var pNoKa = M.indivParams(70, 'PNH', 0, 0, 'testsc');
  t.eq(pNoKa.ka, 0, 'ka = 0 when the spec has no SC rate');
  threw = false;
  try { M.simulate([{ t: 0, amt: 900, route: 'sc' }], [1], pNoKa, { id: 'testsc' }); }
  catch (e) { threw = /no SC absorption/.test(String(e.message)); }
  t.ok(threw, 'SC dose on an IV-only model throws a clear error');

  // eculizumab/ravulizumab remain IV-only (ka = 0, no route tagging needed)
  var pEcu = M.indivParams(70, 'PNH', 0, 0, 'eculizumab');
  t.eq(pEcu.ka, 0, 'eculizumab params carry ka = 0 (IV only)');
  var pRav = M.indivParams(70, 'PNH', 0, 0, 'ravulizumab');
  t.eq(pRav.ka, 0, 'ravulizumab params carry ka = 0 (IV only)');
  var ivRef = M.simulate([{ t: 0, amt: 900 }], [0.5], pEcu, { rtol: 1e-9 }).c[0];
  t.ok(isFinite(ivRef) && ivRef > 0, 'eculizumab IV simulation unchanged by route refactor');

  // clean up the temporary spec and restore the default drug
  delete M.drugs.testsc;
  M.select('eculizumab');
  t.eq(M.drug().id, 'eculizumab', 'default drug restored after the suite');

  return t.summary();
}

module.exports = { run: run };
