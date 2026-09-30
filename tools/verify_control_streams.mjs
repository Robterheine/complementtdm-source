#!/usr/bin/env node
/* Pharmacometrician cross-check: model.js vs the shipped NONMEM control streams.
 *
 * 1. TRANSCRIPTION — parse $THETA/$OMEGA/$SIGMA (and key $PK/$ERROR constants)
 *    straight out of the three control-stream files and diff them against the
 *    values the app actually uses (ECU.model spec). Any manual-transcription
 *    error in either the app or the expectation table below shows up here.
 * 2. STRUCTURE — re-implement each control stream's $DES as written (independent
 *    code, fixed-step RK4 — deliberately NOT the app's adaptive DP54) and compare
 *    predicted concentrations against ECU.model.simulate for a standard schedule.
 *
 * Usage: node tools/verify_control_streams.mjs   (exit 1 on any mismatch)
 */
'use strict';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

globalThis.ECU = {};
require('../src/model.js');
const M = ECU.model;

let fails = 0;
function check(name, a, b, tol) {
  const ok = typeof a === 'string' ? a === b : Math.abs(a - b) <= (tol != null ? tol : 0) * Math.max(1, Math.abs(b));
  if (!ok) { fails++; console.log(`  MISMATCH ${name}: control stream/expected ${a} vs app ${b}`); }
  return ok;
}
function num(re, text, name) {
  const m = text.match(re);
  if (!m) { fails++; console.log(`  PARSE-FAIL ${name}`); return NaN; }
  return parseFloat(m[1]);
}

// ---------------------------------------------------------------- eculizumab
{
  console.log('== eculizumab (nonmemcontrolstream.txt) ==');
  const t = fs.readFileSync('nonmemcontrolstream.txt', 'utf8');
  const s = M.drugs.eculizumab;
  // $THETA block: (0, value) ; n NAME
  const th = t.slice(t.indexOf('$THETA'), t.indexOf('$DES'));
  check('THETA1 CL',      num(/\(0,\s*([\d.]+)\)\s*;\s*1 CL/, th, 'CL'), s.THETA.CL);
  check('THETA2 V1',      num(/\(0,\s*([\d.]+)\)\s*;\s*2 V1/, th, 'V1'), s.THETA.V1);
  check('THETA3 VM',      num(/\(0,\s*([\d.]+)\)\s*;\s*3 VM/, th, 'VM'), s.THETA.VMAX);
  check('THETA4 KM',      num(/\(0,\s*([\d.]+)\)\s*;\s*4 KM/, th, 'KM'), s.THETA.KM);
  check('THETA5 V2',      num(/\(0,\s*([\d.]+)\)\s*;\s*5 V2/, th, 'V2'), s.THETA.V2);
  check('THETA6 Q',       num(/\(0,\s*([\d.]+)\)\s*;\s*Q/, th, 'Q'), s.THETA.Q);
  // $OMEGA: IOV block 0.112 (x6 SAME), then IIV 0.1546, 0.0812
  check('IOV (eta1-6)',   num(/\$OMEGA\s+BLOCK\(1\)\s*\n\s*([\d.]+)/, t, 'IOV'), s.IOV_CL);
  check('IIV CL',         num(/0\.112[\s\S]*?\$OMEGA\s*\n\s*([\d.]+)\s*;\s*IIV CL/, t, 'IIV CL'), s.OMEGA.CL);
  check('IIV V1',         num(/IIV CL[\s\S]*?\n\s*([\d.]+)\s*;\s*IIV V1/, t, 'IIV V1'), s.OMEGA.V1);
  // $SIGMA: 19.1 ADD, 0.0185 PROP (variances)
  check('SIGMA ADD',      num(/\$SIGMA\s*\n\s*([\d.]+)\s*;\s*ADD/, t, 'ADD'), s.SIGMA.ADD);
  check('SIGMA PROP',     num(/ADD[\s\S]*?\n\s*([\d.]+)\s*;\s*PROP/, t, 'PROP'), s.SIGMA.PROP);
  // $PK allometry (as written): CL/Q/VM exponent 0.75, V1 & V2 exponent 1, ref 70
  check('expo CL/Q/VM',   0.75, s.EXPO.CLQ);
  check('expo V1/V2',     1, s.EXPO.V);
  check('WT ref',         70, s.WT_REF || 70);
  check('IOV applies to aHUS only', true,
    s.IOV_DISEASES.length === 1 && s.IOV_DISEASES[0] === 'aHUS' ? 1 : 0);
  check('infusion 30 min', 30 / 1440, s.INFUSION_D, 1e-12);
}

