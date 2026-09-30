'use strict';
/* v0.34.0 — wider, uniform plausible-concentration bounds for the measurement
 * field.
 *
 * Author report (live use): the per-drug measurement bounds (eculizumab and
 * ravulizumab capped at 2000 µg/mL, crovalimab at 5000 µg/mL, with no
 * explicit floor beyond "not negative") were too narrow for real samples.
 * Instruction: use a single 0.01–10000 µg/mL plausible range for all three
 * drugs.
 *
 * Fix: src/model.js gets a new per-drug `obsValMin` alongside the existing
 * `obsValMax`, both set to 0.01 / 10000 for every drug (keeping the existing
 * per-drug-spec convention rather than a hardcoded shared constant, so a
 * future drug could still differ). index.html's #obs-val native min/max
 * attributes, applyDrugUI()'s field sync, and the obsForm submit handler's
 * plausibility check (which previously only rejected values ABOVE maxC) all
 * move to the same bounds; a new low-end alert mirrors the existing wording
 * of the high-end one. The unrelated 8-fold-median non-blocking sanity
 * dialog is untouched.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, T = u.T;

async function run() {
  var t = new T('v0.34.0 widen plausible-concentration bounds to 0.01-10000 µg/mL');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ---- 1. model.js: uniform bounds on all three real drugs -----------------
  ['eculizumab', 'ravulizumab', 'crovalimab'].forEach(function (id) {
    var s = M.spec(id);
    t.eq(s.obsValMin, 0.01, id + ': obsValMin is 0.01 µg/mL');
    t.eq(s.obsValMax, 10000, id + ': obsValMax is 10000 µg/mL');
  });

  // ---- 2. index.html: native input attributes match ------------------------
  t.ok(/id="obs-val"[^>]*min="0\.01"/.test(html), '#obs-val has min="0.01"');
  t.ok(/id="obs-val"[^>]*max="10000"/.test(html), '#obs-val has max="10000"');

  // ---- 3. applyDrugUI(): syncs both bounds from the spec, with the new ----
  //         defaults, not the old 2000 one
  t.ok(ui.indexOf("ov.min = spec.obsValMin || 0.01") >= 0,
    'applyDrugUI() sets the field min from the spec (default 0.01, not unset)');
  t.ok(ui.indexOf("ov.max = spec.obsValMax || 10000") >= 0,
    'applyDrugUI() sets the field max from the spec (default 10000, not the old 2000)');

  // ---- 4. obsForm submit handler: a real low-end plausibility check exists,
  //         mirroring the pre-existing high-end one -------------------------
  var formStart = ui.indexOf("$('obsForm').addEventListener('submit'");
  var formEnd = ui.indexOf("$('iv-run')");
  var formSrc = ui.slice(formStart, formEnd);
  t.ok(formStart >= 0 && formEnd > formStart, 'located the obsForm submit handler source');

  t.ok(formSrc.indexOf("M.drug().obsValMin || 0.01") >= 0,
    'the handler reads the low-end bound from the spec (default 0.01)');
  t.ok(formSrc.indexOf("M.drug().obsValMax || 10000") >= 0,
    'the handler reads the high-end bound from the spec (default 10000, not the old 2000)');
  t.ok(/c < minC[\s\S]{0,200}below the plausible range/.test(formSrc),
    'a quantified sample below minC is rejected with a "below the plausible range" alert');
  t.ok(/c > maxC[\s\S]{0,200}above the plausible range/.test(formSrc),
    'a quantified sample above maxC is still rejected with the pre-existing "above the plausible range" alert');

  // the unrelated 8-fold-median sanity confirm() must be untouched
  t.ok(formSrc.indexOf('8 * med') >= 0 && formSrc.indexOf('differs about') >= 0,
    'the unrelated non-blocking 8-fold-median sanity dialog is still present, unchanged');

  // the low-end check must not fire on below-LLOQ entries (mirrors the
  // existing !below guard on the high-end check)
  var minCheckIdx = formSrc.indexOf('c < minC');
  var maxCheckIdx = formSrc.indexOf('c > maxC');
  t.ok(minCheckIdx >= 0 && /!below && c < minC/.test(formSrc.slice(Math.max(0, minCheckIdx - 12), minCheckIdx + 8)),
    'the low-end check is guarded by !below, same as the high-end check');
  t.ok(maxCheckIdx > minCheckIdx, 'the low-end check runs before the high-end check');

  return t.summary();
}

module.exports = { run: run };
