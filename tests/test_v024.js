'use strict';
/* v0.24.0 — Independent audit (INDEPENDENT_AUDIT.md) findings F5, F7, F16.
 * (F4's checkpoint resolved to "no action" and consumed no version number;
 * this batch continues the ladder from v0.23.0's F2/F3/F11.)
 *
 * F7. Crovalimab's EMA loading regimen is 5 doses (1 IV + 4 weekly SC) before
 *     q28d maintenance. Until a 6th (maintenance) dose is entered, EVERY
 *     spacing on file is a loading spacing — modalInterval()'s "later half of
 *     doses" heuristic has nothing else to look at and returns q7d, which the
 *     chart's continuation block would otherwise auto-project forever (the
 *     same class of bug as the v0.13 hardcoded-interval landmine, different
 *     trigger). Fixed with a per-drug `loadingDoseCount`: while
 *     `doses.length <= loadingDoseCount`, the continuation is suppressed and
 *     `fit.loadingPhase` is set so the UI can say why. 0 for every other
 *     drug (no loading phase), so this is a no-op elsewhere.
 *
 * F5/F16. The regimen explorer's `next`/`ss` probabilities had NO uncertainty
 *     band at all, unlike the trough table's matching `pCI` (batch-means, over
 *     the full kept chain). `scanOneRegimen` already works on a SUBSAMPLED
 *     but still chain-ordered slice (`subsample()` keeps order), so the same
 *     `batchMeansCI` method now runs on that shorter chain — the CI honestly
 *     widens relative to the trough table's full-chain CI, rather than
 *     pretending a 250-draw estimate is exact. `ptaBadge()` already accepted
 *     an optional CI argument (used by the trough table since v0.13) — the
 *     explorer's two call sites (in `intervalScanTableHtml`, shared by the
 *     on-screen table and the printed-report copy) now pass it too.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches ECU.ptaBadge (headless-safe)

async function run() {
  var t = new T('v0.24.0 audit F5/F7/F16 — loading-phase guard + explorer CI');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var model = fs.readFileSync('src/model.js', 'utf8');

  // ======================= F7 =============================================
  t.eq(M.spec('crovalimab').loadingDoseCount, 5, 'crovalimab declares a 5-dose loading regimen');
  ['eculizumab', 'ravulizumab'].forEach(function (id) {
    t.ok(!M.spec(id).loadingDoseCount, id + ': no loading phase declared (0/undefined)');
  });

  M.select('crovalimab');
  // EMA loading exactly as in src/model.js's own posology comment: 1000 mg IV
  // day 1, 340 mg SC on days 2/8/15/22 -- 5 doses, all loading, no maintenance
  // dose yet.
  var loadingDoses = [
    { t: 0, amt: 1000, route: 'iv' },
    { t: 1, amt: 340, route: 'sc' },
    { t: 8, amt: 340, route: 'sc' },
    { t: 15, amt: 340, route: 'sc' },
    { t: 22, amt: 340, route: 'sc' }
  ];
  var fitLoading = await B.runFit({
    wt: 75, disease: 'PNH', drug: 'crovalimab', doses: loadingDoses,
    obs: [], lloq: 0, target: 75, seed: 5
  });
  t.eq(fitLoading.loadingPhase, true, 'still within the 5-dose loading regimen -> loadingPhase true');
  t.eq(fitLoading.chartProjectedDoses.length, 0,
    'no chart continuation is projected during the loading phase (would otherwise silently draw "q7d forever")');
  // the real trough table is UNCHANGED -- F7 only gates the display-only
  // continuation, never the reported troughs/fit itself (golden rule: never
  // let a display-only block reach the decision-relevant numbers)
  t.ok(fitLoading.troughs.length > 0, 'the real trough table is still computed during loading (untouched by F7)');

  // v0.45.0 (review S1): the 6th dose is the FIRST maintenance dose, and the gap to
  // the next one is still unknown -- reading the loading spacing there assumed
  // 680 mg weekly. The guard now runs through the 6th dose; a 7th dose (one real
  // maintenance spacing) ends it, and the continuation resumes.
  var sixthDoses = loadingDoses.concat([{ t: 50, amt: 680, route: 'sc' }]);
  var fitSixth = await B.runFit({
    wt: 75, disease: 'PNH', drug: 'crovalimab', doses: sixthDoses,
    obs: [], lloq: 0, target: 75, seed: 5
  });
  t.eq(fitSixth.loadingPhase, true, 'a 6th dose (the first maintenance dose) is still the loading phase (v0.45.0)');
  t.eq(fitSixth.chartProjectedDoses.length, 0, 'and nothing is projected yet');
  var maintenanceDoses = sixthDoses.concat([{ t: 78, amt: 680, route: 'sc' }]);
  var fitMaint = await B.runFit({
    wt: 75, disease: 'PNH', drug: 'crovalimab', doses: maintenanceDoses,
    obs: [], lloq: 0, target: 75, seed: 5
  });
  t.eq(fitMaint.loadingPhase, false, 'a 7th dose (one real maintenance spacing) ends the loading phase');
  t.ok(fitMaint.chartProjectedDoses.length > 0,
    'the chart continuation resumes once maintenance has genuinely begun');

  // eculizumab/ravulizumab: identical shape of schedule (5 doses, all on file)
  // must NEVER be treated as "loading" -- they have no loading phase at all,
  // and a real, deliberately-prolonged interval (this app's whole purpose)
  // must not be mistaken for one.
  M.select('eculizumab');
  var ecuDoses = [];
  for (var k = 0; k < 5; k++) ecuDoses.push({ t: k * 21, amt: 900, route: 'iv' });  // q3w, prolonged
  var fitEcu = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: ecuDoses,
    obs: [], lloq: 0, target: 75, seed: 5
  });
  t.eq(fitEcu.loadingPhase, false, 'eculizumab has no loading phase, even at 5 doses on a non-default (prolonged) interval');
  t.ok(fitEcu.chartProjectedDoses.length > 0, 'eculizumab continuation is unaffected by F7');

  // on-screen advisory: only shown while loadingPhase is true
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  t.ok(ui.indexOf('fit.loadingPhase') >= 0, 'ui.js checks fit.loadingPhase before advising');
  t.ok(ui.indexOf('loading regimen is not finished') >= 0 || ui.indexOf('not finished') >= 0,
    'a loading-phase advisory string exists');

  // ======================= F5 / F16 ========================================
  M.select('eculizumab');
  var doses = [];
  for (var k2 = 0; k2 < 4; k2++) doses.push({ t: k2 * 14, amt: 900, route: 'iv' });
  var fit = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [{ t: 41.9, c: 150, lloq: false }], lloq: 0, target: 75, seed: 3
  });
  var ivs = B.candidateIntervals(fit.interval);
  var scan = await B.intervalScan({
    draws: fit.draws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, amt: 900, intervals: ivs
  });
  t.ok(scan.length > 0, 'intervalScan returns at least one candidate');
  scan.forEach(function (r) {
    ['next', 'ss'].forEach(function (key) {
      var row = r[key];
      t.ok('pCI' in row, key + '.pCI is present (may be null) for interval ' + r.interval);
      if (row.pCI != null) {
        t.ok(Array.isArray(row.pCI) && row.pCI.length === 2, key + '.pCI is a 2-element array when not null');
        t.ok(row.pCI[0] <= row.pCI[1], key + '.pCI is ordered ascending');
        t.ok(row.pCI[0] >= 0 && row.pCI[1] <= 1, key + '.pCI stays within [0,1]');
        // the CI should bracket the point estimate, up to the small
        // truncation batchMeansCI's fixed 12-batch grouping introduces
        // versus probAbove's use of every row (250 draws / 12 batches
        // truncates a handful of tail rows) -- a small tolerance, not an
        // exact match, is the correct assertion here.
        t.ok(row.pCI[0] - 0.08 <= row.pTarget && row.pTarget <= row.pCI[1] + 0.08,
          key + '.pCI (batch-means) roughly brackets ' + key + '.pTarget (probAbove) for interval ' + r.interval);
      }
    });
  });

  // fewer than 12 draws -> batchMeansCI returns null; scanOneRegimen and
  // ptaBadge must both handle that without throwing (this is the same
  // null-safety the trough table's own pCI already relies on).
  var tinyDraws = fit.draws.slice(0, 5);
  var tinyScan = await B.intervalScan({
    draws: tinyDraws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, amt: 900, intervals: [14]
  });
  t.ok(tinyScan.length === 1, 'intervalScan still runs with very few draws');
  t.eq(tinyScan[0].next.pCI, null, 'fewer than 12 batch-mean rows -> pCI is null, not a crash or a fabricated interval');
  t.ok(typeof ECU.ptaBadge(tinyScan[0].next.pTarget, tinyScan[0].next.pCI) === 'string',
    'ptaBadge renders without throwing when pCI is null');

  // the ss badge is actually WIRED to pCI in the explorer markup, not just
  // computed and discarded -- confirmed by source, since intervalScanTableHtml
  // needs a live DOM/host to call directly in this headless suite.
  t.ok(bayes.indexOf('pCI: batchMeansCI(mat, 0, target)') >= 0, 'scanOneRegimen still computes next.pCI via batchMeansCI (a data-layer concern, unaffected by v0.31.0 dropping it from the table)');
  t.ok(bayes.indexOf('pCI: batchMeansCI(mat, 1, target)') >= 0, 'scanOneRegimen computes ss.pCI via batchMeansCI');
  // v0.31.0: the table no longer renders "next" at all (see test_v031.js) --
  // ss is the only badge left in intervalScanTableHtml.
  t.ok(ui.indexOf('ptaBadge(r.next.pTarget, r.next.pCI)') < 0, 'the explorer table no longer passes next.pCI into ptaBadge (v0.31.0)');
  t.ok(ui.indexOf('ptaBadge(r.ss.pTarget, r.ss.pCI)') >= 0, 'the on-screen/report explorer table still passes ss.pCI into ptaBadge');

  // an explorer badge WITH a real CI actually renders the Monte-Carlo text --
  // proves ptaBadge's existing ci-rendering path (already used by the trough
  // table) is reached by the explorer's own call, not merely that the field
  // exists on the object.
  var rowWithCI = null;
  // v0.42.0: an interval that rounds to zero width is deliberately not printed
  // (review A2), so pick a row whose interval has a real width.
  for (var ri = 0; ri < scan.length && !rowWithCI; ri++) {
    var pc = scan[ri].next.pCI;
    if (pc && Math.round(pc[0] * 100) !== Math.round(pc[1] * 100)) rowWithCI = scan[ri];
  }
  t.ok(!!rowWithCI, 'at least one candidate interval produced a non-null next.pCI to render');
  if (rowWithCI) {
    t.ok(ECU.ptaBadge(rowWithCI.next.pTarget, rowWithCI.next.pCI).indexOf('Monte-Carlo') >= 0,
      'ptaBadge renders the Monte-Carlo CI text when the explorer supplies one');
  }

  return t.summary();
}

module.exports = { run: run };