// -------------------------------------------------------------- ravulizumab
{
  console.log('== ravulizumab (ravulizumab.txt) ==');
  const t = fs.readFileSync('ravulizumab.txt', 'utf8');
  const s = M.drugs.ravulizumab;
  const th = t.slice(t.indexOf('$THETA'), t.indexOf('$OMEGA'));
  const line = (n, name) => num(new RegExp('\\n\\s*([\\d.eE+-]+)\\s*;\\s*' + n + ' ' + name), th, name + n);
  check('THETA1 ALLOCL',  line(1, 'ALLOCL'), s.EXPO.CLQ);
  check('THETA2 ALLOV',   line(2, 'ALLOV'), s.EXPO.V);
  const cl_h = line(3, 'CL LITER PER HOUR');
  const q_h  = line(6, 'Q IN LITER PER HOUR');
  check('CL h->day',      cl_h * 24, s.THETA.CL, 1e-12);
  check('Q h->day',       q_h * 24, s.THETA.Q, 1e-12);
  check('THETA4 V1',      line(4, 'V1 IN LITER'), s.THETA.V1);
  check('THETA5 V2',      line(5, 'V2 IN LITER'), s.THETA.V2);
  // $OMEGA BLOCK(2): " 0.0569 ; 1 CL" then " 0.0161 0.0264 ; 2 V" (cov + var on one line)
  check('OMEGA CL var',   num(/BLOCK\(2\)\s*\n\s*([\d.]+)/, t, 'om1'), s.OMEGA.CL);
  const om2 = t.match(/BLOCK\(2\)[\s\S]*?\n\s*[\d.]+[^\n]*\n\s*([\d.]+)\s+([\d.]+)\s*;/);
  if (!om2) { fails++; console.log('  PARSE-FAIL om2 line'); }
  else {
    check('OMEGA COV',  parseFloat(om2[1]), s.OMEGA.COV);
    check('OMEGA V var', parseFloat(om2[2]), s.OMEGA.V1);
  }
  check('SIGMA PROP',     num(/\$SIGMA\s+([\dEe.+-]+)\s*;\s*PROP/, t, 'prop'), s.SIGMA.PROP);
  check('SIGMA ADD=0',    0, s.SIGMA.ADD);
  check('D1 = 2.5 h',     2.5 / 24, s.INFUSION_D, 1e-12);
  check('WT ref',         70, s.WT_REF || 70);
}

// --------------------------------------------------------------- crovalimab
{
  console.log('== crovalimab (crovalimab.txt, run05) ==');
  const t = fs.readFileSync('crovalimab.txt', 'utf8');
  const s = M.drugs.crovalimab;
  const th = t.slice(t.indexOf('$THETA'), t.indexOf('$OMEGA'));
  const line = (n, name) => num(new RegExp('\\n\\s*([\\d.]+)\\s*;\\s*' + n + ' ' + name), th, name + n);
  check('THETA1 CL',      line(1, 'CL LITER/DAY'), s.THETA.CL);
  check('THETA2 V2(central)', line(2, 'V2 LITER'), s.THETA.V1);
  check('THETA3 Q',       line(3, 'Q LITER/DAY'), s.THETA.Q);
  check('THETA4 V3(periph)', line(4, 'V3 LITER'), s.THETA.V2);
  check('THETA5 KA',      line(5, 'KA 1/DAY'), s.KA_D);
  check('THETA6 F1',      line(6, 'F1 FRACTION'), s.BIOAVAIL_SC);
  // $OMEGA diagonal: CL, V2, Q, V3, KA, F1, add-err — app estimates all 6 PK etas (v0.9.0)
  const om = t.slice(t.indexOf('$OMEGA'), t.indexOf('$SIGMA')).match(/^\s*([\d.]+)\s*;/gm).map(x => parseFloat(x));
  check('OMEGA1 CL',      om[0], s.OMEGA.CL);
  check('OMEGA2 V2',      om[1], s.OMEGA.V1);
  check('OMEGA diag -> COV 0', 0, s.OMEGA.COV);
  check('OMEGA full 6-eta ETA vector', om.slice(0, 6).join(','), s.ETA ? s.ETA.vars.join(',') : '<missing>');
  check('OMEGA item 7 = residual-error IIV (not a PK eta)', 7, om.length === 7 ? 7 : -1);
  // $SIGMA: 0.01277 PROP, 1.02 ADD (variances)
  check('SIGMA PROP',     num(/\$SIGMA\s+([\d.]+)\s*;\s*PROP/, t, 'prop'), s.SIGMA.PROP);
  check('SIGMA ADD',      num(/\n\s*([\d.]+)\s*;\s*ADD ERR/, t, 'add'), s.SIGMA.ADD);
  // $PK covariate constants as written
  check('ALLOCL expo',    0.75, s.EXPO.CLQ);
  check('ALLOV expo',     0.684, s.EXPO.V);
  check('AGEKA',          num(/AGEKA=\(-?([\d.]+)\)/, t, 'ageka'), -s.AGE_EXPO_KA, 1e-12);
  check('AGE ref',        num(/\(AGE\/(\d+)\)/, t, 'ageref'), s.AGE_REF);
  check('WT ref',         num(/\(WT\/(\d+)\)\*\*0\.75/, t, 'wtref'), s.WT_REF);
}

