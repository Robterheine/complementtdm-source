'use strict';
/* v0.18.0 — the restore bar and the novice stepper now line up with the
 * cards below them.
 *
 * Both used to sit OUTSIDE <main class="layout">, as direct children of
 * <body>, with their own independently-tuned max-width + margin:auto
 * (1180px / 1720px respectively). That only approximately matched
 * main.layout's actual box (1180px, its own 18px padding creating the
 * cards' inset) at any given viewport width — confirmed visually by the
 * author on a wide desktop window, where the bars visibly bled to the
 * browser edge while the cards sat in a centered, inset column.
 *
 * Fix: move both inside <main class="layout"> as flex siblings of the
 * cards. main.layout is display:flex; flex-direction:column with default
 * align-items:stretch, which is exactly how .card already gets its width
 * with no explicit sizing of its own — the bars now get the identical
 * mechanism instead of a separately-tuned approximation, so they are
 * *structurally* guaranteed to match at every viewport width, not just
 * tuned to look right at the widths someone happened to test.
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.18.0 restore-bar/stepper alignment with cards');
  var html = fs.readFileSync('index.html', 'utf8');
  var css = fs.readFileSync('src/app.css', 'utf8');

  var mainOpen = html.indexOf('<main class="layout">');
  var mainClose = html.indexOf('</main>');
  var restoreIdx = html.indexOf('id="restoreBar"');
  var stepperIdx = html.indexOf('id="stepper"');
  var firstCardIdx = html.indexOf('id="patientCard"');

  t.ok(mainOpen >= 0 && mainClose > mainOpen, '<main class="layout"> exists and is well-formed');
  t.ok(restoreIdx > mainOpen && restoreIdx < mainClose,
    'the restore bar is now INSIDE <main class="layout">, not before it');
  t.ok(stepperIdx > mainOpen && stepperIdx < mainClose,
    'the stepper is now INSIDE <main class="layout">, not before it');
  t.ok(restoreIdx < firstCardIdx && stepperIdx < firstCardIdx,
    'both sit before the first card, in reading order');

  // The old per-element width tuning must be gone — main.layout's own
  // flex-stretch is now the only thing sizing them.
  t.ok(css.indexOf('.restore-bar {') >= 0, '.restore-bar rule still exists');
  var restoreBlock = css.slice(css.indexOf('.restore-bar {'), css.indexOf('.restore-bar {') + 300);
  t.ok(restoreBlock.indexOf('max-width') < 0, '.restore-bar no longer sets its own max-width');
  t.ok(restoreBlock.indexOf('margin: 10px auto') < 0, '.restore-bar no longer sets its own centering margin');

  var stepperBlock = css.slice(css.indexOf('.stepper {'), css.indexOf('.stepper {') + 300);
  t.ok(stepperBlock.indexOf('max-width') < 0, '.stepper no longer sets its own max-width');
  t.ok(stepperBlock.indexOf('margin: 0 auto') < 0, '.stepper no longer sets its own centering margin');
  // Now that it sits in the same column as the cards, it gets the same
  // boxed-card treatment (full border + radius) instead of the flat,
  // bottom-border-only strip that suited an edge-to-edge banner.
  t.ok(stepperBlock.indexOf('border: 1px solid #fde68a') >= 0 && stepperBlock.indexOf('border-radius: 6px') >= 0,
    '.stepper now gets a full border + radius, matching the card convention it sits alongside');
  t.ok(stepperBlock.indexOf('border-bottom:') < 0, 'the old bottom-border-only (banner) styling is gone');

  // Print and hidden-state rules must still work — they're ID/class
  // selectors, unaffected by moving the element's ancestor.
  t.ok(css.indexOf('#stepper, #helpPop, .toast, .run-hint { display: none !important; }') >= 0,
    'the stepper print-hiding rule is untouched (ID selector, ancestry-independent)');
  t.ok(css.indexOf('.restore-bar { display: none !important; }') >= 0,
    'the restore-bar print-hiding rule is untouched');

  return t.summary();
}

module.exports = { run: run };
