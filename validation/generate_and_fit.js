#!/usr/bin/env node
/* Estimation-engine validation: step 1 of 2.
 *
 * Generates the 14-subject synthetic panel (§4.1-4.2 of the validation plan),
 * fits every subject with the app's own MAP-Bayesian engine (the exact
 * runFit() code path the UI uses), and writes:
 *   - validation/nonmem/<run>.csv   NONMEM-ready datasets, one per NONMEM run
 *   - validation/results.json       true eta, app MAP eta, full scenario
 *                                    metadata for every subject (report input)
 *
 * Deterministic: one fixed seed drives every random draw. Run step 2
 * (run_nonmem.sh) afterwards, then build_report.mjs.
 */
'use strict';
const fs = require('fs');
const path = require('path');

global.ECU = global.ECU || {};
require('../src/model.js');
require('../src/bayes.js');
const M = ECU.model, B = ECU.bayes;

const SEED = 913026;               // one seed for the whole panel, for reproducibility
const rng = B.mulberry32(SEED);
const gauss = B.gaussFactory(rng);

const OUT_DIR = path.join(__dirname, 'nonmem');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---- residual-error draw, matching each drug's own $SIGMA structure ------
 * eculizumab:  Y = IPRED + ERR1            + IPRED*ERR2   (additive + proportional)
 * ravulizumab: Y = IPRED + IPRED*ERR1                      (proportional only)
 * crovalimab:  Y = IPRED + IPRED*ERR1      + ERR2          (proportional + additive,
 *              ETA(7) on the additive term dropped -- see model.js's own
 *              documented simplification, not re-introduced here either) */
function addResidualError(drugId, ipred) {
  const sig = M.spec(drugId).SIGMA;
  const addSD = Math.sqrt(Math.max(0, sig.ADD));
  const propSD = Math.sqrt(Math.max(0, sig.PROP));
  return ipred + addSD * gauss() + ipred * propSD * gauss();
}

/* ---- true-eta draw for one synthetic subject -----------------------------
 * disease + drugId select the SAME prior the app itself would use
 * (M.priorOmega), so the "truth" a subject is generated from is drawn from
 * exactly the distribution both engines assume as their prior. */
function drawTrueEta(drugId, disease) {
  const omega = M.priorOmega(disease, drugId);
  return B.priorDraws(1, omega, rng)[0];
}

function simTrue(drugId, doses, times, wt, disease, etaVec, age) {
  const p = M.indivParams(wt, disease, etaVec, drugId, age);
  const sim = M.simulate(doses, times, p, { id: drugId });
  if (sim.failed) throw new Error('simulation failed for ' + drugId);
  return sim.c;
}

/* ============================== SCENARIOS ================================ */
const scenarios = [];

// ---- Eculizumab, PNH (3 subjects; NONMEM run "ecu_pnh") -------------------
{
  const wt = 72;
  const doses = [0, 14, 28, 42].map(t => ({ t, amt: 900 }));
  scenarios.push({ id: 'ECU-PNH-01', drug: 'eculizumab', disease: 'PNH', wt, age: null,
    label: 'rich sampling (peak + trough x3)',
    doses, obsT: [14 - 0.5 / 24, 14.04, 28 - 0.5 / 24, 28.04, 42 - 0.5 / 24, 56 - 0.5 / 24],
    nmRun: 'ecu_pnh' });
  scenarios.push({ id: 'ECU-PNH-02', drug: 'eculizumab', disease: 'PNH', wt, age: null,
    label: 'sparse, trough-only (routine TDM)',
    doses, obsT: [28 - 0.5 / 24, 42 - 0.5 / 24, 56 - 0.5 / 24],
    nmRun: 'ecu_pnh' });
  scenarios.push({ id: 'ECU-PNH-03', drug: 'eculizumab', disease: 'PNH', wt, age: null,
    label: 'trough-only, oldest sample flagged BLQ',
    doses, obsT: [28 - 0.5 / 24, 42 - 0.5 / 24, 56 - 0.5 / 24],
    blqIdx: [0], lloq: 10,
    nmRun: 'ecu_pnh' });
}

