'use strict';
/* v0.45.0 — outputs that looked reassuring for the wrong reason
 * (review 2026-09-30: S1, U1, U4).
 *
 * S1. F7 suppressed the chart's projected continuation while a crovalimab
 *     patient had <= 5 doses (the loading phase). The 6th dose is the FIRST
 *     maintenance dose, the gap to the next one is unknown, and the old rule
 *     let `modalInterval` read the loading spacing (q7d) for 6, 7 and 8 doses:
 *     the app then assumed 680 mg WEEKLY, about 4x the real exposure, and
 *     printed P > 99%. Eculizumab did the same at 7 doses (weekly x4, then
 *     q14d), because on a tie `modalInterval` kept the OLDEST mode.
 *     Now:
 *       - the loading guard runs through the first maintenance dose;
 *       - for a drug with a declared loading phase, the interval is taken from
 *         the post-loading doses only;
 *       - ties go to the most recent interval;
 *       - when the last two spacings disagree (an interval was just changed, or
 *         loading just ended) the app does not guess: no assumed next-dose
 *         trough, no projected doses, and the regimen explorer is not prefilled
 *         with a guessed interval;
 *       - a regimen the clinician entered (planned) is theirs and bypasses all
 *         of the above.
 *
 * U1. The crovalimab Route select offered only iv/sc and never moved off IV,
 *     so the coded "first dose IV, later SC" fallback was unreachable and every
 *     340 mg SC dose was silently fitted as IV. There is now an Auto option
 *     (the default) that resolves by position, plus a question when a later
 *     crovalimab dose is explicitly set to IV.
 *
 * U4. The "a dose is already recorded within 24 hours" prompt fired on the
 *     standard crovalimab start (IV at 14:00, first SC dose at 09:00 next day,
 *     19 h apart). It now only fires for the same route.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/chart.js');
require('../src/diagnostics.js');
require('../src/ui.js');

var ROOT = require('path').resolve(__dirname, '..');

function doses(ts, amt, firstRoute, route) {
  return ts.map(function (t, i) { return { t: t, amt: amt, route: i === 0 ? firstRoute : route }; });
}
async function fit(drug, ds, planned) {
  M.select(drug);
  return B.runFit({ wt: 70, age: drug === 'crovalimab' ? 40 : null, disease: 'PNH', drug: drug, doses: ds, obs: [],
    lloq: 0, target: 75, seed: 7, priorDraws: 60, planned: planned || null }, {});
}
function hasAssumed(f) { return f.troughs.some(function (t) { return t.assumed; }); }

async function run() {
  var t = new T('v0.45.0 loading-phase projection, route default, duplicate-dose prompt');

  // ---- S1: modalInterval ------------------------------------------------------
  M.select('eculizumab');
  var mk = function (ts) { return ts.map(function (x) { return { t: x, amt: 900 }; }); };
  t.eq(B.modalInterval(mk([0, 7, 14, 21, 28, 42, 56])), 14, 'eculizumab weekly x4 then q14d (7 doses): q14d, not the older q7d');
  t.eq(B.modalInterval(mk([0, 7, 14, 21, 28, 42, 56, 70])), 14, 'eculizumab, 8 doses: q14d');
  t.eq(B.modalInterval(mk([0, 14, 28, 42, 56, 70])), 14, 'steady q14d is still q14d');
  t.eq(B.modalInterval(mk([0, 21, 42, 63, 84])), 21, 'a prolonged q3w schedule is still q3w');

  M.select('crovalimab');
  var cro = [0, 1, 7, 14, 21, 28, 56, 84, 112];
  t.eq(B.modalInterval(mk(cro.slice(0, 7))), 28, 'crovalimab, 7 doses: the interval comes from the post-loading doses only (q28d)');
  t.eq(B.modalInterval(mk(cro.slice(0, 8))), 28, 'crovalimab, 8 doses: q28d');
  t.eq(B.modalInterval(mk(cro)), 28, 'crovalimab, 9 doses: q28d (unchanged)');

  // ---- S1: the pin from the review -------------------------------------------
  var c6 = await fit('crovalimab', doses([0, 1, 7, 14, 21, 28], 340, 'iv', 'sc'));
  t.ok(c6.loadingPhase === true, 'crovalimab with 6 doses (first maintenance dose just given) is still the loading phase');
  t.eq(c6.chartProjectedDoses.length, 0, '6 doses: no projected doses are drawn');
  t.ok(!hasAssumed(c6), '6 doses: NO assumed next-dose trough (it used to be q7d, about 4x the real exposure)');
  t.ok(c6.intervalTrusted === false, '6 doses: the interval is flagged as not trusted (explorer must not prefill it)');

  var c5 = await fit('crovalimab', doses([0, 1, 7, 14, 21], 340, 'iv', 'sc'));
  t.ok(c5.loadingPhase === true && !hasAssumed(c5) && c5.chartProjectedDoses.length === 0, '5 doses: no assumed trough and no projection either');

  var c7 = await fit('crovalimab', doses([0, 1, 7, 14, 21, 28, 56], 680, 'iv', 'sc'));
  t.ok(c7.loadingPhase === false, '7 doses: one real maintenance spacing exists, loading guard lifted');
  t.eq(c7.interval, 28, '7 doses: interval q28d');
  var a7 = c7.troughs.filter(function (x) { return x.assumed; })[0];
  t.ok(!!a7 && Math.abs(a7.t - (56 + 28)) < 1e-3, '7 doses: the assumed trough is one q28d interval after the last dose');
  t.ok(c7.chartProjectedDoses.length > 0 && Math.abs(c7.chartProjectedDoses[0].t - 84) < 1e-9, '7 doses: projection continues at q28d');
  t.ok(c7.intervalTrusted === true, '7 doses: the interval is trusted');

  // ---- S1: planned regimen bypasses the gates --------------------------------
  var c6p = await fit('crovalimab', doses([0, 1, 7, 14, 21, 28], 340, 'iv', 'sc'), { amt: 680, interval: 28 });
  var ap = c6p.troughs.filter(function (x) { return x.assumed; })[0];
  t.ok(!!ap && Math.abs(ap.t - (28 + 28)) < 1e-3, 'loading phase + a planned regimen: the planned next-dose trough is shown (clinician-entered)');
  t.ok(c6p.chartProjectedDoses.length > 0 && c6p.intervalTrusted === true, 'loading phase + planned: projection follows the plan, interval trusted');
  t.ok(c6p.loadingPhase === true, 'the fact that loading is not finished is still reported');

  // ---- S1: last two spacings disagree ----------------------------------------
  var e6 = await fit('eculizumab', doses([0, 7, 14, 21, 28, 42], 900, null, null));
  t.ok(e6.spacingUnsettled === true, 'eculizumab [..,7,7,14]: the last two spacings disagree');
  t.ok(!hasAssumed(e6) && e6.chartProjectedDoses.length === 0, 'so there is no assumed trough and no projection');
  t.ok(e6.intervalTrusted === false, 'and the interval is not trusted');
  var e7 = await fit('eculizumab', doses([0, 7, 14, 21, 28, 42, 56], 900, null, null));
  t.ok(e7.spacingUnsettled === false && e7.interval === 14 && hasAssumed(e7), 'eculizumab 7 doses: settled at q14d, assumed trough present');

  var ext = await fit('eculizumab', doses([0, 14, 28, 42, 56, 70, 91], 900, null, null));
  t.ok(ext.spacingUnsettled === true && !hasAssumed(ext), 'q14d then one q21d gap (an interval extension): not guessed');
  var extP = await fit('eculizumab', doses([0, 14, 28, 42, 56, 70, 91], 900, null, null), { amt: 900, interval: 21 });
  t.ok(hasAssumed(extP) && extP.intervalTrusted === true, 'the same history with a planned q21d regimen gives the planned trough');

  var jit = await fit('eculizumab', doses([0, 14, 28, 43, 57, 71], 900, null, null));
  t.ok(jit.spacingUnsettled === false && hasAssumed(jit), 'a q14d schedule with one day of jitter is settled');
  var late = await fit('eculizumab', doses([0, 14, 28, 42, 56, 73], 900, null, null));
  t.ok(late.spacingUnsettled === false, 'one dose three days late (14 then 17) is still settled');

  var prol = await fit('eculizumab', doses([0, 21, 42, 63, 84], 900, null, null));
  t.ok(prol.loadingPhase === false && prol.spacingUnsettled === false && hasAssumed(prol), 'a 5-dose prolonged q3w eculizumab schedule is neither loading nor unsettled');

  var one = await fit('eculizumab', doses([0], 900, null, null));
  t.ok(!hasAssumed(one), 'a single dose still assumes nothing (v0.32.0 behaviour)');
  var oneP = await fit('eculizumab', doses([0], 900, null, null), { amt: 900, interval: 14 });
  t.ok(hasAssumed(oneP), 'a single dose with a planned regimen still gives the planned trough (v0.40.0 behaviour)');

  // ---- U1: route default ------------------------------------------------------
  t.ok(typeof ECU.resolveDoseRoute === 'function', 'ECU.resolveDoseRoute is exported');
  if (typeof ECU.resolveDoseRoute === 'function') {
    var cs = M.spec('crovalimab'), es = M.spec('eculizumab');
    t.eq(ECU.resolveDoseRoute(cs, 'auto', 0), 'iv', 'Auto: the first crovalimab dose is IV');
    t.eq(ECU.resolveDoseRoute(cs, 'auto', 1), 'sc', 'Auto: the second is SC');
    t.eq(ECU.resolveDoseRoute(cs, 'auto', 6), 'sc', 'Auto: and every later one');
    t.eq(ECU.resolveDoseRoute(cs, 'iv', 3), 'iv', 'an explicit IV is honoured');
    t.eq(ECU.resolveDoseRoute(cs, 'sc', 0), 'sc', 'an explicit SC is honoured');
    t.eq(ECU.resolveDoseRoute(cs, '', 2), 'sc', 'an empty value behaves like Auto');
    t.eq(ECU.resolveDoseRoute(es, 'auto', 3), null, 'eculizumab has no route concept');
  }
  var html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  var sel = html.slice(html.indexOf('id="dose-route"'), html.indexOf('</select>', html.indexOf('id="dose-route"')));
  t.ok(/<option value="auto"/.test(sel), 'the Route select has an Auto option');
  t.ok(sel.indexOf('value="auto"') < sel.indexOf('value="iv"'), 'Auto is the first (default) option');
  var ui = fs.readFileSync(ROOT + '/src/ui.js', 'utf8');
  t.ok(/resolveDoseRoute\(/.test(ui.slice(ui.indexOf("$('doseForm').addEventListener('submit'"))), 'the dose form resolves the route through resolveDoseRoute');
  t.ok(/Crovalimab is given IV only/.test(ui), 'a later crovalimab dose set explicitly to IV asks for confirmation');

  // ---- U4: duplicate-dose prompt ---------------------------------------------
  t.ok(typeof ECU.isDuplicateDose === 'function', 'ECU.isDuplicateDose is exported');
  if (typeof ECU.isDuplicateDose === 'function') {
    var H = 3600000, d0 = Date.UTC(2026, 8, 10, 14);
    var cur = [{ t: d0, amt: 1000, route: 'iv' }];
    t.ok(!ECU.isDuplicateDose(cur, d0 + 19 * H, 'sc'), 'IV at 14:00 then SC at 09:00 next day (19 h) is the standard start: no prompt');
    t.ok(ECU.isDuplicateDose(cur, d0 + 19 * H, 'iv'), 'the same route 19 h apart still prompts');
    t.ok(ECU.isDuplicateDose(cur, d0 + 2 * H, 'sc') === false, 'different routes never prompt');
    t.ok(ECU.isDuplicateDose([{ t: d0, amt: 900, route: null }], d0 + 5 * H, null), 'no-route drugs: 5 h apart still prompts');
    t.ok(!ECU.isDuplicateDose([{ t: d0, amt: 900, route: null }], d0 + 25 * H, null), '25 h apart does not prompt');
  }

  // ---- UI wiring (structural; the DOM itself is checked in the browser) ------
  t.ok(/fit\.intervalTrusted/.test(ui) || /intervalTrusted/.test(ui), 'the explorer consults intervalTrusted');
  t.ok(/spacingUnsettled/.test(ui), 'the UI explains an unsettled spacing');

  return t.summary();
}

module.exports = { run: run };
