'use strict';
/* v0.43.0 — terminal half-life (review B1, author's decision) and the
 * concentration/saturable-elimination context (B2, B3).
 *
 * The old "Eff. t½ at trough" was ln2·V1/CL_eff: a one-compartment figure
 * that ignores the peripheral compartment, so it read 29.0 d for a typical
 * ravulizumab patient whose model terminal half-life is 45.9 d. The author
 * chose to show the terminal (slow-phase) half-life instead:
 *   λz = (s − √(s² − 4·k10·k21)) / 2,  s = k10 + k12 + k21,  t½ = ln2/λz,
 * with k10 = CL_eff/V1. For the two linear drugs CL_eff = CL. For
 * eculizumab CL_eff = CL + Vmax/(Km + C) depends on concentration, so the
 * value is evaluated at the predicted trough and says so (B2), and the
 * individual view shows the fixed, weight-scaled Vmax and Km (B3).
 */
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/chart.js');
require('../src/ui.js');

function slowPhase(cl, v1, v2, q) {
  var k10 = cl / v1, k12 = q / v1, k21 = q / v2, s = k10 + k12 + k21;
  return Math.LN2 / ((s - Math.sqrt(s * s - 4 * k10 * k21)) / 2);
}

async function run() {
  var t = new T('v0.43.0 terminal half-life + saturable-elimination context');
  t.ok(typeof M.terminalHalfLife === 'function', 'M.terminalHalfLife exists');
  if (typeof M.terminalHalfLife !== 'function') return t.summary();

  // ---- engine: matches the two-compartment slow eigenvalue ------------------
  M.select('ravulizumab');
  var pr = M.indivParams(70, 'PNH', [0, 0], 'ravulizumab');
  t.closeTo(M.terminalHalfLife(pr, 100), 45.9, 0.1, 'ravulizumab typical: 45.9 d (the review’s reference value)');
  t.closeTo(M.terminalHalfLife(pr, 100), M.terminalHalfLife(pr, 5), 1e-12, 'linear drug: independent of concentration');
  t.ok(M.terminalHalfLife(pr, 100) > M.effHalfLife(pr, 100) * 1.5, 'longer than the old one-compartment figure (29.0 d)');

  M.select('crovalimab');
  var pc = M.indivParams(70, 'PNH', [0, 0, 0, 0, 0, 0], 'crovalimab', 40);
  t.closeTo(M.terminalHalfLife(pc, 100), slowPhase(pc.cl, pc.v1, pc.v2, pc.q), 1e-9, 'crovalimab: slow eigenvalue of its disposition (the SC depot does not change it)');

  M.select('eculizumab');
  var pe = M.indivParams(70, 'PNH', [0, 0], 'eculizumab');
  var clAt = function (c) { return pe.cl + pe.vmax / (pe.km + c); };
  t.closeTo(M.terminalHalfLife(pe, 100), slowPhase(clAt(100), pe.v1, pe.v2, pe.q), 1e-9, 'eculizumab: slow eigenvalue with the clearance at the given concentration');
  t.ok(M.terminalHalfLife(pe, 300) > M.terminalHalfLife(pe, 50), 'eculizumab: longer at higher concentration (saturable elimination)');
  // independent check: after an IV bolus with concentration held high, the
  // late log-slope of a LINEAR two-compartment simulation equals λz
  M.select('ravulizumab');
  var times = [300, 330];
  var sc = M.simulate([{ t: 0, amt: 3000, bolus: true }], times, pr, { id: 'ravulizumab', rtol: 1e-10 }).c;
  var lz = Math.log(sc[0] / sc[1]) / 30;
  t.closeTo(Math.LN2 / lz, M.terminalHalfLife(pr, 100), 0.05, 'ravulizumab: equals the late log-slope of a simulated bolus (' + (Math.LN2 / lz).toFixed(2) + ' d)');

  // ---- fit + report ----------------------------------------------------------
  M.select('eculizumab');
  var doses = [0, 14, 28, 42, 56, 70, 84, 98].map(function (d) { return { t: d, amt: 900, route: 'iv' }; });
  var obs = [[56, 78], [70, 95], [84, 82], [98, 88]].map(function (x) { return { t: x[0] - 1e-6, c: x[1], lloq: false }; });
  var fit = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses, obs: obs, lloq: 0, target: 75, seed: 20250907 });
  fit.rel = { ssMode: false, t0ms: Date.UTC(2026, 5, 1, 7), dosesRel: doses, obsRel: obs, excludedObs: 0, nowRel: 99 };
  var rep = ECU.reportHtml({ patient: { code: 'X', wt: 70, disease: 'PNH' }, target: { value: 75 }, lloq: 0, errMult: 1,
    doses: [], obs: [], fit: fit, report: { preparedBy: '', advice: '' } });
  var hl = ECU.halfLifeInfo(fit);
  t.ok(hl && isFinite(hl.med) && hl.p5 < hl.med && hl.med < hl.p95, 'halfLifeInfo gives a median with a 5–95% range across posterior draws');
  t.ok(hl.nonlinear === true && hl.conc > 0, 'eculizumab is flagged nonlinear, with the reference concentration');
  t.ok(rep.indexOf('Terminal half-life') > 0, 'the report has a terminal half-life row');
  t.ok(rep.indexOf('at a trough of ' + hl.concText + ' µg/mL') > 0, 'the report states the concentration it applies to (' + hl.concText + ' µg/mL)');
  t.ok(/Saturable elimination/.test(rep) && /Vmax/.test(rep) && /Km/.test(rep), 'the report shows the fixed Vmax and Km (eculizumab)');
  t.ok(/fixed/.test(rep.slice(rep.indexOf('Saturable elimination'))), 'and says they are fixed model values, not estimated');
  t.ok(rep.indexOf('Eff. t½') < 0 && rep.indexOf('Half-life near the trough') < 0, 'no one-compartment "effective half-life" left in the report');

  // linear drug: no concentration qualifier, no Vmax row
  M.select('ravulizumab');
  var rd = [0, 56, 112].map(function (d) { return { t: d, amt: 3300, route: 'iv' }; });
  var fr = await B.runFit({ wt: 70, disease: 'PNH', drug: 'ravulizumab', doses: rd, obs: [{ t: 112 - 1e-6, c: 250, lloq: false }], lloq: 0, target: 150, seed: 3 });
  fr.rel = { ssMode: false, t0ms: Date.UTC(2026, 5, 1, 7), dosesRel: rd, obsRel: [], excludedObs: 0, nowRel: 113 };
  var repR = ECU.reportHtml({ patient: { code: 'X', wt: 70, disease: 'PNH' }, target: { value: 150 }, lloq: 0, errMult: 1,
    doses: [], obs: [], fit: fr, report: { preparedBy: '', advice: '' } });
  var hlR = ECU.halfLifeInfo(fr);
  t.ok(hlR.nonlinear === false && hlR.med > 30, 'ravulizumab: linear, terminal half-life in the expected range (' + hlR.med.toFixed(1) + ' d)');
  t.ok(repR.indexOf('Terminal half-life') > 0 && repR.indexOf('Saturable elimination') < 0, 'ravulizumab report: half-life row, no Vmax row');
  M.select('eculizumab');

  // ---- screen ----------------------------------------------------------------
  var ui = require('fs').readFileSync('src/ui.js', 'utf8');
  t.ok(ui.indexOf('Eff. t½ at trough') < 0, 'the screen no longer shows the one-compartment "Eff. t½ at trough"');
  t.ok(/Terminal t½/.test(ui) && /halfLifeInfo\(fit\)/.test(ui), 'the screen shows the terminal half-life from halfLifeInfo');
  return t.summary();
}

module.exports = { run: run };
