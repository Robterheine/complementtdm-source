/* Control-stream verification as part of the suite (v0.8.1).
 * 1. Re-runs the pharmacometrician cross-check (tools/verify_control_streams.mjs)
 *    as a subprocess — any edit to src/model.js or the shipped control streams
 *    that breaks transcription or $DES equivalence now FAILS the suite.
 * 2. Unit-level tests for the new aux sampling (v0.8.1): band-only ka/F
 *    variability for crovalimab — prior draws carry aux effects, MAP params do
 *    not, F stays in (0,1) on the logit scale, ka stays positive, and the
 *    band is at least as wide with aux sampling as without.
 */
'use strict';
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('model verification vs control streams (v0.8.1)');

  // ---- 1. subprocess cross-check (scripts exits 0 / prints ALL CROSS-CHECKS PASSED)
  var cp = require('child_process');
  var res = cp.spawnSync(process.execPath, ['tools/verify_control_streams.mjs'],
    { encoding: 'utf8', timeout: 120000 });
  t.ok(res.status === 0, 'verify_control_streams.mjs exits 0 (transcription + $DES equivalence)');
  if (res.status !== 0) {
    t.info && t.info('stdout: ' + res.stdout);
    console.log(res.stdout); console.log(res.stderr);
  } else {
    t.ok(res.stdout.indexOf('ALL CROSS-CHECKS PASSED') >= 0,
      'verify_control_streams.mjs reports ALL CROSS-CHECKS PASSED');
  }

  /* v0.13.0 — assert the REPORTED DEVIATIONS, not just the exit code.
   * Until v0.13.0 the tool's structural half compared against an all-NaN
   * reference and printed "0.00%" unconditionally; asserting only `status === 0`
   * laundered that false pass into a green suite. Each drug must now report a
   * deviation line that is present, parseable, non-zero (a literal 0 would mean
   * the reference never ran) and below the 0.02% gate. */
  var devLines = res.stdout.split('\n').filter(function (l) {
    return l.indexOf('max relative deviation') >= 0;
  });
  t.eq(devLines.length, 3, 'cross-check reports a deviation line for all three drugs');
  ['eculizumab', 'ravulizumab', 'crovalimab'].forEach(function (name) {
    var line = devLines.filter(function (l) { return l.indexOf(name + ':') >= 0; })[0];
    if (!line) { t.ok(false, name + ': deviation line present'); return; }
    var m = line.match(/deviation\s+([\deE.+-]+)%/);
    var val = m ? parseFloat(m[1]) : NaN;
    t.ok(isFinite(val), name + ': deviation is a parseable number (got "' + (m ? m[1] : line) + '")');
    t.ok(val > 0, name + ': deviation is strictly > 0 — an exact 0 means the reference integrator never ran');
    t.ok(val < 0.02, name + ': $DES deviation below the 0.02% gate (got ' + val + '%)');
  });

  // ---- 2. aux sampling: band-only absorption variability -------------------
  M.select('crovalimab');
  var spec = M.drug();
  t.ok(spec.OMEGA_AUX && spec.OMEGA_AUX.ka === 0.147 && spec.OMEGA_AUX.f === 1.35,
    'crovalimab spec carries OMEGA_AUX (ka 0.147, F 1.35)');

  function mkRng(s) {
    var x = s >>> 0;
    return function () { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
  }
  var aux = B.auxDraws(200, 'crovalimab', mkRng(99));
  t.ok(aux && aux.length === 200 && isFinite(aux[0].etaKA) && isFinite(aux[0].etaF),
    'auxDraws returns etaKA/etaF per draw');

  // with aux: ka positive and F in (0,1) for every draw; without aux: typicals
  var p0 = M.indivParams(70, 'PNH', 0, 0, 'crovalimab', 40);
  var okKa = true, okF = true;
  for (var i = 0; i < aux.length; i++) {
    var p = M.indivParams(70, 'PNH', 0, 0, 'crovalimab', 40, aux[i]);
    if (!(p.ka > 0)) okKa = false;
    if (!(p.fSc > 0.01 && p.fSc < 0.99)) okF = false;
  }
  t.ok(okKa, 'aux-sampled ka positive for all draws');
  t.ok(okF, 'aux-sampled F (logit scale) stays in (0.01, 0.99)');
  t.ok(Math.abs(p0.ka - 0.126 * Math.pow(40 / 36, -0.459)) < 1e-12 && p0.fSc === 0.83,
    'no aux -> typical ka and F (MAP/typical path unchanged)');

  // band width: aux sampling must not NARROW the prior band (SC schedule)
  var doses = [{ t: 0, amt: 680, route: 'iv' },
               { t: 14, amt: 680, route: 'sc' }, { t: 28, amt: 680, route: 'sc' }];
  var times = [7, 14, 21, 28, 35, 42];
  var seed = 12345;
  function widthOf(withAux) {
    var etas = B.priorDraws(300, M.priorOmega('PNH', 'crovalimab'), mkRng(seed));
    var auxP = withAux ? B.auxDraws(etas.length, 'crovalimab', mkRng(seed + 1)) : null;
    var c = [];
    for (var i = 0; i < etas.length; i++) {
      var pp = M.indivParams(70, 'PNH', etas[i][0], etas[i][1], 'crovalimab', 40, auxP ? auxP[i] : null);
      var s2 = M.simulate(doses, times, pp, { id: 'crovalimab' });
      c.push(s2.c[5]);   // trough of the 3rd dose
    }
    c.sort(function (a, b) { return a - b; });
    return c[Math.floor(c.length * 0.95)] - c[Math.floor(c.length * 0.05)];
  }
  var w0 = widthOf(false), w1 = widthOf(true);
  t.ok(w1 >= w0 * 0.98, 'prior band with aux sampling is >= band without (' +
    w1.toFixed(1) + ' vs ' + w0.toFixed(1) + ' ug/mL)');
  t.ok(w1 > w0 * 0.02, 'aux band is not degenerate');

  // sanity for non-aux drugs: auxDraws is null and nothing changes
  t.eq(B.auxDraws(10, 'eculizumab', mkRng(3)), null, 'eculizumab has no OMEGA_AUX -> no aux draws');

  M.select('eculizumab');
  return t.summary();
}

module.exports = { run: run };
