#!/usr/bin/env node
/* Estimation-engine validation: step 3 of 3 (after generate_and_fit.js and
 * the NONMEM runs in validation/nonmem/run_NAME/NM_run1/psn.phi).
 *
 * Parses each run's .phi file, pairs each NONMEM subject back to its
 * synthetic-panel record (results.json, same subject order the CSV was
 * written in), and applies the acceptance criterion from the validation
 * plan: |eta_app - eta_NONMEM| < 0.1 x SE(eta_NONMEM), where SE is read from
 * the subject's own ETC (conditional covariance) block NONMEM reports.
 * Writes validation/comparison.json (report input) and prints a summary.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const results = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));

function parsePhi(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  const header = lines[1].trim().split(/\s+/);           // SUBJECT_NO ID ETA(1) ... ETC(...) OBJ
  const etaCols = header.map((h, i) => ({ h, i })).filter(x => /^ETA\(\d+\)$/.test(x.h));
  const etcCols = header.map((h, i) => ({ h, i })).filter(x => /^ETC\(\d+,\d+\)$/.test(x.h));
  const subjects = [];
  for (let li = 2; li < lines.length; li++) {
    const vals = lines[li].trim().split(/\s+/).map(Number);
    const eta = etaCols.map(c => vals[c.i]);
    const etc = {};
    etcCols.forEach(c => {
      const m = c.h.match(/^ETC\((\d+),(\d+)\)$/);
      etc[m[1] + ',' + m[2]] = vals[c.i];
    });
    const dim = eta.length;
    const se = [];
    for (let d = 1; d <= dim; d++) {
      const v = etc[d + ',' + d] != null ? etc[d + ',' + d] : etc[d + ',' + d]; // diagonal always present
      se.push(Math.sqrt(Math.max(0, v)));
    }
    subjects.push({ eta, se });
  }
  return subjects;
}

const runFiles = {
  ecu_pnh: 'validation/nonmem/run_ecu_pnh/NM_run1/psn.phi',
  ecu_ahus: 'validation/nonmem/run_ecu_ahus/NM_run1/psn.phi',
  ravu: 'validation/nonmem/run_ravu/NM_run1/psn.phi',
  crov: 'validation/nonmem/run_crov/NM_run1/psn.phi'
};

const projectRoot = path.join(__dirname, '..');
const byRun = {};
for (const r of results) (byRun[r.nmRun] = byRun[r.nmRun] || []).push(r);

const comparison = [];
for (const runName of Object.keys(byRun)) {
  const phiSubjects = parsePhi(path.join(projectRoot, runFiles[runName]));
  const subjRows = byRun[runName];
  if (phiSubjects.length !== subjRows.length) {
    throw new Error(runName + ': phi has ' + phiSubjects.length + ' subjects, expected ' + subjRows.length);
  }
  subjRows.forEach((r, i) => {
    const nm = phiSubjects[i];
    const perEta = r.etaApp.map((etaApp, d) => {
      const etaNm = nm.eta[d];
      const se = nm.se[d];
      const diff = Math.abs(etaApp - etaNm);
      const ratio = se > 0 ? diff / se : (diff < 1e-8 ? 0 : Infinity);
      return {
        name: r.etaNames[d], etaApp: etaApp, etaNonmem: etaNm, etaTrue: r.etaTrue[d],
        se: se, diff: diff, ratioOfSE: ratio, pass: ratio < 0.1
      };
    });
    comparison.push({
      id: r.id, drug: r.drug, disease: r.disease, label: r.label, nmRun: runName,
      etas: perEta, allPass: perEta.every(e => e.pass)
    });
  });
}

fs.writeFileSync(path.join(__dirname, 'comparison.json'), JSON.stringify(comparison, null, 2));

let nPass = 0, nTotal = 0, worstRatio = 0, worstWho = '';
for (const c of comparison) {
  for (const e of c.etas) {
    nTotal++;
    if (e.pass) nPass++;
    if (isFinite(e.ratioOfSE) && e.ratioOfSE > worstRatio) { worstRatio = e.ratioOfSE; worstWho = c.id + '/' + e.name; }
  }
  console.log((c.allPass ? 'PASS' : 'FAIL') + '  ' + c.id + '  (' + c.label + ')  '
    + c.etas.map(e => e.name + ':' + e.ratioOfSE.toFixed(3) + 'xSE').join('  '));
}
console.log('\n' + nPass + '/' + nTotal + ' eta comparisons pass |diff| < 0.1xSE(NONMEM).');
console.log('Worst case: ' + worstWho + ' at ' + worstRatio.toFixed(3) + 'xSE.');
