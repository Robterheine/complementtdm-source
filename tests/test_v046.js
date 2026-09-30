'use strict';
/* v0.46.0 — small input and layout fixes (review 2026-09-30: U2, U3, U5, T1, D2,
 * and the unsorted measurement table from U6).
 *
 * U2. An assay error multiplier outside 0.1-10 was silently replaced by 1: a
 *     typed 50 gave output byte-identical to 1, while a valid 3 moved
 *     P(trough > 75) from 96% to 69%. It is now a run-blocking reason, worded
 *     like the trough-target one.
 * U3. At <= 700 px the session row becomes a column, and the flex-basis of
 *     `.sess-field` (128 px, 170 px for the drug) then applied as a HEIGHT: the
 *     32 px trough-target fold sat in a 128 px box. Measured ~400 px of blank
 *     space on a phone.
 * U5. Typing an age below the minimum said "Enter the patient's age".
 * T1. The R-hat advisory said "re-run", but the seed is a constant, so a re-run
 *     reproduces the same chain exactly.
 * D2. The age typed for crovalimab stayed in the session after switching to a
 *     drug that has no age covariate, and was written to its export.
 * U6 (part). The measurement table was in entry order, not time order.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, T = u.T;
require('../src/chart.js');
require('../src/diagnostics.js');
require('../src/ui.js');

var ROOT = require('path').resolve(__dirname, '..');

async function run() {
  var t = new T('v0.46.0 multiplier, phone layout, age message, advice text, hidden age, sample order');
  var ui = fs.readFileSync(ROOT + '/src/ui.js', 'utf8');
  var css = fs.readFileSync(ROOT + '/src/app.css', 'utf8');
  function bodyOf(name) {
    var s = ui.indexOf('function ' + name + '(');
    if (s < 0) return '';
    var en = ui.indexOf('\n  }', s);
    return en < 0 ? ui.slice(s) : ui.slice(s, en + 4);
  }

  // ---- U2 ---------------------------------------------------------------------
  t.ok(typeof ECU.parseErrMult === 'function', 'ECU.parseErrMult is exported');
  if (typeof ECU.parseErrMult === 'function') {
    var p = ECU.parseErrMult;
    t.ok(p('').ok && p('').value === 1, 'empty: default 1, valid');
    t.ok(p(undefined).ok && p(undefined).value === 1, 'undefined: default 1, valid');
    t.ok(p('1').ok && p('1').value === 1, '1 is valid');
    t.ok(p('3').ok && p('3').value === 3, '3 is valid');
    t.ok(p('0.1').ok && p('10').ok, 'the limits 0.1 and 10 are valid');
    t.ok(!p('50').ok, '50 is NOT valid (it used to become 1 silently)');
    t.ok(!p('0.05').ok, '0.05 is NOT valid');
    t.ok(!p('0').ok && !p('-2').ok, '0 and negatives are NOT valid');
    t.ok(!p('abc').ok, 'text is NOT valid');
    t.ok(!p('Infinity').ok, 'Infinity is NOT valid');
  }
  var upd = bodyOf('updateRunReady');
  t.ok(/assay error multiplier between 0\.1 and 10/.test(upd), 'the Run hint names the multiplier rule');
  t.ok(/errMultOk|errMultValid/.test(upd), 'updateRunReady consults the multiplier validity');
  t.ok(/errMult(Ok|Valid)/.test(bodyOf('runFit')), 'runFit refuses an invalid multiplier as well');

  // ---- U3 ---------------------------------------------------------------------
  var mq = css.indexOf('@media (max-width: 700px)');
  t.ok(mq > 0, 'the 700px media block exists');
  var block = css.slice(mq, css.indexOf('@media', mq + 10) > 0 ? css.indexOf('@media', mq + 10) : css.length);
  t.ok(/\.sess-field[^{]*\{[^}]*flex:\s*0 0 auto/.test(block), 'inside the 700px block .sess-field no longer uses a flex-basis as a height (flex: 0 0 auto)');
  t.ok(/\.sess-field\.sess-drug[^{]*\{[^}]*flex:\s*0 0 auto|\.sess-field,\s*\.sess-field\.sess-drug/.test(block), 'and neither does the drug field (170px basis)');
  t.ok(/\.sess-field\s*\{\s*flex:\s*1 1 128px/.test(css), 'desktop rule is unchanged (still wraps in a row)');

  // ---- U5 ---------------------------------------------------------------------
  t.ok(typeof ECU.ageReason === 'function', 'ECU.ageReason is exported');
  if (typeof ECU.ageReason === 'function') {
    var cs = M.spec('crovalimab'), es = M.spec('eculizumab');
    t.eq(ECU.ageReason(es, null), null, 'no age needed for eculizumab');
    t.eq(ECU.ageReason(cs, 30), null, 'age 30 is fine for crovalimab');
    t.eq(ECU.ageReason(cs, 12), null, 'age 12 (the minimum) is fine');
    t.ok(/12 years or more/.test(ECU.ageReason(cs, 8) || ''), 'age 8: says the minimum (12 years or more)');
    t.ok(/Crovalimab/.test(ECU.ageReason(cs, 8) || ''), 'and names the drug');
    t.ok(/patient.s age/.test(ECU.ageReason(cs, null) || '') && !/years/.test(ECU.ageReason(cs, null) || ''), 'age missing: asks for it without quoting a rule');
    t.ok(/100/.test(ECU.ageReason(cs, 130) || ''), 'age 130: says the maximum');
  }
  t.ok(/ageReason\(/.test(upd), 'the Run hint uses ageReason');

  // ---- T1 ---------------------------------------------------------------------
  t.ok(!/re-run, or add a sample/.test(ui), 'the R-hat advisory no longer tells the user to re-run');
  t.ok(!/; re-run/.test(ui), 'no other advisory tells the user to re-run a fixed-seed fit');
  t.ok(/SEED = 20250907/.test(ui), 'premise check: the seed is still a constant (so a re-run would be identical)');

  // ---- D2 ---------------------------------------------------------------------
  t.ok(typeof ECU.effectiveAge === 'function', 'ECU.effectiveAge is exported');
  if (typeof ECU.effectiveAge === 'function') {
    t.eq(ECU.effectiveAge(M.spec('crovalimab'), '30'), 30, 'crovalimab keeps the typed age');
    t.eq(ECU.effectiveAge(M.spec('eculizumab'), '30'), null, 'eculizumab drops it');
    t.eq(ECU.effectiveAge(M.spec('ravulizumab'), 45), null, 'ravulizumab drops it');
    t.eq(ECU.effectiveAge(M.spec('crovalimab'), ''), null, 'empty stays null');
    t.eq(ECU.effectiveAge(M.spec('crovalimab'), '-3'), null, 'non-positive stays null');
  }
  var rp = bodyOf('readPatient');
  t.ok(/effectiveAge\(/.test(rp), 'readPatient derives the age through effectiveAge');
  t.ok(rp.indexOf('M.select(state.drug)') < rp.indexOf('effectiveAge('), 'and only after the drug is selected (it used to read the age first)');

  // ---- U6 (sample order) ------------------------------------------------------
  var ro = bodyOf('renderObs');
  t.ok(/state\.obs\.sort\(/.test(ro), 'renderObs sorts the samples by time, as renderDoses does for doses');
  t.ok(ro.indexOf('state.obs.sort(') < ro.indexOf('state.obs.forEach'), 'and sorts before the rows are built (so row indices stay consistent)');

  return t.summary();
}

module.exports = { run: run };
