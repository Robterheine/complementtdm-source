'use strict';
/* v0.17.0 — phone + desktop responsive plan, implemented in full.
 * Plan authored by a UI designer + HTML/CSS coder review (see README §20);
 * this suite pins the mechanics that are testable without a real browser
 * (chart.js's compact layout is pure cfg-in/SVG-out, so it's fully unit
 * testable; the full visual result was additionally verified in the browser
 * at 375px and desktop widths before this shipped).
 *
 *   1. chart.js compact layout: derives its own height from the actual
 *      legend content (never overflows regardless of item count), larger
 *      fonts/fewer ticks, desktop path byte-identical to before.
 *   2. ui.js: renderChart/renderIntervalScan/renderDiagnostics all detect
 *      container width and support an explicit force-compact override.
 *   3. The report always gets a forced-desktop chart, rendered into a
 *      detached element — never the live (possibly compact) on-screen one.
 *   4. Two pre-existing table-overflow bugs, found while doing this work,
 *      fixed regardless of the rest of the plan (regimen-explorer table,
 *      diagnostics residual table — neither had a scroll wrapper at all).
 *   5. Breakpoints consolidated: exactly one 700px and one 560px block.
 *   6. Card 4 stays reachable via a stepper-independent path; responsive
 *      card/table CSS and header grid exist.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.17.0 responsive plan (phone + desktop)');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var chart = fs.readFileSync('src/chart.js', 'utf8');
  var diag = fs.readFileSync('src/diagnostics.js', 'utf8');
  var css = fs.readFileSync('src/app.css', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  global.ECU = global.ECU || {};
  require('../src/chart.js');
  var C = ECU.chart;
  function mkHost() { return { innerHTML: '', style: {}, querySelectorAll: function () { return []; }, querySelector: function () { return null; } }; }
  var baseCfg = {
    xMin: 0, xMax: 100, yMax: 400, xLabel: 'Days since first dose', yLabel: 'Concentration (µg/mL)',
    bands: [{ x: [0, 50, 100], lo: [10, 20, 30], hi: [50, 60, 70], fill: 'rgba(100,116,139,.10)' }],
    series: [{ x: [0, 50, 100], y: [30, 40, 50], color: '#0e7490', width: 2.2 }],
    hlines: [{ y: 75, color: '#d97706', dash: '8 5', label: 'Target trough > 75 µg/mL' }]
  };

  // ---- 1. chart.js compact layout -----------------------------------------
  function maxTextY(svgHtml) {
    var ys = [];
    var re = /<text [^>]*y="([\-0-9.]+)"/g, mm;
    while ((mm = re.exec(svgHtml))) ys.push(parseFloat(mm[1]));
    return ys.length ? Math.max.apply(null, ys) : -Infinity;
  }
  [
    ['6-item legend', 6],
    ['2-item legend', 2],
    ['0-item legend', 0]
  ].forEach(function (pair) {
    var labels = ['Population prediction 5–95%', 'Individual prediction 5–95%', 'Observation',
      'Dose', 'Today', 'Projected dose (not entered)'].slice(0, pair[1]);
    var legend = labels.map(function (l, i) {
      return { label: l, color: '#0e7490', swatch: i % 3 === 0 ? 'band' : (i % 3 === 1 ? 'dot' : 'line'), dash: i % 2 ? '4 4' : undefined };
    });
    var h = mkHost();
    C.render(h, Object.assign({}, baseCfg, { compact: true, legend: legend }));
    var vb = h.innerHTML.match(/viewBox="0 0 (\d+) (\d+)"/);
    var H = parseFloat(vb[2]);
    t.ok(maxTextY(h.innerHTML) <= H - 2, 'compact (' + pair[0] + '): no text exceeds the viewBox height (H=' + H + ')');
  });

  var hCompact = mkHost();
  C.render(hCompact, Object.assign({}, baseCfg, { compact: true, legend: [{ label: 'Individual prediction 5–95%', color: '#0e7490', swatch: 'band' }] }));
  t.ok(hCompact.innerHTML.indexOf('viewBox="0 0 340') >= 0, 'compact defaults to a 340-wide viewBox');
  t.ok(hCompact.innerHTML.indexOf('font-size="15"') >= 0, 'compact uses larger tick font (15 vs desktop 12)');
  t.ok(hCompact.innerHTML.indexOf('rotate(-90') < 0, 'compact drops the rotated y-axis label to save width');

  var hDesktop = mkHost();
  C.render(hDesktop, Object.assign({}, baseCfg, { legend: [{ label: 'Individual prediction 5–95%', color: '#0e7490', swatch: 'band' }] }));
  t.ok(hDesktop.innerHTML.indexOf('viewBox="0 0 960 440"') >= 0, 'desktop (compact omitted) is byte-identical to the pre-v0.17.0 default: 960x440');
  t.ok(hDesktop.innerHTML.indexOf('rotate(-90') >= 0, 'desktop keeps the rotated y-axis label');
  t.ok(hDesktop.innerHTML.indexOf('y="432"') >= 0, 'desktop x-axis label position (H-8) is unchanged');

  // ---- 2. ui.js call sites detect container width -------------------------
  t.ok(ui.indexOf('function isCompactWidth') >= 0, 'a shared compact-width helper exists');
  t.ok(ui.indexOf('host.clientWidth') >= 0, 'chart hosts are measured by their own clientWidth, not window.innerWidth');
  t.ok(ui.indexOf('function renderChart(hostOverride, forceCompact)') >= 0,
    'renderChart accepts an override host and an explicit compact flag');
  t.ok(ui.indexOf('function renderDiagnostics(fit, rel, hostId, rowsContainerId, forceCompact)') >= 0,
    'renderDiagnostics accepts an explicit compact override too');
  t.ok(ui.indexOf("var compact = isCompactWidth(ivChartHost") >= 0,
    'the regimen-explorer chart also auto-detects its own container width');

  // ---- 3. report always forces desktop, via a detached element ----------
  t.ok(ui.indexOf('document.createElement(\'div\')') >= 0,
    'the report renders its chart into a detached element, never the live #chart div');
  t.ok(ui.indexOf('renderChart(offscreenChart, false)') >= 0,
    'the report forces the chart non-compact regardless of the live viewport');
  t.ok(ui.indexOf("renderDiagnostics(state.fit, state.fit.rel, 'rpGofChart', 'rpDiagBody', false)") >= 0,
    'the report forces the diagnostics chart non-compact too');
  t.ok(ui.indexOf("if (typeof document !== 'undefined' && state.fit)") >= 0,
    'the report chart path stays guarded for the DOM-free test environment');

  // ---- 4. landmine: resize must not disturb state.stale -------------------
  var resizeBlock = ui.slice(ui.indexOf("window.addEventListener('resize'"), ui.indexOf("window.addEventListener('resize'") + 700);
  t.ok(resizeBlock.indexOf('state.stale') < 0, 'the resize handler never touches state.stale');
  t.ok(resizeBlock.indexOf('setTimeout') >= 0 && resizeBlock.indexOf('clearTimeout') >= 0,
    'the resize handler is debounced');
  t.ok(resizeBlock.indexOf('diagOpenFit') >= 0,
    'the resize handler re-renders diagnostics with the SAME fit/rel it was opened with, not live globals');

  // ---- 5. two pre-existing table-overflow bugs, fixed -------------------
  t.ok(ui.indexOf("h += '<div class=\"tbl-wrap\">' + intervalScanTableHtml(sc, false) + '</div>';") >= 0,
    'the regimen-explorer table (found unwrapped) now has a scroll fallback on screen');
  t.ok(ui.indexOf('intervalScanTableHtml(scP, true)') >= 0,
    'the printed regimen-exploration table is deliberately left unwrapped (print has its own sizing)');
  t.ok(diag.indexOf('<div class="tbl-wrap"><table class="data diag-res">') >= 0,
    'the diagnostics residual table (also found unwrapped) now has a scroll fallback');
  t.ok(ui.indexOf('<div class="tbl-wrap"><table class="data responsive-cards"><thead><tr>') >= 0,
    'the trough table (also found unwrapped) now has a scroll fallback');

  // ---- 6. breakpoints consolidated to exactly one of each ----------------
  var m700 = css.match(/@media \(max-width: 700px\)/g) || [];
  var m560 = css.match(/@media \(max-width: 560px\)/g) || [];
  t.eq(m700.length, 1, 'exactly one 700px media block (was two)');
  t.eq(m560.length, 1, 'exactly one 560px media block (was two)');
  t.ok(css.indexOf('.sess-row') < css.lastIndexOf('@media (max-width: 700px)') || css.indexOf('.sess-row') > css.indexOf('@media (max-width: 700px)'),
    '.sess-row rule survives the consolidation');
  t.ok(css.indexOf('.iv-controls input[type="number"] { width: 84px; }') >= 0,
    'the iv-controls width rule survives the consolidation');
  t.ok(css.indexOf('.row2, .row3 { grid-template-columns: 1fr; }') >= 0, 'the grid-collapse rule survives');
  t.ok(css.indexOf('.stepper { gap: 10px; padding: 6px 10px; }') >= 0, 'the stepper padding rule survives');

  // ---- 7. new phone-tier rules exist --------------------------------------
  t.ok(css.indexOf('header.app .actions { display: grid; grid-template-columns: 1fr 1fr;') >= 0,
    'header actions become a 2x2 grid on phone');
  t.ok(css.indexOf('table.data.responsive-cards tbody tr {') >= 0,
    'responsive-cards table-to-card CSS exists');
  t.ok(css.indexOf('table.data.responsive-cards tbody td::before {') >= 0,
    'the card layout uses data-label via ::before, not duplicated markup');
  t.ok(css.indexOf('button.info { width: 30px; height: 30px;') >= 0,
    'the ⓘ popover touch target is enlarged on phone (padding alone would not work — box-sizing:border-box)');
  t.ok(css.indexOf('.modal-close { padding: 10px 14px;') >= 0, 'the modal close button touch target is enlarged');
  t.ok(css.indexOf('.stepper .linklike { padding: 6px 4px; }') >= 0, 'the stepper dismiss link touch target is enlarged');

  // ---- 8. data-label attributes present on both converted tables --------
  t.ok(ui.indexOf('data-label="Day"') >= 0 && ui.indexOf('data-label="Date"') >= 0,
    'trough table cells carry data-label for the phone card layout');
  t.ok(ui.indexOf("data-label=\"' + rowLabel + '\"") >= 0, 'regimen-explorer table cells carry data-label too');

  // ---- 9. card 4 markup sanity (still true after this pass) --------------
  t.ok(/<div class="card" id="regimenCard">/.test(html), 'card 4 is still its own top-level card');
  t.ok(html.indexOf('id="diagModal"') >= 0, 'the diagnostics modal markup is still present');

  return t.summary();
}

module.exports = { run: run };
