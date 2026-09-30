'use strict';
/* v0.13.0 — regressions for the multidisciplinary audit fixes.
 *
 * Each block pins a defect that reached v0.12.0 unnoticed, so that a future
 * change cannot quietly reintroduce it:
 *   1. next-dose interval came from a hardcoded 14 days, not the drug;
 *   2. entry forms silently rejected real doses and all decimal concentrations;
 *   3. model assumptions were attached to the wrong drug;
 *   4. trough targets carried no source;
 *   5. no way to keep a sample on record but out of the fit;
 *   6. single MCMC chain, no convergence diagnostic;
 *   7. Nelder-Mead non-convergence was indistinguishable from success;
 *   8. batch-means CI used 1.96 where Student t was required;
 *   9. dates carried no year;
 *  10. the report's diagnostics chart shared an id with the on-screen one.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.13.0 audit fixes');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ---- 1. per-drug next-dose interval ------------------------------------
  M.select('ravulizumab');
  var oneDose = [{ t: 0, amt: 3000, route: 'iv' }];
  t.eq(B.modalInterval(oneDose), 56,
    'single ravulizumab dose -> interval falls back to its q8w default, not 14 d');
  /* v0.32.0: a single dose has no established interval to project from, so
   * virtualTroughTime() now returns null for it (see test_v032.js) -- this
   * assertion moved to two doses, where a real interval genuinely exists. */
  var twoDoses = [{ t: 0, amt: 3000, route: 'iv' }, { t: 56, amt: 3000, route: 'iv' }];
  t.eq(B.virtualTroughTime(twoDoses, B.modalInterval(twoDoses)), 112 - 1e-6,
    'virtual trough sits one real interval after the last dose');
  M.select('crovalimab');
  t.eq(B.modalInterval([{ t: 0, amt: 680, route: 'sc' }]), 28,
    'single crovalimab dose -> q4w default');
  M.select('eculizumab');
  t.eq(B.modalInterval([{ t: 0, amt: 900, route: 'iv' }]), 14,
    'single eculizumab dose -> q2w default');
  // a derivable interval still wins over the default
  t.eq(B.modalInterval([{ t: 0, amt: 900 }, { t: 21, amt: 900 }, { t: 42, amt: 900 }]), 21,
    'an interval present in the schedule overrides the drug default');

  // ---- 2. entry forms accept real clinical values -------------------------
  t.ok(/id="obs-val"[^>]*step="any"/.test(html),
    'concentration field uses step="any" (12.5 ug/mL must be enterable)');
  t.ok(/id="dose-amt"[^>]*step="any"/.test(html), 'dose field uses step="any"');
  t.ok(/id="doseForm"[^>]*novalidate/.test(html), 'dose form is novalidate (messages come from the app)');
  t.ok(/id="obsForm"[^>]*novalidate/.test(html), 'measurement form is novalidate');
  t.ok(ui.indexOf("el.step = 'any'") >= 0,
    'the drug spec no longer pushes a step grid onto the dose input');
  // real EMA crovalimab doses must be inside the accepted range
  var cro = M.spec('crovalimab').dose;
  [340, 680, 1020, 1000].forEach(function (d) {
    t.ok(d >= cro.min && d <= cro.max, 'crovalimab ' + d + ' mg is within the accepted dose range');
  });
  t.ok(cro.default !== 3400, 'crovalimab default dose is no longer the non-existent 3400 mg');
  t.eq(cro.default, 680, 'crovalimab default dose is the q4w maintenance dose');
  t.eq(M.spec('crovalimab').ssIntervalDefault, 28, 'crovalimab steady-state interval is q4w');

  // ---- 3 + 4. assumptions and target provenance --------------------------
  M.listDrugs().forEach(function (d) {
    var s = M.spec(d.id);
    if (s.pending) return;
    t.ok(s.assumptions && s.assumptions.length >= 1,
      d.id + ' declares at least one model assumption (surfaced in About and the report)');
    t.ok(!!s.targetSource, d.id + ' trough target cites a source');
    t.ok(/pubmed/i.test(s.targetSourceUrl || ''), d.id + ' target source carries a PubMed link');
  });
  var rav = M.spec('ravulizumab');
  t.ok(rav.assumptions.every(function (a) { return a.indexOf('aHUS') < 0; }),
    'ravulizumab assumptions no longer claim aHUS IOV folding (it has no disease covariate)');
  var ecu = M.spec('eculizumab');
  t.ok(ecu.assumptions.some(function (a) { return a.indexOf('IOV') >= 0 || a.indexOf('occasion') >= 0; }),
    'eculizumab assumptions describe the IOV folding that it actually performs');
  t.eq(rav.targetDefault, 150, 'ravulizumab target is 150 ug/mL (the more conservative interval-prolongation threshold)');

  // ---- 5. exclude-from-fit ------------------------------------------------
  M.select('eculizumab');
  var doses = [];
  for (var k = 0; k < 5; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });
  var good = { t: 55.9, c: 120, lloq: false };
  var bad = { t: 69.9, c: 12, lloq: false };            // implausible, e.g. post-plasma-exchange
  var base = { wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, lloq: 0, target: 75,
               seed: 11, mcmcIters: 1200 };
  var withBad = await B.runFit(Object.assign({}, base, { obs: [good, bad] }));
  var exBad = await B.runFit(Object.assign({}, base, {
    obs: [good, Object.assign({}, bad, { exclude: true, note: 'after plasma exchange' })]
  }));
  var onlyGood = await B.runFit(Object.assign({}, base, { obs: [good] }));
  t.eq(exBad.nExcluded, 1, 'excluded sample is counted');
  t.eq(exBad.obsData.length, 2, 'excluded sample is still reported for display and printing');
  t.ok(exBad.obsData[1].exclude === true, 'the exclude flag survives into obsData');
  t.eq(exBad.obsData[1].note, 'after plasma exchange', 'the exclusion reason survives into obsData');
  t.close(exBad.clQ.med, onlyGood.clQ.med, 0.02,
    'excluding a sample gives the same clearance as never entering it');
  t.ok(Math.abs(withBad.clQ.med - onlyGood.clQ.med) > Math.abs(exBad.clQ.med - onlyGood.clQ.med),
    'the aberrant sample really did move clearance when it was included');
  M.select('eculizumab');

  // ---- 6. multi-chain MCMC + split-R-hat ---------------------------------
  t.ok(typeof B.splitRhat === 'function', 'splitRhat is exported');
  // identical, well-mixed chains -> R-hat ~ 1
  var rngA = B.mulberry32(5), gA = B.gaussFactory(rngA);
  var chA = [], chB = [];
  for (var i = 0; i < 400; i++) { chA.push([gA()]); chB.push([gA()]); }
  var rOk = B.splitRhat([chA, chB], 0);
  t.ok(rOk != null && rOk < 1.05, 'independent draws from one distribution give R-hat < 1.05 (got ' + (rOk || 0).toFixed(3) + ')');
  // chains sitting in different places -> R-hat clearly > 1.05
  var chC = chB.map(function (d) { return [d[0] + 6]; });
  var rBad = B.splitRhat([chA, chC], 0);
  t.ok(rBad != null && rBad > 1.05, 'separated chains are detected (R-hat ' + (rBad || 0).toFixed(2) + ' > 1.05)');
  t.ok(withBad.nChains >= 2, 'runFit samples several chains');
  t.ok(Array.isArray(withBad.rhat) && withBad.rhat.length === withBad.etaDim,
    'runFit reports an R-hat per eta');
  t.ok(withBad.rhat.every(function (r) { return r == null || (isFinite(r) && r < 1.2); }),
    'a routine fit mixes (all R-hat < 1.2)');

  // ---- 7. Nelder-Mead convergence flag -----------------------------------
  t.ok(withBad.map && withBad.map.converged === true, 'MAP reports convergence on a routine fit');
  t.ok(withBad.map.startGap != null && withBad.map.startGap < 1,
    'dispersed starts agree on a routine fit (gap ' + withBad.map.startGap.toFixed(3) + ')');
  // a deliberately capped optimiser must report converged:false rather than ok:true
  var quad = function (x) { return (x[0] - 3) * (x[0] - 3) + (x[1] + 2) * (x[1] + 2); };
  var capped = B.mapEstimate(quad, [0.4, 0.4], { starts: 0 });
  t.ok(capped.converged === true, 'a solvable problem converges');

  // ---- 8. batch-means CI uses Student t ----------------------------------
  t.ok(typeof B.tQuantile975 === 'function', 'tQuantile975 is exported');
  t.closeTo(B.tQuantile975(11), 2.201, 0.002, 't(0.975, 11 df) = 2.201 (12 batches)');
  t.closeTo(B.tQuantile975(1), 12.706, 0.01, 't(0.975, 1 df)');
  t.ok(B.tQuantile975(500) < 2.0 && B.tQuantile975(500) >= 1.96, 'large df approaches the normal limit');
  t.ok(B.tQuantile975(11) > 1.96, 'the t multiplier is wider than the normal one it replaced');

  // ---- 9. dates carry a year ---------------------------------------------
  t.ok(/year:\s*'numeric'/.test(ui), 'fmtDate includes the year');
  t.ok(ui.indexOf('function plausibleTime') >= 0, 'out-of-range timestamps are challenged');

  // ---- 10. report vs screen diagnostics hosts ----------------------------
  var diag = fs.readFileSync('src/diagnostics.js', 'utf8');
  t.ok(/hostId \|\| 'gofChart'/.test(diag), 'gofPanel accepts a host id');
  t.ok(ui.indexOf("'rpGofChart'") >= 0, 'the report renders its diagnostics into its own element');
  var css = fs.readFileSync('src/app.css', 'utf8');
  t.ok(/print-color-adjust:\s*exact/.test(css), 'diagnostics graphics survive a default print');

  // ---- 11. wording: credible, not prediction, interval -------------------
  t.ok(ui.indexOf('credible interval for the true concentration') >= 0,
    'the band is described as a credible interval');
  t.ok(ui.indexOf('prediction interval') < 0,
    'the misleading "prediction interval" wording is gone');
  t.ok(ui.indexOf('etaInformation') >= 0 && ui.indexOf('etaShrinkage') < 0,
    'data-informativeness replaces the inverted "shrinkage" name');

  // ---- 12. autosave + restore -------------------------------------------
  t.ok(ui.indexOf('function saveSession') >= 0 && ui.indexOf('function loadSession') >= 0,
    'session autosave exists');
  t.ok(ui.indexOf('function offerRestore') >= 0,
    'an autosaved session is offered, not silently applied');
  t.ok(html.indexOf('id="restoreBar"') >= 0, 'the restore bar exists in the markup');
  t.ok(ui.indexOf('beforeunload') >= 0, 'unsaved entry is guarded on unload');

  // ---- 13a. dose-interval explorer ---------------------------------------
  /* Interval prolongation is a primary use of TDM for these agents. Before
   * v0.13.0 answering "can this patient move to q3w?" meant hand-entering every
   * future dose and refitting once per candidate interval. */
  t.ok(typeof B.intervalScan === 'function', 'intervalScan is exported');
  t.ok(typeof B.candidateIntervals === 'function', 'candidateIntervals is exported');
  var cand = B.candidateIntervals(14);
  t.ok(cand.indexOf(14) >= 0, 'the current interval is among the candidates');
  t.ok(cand.indexOf(28) >= 0, 'a doubled interval is among the candidates');
  t.ok(cand.every(function (v) { return v === Math.round(v) && v > 0; }), 'candidates are whole positive days');
  t.ok(cand.length >= 6, 'enough candidates to show a trend');
  t.ok(cand[cand.length - 1] > cand[0], 'candidates are sorted ascending');

  M.select('eculizumab');
  var ivDoses = [];
  for (var q = 0; q < 8; q++) ivDoses.push({ t: q * 14, amt: 900, route: 'iv' });
  var ivFit = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: ivDoses,
    obs: [{ t: 97.9, c: 190, lloq: false }, { t: 111.9, c: 185, lloq: false }],
    lloq: 0, target: 75, seed: 7
  });
  var scan = await B.intervalScan({
    draws: ivFit.draws, doses: ivDoses, wt: 70, disease: 'PNH', age: null,
    drug: 'eculizumab', target: 75, amt: 900, intervals: [14, 21, 28]
  });
  t.eq(scan.length, 3, 'intervalScan returns one row per candidate interval');
  scan.forEach(function (r) {
    t.ok(isFinite(r.ss.med) && isFinite(r.ss.p5) && isFinite(r.ss.p95),
      'q' + r.interval + 'd sustained trough quantiles are finite');
    t.ok(r.ss.p5 <= r.ss.med && r.ss.med <= r.ss.p95, 'q' + r.interval + 'd quantiles are ordered');
    t.ok(r.ss.pTarget >= 0 && r.ss.pTarget <= 1, 'q' + r.interval + 'd probability is in [0,1]');
  });
  // the physics: a longer interval cannot raise the sustained trough
  t.ok(scan[0].ss.med > scan[1].ss.med && scan[1].ss.med > scan[2].ss.med,
    'sustained trough falls monotonically as the interval lengthens');
  t.ok(scan[0].ss.pTarget >= scan[2].ss.pTarget,
    'probability of staying above target does not rise with a longer interval');
  /* For an interval LONGER than the one the patient is on, continuing at it
   * washes the drug out, so the sustained trough sits below the one-off delayed
   * trough. At or below the current interval the opposite holds — the patient
   * is still accumulating, so continuing RAISES the trough. Both directions are
   * real, which is precisely why the two columns cannot be collapsed into one. */
  scan.filter(function (r) { return r.interval > ivFit.interval; }).forEach(function (r) {
    t.ok(r.next.med >= r.ss.med,
      'q' + r.interval + 'd (longer than current): delaying one dose leaves a higher trough than continuing at it');
  });
  t.ok(scan[0].ss.med >= scan[0].next.med,
    'at the current interval, continuing accumulates further rather than washing out');
  /* The headline finding this feature exists for: at q28d this patient's
   * NEXT trough still looks acceptable while the SUSTAINED trough does not.
   * Reporting only the next trough would be falsely reassuring. */
  var q28 = scan[2];
  t.ok(q28.next.med > q28.ss.med * 2,
    'q28d: next trough is far above the sustained trough — the two must be shown separately');
  // scanning must reuse the posterior, not refit
  t.ok(ivFit.draws && ivFit.draws.length > 100, 'the fit exposes its posterior draws for scanning');

  /* v0.15.0: the explorer is now its own top-level card 4, not a nested
   * <details> fold inside the forecast card — see tests/test_v015.js for the
   * assertions covering that move. This still checks the control exists. */
  t.ok(html.indexOf('id="iv-run"') >= 0, 'the explorer control exists in the markup');
  t.ok(html.indexOf('id="iv-run"') >= 0, 'the explorer has a run control');
  t.ok(ui.indexOf('function runIntervalScan') >= 0 && ui.indexOf('function renderIntervalScan') >= 0,
    'the explorer is wired in the UI');
  t.ok(ui.indexOf('ivexplore:') >= 0, 'the explorer has help text');
  t.ok(ui.indexOf('It is not a recommendation') >= 0,
    'the explorer states explicitly that it does not recommend a regimen');

  // ---- 13. modal focus management ----------------------------------------
  t.ok(ui.indexOf('function openModal') >= 0 && ui.indexOf('function closeModal') >= 0,
    'modals have focus management helpers');
  t.ok(ui.indexOf('modalReturn') >= 0, 'focus returns to the trigger on close');

  return t.summary();
}

module.exports = { run: run };
