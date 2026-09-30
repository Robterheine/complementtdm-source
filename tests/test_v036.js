'use strict';
/* v0.36.0 — chart hover tooltip: two-sided edge clamp.
 *
 * Finding from an external adversarial review (handed off in
 * adversarial_review_engine_statistical_correctness_handoff.md, "Finding C").
 * Independently re-verified before acting on it (the same review's two other
 * "true positive" findings did not reproduce against the actual code and
 * were NOT acted on -- see that investigation's own conclusion). This one
 * did reproduce: src/chart.js's hover handler clamped the tooltip only on
 * the right edge:
 *
 *   tip.style.left = Math.min(tx, host.width - 190) + 'px';
 *
 * On a narrow card (this app was explicitly redesigned for phone widths,
 * v0.17.0), `host.width - 190` can be small or negative, pinning the
 * tooltip near or off the LEFT edge instead.
 *
 * Fix: a two-sided clamp, `Math.max(4, Math.min(tx, host.width - tipW - 4))`,
 * keeping the tooltip at least 4px from either edge of the card.
 *
 * chart.js has no DOM available in the node test harness, so this test
 * covers it the same way tests/test_audit.js's A2 (hover coordinate mapping)
 * does: replicate the small pure formula here and check it against the
 * cases that matter, plus a source-slice guard confirming the shipped code
 * still contains exactly this clamp (not a diverged copy).
 */
var fs = require('fs');
var T = require('./util.js').T;

function clampedLeft(tx, hostWidth, tipW) {
  return Math.max(4, Math.min(tx, hostWidth - tipW - 4));
}

async function run() {
  var t = new T('v0.36.0 chart hover tooltip: two-sided edge clamp');
  var chart = fs.readFileSync('src/chart.js', 'utf8');

  // ---- 1. source guard: the shipped clamp is two-sided ---------------------
  var handlerStart = chart.indexOf("rect.addEventListener('mousemove'");
  var handlerEnd = chart.indexOf("rect.addEventListener('mouseleave'");
  var handlerSrc = chart.slice(handlerStart, handlerEnd);
  t.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'located the hover mousemove handler');
  t.ok(handlerSrc.indexOf('Math.max(4,') >= 0, 'the tooltip left position has a left-edge floor (Math.max)');
  t.ok(/Math\.max\(4,\s*Math\.min\(tx,\s*host\.width\s*-\s*tipW\s*-\s*4\)\)/.test(handlerSrc),
    'the tooltip left position is a two-sided clamp: max(4, min(tx, host.width - tipW - 4))');

  // ---- 2. formula behaviour: the case Finding C actually described --------
  // A narrow card (320px, well within this app's phone breakpoint) with the
  // cursor near the chart's own left edge (tx close to its minimum, ~14px):
  // the old right-only clamp gave min(14, 320-190) = min(14, 130) = 14, which
  // happened to be fine here -- the real failure needs host.width small
  // enough that host.width - tipW goes negative.
  t.eq(clampedLeft(14, 200, 190), 6,
    'on a narrow card (200px), the right-edge clamp already pulls the tooltip in from tx=14 to 6px, still non-negative');
  t.eq(clampedLeft(14, 150, 190), 4,
    'on a narrower card still (150px, host.width - tipW - 4 goes negative), the 4px left floor wins instead');

  // ---- 3. unaffected cases stay unaffected ---------------------------------
  // A wide card, cursor near the left: nothing changes vs. the old formula.
  t.eq(clampedLeft(14, 960, 190), 14, 'on a wide card, a left-edge hover is unclamped, same as before');
  // A wide card, cursor near the right: still clamped by the right edge, same
  // numeric result as the old formula (960 - 190 - 4 = 766, vs. old 960-190=770
  // -- 4px tighter by design, still comfortably inside the card).
  t.eq(clampedLeft(900, 960, 190), 766, 'on a wide card, a right-edge hover is still clamped by the right edge');

  return t.summary();
}

module.exports = { run: run };
