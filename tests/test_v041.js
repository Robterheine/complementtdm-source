'use strict';
/* v0.41.0 — fixes from an adversarial review, each reproduced first.
 *
 * 1. Incomplete dosing history. With only the last 3 of a year of q14d doses
 *    entered, the fit read the carried-over drug as slow elimination (CL 0.065
 *    vs a true 0.161 L/day) and the explorer reported q21d as P(>75) = 100%
 *    while the true steady-state trough was 59. Full-schedule mode now asks
 *    whether the patient was treated before the first entered dose; the
 *    forecast will not run until that is answered "no" (or steady-state mode
 *    is used, which assumes a long-established regimen).
 * 2. A non-converged fit was shown as a result (925 [924-925], P 100%, with a
 *    small warning beside it). Now the trough table, the parameter block, the
 *    regimen explorer and the report are withheld; the curve stays, marked
 *    not reliable.
 * 3. Implausible inputs went straight into the fit: target 5 (the HTML min
 *    was not enforced), a first sample of 7000 ug/mL, a duplicate dose 2 h
 *    later, a sample dated 40 days in the future. Now: target range enforced;
 *    a per-drug "check the unit" confirmation above a plausible maximum;
 *    duplicate check widened to 24 h; confirmation for a future-dated sample.
 * No DOM in this harness: UI behaviour is pinned by source slicing and was
 * verified in the browser.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, T = u.T;

function bodyOf(src, name) {
  var start = src.indexOf('function ' + name + '(');
  var end = src.indexOf('\n  }\n', start);
  return start < 0 ? '' : src.slice(start, end);
}

async function run() {
  var t = new T('v0.41.0 prior treatment, non-converged fits, input checks');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ==================== 1. treated before the first entered dose? ============
  var full = html.slice(html.indexOf('id="fullDoseUI"'), html.indexOf('<!-- /fullDoseUI -->'));
  t.ok(/name="priorTx" value="no"/.test(full) && /name="priorTx" value="yes"/.test(full),
    'full-schedule mode asks whether the patient was treated before the first entered dose');
  t.ok(!/checked/.test(full.slice(full.indexOf('name="priorTx"') - 200, full.lastIndexOf('name="priorTx"') + 200)),
    'neither answer is preselected: the clinician must choose');
  var urr = bodyOf(ui, 'updateRunReady');
  t.ok(/readPrior\(\)/.test(urr), 'updateRunReady() reads the answer');
  t.ok(/prior === 'yes'/.test(urr) && /prior == null/.test(urr), 'the run is blocked both when unanswered and when earlier doses are missing');
  t.ok(/currentMode\(\) === 'ss' \? 'no'/.test(urr), 'steady-state mode does not ask (it assumes a long-established regimen)');
  var rf = bodyOf(ui, 'runFit');
  t.ok(/readPrior\(\) !== 'no'/.test(rf), 'runFit() refuses independently of the button state (defence in depth)');
  t.ok(bodyOf(ui, 'saveSession').indexOf('priorTx: readPrior()') > 0 && bodyOf(ui, 'exportJson').indexOf('priorTx: readPrior()') > 0,
    'the answer is autosaved and exported');
  ['applySession', 'importJson'].forEach(function (fn) {
    var b = bodyOf(ui, fn);
    t.ok(b.indexOf('setPrior(') > 0 && b.indexOf('setPrior(') < b.indexOf("setMode('"), fn + '() restores the answer before setMode()');
  });
  t.ok((ui.match(/setPrior\(null\)/g) || []).length >= 2, 'the answer is reset on a drug switch and on "clear all"');

  // ==================== 2. non-converged fit withheld =========================
  var fu = bodyOf(ui, 'fitUnreliable');
  t.ok(/converged === false/.test(fu) && /hasObs/.test(fu), 'fitUnreliable() is true for an individualised fit whose search did not converge');
  var rr = bodyOf(ui, 'renderResults');
  t.ok(/if \(fitUnreliable\(fit\)\)/.test(rr), 'renderResults() handles an unreliable fit');
  var unrel = rr.slice(rr.indexOf('if (fitUnreliable(fit))'));
  t.ok(/pb\.innerHTML = ''/.test(unrel) && /tb\.innerHTML = /.test(unrel), 'the parameter block and trough table are replaced');
  t.ok(/Not reliable/.test(unrel), 'the status says "Not reliable"');
  t.ok(rr.indexOf('Treat the individual estimates and the bands with caution') < 0,
    'the old "treat with caution" advisory is gone (it contradicted withholding the result)');
  t.ok(/!fitUnreliable\(state\.fit\)/.test(bodyOf(ui, 'intervalExplorerAvailable')), 'the regimen explorer is unavailable for an unreliable fit');
  t.ok(/fitUnreliable\(state\.fit\)/.test(bodyOf(ui, 'openReportDialog')), 'the report cannot be printed for an unreliable fit');
  t.ok(/fitUnreliable\(fit\)/.test(bodyOf(ui, 'renderChart')), 'the chart is marked not reliable');

  // ==================== 3. input checks =======================================
  t.ok(/targetRange/.test(urr) && /targetRange/.test(rf), 'the trough target range is enforced (run hint and run click)');
  ['eculizumab', 'ravulizumab', 'crovalimab'].forEach(function (id) {
    var s = M.spec(id);
    t.ok(s.obsTypicalMax > 0 && s.obsTypicalMax < s.obsValMax, id + ' has a plausible-maximum level below the hard limit');
  });
  t.eq(M.spec('eculizumab').obsTypicalMax, 1000, 'eculizumab: confirm above 1000 µg/mL');
  t.eq(M.spec('ravulizumab').obsTypicalMax, 3000, 'ravulizumab: confirm above 3000 µg/mL');
  var obsStart = ui.indexOf("$('obsForm').addEventListener('submit'");
  var obsSrc = ui.slice(obsStart, ui.indexOf("$('iv-run')", obsStart));
  t.ok(/obsTypicalMax/.test(obsSrc) && /confirm\(/.test(obsSrc.slice(obsSrc.indexOf('obsTypicalMax'))),
    'a level above the plausible maximum asks for confirmation (check the unit), it is not a hard block');
  t.ok(/t > Date\.now\(\)/.test(obsSrc) && /in the future/.test(obsSrc), 'a sample dated in the future asks for confirmation');
  var doseStart = ui.indexOf("$('doseForm').addEventListener('submit'");
  var doseSrc = ui.slice(doseStart, obsStart);
  // v0.45.0: the window moved into isDuplicateDose() (same-route only); the dialog still says 24 hours
  var dupFn = ui.slice(ui.indexOf('function isDuplicateDose('), ui.indexOf('function isDuplicateDose(') + 320);
  t.ok(/24 \* 3600000/.test(dupFn) && /isDuplicateDose\(/.test(doseSrc) && /within 24 hours/.test(doseSrc), 'the duplicate-dose check covers 24 hours, not 5 minutes');
  t.ok(doseSrc.indexOf('5 * 60000') < 0, 'the old 5-minute window is gone');

  return t.summary();
}

module.exports = { run: run };
