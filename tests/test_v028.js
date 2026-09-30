'use strict';
/* v0.28.0 — Independent audit (INDEPENDENT_AUDIT.md) findings F9, F12, F13,
 * F20, F21, F22, F24. Bundled into one batch and one release per the
 * author's own request: all seven are small, independent, single-file
 * changes with no engine/model risk — exactly the class the audit's own §5
 * table flags as safe to bundle ("Engine / model / MCMC code is not
 * implicated by F2, F3, F11, F13, F19, F20, F22, F23, F24. Prefer those if
 * the brief is 'small safe drop.'"). F1 (calibration) and F4/F14
 * (author decisions) are documented separately in README §33/34 and are not
 * code changes.
 *
 * F9.  aHUS's interval-narrowness caveat lived only in the About dialog and
 *      one findings-paragraph sentence, not on the trough table a consultant
 *      actually reads before advising on the next dose. Merged into the
 *      existing findingsLines() sentence (not appended as a second,
 *      differently-framed one) and added to both the on-screen and printed
 *      trough-table legends.
 * F12. localStorage's autosave persisted patient.code (a name/MRN-like
 *      identifier) indefinitely on whatever device ran the app -- a real
 *      exposure on a shared ward PC. saveSession() no longer writes it.
 * F13. #howto never said the prediction band excludes assay error, even
 *      though the trough-table legend already did -- the same fact needed
 *      to be visible in both places, not just one.
 * F20. The engine's LLOQ-without-a-set-LLOQ error pointed at "the patient
 *      card" -- stale since v0.20.0 moved LLOQ into "Assay settings".
 * F21. No guard against a caller passing epoch-milliseconds instead of days
 *      -- silently sends buildGrid()'s day-stepped loop into ~10^8
 *      iterations instead of failing fast with a clear message.
 * F22. The stepper's step 1 said "Enter weight", but card 1 is "Drug &
 *      patient" with the drug selector as its own first field -- the same
 *      numbers-must-match-cards principle already enforced for steps 2-4.
 * F24. Eculizumab's assumptions[3] pointed at "Advanced options" for the
 *      assay-error multiplier -- stale since the same v0.20.0 restructure
 *      that broke F20's string (that fold is now "Assay settings").
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches ECU.findingsLines (headless-safe)

async function run() {
  var t = new T('v0.28.0 audit F9/F12/F13/F20/F21/F22/F24 — small safe batch');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var model = fs.readFileSync('src/model.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  function bodyOf(src, name) {
    var start = src.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = src.indexOf('\n  }', start);
    return end < 0 ? src.slice(start) : src.slice(start, end + 4);
  }

  // ======================= F9 ===============================================
  M.select('eculizumab');
  function snapWith(disease) {
    return {
      patient: { code: '', wt: 70, age: null, disease: disease },
      target: { value: 75 },
      obs: [],
      fit: {
        hasObs: true,
        clQ: { med: 0.2, p5: 0.15, p95: 0.28 },
        v1Q: { med: 4.3, p5: 3.8, p95: 4.9 },
        troughs: [{ t: 14, med: 90, p5: 70, p95: 110, pTarget: 0.95 }],
        covFallback: false,
        disease: disease,
        rel: { t0ms: Date.now(), nowRel: 0, obsRel: [], excludedObs: 0 }
      }
    };
  }
  var linesAHUS = ECU.findingsLines(snapWith('aHUS'));
  var aHUSLine = linesAHUS.filter(function (l) { return l.indexOf('between-occasion variability') >= 0; });
  t.eq(aHUSLine.length, 1, 'exactly one between-occasion-variability sentence for aHUS (not two competing ones)');
  t.ok(aHUSLine.length && aHUSLine[0].indexOf('more uncertain than for PNH') >= 0,
    'the merged sentence keeps the original "more uncertain than PNH" claim');
  t.ok(aHUSLine.length && aHUSLine[0].indexOf('narrower than the full occasion-to-occasion uncertainty') >= 0,
    'the merged sentence adds the interval-narrowness caveat F9 asked for');
  var linesPNH = ECU.findingsLines(snapWith('PNH'));
  t.eq(linesPNH.filter(function (l) { return l.indexOf('between-occasion variability') >= 0; }).length, 0,
    'PNH (no IOV term) gets no between-occasion sentence at all');

  // on-screen and report trough-table legends both carry the same caveat,
  // gated on the same predicate (M.drug().IOV_DISEASES.indexOf(fit.disease))
  // used everywhere else this app makes this decision -- never a second,
  // independently-typed condition that could drift from it.
  var iovGateCount = (ui.match(/M\.drug\(\)\.IOV_DISEASES\.indexOf\(fit\.disease\) >= 0/g) || []).length;
  // baseline (pre-F9): 2 uses — the pre-existing advisory and findingsLines's
  // own gate. F9 adds exactly 2 more (on-screen legend, report legend) -> 4.
  t.eq(iovGateCount, 4, 'the IOV-disease gate is reused 4 times total (2 pre-existing + 2 new for F9), not reimplemented — found ' + iovGateCount);
  // distinct literal substrings (legend-note vs rp-legend classes) so removing
  // EITHER the on-screen or the report addition is independently detectable —
  // a shared "narrower than..." substring search alone cannot tell them apart.
  t.ok(ui.indexOf('<div class="legend-note">\' + esc(fit.disease) + \': between-occasion variability is folded into the prior, so the interval above') >= 0,
    'the ON-SCREEN trough-table legend specifically carries the interval-narrowness caveat');
  t.ok(ui.indexOf('<div class="rp-legend">\' + esc(fit.disease) + \': between-occasion variability is folded into the prior, so the interval above') >= 0,
    'the REPORT trough-table legend specifically carries the interval-narrowness caveat');

  // ======================= F12 ==============================================
  var saveBody = bodyOf(ui, 'saveSession');
  t.ok(saveBody.length > 0, 'saveSession() found in src/ui.js');
  t.ok(saveBody.indexOf('patient: state.patient,') < 0,
    'saveSession() no longer writes state.patient verbatim (that included .code)');
  t.ok(saveBody.indexOf("code: ''") >= 0,
    'saveSession() explicitly blanks .code before persisting the rest of the patient object');
  t.ok(saveBody.indexOf('Object.assign({}, state.patient') >= 0,
    'saveSession() still persists the REST of the patient object (age/disease), only code is stripped');
  // the restore-bar prompt already degrades gracefully when .code is absent
  // (an existing ternary) -- confirm that guard is still there, unchanged
  var restoreBody = bodyOf(ui, 'offerRestore');
  t.ok(restoreBody.indexOf('s.patient && s.patient.code ?') >= 0,
    'offerRestore() still guards against a missing/blank patient code (now the normal case)');

  // ======================= F13 ==============================================
  t.ok(html.indexOf('does not include assay error, so a future measured value may fall outside it') >= 0,
    '#howto’s Band bullet now states the same assay-error exclusion the trough-table legend already stated');
  var howtoBlock = html.slice(html.indexOf('id="howto"'), html.indexOf('</details>', html.indexOf('id="howto"')));
  t.ok(howtoBlock.indexOf('does not include assay error') >= 0, 'the sentence is inside the #howto block specifically, not elsewhere');

  // ======================= F20 ===============================================
  t.eq((bayes.match(/patient card/g) || []).length, 0, 'the literal "patient card" is gone from src/bayes.js');
  t.ok(bayes.indexOf('enter the assay LLOQ under Assay settings') >= 0,
    'the LLOQ throw now names the actual fold ("Assay settings")');
  // behavioural: the real throw fires with the corrected message
  M.select('eculizumab');
  var lloqDoses = [{ t: 0, amt: 900, route: 'iv' }];
  var lloqThrew = null;
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: lloqDoses,
      obs: [{ t: 5, c: null, lloq: true }], lloq: 0, target: 75, seed: 1 });
  } catch (e) { lloqThrew = e.message; }
  t.ok(!!lloqThrew && lloqThrew.indexOf('Assay settings') >= 0 && lloqThrew.indexOf('patient card') < 0,
    'a real below-LLOQ-without-LLOQ case throws the corrected message end-to-end (got: ' + lloqThrew + ')');

  // ======================= F21 ===============================================
  M.select('eculizumab');
  var okDoses = [{ t: 0, amt: 900, route: 'iv' }, { t: 14, amt: 900, route: 'iv' }];
  // sanity: a normal, small relative-day time is completely unaffected
  var normalFit = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: okDoses, obs: [], lloq: 0, target: 75, seed: 1 });
  t.ok(!!normalFit, 'a normal relative-day schedule runs exactly as before (the guard does not false-positive)');

  var msDoses = [{ t: Date.now(), amt: 900, route: 'iv' }];
  var msThrew = false, msMsg = '';
  var msStart = Date.now();
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: msDoses, obs: [], lloq: 0, target: 75, seed: 1 });
  } catch (e) { msThrew = true; msMsg = e.message; }
  var msElapsed = Date.now() - msStart;
  t.ok(msThrew, 'a dose time that looks like epoch-ms throws, rather than hanging on a multi-million-day grid');
  t.ok(/millisecond|days/i.test(msMsg), 'the error names the actual mistake (got: ' + msMsg + ')');
  t.ok(msElapsed < 5000, 'the guard fires fast (' + msElapsed + ' ms) -- before any expensive simulation work, not after a hang');

  var msObsThrew = false;
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: okDoses,
      obs: [{ t: Date.now(), c: 100, lloq: false }], lloq: 0, target: 75, seed: 1 });
  } catch (e) { msObsThrew = /millisecond|days/i.test(e.message); }
  t.ok(msObsThrew, 'an OBSERVATION time that looks like epoch-ms is caught too, not just dose times');

  // a legitimate, very-negative steady-state pre-roll time must not trip the
  // guard (sanity against an overly aggressive threshold)
  var ssDoses = [];
  for (var kd = 80; kd >= 0; kd--) ssDoses.push({ t: -kd * 56, amt: 3000, route: 'iv' });
  var ssOk = null;
  try { ssOk = await B.runFit({ wt: 70, disease: 'PNH', drug: 'ravulizumab', doses: ssDoses, obs: [], lloq: 0, target: 100, seed: 1 }); } catch (e) { ssOk = null; }
  t.ok(!!ssOk, 'a real steady-state pre-roll (80 cycles x 56 days = -4480 d) stays far under the 1e5-day threshold and runs normally');

  // ======================= F22 ===============================================
  t.ok(html.indexOf('<i>1</i> Drug &amp; weight') >= 0, 'stepper step 1 now reads "Drug & weight"');
  t.ok(html.indexOf('<i>1</i> Enter weight') < 0, 'the old "Enter weight" wording is gone');
  // the existing pinned assertion in test_usability.js must have been updated
  // in place, not left pinning the old wording (that assertion would now be
  // asserting something false about the shipped app).
  var usability = fs.readFileSync('tests/test_usability.js', 'utf8');
  // the comment explaining the change legitimately mentions the old wording
  // as history (this whole suite's convention) -- what must be gone is the
  // old wording inside the actual ASSERTION (recognisable by the regex
  // literal being applied directly to `html` right after it).
  t.ok(usability.indexOf('Enter weight/.test(html)') < 0,
    'tests/test_usability.js’s step-1 regex no longer matches on the old "Enter weight" wording');
  t.ok(usability.indexOf('Drug &amp; weight') >= 0,
    'tests/test_usability.js’s own step-1 assertion was updated to the new wording');

  // ======================= F24 ===============================================
  t.eq((model.match(/Advanced options/g) || []).length, 0, 'the literal "Advanced options" is gone from src/model.js');
  t.ok(model.indexOf('requires the assay-error multiplier in "Assay settings"') >= 0,
    'eculizumab’s assumptions now name the actual fold ("Assay settings")');

  return t.summary();
}

module.exports = { run: run };
