/* Crovalimab (PiaSky FDA review, control stream run05) model tests.
 * 1. Spec transcription: THETA/OMEGA/SIGMA/covariate relations match the
 *    control stream exactly (time base = days, no rescaling).
 * 2. Age covariate on ka: ka = 0.126 * (age/36)^-0.459; weight allometry on
 *    CL/Q (0.75) and V2/V3 (0.684) referenced to 75 kg.
 * 3. Mixed-route behavior: IV loading dose (compartment 2) then SC doses
 *    (compartment 1 with F = 0.83) — same observation compartment.
 * 4. Typical-patient plausibility: label-like loading + q2w SC maintenance at
 *    steady state; trough/peak sanity at the reported half-life scale.
 * 5. MAP recovery from simulated data through runFit (age threaded through).
 * Always restores the default drug (eculizumab) afterwards.
 */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('crovalimab (run05)');

  // ---- 1. spec transcription vs the control stream ----
  M.select('crovalimab');
  var s = M.drug();
  t.ok(!s.pending, 'crovalimab spec is no longer pending');
  t.close(s.THETA.CL, 0.0791, 1e-12, 'CL = 0.0791 L/day (control stream)');
  t.close(s.THETA.V1, 3.23, 1e-12, 'central volume V2 = 3.23 L');
  t.close(s.THETA.V2, 2.32, 1e-12, 'peripheral volume V3 = 2.32 L');
  t.close(s.THETA.Q, 0.168, 1e-12, 'Q = 0.168 L/day');
  t.close(s.THETA.VMAX, 0, 1e-12, 'linear elimination only (no MM term in run05)');
  t.close(s.KA_D, 0.126, 1e-12, 'ka = 0.126 /day');
  t.close(s.BIOAVAIL_SC, 0.83, 1e-12, 'F1 = 0.83');
  t.eq(s.EXPO.CLQ, 0.75, 'WT on CL and Q: allometric exponent 0.75 (FIX)');
  t.eq(s.EXPO.V, 0.684, 'WT on V2 and V3: exponent 0.684');
  t.eq(s.WT_REF, 75, 'allometric reference weight 75 kg');
  t.eq(s.AGE_REF, 36, 'age reference for ka = 36 years');
  t.eq(s.AGE_EXPO_KA, -0.459, 'age exponent on ka = -0.459');
  t.close(s.OMEGA.CL, 0.0424, 1e-12, 'omega CL (eta1)');
  t.close(s.OMEGA.V1, 0.0502, 1e-12, 'omega V2 (eta2)');
  t.close(s.SIGMA.ADD, 1.02, 1e-12, 'additive residual variance 1.02 (SD 1.01)');
  t.close(s.SIGMA.PROP, 0.01277, 1e-12, 'proportional residual variance 0.01277 (SD 0.113)');
  t.eq(s.diseaseCovariate, false, 'disease is not a covariate of this model');
  t.eq(s.covariateAge, true, 'age is a covariate of this model (UI asks for it)');
  t.eq(s.targetDefault, 75, 'target default = 75 µg/mL (complete C5 inhibition)');
  t.ok(s.adminRoutes.first === 'iv' && s.adminRoutes.subsequent === 'sc',
    'admin routes: IV loading, SC thereafter');

  // ---- 2. covariate relations ----
  var p36 = M.indivParams(75, 'PNH', 0, 0, 'crovalimab', 36);
  t.close(p36.cl, 0.0791, 1e-12, 'at 75 kg / 36 y: CL = THETA (reference individual)');
  t.close(p36.v1, 3.23, 1e-12, 'at 75 kg: V2 = THETA');
  t.close(p36.ka, 0.126, 1e-12, 'at 36 y: ka = THETA');
  var p60 = M.indivParams(60, 'PNH', 0, 0, 'crovalimab', 36);
  t.close(p60.cl, 0.0791 * Math.pow(60 / 75, 0.75), 1e-12, 'CL allometry (WT/75)^0.75');
  t.close(p60.v1, 3.23 * Math.pow(60 / 75, 0.684), 1e-12, 'V2 allometry (WT/75)^0.684');
  t.close(p60.q, 0.168 * Math.pow(60 / 75, 0.75), 1e-12, 'Q allometry (WT/75)^0.75');
  var pOld = M.indivParams(75, 'PNH', 0, 0, 'crovalimab', 72);
  t.close(pOld.ka, 0.126 * Math.pow(72 / 36, -0.459), 1e-12, 'ka age scaling (age/36)^-0.459');
  t.ok(pOld.ka < p36.ka, 'older patient -> slower SC absorption');
  var pNoAge = M.indivParams(75, 'PNH', 0, 0, 'crovalimab');
  t.close(pNoAge.ka, 0.126, 1e-12, 'ka falls back to the reference age when age is omitted');

  // ---- 3. mixed IV + SC routes through the same observation compartment ----
  // IV loading dose peaks at the end of its short infusion; an equal SC dose
  // peaks much later and lower (absorption-limited).
  var times = [0.05, 0.2, 0.5, 1, 3, 7, 14, 21];
  var iv = M.simulate([{ t: 0, amt: 1000, route: 'iv' }], times, p36, { id: 'crovalimab' }).c;
  var sc = M.simulate([{ t: 0, amt: 1000, route: 'sc' }], times, p36, { id: 'crovalimab' }).c;
  function argmax(a) { var m = 0; for (var i = 1; i < a.length; i++) if (a[i] > a[m]) m = i; return m; }
  t.ok(argmax(iv) <= 1, 'IV loading dose peaks around the end of its infusion');
  t.ok(argmax(sc) >= 3, 'SC dose peaks days later (depot absorption)');
  t.ok(sc[argmax(sc)] < iv[argmax(iv)], 'SC peak lower than IV peak at the same dose');
  // IV dose goes straight to the central compartment (no depot delay)
  t.ok(iv[0] > sc[0] * 5, 'IV dose appears in plasma far earlier than SC');
  // bioavailability: long-window AUC ratio SC/IV ~ F = 0.83
  var longT = [1, 2, 4, 8, 16, 32, 64, 128, 200];
  function trapz(ts, cs) { var a = 0; for (var i = 1; i < ts.length; i++) a += (cs[i] + cs[i - 1]) / 2 * (ts[i] - ts[i - 1]); return a; }
  var ivL = M.simulate([{ t: 0, amt: 680, route: 'iv' }], longT, p36, { id: 'crovalimab' }).c;
  var scL = M.simulate([{ t: 0, amt: 680, route: 'sc' }], longT, p36, { id: 'crovalimab' }).c;
  var fRatio = trapz(longT, scL) / trapz(longT, ivL);
  t.ok(fRatio > 0.72 && fRatio < 0.95, 'SC/IV AUC ratio reflects F = 0.83 (got ' + fRatio.toFixed(2) + ')');

  // ---- 4. typical-patient plausibility: loading + q2w SC maintenance ----
  // EMA PiaSky-like: 1000 mg IV loading, then 680 mg SC. Simulate ~30 cycles
  // and check the system settles to a repeating cycle (steady state).
  var K = 30, I = 14, doses = [];
  doses.push({ t: 0, amt: 1000, route: 'iv' });
  for (var k = 1; k <= K; k++) doses.push({ t: k * I, amt: 680, route: 'sc' });
  var trT = [(K - 2) * I - 1e-6, (K - 1) * I - 1e-6, K * I - 1e-6];
  var simSS = M.simulate(doses, trT, p36, { rtol: 1e-8, id: 'crovalimab' });
  t.ok(!simSS.failed && simSS.c.every(function (v) { return isFinite(v) && v > 0; }),
    'crovalimab loading + q2w SC simulation finite');
  t.close(simSS.c[1], simSS.c[2], 0.02, 'q2w SC troughs repeat at steady state (75 kg, 36 y)');
  t.ok(simSS.c[2] > 40 && simSS.c[2] < 3000,
    'steady-state trough plausible for C5 inhibition (' + simSS.c[2].toFixed(0) + ' µg/mL)');
  // terminal half-life scale: concentration falls ~50% over ~53 days after stopping
  var stopT = [K * I + 1, K * I + 1 + 53];
  var sStop = M.simulate(doses, stopT, p36, { rtol: 1e-8, id: 'crovalimab' }).c;
  var frac = sStop[1] / sStop[0];
  t.ok(frac > 0.4 && frac < 0.68, 'decline over ~53 d consistent with the reported terminal t½ (fraction ' + frac.toFixed(2) + ')');

  // ---- 5. MAP recovery through runFit (age threaded through) ----
  var rng = B.mulberry32(7);
  var g = B.gaussFactory(rng);
  var etaTrue = [0.3, -0.25];
  var pTrue = M.indivParams(60, 'PNH', etaTrue[0], etaTrue[1], 'crovalimab', 50);
  var dAll = [{ t: 0, amt: 1000, route: 'iv' }];
  for (var k2 = 1; k2 <= 4; k2++) dAll.push({ t: k2 * I, amt: 680, route: 'sc' });
  var obsTimes = [I - 1e-6, 2 * I - 1e-6, 3 * I - 1e-6, 4 * I - 1e-6];
  var sTrue = M.simulate(dAll, obsTimes, pTrue, { rtol: 1e-8, id: 'crovalimab' }).c;
  var sig = s.SIGMA;
  var obs = sTrue.map(function (c, i) {
    var sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
    return { t: obsTimes[i], c: Math.max(1e-6, c + sd * g() / Math.sqrt(3)), lloq: false };
  });
  var fit = await B.runFit({ wt: 60, age: 50, disease: 'PNH', drug: 'crovalimab',
    doses: dAll, obs: obs, lloq: 0, target: 75, seed: 5, mcmcIters: 800 }, {});
  t.ok(fit.hasObs && isFinite(fit.map.ofv), 'crovalimab MAP finite');
  t.ok(Math.abs(fit.map.etaCL - etaTrue[0]) < 0.6 && Math.abs(fit.map.etaV1 - etaTrue[1]) < 0.6,
    'crovalimab MAP recovers simulated etas (got ' + fit.map.etaCL.toFixed(2) + ', ' + fit.map.etaV1.toFixed(2) + ')');
  t.ok(fit.clQ.med > 0.02 && fit.clQ.med < 0.4, 'crovalimab CL posterior in a sensible range (' + fit.clQ.med.toFixed(3) + ' L/day)');
  t.ok(fit.troughs.length > 0 && fit.troughs[fit.troughs.length - 1].pTarget >= 0 && fit.troughs[fit.troughs.length - 1].pTarget <= 1,
    'trough P(target) computed for crovalimab');

  // restore default
  M.select('eculizumab');
  t.eq(M.drug().id, 'eculizumab', 'default drug restored after the suite');
  t.ok(M.listDrugs().length >= 3, 'drug list exposes eculizumab, ravulizumab and crovalimab');

  return t.summary();
}

module.exports = { run: run };
