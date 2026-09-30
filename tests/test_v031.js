'use strict';
/* v0.31.0 — regimen explorer table: steady-state trough only.
 *
 * The chart already dropped the "next dose only" series back in v0.15.0
 * (see test_v015.js), on the reasoning that two overlapping lines answering
 * different questions read as chart clutter — but the table right below it
 * kept both a "Next trough" and a "Steady-state trough" pair of columns, so
 * "next" never actually went away, it just moved down one element. Author
 * request: match the table to the chart and show steady-state only.
 *
 * `next` itself is NOT removed from bayes.js's intervalScan()/doseScan() --
 * only the table's own presentation of it. The underlying data stays
 * computed (tests/test_v013.js and test_v014.js keep exercising it as a
 * bayes.js data-layer concern, independent of what ui.js chooses to render).
 */
var fs = require('fs');
var T = require('./util.js').T;

async function run() {
  var t = new T('v0.31.0 regimen explorer table shows steady-state trough only');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  function bodyOf(name) {
    var start = ui.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = ui.indexOf('\n  }', start);
    return end < 0 ? ui.slice(start) : ui.slice(start, end + 4);
  }

  var tableBody = bodyOf('intervalScanTableHtml');
  t.ok(tableBody.length > 0, 'intervalScanTableHtml() found');

  // ---- 1. the "Next trough" column and its P(next > target) badge are gone
  t.ok(tableBody.indexOf('Next trough') < 0,
    'the table header no longer has a "Next trough" column');
  t.ok(tableBody.indexOf('r.next') < 0,
    'the table body no longer reads r.next at all (was r.next.med/.p5/.p95/.pTarget/.pCI)');
  t.ok(tableBody.indexOf('P(next') < 0,
    'the "P(next > target)" column header is gone');

  // ---- 2. the steady-state column is untouched -----------------------------
  t.ok(tableBody.indexOf('Steady-state trough') >= 0,
    'the steady-state trough column is still there');
  t.ok(tableBody.indexOf('r.ss.med') >= 0 && tableBody.indexOf("ptaBadge(r.ss.pTarget, r.ss.pCI)") >= 0,
    'the steady-state column still reads r.ss.med and passes r.ss.pTarget/.pCI into ptaBadge, unchanged');

  // ---- 3. the legend note no longer defines "Next trough" ------------------
  t.ok(tableBody.indexOf('<b>Next trough</b>') < 0,
    'the legend note no longer explains a "Next trough" term that is no longer shown');
  t.ok(tableBody.indexOf('<b>Steady-state trough</b>') >= 0,
    'the legend note still explains "Steady-state trough"');

  // ---- 4. the chart's accessibility description no longer claims "next"
  //         values are listed in the table below it (they no longer are) ----
  var renderBody = bodyOf('renderIntervalScan');
  t.ok(renderBody.length > 0, 'renderIntervalScan() found');
  t.ok(renderBody.indexOf('effect of changing only the next dose') < 0,
    'the chart description no longer promises a "next dose" figure that the table no longer carries');

  // ---- 5. the ⓘ popover no longer explains a "Next trough" concept that
  //         nothing in the explorer displays any more -----------------------
  t.ok(ui.indexOf("ivexplore:") >= 0, 'the ivexplore HELP entry exists');
  var helpStart = ui.indexOf('ivexplore:');
  var helpEnd = ui.indexOf("\n", ui.indexOf("',", helpStart));
  var helpText = ui.slice(helpStart, helpEnd);
  t.ok(helpText.indexOf('Next trough') < 0,
    'the regimen-explorer help popover no longer mentions "Next trough"');

  return t.summary();
}

module.exports = { run: run };
