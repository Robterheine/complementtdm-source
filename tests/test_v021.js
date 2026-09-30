'use strict';
/* v0.21.0 — time-dependent weighting of older samples, as a SIGMA setting.
 *
 * v0.20.0 shipped this feature keyed to each model's between-occasion variance
 * (IOV_CL), which made it unavailable for three of the four drug/disease
 * combinations. That was the wrong level of the model: IOV is a random-effect
 * (OMEGA) term, whereas down-weighting an old measurement is a statement about
 * the residual error (SIGMA). v0.21.0 re-expresses it as exactly that — the
 * existing assay-error multiplier, made time-dependent:
 *
 *     SD_i = SD_base(pred_i) * errMult * m(age_i)
 *     m(age) = 1 + (Mmax - 1) * (1 - exp(-age / 365 d))
 *
 * Consequences asserted below, each of which is the point of the design:
 *   - m(0) = 1 exactly: the newest sample is never inflated;
 *   - m saturates at Mmax, so a sample is down-weighted but never discarded;
 *   - the realised weight is exactly 1/m^2, with NO dependence on the sample's
 *     concentration, on the drug, or on the disease;
 *   - it behaves identically for every drug, including the three whose models
 *     carry no IOV term at all.
 *
 * Presets set Mmax — how much the residual error grows: low 1.5, medium 2,
 * high 3. The time constant is shared, so the tiers differ in strength, not in
 * shape. "High" therefore means MORE inflation and LESS weight on old samples;
 * that direction is pinned numerically, because it is the thing a later
 * refactor is most likely to invert.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.21.0 time-dependent residual error (sigma) for older samples');
  var html = fs.readFileSync('index.html', 'utf8');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var idx = function (needle) { return html.indexOf(needle); };

  // ======================= 1. presets ====================================
  t.eq(B.recencyMaxMult('off'), 1, 'off => no inflation');
  t.eq(B.recencyMaxMult('low'), 1.5, 'low => residual SD up to x1.5');
  t.eq(B.recencyMaxMult('medium'), 2, 'medium => up to x2');
  t.eq(B.recencyMaxMult('high'), 3, 'high => up to x3');
  t.eq(B.RECENCY_TAU_DAYS, 365, 'one shared time constant of 365 days');
  // a pre-v0.21.0 session, a hand-edited JSON or a renamed preset must all
  // degrade to "no inflation", never to NaN or an accidental tier
  t.eq(B.recencyMaxMult(undefined), 1, 'an absent preset (older saved session) => off');
  t.eq(B.recencyMaxMult('nonsense'), 1, 'an unknown preset => off');
  t.eq(B.recencyMaxMult(null), 1, 'null => off');
  t.ok(B.recencyMaxMult('high') > B.recencyMaxMult('medium') &&
       B.recencyMaxMult('medium') > B.recencyMaxMult('low'),
    'HIGH = MORE inflation = LESS weight on old samples — the direction a refactor is most likely to invert');

  // ======================= 2. shape of m(age) ============================
  ['low', 'medium', 'high'].forEach(function (preset) {
    var mx = B.recencyMaxMult(preset);
    t.eq(B.recencyMult(preset, 0), 1, preset + ': the newest sample is inflated by exactly x1');
    t.eq(B.recencyMult(preset, -5), 1, preset + ': a negative age (cannot happen, but must not explode) gives x1');
    var prev = 1;
    [1, 30, 91, 182, 365, 730, 1825].forEach(function (age) {
      var m = B.recencyMult(preset, age);
      t.ok(m > prev, preset + ': inflation strictly increases with age (at ' + age + ' d)');
      t.ok(m < mx, preset + ': inflation never reaches, let alone exceeds, its ceiling (at ' + age + ' d)');
      prev = m;
    });
    t.close(B.recencyMult(preset, 3650), mx, 2e-3, preset + ': saturates at its ceiling by 10 years');
  });
  t.eq(B.recencyMult('off', 3650), 1, 'off: no inflation at any age');

  // the closed form, spelled out once
  t.close(B.recencyMult('medium', 365), 1 + 1 * (1 - Math.exp(-1)), 1e-12,
    'm(365 d) for medium is exactly 1 + (2-1)(1 - e^-1)');

  // ======================= 3. drug/disease independence ==================
  /* The whole point of v0.21.0. The multiplier must be identical everywhere,
   * including for the three models with no IOV term — the case v0.20.0 got
   * wrong by disabling the option entirely. */
  var ref = B.recencyMult('high', 365);
  [['eculizumab', 'aHUS'], ['eculizumab', 'PNH'], ['ravulizumab', 'PNH'], ['crovalimab', 'PNH']]
    .forEach(function (pair) {
      M.select(pair[0]);
      t.eq(B.recencyMult('high', 365), ref,
        pair[0] + '/' + pair[1] + ': the same multiplier — the setting is SIGMA, not OMEGA');
    });
  M.select('eculizumab');
  t.ok(bayes.indexOf('iovVar') < 0,
    'the engine\'s recency code no longer consults the model\'s between-occasion variance at all');
  t.ok(ui.indexOf('recencyApplies') < 0 && ui.indexOf('syncRecencyAvailability') < 0,
    'and the UI no longer has an availability gate — the option is always offered');

  // ======================= 4. the analytic pin ===========================
  /* Reconstruct the exact OFV difference between "off" and a tier from first
   * principles. The DIFFERENCE cancels the prior term, which is identical in
   * both. Goes red if the multiplier is dropped, mis-signed, applied to the
   * wrong observation, uses the wrong ceiling or time constant, is squared in
   * the wrong place, or loses its log-variance penalty. */
  var doses = [];
  for (var k = 0; k < 40; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });
  var T_OLD = 181.6, T_NEW = 545.6;               // 364 days apart
  var obs = [{ t: T_OLD, c: 62, lloq: false }, { t: T_NEW, c: 118, lloq: false }];
  var eta = [0.12, -0.05];
  var sig = M.spec('eculizumab').SIGMA;

  function ctxFor(preset, disease, drug) {
    return {
      wt: 70, disease: disease, drug: drug, doses: doses, obs: obs, lloq: 0,
      omega: M.priorOmega(disease, drug), rtol: 1e-6, errMult: 1, recency: preset
    };
  }

  var pars = M.indivParams(70, 'PNH', eta, 'eculizumab', null);
  var sim = M.simulate(doses, [T_OLD, T_NEW], pars, { rtol: 1e-6, id: 'eculizumab' });
  t.ok(!sim.failed, 'the reference simulation succeeded');

  ['low', 'medium', 'high'].forEach(function (preset) {
    var expected = 0;
    [T_OLD, T_NEW].forEach(function (ti, i) {
      var pred = sim.c[i], age = T_NEW - ti;
      var m = B.recencyMult(preset, age);
      var vOff = Math.max(sig.ADD + sig.PROP * pred * pred, 1e-6);
      var vOn = vOff * m * m;
      var d = obs[i].c - pred;
      expected += (d * d / vOn + Math.log(vOn)) - (d * d / vOff + Math.log(vOff));
    });
    // deliberately PNH: the combination v0.20.0 refused to apply this to
    var got = B.makeOfv(ctxFor(preset, 'PNH', 'eculizumab'))(eta) -
              B.makeOfv(ctxFor('off', 'PNH', 'eculizumab'))(eta);
    t.close(got, expected, 1e-9,
      'closed-form OFV shift for "' + preset + '" matches the implementation exactly (eculizumab/PNH)');
    t.ok(Math.abs(got) > 1e-6, '"' + preset + '" actually moves the OFV for a drug with no IOV term');
  });

  // errMult and the recency multiplier compose (both scale the same SD)
  var withErr = B.makeOfv(Object.assign(ctxFor('high', 'PNH', 'eculizumab'), { errMult: 2 }))(eta);
  var expectedErr = 0;
  [T_OLD, T_NEW].forEach(function (ti, i) {
    var pred = sim.c[i];
    var m = 2 * B.recencyMult('high', T_NEW - ti);
    var v = Math.max(sig.ADD + sig.PROP * pred * pred, 1e-6) * m * m;
    var d = obs[i].c - pred;
    expectedErr += d * d / v + Math.log(v);
  });
  var priorOnly = B.makeOfv({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, obs: [], lloq: 0,
    omega: M.priorOmega('PNH', 'eculizumab'), rtol: 1e-6, errMult: 1, recency: 'off' })(eta);
  t.close(withErr - priorOnly, expectedErr, 1e-9,
    'errMult and the recency multiplier compose on the SD, exactly as specified');

  // ======================= 5. a lone sample is untouched =================
  var solo = [{ t: T_NEW, c: 118, lloq: false }];
  ['low', 'medium', 'high'].forEach(function (preset) {
    var base = { wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, obs: solo, lloq: 0,
      omega: M.priorOmega('PNH', 'eculizumab'), rtol: 1e-6, errMult: 1 };
    t.eq(B.makeOfv(Object.assign({}, base, { recency: preset }))(eta),
         B.makeOfv(Object.assign({}, base, { recency: 'off' }))(eta),
      'a lone (therefore newest) sample is bit-identical under "' + preset + '"');
  });

  // ======================= 6. direction of the fit =======================
  /* The old sample is low (62) and the new one high (118). Inflating the old
   * one's error must pull the individual estimate TOWARDS the recent sample —
   * i.e. towards a lower clearance. Anything else means the sign is wrong. */
  var fitOff = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: obs, lloq: 0, target: 75, seed: 11, recency: 'off' });
  var fitHigh = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: obs, lloq: 0, target: 75, seed: 11, recency: 'high' });
  t.ok(fitHigh.clQ.med < fitOff.clQ.med,
    'down-weighting the older (lower) sample moves clearance towards the recent one — ' +
    fitOff.clQ.med.toFixed(4) + ' -> ' + fitHigh.clQ.med.toFixed(4));

  // ======================= 7. the fit echoes its settings ================
  t.eq(fitOff.recency, 'off', 'runFit echoes recency=off by default');
  t.eq(fitOff.recencyMaxMult, 1, 'and a ceiling of x1 when off');
  t.eq(fitHigh.recency, 'high', 'runFit echoes the preset it was given');
  t.eq(fitHigh.recencyMaxMult, 3, 'and the ceiling it used');
  t.eq(fitHigh.recencyTau, 365, 'and the time constant it used');
  var fitBogus = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: obs, lloq: 0, target: 75, seed: 11, recency: 'turbo' });
  t.eq(fitBogus.recency, 'off', 'an unrecognised preset is reported as the "off" it actually was');

  // ======================= 8. per-sample disclosure ======================
  var od = fitHigh.obsData;
  t.eq(od.length, 2, 'obsData still carries every observation');
  t.close(od[0].ageDays, 364, 1e-6, 'the older sample is reported as 364 days older than the newest');
  t.eq(od[1].ageDays, 0, 'the newest sample is reported as age 0');
  t.eq(od[1].recencyMult, 1, 'the newest sample is inflated by exactly x1');
  t.eq(od[1].recencyWeight, 1, 'and keeps exactly 100% of its weight');
  t.close(od[0].recencyMult, B.recencyMult('high', 364), 1e-12,
    'the older sample reports the multiplier actually applied to it');
  t.close(od[0].recencyWeight, 1 / Math.pow(od[0].recencyMult, 2), 1e-12,
    'the realised weight is exactly 1/m^2 — no dependence on concentration');
  t.ok(fitOff.obsData.every(function (o) { return o.recencyWeight === 1 && o.recencyMult === 1; }),
    'with the option off every sample reports full weight');

  // ---- negative relative times (steady-state mode) ----------------------
  /* Found in v0.20.0 by driving the built artifact. In steady-state mode the
   * time origin is the LATEST DOSE, so samples drawn before it carry NEGATIVE
   * relative times; a "newest sample" scan seeded at 0 is then later than every
   * actual sample, and reports a discount on one the fit left alone. */
  var ssDoses = [];
  for (var sd = -39; sd <= 0; sd++) ssDoses.push({ t: sd * 14, amt: 900, route: 'iv' });
  var ssObs = [{ t: -364.4, c: 62, lloq: false }, { t: -0.4, c: 118, lloq: false }];
  var fitSS = await B.runFit({ wt: 72, disease: 'PNH', drug: 'eculizumab', doses: ssDoses,
    obs: ssObs, lloq: 0, target: 75, seed: 13, recency: 'high' });
  t.ok(fitSS.obsData.every(function (o) { return o.ageDays >= 0; }),
    'ages are never negative, even when every observation time is');
  t.eq(fitSS.obsData[1].ageDays, 0, 'the newest sample is age 0 on a negative-time (steady-state) schedule');
  t.eq(fitSS.obsData[1].recencyWeight, 1, 'and therefore keeps exactly full weight');
  t.close(fitSS.obsData[0].ageDays, 364, 1e-9, 'the older sample is still 364 days older than it');
  t.eq(fitSS.obsData.filter(function (o) { return o.recencyWeight < 0.995; }).length, 1,
    'exactly ONE of the two samples is reported as down-weighted — the advisory counts what the fit did');

  // ======================= 9. the UI =====================================
  t.ok(idx('id="pt-recency"') >= 0, 'the recency control exists');
  t.ok(idx('id="assayOptions"') >= 0, 'the "Assay settings" fold exists');
  t.ok(idx('>Advanced fitting options<') >= 0, 'card 3\'s fold is "Advanced fitting options"');
  t.ok(idx('Advanced options (assay)') < 0, 'the old "Advanced options (assay)" label is gone');
  t.ok(ui.indexOf('Advanced options (assay)') < 0, 'and nothing points users at that label by name');
  t.ok(idx('id="chartCard"') < idx('id="pt-lloq"') && idx('id="pt-lloq"') < idx('id="resultsCard"'),
    'LLOQ sits in card 2, beside the "< LLOQ" checkbox that needs it');
  t.ok(idx('id="chartCard"') < idx('id="pt-errmult"') && idx('id="pt-errmult"') < idx('id="resultsCard"'),
    'the assay error multiplier sits in card 2 with it');
  t.ok(idx('id="resultsCard"') < idx('id="pt-recency"'), 'the recency control sits in card 3');
  var obsFormEnd = html.indexOf('</form>', idx('id="obsForm"'));
  t.ok(obsFormEnd > 0 && obsFormEnd < idx('id="assayOptions"'),
    'the assay fold sits after </form>, outside the sample form\'s submit path');

  ['off', 'low', 'medium', 'high'].forEach(function (v) {
    t.ok(idx('<option value="' + v + '"') >= 0, 'preset "' + v + '" is offered');
  });
  var selBlock = html.slice(idx('id="pt-recency"'), html.indexOf('</select>', idx('id="pt-recency"')));
  t.ok(selBlock.indexOf('selected') < 0, 'no option is pre-selected — "off" wins by document order');
  t.ok(selBlock.indexOf('<option value="off"') < selBlock.indexOf('<option value="low"'),
    '"off" is the first option, and therefore the default');
  t.ok(selBlock.indexOf('disabled') < 0, 'the control is never shipped disabled');
  // the labels must quote the ceiling, since that is what the preset sets
  ['1.5', '2', '3'].forEach(function (m) {
    t.ok(selBlock.indexOf('×' + m) >= 0, 'the option labels quote the ×' + m + ' ceiling');
  });
  t.ok(/id="pt-recency"[^>]*title="/.test(html), 'the control carries a native title (tier-2 help convention)');
  t.ok(idx('data-help="recency"') >= 0, 'and a tier-3 help popover button');

  // ======================= 10. state plumbing ============================
  function bodyOf(name) {
    var start = ui.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = ui.indexOf('\n  }', start);
    return end < 0 ? ui.slice(start) : ui.slice(start, end + 4);
  }
  [['readPatient', 'pt-recency'], ['syncInputs', 'pt-recency'],
   ['saveSession', 'recency'], ['applySession', 's.recency'],
   ['importJson', 'c.recency'], ['cleanSession', 'data.recency'], ['exportJson', 'recency: state.recency']
  ].forEach(function (pair) {
    t.ok(bodyOf(pair[0]).indexOf(pair[1]) >= 0,
      pair[0] + '() carries the recency setting (' + pair[1] + ')');
  });
  t.ok(ui.indexOf("recency: state.recency || 'off',") >= 0,
    'the runFit input object passes it to the engine — without this the UI would show a preset the fit ignored');
  t.ok(bodyOf('cleanSession').indexOf('RECENCY_PRESETS.indexOf(data.recency)') >= 0,  // v0.44.0: both restore paths validate in cleanSession()
    'a session saved before this feature existed restores as "off", not undefined');
  var recHandler = ui.slice(ui.indexOf("recSel.addEventListener('change'"),
                            ui.indexOf("recSel.addEventListener('change'") + 320);
  t.ok(recHandler.indexOf('readPatient();') >= 0, 'the change handler reads the new preset');
  t.ok(recHandler.indexOf('syncRecencyHint();') >= 0,
    'and refreshes the hint line, which quotes the multiplier');
  t.ok(recHandler.indexOf('markStale();') >= 0,
    'and marks the forecast stale — markStale is also the sole autosave point');

  // ======================= 11. disclosure ================================
  t.ok(ui.indexOf('Weighting of older samples') >= 0, 'the report names the setting');
  t.ok(ui.indexOf('Older-sample weighting') >= 0, 'the report carries the per-sample realised weights');
  t.ok(ui.indexOf('residual SD ×') >= 0, 'including the multiplier actually applied to each sample');
  t.ok(ui.indexOf('is never estimated from the patient') >= 0 ||
       ui.indexOf('is ever estimated from the patient') >= 0,
    'About states the settings are never estimated from the patient\'s own data');
  t.ok(ui.indexOf('random-effect (OMEGA) term') >= 0,
    'About distinguishes this SIGMA setting from the OMEGA-level occasion variability');
  t.ok(ui.indexOf('widens the reported credible intervals') >= 0,
    'About states the honest consequence: a fit leaning on fewer samples is less certain, not more');

  return t.summary();
}

module.exports = { run: run };
