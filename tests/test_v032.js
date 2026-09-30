'use strict';
/* v0.32.0 — a single entered dose no longer projects a second, assumed one.
 *
 * Bug report (author, live use): entered exactly one eculizumab dose, and
 * the forecast chart showed two vertical dose lines, with "Projected dose
 * (not entered)" in the legend. Root cause: modalInterval() falls back to
 * the drug's own default maintenance interval (correct, existing behaviour,
 * v0.13.0 finding #1) whenever fewer than two real doses exist to derive a
 * genuine interval from -- and chartProjectedDoses/virtualTroughTime both
 * used that fallback to draw a "continuation" dose regardless of how many
 * real doses were actually on file. With exactly one dose, that continuation
 * is not a continuation of anything: there is no established regimen in the
 * data, only a guess at what the drug's typical interval usually is.
 *
 * Fix: both the chart's projected-dose continuation and the trough table's
 * "assumed dose" row now require at least TWO real entered doses (a
 * genuine, derivable interval) before projecting anything. With exactly one
 * dose, the chart shows only that one dose's own decay, and the trough
 * table falls back to its existing "no troughs yet" empty state -- both
 * already-existing, already-tested code paths, not new ones.
 *
 * modalInterval() itself is UNCHANGED (still used correctly elsewhere, e.g.
 * to prefill the steady-state interval field and the regimen explorer) --
 * only whether virtualTroughTime()/chartProjectedDoses ACT on its fallback
 * for fewer than two doses.
 */
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.32.0 no assumed continuation dose from a single entered dose');
  M.select('eculizumab');

  // ---- 1. virtualTroughTime: null for one dose, real for two or more -----
  var oneDose = [{ t: 0, amt: 900, route: 'iv' }];
  var twoDoses = [{ t: 0, amt: 900, route: 'iv' }, { t: 14, amt: 900, route: 'iv' }];
  t.eq(B.virtualTroughTime(oneDose, B.modalInterval(oneDose)), null,
    'a single dose has no established interval -- virtualTroughTime returns null, not a guessed one');
  t.eq(B.virtualTroughTime(twoDoses, B.modalInterval(twoDoses)), 14 + 14 - 1e-6,
    'two real doses establish a genuine interval -- virtualTroughTime still projects from it, unchanged');

  // ---- 2. troughTimesOf: empty for one dose, one entry for two -----------
  t.eq(B.troughTimesOf(oneDose, B.modalInterval(oneDose)).length, 0,
    'troughTimesOf() returns no trough times at all for a single dose (nothing real, nothing assumed)');
  t.eq(B.troughTimesOf(twoDoses, B.modalInterval(twoDoses)).length, 2,
    'troughTimesOf() still returns both the one real pre-dose trough and the one assumed continuation for two doses, unchanged');

  // ---- 3. full runFit, one dose: no chart continuation, no assumed trough
  var fitOne = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: oneDose,
    obs: [{ t: -0.01, c: 200, lloq: false }], lloq: 0, target: 75, seed: 11
  });
  t.eq(fitOne.chartProjectedDoses.length, 0,
    'a real one-dose fit produces zero chart-projected continuation doses');
  t.eq(fitOne.troughs.length, 0,
    'a real one-dose fit produces zero trough-table rows (no real trough exists yet, and nothing is assumed)');

  // ---- 4. full runFit, two doses: continuation and assumed row are back --
  var fitTwo = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: twoDoses,
    obs: [{ t: -0.01, c: 200, lloq: false }, { t: 13.99, c: 150, lloq: false }],
    lloq: 0, target: 75, seed: 11
  });
  t.ok(fitTwo.chartProjectedDoses.length > 0,
    'a genuine two-dose regimen still gets its chart continuation, unchanged from before this fix');
  t.ok(fitTwo.troughs.some(function (tr) { return tr.assumed; }),
    'a genuine two-dose regimen still gets its assumed-dose trough row, unchanged from before this fix');

  // ---- 5. the UI's existing empty-state message is what a one-dose fit now
  //         reaches (already-tested code path, just confirming it is wired) -
  var ui = require('fs').readFileSync('src/ui.js', 'utf8');
  t.ok(ui.indexOf('Add planned doses to see predicted troughs.') >= 0,
    'the existing "no troughs yet" empty-state message is the one a single-dose fit now falls into');

  // ---- 6. loading-phase drugs (crovalimab) are unaffected -- they were
  //         already suppressing the continuation for their own reason -----
  M.select('crovalimab');
  var oneCrov = [{ t: 0, amt: 1000, route: 'iv' }];
  var fitCrov = await B.runFit({
    wt: 70, age: 40, disease: 'PNH', drug: 'crovalimab', doses: oneCrov,
    obs: [{ t: 0.5, c: 100, lloq: false }], lloq: 0, target: 75, seed: 11
  });
  t.eq(fitCrov.loadingPhase, true, 'crovalimab with one dose is still correctly in its own loading phase');
  t.eq(fitCrov.chartProjectedDoses.length, 0,
    'crovalimab, one dose: still zero continuation doses (was already true via loadingPhase, now also true via the dose-count gate)');
  M.select('eculizumab');

  return t.summary();
}

module.exports = { run: run };
