'use strict';
/* v0.25.0 — Independent audit (INDEPENDENT_AUDIT.md) finding F6.
 *
 * essAll used to be computed by mapping the single-chain Geyer-IPS ess()
 * over `draws` -- the POOLED array, all chains concatenated together --
 * while split-R-hat (already chain-aware) worked on the unpooled `chains`.
 * The two diagnostics were not even asking the same question: R-hat could
 * flag a chain that never mixed while a pooled ESS on the same data could
 * read arbitrarily high OR low (concatenating a stuck chain does not bias
 * a pooled autocorrelation estimate in one guaranteed direction).
 *
 * Fixed with a genuine split-chain BULK ESS (Vehtari et al. 2021 / Stan):
 * each chain is halved (the SAME halving splitRhat already does -- both are
 * now built on one shared `splitChainStats()` helper, so they can never
 * silently disagree about what counts as "the segments under comparison"),
 * each split-chain's autocovariance is centred on its OWN mean and averaged
 * across split-chains, then Geyer's initial monotone positive sequence
 * (same style as the existing single-chain ess()) truncates the lag sum.
 *
 * `essMin` (the worst-informed parameter across ALL etas, not just CL) is
 * new on the fit result and is what `precisionWord()` now prefers -- falling
 * back to `essCL` when `essMin` is absent, so the existing essCL-only
 * synthetic tests in tests/test_usability.js are unaffected.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches ECU.precisionWord (headless-safe)

function mkChain(n, gen) {
  var c = [];
  for (var i = 0; i < n; i++) c.push([gen(i)]);
  return c;
}

async function run() {
  var t = new T('v0.25.0 audit F6 — split-chain bulk ESS');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var ui = fs.readFileSync('src/ui.js', 'utf8');

  // ======================= 1. shared preamble refactor ====================
  t.ok(bayes.indexOf('function splitChainStats(') >= 0, 'splitChainStats() exists');
  t.ok(bayes.indexOf('function bulkEss(') >= 0, 'bulkEss() exists');
  // splitRhat must be BUILT ON splitChainStats now, not a second copy of the
  // segment-splitting logic -- confirmed structurally (the fix must not
  // reintroduce two independent definitions of "the segments").
  var srBody = bayes.slice(bayes.indexOf('function splitRhat('), bayes.indexOf('function bulkEss('));
  t.ok(srBody.indexOf('splitChainStats(chains, dim)') >= 0, 'splitRhat() calls the shared splitChainStats() helper');
  t.ok(srBody.indexOf('for (c = 0; c < chains.length; c++)') < 0,
    'splitRhat() no longer contains its own copy of the chain-halving loop (moved into splitChainStats)');
  // runFit must actually WIRE bulkEss in, on the real per-chain matrix -- not
  // just have bulkEss exist unused. This is the assertion that catches a
  // revert to the old `essAll.push(ess(draws.map(...)))` pooled call, which
  // every purely-numeric check below (essAll.length, essMin<=essCL, etc.)
  // stays internally consistent under and therefore CANNOT catch on its own.
  t.ok(bayes.indexOf('essAll.push(bulkEss(mcmc.chains, ed));') >= 0,
    'runFit computes essAll via bulkEss(mcmc.chains, ed), not the old pooled ess(draws.map(...))');
  t.ok(bayes.indexOf('essAll.push(ess(draws.map(') < 0,
    'the old pooled single-chain call is gone from runFit entirely');

  // splitRhat's own OUTPUT must be unaffected by the refactor: same formula,
  // same numeric answer, on a hand-checkable case (two identical, offset
  // constant "chains" of 8 points each -- half=4, means differ by 10).
  var a = mkChain(8, function (i) { return i < 4 ? 0 : 0; });   // constant chain, mean 0
  var bch = mkChain(8, function (i) { return i < 4 ? 10 : 10; }); // constant chain, mean 10, but W=0 -> null
  t.eq(B.splitRhat([a, bch], 0), null, 'splitRhat still returns null on a degenerate (zero within-variance) case');

  // ======================= 2. bulkEss: the audit's own pinned case ========
  /* "a two-chain synthetic example where chain 2 never moved (constant
   * value) -- assert BOTH R-hat is high AND bulk ESS is low." */
  var moving = mkChain(400, function (i) { return ((i * 9301 + 49297) % 233280) / 233280 - 0.5; });
  var stuck = mkChain(400, function () { return 5; });
  var rhatStuck = B.splitRhat([moving, stuck], 0);
  var essStuck = B.bulkEss([moving, stuck], 0);
  t.ok(rhatStuck > 1.05, 'a chain that never moved: split-R-hat correctly flags non-convergence (got ' + rhatStuck.toFixed(2) + ')');
  t.ok(essStuck != null && essStuck < 400, // well under half the 800 total draws
    'a chain that never moved: bulk ESS is correctly low, not diluted upward by the stuck chain (got ' + essStuck.toFixed(1) + ' of 800)');

  // ======================= 3. the OTHER direction of disagreement =========
  /* My own amendment to F6 in INDEPENDENT_AUDIT.md: pooling does not bias in
   * one guaranteed direction. Two chains that AGREE with each other (good
   * R-hat) but each wander slowly (severe within-chain autocorrelation) must
   * show a GOOD R-hat and a LOW ESS -- the opposite pairing from case 2,
   * proving this is not a one-way check. */
  function mkSlow(n, off) {
    var c = [];
    for (var i = 0; i < n; i++) c.push([Math.sin((i + off) / 40)]);
    return c;
  }
  var slow1 = mkSlow(400, 0), slow2 = mkSlow(400, 0);
  var rhatSlow = B.splitRhat([slow1, slow2], 0);
  var essSlow = B.bulkEss([slow1, slow2], 0);
  t.ok(rhatSlow < 1.05, 'two chains that agree but each drift slowly: split-R-hat reports fine (got ' + rhatSlow.toFixed(4) + ')');
  t.ok(essSlow != null && essSlow < 100, 'the SAME case: bulk ESS is still correctly low despite a fine R-hat (got ' + essSlow.toFixed(1) + ' of 800)');

  // ======================= 3b. per-segment centering, not grand-mean ======
  /* Each split-chain's autocovariance must be centred on ITS OWN mean, not a
   * mean shared across all segments (Vehtari et al.) -- otherwise a genuine
   * between-chain mean difference leaks into the WITHIN-chain autocorrelation
   * estimate as spurious correlation, understating ESS even for chains that
   * are each internally close to i.i.d. Two chains, each near-i.i.d., with a
   * modest mean gap (0.5): centering on each chain's own mean gives a
   * noticeably higher (more correct) ESS than centering on one shared mean
   * would -- verified empirically (correct ~25, grand-mean-sabotaged ~12 of
   * 800, on this exact construction) before picking the threshold below. */
  var g1 = mkChain(400, function (i) { return 0 + ((i * 9301 + 49297) % 233280) / 233280 - 0.5; });
  var g2 = mkChain(400, function (i) { return 0.5 + (((i + 131) * 9301 + 49297) % 233280) / 233280 - 0.5; });
  var essGapCase = B.bulkEss([g1, g2], 0);
  t.ok(essGapCase != null && essGapCase > 18,
    'per-segment centering on a modest between-chain mean gap gives a healthy ESS (got ' + essGapCase.toFixed(1) +
    '); centering on one shared mean across segments would understate it to roughly half this');

  // ======================= 4. sanity: well-mixed, healthy case ============
  var w1 = mkChain(400, function (i) { return ((i * 9301 + 49297) % 233280) / 233280 - 0.5; });
  var w2 = mkChain(400, function (i) { return (((i + 197) * 9301 + 49297) % 233280) / 233280 - 0.5; });
  var rhatGood = B.splitRhat([w1, w2], 0);
  var essGood = B.bulkEss([w1, w2], 0);
  t.ok(rhatGood < 1.05, 'two well-mixed chains: split-R-hat reports fine');
  t.ok(essGood != null && essGood > 100, 'two well-mixed chains: bulk ESS is a healthy fraction of the 800 total draws (got ' + essGood.toFixed(1) + ')');

  // null-safety: too few usable segments
  t.eq(B.bulkEss([mkChain(2, function (i) { return i; })], 0), null, 'a single 2-point chain (too short to halve) -> bulkEss returns null, not NaN or a crash');

  // ======================= 5. essMin: worst eta, not just CL ==============
  M.select('crovalimab');   // 6-eta drug -- the case the audit named explicitly
  var doses = [{ t: 0, amt: 1000, route: 'iv' }, { t: 1, amt: 340, route: 'sc' },
    { t: 8, amt: 340, route: 'sc' }, { t: 15, amt: 340, route: 'sc' }, { t: 22, amt: 340, route: 'sc' },
    { t: 50, amt: 680, route: 'sc' }, { t: 78, amt: 680, route: 'sc' }];
  var fitCro = await B.runFit({
    wt: 75, disease: 'PNH', drug: 'crovalimab', doses: doses,
    obs: [{ t: 77.9, c: 40, lloq: false }], lloq: 0, target: 75, seed: 9
  });
  t.ok(Array.isArray(fitCro.essAll) && fitCro.essAll.length === 6, 'a 6-eta crovalimab fit reports 6 essAll entries');
  t.eq(fitCro.essCL, fitCro.essAll[0], 'essCL is still essAll[0], unchanged meaning');
  var finiteEss = fitCro.essAll.filter(function (v) { return v != null && isFinite(v); });
  t.ok(finiteEss.length > 0, 'at least one eta has a finite ESS');
  t.ok(fitCro.essMin != null, 'essMin is populated on a real fit');
  t.close(fitCro.essMin, Math.min.apply(null, finiteEss), 1e-9, 'essMin is exactly the minimum of the finite essAll entries');
  // the point of F6: essMin need not equal essCL -- some other eta can be
  // the worst-informed one. Not asserting inequality (would be fit-specific
  // and flaky); asserting the computation is genuinely eta-aware instead.
  t.ok(fitCro.essMin <= fitCro.essCL + 1e-6, 'essMin is never larger than essCL (it is a minimum that includes essCL)');

  // ======================= 6. precisionWord: essMin preferred, essCL fallback
  t.eq(ECU.precisionWord({ hasObs: false }), 'not applicable (population forecast)', 'unchanged: no fit -> not applicable');
  // pre-existing behaviour (essCL only, no essMin) must be BIT-IDENTICAL --
  // this is the exact shape tests/test_usability.js already pins.
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 50 }), 'low (consider re-sampling or additional samples)',
    'essCL-only object (legacy shape): still buckets on essCL, unchanged');
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 600 }), 'good', 'essCL-only object: still "good" at 600, unchanged');
  // essMin now takes precedence when BOTH are present and disagree
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 600, essMin: 50 }), 'low (consider re-sampling or additional samples)',
    'a poorly-informed OTHER eta (essMin=50) correctly overrides a healthy essCL=600');
  t.eq(ECU.precisionWord({ hasObs: true, essCL: 50, essMin: 600 }), 'good',
    'conversely essMin=600 is trusted over a low essCL=50 (the object states CL was the WORST, not that everything was)');
  t.ok(ui.indexOf('fit.essMin != null ? fit.essMin : fit.essCL') >= 0, 'precisionWord source shows the essMin-preferred, essCL-fallback logic');

  return t.summary();
}

module.exports = { run: run };
