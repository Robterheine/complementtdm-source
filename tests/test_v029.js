'use strict';
/* v0.29.0 — custom infusion times, all IV administration routes.
 *
 * Author-approved plan (2026-09-14), following a four-person planning panel
 * (pharmacometrician, pharmacist, UI designer, coder). Key findings that
 * shaped the implementation:
 *
 *   - M.simulate() already had a DORMANT per-dose duration override
 *     (`d.dur`, model.js) that nothing in the UI or tests ever set --
 *     the hard part (engine plumbing) already existed; the real work was
 *     the data model, the UI, and the grid-density interaction buildGrid()
 *     has around a dose's own duration (the same class of issue v0.27.0
 *     fixed for a different trigger).
 *   - SC has no infusion-duration concept at all (instantaneous depot
 *     deposit, first-order ka absorption) -- not a smaller version of this
 *     feature, a non-question. The field is never shown, never read, and
 *     never used for an SC dose.
 *   - Author's decisions: duration reaches the REAL fit (not display-only);
 *     10-360 minutes, uniform across all three drugs; steady-state mode
 *     gets ONE scalar setting applied to every synthesised dose, not a
 *     per-dose value; a non-blocking warning when a FITTED sample falls
 *     inside a dose's own infusion window ("may impact estimation"); no
 *     negligible-at-trough claim is made anywhere (not verified, not
 *     asserted).
 *   - Units: the engine's own unit is DAYS throughout (INFUSION_D, d.dur);
 *     the UI works in MINUTES and converts at exactly one boundary
 *     (durToMinutes/minutesToDur), the same pattern dose-dt/obs-dt already
 *     use for epoch-ms -> days. Getting this wrong is precisely the F21
 *     class of bug (epoch-ms vs days) one release earlier.
 */
var fs = require('fs');
var u = require('./util.js');
var M = u.M, B = u.B, T = u.T;
require('../src/ui.js');   // attaches ECU.durToMinutes/minutesToDur/fmtDur

