/* Tests for the v0.8.0 novice-usability improvements (P1–P5 of
 * NOVICE_UI_REVIEW.md).
 *  1. ⓘ popover markers exist for the six promoted fields and their keys
 *     match the HELP map (plus the dynamic 'pta' badge).
 *  2. Popover wording is prescriber language; native `title`s are kept
 *     (two-tier scheme intact).
 *  3. P1 stepper: three steps (numbers matching cards 1-3) + dismiss; run-hint
 *     element present; age field is empty-by-default (P4) while weight has
 *     no prefill either.
 *  4. P3: precisionWord buckets ESS/covFallback sensibly.
 *  5. Report machinery unaffected (no version regressions). */
var u = require('./util.js');

require('../src/version.js');   // central version string (v0.12.0)
require('../src/chart.js');     // ECU.chart (log tan) for the v0.12 assertions
require('../src/ui.js');   // attaches ECU.HELP / ECU.helpTextFor / ECU.precisionWord

async function run() {
  var t = new u.T('novice usability (v0.8.0)');
  var fs = require('fs');
  var html = fs.readFileSync('index.html', 'utf8');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  // ---- 1. P2: ⓘ markers on the six promoted fields -----------------------
  var six = ['data-help="wt"', 'data-help="age"', 'data-help="target"',
             'data-help="lloq"', 'data-help="lloqbox"', 'data-help="errmult"'];
  six.forEach(function (m) {
    t.ok(html.indexOf(m) >= 0, 'index.html: popover marker ' + m + ' present');
  });
  t.ok(html.split('class="info"').length - 1 >= 6, 'index.html: at least six ⓘ buttons');
  t.ok(html.indexOf('data-help="pta"') < 0, 'index.html: pta badge is dynamic (not in static HTML)');

  // every static data-help key resolves to HELP text
  Object.keys({ wt: 1, age: 1, target: 1, lloq: 1, lloqbox: 1, errmult: 1 }).forEach(function (k) {
    t.ok(typeof ECU.HELP[k] === 'string' && ECU.HELP[k].length > 20,
      'HELP text for "' + k + '" present and non-trivial');
  });

  // P-badge renders the dynamic key (the popover falls back to the title)
  t.ok(ui.indexOf('data-help="pta"') >= 0, 'ui.js: P-badge carries the dynamic pta popover key');

  // ---- 2. two-tier scheme: native titles kept alongside popovers ---------
  ['pt-wt', 'pt-target', 'pt-lloq'].forEach(function (id) {
    var re = new RegExp('id="' + id + '"[^>]*title="', 'm');
    t.ok(re.test(html), 'index.html: ' + id + ' keeps its native title (tier 2 preserved)');
  });

  // ---- 3. P1 stepper + run hint; P4 empty-by-default age -----------------
  ['data-step="wt"', 'data-step="dose"', 'data-step="run"',
   'id="stepperDismiss"', 'id="runHint"', 'id="toast"'].forEach(function (m) {
    t.ok(html.indexOf(m) >= 0, 'index.html: ' + m + ' present');
  });
  t.ok(html.indexOf('data-step="obs"') < 0,
    'the old separate "samples" step is gone (merged into "dose", card 2)');
  /* v0.16.0: every number the stepper shows must match the numbered card it
   * belongs to. v0.19.0: step 4 was re-added (feedback: the stepper should
   * still reach 4, matching card 4) — it becomes reachable once a forecast
   * exists rather than being left out entirely. */
  // F22 (independent audit, 2026-09-13): card 1 is "Drug & patient" and the
  // drug selector is its first field, but step 1 said "Enter weight" -- the
  // same numbers-must-match-cards principle this whole block already tests
  // for steps 2-4. Updated in place, not appended to, since the old wording
  // no longer describes what the app shows.
  t.ok(/<i>1<\/i>\s*Drug &amp; weight/.test(html), 'stepper step 1 is numbered 1 and matches card 1 (drug is card 1’s own first field)');
  t.ok(/<i>2<\/i>\s*Add doses/.test(html), 'stepper step 2 is numbered 2 (matches card 2)');
  t.ok(/<i>3<\/i>\s*Run forecast/.test(html), 'stepper step 3 is numbered 3 (matches card 3)');
  t.ok(/<i>4<\/i>\s*Explore regimen/.test(html), 'stepper step 4 is numbered 4 (matches card 4)');
  t.ok(html.indexOf('id="pt-age" min="1" max="100" step="1" value="36"') < 0,
    'P4: age field no longer pre-filled with 36');
  t.ok(html.indexOf('placeholder="e.g. 36"') >= 0, 'P4: age uses an example placeholder');
  t.ok(html.indexOf('value="70"') < 0, 'P4: weight stays empty-by-default (no value=70)');
  t.ok(html.indexOf('Leave unchanged unless your lab advises') >= 0,
    'P4: assay multiplier carries the "leave unchanged" legend');
  t.ok(html.indexOf('id="footerVersion"') >= 0 && html.indexOf('v0.11.0') < 0,
    'footer version is a placeholder filled from the central string (no literal)');

  // ---- 4. P3: precisionWord buckets --------------------------------------
  t.eq(ECU.precisionWord({ hasObs: false }), 'not applicable (population forecast)',
    'precisionWord: population forecast wording');
  t.ok(ECU.precisionWord({ hasObs: true, covFallback: true, essCL: 900 }).indexOf('low') === 0,
    'precisionWord: Laplace fallback -> low');
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 50 }), 'low (consider re-sampling or additional samples)',
    'precisionWord: ESS < 100 -> low');
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 200 }), 'intermediate', 'precisionWord: 100-299 -> intermediate');
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 600 }), 'good', 'precisionWord: >= 300 -> good');

  // ---- 4b. adversarial-review fixes (v0.8.0 rev2) ------------------------
  var css = fs.readFileSync('src/app.css', 'utf8');
  // ⓘ buttons must NOT be nested inside labels (label-click forwarding hazard)
  t.ok(html.indexOf('<label class="f" for="pt-wt">Weight (kg) <button') < 0,
    'fix: ⓘ no longer nested inside the weight label');
  var lblHelp = html.split('class="lbl-help"').length - 1;
  t.ok(lblHelp >= 5, 'fix: label/ⓘ pairs restructured as siblings (' + lblHelp + '/5)');
  t.ok(html.split('aria-expanded="false"').length - 1 >= 6,
    'fix: info buttons carry aria-expanded="false"');
  t.ok(html.indexOf('id="toast" role="status" aria-live="polite"') >= 0,
    'fix: toast announced via role=status + aria-live=polite');
  // ephemeral layers hidden in print (they live outside header/main)
  t.ok(/#stepper, #helpPop, \.toast, \.run-hint \{ display: none !important; \}/.test(css),
    'fix: stepper/popover/toast/run-hint hidden in @media print');
  t.ok(css.indexOf('#helpPop {') > 0 && css.indexOf('#helpPop.show') > 0,
    'css: popover styles present');
  // ui.js behaviour: aria sync + viewport flip
  t.ok(ui.indexOf('function setExpanded') >= 0 && ui.indexOf("setAttribute('aria-expanded'") >= 0,
    'fix: popover aria-expanded kept in sync (open/toggle/outside/Escape)');
  t.ok(ui.indexOf('spaceBelow') >= 0 && ui.indexOf("- ph - 6") >= 0,
    'fix: popover flips above the trigger when there is no room below');
  t.ok(ui.indexOf("pop.setAttribute('role', 'note')") >= 0, 'fix: popover has role=note');

  // ---- 5. helpTextFor fallback + report functions still exported ---------
  t.eq(ECU.helpTextFor('wt', null), ECU.HELP.wt, 'helpTextFor: HELP map lookup');
  t.ok(typeof ECU.reportHtml === 'function' && typeof ECU.findingsLines === 'function',
    'report generators still exported');

  // ---- 6. v0.9.2 shrinkage visual ----------------------------------------
  if (typeof ECU.infoBars === 'function') {
    var fitGood = { hasObs: true, etaInformation: [0.8, 0.7], map: { etaNames: ['CL', 'V1'] } };
    var fitWeak = { hasObs: true, etaInformation: [0.1, 0.35], map: { etaNames: ['CL', 'V1'] } };
    var fitNull = { hasObs: true, etaInformation: null, map: null };
    var g = ECU.infoBars(fitGood), w = ECU.infoBars(fitWeak), n = ECU.infoBars(fitNull);
    t.ok(g.indexOf('shrink-fill ok') >= 0 && g.indexOf('80%') >= 0,
      'shrink visual: high shrinkage renders green bar with percent');
    t.ok(w.indexOf('shrink-fill weak') >= 0 && w.indexOf('shrink-fill warn') >= 0,
      'shrink visual: 0.1 -> grey (prior-anchored), 0.35 -> amber');
    t.ok(g.indexOf('shrink-key') >= 0 && g.indexOf('population prior') >= 0,
      'shrink visual: colour key legend present');
    t.eq(n, '', 'shrink visual: empty when no shrinkage data (population fit)');
    var cssShr = fs.readFileSync('src/app.css', 'utf8');
    t.ok(cssShr.indexOf('.shrink-bars {') >= 0 && cssShr.indexOf('.shrink-fill.ok') >= 0,
      'shrink visual: styles present in app.css');
    t.ok(cssShr.indexOf('.shrink-bars { background: #fff') >= 0,
      'shrink visual: print rules keep bars legible on paper');
    t.ok(ui.indexOf('function infoBars') >= 0 && ui.indexOf('infoBars(fit)') >= 0,
      'shrink visual: wired into results card and exported');
  } else {
    t.fail++; t.msgs.push('FAIL: infoBars not exported from ui.js');
  }

  // ---- 7. v0.12.0: log y-axis, folded target, central version, research link
  t.ok(html.indexOf('id="logY"') >= 0, 'v0.12: log-scale y-axis toggle present');
  t.ok(html.indexOf('id="targetFold"') >= 0 && html.indexOf('id="targetFoldVal"') >= 0,
    'v0.12: trough target folded (details + value summary)');
  t.ok(/<details class="sess-fold" id="targetFold">[\s\S]*?id="pt-target"/.test(html),
    'v0.12: pt-target lives inside the fold');
  t.ok(html.indexOf('id="titleVersion"') >= 0 && html.indexOf('id="footerVersion"') >= 0,
    'v0.12: version placeholders in header + footer');
  t.ok(html.indexOf('applied-pharmacometrics') >= 0, 'v0.12: research-group link in the footer');
  t.ok(ui.indexOf('applied-pharmacometrics') >= 0, 'v0.12: research-group link in About');
  t.ok(ui.indexOf('ECU.VERSION') >= 0, 'v0.12: ui reads the central version');
  t.ok(ui.indexOf('updateTargetFold') >= 0 && ui.indexOf('applyVersion') >= 0,
    'v0.12: fold + version helpers wired');
  t.ok(typeof ECU.appVersion === 'string' && /^\d+\.\d+\.\d+$/.test(ECU.appVersion),
    'v0.12: ECU.appVersion exposed (got ' + ECU.appVersion + ')');
  t.ok(html.indexOf('placeholder="e.g. ID001"') >= 0 && html.indexOf('PNH-001') < 0,
    'v0.12: patient ID placeholder is generic (e.g. ID001)');
  t.ok(ui.indexOf('s.reviewUrl') >= 0, 'v0.12: About renders the per-model review reference link');
  t.ok(css.indexOf('.sess-fold') >= 0 && css.indexOf('.chart-log') >= 0,
    'v0.12: fold + log-toggle styles present');
  var chartSrc = fs.readFileSync('src/chart.js', 'utf8');
  t.ok(chartSrc.indexOf('logTicks') >= 0 && chartSrc.indexOf('logY') >= 0,
    'v0.12: chart.js supports a log y-axis');
  var lt = ECU.chart.logTicks(1, 100);
  t.ok(lt.indexOf(1) >= 0 && lt.indexOf(2) >= 0 && lt.indexOf(10) >= 0 && lt.indexOf(100) >= 0,
    'v0.12: logTicks produces the 1-2-5 sequence per decade');

  return t.summary();
}

module.exports = { run: run };
