'use strict';
/* v0.19.0 — two pieces of direct author feedback.
 *
 *   1. Regimen-explorer interval candidates must always be whole weeks.
 *      "Every 6 days" is arithmetically fine but clinically undoable: a
 *      fixed non-7-multiple interval drifts across weekdays every cycle,
 *      and every real regimen for these agents (q2w, q4w, q8w...) is in
 *      fact quoted in weeks. candidateIntervals() previously applied
 *      fractional multipliers to the current interval and rounded to the
 *      nearest whole DAY, which can and did produce non-week values
 *      (14 x 1.25 = 17.5 -> rounds to 18, not a multiple of 7).
 *   2. The stepper should still reach step 4 ("Explore regimen"), matching
 *      card 4 — v0.16.0 had deliberately left it out on the reasoning that
 *      the explorer is a downstream/optional tool, but the numbers-must-
 *      match-the-cards principle from that same release argues for keeping
 *      it, simply gated on a forecast existing first.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.19.0 weekly interval candidates + stepper step 4');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ---- 1. candidateIntervals: always whole weeks ------------------------
  [7, 10, 14, 21, 28, 42, 56, 84].forEach(function (cur) {
    var cand = B.candidateIntervals(cur);
    t.ok(cand.length > 0, 'candidateIntervals(' + cur + ') returns something');
    t.ok(cand.every(function (v) { return v % 7 === 0; }),
      'candidateIntervals(' + cur + '): every candidate is a multiple of 7 (got [' + cand.join(',') + '])');
    t.ok(cand.every(function (v) { return v > 0; }), 'candidateIntervals(' + cur + '): every candidate is positive');
    t.ok(cand.length === cand.filter(function (v, i) { return cand.indexOf(v) === i; }).length,
      'candidateIntervals(' + cur + '): no duplicate candidates');
    var sorted = cand.slice().sort(function (a, b) { return a - b; });
    t.eq(cand.join(','), sorted.join(','), 'candidateIntervals(' + cur + '): already sorted ascending');
  });

  // the drugs' own real intervals must always be reproducible as a candidate
  t.ok(B.candidateIntervals(14).indexOf(14) >= 0, 'q2w (eculizumab) reproduces itself as a candidate');
  t.ok(B.candidateIntervals(28).indexOf(28) >= 0, 'q4w (crovalimab) reproduces itself as a candidate');
  t.ok(B.candidateIntervals(56).indexOf(56) >= 0, 'q8w (ravulizumab) reproduces itself as a candidate');

  // enough candidates to show a trend, and prolongation-favoured (this
  // app's primary use case — more candidates above the current interval
  // than below it)
  var c14 = B.candidateIntervals(14);
  t.ok(c14.length >= 6, 'still enough candidates after the weekly-snap redesign (got ' + c14.length + ')');
  t.ok(c14.filter(function (v) { return v > 14; }).length > c14.filter(function (v) { return v < 14; }).length,
    'the spread favours prolongation (more candidates above the current interval than below)');

  // a short, non-whole-week baseline (defensive: modalInterval's fallback
  // could in principle hand this a value that isn't itself a multiple of 7)
  var c10 = B.candidateIntervals(10);
  t.ok(c10.every(function (v) { return v % 7 === 0; }), 'a non-week input (10d) still yields only week-multiple candidates');

  // ---- integration: doseScan's fixed interval doesn't need to be a week
  // (a clinician exploring a DOSE change keeps their own entered interval
  // fixed, whatever it is) — only the INTERVAL-scan candidates are snapped.
  M.select('eculizumab');
  var doses = [];
  for (var k = 0; k < 4; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });
  var fit = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [{ t: 41.9, c: 150, lloq: false }], lloq: 0, target: 75, seed: 3
  });
  var ivs = B.candidateIntervals(fit.interval);
  var scan = await B.intervalScan({
    draws: fit.draws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, amt: 900, intervals: ivs
  });
  t.eq(scan.length, ivs.length, 'intervalScan evaluates every weekly candidate');
  scan.forEach(function (r) {
    t.ok(r.interval % 7 === 0, 'every regimen actually scanned/proposed is a whole week (got ' + r.interval + ')');
  });

  // ---- 2. stepper step 4 ---------------------------------------------------
  t.ok(/<span class="step" data-step="explore">/.test(html), 'a step-4 element (data-step="explore") exists in the stepper');
  t.ok(/<i>4<\/i>\s*Explore regimen/.test(html), 'step 4 is numbered 4 and labelled "Explore regimen", matching card 4');
  t.ok(ui.indexOf('var exploreDone = !!(state.fit && state.fit.intervalScan);') >= 0,
    'step 4\'s completion is tied to an exploration actually having been run');
  t.ok(ui.indexOf("set('explore', exploreDone, runDone);") >= 0,
    'step 4 becomes active once step 3 (Run forecast) is done, not before');
  t.ok(ui.indexOf('state.fit.intervalScan = { mode: vary, amt: amt, interval: iv, baseline: baseline, rows: scan };\n      renderIntervalScan();\n      updateStepper();') >= 0,
    'the stepper is refreshed immediately after a successful regimen exploration');

  return t.summary();
}

module.exports = { run: run };
