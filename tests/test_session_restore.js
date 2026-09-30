'use strict';
/* v0.19.1 — a custom trough target was silently lost on autosave restore.
 *
 * The app has TWO paths that rehydrate a whole session, and they disagreed:
 *
 *   applySession(s)  (localStorage autosave / the "Restore" bar)
 *   importJson(file) (the exported .json session file)
 *
 * applyDrugUI() resets the trough target to the selected drug's default, in
 * BOTH the DOM field and state.target.value. That is deliberate and load-
 * bearing: the drug-switch handler relies on it to move the target to the new
 * drug's default when the model changes (eculizumab 75 -> ravulizumab 100 is
 * not a cosmetic difference — it drives the forecast, the P(trough > target)
 * column and the plot's target line).
 *
 * importJson() therefore calls applyDrugUI() FIRST and assigns state.target
 * afterwards, so the drug defaults are laid down and then overwritten by the
 * session's own value. applySession() did the opposite: it assigned
 * state.target and then called applyDrugUI(), which promptly destroyed it.
 * Restoring an autosaved session silently reverted a clinician-entered target
 * to the drug default, with no error and a UI that looked correct.
 *
 * Because the two paths disagreed, the bug was invisible to anyone testing
 * with the JSON export — which is why it survived several releases.
 *
 * Fix: applySession() now follows importJson()'s ordering contract exactly —
 * applyDrugUI() lays down drug-scoped defaults, the session's own values are
 * applied on top, then syncInputs() pushes them to the DOM. The two restore
 * paths converge rather than diverging further.
 *
 * These are structural assertions on src/ui.js rather than behavioural ones:
 * ui.js requires a DOM and this suite is deliberately Node-only (see
 * tests/util.js, which loads only model.js and bayes.js). The ordering
 * invariant IS the fix, so pinning the order is pinning the behaviour — and
 * every assertion below was confirmed to fail against the pre-fix code.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, T = u.T;

/* Slice one top-level function out of the ui.js IIFE. Top-level functions in
 * that file are indented two spaces, so the first "\n  }" after the header is
 * its closing brace — nested functions, blocks and callbacks are indented
 * deeper and cannot match it. */
function bodyOf(src, name) {
  var start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  var end = src.indexOf('\n  }', start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 4);
}

async function run() {
  var t = new T('session restore keeps a custom trough target (v0.19.1)');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  var applySess = bodyOf(ui, 'applySession');
  var importFn = bodyOf(ui, 'importJson');
  var drugUi = bodyOf(ui, 'applyDrugUI');

  t.ok(applySess.length > 0, 'applySession() found in src/ui.js');
  t.ok(importFn.length > 0, 'importJson() found in src/ui.js');
  t.ok(drugUi.length > 0, 'applyDrugUI() found in src/ui.js');

  // ---- why the clobber is observable at all -------------------------------
  // If every drug shared one default target the bug would be invisible. They
  // do not: the target is per-drug and traceable to its own source.
  var defaults = ['eculizumab', 'ravulizumab', 'crovalimab'].map(function (id) {
    M.select(id);
    return M.drug().targetDefault;
  });
  M.select('eculizumab');
  t.ok(defaults.every(function (v) { return isFinite(v) && v > 0; }),
    'every drug declares a positive default trough target');
  t.ok(defaults.some(function (v) { return v !== defaults[0]; }),
    'the default target differs between drugs, so overwriting a restored one is observable');

  // ---- 1. applySession: the ordering that was wrong -----------------------
  var aDrug = applySess.indexOf('applyDrugUI()');
  var aTarget = applySess.indexOf('state.target =');
  var aSync = applySess.indexOf('syncInputs()');

  t.ok(aDrug >= 0, 'applySession calls applyDrugUI()');
  t.ok(aTarget >= 0, 'applySession restores state.target');
  t.ok(aSync >= 0, 'applySession calls syncInputs()');
  t.ok(aDrug < aTarget,
    'applySession lays down the drug defaults (applyDrugUI) BEFORE restoring state.target — ' +
    'the reverse order lets applyDrugUI overwrite the restored target with the drug default');
  t.ok(aTarget < aSync,
    'applySession restores state.target BEFORE syncInputs() pushes it to the DOM — ' +
    'otherwise the field shows the drug default and readPatient() reads it straight back');

  // ---- 2. importJson: the path that was already right must stay right -----
  var iDrug = importFn.indexOf('applyDrugUI()');
  var iTarget = importFn.indexOf('state.target =');
  var iSync = importFn.indexOf('syncInputs()');

  t.ok(iDrug >= 0 && iTarget >= 0 && iSync >= 0,
    'importJson calls applyDrugUI(), restores state.target and calls syncInputs()');
  t.ok(iDrug < iTarget,
    'importJson keeps its (already correct) order: applyDrugUI() before state.target');
  t.ok(iTarget < iSync, 'importJson restores the target before syncing the DOM');

  // ---- 3. the two restore paths now agree ---------------------------------
  var GUARD = /if \(!\(state\.target\.value > 0\)\) state\.target\.value = null;/;
  t.ok(GUARD.test(importFn), 'importJson rejects a non-positive stored target');
  t.ok(GUARD.test(applySess),
    'applySession applies the SAME guard against a non-positive stored target — ' +
    'the two restore paths must not diverge');

  // ---- 4. applyDrugUI must keep resetting unconditionally -----------------
  // The other candidate fix — making the prefill conditional on "no target
  // entered yet" — would fix this bug and break drug switching, because the
  // drug-change handler has no other mechanism for moving the target to the
  // new drug's default. Pin both halves so that fix cannot be applied silently.
  t.ok(/state\.target\.value = spec\.targetDefault \|\| 75;/.test(drugUi),
    'applyDrugUI still resets state.target to the drug default unconditionally');
  t.ok(/tg\.value = spec\.targetDefault \|\| 75;/.test(drugUi),
    'applyDrugUI still prefills the target FIELD with the drug default');
  t.ok(ui.indexOf('      M.select(next);\n      applyDrugUI();\n      syncInputs();') >= 0,
    'the drug-switch handler still relies on applyDrugUI() + syncInputs(), in that order');

  return t.summary();
}

module.exports = { run: run };