// ---- Eculizumab, aHUS (2 subjects; NONMEM run "ecu_ahus", folded-IOV variant)
{
  const wt = 68;
  const doses = [0, 14, 28, 42].map(t => ({ t, amt: 900 }));
  scenarios.push({ id: 'ECU-AHUS-01', drug: 'eculizumab', disease: 'aHUS', wt, age: null,
    label: 'rich sampling, folded-IOV prior (R5)',
    doses, obsT: [14 - 0.5 / 24, 14.04, 28 - 0.5 / 24, 28.04, 42 - 0.5 / 24, 56 - 0.5 / 24],
    nmRun: 'ecu_ahus' });
  scenarios.push({ id: 'ECU-AHUS-02', drug: 'eculizumab', disease: 'aHUS', wt, age: null,
    label: 'sparse, trough-only, folded-IOV prior',
    doses, obsT: [28 - 0.5 / 24, 42 - 0.5 / 24, 56 - 0.5 / 24],
    nmRun: 'ecu_ahus' });
}

// ---- Ravulizumab (4 subjects; NONMEM run "ravu") ---------------------------
{
  const wt = 75;
  const doses = [0, 56, 112].map(t => ({ t, amt: 3000 }));
  scenarios.push({ id: 'RAVU-01', drug: 'ravulizumab', disease: null, wt, age: null,
    label: 'rich sampling',
    doses, obsT: [56 - 2.5 / 24, 56.15, 112 - 2.5 / 24, 112.15, 168 - 2.5 / 24],
    nmRun: 'ravu' });
  scenarios.push({ id: 'RAVU-02', drug: 'ravulizumab', disease: null, wt, age: null,
    label: 'sparse, trough-only',
    doses, obsT: [56 - 2.5 / 24, 112 - 2.5 / 24, 168 - 2.5 / 24],
    nmRun: 'ravu' });
  scenarios.push({ id: 'RAVU-03', drug: 'ravulizumab', disease: null, wt, age: null,
    label: 'trough-only, one sample flagged BLQ',
    doses, obsT: [56 - 2.5 / 24, 112 - 2.5 / 24, 168 - 2.5 / 24],
    blqIdx: [2], lloq: 10,
    nmRun: 'ravu' });
  scenarios.push({ id: 'RAVU-04', drug: 'ravulizumab', disease: null, wt, age: null,
    label: 'minimal: single trough (worst-case identifiability)',
    doses, obsT: [56 - 2.5 / 24],
    nmRun: 'ravu' });
}

// ---- Crovalimab (5 subjects; NONMEM run "crov") ----------------------------
{
  const wt = 70, age = 45;
  const richDoses = [{ t: 0, amt: 1000, route: 'iv' }];
  for (let d = 1; d <= 4; d++) richDoses.push({ t: 1 + d * 7, amt: 340, route: 'sc' });
  richDoses.push({ t: 29, amt: 680, route: 'sc' });
  richDoses.push({ t: 57, amt: 680, route: 'sc' });
  scenarios.push({ id: 'CROV-01', drug: 'crovalimab', disease: null, wt, age,
    label: 'rich sampling (6-eta stress test)',
    doses: richDoses, obsT: [4, 33, 56.99, 84.99],
    nmRun: 'crov' });
  scenarios.push({ id: 'CROV-02', drug: 'crovalimab', disease: null, wt, age,
    label: 'sparse, trough-only',
    doses: richDoses, obsT: [56.99, 84.99],
    nmRun: 'crov' });
  scenarios.push({ id: 'CROV-03', drug: 'crovalimab', disease: null, wt, age,
    label: 'trough-only, one sample flagged BLQ',
    doses: richDoses, obsT: [28.99, 56.99, 84.99],
    blqIdx: [0], lloq: 10,
    nmRun: 'crov' });
  {
    const customDoses = [{ t: 0, amt: 1000, route: 'iv', dur: 120 / 1440 }];
    for (let d = 1; d <= 4; d++) customDoses.push({ t: 1 + d * 7, amt: 340, route: 'sc' });
    customDoses.push({ t: 29, amt: 680, route: 'sc' });
    scenarios.push({ id: 'CROV-04', drug: 'crovalimab', disease: null, wt, age,
      label: 'non-default IV loading duration (120 min, R6)',
      doses: customDoses, obsT: [0.083, 33, 56.99],
      nmRun: 'crov' });
  }
  scenarios.push({ id: 'CROV-05', drug: 'crovalimab', disease: null, wt, age,
    label: 'minimal: single trough (worst-case identifiability)',
    doses: richDoses, obsT: [56.99],
    nmRun: 'crov' });
}

