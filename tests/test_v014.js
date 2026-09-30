'use strict';
/* v0.14.0 — regimen explorer: dose scanning at a fixed interval.
 *
 * Prompted directly by a clinical-pharmacologist use case: "if I adjust a
 * dose, show me the predicted trough and its 90% credible interval at steady
 * state." v0.13.0 shipped interval scanning (fixed dose, varying interval);
 * this suite pins the dose-scanning counterpart (fixed interval, varying
 * dose) and a defect caught while verifying it in the browser: the "next
 * trough" column read numerically IDENTICAL across every candidate dose,
 * because a trough measured strictly before an administration cannot depend
 * on that administration's amount. Fixed by evaluating "next" one cycle later
 * for a dose scan (after the first dose at the new amount), while interval
 * scanning is unaffected (its "next" already falls after the change, at the
 * delayed administration time).
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.14.0 regimen explorer (dose scanning)');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  t.ok(typeof B.doseScan === 'function', 'doseScan is exported');
  t.ok(typeof B.candidateAmounts === 'function', 'candidateAmounts is exported');

  // ---- candidateAmounts -----------------------------------------------
  var cand = B.candidateAmounts(680, M.spec('crovalimab').dose);
  ['340', '680', '1020'].forEach(function (v) {
    t.ok(cand.indexOf(parseInt(v, 10)) >= 0, 'candidate doses include the real crovalimab dose ' + v + ' mg');
  });
  t.ok(cand.every(function (v) { return v >= M.spec('crovalimab').dose.min && v <= M.spec('crovalimab').dose.max; }),
    'every candidate dose is within the spec range');
  t.ok(cand.length >= 5, 'enough candidate doses to show a trend');

  // ---- doseScan: physics and the "next trough" fix ----------------------
  M.select('eculizumab');
  var doses = [];
  for (var k = 0; k < 8; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });
  var fit = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses,
    obs: [{ t: 97.9, c: 190, lloq: false }, { t: 111.9, c: 185, lloq: false }],
    lloq: 0, target: 75, seed: 7
  });
  var scan = await B.doseScan({
    draws: fit.draws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, interval: 14, amounts: [650, 1300, 2600]
  });
  t.eq(scan.length, 3, 'doseScan returns one row per candidate dose');
  scan.forEach(function (r) {
    t.ok(isFinite(r.next.med) && isFinite(r.ss.med), 'amt=' + r.amt + ': quantiles finite');
    t.ok(r.ss.p5 <= r.ss.med && r.ss.med <= r.ss.p95, 'amt=' + r.amt + ': steady-state quantiles ordered');
  });
  /* The regression this suite exists to catch: before the fix, r.next.med was
   * bit-identical across every candidate dose (169 vs 169 vs 169), because it
   * was evaluated strictly before the candidate dose was ever given. */
  t.ok(Math.abs(scan[0].next.med - scan[2].next.med) > 50,
    '"next trough" now differs materially between a 650 mg and a 2600 mg candidate (got ' +
    scan[0].next.med.toFixed(0) + ' vs ' + scan[2].next.med.toFixed(0) + ')');
  t.ok(scan[0].next.med < scan[1].next.med && scan[1].next.med < scan[2].next.med,
    '"next trough" rises monotonically with the candidate dose');
  // steady-state trough must also rise monotonically and by more than "next"
  // (accumulation compounds a dose change over multiple cycles)
  t.ok(scan[0].ss.med < scan[1].ss.med && scan[1].ss.med < scan[2].ss.med,
    'steady-state trough rises monotonically with dose');
  var nextRatio = scan[2].next.med / scan[0].next.med;
  var ssRatio = scan[2].ss.med / scan[0].ss.med;
  t.ok(ssRatio > nextRatio,
    'the dose ratio (4x) shows up more fully at steady state than after a single dose (ss ratio ' +
    ssRatio.toFixed(2) + ' > next ratio ' + nextRatio.toFixed(2) + ')');

  // ---- doseScan vs intervalScan: bit-identical on the shared regimen -----
  var ivScanAtCurrent = await B.intervalScan({
    draws: fit.draws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, amt: 1200, intervals: [14]
  });
  var doScanAtCurrent = await B.doseScan({
    draws: fit.draws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, interval: 14, amounts: [1200]
  });
  /* The steady-state trough only depends on (amt, interval, nCycles) — never
   * on which axis is being scanned — so it must agree exactly between the two
   * entry points. "next" deliberately does NOT agree: intervalScan reports the
   * trough BEFORE the first candidate-amount dose (nextCycle=1), doseScan
   * reports the trough AFTER it (nextCycle=2, per the fix above), so the two
   * functions look at different points in time by design. */
  t.close(ivScanAtCurrent[0].ss.med, doScanAtCurrent[0].ss.med, 1e-9,
    'intervalScan and doseScan agree exactly at an overlapping (amt, interval) point (steady state)');
  t.ok(ivScanAtCurrent[0].next.med !== doScanAtCurrent[0].next.med,
    'intervalScan (next = before the changed dose) and doseScan (next = after it) deliberately look at different times');

  // ---- interval-scan regression: unaffected by the nextCycle change ------
  var ivscan2 = await B.intervalScan({
    draws: fit.draws, doses: doses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, amt: 900, intervals: [14, 21, 28]
  });
  t.closeTo(ivscan2[1].ss.med, 76, 8, 'q21d sustained trough unchanged by the nextCycle refactor (~76 ug/mL)');
  t.closeTo(ivscan2[2].ss.med, 22, 5, 'q28d sustained trough unchanged by the nextCycle refactor (~22 ug/mL)');

  // ---- UI wiring ----------------------------------------------------------
  t.ok(html.indexOf('id="iv-vary"') >= 0, 'a vary-mode selector exists');
  t.ok(html.indexOf('id="iv-interval"') >= 0, 'an editable interval field exists (for dose-scan mode)');
  t.ok(ui.indexOf('function intervalScanTableHtml') >= 0, 'the results table is built by a shared, testable function');
  t.ok(ui.indexOf("sc.mode === 'dose'") >= 0, 'the UI branches on scan mode');
  t.ok(ui.indexOf('Steady-state trough') >= 0, '"steady state" terminology is used (not "sustained")');
  t.ok(ui.indexOf('Sustained trough') < 0, 'the old "sustained" column header is gone');

  // ---- report inclusion (the actual point of this feature) --------------
  t.ok(ui.indexOf('Regimen exploration') >= 0, 'the report includes a Regimen exploration section when used');
  t.ok(ui.indexOf('fit.intervalScan && fit.intervalScan.rows') >= 0,
    'the report only includes it when the clinician actually ran an exploration');
  t.ok(ui.indexOf('This is not the forecast above') >= 0,
    'the report explicitly separates the exploration from the individualized forecast');
  /* v0.17.0: the live table gained a "responsive-cards" class (phone
   * card layout), so the exact literal changed — same distinction, updated
   * string. */
  t.ok(ui.indexOf("forPrint ? 'rp-table' : 'data responsive-cards'") >= 0,
    'the report copy of the table uses the report table styling, not the on-screen one');

  return t.summary();
}

module.exports = { run: run };
