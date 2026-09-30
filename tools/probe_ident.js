/* Temporary probe: identifiability diagnostics behave as designed.
 * A: SC troughs only -> ka/F informativeness ~ 0 (prior-anchored), high |corr(CL,F/KA)|
 * B: SC peak + troughs -> ka/F informativeness improves (data start informing them) */
'use strict';
global.ECU = {};
require('../src/model.js');
require('../src/bayes.js');
var M = ECU.model, B = ECU.bayes;

var doses = [{ t: 0, amt: 1000, route: 'iv' }];
for (var d = 1; d <= 4; d++) doses.push({ t: 1 + d * 7, amt: 340, route: 'sc' });
var sig = M.spec('crovalimab').SIGMA;
var ETA_TRUE = [0.15, -0.1, 0, 0, 0.1, 0.15];

function obsAt(times, sdFrac) {
  var p = M.indivParams(75, 'PNH', ETA_TRUE, 'crovalimab', 40);
  var sim = M.simulate(doses, times, p, { rtol: 1e-8, id: 'crovalimab' });
  return sim.c.map(function (c, k) {
    var sd = Math.sqrt(sig.ADD + sig.PROP * c * c);
    return { t: times[k], c: c + sd * sdFrac, lloq: false };
  });
}

function report(tag, fit) {
  var sh = fit.etaInformation;
  console.log(tag);
  console.log('  informativeness: ' + fit.map.etaNames.map(function (n, i) {
    return n + ' ' + (sh ? sh[i].toFixed(2) : '?');
  }).join(', '));
  var C = fit.etaCorr;
  if (C) {
    console.log('  corr(CL,F)=' + C[0][5].toFixed(2) + '  corr(CL,KA)=' + C[0][4].toFixed(2) +
      '  corr(CL,V1)=' + C[0][1].toFixed(2));
  }
}

function runFitAt(times, tag) {
  return B.runFit({
    wt: 75, age: 40, disease: 'PNH', drug: 'crovalimab', doses: doses,
    obs: obsAt(times, 0.3), lloq: 0, target: 75, seed: 42, mcmcIters: 4000
  }, { progress: function () {} }).then(function (fit) { report(tag, fit); });
}

runFitAt([55.999, 69.999], 'A: 2 SC troughs only').then(function () {
  return runFitAt([56.999, 60, 69.999], 'B: SC peak (~4 d post-dose) + 2 troughs');
});