/* ============================ GENERATE + FIT ============================= */
async function main() {
  const results = [];
  for (const sc of scenarios) {
    const etaTrue = drawTrueEta(sc.drug, sc.disease);
    const cTrue = simTrue(sc.drug, sc.doses, sc.obsT, sc.wt, sc.disease, etaTrue, sc.age);
    const obs = sc.obsT.map((t, i) => {
      const isBlq = sc.blqIdx && sc.blqIdx.indexOf(i) >= 0;
      if (isBlq) return { t, c: null, lloq: true };
      const cObs = Math.max(0.01, addResidualError(sc.drug, cTrue[i]));
      return { t, c: Number(cObs.toFixed(4)), lloq: false };
    });

    const input = {
      drug: sc.drug, wt: sc.wt, age: sc.age, disease: sc.disease || 'PNH',
      doses: sc.doses, obs, lloq: sc.lloq || 0, errMult: 1, recency: 'off',
      target: 75, windowStart: 0, seed: SEED
    };
    const fit = await B.runFit(input, {});

    results.push({
      id: sc.id, drug: sc.drug, disease: sc.disease, label: sc.label, nmRun: sc.nmRun,
      wt: sc.wt, age: sc.age, doses: sc.doses, obsT: sc.obsT, blqIdx: sc.blqIdx || [], lloq: sc.lloq || 0,
      etaTrue, cTrue, obs,
      etaNames: fit.map.etaNames,
      etaApp: fit.map.etaVec,
      appParams: fit.map.params,
      appConverged: fit.map.converged,
      appOfv: fit.map.ofv
    });
    console.log(sc.id + ' (' + sc.drug + (sc.disease ? '/' + sc.disease : '') + '): '
      + sc.label + ' -- app MAP eta = [' + fit.map.etaVec.map(v => v.toFixed(4)).join(', ') + ']');
  }

  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
  console.log('\nWrote validation/results.json (' + results.length + ' subjects).');

  /* ---- NONMEM datasets, one CSV per run, subjects stacked as separate IDs.
   * EVID/CMT/RATE follow standard NM-TRAN convention: EVID=1 dosing record,
   * EVID=0 observation record; RATE = AMT/duration for a zero-order infusion
   * (0 for an instantaneous/SC dose). MDV=1 on dosing rows (DV not a
   * measurement), 0 on observation rows (1 again for a BLQ row -- M3 handling
   * is via a separate CENS column, see the control streams in Appendix A). */
  const byRun = {};
  for (const r of results) { (byRun[r.nmRun] = byRun[r.nmRun] || []).push(r); }

  function writeCsv(runName, rows) {
    const lines = ['ID,TIME,AMT,RATE,DV,MDV,EVID,CMT,CENS,WT,AGE'];
    let id = 0;
    for (const r of rows) {
      id++;
      const recs = [];
      for (const d of r.doses) {
        const isSc = d.route === 'sc';
        const durD = d.dur != null ? d.dur : M.spec(r.drug).INFUSION_D;
        const rate = isSc ? 0 : (d.amt / durD).toFixed(6);
        const cmt = r.drug === 'crovalimab' ? (isSc ? 1 : 2) : 1;
        recs.push({ t: d.t, rank: 1, row: [id, d.t.toFixed(6), d.amt, rate, '.', 1, 1, cmt, 0, r.wt, r.age != null ? r.age : '.'] });
      }
      r.obs.forEach((o) => {
        const cmtObs = r.drug === 'crovalimab' ? 2 : 1;
        const isBlq = o.lloq;
        const dv = isBlq ? (r.lloq || 10) : o.c;
        // rank 0: an observation at the SAME clock time as a dose is read
        // BEFORE that dose (the app's own trough convention, see M.simulate's
        // header comment) -- NM-TRAN takes same-time record order from the
        // file, so the observation row must be written first.
        recs.push({ t: o.t, rank: 0, row: [id, o.t.toFixed(6), 0, 0, dv, 0, 0, cmtObs, isBlq ? 1 : 0, r.wt, r.age != null ? r.age : '.'] });
      });
      // NM-TRAN requires each subject's records in non-decreasing TIME order.
      recs.sort((a, b) => a.t - b.t || a.rank - b.rank);
      for (const rec of recs) lines.push(rec.row.join(','));
    }
    fs.writeFileSync(path.join(OUT_DIR, runName + '.csv'), lines.join('\n') + '\n');
    console.log('Wrote validation/nonmem/' + runName + '.csv (' + rows.length + ' subjects, ' + (lines.length - 1) + ' records).');
  }

  for (const runName of Object.keys(byRun)) writeCsv(runName, byRun[runName]);
}

main().catch(e => { console.error(e); process.exit(1); });
