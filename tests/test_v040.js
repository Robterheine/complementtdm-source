'use strict';
/* v0.40.0 — two items of user feedback.
 *
 * A. Restoring a session broke the forecast. Both restore paths (the
 *    autosave "Restore" bar -> applySession(), and "Import session" ->
 *    importJson()) called setMode() BEFORE syncInputs(). setMode() ->
 *    markStale() -> updateRunReady() -> readPatient() read the still-empty
 *    form back over the restored state: weight and LLOQ blank, a custom
 *    target reset to the drug default, the assay-error multiplier reset to 1
 *    -- and markStale()'s autosave then overwrote the good saved copy.
 *    importJson() had this order since at least v0.16.0; applySession()
 *    gained it in v0.30.0. Fix: syncInputs() (and the planned-regimen
 *    fields) before setMode(), in both. No DOM in this harness, so pinned
 *    by source order; verified live in the browser as well.
 *
 * B. An optional clinician-entered planned regimen (dose + interval) for
 *    after the last entered dose. modalInterval()'s guess from the history
 *    reverted to the old interval right after an interval extension
 *    (q14 x N then q21 once -> projected q14) and to the loading interval
 *    right after loading. When the planned regimen is given it drives the
 *    chart continuation, the "next dose" trough row, the horizon and the
 *    explorer default; the fit itself (likelihood) is unchanged.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

function bodyOf(src, name) {
  var start = src.indexOf('function ' + name + '(');
  var end = src.indexOf('\n  }\n', start);
  return start < 0 ? '' : src.slice(start, end);
}

async function run() {
  var t = new T('v0.40.0 session restore keeps settings + planned regimen');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ==================== A. restore order =====================================
  ['applySession', 'importJson'].forEach(function (fn) {
    var b = bodyOf(ui, fn);
    var sync = b.indexOf('syncInputs();');
    var mode = b.indexOf("setMode('");
    t.ok(sync > 0 && mode > 0, fn + '() calls both syncInputs() and setMode()');
    t.ok(sync < mode, fn + '() writes the restored values into the form BEFORE setMode() re-reads the form');
    t.ok(b.indexOf('setPlanFields(') > 0 && b.indexOf('setPlanFields(') < mode,
      fn + '() restores the planned-regimen fields before setMode() as well');
  });

  var ij = bodyOf(ui, 'importJson');
  t.ok(/exclude:\s*!!o\.exclude/.test(bodyOf(ui, 'cleanSession')) && /note:/.test(bodyOf(ui, 'cleanSession')) && /state\.obs = c\.obs/.test(ij),
    'importJson() keeps each sample\u2019s exclude flag and note (they are exported; dropping them put excluded samples back into the fit)');

  // ==================== B. engine: planned regimen ===========================
  M.select('eculizumab');
  var ext = [0, 14, 28, 42, 56, 70, 91].map(function (d) { return { t: d, amt: 900, route: 'iv' }; });
  var base = { wt: 70, disease: 'PNH', drug: 'eculizumab', obs: [{ t: 90.99, c: 150, lloq: false }], lloq: 0, target: 75, seed: 5, mcmcIters: 300 };

  var fHist = await B.runFit(Object.assign({}, base, { doses: ext }));
  t.eq(fHist.interval, 14, 'without a planned regimen the history-derived interval is still used (q14 after one q21 gap -- the reported problem)');
  t.eq(fHist.planned, null, 'fit.planned is null when nothing was entered');

  var fPlan = await B.runFit(Object.assign({}, base, { doses: ext, planned: { amt: 1200, interval: 21 } }));
  t.eq(fPlan.interval, 21, 'with a planned regimen the forward interval is the entered 21 days');
  t.ok(fPlan.planned && fPlan.planned.amt === 1200 && fPlan.planned.interval === 21, 'fit.planned echoes the entered regimen');
  var pd = fPlan.chartProjectedDoses;
  t.ok(pd.length >= 1 && Math.abs(pd[0].t - (91 + 21)) < 1e-9, 'the first projected dose is 21 days after the last entered dose');
  t.ok(pd.every(function (d) { return d.amt === 1200; }), 'projected doses carry the planned amount, not the last entered one');
  t.ok(pd.length < 2 || Math.abs(pd[1].t - pd[0].t - 21) < 1e-9, 'projected doses are spaced at the planned interval');
  var assumedRow = fPlan.troughs.filter(function (tr) { return tr.assumed; })[0];
  t.ok(assumedRow && Math.abs(assumedRow.t - (91 + 21 - 1e-6)) < 1e-6, 'the next-dose trough row sits at last dose + planned interval');
  t.ok(fPlan.horizon >= 91 + 1.5 * 21 - 1e-9, 'the forecast horizon extends by the planned interval');

  // the fit itself does not depend on the future plan
  t.ok(Math.abs(fPlan.map.etaCL - fHist.map.etaCL) < 1e-9 && Math.abs(fPlan.map.etaV1 - fHist.map.etaV1) < 1e-9,
    'the MAP estimate is identical with and without a planned regimen (the plan never reaches the likelihood)');

  // one entered dose + a plan: the clinician supplied the regimen, so it projects
  var one = [{ t: 0, amt: 900, route: 'iv' }];
  var fOne = await B.runFit(Object.assign({}, base, { doses: one, obs: [{ t: 13.9, c: 100, lloq: false }], planned: { amt: 900, interval: 14 } }));
  t.ok(fOne.chartProjectedDoses.length > 0, 'a single entered dose plus a planned regimen does project a continuation');
  t.ok(fOne.troughs.some(function (tr) { return tr.assumed; }), 'and gives a next-dose trough row');
  var fOneNo = await B.runFit(Object.assign({}, base, { doses: one, obs: [{ t: 13.9, c: 100, lloq: false }] }));
  t.eq(fOneNo.chartProjectedDoses.length, 0, 'a single dose without a plan still projects nothing (v0.32.0 unchanged)');

  // invalid plan values are ignored, not half-applied
  var fBad = await B.runFit(Object.assign({}, base, { doses: ext, planned: { amt: 900, interval: 0 } }));
  t.eq(fBad.planned, null, 'a plan with a non-positive interval is ignored');
  t.eq(fBad.interval, 14, 'and the history-derived interval is used instead');

  // crovalimab: the loading-phase suppression still holds with a plan
  M.select('crovalimab');
  var fCro = await B.runFit({ wt: 70, age: 40, disease: 'PNH', drug: 'crovalimab', doses: [{ t: 0, amt: 1000, route: 'iv' }],
    obs: [{ t: 0.5, c: 100, lloq: false }], lloq: 0, target: 75, seed: 5, planned: { amt: 680, interval: 28 } });
  // v0.45.0 (review S1): a regimen the clinician typed is theirs, so it bypasses the loading guard
  // (which exists to stop the app guessing the interval from the loading spacing).
  t.ok(fCro.chartProjectedDoses.length > 0 && fCro.loadingPhase === true,
    'crovalimab in its loading phase WITH a plan: the plan is projected, and loading is still reported (v0.45.0)');
  var fCro0 = await B.runFit({ wt: 70, age: 40, disease: 'PNH', drug: 'crovalimab', doses: [{ t: 0, amt: 1000, route: 'iv' }, { t: 1, amt: 340, route: 'sc' }, { t: 7, amt: 340, route: 'sc' }],
    obs: [{ t: 8, c: 100, lloq: false }], lloq: 0, target: 75, seed: 5 });
  t.eq(fCro0.chartProjectedDoses.length, 0, 'crovalimab in its loading phase WITHOUT a plan: still no projected continuation');
  M.select('eculizumab');

  // ==================== B. UI wiring (source) ================================
  t.ok(html.indexOf('id="plan-dose"') > 0 && html.indexOf('id="plan-interval"') > 0, 'the planned-regimen inputs exist');
  t.ok(html.indexOf('id="plan-dose"') > html.indexOf('id="fullDoseUI"') && html.indexOf('id="plan-dose"') < html.indexOf('<!-- /fullDoseUI -->'),
    'they live in the full-schedule panel only (steady-state mode already defines its own regimen)');
  var run = bodyOf(ui, 'runFit');
  t.ok(/planned:\s*currentMode\(\) === 'ss' \? null : plan/.test(run), 'the forecast passes the planned regimen in full-schedule mode, never in steady-state mode');
  t.ok(run.indexOf('readPlan(true)') > 0, 'the run click validates the planned regimen (alerts on a half-filled or out-of-range plan)');
  var rp = bodyOf(ui, 'readPlan');
  t.ok(rp.indexOf('M.drug().dose') > 0, 'the planned dose is checked against the drug’s own dose range');
  t.ok(/'plan-dose', 'plan-interval'/.test(ui), 'editing the plan marks the forecast stale');
  t.ok(bodyOf(ui, 'saveSession').indexOf('plan: readPlanRaw()') > 0, 'the plan is autosaved');
  t.ok(bodyOf(ui, 'exportJson').indexOf('plan: readPlanRaw()') > 0, 'the plan is exported');
  // v0.42.0: the regimen detail moved from the legend label to the chart caption (legend ran off phones)
  t.ok(ui.indexOf('planned doses (entered regimen: ') > 0, 'the chart caption says the projection is the entered regimen when a plan is set');
  t.ok(ui.indexOf("assumed q' + fmtDays(fit.interval) + 'd from the entered history") > 0,
    'without a plan the legend names the interval it assumed from the history');

  return t.summary();
}

module.exports = { run: run };
