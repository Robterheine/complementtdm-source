/* Tests for the v0.7.2 print-report feature.
 * The report generators (ECU.reportHtml / ECU.findingsLines) take a snapshot
 * of the state fields they use, so they run headlessly. Covers:
 *  - report renders with an individualized fit and with a population fit
 *  - prepared-by and advice appear verbatim (escaped); empty advice shows a
 *    visible placeholder, not silence
 *  - no "NaN"/"undefined"/"null" leaks into the printed text
 *  - signature block and disclaimer-critical items (target, LLOQ) present
 */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches ECU.reportHtml / ECU.findingsLines (headless-safe)

async function run() {
  var t = new T('print report (v0.7.2)');
  M.select('eculizumab');

  var doses = [{ t: 0, amt: 900 }, { t: 14, amt: 900 }, { t: 28, amt: 1200 }];
  var base = { wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, lloq: 10, target: 75, seed: 42, mcmcIters: 200 };

  // --- individualized fit ---
  var fit = await B.runFit(Object.assign({}, base, {
    obs: [{ t: 13.9, c: 120, lloq: false }, { t: 27.9, c: null, lloq: true }]
  }), {});
  fit.rel = {
    ssMode: false, t0ms: Date.now() - 28 * 86400000,
    dosesRel: doses.map(function (d, i) { return { t: i * 14, amt: d.amt, route: null }; }),
    obsRel: [{ t: 13.9, c: 120, lloq: false }, { t: 27.9, c: null, lloq: true }],
    excludedObs: 0, nowRel: 28.2
  };

  var snap = {
    patient: { code: 'PNH-<001>', wt: 70, age: null, disease: 'PNH' },
    target: { value: 75 },
    lloq: 10,
    errMult: 1,
    doses: [{ t: Date.now() - 28 * 86400000, amt: 900 }, { t: Date.now() - 14 * 86400000, amt: 900 }, { t: Date.now(), amt: 1200 }],
    obs: [{ t: Date.now() - 14 * 86400000, c: 120, lloq: false }, { t: Date.now(), c: null, lloq: true }],
    fit: fit,
    report: { preparedBy: 'R. ter Heine & <colleague>', advice: 'Continue 1200 mg q2w.\nRe-check trough in 4 weeks.' }
  };

  var html = ECU.reportHtml(snap);
  t.ok(typeof html === 'string' && html.length > 500, 'report HTML generated');

  // advice + prepared-by appear (escaped), advice newlines become <br>
  t.ok(html.indexOf('Continue 1200 mg q2w.<br>Re-check trough in 4 weeks.') >= 0, 'advice text printed verbatim with line breaks');
  t.ok(html.indexOf('R. ter Heine &amp; &lt;colleague&gt;') >= 0, 'prepared-by escaped and present');
  t.ok(html.indexOf('PNH-&lt;001&gt;') >= 0, 'patient pseudonym escaped');

  // empty advice -> visible placeholder, not silence
  var snapNoAdvice = Object.assign({}, snap, { report: { preparedBy: '', advice: '' } });
  var h2 = ECU.reportHtml(snapNoAdvice);
  t.ok(h2.indexOf('No advice entered.') >= 0, 'empty advice shows a visible placeholder');
  t.ok(h2.indexOf('not entered') >= 0, 'empty prepared-by shows a visible placeholder');

  // no NaN/undefined leaks anywhere in the document text
  ['NaN', 'undefined', '"null"', '>null<'].forEach(function (bad) {
    t.ok(html.indexOf(bad) < 0, 'no "' + bad + '" leak in report');
  });

  // essential content present
  t.ok(html.indexOf('Therapeutic drug monitoring report') >= 0, 'report title present');
  t.ok(html.indexOf('75 µg/mL') >= 0, 'trough target present');
  t.ok(html.indexOf('LLOQ') >= 0, 'LLOQ documented');
  t.ok(html.indexOf('Fit quality') >= 0, 'fit-quality section present');
  t.ok(html.indexOf('Model findings') >= 0, 'model findings section present');
  t.ok(html.indexOf('Advice') >= 0, 'advice section present');
  t.ok(html.indexOf('Reviewed / authorized by') >= 0, 'reviewer signature line present');
  t.ok(html.indexOf('MAP-Bayesian individualization') >= 0, 'method line names the estimation');

  // findings lines
  var fl = ECU.findingsLines(snap);
  t.ok(Array.isArray(fl) && fl.length >= 2, 'findings produced for an individualized fit');
  t.ok(fl.some(function (l) { return /individualized/i.test(l); }), 'findings state individualization');
  t.ok(fl.some(function (l) { return /P\(trough > 75/.test(l); }), 'findings quote P(trough > target)');

  // --- population (no-observation) fit ---
  var popFit = await B.runFit(Object.assign({}, base, { obs: [] }), {});
  popFit.rel = {
    ssMode: false, t0ms: fit.rel.t0ms,
    dosesRel: fit.rel.dosesRel,
    obsRel: [],
    excludedObs: 0, nowRel: 28.2
  };
  var snapPop = Object.assign({}, snap, { fit: popFit });
  var h3 = ECU.reportHtml(snapPop);
  t.ok(h3.indexOf('Population (prior) forecast') >= 0, 'population fit labelled honestly');
  t.ok(h3.indexOf('No measurements entered') >= 0, 'no-measurement note present');
  t.ok(h3.indexOf('NaN') < 0 && h3.indexOf('undefined') < 0, 'no NaN/undefined in population report');

  // findings for population fit
  var flPop = ECU.findingsLines(snapPop);
  t.ok(flPop.some(function (l) { return /population \(prior\) forecast/i.test(l); }), 'population findings honest');

  return t.summary();
}

module.exports = { run: run };