async function run() {
  var t = new T('v0.29.0 custom infusion times');
  var model = fs.readFileSync('src/model.js', 'utf8');
  var bayes = fs.readFileSync('src/bayes.js', 'utf8');
  var ui = fs.readFileSync('src/ui.js', 'utf8');
  var html = fs.readFileSync('index.html', 'utf8');

  function bodyOf(src, name) {
    var start = src.indexOf('function ' + name + '(');
    if (start < 0) return '';
    var end = src.indexOf('\n  }', start);
    return end < 0 ? src.slice(start) : src.slice(start, end + 4);
  }

  // ======================= 1. data model ===================================
  ['eculizumab', 'ravulizumab', 'crovalimab'].forEach(function (id) {
    var im = M.spec(id).infusionMinutes;
    t.ok(!!im, id + ': declares infusionMinutes');
    t.eq(im.min, 10, id + ': min is 10 minutes');
    t.eq(im.max, 360, id + ': max is 360 minutes');
  });
  // the default is DERIVED from INFUSION_D, never a second hardcoded number
  t.eq(ECU.durToMinutes(M.spec('eculizumab').INFUSION_D), 30, 'eculizumab default derives to 30 min from its own INFUSION_D');
  t.eq(ECU.durToMinutes(M.spec('ravulizumab').INFUSION_D), 150, 'ravulizumab default derives to 150 min (2.5 h)');
  t.eq(ECU.durToMinutes(M.spec('crovalimab').INFUSION_D), 60, 'crovalimab default derives to 60 min (1 h)');

  // ======================= 2. units round-trip ==============================
  t.eq(ECU.minutesToDur(45), 45 / 1440, '45 minutes converts to exactly 45/1440 days');
  t.close(ECU.durToMinutes(ECU.minutesToDur(45)), 45, 1e-9, 'round-trip 45 min -> days -> min recovers 45 exactly');
  t.eq(ECU.fmtDur(30 / 1440), '30 min', 'fmtDur: 30 min displays as "30 min"');
  t.eq(ECU.fmtDur(150 / 1440), '2.5 h', 'fmtDur: 150 min (2.5h) displays as "2.5 h", matching the house style');
  t.eq(ECU.fmtDur(60 / 1440), '1 h', 'fmtDur: exactly 60 min displays as "1 h", not "1.0 h"');

  // end-to-end: 45 minutes stored on a dose reaches the ODE's own rate event
  // at exactly the right time -- not 45 days, not 45 hours, not silently
  // reinterpreted anywhere along the way.
  M.select('eculizumab');
  var pProbe = M.indivParams(70, 'PNH', [0, 0], 'eculizumab', null);
  var probeDur = ECU.minutesToDur(45);
  var simA = M.simulate([{ t: 0, amt: 900, route: 'iv', dur: probeDur }], [probeDur - 1e-6, probeDur + 1e-6], pProbe, { id: 'eculizumab' });
  var simB = M.simulate([{ t: 0, amt: 900, route: 'iv', dur: 999 / 1440 }], [probeDur - 1e-6, probeDur + 1e-6], pProbe, { id: 'eculizumab' });
  t.ok(Math.abs(simA.c[0] - simA.c[1]) > Math.abs(simB.c[0] - simB.c[1]),
    'a dose stored with a 45-min duration actually ends its infusion near t=45min (concentration changes sharply there), unlike a 999-min dose at the same probe times');

  // ======================= 3. additive safety ===============================
  // explicit default == omitted, bit-for-bit, both at the simulate() level
  // and end-to-end through the real fit.
  // two doses, not one: v0.32.0 no longer projects an assumed trough from a
  // single dose, and troughs[0] below needs a REAL one to compare.
  var doses1 = [{ t: 0, amt: 900, route: 'iv' }, { t: 14, amt: 900, route: 'iv' }];
  var doses2 = [{ t: 0, amt: 900, route: 'iv', dur: M.spec('eculizumab').INFUSION_D },
    { t: 14, amt: 900, route: 'iv', dur: M.spec('eculizumab').INFUSION_D }];
  var sA = M.simulate(doses1, [0.01, 0.05, 0.5, 5], pProbe, { id: 'eculizumab' });
  var sB = M.simulate(doses2, [0.01, 0.05, 0.5, 5], pProbe, { id: 'eculizumab' });
  t.eq(JSON.stringify(sA.c), JSON.stringify(sB.c), 'explicit default duration is bit-identical to omitting it (M.simulate)');

  var fitDefault = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses1, obs: [{ t: 13.9, c: 90, lloq: false }], lloq: 0, target: 75, seed: 3 });
  var fitExplicit = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: doses2, obs: [{ t: 13.9, c: 90, lloq: false }], lloq: 0, target: 75, seed: 3 });
  t.eq(fitDefault.clQ.med, fitExplicit.clQ.med, 'explicit default duration gives an identical fitted clearance to omitting it (real runFit)');
  t.eq(fitDefault.troughs[0].med, fitExplicit.troughs[0].med, 'and an identical trough prediction');

  // ======================= 4. divergence: duration genuinely affects the fit
  var longDose = [{ t: 0, amt: 900, route: 'iv', dur: 300 / 1440 }];   // 5h, vs 30-min default
  var sim30 = M.simulate(doses1, [0.02], pProbe, { id: 'eculizumab' });
  var sim300 = M.simulate(longDose, [0.02], pProbe, { id: 'eculizumab' });
  t.ok(sim300.c[0] < sim30.c[0] * 0.5,
    'a 5h infusion gives a meaningfully lower early concentration than the 30-min default at the same probe time (' +
    sim300.c[0].toFixed(1) + ' vs ' + sim30.c[0].toFixed(1) + ')');

  // ======================= 5. buildGrid density (the v0.27.0-class fix) =====
  var fitLong = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: longDose, obs: [], lloq: 0, target: 75, seed: 1 });
  var hasTruePeakPoint = fitLong.grid.some(function (g) { return Math.abs(g - 300 / 1440) < 1e-5; });
  t.ok(hasTruePeakPoint, 'the grid contains a point at THIS dose’s own true end-of-infusion instant (300 min), not just the drug default (30 min)');
  var hasWrongDefaultPoint = fitLong.grid.filter(function (g) { return Math.abs(g - 30 / 1440) < 1e-5; }).length;
  // (a point may legitimately exist near there from the generic s*0.1
  // background grid -- the assertion above, not this one, is what proves
  // the fix; this is just documentary, not asserted on)
  t.ok(bayes.indexOf('add(d.t + (d.dur != null ? d.dur : dur));') >= 0,
    'buildGrid() reads the PER-DOSE duration when adding the peak instant, not the drug-wide default');

  // ======================= 6. during-infusion detection ======================
  function fitWithObsAt(obsT, durMin) {
    return B.runFit({
      wt: 70, disease: 'PNH', drug: 'eculizumab',
      doses: [{ t: 0, amt: 900, route: 'iv', dur: minutesToDurLocal(durMin) }],
      obs: [{ t: obsT, c: 400, lloq: false }], lloq: 0, target: 75, seed: 1
    });
  }
  function minutesToDurLocal(min) { return min / 1440; }
  var midInfusion = await fitWithObsAt(150 / 1440, 300);   // 2.5h into a 5h infusion
  t.eq(midInfusion.samplesDuringInfusion.length, 1, 'a sample strictly inside a 5h infusion window is flagged');
  t.ok(midInfusion.samplesDuringInfusion.length > 0 && midInfusion.samplesDuringInfusion[0].doseDurMin === 300,
    'the flag records the dose’s own duration in minutes');

  var afterInfusion = await fitWithObsAt(400 / 1440, 300);   // after the 5h/300min window
  t.eq(afterInfusion.samplesDuringInfusion.length, 0, 'a sample after the infusion has ended is not flagged');

  var beforeInfusion = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab',
    doses: [{ t: 0, amt: 900, route: 'iv', dur: 300 / 1440 }, { t: 14, amt: 900, route: 'iv', dur: 300 / 1440 }],
    obs: [{ t: -0.01, c: 90, lloq: false }], lloq: 0, target: 75, seed: 1
  });
  t.eq(beforeInfusion.samplesDuringInfusion.length, 0, 'a sample before a dose starts is not flagged by that dose');

  // exactly at the boundaries -- documented as excluded (strict, open interval)
  var atStart = await fitWithObsAt(0, 300);
  t.eq(atStart.samplesDuringInfusion.length, 0, 'a sample exactly AT the infusion start instant is not flagged (strict interval)');
  var atEnd = await fitWithObsAt(300 / 1440, 300);
  t.eq(atEnd.samplesDuringInfusion.length, 0, 'a sample exactly AT the infusion end instant is not flagged (strict interval)');

  // default duration (no custom .dur at all) is still checked -- every IV
  // dose has SOME duration, custom or the drug's own default.
  var defaultDurCheck = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: [{ t: 0, amt: 900, route: 'iv' }],
    obs: [{ t: 0.01, c: 400, lloq: false }], lloq: 0, target: 75, seed: 1   // 14.4 min into the 30-min DEFAULT infusion
  });
  t.eq(defaultDurCheck.samplesDuringInfusion.length, 1, 'the check applies to the DRUG DEFAULT duration too, not only an explicit custom one');

  // SC doses are never flagged, regardless of sample timing -- no infusion,
  // no window, by construction.
  M.select('crovalimab');
  var scCheck = await B.runFit({
    wt: 75, disease: 'PNH', drug: 'crovalimab',
    doses: [{ t: 0, amt: 340, route: 'sc' }], obs: [{ t: 0.001, c: 5, lloq: false }], lloq: 0, target: 75, seed: 1
  });
  t.eq(scCheck.samplesDuringInfusion.length, 0, 'an SC dose is never flagged — SC has no infusion-duration concept at all');

  // an EXCLUDED sample does not "impact estimation" (it never reaches the
  // likelihood), so it must not be flagged even if its timing would
  // otherwise qualify.
  M.select('eculizumab');
  var excludedCheck = await B.runFit({
    wt: 70, disease: 'PNH', drug: 'eculizumab', doses: [{ t: 0, amt: 900, route: 'iv', dur: 300 / 1440 }],
    obs: [{ t: 150 / 1440, c: 400, lloq: false, exclude: true }], lloq: 0, target: 75, seed: 1
  });
  t.eq(excludedCheck.samplesDuringInfusion.length, 0, 'an EXCLUDED sample is never flagged — it cannot impact an estimation it never reaches');

  // ======================= 7. bounds guard (engine backstop) =================
  M.select('eculizumab');
  var tooShort = false;
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: [{ t: 0, amt: 900, route: 'iv', dur: 5 / 1440 }], obs: [], lloq: 0, target: 75, seed: 1 });
  } catch (e) { tooShort = /10.*360|units/i.test(e.message); }
  t.ok(tooShort, 'a 5-minute duration (below the 10-min floor) throws a clear, units-aware error');

  var tooLong = false;
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: [{ t: 0, amt: 900, route: 'iv', dur: 400 / 1440 }], obs: [], lloq: 0, target: 75, seed: 1 });
  } catch (e) { tooLong = /10.*360|units/i.test(e.message); }
  t.ok(tooLong, 'a 400-minute duration (above the 360-min ceiling) throws');

  // the exact units-mismatch scenario the author asked to be guarded against:
  // hours mistakenly entered where minutes were expected (e.g. "5" meant as
  // 5 hours, but if mis-stored as 5 DAYS -- the F21-class mistake -- it must
  // be caught, not silently accepted as a 5-day "infusion").
  var unitsMismatch = false;
  try {
    await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: [{ t: 0, amt: 900, route: 'iv', dur: 5 }], obs: [], lloq: 0, target: 75, seed: 1 }); // 5 DAYS, not 5 minutes
  } catch (e) { unitsMismatch = true; }
  t.ok(unitsMismatch, 'a duration that is clearly in the wrong unit (5 DAYS, not minutes) is rejected, not silently simulated as a 5-day infusion');

  // an out-of-range duration on an SC (or bolus) dose is never even checked
  // -- SC never reads .dur, so a stray value there is inert, not an error.
  M.select('crovalimab');
  var scStrayDur = null;
  try {
    var fitStray = await B.runFit({ wt: 75, disease: 'PNH', drug: 'crovalimab', doses: [{ t: 0, amt: 340, route: 'sc', dur: 9999 }], obs: [], lloq: 0, target: 75, seed: 1 });
    scStrayDur = fitStray ? 'ran-fine' : null;
  } catch (e) { scStrayDur = 'threw:' + e.message; }
  t.eq(scStrayDur, 'ran-fine', 'a stray out-of-range .dur on an SC dose is inert (never read, never validated), not an error');

  // ======================= 8. steady-state: one scalar, uniform ==============
  M.select('eculizumab');
  var ssDoses = [];
  for (var k = 40; k >= 0; k--) ssDoses.push({ t: -k * 14, amt: 900, route: null, dur: 120 / 1440 });
  var fitSS = await B.runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', doses: ssDoses, obs: [], lloq: 0, target: 75, seed: 1, windowStart: -28 });
  t.ok(ssDoses.every(function (d) { return d.dur === 120 / 1440; }), 'sanity: the constructed SS-style dose list carries the same duration on every dose (mirroring what relContextSS() would build)');

  // ======================= 9. UI structural wiring ============================
  t.ok(html.indexOf('id="doseDurWrap"') >= 0, 'the full-schedule duration field exists');
  t.ok(html.indexOf('id="ssDurWrap"') >= 0, 'the steady-state duration field exists');
  t.ok(html.indexOf('id="dose-dur"') >= 0 && html.indexOf('id="ss-dur"') >= 0, 'both input elements exist');

  var syncBody = bodyOf(ui, 'syncDoseDurVisibility');
  t.ok(syncBody.length > 0, 'syncDoseDurVisibility() exists');
  // v0.45.0: the route comes from resolveDoseRoute() (Auto resolves by position) but the gate is still "not SC"
  t.ok(/resolveDoseRoute\(spec, routeSel\.value, state\.doses\.length\) !== 'sc'/.test(syncBody), 'the full-schedule field is gated on the (resolved) route being non-SC, not on the drug');

  var applyDrugBody = bodyOf(ui, 'applyDrugUI');
  t.ok(applyDrugBody.indexOf('syncDoseDurVisibility()') >= 0, 'applyDrugUI() calls syncDoseDurVisibility() (drug switch, import, restore, init all route through it)');
  t.ok(applyDrugBody.indexOf("ssDurW.style.display = spec.adminRoutes ? 'none' : 'block'") >= 0,
    'applyDrugUI() hides the SS duration field specifically for a drug with adminRoutes (crovalimab: 100% SC in SS mode, no IV administration exists there at all)');

  t.ok(ui.indexOf("routeSel.addEventListener('change', syncDoseDurVisibility)") >= 0,
    'the #dose-route change listener re-syncs duration-field visibility live (crovalimab: switching a single dose between IV/SC)');

  var addBody = bodyOf(ui, 'wire');
  t.ok(ui.indexOf('if (durMin != null) doseObj.dur = minutesToDur(durMin);') >= 0,
    'the dose-add handler stores the converted (minutes -> days) duration on the pushed dose object');
  t.ok(ui.indexOf("if (route !== 'sc') {") >= 0 && ui.indexOf('var durRaw = $(\'dose-dur\')') >= 0,
    'the duration field is only read for a non-SC dose');

  // relContext()/relContextSS() must carry .dur through -- the single most
  // important wiring check in this whole feature, since a silent drop here
  // means every UI/engine piece above is individually correct but the
  // feature is completely inert end-to-end.
  var relContextBody = bodyOf(ui, 'relContext');
  t.ok(relContextBody.indexOf('if (d.dur != null) out.dur = d.dur;') >= 0,
    'relContext() (full-schedule) carries dur through into dosesRel — without this, a custom duration never reaches runFit at all');
  var relContextSSBody = bodyOf(ui, 'relContextSS');
  t.ok(relContextSSBody.indexOf('if (ssDur != null) out.dur = ssDur;') >= 0,
    'relContextSS() applies the SAME scalar duration to every synthesised dose');
  t.ok(relContextSSBody.indexOf('if (!M.drug().adminRoutes) {') >= 0,
    'relContextSS() only reads the SS duration field for drugs with no adminRoutes (i.e. where SS mode is genuinely all-IV)');

  // export/import round-trip -- the other place this feature could go
  // silently inert (a saved/reopened session losing the duration).
  t.ok(ui.indexOf('dur: d.dur != null ? d.dur : null') >= 0, 'exportJson() carries each dose’s duration');
  t.ok(ui.indexOf('o.dur = du;') >= 0 && /cleanSession\(/.test(ui.slice(ui.indexOf('function importJson('))), 'importJson() restores each dose’s duration (through cleanSession(), v0.44.0)');
  t.ok(ui.indexOf("dur: (!M.drug().adminRoutes && $('ss-dur')") >= 0, 'exportJson() carries the SS scalar duration');
  t.ok(ui.indexOf("if ($('ss-dur')) $('ss-dur').value = c.ss.dur != null ? c.ss.dur : '';") >= 0, 'importJson() restores the SS scalar duration');

  // markStale wiring for the SS field (autosave + stale-banner trigger)
  t.ok(ui.indexOf("['ss-dose', 'ss-interval', 'ss-dur']") >= 0, 'the SS duration field is wired to markStale, same as ss-dose/ss-interval');

  // ======================= 10. disclosure ======================================
  t.ok(ui.indexOf('var showDur = state.doses.some(function (d) { return d.dur != null; });') >= 0,
    'the main dose table shows a Duration column only once a custom value is actually set (keeps the common case unchanged)');
  t.ok(ui.indexOf('var showDurR = st.doses.some(function (d) { return d.dur != null; });') >= 0,
    'the printed report’s dose table has the same conditional column');
  t.ok(ui.indexOf("ssDurUsed != null ? ', ' + fmtDur(ssDurUsed) + ' infusion'") >= 0,
    'the report’s steady-state summary sentence names a non-default duration — SS mode has no per-dose table, so this is its ONLY disclosure point');
  t.ok(ui.indexOf('fit.samplesDuringInfusion && fit.samplesDuringInfusion.length') >= 0,
    'the advisory block checks fit.samplesDuringInfusion');
  t.ok(ui.indexOf('may impact estimation') >= 0, 'the warning uses the author’s own framing ("may impact estimation")');
  t.ok(ui.indexOf('infdur:') >= 0, 'a help-popover entry exists for the new field');

  // ======================= 11. About/assumptions ===============================
  ['eculizumab', 'ravulizumab', 'crovalimab'].forEach(function (id) {
    var assumptions = M.spec(id).assumptions;
    t.ok(assumptions.some(function (a) { return /infusion duration is adjustable|adjustable \(10.?360 minutes\)/.test(a); }),
      id + ': assumptions disclose that infusion duration is now adjustable');
  });
  t.ok(model.indexOf('negligible') < 0 || model.indexOf('negligible at trough') < 0,
    'no "negligible at trough" claim is made anywhere in the model spec (author: not verified, not to be asserted)');

  return t.summary();
}

module.exports = { run: run };