// ----------------------------- STRUCTURE: independent $DES vs app simulator --
// Fixed-step RK4, written from the control-stream equations only (not shared
// code with the app's adaptive Dormand-Prince).
function rk4Sim(des, nComp, doses, outTimes, infusionD) {
  const ev = [];
  for (const d of doses) {
    if (d.route === 'sc') ev.push({ t: d.t, kind: 'sc', amt: d.amt * d.F });
    else {
      const r = d.amt / infusionD;
      ev.push({ t: d.t, kind: 'rin', v: r });
      ev.push({ t: d.t + infusionD, kind: 'rin', v: -r });
    }
  }
  /* outTimes entries are {t, V}: the observation time and the volume the
   * central amount is divided by. Both must be unpacked here — pushing the
   * whole object as `t` made every comparison NaN, and because compareConc
   * tested `rel > worst`, NaN never raised `worst` and the structural check
   * passed unconditionally against nothing (fixed v0.13.0). */
  for (let i = 0; i < outTimes.length; i++) {
    const ot = outTimes[i];
    const isObj = ot !== null && typeof ot === 'object';
    const tt = isObj ? ot.t : ot;
    const vv = isObj ? ot.V : 1;
    const cc = (isObj && ot.comp != null) ? ot.comp : 0;
    if (!Number.isFinite(tt)) throw new Error(`rk4Sim: observation time ${i} is not a number`);
    if (!Number.isFinite(vv) || vv <= 0) throw new Error(`rk4Sim: observation volume ${i} is not a positive number`);
    if (!(cc >= 0 && cc < nComp)) throw new Error(`rk4Sim: observed compartment ${cc} out of range`);
    ev.push({ t: tt, kind: 'out', idx: i, V: vv, comp: cc });
  }
  ev.sort((a, b) => a.t - b.t || (a.kind === 'out' ? -1 : 1) - (b.kind === 'out' ? -1 : 1));
  let y = new Array(nComp).fill(0), rin = 0, t = 0, res = [];
  const h = 0.0005;
  const deriv = (tt, yy) => des(yy, rin);
  for (const e of ev) {
    while (t < e.t - 1e-12) {
      const hh = Math.min(h, e.t - t);
      const k1 = deriv(t, y);
      const k2 = deriv(t + hh / 2, y.map((v, i) => v + hh / 2 * k1[i]));
      const k3 = deriv(t + hh / 2, y.map((v, i) => v + hh / 2 * k2[i]));
      const k4 = deriv(t + hh, y.map((v, i) => v + hh * k3[i]));
      y = y.map((v, i) => v + hh / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
      t += hh;
    }
    // e.comp is the OBSERVED compartment: 0 for the 2-cmt IV models, but 1 for
    // crovalimab, whose compartment 0 is the SC depot (v0.13.0)
    if (e.kind === 'out') res[e.idx] = y[e.comp] / e.V;
    else if (e.kind === 'rin') rin += e.v;
    else if (e.kind === 'sc') y[0] += e.amt;
  }
  return res;
}
function compareConc(name, app, ref) {
  let worst = 0;
  /* Guard the comparison itself: a non-finite or absurdly small reference makes
   * `rel` NaN, and NaN fails every `>` test silently. The check must fail loudly
   * instead of reporting a 0.00% deviation it never computed (v0.13.0). */
  if (!Array.isArray(ref) || ref.length !== app.length) {
    fails++; console.log(`  MISMATCH ${name}: reference vector has ${ref ? ref.length : 'no'} points, app has ${app.length}`);
    return;
  }
  for (let i = 0; i < app.length; i++) {
    if (!Number.isFinite(app[i]) || !Number.isFinite(ref[i])) {
      fails++; console.log(`  MISMATCH ${name}: non-finite value at index ${i} (app=${app[i]}, ref=${ref[i]})`);
      return;
    }
    const rel = Math.abs(app[i] - ref[i]) / Math.max(1e-12, Math.abs(ref[i]));
    if (!Number.isFinite(rel)) {
      fails++; console.log(`  MISMATCH ${name}: non-finite relative deviation at index ${i}`);
      return;
    }
    if (rel > worst) worst = rel;
  }
  // a reference that is uniformly ~0 would make any app output "match"
  const refMax = Math.max.apply(null, ref.map(Math.abs));
  if (!(refMax > 1e-6)) {
    fails++; console.log(`  MISMATCH ${name}: reference vector is degenerate (max |C| = ${refMax})`);
    return;
  }
  console.log(`  ${name}: max relative deviation ${ (worst * 100).toPrecision(3) }% across ${app.length} time points`);
  if (!(worst < 2e-4)) { fails++; console.log(`  MISMATCH ${name}: deviation exceeds 0.02%`); }
}
const D = (t, amt, route, F) => ({ t, amt, route, F: F || 1 });

{ // eculizumab: PNH patient 70 kg, 900 mg q2w, troughs+midpoints over 6 weeks
  console.log('== structure: eculizumab $DES (ADVAN13 2-cpt + MM) ==');
  const s = M.drugs.eculizumab;
  const p = M.indivParams(70, 'PNH', 0, 0, 'eculizumab');
  const out = [1, 3, 7, 13.99, 14.01, 15, 21, 27.99, 28.01, 29, 35, 41.99];
  const doses = [0, 14, 28].map(t => D(t, 900));
  const app = M.simulate(doses, out, p, { id: 'eculizumab' }).c;
  const ref = rk4Sim((y, rin) => {
    const c = y[0] / s.THETA.V1;
    const d1 = -(s.THETA.CL / s.THETA.V1) * y[0] - (s.THETA.VMAX * c) / (s.THETA.KM + c)
               - (s.THETA.Q / s.THETA.V1) * y[0] + (s.THETA.Q / s.THETA.V2) * y[1] + rin;
    const d2 = -(s.THETA.Q / s.THETA.V2) * y[1] + (s.THETA.Q / s.THETA.V1) * y[0];
    return [d1, d2];
  }, 2, doses, out.map(t => ({ t, V: s.THETA.V1 })), s.INFUSION_D);
  compareConc('eculizumab', app, ref);
}
{ // ravulizumab: 3000 mg q8w (ADVAN3 TRANS4, linear, hours->days rescale)
  console.log('== structure: ravulizumab $DES (ADVAN3, rescaled to days) ==');
  const s = M.drugs.ravulizumab;
  const p = M.indivParams(70, 'PNH', 0, 0, 'ravulizumab');
  const out = [1, 7, 28, 55.99, 56.01, 60, 84, 111.99];
  const doses = [0, 56].map(t => D(t, 3000));
  const app = M.simulate(doses, out, p, { id: 'ravulizumab' }).c;
  const ref = rk4Sim((y, rin) => {
    const k10 = s.THETA.CL / s.THETA.V1, k12 = s.THETA.Q / s.THETA.V1, k21 = s.THETA.Q / s.THETA.V2;
    return [-(k10 + k12) * y[0] + k21 * y[1] + rin, k12 * y[0] - k21 * y[1]];
  }, 2, doses, out.map(t => ({ t, V: s.THETA.V1 })), s.INFUSION_D);
  compareConc('ravulizumab', app, ref);
}
{ /* crovalimab: 70 kg, age 40. EMA PiaSky schedule — 1000 mg IV loading, then
   * 680 mg SC maintenance. Compartment 0 is the SC DEPOT and compartment 1 the
   * central (observed) compartment, so the observation must be read from
   * compartment 1. The covariate model is written out here independently of the
   * app: WT ref 75 kg (not 70), exponent 0.75 on CL/Q and 0.684 on V2/V3, and
   * age on ka — at 70 kg none of these factors is 1, so omitting them (as this
   * block previously did) is a real error the NaN comparison was hiding. */
  console.log('== structure: crovalimab $DES (run05, SC depot + F1) ==');
  const s = M.drugs.crovalimab;
  const WT = 70, AGE = 40;
  const p = M.indivParams(WT, 'PNH', 0, 0, 'crovalimab', AGE);
  const out = [0.5, 1, 3, 7, 13.99, 14.01, 16, 21, 27.99, 28.01, 30];
  const doses = [D(0, 1000, 'iv'), D(14, 680, 'sc', s.BIOAVAIL_SC), D(28, 680, 'sc', s.BIOAVAIL_SC)];
  const app = M.simulate(doses, out, p, { id: 'crovalimab' }).c;
  const fCLQ = Math.pow(WT / 75, 0.75);
  const fV   = Math.pow(WT / 75, 0.684);
  const CL = s.THETA.CL * fCLQ, Q = s.THETA.Q * fCLQ;
  const V2 = s.THETA.V1 * fV,   V3 = s.THETA.V2 * fV;
  const ka = s.KA_D * Math.pow(AGE / 36, -0.459);
  const ref = rk4Sim((y, rin) => {
    const k23 = Q / V2, k32 = Q / V3, k20 = CL / V2;
    return [-ka * y[0],
            -k23 * y[1] - k20 * y[1] + ka * y[0] + k32 * y[2] + rin,
            -k32 * y[2] + k23 * y[1]];
  }, 3, doses, out.map(t => ({ t, V: V2, comp: 1 })), s.INFUSION_D);
  compareConc('crovalimab', app, ref);
}

console.log(fails === 0 ? '\nALL CROSS-CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
