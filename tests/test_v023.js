'use strict';
/* v0.23.0 — Independent audit (INDEPENDENT_AUDIT.md) findings F2, F3, F11.
 *
 * F2. findingsLines() picked the upcoming trough with the LOWEST pTarget and
 *     printed it as "the trough before the NEXT dose" — a later, worse trough
 *     was written into the printed record as the imminent one. Fixed: "next"
 *     is now the smallest-t upcoming row; "worst" (lowest pTarget) is reported
 *     in a separate sentence, and only when it names a different dose than
 *     "next" (otherwise the two sentences would just repeat one row).
 *
 * F3. Three spots recommended a dose or interval change, violating this
 *     project's own rule that the app never suggests a dose (README golden
 *     rules): ptaBadge()'s warn/bad titles, the low-attainment advisory, and
 *     the #howto bullet. All three now report probability only.
 *
 * F11. ptaBadge() printed the literal string "P ≥ 90%" once above threshold,
 *      hiding whether the real number was 91% or 99%. Now always prints the
 *      actual rounded percent, at every threshold.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches ECU.findingsLines / ECU.ptaBadge (headless-safe)

var DAY = 86400000;

async function run() {
  var t = new T('v0.23.0 audit F2/F3/F11 — record correctness + no dose suggestion');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ======================= F2 ==============================================
  M.select('eculizumab');

  function snapWith(troughs, nowRel) {
    var t0ms = Date.now() - 60 * DAY;
    return {
      patient: { code: '', wt: 70, age: null, disease: 'PNH' },
      target: { value: 75 },
      obs: [],
      fit: {
        hasObs: true,
        clQ: { med: 0.2, p5: 0.15, p95: 0.28 },
        v1Q: { med: 4.3, p5: 3.8, p95: 4.9 },
        troughs: troughs,
        covFallback: false,
        disease: 'PNH',
        rel: { t0ms: t0ms, nowRel: nowRel, obsRel: [{ t: 0 }], excludedObs: 0 }
      }
    };
  }

  // -- two upcoming troughs, nearest is NOT the worst: t=14 (P=0.99) is next,
  // t=28 (P=0.40) is worse but later. Before the fix, the worst (t=28) row was
  // printed as "before the next dose" -- exactly the bug.
  var snap1 = snapWith([
    { t: 14, med: 90, p5: 70, p95: 110, pTarget: 0.99 },
    { t: 28, med: 40, p5: 20, p95: 60, pTarget: 0.40 }
  ], 0);
  var lines1 = ECU.findingsLines(snap1);
  var nextDoseLine = lines1.filter(function (l) { return l.indexOf('before the next dose') >= 0; });
  t.eq(nextDoseLine.length, 1, 'exactly one "before the next dose" sentence is printed');
  // fmtDate() is internal to ui.js (not exported), so the date itself isn't
  // directly checkable headlessly -- assert on content that IS: the P and
  // median values, which is exactly what the bug mixed up between rows.
  t.ok(nextDoseLine[0].indexOf('99%') >= 0, '"next dose" sentence carries t=14\'s own P (99%), not t=28\'s');
  t.ok(nextDoseLine[0].indexOf('90') >= 0, '"next dose" sentence carries t=14\'s own median (90), not t=28\'s (40)');
  t.ok(nextDoseLine[0].indexOf('40%') < 0, '"next dose" sentence does NOT carry t=28\'s P (40%) -- the exact bug being fixed');

  var worstLine = lines1.filter(function (l) { return l.indexOf('lowest predicted attainment') >= 0; });
  t.eq(worstLine.length, 1, 'a separate "lowest predicted attainment" sentence is printed for the worse, later dose');
  t.ok(worstLine.length && worstLine[0].indexOf('40%') >= 0, 'the worst-trough sentence carries t=28\'s own P (40%)');
  t.ok(worstLine.length && worstLine[0].indexOf('before the next dose') < 0, 'the worst-trough sentence is never itself labelled "the next dose"');

  // -- the nearest upcoming trough IS also the worst: only ONE trough
  // sentence should ever be printed, never two identical-sounding ones.
  var snap2 = snapWith([
    { t: 14, med: 40, p5: 20, p95: 60, pTarget: 0.40 },
    { t: 28, med: 90, p5: 70, p95: 110, pTarget: 0.99 }
  ], 0);
  var lines2 = ECU.findingsLines(snap2);
  var troughSentences2 = lines2.filter(function (l) { return l.indexOf('trough before the next dose') >= 0 || l.indexOf('lowest predicted attainment') >= 0; });
  t.eq(troughSentences2.length, 1, 'when the next dose is also the worst, only one trough sentence is printed (no duplicate)');

  // -- only one upcoming trough at all: same guard, same single sentence.
  var snap3 = snapWith([{ t: 14, med: 90, p5: 70, p95: 110, pTarget: 0.99 }], 0);
  var lines3 = ECU.findingsLines(snap3);
  t.eq(lines3.filter(function (l) { return l.indexOf('lowest predicted attainment') >= 0; }).length, 0,
    'a single upcoming trough never gets a second "worst" sentence');

  // ======================= F3 ===============================================
  ['consider adjusting', 'consider a dose', 'suggests considering'].forEach(function (phrase) {
    t.ok(ui.indexOf(phrase) < 0, 'src/ui.js contains no dose-suggestion phrase: "' + phrase + '"');
    t.ok(html.indexOf(phrase) < 0, 'index.html contains no dose-suggestion phrase: "' + phrase + '"');
  });
  // the underlying probability statement must still be there -- F3 removes
  // the RECOMMENDATION, not the fact that attainment is being reported
  t.ok(ui.indexOf('not predicted to be reached with') >= 0,
    'the low-attainment advisory still reports probability, non-directively');
  t.ok(html.indexOf('P(trough') >= 0, '#howto still explains what P(trough > target) means');

  // ======================= F11 ==============================================
  t.ok(ECU.ptaBadge(0.91, null).indexOf('91') >= 0, 'ptaBadge(0.91): shows the actual percent (91), not just a threshold');
  t.ok(ECU.ptaBadge(0.91, null).indexOf('≥ 90') < 0, 'ptaBadge(0.91): no longer prints the literal "≥ 90%" text');
  t.ok(ECU.ptaBadge(0.99, null).indexOf('99') >= 0, 'ptaBadge(0.99): shows 99, not 90');
  t.ok(ECU.ptaBadge(0.65, null).indexOf('65') >= 0, 'ptaBadge(0.65): warn-tier badge still shows its own percent');
  t.ok(ECU.ptaBadge(0.05, null).indexOf('5') >= 0, 'ptaBadge(0.05): bad-tier badge still shows its own percent');
  // colour bucketing itself (>=0.9 ok, >=0.5 warn, else bad) is unchanged by
  // F3/F11 -- only the copy/label changed
  t.ok(ECU.ptaBadge(0.91, null).indexOf('badge ok') >= 0, 'p=0.91 still gets the "ok" colour class');
  t.ok(ECU.ptaBadge(0.65, null).indexOf('badge warn') >= 0, 'p=0.65 still gets the "warn" colour class');
  t.ok(ECU.ptaBadge(0.05, null).indexOf('badge bad') >= 0, 'p=0.05 still gets the "bad" colour class');

  return t.summary();
}

module.exports = { run: run };
