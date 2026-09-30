'use strict';
/* v0.37.0 — a stale forecast is cleared, not just flagged.
 *
 * Author report (live use, 2026-09-18): after running a forecast, removing
 * or changing a measured concentration left the old chart, trough table and
 * advisories fully displayed underneath the amber "Inputs changed" banner --
 * easy to miss, and the stale numbers otherwise looked exactly like current
 * ones, which could read as "a new forecast is not necessary."
 *
 * Fix: markStale() now clears the on-screen forecast (chart, fitStatus,
 * paramBlock, troughBlock, advisoryBlock) the moment it goes stale, via a
 * new showStaleResults() -- not just once the banner appears. Also resets
 * card 4 (the regimen explorer), which reuses the same fit and would
 * otherwise keep showing a scan computed from the now-outdated posterior.
 * state.fit itself is NOT cleared (unlike "Clear all" or a drug switch,
 * which already discard it entirely) -- openReportDialog()'s own
 * pre-existing staleness confirm() still offers to print the last run's
 * result, and that behaviour is deliberately left unchanged here.
 *
 * ui.js's DOM-dependent functions have no DOM in this node harness (see
 * tests/test_v033.js and others for the same convention): covered here by
 * source-slicing the two functions involved.
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.37.0 a stale forecast is cleared, not just flagged');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  // ---- 1. markStale() clears the display exactly once, before flagging ---
  var msStart = ui.indexOf('function markStale() {');
  var msEnd = ui.indexOf('\n  }', msStart);
  var msSrc = ui.slice(msStart, msEnd);
  t.ok(msStart >= 0 && msEnd > msStart, 'located markStale()');
  t.ok(/if \(state\.fit && !state\.stale\) showStaleResults\(\);/.test(msSrc),
    'markStale() clears the stale display, guarded so a fit exists and this is the FIRST time going stale');
  t.ok(msSrc.indexOf('showStaleResults()') < msSrc.indexOf('state.stale = true;'),
    'the display is cleared using the fit that is about to be invalidated, before state.stale flips');
  t.ok(!/state\.fit\s*=\s*null/.test(msSrc), 'markStale() does not null out state.fit (the report dialog still needs it for its own stale-print confirm)');

  // ---- 2. showStaleResults() clears every result surface, card 4 included -
  var srStart = ui.indexOf('function showStaleResults() {');
  var srEnd = ui.indexOf('\n  }', srStart);
  var srSrc = ui.slice(srStart, srEnd);
  t.ok(srStart >= 0 && srEnd > srStart, 'located showStaleResults()');
  ["$('chart').innerHTML", "$('fitStatus').innerHTML", "$('paramBlock').innerHTML", "$('troughBlock').innerHTML", "$('advisoryBlock').innerHTML"].forEach(function (frag) {
    t.ok(srSrc.indexOf(frag) >= 0, 'showStaleResults() touches ' + frag);
  });
  t.ok(/paramBlock'\)\.innerHTML = \$\('troughBlock'\)\.innerHTML = \$\('advisoryBlock'\)\.innerHTML = '';/.test(srSrc),
    'param/trough/advisory blocks are emptied outright, not left with stale content');
  t.ok(srSrc.indexOf("ivRunBtn.disabled = true") >= 0 && srSrc.indexOf("Run a forecast in card 3 first") >= 0,
    'card 4 (regimen explorer) is reset too -- it reuses the same fit and would otherwise show a scan from an outdated posterior');

  // ---- 3. the message is honest about WHY the chart is empty (distinct from
  //         the "nothing entered yet" copy showEmpty() uses) ---------------
  t.ok(srSrc.indexOf('Forecast cleared because the inputs changed') >= 0,
    'the chart placeholder explains the forecast was cleared due to changed inputs, not a generic "nothing yet" message');
  t.ok(srSrc.indexOf('Enter the dosing schedule') < 0,
    'showStaleResults() does not reuse showEmpty()\'s "nothing entered yet" wording -- data WAS entered and fitted here');

  return t.summary();
}

module.exports = { run: run };
