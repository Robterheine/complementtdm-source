'use strict';
/* v0.39.0 — the run-button hint names the weight range when a weight WAS
 * entered but is out of range for the selected drug.
 *
 * Reported by a colleague using the app with an 8 kg patient: the Run
 * forecast button was disabled with "Enter the patient's weight to run the
 * forecast." although a weight had been entered. The cause was legitimate
 * (ravulizumab and crovalimab accept 25-300 kg; only eculizumab accepts
 * 3-300 kg since v0.38.0) but the message gave no hint of it, and read as
 * a bug.
 *
 * Fix: updateRunReady() keeps the old wording when the weight field is blank
 * or not a number, and otherwise says which range applies to which drug:
 * "Enter a weight between 25 and 300 kg for Ravulizumab to run the forecast."
 * ui.js has no DOM in this harness, so this is covered by source-slicing the
 * function (same convention as tests/test_v037.js).
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.39.0 run-button hint names the weight range');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var start = ui.indexOf('function updateRunReady() {');
  var end = ui.indexOf('\n  }\n', start);
  var src = ui.slice(start, end);
  t.ok(start >= 0 && end > start, 'located updateRunReady()');

  // blank / non-numeric weight: unchanged wording
  t.ok(/isFinite\(state\.patient\.wt\)/.test(src),
    'the hint distinguishes an entered weight from a blank one');
  t.ok(src.indexOf("'the patient\\u2019s weight'") >= 0,
    'a blank weight still asks for "the patient’s weight"');

  // entered but out of range: names the range and the drug
  t.ok(src.indexOf("'a weight between '") >= 0, 'an out-of-range weight asks for "a weight between …"');
  t.ok(/weightRange\(\)/.test(src) && /wr\.min/.test(src) && /wr\.max/.test(src),
    'the hint quotes the drug’s own weightRange min and max, not hardcoded numbers');
  t.ok(src.indexOf('M.drug().label') >= 0, 'the hint names the selected drug');
  t.ok(!/between 25 and 300|between 3 and 300/.test(src), 'no hardcoded range in the message');

  // the surrounding sentence structure is intact
  t.ok(src.indexOf("'Enter ' + reasons.join(' and ') + ' to run the forecast.'") >= 0,
    'the "Enter … to run the forecast." sentence frame is unchanged');

  return t.summary();
}

module.exports = { run: run };
