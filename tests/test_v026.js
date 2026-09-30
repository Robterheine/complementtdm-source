'use strict';
/* v0.26.0 — Independent audit (INDEPENDENT_AUDIT.md) finding F8.
 *
 * Two unrelated bounds were "the wrong walls": too permissive on one side,
 * too strict on the other.
 *
 *   - Age: crovalimab's ka = 0.126*(age/36)^-0.459 is an adult-population
 *     formula, but the input gate accepted age 1-100 uniformly across all
 *     three drugs (only crovalimab has an age covariate at all). Resolved
 *     per the author's exact instruction: age < 12 refused outright
 *     (crovalimab only); age 12-16 runs but is flagged, non-blocking,
 *     because the model was not developed for children; age >= 17 is
 *     silent. Ravulizumab/eculizumab have no age covariate and are
 *     untouched -- ravulizumab gets a plain informational note ("developed
 *     for adults"), eculizumab gets nothing, per the author's own read of
 *     each model's population.
 *
 *   - Weight: 35-200 kg was a hard, unsourced refusal that excluded real,
 *     plausible obese PNH/aHUS patients outright. Widened to 25-300 kg
 *     (author's own judgement of "should capture all adults"), applied
 *     uniformly to all three drugs (weight is a covariate everywhere via
 *     allometric scaling) -- a wider hard bound, not a warning-based one;
 *     the author chose the simpler of the audit's two suggested options.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches headless-safe UI internals via ECU

var CROVALIMAB_LOADING = [
  { t: 0, amt: 1000, route: 'iv' }, { t: 1, amt: 340, route: 'sc' },
  { t: 8, amt: 340, route: 'sc' }, { t: 15, amt: 340, route: 'sc' }, { t: 22, amt: 340, route: 'sc' },
  { t: 50, amt: 680, route: 'sc' }
];

async function run() {
  var t = new T('v0.26.0 audit F8 — crovalimab pediatric gate + widened weight bound');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ======================= 1. declared thresholds =========================
  t.eq(M.spec('crovalimab').pediatricBlockAge, 12, 'crovalimab: hard-block below age 12');
  t.eq(M.spec('crovalimab').pediatricWarnAge, 17, 'crovalimab: warning band ends at age 17 (i.e. covers 12-16)');
  ['eculizumab', 'ravulizumab'].forEach(function (id) {
    t.ok(!M.spec(id).pediatricBlockAge, id + ': no pediatric gate declared (no age covariate to gate)');
  });

  // ======================= 2. crovalimab age gate, via the real engine ====
  M.select('crovalimab');
  function fitAt(age) {
    return B.runFit({ wt: 40, disease: 'PNH', drug: 'crovalimab', age: age, doses: CROVALIMAB_LOADING, obs: [], lloq: 0, target: 75, seed: 2 });
  }

  var blockedAges = [1, 6, 11];
  for (var bi = 0; bi < blockedAges.length; bi++) {
    var age = blockedAges[bi], threw = false, msg = '';
    try { await fitAt(age); } catch (e) { threw = true; msg = e.message; }
    t.ok(threw, 'age ' + age + ' (< 12): runFit throws rather than silently extrapolating');
    if (threw) t.ok(/12/.test(msg) && /child/i.test(msg), 'age ' + age + ': error names the threshold and the reason');
  }

  var warnAges = [12, 13, 16, 16.9];
  for (var wi = 0; wi < warnAges.length; wi++) {
    var fWarn = await fitAt(warnAges[wi]);
    t.eq(fWarn.pediatricWarn, true, 'age ' + warnAges[wi] + ' (12–16): runs, and is flagged pediatricWarn=true');
  }

  var silentAges = [17, 18, 40, 90];
  for (var si = 0; si < silentAges.length; si++) {
    var fOk = await fitAt(silentAges[si]);
    t.eq(fOk.pediatricWarn, false, 'age ' + silentAges[si] + ' (≥ 17): runs silently, pediatricWarn=false');
  }

  // ======================= 3. eculizumab / ravulizumab are untouched ======
  M.select('eculizumab');
  // wt: 70 deliberately -- comfortably inside BOTH the old and new weight
  // bounds, since this check's purpose is the age gate, not the weight one;
  // a weight near either boundary would make this assertion accidentally
  // sensitive to a completely different sabotage (found the hard way: an
  // earlier draft used wt: 30, valid only under the new 25-300 kg bound,
  // which crashed this test uncaught the moment the weight-bound sabotage
  // below was applied, for a reason unrelated to what was being tested).
  var fEcuChild = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', age: 3,
    doses: [{ t: 0, amt: 900, route: 'iv' }], obs: [], lloq: 0, target: 75, seed: 2
  });
  t.eq(fEcuChild.pediatricWarn, false, 'eculizumab: a young age never triggers pediatricWarn (no covariate, suitable for children per the author)');

  M.select('ravulizumab');
  var fRav = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'ravulizumab', age: 5,
    doses: [{ t: 0, amt: 3000, route: 'iv' }], obs: [], lloq: 0, target: 75, seed: 2
  });
  t.eq(fRav.pediatricWarn, false, 'ravulizumab: age is not even a covariate, so pediatricWarn never fires (the "adult" note is informational only)');
  t.ok(ui.indexOf("ravulizumab: 'IV infusion over 2.5 h. Developed for adults.'") >= 0,
    'ravulizumab’s drug hint states "Developed for adults" as plain fact, not a warning');
  t.ok(M.spec('ravulizumab').assumptions.some(function (a) { return /adult population/i.test(a); }),
    'ravulizumab’s assumptions (About/report) also state the adult-population fact');

  // ======================= 4. UI wiring (source-level) =====================
  t.ok(ui.indexOf('fit.pediatricWarn') >= 0, 'the advisory block checks fit.pediatricWarn');
  t.ok(ui.indexOf('was not developed for children') >= 0, 'a "not developed for children" advisory string exists');
  // scoped to updateRunReady's OWN body (not just "found somewhere in the
  // file") -- the same literal also appears, correctly, in runFit()'s click
  // handler a few hundred lines later, so an unscoped indexOf() cannot tell
  // updateRunReady's own check apart from that other, unrelated one.
  function bodyOf(name) {
    var start = ui.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = ui.indexOf('\n  }', start);
    return end < 0 ? ui.slice(start) : ui.slice(start, end + 4);
  }
  // v0.46.0: the gate moved into ageReason(), which updateRunReady calls with the current drug's spec
  t.ok(bodyOf('ageReason').indexOf('spec.pediatricBlockAge || 1') >= 0 && /ageReason\(M\.drug\(\)/.test(bodyOf('updateRunReady')) && !/[<>]=? *12\b/.test(bodyOf('ageReason')),
    'updateRunReady’s own age gate (ageReason) is crovalimab-scoped via pediatricBlockAge, not a hardcoded 12');

  // ======================= 5. weight: widened to 25-300 everywhere ========
  // (v0.38.0: the 25-300 literal became a per-drug spec field, weightRange;
  // the sites are pinned in tests/test_v038.js. What stays true here: the old
  // 35-200 bound is gone, and 25 kg is still accepted by every drug.)
  t.ok(bayes.indexOf('input.wt >= 35 && input.wt <= 200') < 0, 'the old 35–200 kg bound is gone from bayes.js');
  t.ok(ui.indexOf('35 && state.patient.wt <= 200') < 0 && ui.indexOf('wt >= 35 && wt <= 200') < 0,
    'no remaining 35–200 weight literal in ui.js');

  var weightCases = [
    ['eculizumab', [{ t: 0, amt: 900, route: 'iv' }], null],
    ['ravulizumab', [{ t: 0, amt: 3000, route: 'iv' }], null],
    ['crovalimab', [{ t: 0, amt: 1000, route: 'iv' }, { t: 1, amt: 340, route: 'sc' }], 40]
  ];
  for (var ci = 0; ci < weightCases.length; ci++) {
    var id = weightCases[ci][0], d = weightCases[ci][1], age2 = weightCases[ci][2];
    M.select(id);
    try {
      await B.runFit({ wt: 25, disease: 'PNH', drug: id, age: age2, doses: d, obs: [], lloq: 0, target: 75, seed: 2 });
      t.ok(true, id + ': 25 kg (new lower bound) runs without throwing');
    } catch (e) {
      t.ok(false, id + ': 25 kg unexpectedly threw: ' + e.message);
    }
  }

  return t.summary();
}

module.exports = { run: run };
