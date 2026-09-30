'use strict';
/* v0.27.0 — the chart's display-only continuation drew a visibly flattened,
 * shortened cycle wherever it appeared, instead of a periodic sawtooth.
 *
 * Found by the author driving the real app (steady-state eculizumab, a short
 * interval for rapid visual testing) — a screenshot showed peaks alternating
 * tall/tall/tall/SHORT/SHORT/tall instead of one uniform repeating shape.
 *
 * Root cause: `grid` (the time points the chart simulation is evaluated at)
 * was built from the real, entered `doses` alone, BEFORE `chartProjectedDoses`
 * (the display-only continuation past the last real dose) was computed.
 * `buildGrid()` adds fine per-dose time points (near each dose's peak and its
 * own pre-dose instant) only for the doses it is given — so every projected
 * dose's peak/trough fell in a region with nothing but the coarse
 * background half-day grid. The chart simulation itself
 * (`simulateDraws(chartPostDraws, chartDoses, grid, ...)`) was run over
 * `doses.concat(chartProjectedDoses)`, i.e. it DID simulate those cycles
 * correctly — the underlying curve was genuinely periodic throughout — but
 * the RENDERED polyline, drawn through whatever grid points existed, missed
 * the sharp peak/trough for the under-sampled cycles and drew a flattened
 * hump instead. Confirmed directly: the pre-dose trough at every REAL dose
 * was numerically constant; only the projected ones' sampling was sparse.
 *
 * Fixed by moving the (pure, dose-list-only) computation of
 * `chartProjectedDoses`/`loadingPhase` earlier, before `grid` is built, and
 * building `grid` from `doses.concat(chartProjectedDoses)`. `buildGrid()`
 * only reads doses to add time points around them — nothing else — so this
 * cannot change `ctx.doses`, the MAP/MCMC likelihood, or `troughs`, all of
 * which continue to use the real `doses` array exactly as before.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.27.0 chart continuation: grid resolution around projected doses');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');

  // ======================= 1. buildGrid: adding doses only ADDS points ====
  M.select('eculizumab');
  var doses = [];
  for (var k = 0; k < 4; k++) doses.push({ t: k * 14, amt: 900, route: 'iv' });
  var extra = [{ t: 56, amt: 900, route: 'iv' }, { t: 70, amt: 900, route: 'iv' }];
  var dur = M.drug().INFUSION_D;
  var gridSmall = B.buildGrid(doses, 90, 14, 0, dur);
  var gridLarge = B.buildGrid(doses.concat(extra), 90, 14, 0, dur);
  var smallSet = {};
  gridSmall.forEach(function (v) { smallSet[Math.round(v * 1e6)] = true; });
  var allPresent = gridSmall.every(function (v) { return gridLarge.indexOf(v) >= 0; });
  t.ok(allPresent, 'every point buildGrid() produces from the real doses alone still appears when extra doses are added');
  t.ok(gridLarge.length > gridSmall.length, 'adding doses to buildGrid() only ever adds points, confirmed on a real case (got ' +
    gridSmall.length + ' -> ' + gridLarge.length + ')');

  // ======================= 2. the exact reproduction case =================
  /* Steady-state eculizumab, a 1-day interval (used for the same reason the
   * author used one: it produces many cycles quickly, so a flattened
   * continuation cycle is easy to see and easy to test for). 80 pre-cycles
   * (the app's own steady-state pre-roll for eculizumab) put the real doses
   * well past any transient, so every REAL pre-dose trough is expected to
   * be numerically identical -- and, after this fix, so is every PROJECTED
   * one. */
  var I = 1, D = 900, K = 80;
  var ssDoses = [];
  for (var kd = K; kd >= 1; kd--) ssDoses.push({ t: -kd * I, amt: D, route: null });
  ssDoses.push({ t: 0, amt: D, route: null });
  for (var ka = 1; ka <= 3; ka++) ssDoses.push({ t: ka * I, amt: D, route: null });
  var obs = [{ t: -0.01, c: 200, lloq: false }, { t: 0.13, c: 600, lloq: false }];

  var fit = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: ssDoses, obs: obs,
    lloq: 0, target: 75, seed: 7, windowStart: -2 * I
  });

  t.ok(fit.chartProjectedDoses.length > 0, 'the reproduction case genuinely produces a chart continuation to test');

  // grid density: a one-day window among the PROJECTED doses must not be
  // sparser than a comparable window among the real ones -- this is the
  // direct, structural symptom of the bug (a bare half-day background grid
  // has only 3 points per day; a resolved dose has a dozen or more).
  function countIn(lo, hi) { return fit.grid.filter(function (g) { return g >= lo && g < hi; }).length; }
  var realWindowDensity = countIn(1, 2);
  fit.chartProjectedDoses.forEach(function (d) {
    var winHi = Math.floor(d.t) + 1;
    if (winHi > fit.horizon) return;   // the last projected dose's own window is
    // legitimately truncated by the horizon itself -- nothing to compare there
    // (the fine points right at its own peak/trough still exist; only the
    // FOLLOWING day's worth of background grid is cut short by design).
    var density = countIn(Math.floor(d.t), winHi);
    t.ok(density >= realWindowDensity * 0.5,
      'grid density around projected dose at t=' + d.t + ' (' + density + ' points) is comparable to a real dose’s own window (' +
      realWindowDensity + ' points), not the bare ~3-point background grid');
  });

  // the direct, user-facing symptom: every pre-dose trough, real AND
  // projected, is the SAME number -- a genuinely periodic regimen must look
  // periodic on the chart, not just in the underlying (unrendered) math.
  var allDoses = ssDoses.concat(fit.chartProjectedDoses).filter(function (d) { return d.t >= -1 && d.t <= 7; });
  var troughReadings = allDoses.map(function (d) {
    var best = -1, bestGap = Infinity;
    for (var i = 0; i < fit.grid.length; i++) {
      var gap = (d.t - 1e-6) - fit.grid[i];
      if (gap >= 0 && gap < bestGap) { bestGap = gap; best = i; }
    }
    return { t: d.t, gap: bestGap, conc: fit.chartBand.med[best] };
  });
  // every grid point actually used must be a genuine pre-dose instant (tight
  // gap), not a stand-in half-day-old point standing in for a missing one --
  // this is what tells apart "periodic AND well-sampled" from "periodic
  // reading by coincidence, still under-sampled."
  troughReadings.forEach(function (r) {
    t.ok(r.gap < 0.05, 'dose at t=' + r.t + ': the nearest grid point is genuinely close to the pre-dose instant (gap ' + r.gap.toFixed(4) + ' d), not a coarse stand-in');
  });
  var concs = troughReadings.map(function (r) { return r.conc; });
  var maxDev = Math.max.apply(null, concs) - Math.min.apply(null, concs);
  t.ok(maxDev < 1.0,
    'every pre-dose trough (real and projected alike) reads the same concentration, within noise (max deviation ' +
    maxDev.toFixed(3) + ' µg/mL across ' + concs.length + ' doses) -- a periodic regimen renders as periodic');

  // ======================= 3. the fit itself is unaffected =================
  /* The whole point of doing this inside buildGrid's own dose list, rather
   * than touching ctx.doses or the trough computation: the actual fit must
   * be bit-for-bit identical to what it was before this reorganisation.
   * Pin it structurally, since re-deriving the exact expected numbers here
   * would just duplicate the engine. */
  t.ok(bayes.indexOf('ctx = { wt: input.wt, age: age, disease: disease, drug: drug, doses: doses,') >= 0,
    'the MAP/MCMC likelihood context still takes the real doses array, untouched by this fix');
  // v0.40.0: the call gained a `planned` argument; still the real doses array.
  // v0.45.0: and a fourth switch that can drop the assumed row (review S1); still the real doses array.
  t.ok(bayes.indexOf('troughTimesOf(doses, interval, planned, !assume)') >= 0,
    'the trough table is still computed from the real doses array, untouched by this fix');

  // ======================= 4. structural: the fix is where it should be ===
  var gridCallIdx = bayes.indexOf('var grid = buildGrid(doses.concat(chartProjectedDoses)');
  var chartProjIdx = bayes.indexOf('var chartProjectedDoses = [];');
  t.ok(gridCallIdx >= 0, 'buildGrid() is called with doses.concat(chartProjectedDoses), not doses alone');
  t.ok(chartProjIdx >= 0 && chartProjIdx < gridCallIdx,
    'chartProjectedDoses is computed BEFORE grid is built (the actual fix -- order matters)');
  // the old duplicate computation lower in the function must be gone, not
  // just superseded -- two copies would be confusing and one could drift
  var declCount = (bayes.match(/var chartProjectedDoses = \[\];/g) || []).length;
  t.eq(declCount, 1, 'chartProjectedDoses is declared exactly once, not duplicated');

  return t.summary();
}

module.exports = { run: run };
