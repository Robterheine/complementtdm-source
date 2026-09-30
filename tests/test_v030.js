'use strict';
/* v0.30.0 — steady-state mode's own fields (ss-dose, ss-interval, ss-anchor,
 * and as of v0.29.0 ss-dur) were never covered by the localStorage autosave.
 *
 * `saveSession()`/`applySession()`/`offerRestore()` only ever captured
 * `state.doses`/`state.obs` (full-schedule mode's own records) plus the
 * drug/target/patient/report fields shared by both modes. `exportJson()`/
 * `importJson()` (the JSON file path) already had an `ss: {dose, interval,
 * anchor, dur}` block — the autosave simply never grew the same thing.
 *
 * Two distinct symptoms, both from the same missing piece:
 *   1. A steady-state session that HAS measurements (obs.length > 0) still
 *      gets its restore-bar offer, restores those measurements... but not
 *      the regimen itself (dose/interval/anchor/duration) or even the fact
 *      that the app should be in steady-state mode at all.
 *   2. A steady-state session with NO measurements entered yet (just the
 *      regimen configured) never gets offered a restore in the first place
 *      -- `loadSession()`'s "is there anything worth restoring" guard only
 *      ever checked doses/obs length, so a pure regimen-only session reads
 *      as empty and is silently never surfaced at all.
 *
 * Fixed by mirroring exportJson()/importJson()'s existing ss:{...} shape
 * exactly, in saveSession()/applySession(), plus relaxing loadSession()'s
 * guard and improving offerRestore()'s prompt text for the SS case.
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.30.0 steady-state fields covered by session autosave');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  function bodyOf(name) {
    var start = ui.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = ui.indexOf('\n  }', start);
    return end < 0 ? ui.slice(start) : ui.slice(start, end + 4);
  }

  // ======================= 1. saveSession() captures SS state ==============
  var saveBody = bodyOf('saveSession');
  t.ok(saveBody.length > 0, 'saveSession() found');
  t.ok(saveBody.indexOf('mode: currentMode()') >= 0,
    'saveSession() now records which mode the session was in (full vs ss) -- without this, applySession() has no way to know an ss block should even be applied');
  t.ok(saveBody.indexOf('ss:') >= 0,
    'saveSession() now captures an ss:{...} block, mirroring exportJson()’s existing shape');
  t.ok(saveBody.indexOf('ss.D') >= 0 && saveBody.indexOf('ss.I') >= 0 && saveBody.indexOf('ss.A') >= 0,
    'the captured ss block carries dose (D), interval (I) and anchor (A) -- the same three exportJson() already captures');
  t.ok(saveBody.indexOf("$('ss-dur')") >= 0,
    'the captured ss block also carries the v0.29.0 infusion-duration field, not just the three pre-existing ones');

  // ======================= 2. loadSession()'s guard is relaxed =============
  var loadBody = bodyOf('loadSession');
  t.ok(loadBody.length > 0, 'loadSession() found');
  // the OLD guard (doses.length || obs.length only) must no longer be the
  // WHOLE story -- a pure regimen-only ss session (no doses, no obs yet)
  // must also count as "something worth restoring".
  t.ok(loadBody.indexOf('s.mode') >= 0 && loadBody.indexOf('s.ss') >= 0,
    'loadSession()’s "anything worth restoring" check also recognises a saved ss regimen, not only doses/obs length');

  // ======================= 3. applySession() restores SS fields ============
  var applyBody = bodyOf('applySession');
  t.ok(applyBody.length > 0, 'applySession() found');
  t.ok(applyBody.indexOf("$('ss-dose')") >= 0 && applyBody.indexOf("$('ss-interval')") >= 0 && applyBody.indexOf("$('ss-anchor')") >= 0,
    'applySession() writes the restored regimen back into the ss-dose/ss-interval/ss-anchor fields');
  t.ok(applyBody.indexOf("$('ss-dur')") >= 0,
    'applySession() also restores the v0.29.0 infusion-duration field');
  t.ok(applyBody.indexOf('setMode(') >= 0,
    'applySession() actually SWITCHES the app into steady-state mode when the saved session was in it -- restoring the field values alone, while the UI silently stays in full-schedule mode, would leave the regimen configured but invisible');
  // mirrors importJson()'s own guard style (a parseable anchor date), so the
  // two restore paths cannot silently diverge on what counts as valid data
  // v0.44.0: both restore paths now validate in the one shared cleanSession() gate
  t.ok(applyBody.indexOf('cleanSession(') >= 0 && bodyOf('cleanSession').indexOf('isFinite(when(data.ss.anchor))') >= 0,
    'applySession() validates the restored anchor date (through cleanSession(), the same gate importJson() uses) before trusting it');

  // ======================= 4. offerRestore()'s prompt describes SS sessions
  var restoreBody = bodyOf('offerRestore');
  t.ok(restoreBody.length > 0, 'offerRestore() found');
  t.ok(restoreBody.indexOf('s.mode') >= 0 && restoreBody.indexOf('ss') >= 0,
    'the restore-bar prompt distinguishes a steady-state session from a full-schedule one, rather than always describing it as N doses / N measurements (which would read as "0 dose(s)" for a pure regimen-only ss session)');

  // ======================= 5. the two restore paths must not diverge =======
  // applySession() and importJson() both restore the same four fields; if
  // one used a different mechanism than the other, a session saved via one
  // path and restored via reasoning built for the other could silently
  // disagree about what a valid restore looks like.
  var importBody = bodyOf('importJson');
  t.ok(applyBody.indexOf("$('ss-dose').value") >= 0 && importBody.indexOf("$('ss-dose').value") >= 0,
    'applySession() and importJson() both write #ss-dose.value directly -- the same restore mechanism, not two different ones');

  return t.summary();
}

module.exports = { run: run };
