'use strict';
/* v0.38.0 — per-drug weight range: eculizumab accepts down to 3 kg.
 *
 * Author request: eculizumab's 25 kg lower weight limit excluded very young
 * children who should be able to have TDM; per the author, the source model
 * was developed on small children as well. Lowered to 3 kg for eculizumab
 * only. Ravulizumab (adult model) and crovalimab (age-gated, own paediatric
 * rules) keep 25 kg. The upper bound stays 300 kg for all three.
 *
 * The bound used to be a hardcoded 25-300 literal at four sites (runFit,
 * updateRunReady, updateStepper, the run-click alert) plus the HTML input.
 * It is now a per-drug spec field, `weightRange`, read at every one of them,
 * so the four sites cannot drift apart from each other or from the spec.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;

async function run() {
  var t = new T('v0.38.0 per-drug weight range (eculizumab down to 3 kg)');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  // ---- 1. the spec carries the range ---------------------------------------
  t.eq(M.spec('eculizumab').weightRange.min, 3, 'eculizumab weight minimum is 3 kg');
  t.eq(M.spec('eculizumab').weightRange.max, 300, 'eculizumab weight maximum stays 300 kg');
  t.eq(M.spec('ravulizumab').weightRange.min, 25, 'ravulizumab weight minimum stays 25 kg');
  t.eq(M.spec('crovalimab').weightRange.min, 25, 'crovalimab weight minimum stays 25 kg');

  // ---- 2. the engine enforces the per-drug range ---------------------------
  async function tryFit(drug, wt, doses, age) {
    M.select(drug);
    try {
      await B.runFit({ wt: wt, disease: 'PNH', drug: drug, age: age || null, doses: doses, obs: [], lloq: 0, target: 75, seed: 2 });
      return true;
    } catch (e) { return e.message; }
  }
  var ecuDose = [{ t: 0, amt: 300, route: 'iv' }];
  var ravDose = [{ t: 0, amt: 3000, route: 'iv' }];
  var croDose = [{ t: 0, amt: 1000, route: 'iv' }, { t: 1, amt: 340, route: 'sc' }];
  t.eq(await tryFit('eculizumab', 3, ecuDose), true, 'eculizumab: 3 kg (new lower bound) runs');
  t.eq(await tryFit('eculizumab', 10, ecuDose), true, 'eculizumab: 10 kg runs');
  var below = await tryFit('eculizumab', 2.9, ecuDose);
  t.ok(typeof below === 'string' && below.indexOf('3') >= 0 && below.indexOf('300') >= 0,
    'eculizumab: 2.9 kg is refused, and the message names the 3–300 kg range (got: ' + below + ')');
  t.ok(typeof (await tryFit('eculizumab', 301, ecuDose)) === 'string', 'eculizumab: 301 kg is still refused');
  var ravLow = await tryFit('ravulizumab', 10, ravDose);
  t.ok(typeof ravLow === 'string' && ravLow.indexOf('25') >= 0, 'ravulizumab: 10 kg is still refused, message names 25 kg (got: ' + ravLow + ')');
  t.ok(typeof (await tryFit('crovalimab', 10, croDose, 40)) === 'string', 'crovalimab: 10 kg is still refused');
  t.eq(await tryFit('ravulizumab', 25, ravDose), true, 'ravulizumab: 25 kg still runs');
  M.select('eculizumab');

  // ---- 3. no hardcoded 25-300 literal is left in the engine or the UI ------
  t.ok(bayes.indexOf('input.wt >= 25 && input.wt <= 300') < 0, 'bayes.js no longer hardcodes the 25–300 kg literal');
  t.ok(/weightRange/.test(bayes), 'bayes.js reads the range from the drug spec');
  t.ok((ui.match(/wt >= 25 && .{0,20}<= 300/g) || []).length === 0, 'ui.js no longer hardcodes the 25–300 kg literal');
  t.ok((ui.match(/weightRange/g) || []).length >= 4,
    'ui.js reads weightRange at every site (updateRunReady, updateStepper, run-click alert, applyDrugUI)');
  t.ok(/pt-wt[\s\S]{0,200}\.min\s*=\s*[^;]*weightRange/.test(ui) || /wtEl\.min\s*=/.test(ui),
    'applyDrugUI syncs the weight input’s min/max to the selected drug');

  // ---- 4. the HTML default matches the default drug (eculizumab) -----------
  t.ok(html.indexOf('id="pt-wt" min="3" max="300"') >= 0, 'the weight input starts at min 3 (default drug is eculizumab)');

  // ---- 5. the paediatric disclaimer is no longer a blanket "no children" ---
  t.ok(ui.indexOf('the models do not cover paediatric patients') < 0,
    'the About/report disclaimer no longer claims that no model covers paediatric patients');
  t.ok(M.spec('eculizumab').assumptions.some(function (a) { return a.indexOf('3') >= 0 && /kg/.test(a); }),
    'the eculizumab assumptions state the 3–300 kg range and that it is the author’s scope decision');

  return t.summary();
}

module.exports = { run: run };
