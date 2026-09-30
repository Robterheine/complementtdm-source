/* =========================================================================
 * mAb TDM — application wiring (vanilla JS, no dependencies)
 *
 * Scope: enter the patient, the actual dosing schedule and measured
 * concentrations, then run the Bayesian forecast. No preprogrammed dosing
 * regimens are assumed or suggested — the user provides everything.
 * ========================================================================= */
(function () {
  'use strict';
  var M = ECU.model, B = ECU.bayes, C = ECU.chart;
  var D = ECU.diagnostics || null;
  var DAY = 86400000;
  var SEED = 20250907;
  // Version comes from src/version.js — the single source of truth (kept in
  // step with package.json by build.mjs and tests/test_version.js).
  var VERSION = (typeof ECU !== 'undefined' && ECU.VERSION) || '0.0.0';

  function $(id) { return document.getElementById(id); }

  // All data fields start empty — the clinician enters everything (weight,
  // target, regimen) themselves; nulls mean "not entered yet".
  var state = {
    patient: { code: '', wt: null, age: null, disease: 'PNH' },
    drug: 'eculizumab',
    target: { value: null },
    lloq: null,
    errMult: 1,
    recency: 'off',   // advanced fitting option; see B.recencyTau()
    doses: [],   // {t: ms, amt: mg, route?: 'iv'|'sc'}
    obs: [],     // {t: ms, c: ug/mL, lloq: bool}
    fit: null,   // bayes result + .rel
    report: { preparedBy: '', advice: '' },
    running: false
  };

  /* ------------------------ session autosave -----------------------------
   * An hour of ward data entry used to be lost to an accidental refresh, a
   * back-swipe on a tablet or a tab eviction: state lived only in this closure.
   * localStorage is same-origin, stays on the device and never leaves it, so it
   * is consistent with the app's offline, nothing-transmitted design. The JSON
   * export remains the way to move a session between machines. (v0.13.0) */
  var LS_KEY = 'complementtdm.session.v1';
  var lsOk = (function () {
    try { var k = '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; }
    catch (e) { return false; }   // private window, blocked site data, etc.
  })();

  function saveSession() {
    if (!lsOk) return;
    try {
      /* F12 (independent audit, 2026-09-13): patient.code (a name or MRN-like
       * identifier the clinician may type) is never persisted to localStorage
       * — on a shared ward PC, that would leave an identifiable patient name
       * sitting in browser storage indefinitely. Everything else needed to
       * pick the session back up (doses, measurements, target, drug) has no
       * identifying value on its own and is unaffected. The JSON export
       * still carries the code, by design — it is the deliberate, portable,
       * user-initiated path, not something written silently in the background. */
      /* Steady-state mode's own fields (ss-dose, ss-interval, ss-anchor,
       * and since v0.29.0 ss-dur) were never covered here -- only
       * state.doses/state.obs (full-schedule mode's own records). A
       * steady-state session with no measurements entered yet read as
       * completely empty and was never even offered for restore; one WITH
       * measurements restored those, but not the regimen itself, and not
       * even the fact that the app should be in steady-state mode at all.
       * Mirrors exportJson()'s existing ss:{dose,interval,anchor,dur} shape
       * exactly, so the two restore paths (autosave, JSON file) describe
       * the same four fields the same way. */
      var ss = currentMode() === 'ss' ? readSS(false) : null;
      localStorage.setItem(LS_KEY, JSON.stringify({
        v: ECU.VERSION, savedAt: Date.now(),
        patient: Object.assign({}, state.patient, { code: '' }), drug: state.drug, target: state.target,
        lloq: state.lloq, errMult: state.errMult, recency: state.recency,
        mode: currentMode(),
        ss: ss ? { dose: ss.D, interval: ss.I, anchor: new Date(ss.A).toISOString(),
          dur: (!M.drug().adminRoutes && $('ss-dur') && $('ss-dur').value.trim() !== '') ? parseFloat($('ss-dur').value) : null } : null,
        doses: state.doses, obs: state.obs, report: state.report,
        plan: readPlanRaw(), priorTx: readPrior()
      }));
    } catch (e) { /* quota or serialisation failure must never break the app */ }
  }
  function loadSession() {
    if (!lsOk) return null;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      // A pure steady-state regimen (dose/interval/anchor set, but no
      // measurements entered yet) is just as much "something worth
      // restoring" as a full-schedule session with doses/obs recorded --
      // without this, a session that was only ever a configured regimen
      // read as empty and was silently never offered for restore at all.
      var hasSSRegimen = s && s.mode === 'ss' && s.ss && s.ss.dose > 0;
      if (!s || (!(s.doses && s.doses.length) && !(s.obs && s.obs.length) && !hasSSRegimen)) return null;
      return s;
    } catch (e) { return null; }
  }
  function clearSession() {
    if (!lsOk) return;
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  // --------------------------- helpers -----------------------------------
  function at9(d) { var x = new Date(d); x.setHours(9, 0, 0, 0); return x.getTime(); }
  /* The YEAR is deliberately included. Without it a mistyped year (one stray
   * arrow-press in a datetime-local field) is invisible in every table and in
   * the printed report, while silently re-anchoring day 0 of the whole fit. */
  function fmtDate(ms) {
    return new Date(ms).toLocaleString('en-GB',
      { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtC(v) { return isFinite(v) ? (v >= 100 ? Math.round(v).toString() : (v >= 10 ? v.toFixed(1) : v.toFixed(2))) : '–'; }
  /* v0.42.0 (review A2): a probability that rounds to 0 or 100 is printed as
   * "< 1%" / "> 99%" -- a finite chain cannot show certainty, and "100%" next
   * to a zero-width "(100–100%)" interval read as infinite precision. */
  function fmtPct(p) {
    if (!isFinite(p)) return '–';
    var r = Math.round(p * 100);
    return r >= 100 ? '> 99%' : r <= 0 ? '< 1%' : r + '%';
  }
  // Monte-Carlo interval text, omitted when it rounds to zero width (A2).
  function fmtPci(ci) {
    if (!(ci && isFinite(ci[0]) && isFinite(ci[1]))) return '';
    var lo = Math.round(ci[0] * 100), hi = Math.round(ci[1] * 100);
    return lo === hi ? '' : lo + '–' + hi + '%';
  }
  /* Troughs are computed a hair (1e-6 day) before the dose, so a 09:00 dose
   * printed its trough at 08:59 (review C6). Shown at the dose minute. */
  function troughDate(rel, t) {
    return fmtDate(rel.t0ms + Math.round(t * 1440) / 1440 * DAY);
  }
  /* Review A3: print the WORST-informed parameter's ESS, not clearance's. */
  function essText(fit) {
    var all = fit.essAll, names = fit.map && fit.map.etaNames;
    if (all && all.length && names && names.length === all.length) {
      var k = 0;
      for (var i = 1; i < all.length; i++) if (all[i] < all[k]) k = i;
      return 'lowest ESS ≈ ' + Math.max(1, Math.round(all[k])) + ' (' + names[k] + ')';
    }
    return 'ESS ≈ ' + Math.max(1, Math.round(fit.essMin != null ? fit.essMin : (fit.essCL || 0)));
  }
  /* v0.43.0 (review B1/B2, author's decision): the TERMINAL half-life of the
   * two-compartment model, as a median and 5–95% range across posterior
   * draws. For eculizumab (saturable elimination) it holds at a stated
   * concentration: the predicted true trough before the next dose. */
  function halfLifeInfo(fit) {
    if (!fit || !fit.draws || !fit.draws.length) return null;
    var drug = M.drug();
    var nonlinear = drug.THETA.VMAX > 0;
    var next = (fit.troughs || []).filter(function (tr) { return tr.assumed; })[0] ||
      (fit.troughs && fit.troughs.length ? fit.troughs[fit.troughs.length - 1] : null);
    var conc = next && isFinite(next.med) ? next.med : NaN;
    if (nonlinear && !(conc > 0)) return null;
    var n = fit.draws.length, step = Math.max(1, Math.floor(n / 400)), vals = [];
    for (var i = 0; i < n; i += step) {
      var p = M.indivParams(fit.wt, fit.disease, fit.draws[i], drug.id, fit.age);
      var th = M.terminalHalfLife(p, conc);
      if (isFinite(th)) vals.push(th);
    }
    if (!vals.length) return null;
    vals.sort(function (a, b) { return a - b; });
    var q = function (f) { return vals[Math.min(vals.length - 1, Math.max(0, Math.round(f * (vals.length - 1))))]; };
    var pTyp = M.indivParams(fit.wt, fit.disease, fit.map ? fit.map.etaVec || fit.map.eta || [0, 0] : [0, 0], drug.id, fit.age);
    return {
      med: q(0.5), p5: q(0.05), p95: q(0.95), nonlinear: nonlinear,
      conc: conc, concText: isFinite(conc) ? (conc >= 10 ? String(Math.round(conc)) : conc.toFixed(1)) : '',
      vmax: pTyp.vmax, km: pTyp.km,
      clTotal: nonlinear ? pTyp.cl + pTyp.vmax / (pTyp.km + conc) : pTyp.cl
    };
  }
  function halfLifeText(hl) {
    return hl.med.toFixed(1) + ' days [5–95% ' + hl.p5.toFixed(1) + '–' + hl.p95.toFixed(1) + ']' +
      (hl.nonlinear ? ' at a trough of ' + hl.concText + ' µg/mL' : '');
  }

  /* Review B4: residual error as SD/CV with units; NONMEM variances kept. */
  function residualText(spec) {
    var parts = [], vars = [];
    if (spec.SIGMA.ADD > 0) { parts.push('additive SD ' + Math.sqrt(spec.SIGMA.ADD).toFixed(1) + ' µg/mL'); vars.push(spec.SIGMA.ADD); }
    parts.push('proportional CV ' + (Math.sqrt(spec.SIGMA.PROP) * 100).toFixed(1) + '%'); vars.push(spec.SIGMA.PROP);
    return parts.join(' + ') + ' (NONMEM variances ' + vars.join(' and ') + ')';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  /* A mistyped year in a datetime-local field is one arrow-press away and used
   * to be invisible everywhere. Challenge anything outside roughly the last
   * three years to a year ahead, naming the parsed date in full. */
  function plausibleTime(ms, what) {
    var now = Date.now();
    var lo = now - 3 * 365.25 * DAY, hi = now + 365.25 * DAY;
    if (ms >= lo && ms <= hi) return true;
    return confirm('That ' + what + ' is dated ' + fmtDate(ms) +
      ', which is outside the last three years / next year.\n\nIs that date correct?');
  }

  /* Full MAP eta vector as a label/pair list — dimension-agnostic (v0.9.0:
   * crovalimab estimates all 6 PK etas, 2-eta drugs keep the familiar pair). */
  function etaLabel(pm) {
    var names = (pm && pm.etaNames && pm.etaNames.length) ? pm.etaNames : ['CL', 'V1'];
    return 'η(' + names.join('), η(') + ')';
  }
  function fmtEtaVec(pm) {
    var names = (pm && pm.etaNames && pm.etaNames.length) ? pm.etaNames : ['CL', 'V1'];
    var vec = (pm && pm.etaVec && pm.etaVec.length) ? pm.etaVec : [pm && pm.etaCL, pm && pm.etaV1];
    var parts = [];
    for (var i = 0; i < names.length; i++) {
      parts.push(names[i] + ' ' + (isFinite(vec[i]) ? vec[i].toFixed(2) : '–'));
    }
    return parts.join(', ');
  }

  /* v0.9.2 — compact per-eta data-informativeness visual. One row per eta:
   * a tiny horizontal bar (filled proportion = shrinkage) with a percent
   * label, colour-coded green (well informed ≥ 0.5), amber (partly informed
   * 0.3–0.5) or grey-red (prior-anchored < 0.3). Grey-red deliberately reads
   * as "no information" rather than "error" — prior-anchored is honest, not
   * a failure. Rendered in the results card and in the print report. */
  function shrinkLevel(sv) {
    return sv >= 0.5 ? 'ok' : (sv >= 0.3 ? 'warn' : 'weak');
  }
  function infoBars(fit) {
    if (!fit || !fit.etaInformation || !fit.map || !fit.map.etaNames) return '';
    var names = fit.map.etaNames, sh = fit.etaInformation, out = '';
    for (var i = 0; i < sh.length; i++) {
      if (!isFinite(sh[i])) continue;
      var pc = Math.max(0, Math.min(1, sh[i]));
      var lv = shrinkLevel(pc);
      out += '<div class="shrink-row" title="' + names[i] + ': ' + Math.round(pc * 100) +
        '% informed by your samples (0% = stays on the population model, 100% = fully determined by the measurements)">' +
        '<span class="shrink-name">η(' + names[i] + ')</span>' +
        '<span class="shrink-track"><span class="shrink-fill ' + lv + '" style="width:' + Math.round(pc * 100) + '%"></span></span>' +
        '<span class="shrink-pct ' + lv + '">' + Math.round(pc * 100) + '%</span></div>';
    }
    return out ? '<div class="shrink-bars" title="How much of each individual parameter shift the measurements actually determined: longer bar = better informed by your samples.">' + out +
      '<div class="shrink-key">Bar length = share informed by your samples · <span class="sk-ok">green ≥ 50%</span> · <span class="sk-warn">amber 30–49%</span> · <span class="sk-weak">grey &lt; 30% (population prior)</span></div></div>' : '';
  }
  /* F3/F11 (independent audit, 2026-09-13): colour is an attainment report
   * against the user's own chosen target, not a decision rule — this app
   * never suggests a dose or interval change (README golden rule). The old
   * "≥ 90%" text also hid the actual number once above threshold, and the
   * warn/bad titles told the reader to change the regimen. All three badges
   * now always show the real percent; none of them recommend anything. */
  function ptaBadge(p, ci) {
    if (!isFinite(p)) return '<span class="badge info" title="Probability not available">–</span>';
    var ciTxt = fmtPci(ci) ? ' (Monte-Carlo 95% interval ' + fmtPci(ci) + ')' : '';
    var pct = esc(fmtPct(p));
    if (p >= 0.9) return '<span class="badge ok" data-help="pta" title="Probability ' + pct + ', the trough target is likely to be maintained' + ciTxt + '">P ' + pct + '</span>';
    if (p >= 0.5) return '<span class="badge warn" data-help="pta" title="Probability ' + pct + ', intermediate attainment against your chosen target' + ciTxt + '">P ' + pct + '</span>';
    return '<span class="badge bad" data-help="pta" title="Probability ' + pct + ', the target is unlikely to be attained' + ciTxt + '">P ' + pct + '</span>';
  }
  /* Dosing intervals are whole days in practice; fmtC would render 14 as
   * "14.0", which reads like a measured quantity rather than a schedule. */
  function fmtDays(v) {
    if (!isFinite(v)) return '?';
    return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
  }
  function noteHtml(text, kind) {
    return '<div class="note ' + (kind || '') + '">' + text + '</div>';
  }

  /* --------------- novice-help machinery (v0.8.0) ------------------------
   * P2 two-tier help: prescriber-language ⓘ popovers for the six fields where
   * a novice stalls (click/tap/keyboard — works where native `title` does
   * not); every other hover tooltip stays as it is. Popover text is plain
   * language on purpose; the technical wording remains in the `title`s and
   * the About dialog. */
  var HELP = {
    ivexplore: 'Shows what this patient\u2019s own fitted parameters predict for a different dose or interval, using the posterior the last run already produced, no refit needed. Choose what to vary: the other value stays fixed at what you entered. The table shows the steady-state trough, once the patient is continued on the candidate regimen until the concentration settles. For a drug that accumulates, this is the lower, and usually the decision-relevant, number. The app shows the consequences; choosing the regimen remains yours.',
    wt: 'Body weight, used by the model to adjust clearance and volumes. Enter the current weight in kg.',
    age: 'Age in years. Older patients absorb the under-the-skin (SC) dose more slowly. The model uses this to adjust the absorption rate.',
    target: 'The lowest trough you want to keep. The table shows P(> target), the chance the true trough stays above this number. Left empty, the drug\u2019s usual target is used.',
    lloq: 'Lowest concentration your lab can measure reliably (see the lab report, e.g. 10 \u00b5g/mL). Samples below this are still useful. Tick \u201c< LLOQ\u201d when you add them.',
    lloqbox: 'Tick when the lab reported the result as below the measurement limit. Leave the concentration field empty; the app uses the LLOQ value.',
    errmult: 'Leave at 1 unless your lab advises otherwise. Raise it only if your assay is noisier than the model assumes. The forecast then leans more on typical patients.',
    recency: 'Optional, off by default. A measurement describes the patient as they were on the day it was drawn, so a sample from a year ago says a little less about them today than one from last week. Switched on, older samples are given a larger measurement error and therefore pull the fit less \u2014 low, medium and high set how much larger it grows (up to 1.5, 2 or 3 times). The newest sample is never affected, and no sample is ever discarded. This is a setting for the assay error, so it works the same way for every drug.',
    prior: 'Doses given before the first one entered here still leave drug in the blood. The model cannot see them, so it explains the higher level by assuming this patient clears the drug slowly, and then predicts levels that are too high for any longer interval. Answer No only if the first dose above really was the first ever dose. Otherwise enter the earlier doses, or use Steady state mode for a patient who has been on the same regimen for months.',
    plan: 'Optional. The dose and interval you intend to give after the last dose in the schedule. The chart\u2019s projected doses and the next-dose trough then follow this regimen. Left empty, the app continues with the interval and dose found in the entered history, which lags behind a recent interval change. This is your plan, not a suggestion from the app, and it does not change the fit to the measured levels.',
    infdur: 'Optional \u2014 leave blank to use the drug\u2019s own default. How long the IV infusion actually ran, in minutes (10\u2013360). Not applicable to SC doses, which have no infusion \u2014 the depot absorbs at its own rate regardless of injection time. Affects the shape of the concentration curve during and shortly after the infusion; a sample drawn while it was still running is flagged separately, since it may not reflect a representative concentration.'
  };

  /* P-badge click popover: the badge's own (dynamic) title, incl. the
   * Monte-Carlo interval, shown tap-friendly instead of hover-only. */
  function helpTextFor(key, el) {
    if (key === 'pta') return el ? (el.getAttribute('title') || '') : '';
    return HELP[key] || (el ? el.getAttribute('title') || '' : '');
  }

  function wireHelpPopovers() {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    document.addEventListener('click', function (e) {
      var pop = document.getElementById('helpPop');
      var btn = e.target.closest ? e.target.closest('button.info[data-help], .badge[data-help]') : null;
      if (!btn) {
        if (pop && pop.classList.contains('show')) {
          pop.classList.remove('show');
          setExpanded(pop._src, false);
        }
        return;
      }
      e.preventDefault();
      if (!pop) {
        pop = document.createElement('div');
        pop.id = 'helpPop';
        pop.setAttribute('role', 'note');
        document.body.appendChild(pop);
      }
      var key = btn.getAttribute('data-help');
      if (pop.getAttribute('data-for') === key && pop.classList.contains('show') && pop._src === btn) {
        // second click on the same trigger toggles the popover off
        pop.classList.remove('show');
        setExpanded(pop._src, false);
        return;
      }
      // switching triggers: put the previous trigger's state back in sync
      setExpanded(pop._src, false);
      pop.textContent = helpTextFor(key, btn);
      pop.setAttribute('data-for', key);
      pop._src = btn;
      pop.classList.add('show');
      setExpanded(btn, true);
      var r = btn.getBoundingClientRect();
      var pw = pop.offsetWidth || 240;
      var left = Math.max(8, Math.min(r.left, (window.innerWidth || 1024) - pw - 8));
      pop.style.left = left + 'px';
      // flip above the trigger when there is no room below (short viewports /
      // bottom-of-page fields such as the < LLOQ ⓘ in the sample form)
      var spaceBelow = (window.innerHeight || 800) - r.bottom;
      var ph = pop.offsetHeight || 60;
      if (spaceBelow < ph + 16 && r.top > ph + 16) {
        pop.style.top = (r.top + (window.scrollY || 0) - ph - 6) + 'px';
      } else {
        pop.style.top = (r.bottom + (window.scrollY || 0) + 6) + 'px';
      }
    });
    // Escape closes the popover and keeps aria-expanded truthful
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var p2 = document.getElementById('helpPop');
        if (p2 && p2.classList.contains('show')) {
          p2.classList.remove('show');
          setExpanded(p2._src, false);
        }
      }
    });
  }
  function setExpanded(btn, val) {
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', val ? 'true' : 'false');
  }

  /* P1: the Run button teaches the requirements while disabled. */
  // The accepted body-weight range is a per-drug spec field (v0.38.0);
  // the fallback only covers a spec that predates it.
  function weightRange() { return M.drug().weightRange || { min: 25, max: 300 }; }
  function weightInRange(w) { var r = weightRange(); return w >= r.min && w <= r.max; }

  function updateRunReady() {
    if (typeof document === 'undefined') return;
    var btn = $('btnRun'), hint = $('runHint');
    if (!btn) return;
    readPatient();
    var wtOk = weightInRange(state.patient.wt);
    // F8: only crovalimab declares pediatricBlockAge -- the button stays
    // blocked below it (a hard refusal, same as an out-of-range weight),
    // but 12-16 is allowed through with a flagged, non-blocking advisory
    // (see runFit's pediatricWarn) rather than being disabled here too.
    var ageMsg = ageReason(M.drug(), state.patient.age);
    var ageOk = !ageMsg;
    var errMultOk = state.errMultOk !== false;
    var doseOk = currentMode() === 'ss' ? !!readSS(false) : state.doses.length > 0;
    var prior = currentMode() === 'ss' ? 'no' : readPrior();
    var tr = M.drug().targetRange || { min: 10, max: 500 };
    var tgtOk = state.target.value >= tr.min && state.target.value <= tr.max;
    var reasons = [];
    if (!wtOk) {
      // A weight that WAS entered but is out of range for this drug must say
      // so (v0.39.0): "enter the patient's weight" read as a bug to a user
      // who had typed 8 kg into ravulizumab, whose minimum is 25 kg.
      var wr = weightRange();
      reasons.push(isFinite(state.patient.wt)
        ? 'a weight between ' + wr.min + ' and ' + wr.max + ' kg for ' + M.drug().label
        : 'the patient\u2019s weight');
    }
    if (!ageOk) reasons.push(ageMsg);
    if (!doseOk) reasons.push(currentMode() === 'ss' ? 'a steady-state dose and interval' : 'at least one dose');
    if (!tgtOk) reasons.push('a trough target between ' + tr.min + ' and ' + tr.max + ' \u00b5g/mL');
    if (!errMultOk) reasons.push('an assay error multiplier between 0.1 and 10 (Assay settings, below the measurements)');
    if (prior == null) reasons.push('an answer to \u201ctreated before the first dose entered?\u201d');
    if (prior === 'yes') reasons.push('the earlier doses (then answer No), or use Steady state mode,');
    var ok = reasons.length === 0 && !state.running;
    btn.disabled = !ok;
    if (hint) {
      if (ok) {
        // P5: set the expectation about the report's human fields — one faint
        // line, no new input on the main screen
        hint.textContent = 'You will be asked who prepared the report when you print.';
        hint.classList.add('show', 'ready');
      } else {
        hint.textContent = 'Enter ' + reasons.join(' and ') + ' to run the forecast.';
        hint.classList.remove('ready');
        hint.classList.add('show');
      }
    }
  }

  /* P1: four-step guide under the header; each dot fills as the step is done. */
  /* v0.16.0: the stepper's numbers must match the numbered cards below it —
   * "Add samples" used to be its own numbered step 3, but samples are
   * optional and live in card 2 alongside doses, so a separate number there
   * disagreed with the card it actually belonged to. Merged into one step. */
  /* v0.19.0: step 4 ("Explore regimen") re-added, matching card 4 — it was
   * deliberately left out in v0.16.0 on the reasoning that the explorer is a
   * downstream, optional tool with no onboarding step of its own; feedback
   * was that the stepper's count should still reach 4, matching the card it
   * corresponds to, with the step simply becoming reachable once a forecast
   * exists (mirroring how "Run forecast" itself only becomes active once
   * weight and doses are entered). */
  function updateStepper() {
    if (typeof document === 'undefined') return;
    var el = $('stepper');
    if (!el || el.classList.contains('hidden')) return;
    var wtDone = weightInRange(state.patient.wt);
    var doseDone = currentMode() === 'ss' ? !!readSS(false) : state.doses.length > 0;
    var runDone = !!state.fit && !state.stale;
    var exploreDone = !!(state.fit && state.fit.intervalScan);
    function set(step, done, active) {
      var s = el.querySelector('[data-step="' + step + '"]');
      if (!s) return;
      s.classList.toggle('done', !!done);
      s.classList.toggle('active', !!active && !done);
    }
    set('wt', wtDone, true);
    set('dose', doseDone, wtDone);
    set('run', runDone, wtDone && doseDone);
    set('explore', exploreDone, runDone);
  }

  /* P4: non-blocking toast with Undo (replaces the native confirm()). */
  function showToast(msg, undoFn, ms) {
    var t = $('toast');
    if (!t) { if (undoFn) undoFn(); return; }
    t.innerHTML = esc(msg) + (undoFn ? ' <button class="linklike" id="toastUndo" type="button">Undo</button>' : '');
    t.classList.add('show');
    if (undoFn) {
      var b = document.getElementById('toastUndo');
      if (b) b.addEventListener('click', function () { undoFn(); hideToast(); });
    }
    clearTimeout(showToast._h);
    showToast._h = setTimeout(hideToast, ms || 6000);
  }
  function hideToast() {
    var t = $('toast');
    if (t) { t.classList.remove('show'); t.innerHTML = ''; }
  }

  /* P3: qualitative sampling-precision word (diagnostics stay in the details).
   * F6 (independent audit, 2026-09-13): prefer essMin (the worst-informed
   * parameter across ALL etas, e.g. ka or F on a 6-eta crovalimab posterior
   * that CL alone would not show) over essCL alone; essCL remains the
   * fallback when essMin isn't present (e.g. a synthetic/legacy fit object
   * with only essCL set), so this stays a strict superset of the old
   * behaviour rather than a breaking change. */
  function precisionWord(fit) {
    if (!fit || !fit.hasObs) return 'not applicable (population forecast)';
    var essSrc = fit.essMin != null ? fit.essMin : fit.essCL;
    var ess = Math.max(0, essSrc || 0);
    if (fit.covFallback || ess < 100) return 'low (consider re-sampling or additional samples)';
    if (ess < 300) return 'intermediate';
    return 'good';
  }

  // --------------------------- inputs -------------------------------------
  /* v0.46.0 (review U2): the assay error multiplier used to be replaced by 1 when
   * it was outside 0.1-10, with no message and the typed number still showing in
   * the field. A typed 50 gave output identical to 1, while a valid 3 moved
   * P(trough > 75) from 96 % to 69 %. Empty means "leave at the default 1";
   * anything else outside the range is reported and blocks the run. */
  function parseErrMult(raw) {
    if (raw == null || String(raw).trim() === '') return { ok: true, value: 1 };
    var v = Number(raw);
    if (!isFinite(v) || v < 0.1 || v > 10) return { ok: false, value: 1 };
    return { ok: true, value: v };
  }
  /* v0.46.0 (review U5): why the age is not acceptable, in the words the Run hint
   * needs, or null when it is. Typing 8 for crovalimab used to say only "the
   * patient's age". */
  function ageReason(spec, age) {
    if (!spec || !spec.covariateAge) return null;
    var min = spec.pediatricBlockAge || 1;
    if (!(age > 0)) return 'the patient\u2019s age';
    if (age < min) return 'an age of ' + min + ' years or more for ' + spec.label;
    if (age > 100) return 'an age of 100 years or less';
    return null;
  }
  /* v0.46.0 (review D2): the age belongs to the model only when the drug has an age
   * covariate. The field is hidden for the others, but its value (typed for
   * crovalimab) used to stay in the session and be written to the export. */
  function effectiveAge(spec, raw) {
    var a = parseFloat(raw);
    return spec && spec.covariateAge && isFinite(a) && a > 0 ? a : null;
  }

  function readPatient() {
    state.patient.code = $('pt-code').value.trim();
    state.patient.wt = parseFloat($('pt-wt').value);
    state.patient.disease = $('pt-disease').value;
    state.drug = $('pt-drug').value || 'eculizumab';
    if (M.drugs[state.drug]) M.select(state.drug);
    state.patient.age = effectiveAge(M.drug(), $('pt-age') ? $('pt-age').value : '');   // v0.46.0: only when the drug uses it
    if (!M.drug().diseaseCovariate) state.patient.disease = 'PNH';  // not a covariate of this model
    var tv = parseFloat($('pt-target').value);
    state.target.value = isFinite(tv) && tv > 0 ? tv : null;
    if (state.target.value == null) state.target.value = M.drug().targetDefault || 75;
    var ll = $('pt-lloq').value;
    state.lloq = ll === '' ? null : parseFloat(ll);
    var emp = parseErrMult($('pt-errmult') ? $('pt-errmult').value : '');
    state.errMult = emp.value;
    state.errMultOk = emp.ok;   // v0.46.0: an out-of-range value is reported, not silently replaced
    var rc = $('pt-recency');
    state.recency = rc && RECENCY_PRESETS.indexOf(rc.value) >= 0 ? rc.value : 'off';
  }

  /* Custom infusion times (2026-09-14, author-approved plan). The engine's own
   * time unit is DAYS everywhere (INFUSION_D, d.dur) -- nobody enters a
   * clinical duration as a fraction of a day, so the UI works in MINUTES and
   * converts at this one boundary, the same pattern dose-dt/obs-dt already
   * use to convert epoch-ms to days. durToMinutes()/minutesToDur() are the
   * only two places this conversion happens; every other line of code deals
   * in whichever unit it already dealt in before this feature existed. */
  /* v0.45.0 (review U1): which route a new dose gets. The select used to offer
   * only iv / sc and stay on IV, so the "first dose IV, later doses SC" fallback
   * below was unreachable and every SC dose was silently fitted as IV. "Auto"
   * (the default) resolves by position. A drug without adminRoutes has no
   * route concept. */
  function resolveDoseRoute(spec, selected, nDoses) {
    var ar = spec && spec.adminRoutes;
    if (!ar) return null;
    if (selected === 'iv' || selected === 'sc') return selected;
    return nDoses > 0 ? ar.subsequent : ar.first;
  }
  /* v0.45.0 (review U4): a second dose within 24 h of another only looks like a
   * double entry when it has the SAME route. Crovalimab's standard start (IV in
   * the afternoon of day 1, the first SC dose next morning) is 19 h apart. */
  function isDuplicateDose(doses, t, route) {
    return doses.some(function (d) {
      return Math.abs(d.t - t) < 24 * 3600000 && (d.route || null) === (route || null);
    });
  }
  function durToMinutes(days) { return Math.round(days * 1440); }
  function minutesToDur(min) { return min / 1440; }
  // Display only (dose table, report): minutes below an hour, hours (1 dp)
  // at or above -- matches the house style already used in the drug hints
  // ("IV infusion over 2.5 h").
  function fmtDur(days) {
    var min = durToMinutes(days);
    if (min < 60) return min + ' min';
    var h = min / 60;
    return (h % 1 === 0 ? h : h.toFixed(1)) + ' h';
  }
  /* Shows/hides the full-schedule duration field for whichever route is
   * currently selected (SC has no infusion-duration concept at all -- see
   * M.simulate()); a no-op, empty-string-safe no-adminRoutes drug is always
   * IV, so always shown. Also prefills the placeholder with THIS drug's own
   * default, converted to minutes, so an untouched field reads as informative
   * rather than blank. Called from applyDrugUI() (drug changes) and the
   * #dose-route change listener wired there (route changes, crovalimab only,
   * since only crovalimab shows that selector at all). */
  function syncDoseDurVisibility() {
    var wrap = $('doseDurWrap');
    if (!wrap) return;
    var spec = M.drug();
    var routeSel = $('dose-route');
    var isIV = !spec.adminRoutes || !routeSel || resolveDoseRoute(spec, routeSel.value, state.doses.length) !== 'sc';
    wrap.style.display = isIV ? 'block' : 'none';
    var durEl = $('dose-dur');
    if (durEl && !durEl.value) durEl.placeholder = 'e.g. ' + durToMinutes(spec.INFUSION_D);
  }

  /* Refresh the per-drug parts of the UI (dose field conventions, steady-state
   * default interval, sampling hints, model description, disease covariate,
   * trough-target default). */
  function applyDrugUI() {
    var spec = M.drug();
    var d = spec.dose;
    ['dose-amt', 'ss-dose'].forEach(function (id) {
      var el = $(id);
      el.value = '';
      el.min = d.min;
      el.max = d.max;
      el.placeholder = 'e.g. ' + d.default;
      /* step="any", NOT the spec's dose granularity. Native constraint
       * validation runs before the submit handler, so a value off the step grid
       * silently prevents the dose from ever being added: with crovalimab's
       * old min=100/step=50 the real 340, 680 and 1020 mg doses were all
       * rejected with a browser bubble suggesting wrong values. Range is still
       * checked in JS, where the message is ours (v0.13.0). */
      el.step = 'any';
    });
    $('ss-interval').value = '';
    $('ss-interval').placeholder = 'e.g. ' + spec.ssIntervalDefault;
    // v0.11.0: one short pragmatic hint per drug (full model documentation
    // lives in the About dialog — the main screen stays light).
    var HINTS = {
      eculizumab: 'IV infusion over 30 min.',
      // F8 (independent audit, 2026-09-13): displayed as fact, not a
      // warning — the model has no age covariate to gate on at all.
      ravulizumab: 'IV infusion over 2.5 h. Developed for adults.',
      crovalimab: 'First dose IV (loading), then SC.'
    };
    var hintEl = $('drugHint');
    /* The hint line shows, in order of relevance: a per-disease note
     * (eculizumab PNH/aHUS), else the short pragmatic route hint. */
    function drugHintText() {
      var dnote = spec.diseaseCovariate ?
        ((spec.diseaseNotes || {})[state.patient.disease] || '') : '';
      return dnote || HINTS[spec.id] || '';
    }
    if (hintEl) hintEl.textContent = drugHintText();
    var peak = spec.samplePeak + ' · trough just before the next dose';
    var h = $('sampleHint');
    if (h) h.textContent = '· ' + peak;
    $('obs-dt').title = 'Time the blood sample was drawn, ' + peak;
    // disease is only asked for when it is a covariate of the selected model;
    // age only when it is a covariate of the selected model (crovalimab ka)
    var dr = $('diseaseRow');
    if (dr) dr.style.display = spec.diseaseCovariate ? 'block' : 'none';
    // keep the hint current when the user changes the disease (eculizumab)
    var dSel = $('pt-disease');
    if (dSel && !dSel.dataset.noteWired) {
      dSel.dataset.noteWired = '1';
      dSel.addEventListener('change', function () {
        readPatient();
        if (hintEl) hintEl.textContent = drugHintText();
        syncRecencyHint();
      });
    }
    var ar = $('ageRow');
    if (ar) ar.style.display = spec.covariateAge ? 'block' : 'none';
    // per-drug dose-field route selector (crovalimab: IV loading, SC thereafter)
    var rw = $('doseRouteWrap');
    if (rw) rw.style.display = spec.adminRoutes ? 'block' : 'none';
    /* Custom infusion times (2026-09-14, author-approved plan): the duration
     * field is a property of the ROUTE (IV only -- SC has no infusion-duration
     * concept at all, see M.simulate()), not of the drug. For a drug with no
     * adminRoutes (eculizumab, ravulizumab) every dose is IV, so it is always
     * shown; for crovalimab it tracks whichever route is currently selected
     * in #dose-route, wired below (change listener, guarded so it is only
     * attached once per page load, same pattern as the disease-note listener
     * a few lines up). */
    var routeSel = $('dose-route');
    if (routeSel && !routeSel.dataset.durWired) {
      routeSel.dataset.durWired = '1';
      routeSel.addEventListener('change', syncDoseDurVisibility);
    }
    syncDoseDurVisibility();
    // steady-state mode: crovalimab's SS regimen is 100% SC maintenance (no
    // IV administration exists in that mode at all -- relContextSS() always
    // uses adminRoutes.subsequent) so the field is not merely hidden, it is
    // genuinely inapplicable; every other drug's SS regimen is 100% IV.
    var ssDurW = $('ssDurWrap');
    if (ssDurW) ssDurW.style.display = spec.adminRoutes ? 'none' : 'block';
    var ssDurEl = $('ss-dur');
    if (ssDurEl && !ssDurEl.value) ssDurEl.placeholder = 'e.g. ' + durToMinutes(spec.INFUSION_D);
    // measurement-field and target-field limits + tooltips come from the spec
    var wtEl = $('pt-wt');
    if (wtEl) { wtEl.min = weightRange().min; wtEl.max = weightRange().max; }
    var ov = $('obs-val');
    if (ov) { ov.min = spec.obsValMin || 0.01; ov.max = spec.obsValMax || 10000; }
    var tr = spec.targetRange || { min: 10, max: 500 };
    var tg = $('pt-target');
    if (tg) {
      tg.min = tr.min; tg.max = tr.max;
      // Prefill with the drug's default trough target — the same value the
      // forecast, the P(trough > target) column and the plot use — so the
      // folded summary and the run agree from the start.
      tg.value = spec.targetDefault || 75;
    }
    state.target.value = spec.targetDefault || 75;
    updateTargetFold();
    var wtEl = $('pt-wt');
    if (wtEl && spec.wtTooltip) wtEl.title = spec.wtTooltip;
    // SC dosing reaches much higher steady-state concentrations for crovalimab —
    // give the chart room instead of clipping at the eculizumab-tuned default
    if (spec.yMaxCap) chartYMaxCap = spec.yMaxCap; else chartYMaxCap = 2400;
    var dn = $('drugHint');
    if (dn) dn.textContent = drugHintText();   // re-evaluate after readPatient
    // trough-target hint for the selected drug (the field itself stays empty —
    // runFit falls back to the drug default when left blank)
    var th = $('targetHint');
    if (th) th.textContent = spec.targetHint || '';
    syncRecencyHint();
  }

  function targetLabel() {
    return '> ' + state.target.value + ' µg/mL';   // raw text: SVG labels use textContent
  }

  /* The trough target lives in a collapsed <details> so it cannot be changed by
   * accident; its summary always shows the value the forecast and the plot
   * actually use (the drug default until the user opens it and edits). */
  /* Advanced fitting option: time-dependent weighting of older samples.
   *
   * This is a residual-error (SIGMA) setting, not a random-effects one: it
   * multiplies each sample's residual SD by a factor that grows with the
   * sample's age. It therefore applies to every drug and every disease, and
   * does not depend on whether a given model estimates between-occasion
   * variability — that is an OMEGA term and a separate matter entirely. */
  var RECENCY_PRESETS = ['off', 'low', 'medium', 'high'];

  function syncRecencyHint() {
    var sel = $('pt-recency');
    if (sel) sel.value = RECENCY_PRESETS.indexOf(state.recency) >= 0 ? state.recency : 'off';
    var hint = $('recencyHint');
    if (!hint) return;
    var mx = B.recencyMaxMult(state.recency);
    if (!(mx > 1)) {
      hint.textContent = 'All measurements are weighted equally, whatever their date. ' +
        'This is the published residual error model, and the default.';
      return;
    }
    var yr = B.recencyMult(state.recency, 365);
    hint.textContent = 'Older samples are given a larger residual error, so they influence the fit ' +
      'less than recent ones: ×' + yr.toFixed(2) + ' after a year, rising towards ×' + mx.toFixed(1) +
      ' (a weight of ' + Math.round(100 / (mx * mx)) + '%). The newest sample is never inflated, ' +
      'and no sample is ever discarded.';
  }

  function updateTargetFold() {
    var el = $('targetFoldVal');
    if (!el) return;
    var inp = $('pt-target');
    var v = inp ? parseFloat(inp.value) : NaN;
    if (!(isFinite(v) && v > 0)) v = (M.drug() && M.drug().targetDefault) || 75;
    el.textContent = v + ' µg/mL';
  }

  /* Keep the browser title, header, footer and About dialog on the central
   * version string (src/version.js). */
  function applyVersion() {
    if (typeof document === 'undefined') return;
    var t = document.getElementById('titleVersion');
    if (t) t.textContent = 'v' + VERSION;
    var f = document.getElementById('footerVersion');
    if (f) f.textContent = VERSION;
    if (document.title && document.title.indexOf('(v') < 0) {
      document.title = document.title + ' (v' + VERSION + ')';
    }
  }

  var chartYMaxCap = 2400;   // per-drug chart y-axis cap (set by applyDrugUI)

  function markStale() {
    if (state.running) return;
    // Author report (2026-09-18): editing or removing a measurement after a
    // forecast had run left the old chart, trough table and advisories fully
    // displayed underneath the stale banner -- easy to miss, and the stale
    // numbers otherwise looked exactly like current ones. The displayed
    // forecast is cleared the moment it goes stale, not just flagged.
    // state.fit itself is kept (openReportDialog() still offers to print the
    // last run's result, with its own explicit staleness confirm()); only the
    // on-screen display resets, and only once, not on every further keystroke
    // while already stale.
    if (state.fit && !state.stale) showStaleResults();
    state.stale = true;
    var b = $('staleBanner');
    if (b) b.style.display = 'block';
    updateRunReady();
    updateStepper();
    saveSession();   // every mutation goes through here, so this is the autosave point
  }

  // ------------------------- schedule modes -------------------------------
  function currentMode() {
    var el = document.querySelector('input[name="schedMode"]:checked');
    return el && el.value === 'ss' ? 'ss' : 'full';
  }

  function setMode(m) {
    var radios = document.querySelectorAll('input[name="schedMode"]');
    Array.prototype.forEach.call(radios, function (r) { r.checked = (r.value === m); });
    $('fullDoseUI').style.display = m === 'full' ? 'block' : 'none';
    $('ssDoseUI').style.display = m === 'ss' ? 'block' : 'none';
    renderDoses();
    renderObs();
    markStale();
    updateRunReady();
  }

  /* v0.41.0: "treated before the first entered dose?" (full-schedule mode).
   * Missing early doses make the fit read the carried-over drug as slow
   * elimination -- in testing, CL 0.065 instead of 0.161 L/day, and a q21d
   * regimen reported as P(>75) = 100% while the true trough was 59. So the
   * forecast only runs once this is answered "no". null = not answered. */
  function readPrior() {
    var el = document.querySelector('input[name="priorTx"]:checked');
    return el ? el.value : null;
  }
  function setPrior(v) {
    Array.prototype.forEach.call(document.querySelectorAll('input[name="priorTx"]'), function (r) {
      r.checked = (r.value === v);
    });
  }

  /* v0.40.0: optional planned regimen (full-schedule mode). readPlanRaw()
   * is what gets saved (both fields, possibly half-filled, so a restore gives
   * back exactly what was typed); readPlan() is what the forecast uses:
   * null = none entered, an object = valid, false = invalid (alerted). */
  function readPlanRaw() {
    var a = parseFloat($('plan-dose') ? $('plan-dose').value : '');
    var i = parseFloat($('plan-interval') ? $('plan-interval').value : '');
    return { amt: isFinite(a) ? a : null, interval: isFinite(i) ? i : null };
  }
  function readPlan(alertOn) {
    var r = readPlanRaw();
    if (r.amt == null && r.interval == null) return null;
    var dl = M.drug().dose, bad = [];
    if (!(r.amt >= dl.min && r.amt <= dl.max)) bad.push('dose (' + dl.min + '\u2013' + dl.max + ' mg)');
    if (!(r.interval >= 1 && r.interval <= 365)) bad.push('interval (1\u2013365 days)');
    if (bad.length) {
      if (alertOn) alert('Planned regimen: enter a valid ' + bad.join(' and ') + ', or leave both fields empty.');
      return false;
    }
    return { amt: r.amt, interval: r.interval };
  }
  function setPlanFields(p) {
    if ($('plan-dose')) $('plan-dose').value = p && p.amt != null ? p.amt : '';
    if ($('plan-interval')) $('plan-interval').value = p && p.interval != null ? p.interval : '';
  }

  /* Parse the steady-state panel inputs. Returns {D, I, A} or null (with an
   * alert unless alertOn is false). */
  function readSS(alertOn) {
    var dl = M.drug().dose;
    var D = parseFloat($('ss-dose').value);
    var I = parseFloat($('ss-interval').value);
    var A = Date.parse($('ss-anchor').value);
    var bad = [];
    if (!(D >= dl.min) || !(D <= dl.max)) bad.push('dose (' + dl.min + '–' + dl.max + ' mg)');
    if (!(I >= 1) || !(I <= 90)) bad.push('interval (1–90 days)');
    // (D and I are null when the fields are empty — the range checks above fire first)
    if (!isFinite(A) || A > Date.now() + DAY) bad.push('latest-dose date');
    // Custom infusion times: only checked when the field is both visible
    // (not adminRoutes -- crovalimab's SS regimen is 100% SC) and non-empty
    // (blank is valid: it means "use the drug's default").
    if (!M.drug().adminRoutes) {
      var ssDurRaw2 = $('ss-dur') ? $('ss-dur').value.trim() : '';
      if (ssDurRaw2 !== '') {
        var ssDurVal = parseFloat(ssDurRaw2);
        var imSS = M.drug().infusionMinutes || { min: 10, max: 360 };
        if (!(ssDurVal >= imSS.min && ssDurVal <= imSS.max)) bad.push('infusion duration (' + imSS.min + '–' + imSS.max + ' min)');
      }
    }
    if (bad.length) {
      if (alertOn) alert('Steady-state regimen: enter a valid ' + bad.join(', ') + '.');
      return null;
    }
    return { D: D, I: I, A: A };
  }

  // ------------------------- model input prep -----------------------------
  function relContext() {
    readPatient();
    if (currentMode() === 'ss') return relContextSS();
    var t0ms = Infinity;
    state.doses.forEach(function (d) { if (d.t < t0ms) t0ms = d.t; });
    if (!isFinite(t0ms)) return null;
    var dosesRel = state.doses.slice().map(function (d) {
      // Custom infusion times (2026-09-14): `dur` must survive this mapping
      // or a per-dose duration set in the dose form never reaches runFit at
      // all -- it would sit in state.doses, visibly stored, and be silently
      // dropped right here, the one place this whole feature could go
      // completely inert without a single error anywhere.
      var out = { t: (d.t - t0ms) / DAY, amt: d.amt, route: d.route || null };
      if (d.dur != null) out.dur = d.dur;
      return out;
    }).sort(function (a, b) { return a.t - b.t; });
    var excluded = 0;
    var obsRel = [];
    state.obs.forEach(function (o) {
      if (o.t < t0ms - 30 * 60000) { excluded++; return; }
      obsRel.push({ t: (o.t - t0ms) / DAY, c: o.c, lloq: o.lloq, exclude: !!o.exclude, note: o.note || '' });
    });
    obsRel.sort(function (a, b) { return a.t - b.t; });
    return {
      t0ms: t0ms,
      dosesRel: dosesRel,
      obsRel: obsRel,
      excludedObs: excluded,
      nowRel: (Date.now() - t0ms) / DAY
    };
  }

  /* Steady-state mode: the latest dose (anchor, A) is day 0. Earlier cycles are
   * synthesized back far enough that the system is at steady state when the
   * first recorded sample was drawn; the regimen is also continued forward so
   * the forecast shows the patient staying on it (future doses remain virtual). */
  function relContextSS() {
    var ss = readSS(true);
    if (!ss) return null;
    var D = ss.D, I = ss.I, A = ss.A;
    var earliest = state.obs.length
      ? Math.min.apply(null, state.obs.map(function (o) { return o.t; }))
      : Infinity;
    var coverD = isFinite(earliest) ? Math.min(400, (A - earliest) / DAY) : 0;
    if (coverD < 0) coverD = 0;
    // Eculizumab accumulates slowly at high troughs (saturable clearance), so the
    // pre-roll is sized as ~240 days before the first sample/anchor, regardless of
    // the dosing interval, so the displayed cycles sit on the true steady state.
    var pre = Math.ceil(240 / I) + 1;   // extra cycles before the first sample
    var K = Math.min(80, Math.max(pre + 1, Math.ceil(coverD / I) + pre));
    // slow SC absorption (crovalimab ka ≈ 0.126/day, t½,depot ≈ 5.5 d) needs a
    // longer pre-roll so the early displayed cycles are not still ramping
    if (M.drug().KA_D > 0) K = Math.min(120, K + Math.ceil(28 / M.drug().KA_D / I));
    var earliestAllowed = A - K * I * DAY;
    var excluded = 0;
    var obsRel = [];
    state.obs.forEach(function (o) {
      if (o.t < earliestAllowed - 30 * 60000) { excluded++; return; }
      obsRel.push({ t: (o.t - A) / DAY, c: o.c, lloq: o.lloq, exclude: !!o.exclude, note: o.note || '' });
    });
    obsRel.sort(function (a, b) { return a.t - b.t; });
    var dosesRel = [];
    var k;
    // steady-state maintenance: all doses are of the "subsequent" route kind
    var ssRoute = M.drug().adminRoutes ? M.drug().adminRoutes.subsequent : null;
    /* Custom infusion times (2026-09-14): ONE scalar, applied to every
     * synthesized dose alike (historical pre-roll and future cycles both) --
     * there is no per-dose form in SS mode to give a different value to any
     * one of them, and nobody has real per-cycle timestamps to attach one to
     * anyway (author's own instruction: "1 setting for all administrations").
     * Read only when relevant: crovalimab's SS regimen is 100% SC
     * (ssRoute = adminRoutes.subsequent), which has no duration concept at
     * all, so #ssDurWrap is hidden for it (applyDrugUI) and nothing here
     * needs to special-case that -- ssDur simply stays null and `dur` is
     * never set on any of these doses. */
    var ssDur = null;
    if (!M.drug().adminRoutes) {
      var ssDurRaw = $('ss-dur') ? $('ss-dur').value.trim() : '';
      if (ssDurRaw !== '') ssDur = minutesToDur(parseFloat(ssDurRaw));
    }
    function mkSSDose(t) {
      var out = { t: t, amt: D, route: ssRoute };
      if (ssDur != null) out.dur = ssDur;
      return out;
    }
    for (k = K; k >= 1; k--) dosesRel.push(mkSSDose(-k * I));
    dosesRel.push(mkSSDose(0));
    var nowRel = (Date.now() - A) / DAY;
    var ahead = 3 + (nowRel > 0 ? Math.floor(nowRel / I) : 0);
    for (k = 1; k <= ahead; k++) dosesRel.push(mkSSDose(k * I));
    var wStart = -2 * I;
    var minObsRel = obsRel.length ? obsRel[0].t : Infinity;
    if (isFinite(minObsRel)) wStart = Math.min(wStart, minObsRel - 2);
    wStart = Math.max(wStart, -240, -K * I + 1);
    return {
      ssMode: true,
      t0ms: A,
      dosesRel: dosesRel,
      obsRel: obsRel,
      excludedObs: excluded,
      excludedDays: K * I,
      nowRel: nowRel,
      windowStart: wStart
    };
  }

  // --------------------------- run forecast -------------------------------
  function showProgress(show, frac, msg) {
    var w = $('progress');
    w.style.display = show ? 'block' : 'none';
    $('progressBar').style.width = Math.round((frac || 0) * 100) + '%';
    $('progressMsg').textContent = msg || '';
  }

  async function runFit() {
    if (state.running) return;
    readPatient();
    var plan = currentMode() === 'ss' ? null : readPlan(true);
    if (plan === false) return;
    var rel = relContext();
    if (!rel) {
      if (!state.doses.length && currentMode() === 'full') {
        alert('Add at least one dose first. Use the dose form below.');
      }
      return;
    }
    var wt = state.patient.wt;
    if (!weightInRange(wt)) { alert('Enter the patient\'s body weight (' + weightRange().min + '–' + weightRange().max + ' kg), a covariate of the model.'); return; }
    // F8 (independent audit, 2026-09-13): crovalimab-only. Below
    // pediatricBlockAge the model has no basis to extrapolate the
    // absorption-rate covariate and is refused outright, same as an
    // out-of-range weight; 12-16 is allowed through (flagged separately by
    // runFit's pediatricWarn, rendered as a non-blocking advisory).
    var minAge = M.drug().pediatricBlockAge || 1;
    if (M.drug().covariateAge && !(state.patient.age >= minAge && state.patient.age <= 100)) {
      alert(M.drug().label + ' requires an age between ' + minAge + ' and 100 years. The model was not developed for younger children.');
      return;
    }
    if (state.errMultOk === false) {
      alert('The assay error multiplier must be between 0.1 and 10 (Assay settings, below the measurements), or left at 1.');
      return;
    }
    var tRange = M.drug().targetRange || { min: 10, max: 500 };
    if (!(state.target.value >= tRange.min && state.target.value <= tRange.max)) {
      alert('Enter a trough target between ' + tRange.min + ' and ' + tRange.max + ' \u00b5g/mL for ' + M.drug().label + '.');
      return;
    }
    if (currentMode() === 'full' && readPrior() !== 'no') {
      alert(readPrior() === 'yes'
        ? 'Earlier doses are missing. Enter them (then answer No), or use Steady state mode. Without them the forecast would be falsely reassuring.'
        : 'Answer whether the patient was treated with this drug before the first dose entered.');
      return;
    }

    state.running = true;
    $('btnRun').disabled = true;
    $('staleBanner').style.display = 'none';
    showProgress(true, 0.01, 'Preparing…');
    var status = $('fitStatus');
    status.innerHTML = '';

    try {
      var input = {
        wt: wt,
        age: state.patient.age,
        disease: state.patient.disease,
        doses: rel.dosesRel,
        obs: rel.obsRel,
        lloq: state.lloq || 0,
        errMult: state.errMult || 1,
        recency: state.recency || 'off',
        target: state.target.value,
        windowStart: rel.windowStart,
        planned: currentMode() === 'ss' ? null : plan,
        seed: SEED
      };
      var fit = await B.runFit(input, {
        progress: function (f, m) { showProgress(true, f, m); }
      });
      fit.rel = rel;
      state.fit = fit;
      state.stale = false;
      var warn = [];
      if (rel.excludedObs > 0) {
        warn.push(noteHtml(rel.excludedObs + ' measurement(s) ' +
          (rel.ssMode ? 'predating the steady-state history on this regimen (older than the ' + rel.excludedDays + ' days simulated back to steady state)' : 'earlier than the first dose') +
          ' were excluded from the fit.', 'warn'));
      }
      if (state.obs.length && !state.obs.some(function (o) { return !o.lloq; })) {
        warn.push(noteHtml('All measurements are below LLOQ. Individualization relies entirely on censored (M3) information.', 'warn'));
      }
      if (fit.covFallback) {
        warn.push(noteHtml('The parameter uncertainty was estimated from the population prior (the curvature of the fit at the optimum was not usable). Interpret the prediction bands with extra caution and consider re-sampling.', 'warn'));
      }
      status.innerHTML = warn.join('');
      var hint = null;   // v0.11.0: chartHint element removed (info in x-label)
      if (hint) {
        hint.textContent = rel.ssMode
          ? ' · day 0 = latest dose of the steady-state regimen (negative days = preceding cycles)'
          : ' · time in days since first dose';
      }
      renderChart();
      renderResults();
    } catch (err) {
      console.error(err);
      status.innerHTML = noteHtml('Forecast failed: ' + esc(err && err.message || err), 'bad');
    } finally {
      state.running = false;
      $('btnRun').disabled = false;
      updateRunReady();
      updateStepper();
      showProgress(false, 0, '');
    }
  }

  // ----------------------------- chart ------------------------------------
  /* v0.17.0 — phone/desktop chart layout. Charts stay one hand-built SVG
   * string per render; the only new idea is that the caller now measures its
   * OWN container and tells chart.js whether to lay out compact or wide,
   * rather than drawing one wide layout and letting the browser scale it
   * (which is what made phone chart text illegible before this). */
  var PHONE_CHART_PX = 480;
  function isCompactWidth(px) { return px > 0 && px < PHONE_CHART_PX; }

  /* hostOverride: render into a different element than the live #chart div —
   * used by generateReport() to build a guaranteed-desktop copy for print
   * without disturbing whatever the clinician currently has on screen.
   * forceCompact: true/false pins the layout regardless of container width
   * (print always forces false); omitted, it auto-detects. */
  function renderChart(hostOverride, forceCompact) {
    var fit = state.fit;
    var host = hostOverride || $('chart');
    if (!fit) {
      if (!hostOverride) host.innerHTML = '<div class="note">Enter the dosing schedule and press “Run forecast” to see the concentration–time plot.</div>';
      return;
    }
    var compact = forceCompact != null ? forceCompact : isCompactWidth(host.clientWidth);
    var rel = fit.rel;
    var grid = fit.grid;
    // chartBand/chartPriorBand continue the regimen past the last real dose
    // (same historical dose/interval) so the curve doesn't wash out to zero
    // and read as "therapy stopped"; troughs/fitting elsewhere are computed
    // from the real doses only and are unaffected by this (see bayes.js).
    var med = fit.chartBand.med, p5 = fit.chartBand.p5, p95 = fit.chartBand.p95;
    var pm5 = fit.chartPriorBand.p5, pm95 = fit.chartPriorBand.p95;
    var xMin = fit.windowStart || 0;
    // Only quantified samples are plottable: blank-valued censored samples have
    // no numeric result (plotting them at 0 would misrepresent a below-LLOQ
    // measurement; they still appear in the obs table and drive the M3 fit).
    // NB: isFinite(null) is true (null coerces to 0), so the null check is required.
    function plottable(o) { return o.c != null && isFinite(o.c) && o.c >= 0; }
    var obsPts = rel.obsRel.filter(function (o) { return o.t >= xMin - 0.01 && plottable(o); }).map(function (o) {
      return { x: o.t, y: o.c, color: '#dc2626', label: 'obs' };
    });

    /* The axis is sized to what is actually DRAWN. Once an individual fit
     * exists the population band is no longer plotted (see below), so it must
     * not influence the y-range either — otherwise a wide, invisible
     * population band could still stretch the axis and visually flatten the
     * individual band it was supposed to have been replaced by. */
    var yMax = 60;
    function consider(v) { if (isFinite(v) && v > yMax) yMax = v; }
    p95.forEach(consider);
    if (!fit.hasObs) pm95.forEach(consider);
    obsPts.forEach(function (p) { consider(p.y); });
    consider(state.target.value);
    // lower edge of the data, needed only for the optional log axis
    var yLoData = Infinity;
    function considerLo(v) { if (isFinite(v) && v > 0 && v < yLoData) yLoData = v; }
    p5.forEach(considerLo);
    if (!fit.hasObs) pm5.forEach(considerLo);
    obsPts.forEach(function (p) { considerLo(p.y); });
    considerLo(state.target.value);
    yMax = Math.min(yMax * 1.18, chartYMaxCap);
    var logEl = $('logY');
    var logY = !!(logEl && logEl.checked);
    var yMin = 0;
    if (logY) {
      // snap to whole decades so the log grid reads cleanly; the values
      // themselves stay in µg/mL — only the axis spacing changes
      var loRaw = Math.max(1e-3, isFinite(yLoData) ? yLoData : yMax / 100);
      yMin = Math.pow(10, Math.floor(Math.log10(loRaw)));
      yMax = Math.pow(10, Math.ceil(Math.log10(Math.max(yMax, yMin * 10))));
      if (!(yMax > yMin)) yMax = yMin * 10;
    }
    var xMax = Math.max(fit.horizon, rel.nowRel) + 2;

    var legend = [];
    var series = [];
    var bands = [];
    var rows = [];

    if (fit.hasObs) {
      /* Once an individual fit exists, the population band is deliberately
       * NOT drawn — showing it alongside a narrower, patient-informed band
       * invited exactly the misreading a clinician must not make: that the
       * wider population range is somehow still the relevant uncertainty for
       * THIS patient. A fit that used this patient's own measurements
       * supersedes the population prior; only the individual band is shown.
       * ("Individual prediction", not "Posterior": a clinician reading this
       * chart while dosing a patient should not need to know what a
       * posterior distribution is.) */
      bands.push({ x: grid, lo: p5, hi: p95, fill: 'rgba(14,116,144,.16)' });
      series.push({ x: grid, y: med, color: '#0e7490', width: 2.2, label: 'Individual prediction (median)' });
      rows.push({ label: 'Individual prediction (median)', color: '#0e7490', values: med });
      legend.push({ label: 'Individual prediction 5–95%', color: 'rgba(14,116,144,.55)', swatch: 'band' });
    } else {
      bands.push({ x: grid, lo: pm5, hi: pm95, fill: 'rgba(100,116,139,.14)' });
      series.push({ x: grid, y: fit.chartPriorBand.med, color: '#475569', width: 2, label: 'Population prediction (median)' });
      rows.push({ label: 'Population prediction (median)', color: '#475569', values: fit.chartPriorBand.med });
      legend.push({ label: 'Population prediction 5–95%', color: 'rgba(100,116,139,.45)', swatch: 'band' });
    }
    rows.push({ label: 'Observed', color: '#dc2626', values: {} });
    legend.push({ label: 'Observation', color: '#dc2626', swatch: 'dot' });
    legend.push({ label: 'Dose', color: '#94a3b8', swatch: 'line', dash: '2 3' });
    legend.push({ label: 'Today', color: '#b45309', swatch: 'line', dash: '4 4' });

    var vlines = rel.dosesRel.filter(function (d) { return d.t >= xMin - 0.5 && d.t <= xMax; })
      .map(function (d) { return { x: d.t, color: '#dbe4ec' }; });
    if (rel.nowRel >= xMin - 0.5 && rel.nowRel <= xMax) vlines.push({ x: rel.nowRel, color: '#b45309', dash: '4 4' });
    /* Projected continuation dose(s): NOT entered by the clinician — the
     * regimen is assumed to continue at the patient's own historical dose and
     * interval, purely so the curve doesn't wash out to zero past the last
     * real dose. Dotted and lighter than both a real "Dose" line and "Today",
     * so it cannot be mistaken for either. */
    if (fit.chartProjectedDoses && fit.chartProjectedDoses.length) {
      fit.chartProjectedDoses.forEach(function (d) {
        if (d.t >= xMin - 0.5 && d.t <= xMax) vlines.push({ x: d.t, color: 'rgba(180,83,9,.55)', dash: '2 3' });
      });
      // Short labels: the 68-character v0.40.0 label ran off a phone-width
      // chart (review C3). The regimen detail is in the caption below.
      legend.push({ label: fit.planned ? 'Planned dose' : 'Projected dose (not entered)',
        color: 'rgba(180,83,9,.55)', swatch: 'line', dash: '2 3' });
    }

    var cfg = {
      compact: compact,
      xMin: xMin, xMax: xMax, yMax: yMax, yMin: yMin, logY: logY,
      futureFrom: rel.nowRel,
      xLabel: rel.ssMode ? 'Days since latest dose (day 0)' : 'Days since first dose',
      yLabel: 'Concentration (µg/mL)' + (logY ? ', log scale' : ''),
      bands: bands,
      hlines: [{ y: state.target.value, color: '#d97706', width: 2, dash: '8 5', label: 'Target trough ' + targetLabel() }],
      vlines: vlines,
      series: series,
      points: obsPts,
      legend: legend,
      hover: { times: grid, rows: rows },
      hoverDate: function (t) { return fmtDate(rel.t0ms + t * DAY); },
      /* Text alternative built from the actual forecast, so a screen-reader
       * user gets the same headline numbers a sighted user reads off the plot. */
      title: M.drug().label + ' concentration–time forecast',
      desc: (function () {
        var f = state.fit;
        var parts = [M.drug().label + ' predicted concentration over time.'];
        parts.push(f && f.hasObs
          ? 'Individualised from ' + (f.obsData ? f.obsData.length : 0) + ' measured concentration(s).'
          : 'Population forecast. No measurements fitted yet.');
        var up = f && f.troughs ? f.troughs.filter(function (tr) { return tr.t > rel.nowRel - 0.02; }) : [];
        if (up.length) {
          var n = up[0];
          parts.push('Next trough on day ' + fmtC(n.t) + ': median ' + fmtC(n.med) +
            ' µg/mL, 90% credible interval ' + fmtC(n.p5) + ' to ' + fmtC(n.p95) +
            ' µg/mL, probability above the ' + state.target.value + ' µg/mL target ' +
            Math.round(n.pTarget * 100) + '%.');
        }
        parts.push('All predicted troughs are listed in the table below this chart.');
        return parts.join(' ');
      })()
    };
    var obsLookup = rel.obsRel.filter(plottable)
      .map(function (o) { return { x: o.t, y: o.c }; });
    var hoverObs = grid.map(function (t) {
      var best = null, bd = Infinity;
      for (var i = 0; i < obsLookup.length; i++) {
        var d0 = Math.abs(obsLookup[i].x - t);
        if (d0 < bd) { bd = d0; best = obsLookup[i].y; }
      }
      return bd < 0.02 ? best : NaN;
    });
    rows[rows.length - 1].values = hoverObs;

    C.render(host, cfg);
    if (!hostOverride && $('chartCaption')) $('chartCaption').textContent = chartCaption(fit);
    if (fitUnreliable(fit)) {
      host.insertAdjacentHTML('afterbegin', noteHtml('<b>Not reliable:</b> this fit did not converge. The curve is shown only to help find the input problem.', 'bad'));
    }
  }

  /* Review C5: the caption describes what this chart actually draws. It used
   * to be fixed text explaining a population band that is not drawn once an
   * individual fit exists, and a projection that is not always there. */
  function chartCaption(fit) {
    var parts = [fit.hasObs
      ? 'Shaded band = 5–95% range of the individual prediction, which uses this patient\u2019s measured levels'
      : 'Shaded band = 5–95% range of the population prediction (model only, no measured levels yet)'];
    if (fit.hasObs) parts.push('red points = measurements');
    parts.push('dashed amber line = target');
    if (fit.chartProjectedDoses && fit.chartProjectedDoses.length) {
      parts.push(fit.planned
        ? 'faint dotted amber = planned doses (entered regimen: ' + fmtC(fit.planned.amt) + ' mg q' + fmtDays(fit.planned.interval) + 'd), not yet given'
        : 'faint dotted amber = projected doses, not entered (assumed q' + fmtDays(fit.interval) + 'd from the entered history; fill in the planned regimen to change this)');
    }
    return parts.join(' · ') + '.';
  }

  // ------------------------- results panels -------------------------------
  function renderResults() {
    var fit = state.fit;
    var s = $('fitStatus'), pb = $('paramBlock'), tb = $('troughBlock'), ab = $('advisoryBlock');
    if (!fit) {
      pb.innerHTML = tb.innerHTML = ab.innerHTML = '';
      return;
    }
    var rel = fit.rel;
    var meta = fit.hasObs
      ? '<b>Individualized</b> to this patient\u2019s ' + rel.obsRel.length + ' measured concentration' + (rel.obsRel.length === 1 ? '' : 's') + '.'
      : '<b>Population forecast.</b> No samples fitted yet. Add measurements and run again to individualize.';

    var pm = fit.map;
    var html = '<div class="result-meta">' + meta + '</div>';
    if (fit.hasObs) {
      var cl = fit.clQ, v1 = fit.v1Q;
      var hl = halfLifeInfo(fit);
      html += '<div class="kv">' +
        '<span class="k">Clearance CL (L/day)</span><span class="v">' + fmtC(cl.med) +
        ' <span class="ci-range">[' + fmtC(cl.p5) + '–' + fmtC(cl.p95) + ']</span></span>' +
        '<span class="k">Central volume V1 (L)</span><span class="v">' + fmtC(v1.med) +
        ' <span class="ci-range">[' + fmtC(v1.p5) + '–' + fmtC(v1.p95) + ']</span></span>' +
        '<span class="k">Terminal t½ (days)' + (hl && hl.nonlinear ? ' at ' + hl.concText + ' µg/mL' : '') + '</span><span class="v">' +
        (hl ? hl.med.toFixed(1) + ' <span class="ci-range">[' + hl.p5.toFixed(1) + '–' + hl.p95.toFixed(1) + ']</span>' : '–') + '</span>' +
        (hl && hl.nonlinear
          ? '<span class="k">Saturable elimination (fixed)</span><span class="v">Vmax ' + fmtC(hl.vmax) + ' mg/day, Km ' + fmtC(hl.km) + ' µg/mL</span>'
          : '') +
        '<span class="k">' + etaLabel(pm) + ' (MAP)</span><span class="v">' + fmtEtaVec(pm) + '</span>' +
        '</div>';
      html += infoBars(fit);
      // v0.15.0: diagnostics (GOF residuals + EBE forest) moved from an inline
      // <details> to a modal (openDiagnostics), reusing the About/Report
      // modal pattern — a small button here, next to the parameters that
      // depend on this fit, keeps the hint visible without opening anything.
      if (D && fit.obsData && fit.obsData.length) {
        var hint = D.summaryHint(fit);
        html += '<button type="button" class="linklike diag-open" id="btnDiagnostics">Fit diagnostics' +
          (hint ? ' <span class="diag-hint ' + (hint === 'good' ? 'ok' : hint === 'warn' ? 'warn' : 'bad') + '">' + hint + '</span>' : '') +
          ' ›</button>';
      }
      html += '<details class="help"><summary>How this was calculated</summary><ul>' +
        '<li><b>Best-fit (MAP) parameters:</b> clearance ' + fmtC(cl.med) + ' L/day [5–95% ' + fmtC(cl.p5) + '–' + fmtC(cl.p95) +
        '], central volume ' + fmtC(v1.med) + ' L [' + fmtC(v1.p5) + '–' + fmtC(v1.p95) + '].</li>' +
        '<li><b>Terminal half-life:</b> ' + (hl ? halfLifeText(hl) : '–') + '. This is the slow phase of the two-compartment model, ' +
        'the rate at which levels fall once distribution is complete' +
        (hl && hl.nonlinear
          ? '. Eculizumab also has saturable (target-mediated) elimination with fixed model values Vmax ' + fmtC(hl.vmax) +
            ' mg/day (scaled to this weight) and Km ' + fmtC(hl.km) + ' µg/mL, which speeds up elimination at low concentrations; ' +
            'the figure therefore holds at the predicted trough of ' + hl.concText + ' µg/mL, where total clearance is ' + fmtC(hl.clTotal) +
            ' L/day, and is shorter below it. The clearance shown above is the linear part only'
          : '') + '.</li>' +
        '<li><b>Individual shifts from the typical patient (η):</b> ' + fmtEtaVec(pm) + '.</li>' +
        '<li><b>Sampling precision:</b> ' + precisionWord(fit) + ' (' + fit.nDraws + ' posterior draws, ' +
        essText(fit) + ', acceptance ' + (fit.acceptance ? fit.acceptance.toFixed(2) : '–') + ').</li>' +
        '</ul></details>';
    } else {
      var ts = M.drug().THETA;
      html += '<div class="kv">' +
        '<span class="k">Typical CL (L/day)</span><span class="v">' + fmtC(ts.CL) + '</span>' +
        '<span class="k">Typical V1 (L)</span><span class="v">' + fmtC(ts.V1) + '</span>' +
        (ts.VMAX > 0
          ? '<span class="k">Vmax (mg/day), Km (µg/mL)</span><span class="v">' + ts.VMAX + ', ' + ts.KM + '</span>'
          : '<span class="k">V2 (L), Q (L/day)</span><span class="v">' + fmtC(ts.V2) + ', ' + fmtC(ts.Q) + '</span>') +
        '</div>';
    }
    pb.innerHTML = html;
    var diagBtn = document.getElementById('btnDiagnostics');
    if (diagBtn) diagBtn.addEventListener('click', function () { openDiagnostics(fit, rel); });
    showIntervalCard();

    // troughs
    var thr = '';
    if (fit.troughs.length) {
      // responsive-cards + data-label: see the note on intervalScanTableHtml
      // — below the phone breakpoint this becomes label:value cards via CSS
      // alone, no second markup path. Also newly wrapped in .tbl-wrap
      // (found unwrapped, like the regimen-explorer table, while scoping the
      // responsive work — neither table had a scroll fallback before this).
      thr = '<div class="tbl-wrap"><table class="data responsive-cards"><thead><tr>' +
        '<th title="' + (rel.ssMode ? 'Day of treatment, where day 0 = the latest dose of the steady-state regimen (negative days = preceding cycles)' : 'Day of treatment since the first dose') + '">Day</th>' +
        '<th title="Calendar date of the trough">Date</th>' +
        '<th class="num" title="Median and 5th–95% range of the true (latent) trough concentration">Median trough [5–95%]</th>' +
        '<th class="num" title="Probability that the true trough stays above the target, given the fitted posterior for this patient. Assay error is not included: a measured level can differ">P(true trough &gt; ' + state.target.value + ' <span class="unit">µg/mL</span>)</th></tr></thead><tbody>';
      fit.troughs.forEach(function (tr) {
        var future = tr.t > rel.nowRel - 0.02;
        thr += '<tr class="' + (future ? '' : 'past') + (tr.assumed ? ' assumed' : '') + '">' +
          '<td data-label="Day">' + fmtDays(tr.t) + '</td>' +
          '<td data-label="Date">' + troughDate(rel, tr.t) +
          (tr.assumed ? (fit.planned
            ? ' <span class="tag-assumed" title="Next dose of the planned regimen you entered (' + fmtC(fit.planned.amt) + ' mg q' +
              fmtDays(fit.planned.interval) + 'd), not yet given.">planned dose</span>'
            : ' <span class="tag-assumed" title="No dose was entered at this time. The app assumed the next administration falls one interval (q' +
              fmtDays(fit.interval) + ' d) after the last entered dose.">assumed dose</span>') : '') + '</td>' +
          '<td class="num" data-label="Median trough">' + fmtC(tr.med) + ' <span class="ci-range">[' + fmtC(tr.p5) + '–' + fmtC(tr.p95) + ']</span></td>' +
          '<td class="num" data-label="P(&gt; target)">' + ptaBadge(tr.pTarget, tr.pCI) + '</td>' +
          '</tr>';
      });
      thr += '</tbody></table></div>';
      thr += '<div class="legend-note">Trough just before each dose · median [5–95%] is a <b>credible interval for the true concentration</b> (it does not include assay error, so a future measured value may fall outside it) · P = chance the true trough exceeds ' + state.target.value + ' µg/mL (hover a badge for details).</div>';
      // F9 (independent audit, 2026-09-13): the interval-narrowness caveat
      // now lives here too, not just in the findings paragraph — this is the
      // table a consultant actually reads before advising on the next dose.
      if (M.drug().IOV_DISEASES.indexOf(fit.disease) >= 0) {
        thr += '<div class="legend-note">' + esc(fit.disease) + ': between-occasion variability is folded into the prior, so the interval above for the next dose is somewhat narrower than the full occasion-to-occasion uncertainty.</div>';
      }
      if (fit.troughs.some(function (tr) { return tr.assumed; })) {
        thr += fit.planned
          ? '<div class="legend-note">The row marked <b>planned dose</b> is the next administration of the planned regimen you entered (' +
            fmtC(fit.planned.amt) + ' mg q' + fmtDays(fit.planned.interval) + 'd), not yet given.</div>'
          : '<div class="legend-note">The row marked <b>assumed dose</b> projects one interval (q' + fmtDays(fit.interval) +
            ' d, taken from the entered history) after the last entered dose. To model a different regimen, fill in the planned regimen below the dose form.</div>';
      }
    } else {
      thr = '<div class="note">Add planned doses to see predicted troughs.</div>';
    }
    tb.innerHTML = thr;

    // advisories
    var ad = [];
    var upcoming = fit.troughs.filter(function (tr) { return tr.t > rel.nowRel - 0.02; });
    if (upcoming.some(function (tr) { return tr.pTarget < 0.9; })) {
      ad.push(noteHtml('The target is not predicted to be reached with ≥ 90% probability at one or more upcoming doses.', 'warn'));
    }
    if (M.drug().IOV_DISEASES.indexOf(fit.disease) >= 0) {
      ad.push(noteHtml(fit.disease + ': clearance varies between occasions, so predictions are more uncertain; re-sample around flares or regimen changes.', 'warn'));
    }
    /* F7 (independent audit, 2026-09-13): the chart's projected-dose
     * continuation is already suppressed by the engine during a loading
     * phase (see fit.loadingPhase in runFit); this says why, since a
     * silently absent projection is easy to misread as "the app forgot,"
     * not "the app knows this interval isn't the maintenance one yet." */
    if (fit.loadingPhase && !fit.planned) {
      ad.push(noteHtml(M.drug().label + '’s loading regimen is not finished. The forecast is not projected past the last entered dose and no ' +
        'next-dose trough is assumed, because the interval so far is the loading schedule’s, not the eventual maintenance interval. ' +
        'Enter the planned regimen below the dose form to see them, or add the maintenance doses as they are given.', 'warn'));
    } else if (fit.spacingUnsettled && !fit.planned) {
      /* v0.45.0 (review S1): the last two spacings disagree -- an interval was just
       * changed -- so the app does not guess which one continues. */
      ad.push(noteHtml('The last two dosing intervals differ, so the app does not guess the next one: no next-dose trough is assumed and no ' +
        'doses are projected. Enter the planned regimen below the dose form to see them.', 'warn'));
    }
    /* F8 (independent audit, 2026-09-13): passive, non-blocking note (author's
     * choice) — informs without gating the workflow, same register as the
     * other advisories on this list. Under pediatricBlockAge the run is
     * refused outright (see runFit); this covers the age band that is
     * allowed to run but was never part of the model's own development. */
    if (fit.pediatricWarn) {
      ad.push(noteHtml(M.drug().label + ' was not developed for children. This forecast extrapolates the model beyond the population it was built on.', 'warn'));
    }
    /* Custom infusion times (2026-09-14, author-approved plan): a sample
     * drawn while a dose is still infusing is real, and — the concentration
     * may genuinely still be rising, or the draw may have picked up
     * contamination/dilution from the same line the infusion is running
     * through — either way it "may impact estimation" (the author's own
     * framing); passive note, same register as every other advisory here,
     * never a gate on the workflow. */
    if (fit.samplesDuringInfusion && fit.samplesDuringInfusion.length) {
      var infDates = fit.samplesDuringInfusion.map(function (s) {
        return fmtDate(rel.t0ms + s.obsT * DAY) + ' (' + fmtDur(minutesToDur(s.doseDurMin)) + ' infusion starting ' + fmtDate(rel.t0ms + s.doseT * DAY) + ')';
      });
      ad.push(noteHtml((fit.samplesDuringInfusion.length > 1 ? 'Samples' : 'A sample') + ' drawn during an infusion may not reflect a representative concentration and may impact estimation: ' +
        infDates.join('; ') + '.', 'warn'));
    }
    if (state.lloq > 0) {
      ad.push(noteHtml('Below-LLOQ samples handled with the M3 method (LLOQ = ' + esc(String(state.lloq)) + ' µg/mL).', ''));
    }
    /* Recency weighting changes what the fit is based on, so it must never be
     * silent: say which samples were discounted and by how much. */
    if (fit.recencyMaxMult > 1) {
      var disc = (fit.obsData || []).filter(function (o) { return !o.exclude && o.recencyWeight < 0.995; });
      ad.push(noteHtml('Older samples down-weighted (' + esc(fit.recency) + ', residual error up to ×' +
        fit.recencyMaxMult + '): ' +
        (disc.length ? disc.length + ' of ' + (fit.obsData || []).length + ' measurement' +
          ((fit.obsData || []).length > 1 ? 's' : '') + ' carry a larger residual error, the oldest at ' +
          Math.round(100 * Math.min.apply(null, disc.map(function (o) { return o.recencyWeight; }))) +
          '% of its normal weight'
          : 'no sample is old enough to be affected') + '.', 'info'));
    }
    /* v0.13.0 diagnostics that must not stay silent: an excluded sample changes
     * what the fit is based on, and a non-converged optimiser or unmixed chain
     * means the individual estimate itself may be wrong. */
    if (fit.nExcluded > 0) {
      ad.push(noteHtml(fit.nExcluded + ' sample' + (fit.nExcluded > 1 ? 's are' : ' is') +
        ' excluded from the fit; shown on the chart and in the report, but not used to estimate this patient\'s parameters.', 'info'));
    }
    if (fit.map && fit.map.startGap > 1) {
      ad.push(noteHtml('The parameter search reached different solutions from different starting points (objective-function gap ' +
        fmtC(fit.map.startGap) + '). The samples may not identify this patient uniquely; an additional sample at a different time would help.', 'warn'));
    }
    if (fit.rhat && fit.rhat.length) {
      var badR = [];
      var rnames = (fit.map && fit.map.etaNames) || [];
      for (var ri = 0; ri < fit.rhat.length; ri++) {
        if (fit.rhat[ri] != null && fit.rhat[ri] > 1.05) badR.push(rnames[ri] || ('eta' + (ri + 1)));
      }
      if (badR.length) {
        ad.push(noteHtml('The posterior sampler did not fully mix for ' + esc(badR.join(', ')) +
          ' (R-hat > 1.05). The reported intervals for those parameters may be unreliable; add a sample, or check the entered doses and times.', 'warn'));
      }
    }
    if (!state.obs.length) {
      ad.push(noteHtml('Add measured concentrations to individualize the forecast.', 'info'));
    }
    // v0.9.1 identifiability diagnostics: which etas did the samples actually
    // inform? Shrinkage ≈ 0 means the posterior stayed on the population prior
    // for that parameter — the honest response when SC troughs cannot separate
    // e.g. absorption from clearance. Surface a gentle sampling hint, not a
    // warning: the forecast is still valid, just prior-anchored.
    if (fit.hasObs && fit.etaInformation && fit.map && fit.map.etaNames) {
      var names = fit.map.etaNames;
      var weak = [];
      for (var ei = 0; ei < fit.etaInformation.length; ei++) {
        if (fit.etaInformation[ei] < 0.3 && ei < names.length) weak.push(names[ei]);
      }
      if (weak.length) {
        var weakTxt = weak.length === 1 ? weak[0] : weak.join(', ').replace(/, ([^,]*)$/, ' and $1');
        ad.push(noteHtml('Samples did not yet inform ' + weakTxt + '; a peak sample alongside the trough sharpens the forecast.', 'info'));
      }
    }
    ab.innerHTML = ad.join('');
    if (fitUnreliable(fit)) {
      s.innerHTML = noteHtml('<b>Not reliable.</b> The parameter search did not converge, so this fit is not a usable estimate for this patient. ' +
        'The trough predictions, probabilities, parameters and regimen explorer are withheld, and the report cannot be printed. ' +
        'The curve is shown only to help find the problem: check the entered doses, amounts and sample times (and the unit of the levels), then run the forecast again.', 'bad') + s.innerHTML;
      pb.innerHTML = '';
      tb.innerHTML = noteHtml('Trough predictions withheld: the last forecast did not converge.', 'warn');
    }
  }

  /* v0.10.0 — diagnostics rendering: GOF scatter (SVG via chart.js) inside the
   * details block + hover sync between scatter points and residual rows. */
  /* v0.15.0 — diagnostics moved from an inline <details> to a modal, opened
   * from the button rendered next to the individual parameters. The content
   * is built lazily here (not on every fit render) since it's only needed if
   * the clinician actually opens it. */
  /* The fit/rel the diagnostics modal is currently showing, if it's open —
   * so a window resize can re-render it with the SAME data it was opened
   * with, not whatever state.fit happens to be at that later moment. */
  var diagOpenFit = null, diagOpenRel = null;

  function openDiagnostics(fit, rel) {
    var D = ECU.diagnostics;
    if (!D || !fit || !fit.obsData || !fit.obsData.length) return;
    $('diagModalBody').innerHTML =
      '<h4 class="diag-h">Observed vs individual prediction</h4>' +
      '<div class="diag-gof">' + D.gofPanel(fit, M.drug(), function (t) { return fmtDate(rel.t0ms + t * DAY); }, 'diagModalGof') + '</div>' +
      '<h4 class="diag-h">This patient vs the population (EBEs)</h4>' +
      '<div class="diag-ebe">' + D.ebePanel(fit, M.drug()) + '</div>';
    openModal('diagModal', 'diagClose');
    diagOpenFit = fit; diagOpenRel = rel;
    renderDiagnostics(fit, rel, 'diagModalGof', 'diagModalBody');
  }

  /* forceCompact: print always passes false explicitly, so the report's own
   * diagnostics chart is never affected by whatever width the clinician's
   * window happens to be at print time (the report is a fixed A4 document,
   * not a live view). Omitted, it auto-detects from the host's own width —
   * used only by the live modal, whose width is genuinely worth adapting to. */
  function renderDiagnostics(fit, rel, hostId, rowsContainerId, forceCompact) {
    var host = document.getElementById(hostId || 'gofChart');
    if (!host) return;
    var D = ECU.diagnostics;
    var cfg = D.gofChart(fit, M.drug());
    if (cfg) {
      var compact = forceCompact != null ? forceCompact : isCompactWidth(host.clientWidth);
      cfg.compact = compact;
      if (!compact) { cfg.width = 560; cfg.height = 400; }
      C.render(host, cfg);
      // hover sync: point <-> residual row. The container id is a parameter
      // (not hardcoded) so this works whether the residual rows live in the
      // diagnostics modal or, in principle, anywhere else — a hardcoded
      // '#diagBlock' here would silently stop finding any rows the moment
      // that id moved (as it did in v0.15.0, diagBlock -> the modal).
      var svg = host.querySelector('svg');
      var pts = host.querySelectorAll('.gof-pt');
      var rows = document.querySelectorAll('#' + (rowsContainerId || 'diagBlock') + ' .res-row');
      function highlight(idx, on) {
        rows.forEach(function (r) {
          if (r.getAttribute('data-obs-idx') === String(idx)) r.classList.toggle('hl', on);
        });
        pts.forEach(function (p) {
          if (p.getAttribute('data') === String(idx)) p.setAttribute('r', on ? '6.2' : '4.4');
        });
      }
      pts.forEach(function (p, i) {
        var idx = i; // points array order == obsData order (filtered, but gofChart keeps order)
        p.style.cursor = 'pointer';
        p.addEventListener('mouseenter', function () { highlight(idx, true); });
        p.addEventListener('mouseleave', function () { highlight(idx, false); });
      });
      rows.forEach(function (r) {
        var idx = r.getAttribute('data-obs-idx');
        r.addEventListener('mouseenter', function () { highlight(idx, true); });
        r.addEventListener('mouseleave', function () { highlight(idx, false); });
      });
    }
  }

  // ----------------------------- editors ----------------------------------
  function renderDoses() {
    var tb = $('doseTable');
    syncDoseDurVisibility();   // v0.45.0: Auto moves from the first route to the later one after dose 1
    if (currentMode() === 'ss') {
      tb.innerHTML = '<tr><td class="empty-cell">Regimen defined above (fixed dose + interval at steady state). Switch to “Full schedule” to see and edit individual doses.</td></tr>';
      return;
    }
    state.doses.sort(function (a, b) { return a.t - b.t; });
    if (!state.doses.length) {
      tb.innerHTML = '<tr><td class="empty-cell">No doses entered yet. Add the actual dose dates and amounts below.</td></tr>';
      return;
    }
    var t0 = state.doses[0].t;
    var now = Date.now();
    var ar = M.drug().adminRoutes;
    var showRoute = !!(ar && ar.first && ar.subsequent && ar.first !== ar.subsequent);
    // Custom infusion times (2026-09-14): conditional, same convention as
    // Route above — a session where nobody touched this stays exactly as
    // light as before the feature existed; the column appears only once
    // someone actually sets a custom duration on at least one dose.
    var showDur = state.doses.some(function (d) { return d.dur != null; });
    var h = '<thead><tr><th>Day</th><th>Date &amp; time</th><th class="num">Dose (mg)</th>' +
      (showRoute ? '<th title="Administration route (the first dose is IV, all later doses are subcutaneous)">Route</th>' : '') +
      (showDur ? '<th title="Infusion duration, where set to something other than the drug’s own default">Duration</th>' : '') +
      '<th></th></tr></thead><tbody>';
    state.doses.forEach(function (d, i) {
      var relDay = ((d.t - t0) / DAY);
      var routeCell = showRoute
        ? '<td>' + (d.route === 'sc' ? 'SC' : 'IV') + '</td>'
        : '';
      var durCell = showDur
        ? '<td>' + (d.dur != null && d.route !== 'sc' ? fmtDur(d.dur) : (d.route === 'sc' ? '–' : fmtDur(M.drug().INFUSION_D) + ' (default)')) + '</td>'
        : '';
      h += '<tr class="' + (d.t < now ? 'past' : '') + '"><td>' + fmtC(relDay) + '</td><td>' + fmtDate(d.t) + '</td>' +
        '<td class="num"><b>' + esc(String(d.amt)) + '</b></td>' + routeCell + durCell +
        '<td class="num"><button class="linklike" data-rmdose="' + i + '" title="Remove this dose">remove</button></td></tr>';
    });
    h += '</tbody>';
    tb.innerHTML = h;
    Array.prototype.forEach.call(tb.querySelectorAll('[data-rmdose]'), function (el) {
      el.addEventListener('click', function () {
        state.doses.splice(parseInt(el.getAttribute('data-rmdose'), 10), 1);
        renderDoses(); markStale();
      });
    });
  }

  function renderObs() {
    var tb = $('obsTable');
    if (!state.obs.length) {
      tb.innerHTML = '<tr><td class="empty-cell">No measurements yet.</td></tr>';
      return;
    }
    // v0.46.0 (review U6): chronological, as the dose table is (entry order hid an out-of-order date)
    state.obs.sort(function (a, b) { return a.t - b.t; });
    var t0 = null;
    if (currentMode() === 'ss') {
      var ss0 = readSS(false);
      if (ss0) t0 = ss0.A;
    }
    if (t0 == null) t0 = state.doses.length ? state.doses[0].t : (state.obs[0].t);
    var h = '<thead><tr><th>Day</th><th>Date &amp; time</th><th class="num">Conc (<span class="unit">µg/mL</span>)</th>' +
      '<th class="num">In fit</th><th></th></tr></thead><tbody>';
    state.obs.forEach(function (o, i) {
      var concCell = o.lloq
        ? '&lt; ' + esc(String(state.lloq || 'LLOQ'))
        : '<b>' + fmtC(o.c) + '</b>';
      h += '<tr' + (o.exclude ? ' class="obs-ex"' : '') + '><td>' + fmtC((o.t - t0) / DAY) + '</td><td>' + fmtDate(o.t) + '</td>' +
        '<td class="num">' + concCell + '</td>' +
        '<td class="num"><label class="check" style="margin:0;justify-content:flex-end" ' +
        'title="Untick to keep this sample on record but exclude it from the fit, e.g. drawn after plasma exchange, apheresis or CRRT, or with a known pre-analytical problem">' +
        '<input type="checkbox" data-fitobs="' + i + '"' + (o.exclude ? '' : ' checked') + '></label></td>' +
        '<td class="num"><button class="linklike" data-rmobs="' + i + '" title="Remove this measurement">remove</button></td></tr>';
      if (o.exclude) {
        h += '<tr class="obs-ex"><td colspan="5" style="padding-top:0">' +
          '<input type="text" class="obs-note" data-noteobs="' + i + '" maxlength="80" ' +
          'placeholder="Reason this sample is excluded (shown in the report)" value="' + esc(o.note || '') + '"></td></tr>';
      }
    });
    h += '</tbody>';
    tb.innerHTML = h;
    Array.prototype.forEach.call(tb.querySelectorAll('[data-rmobs]'), function (el) {
      el.addEventListener('click', function () {
        state.obs.splice(parseInt(el.getAttribute('data-rmobs'), 10), 1);
        renderObs(); markStale();
      });
    });
    /* v0.13.0 — excluding rather than deleting keeps the sample visible on the
     * chart and in the printed report while removing it from the likelihood.
     * Deleting it would lose the record of why it was disregarded. */
    Array.prototype.forEach.call(tb.querySelectorAll('[data-fitobs]'), function (el) {
      el.addEventListener('change', function () {
        var idx = parseInt(el.getAttribute('data-fitobs'), 10);
        state.obs[idx].exclude = !el.checked;
        renderObs(); markStale(); saveSession();
      });
    });
    Array.prototype.forEach.call(tb.querySelectorAll('[data-noteobs]'), function (el) {
      el.addEventListener('input', function () {
        state.obs[parseInt(el.getAttribute('data-noteobs'), 10)].note = el.value;
        saveSession();
      });
    });
  }

  // --------------------------- persistence --------------------------------
  function exportJson() {
    var ss = currentMode() === 'ss' ? readSS(false) : null;
    var data = {
      app: 'mab-tdm', version: VERSION, savedAt: new Date().toISOString(),
      patient: state.patient, drug: state.drug, target: state.target, lloq: state.lloq, errMult: state.errMult,
      recency: state.recency,
      report: { preparedBy: state.report.preparedBy, advice: state.report.advice },
      plan: readPlanRaw(), priorTx: readPrior(),
      mode: currentMode(),
      /* Custom infusion times (2026-09-14): both the SS scalar and each
       * full-schedule dose's own .dur must survive export/import, or a
       * custom duration silently vanishes the moment a session is saved and
       * reopened -- exactly the class of boundary this feature already had
       * to fix once for relContext()/relContextSS(). */
      ss: ss ? { dose: ss.D, interval: ss.I, anchor: new Date(ss.A).toISOString(),
        dur: (!M.drug().adminRoutes && $('ss-dur') && $('ss-dur').value.trim() !== '') ? parseFloat($('ss-dur').value) : null } : null,
      doses: state.doses.map(function (d) { return { t: new Date(d.t).toISOString(), amt: d.amt, route: d.route, dur: d.dur != null ? d.dur : null }; }),
      obs: state.obs.map(function (o) { return { t: new Date(o.t).toISOString(), c: o.c, lloq: o.lloq, exclude: !!o.exclude, note: o.note || '' }; })
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'complementtdm-session.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* v0.44.0 (review H1, H2) -- the ONE gate every stored session passes through,
   * whether it comes from an imported file or from the autosave in localStorage.
   * A session is data someone else may have written (colleagues e-mail these
   * files), so nothing in it is trusted to be the type its field name suggests:
   *   - a dose amount of "900<img onerror=...>" used to reach innerHTML and run;
   *   - a date that does not parse became NaN, and a NaN dose time sent the
   *     engine into an infinite loop that froze the tab.
   * Every number is coerced and must be finite, every route must be a known
   * one, every date must parse; anything else refuses the whole file with a
   * message naming the entry. Free text (notes, names) is kept verbatim: it is
   * escaped where it is written out, not stripped here. Pure function, no DOM. */
  function cleanSession(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.doses)) throw new Error('not a session file');
    function num(v) {
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '') return Number(v);
      return NaN;
    }
    function when(v) {
      if (typeof v === 'number') return v;                      // autosave stores epoch-ms
      if (typeof v === 'string' && v.trim() !== '') return Date.parse(v);
      return NaN;
    }
    function optNum(v, what, minExclusive) {
      if (v == null || v === '') return null;
      var n = num(v);
      if (!isFinite(n) || (minExclusive != null && !(n > minExclusive))) throw new Error(what + ' is not a valid number');
      return n;
    }
    var out = {};
    var drugId = (data.drug && M.drugs[data.drug] && !M.drugs[data.drug].pending) ? data.drug : 'eculizumab';
    out.drug = drugId;

    var p = (data.patient && typeof data.patient === 'object') ? data.patient : {};
    out.patient = {
      code: typeof p.code === 'string' ? p.code : '',
      wt: optNum(p.wt, 'the patient weight', 0),
      age: optNum(p.age, 'the patient age', 0),
      disease: p.disease === 'aHUS' ? 'aHUS' : 'PNH'
    };
    var tv = data.target && typeof data.target === 'object' ? data.target.value : null;
    out.target = { value: optNum(tv, 'the trough target', 0) };
    out.lloq = optNum(data.lloq, 'the LLOQ', -1e-12);
    var em = num(data.errMult);
    out.errMult = isFinite(em) && em >= 0.1 && em <= 10 ? em : 1;
    out.recency = RECENCY_PRESETS.indexOf(data.recency) >= 0 ? data.recency : 'off';
    out.report = {
      preparedBy: data.report && typeof data.report.preparedBy === 'string' ? data.report.preparedBy : '',
      advice: data.report && typeof data.report.advice === 'string' ? data.report.advice : ''
    };

    out.doses = data.doses.map(function (d, i) {
      var n = i + 1;
      if (!d || typeof d !== 'object') throw new Error('dose ' + n + ' is not a valid entry');
      var t = when(d.t);
      if (!isFinite(t)) throw new Error('dose ' + n + ' has no valid date');
      var amt = num(d.amt);
      if (!(isFinite(amt) && amt > 0)) throw new Error('dose ' + n + ' has no valid amount');
      var route = (d.route == null || d.route === '') ? null : d.route;
      if (route !== null && route !== 'iv' && route !== 'sc') throw new Error('dose ' + n + ' has an unknown route');
      var o = { t: t, amt: amt, route: route };
      if (d.dur != null) {
        var du = num(d.dur);
        if (!(isFinite(du) && du > 0)) throw new Error('dose ' + n + ' has an invalid infusion duration');
        o.dur = du;
      }
      return o;
    });
    if (data.obs != null && !Array.isArray(data.obs)) throw new Error('the measurement list is not a list');
    out.obs = (data.obs || []).map(function (o, i) {
      var n = i + 1;
      if (!o || typeof o !== 'object') throw new Error('sample ' + n + ' is not a valid entry');
      var t = when(o.t);
      if (!isFinite(t)) throw new Error('sample ' + n + ' has no valid date');
      var lloq = !!o.lloq, c = null;
      if (o.c != null && o.c !== '') {
        c = num(o.c);
        if (!(isFinite(c) && c >= 0)) throw new Error('sample ' + n + ' has no valid concentration');
      } else if (!lloq) {
        throw new Error('sample ' + n + ' has no valid concentration');
      }
      return { t: t, c: c, lloq: lloq, exclude: !!o.exclude, note: typeof o.note === 'string' ? o.note : '' };
    });

    var pl = data.plan && typeof data.plan === 'object' ? data.plan : null;
    out.plan = pl ? { amt: isFinite(num(pl.amt)) ? num(pl.amt) : null, interval: isFinite(num(pl.interval)) ? num(pl.interval) : null } : null;
    out.priorTx = (data.priorTx === 'yes' || data.priorTx === 'no') ? data.priorTx : null;
    out.mode = data.mode === 'ss' ? 'ss' : 'full';
    out.ss = null;
    if (data.ss && typeof data.ss === 'object' && isFinite(when(data.ss.anchor))) {
      var sd = num(data.ss.dose), si = num(data.ss.interval), sdur = num(data.ss.dur);
      out.ss = { dose: isFinite(sd) ? sd : null, interval: isFinite(si) ? si : null,
        anchor: when(data.ss.anchor), dur: (isFinite(sdur) && sdur > 0) ? sdur : null };
    }
    return out;
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var c = cleanSession(JSON.parse(reader.result));
        var drug = c.drug;
        state.drug = drug;
        M.select(drug);
        $('pt-drug').value = drug;
        applyDrugUI();
        state.patient = c.patient;
        state.target = c.target;
        if (!(state.target.value > 0)) state.target.value = null;
        state.lloq = c.lloq;
        state.errMult = c.errMult;
        state.recency = c.recency;
        state.report = c.report;
        state.doses = c.doses;
        /* v0.40.0: exclude + note are exported, so they must be imported too --
         * dropping them put an excluded sample silently back into the fit. */
        state.obs = c.obs;
        // v0.40.0: form first, then setMode() -- see applySession() for why.
        setPlanFields(c.plan);
        setPrior(c.priorTx);
        syncInputs();
        if (c.mode === 'ss' && c.ss) {
          $('ss-dose').value = c.ss.dose != null ? c.ss.dose : 900;
          $('ss-interval').value = c.ss.interval != null ? c.ss.interval : 14;
          $('ss-anchor').value = toLocalInput(new Date(c.ss.anchor));
          if ($('ss-dur')) $('ss-dur').value = c.ss.dur != null ? c.ss.dur : '';
          setMode('ss');
        } else {
          setMode('full');
        }
        state.fit = null;
        markStale();
      } catch (e) {
        alert('Could not import session: ' + e.message);
      }
    };
    reader.readAsText(file);
  }

  function syncInputs() {
    $('pt-drug').value = state.drug;
    $('pt-code').value = state.patient.code;
    $('pt-wt').value = state.patient.wt != null ? state.patient.wt : '';
    if ($('pt-age')) $('pt-age').value = state.patient.age || '';
    $('pt-disease').value = state.patient.disease;
    $('pt-target').value = (state.target.value != null && state.target.value > 0)
      ? state.target.value : (M.drug().targetDefault || 75);
    updateTargetFold();
    $('pt-lloq').value = state.lloq || '';
    if ($('pt-errmult')) $('pt-errmult').value = state.errMult || 1;
    if ($('pt-recency')) $('pt-recency').value = state.recency || 'off';
    syncRecencyHint();
  }

  // ------------------------------ init ------------------------------------
  function wire() {
    var inputs = ['pt-code', 'pt-wt', 'pt-age', 'pt-disease', 'pt-target', 'pt-lloq', 'pt-errmult', 'plan-dose', 'plan-interval'];
    inputs.forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('input', function () {
        if (id === 'pt-target') updateTargetFold();
        if (id === 'pt-lloq') readPatient();
        markStale();
      });
    });
    /* The recency preset is a <select>: listen on 'change' (the codebase
     * distrusts 'input' for selects — pt-disease has its own change handler
     * for the same reason). markStale() is not optional here: it is the
     * sole autosave point AND the stale banner, so omitting it would both
     * lose the setting and leave a stale forecast looking current. */
    Array.prototype.forEach.call(document.querySelectorAll('input[name="priorTx"]'), function (r) {
      r.addEventListener('change', markStale);
    });
    var recSel = $('pt-recency');
    if (recSel) recSel.addEventListener('change', function () {
      readPatient();
      // the hint line quotes the chosen tau, so it is stale until refreshed
      syncRecencyHint();
      markStale();
    });
    $('btnRun').addEventListener('click', runFit);

    // log-scale y-axis: a view-only toggle — re-render immediately, no refit
    var logTgl = $('logY');
    if (logTgl) logTgl.addEventListener('change', function () { renderChart(); });

    $('tplClear').addEventListener('click', function () {
      if (!state.doses.length && !state.obs.length) return;
      // P4: non-blocking undo instead of a native confirm() dialog
      var oldDoses = state.doses, oldObs = state.obs, oldFit = state.fit, oldPrior = readPrior();
      state.doses = []; state.obs = []; state.fit = null;
      setPrior(null);
      renderDoses(); renderObs(); showEmpty();
      showToast('Removed all doses and measurements.', function () {
        state.doses = oldDoses; state.obs = oldObs; state.fit = oldFit;
        setPrior(oldPrior);
        renderDoses(); renderObs(); markStale();
      });
    });

    $('pt-drug').addEventListener('change', function () {
      var next = $('pt-drug').value;
      if (next === state.drug) return;
      var spec = M.drugs[next];
      if (!spec || spec.pending) {
        alert(spec ? spec.label + ' is prepared but its population PK parameters are not yet available.' : 'Unknown drug.');
        $('pt-drug').value = state.drug;
        return;
      }
      var hasData = state.doses.length > 0 || state.obs.length > 0 || state.fit != null;
      if (hasData && !confirm('Switch the PK model to ' + spec.label +
        '? Dosing history, measurements and the current forecast belong to the previous drug\'s model and will be cleared. Patient details are kept; the trough target is reset to the new drug\'s default of ' +
        (spec.targetDefault || 75) + ' µg/mL.')) {
        $('pt-drug').value = state.drug;
        return;
      }
      state.doses = []; state.obs = []; state.fit = null;
      state.drug = next;
      setPlanFields(null);   // a planned dose belongs to the previous drug
      setPrior(null);        // "treated before" was about the previous drug
      // applyDrugUI() below re-prefills the target with the new drug's default
      // P4: reset the hidden disease selector so a stale value cannot leak
      // back when the user switches to a drug where disease is a covariate
      state.patient.disease = 'PNH';
      M.select(next);
      applyDrugUI();
      syncInputs();
      renderDoses(); renderObs();
      showEmpty();
    });

      Array.prototype.forEach.call(document.querySelectorAll('input[name="schedMode"]'), function (r) {
      r.addEventListener('change', function () {
        if (currentMode() === 'ss') {
          // the anchor date is a workflow convenience (not patient data) and is
          // needed to render the steady-state window; dose and interval stay
          // empty so the clinician enters the regimen themselves
          if (!Date.parse($('ss-anchor').value)) $('ss-anchor').value = toLocalInput(new Date(at9(Date.now())));
        }
        setMode(currentMode());
      });
    });
    ['ss-dose', 'ss-interval', 'ss-dur'].forEach(function (id) {
      $(id).addEventListener('input', markStale);
    });
    $('ss-anchor').addEventListener('change', markStale);

    $('doseForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var t = Date.parse($('dose-dt').value);
      var amt = parseFloat($('dose-amt').value);
      var dl = M.drug().dose;
      if (!isFinite(t)) { alert('Enter a valid dose date & time.'); return; }
      if (!plausibleTime(t, 'dose')) return;
      if (!(amt >= dl.min && amt <= dl.max)) { alert('Dose must be between ' + dl.min + ' and ' + dl.max + ' mg for ' + M.drug().label + '.'); return; }
      // Non-blocking order-of-magnitude challenge: a transposed dose stays
      // inside the permitted range, so the range check alone will not catch it.
      if (state.doses.length) {
        var amts = state.doses.map(function (d) { return d.amt; }).sort(function (a, b) { return a - b; });
        var medD = amts[Math.floor(amts.length / 2)];
        if (medD > 0 && (amt > 3 * medD || amt < medD / 3)) {
          if (!confirm('This dose (' + amt + ' mg) differs about ' +
            (amt > medD ? Math.round(amt / medD) : Math.round(medD / amt)) +
            '-fold from the other doses in the schedule (' + medD + ' mg).\n\nAdd it anyway?')) return;
        }
      }
      var route = null;
      var ar = M.drug().adminRoutes;
      if (ar) {
        var rv = $('dose-route').value;
        route = resolveDoseRoute(M.drug(), rv, state.doses.length);
        // v0.45.0 (review U1): only the loading dose is IV; a later dose explicitly set to IV is almost always a slip
        if (rv === 'iv' && state.doses.length > 0 && ar.subsequent === 'sc' &&
          !confirm('Crovalimab is given IV only for the first (loading) dose; later doses are SC.\n\nAdd this dose as IV anyway?')) return;
      }
      /* Custom infusion times (2026-09-14, author-approved plan). SC has no
       * infusion-duration concept at all (M.simulate() never reads .dur for
       * an SC dose) -- the field is not read for one, regardless of whatever
       * stray value is sitting in it. Left blank -> dur stays unset -> the
       * engine falls back to the drug's own default (M.simulate()/buildGrid()
       * both already do this), so an untouched field is a true no-op. */
      var durMin = null;
      if (route !== 'sc') {
        var durRaw = $('dose-dur') ? $('dose-dur').value.trim() : '';
        if (durRaw !== '') {
          var im = M.drug().infusionMinutes || { min: 10, max: 360 };
          durMin = parseFloat(durRaw);
          if (!(durMin >= im.min && durMin <= im.max)) {
            alert('Infusion duration must be between ' + im.min + ' and ' + im.max + ' minutes.');
            return;
          }
        }
      }
      // Duplicate guard: two clicks on "Add dose" silently doubled the amount
      // v0.41.0: 24 h, not 5 min -- a dose entered twice by two people an hour
      // apart doubled the exposure in the fit without a question.
      var dup = isDuplicateDose(state.doses, t, route);   // v0.45.0: same route only (review U4)
      if (dup && !confirm('A dose is already recorded within 24 hours of that time.\n\nIs this really a second, separate dose?')) return;
      var doseObj = { t: t, amt: amt, route: route };
      if (durMin != null) doseObj.dur = minutesToDur(durMin);
      state.doses.push(doseObj);
      $('dose-amt').value = '';
      renderDoses(); markStale();
    });
    $('obsForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var t = Date.parse($('obs-dt').value);
      var cRaw = $('obs-val').value.trim();
      var c = parseFloat(cRaw);
      var below = $('obs-lloq').checked;
      if (!isFinite(t)) { alert('Enter a valid date & time for the measurement.'); return; }
      if (!plausibleTime(t, 'measurement')) return;
      // v0.41.0: a measured level cannot be from the future (a month typo was accepted silently)
      if (t > Date.now() + 5 * 60000 &&
        !confirm('That measurement is dated in the future (' + fmtDate(t) + '). A measured level cannot be from the future.\n\nIs the date correct?')) return;
      // A '< LLOQ' sample may be entered without a numeric value (only the flag
      // matters for the M3 likelihood); a quantified sample needs a value.
      if (!below && !(c >= 0)) { alert('Enter a valid concentration.'); return; }
      if (below && cRaw !== '' && !(c >= 0)) { alert('Enter a valid concentration, or leave the field empty for a below-LLOQ sample.'); return; }
      if (below && !(state.lloq > 0)) {
        /* The LLOQ lives in the collapsed "Assay settings" fold, directly below
         * the measurements table — one card away from this checkbox rather
         * than two, since v0.20.0 moved the assay controls out of the Forecast
         * card. Open that fold and focus the field instead of just refusing. */
        var advEl = $('assayOptions');
        if (advEl) { advEl.open = true; }
        var lq = $('pt-lloq');
        if (lq) { lq.focus(); }
        alert('A below-LLOQ sample needs the assay LLOQ. It is under “Assay settings”, just below the measurements (now opened for you).');
        return;
      }
      var minC = (M.drug().obsValMin || 0.01);
      var maxC = (M.drug().obsValMax || 10000);
      if (!below && c < minC) { alert('That concentration (' + c + ' µg/mL) is below the plausible range for ' + M.drug().label + ' (min ' + minC + ' µg/mL). Check for a decimal or unit error. The app expects µg/mL (= mg/L).'); return; }
      if (!below && c > maxC) { alert('That concentration (' + c + ' µg/mL) is above the plausible range for ' + M.drug().label + ' (max ' + maxC + ' µg/mL). Check for a decimal or unit error. The app expects µg/mL (= mg/L).'); return; }
      // v0.41.0: every sample, including the first (the fold check below needs
      // earlier samples, so a first 7000 µg/mL went in unchallenged).
      var typC = M.drug().obsTypicalMax;
      if (!below && typC && c > typC &&
        !confirm('That concentration (' + fmtC(c) + ' µg/mL) is unusually high for ' + M.drug().label + ' (above ' + typC +
          ' µg/mL). Check the unit: the app expects µg/mL (= mg/L).\n\nAdd it anyway?')) return;
      // Non-blocking order-of-magnitude challenge against the other samples:
      // a 10x transposition lands inside the permitted range in this field.
      if (!below && isFinite(c) && state.obs.length) {
        var prev = state.obs.filter(function (o) { return !o.lloq && isFinite(o.c) && o.c > 0; });
        if (prev.length) {
          var med = prev.map(function (o) { return o.c; }).sort(function (a, b) { return a - b; })[Math.floor(prev.length / 2)];
          if (med > 0 && (c > 8 * med || c < med / 8)) {
            if (!confirm('This measurement (' + fmtC(c) + ' µg/mL) differs about ' +
              (c > med ? Math.round(c / med) : Math.round(med / c)) + '-fold from the other samples (median ' +
              fmtC(med) + ' µg/mL).\n\nAdd it anyway?')) return;
          }
        }
      }
      state.obs.push({ t: t, c: below && cRaw === '' ? null : c, lloq: below, exclude: false, note: '' });
      $('obs-val').value = '';
      $('obs-lloq').checked = false;
      renderObs(); markStale();
    });

    var ivBtn = $('iv-run');
    if (ivBtn) ivBtn.addEventListener('click', function () { runIntervalScan(); });

    $('btnExport').addEventListener('click', exportJson);
    $('btnImport').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () { if (this.files[0]) importJson(this.files[0]); this.value = ''; });
    $('btnPrint').addEventListener('click', openReportDialog);

    // report dialog
    $('rp-generate').addEventListener('click', generateReport);
    $('rp-cancel').addEventListener('click', closeReportDialog);
    $('reportClose').addEventListener('click', closeReportDialog);
    $('reportModal').addEventListener('click', function (e) { if (e.target === $('reportModal')) closeReportDialog(); });

    // Getting started (real window; this wiring is only the popup-blocker fallback)
    $('btnGettingStarted').addEventListener('click', openGettingStarted);
    $('gettingStartedClose').addEventListener('click', closeGettingStarted);
    $('gettingStartedModal').addEventListener('click', function (e) { if (e.target === $('gettingStartedModal')) closeGettingStarted(); });

    // About modal
    $('btnAbout').addEventListener('click', openAbout);
    $('aboutClose').addEventListener('click', closeAbout);
    $('aboutModal').addEventListener('click', function (e) { if (e.target === $('aboutModal')) closeAbout(); });

    var closeDiag = function () { closeModal('diagModal'); diagOpenFit = null; diagOpenRel = null; };
    $('diagClose').addEventListener('click', closeDiag);
    $('diagModal').addEventListener('click', function (e) { if (e.target === $('diagModal')) closeDiag(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('gettingStartedModal').hidden) closeGettingStarted();
        if (!$('aboutModal').hidden) closeAbout();
        if (!$('reportModal').hidden) closeReportDialog();
        if (!$('diagModal').hidden) closeDiag();
        // the help popover closes (and re-syncs aria-expanded) in wireHelpPopovers' keydown handler
      }
    });
    var sd = $('stepperDismiss');
    if (sd) sd.addEventListener('click', function () {
      var el = $('stepper');
      if (el) el.classList.add('hidden');
    });
  }

  function init() {
    if (!document.getElementById('chart')) return;
    applyVersion();
    var next = at9(Date.now() + DAY);
    $('dose-dt').value = toLocalInput(new Date(next));
    $('obs-dt').value = toLocalInput(new Date(Date.now() + 30 * 60000));
    $('ss-anchor').value = toLocalInput(new Date(at9(Date.now())));
    wire();
    wireHelpPopovers();
    // A browser reload restores form values (e.g. the drug dropdown). Honour
    // the restored selection so the prefilled trough target and the visible
    // per-drug fields always match the drug actually shown.
    var sel = $('pt-drug');
    if (sel && M.drugs[sel.value]) { state.drug = sel.value; M.select(state.drug); }
    applyDrugUI();
    renderDoses();
    renderObs();
    showEmpty();
    offerRestore();
    // Warn before losing unsaved entry. Autosave makes this recoverable, but a
    // deliberate confirmation still prevents the most common data loss.
    window.addEventListener('beforeunload', function (e) {
      if (state.doses.length || state.obs.length) { e.preventDefault(); e.returnValue = ''; }
    });
    /* v0.17.0 — re-render the charts (not re-run the fit — these are pure
     * string builders over the fit's already-computed draws) when the window
     * is resized across the compact/desktop threshold, so rotating a tablet
     * or resizing a browser window doesn't leave a chart drawn for the wrong
     * width. Debounced: a drag-resize fires many times a second, and each
     * re-render is cheap but not free. Deliberately does not touch
     * state.stale — resizing after an edit must not silently clear a
     * staleness warning the clinician hasn't actually resolved by re-running
     * the fit (landmine flagged in the responsive plan). */
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.fit) renderChart();
        if (state.fit && state.fit.intervalScan) renderIntervalScan();
        if (!$('diagModal').hidden && diagOpenFit) {
          renderDiagnostics(diagOpenFit, diagOpenRel, 'diagModalGof', 'diagModalBody');
        }
      }, 180);
    });
  }

  /* Offer to restore an autosaved session rather than silently reinstating it:
   * silently loading another patient's data into a blank-looking form would be
   * far worse than losing it. */
  function offerRestore() {
    var s = loadSession();
    if (!s) return;
    var bar = document.getElementById('restoreBar');
    if (!bar) return;
    var when = fmtDate(s.savedAt || Date.now());
    var who = s.patient && s.patient.code ? ' (' + esc(s.patient.code) + ')' : '';
    /* A steady-state session with no measurements yet used to read as
     * "0 dose(s), 0 measurement(s)" -- accurate about state.doses (empty in
     * ss mode by construction) but useless to a clinician deciding whether
     * to restore it, since the actual thing worth restoring (the regimen)
     * went unmentioned entirely. */
    var whatParts = [];
    if (s.mode === 'ss' && s.ss && s.ss.dose > 0) {
      whatParts.push('a steady-state regimen (' + esc(String(s.ss.dose)) + ' mg q' + esc(String(s.ss.interval)) + 'd)');
    } else {
      whatParts.push(esc(String((s.doses || []).length)) + ' dose(s)');
    }
    whatParts.push(esc(String((s.obs || []).length)) + ' measurement(s)');
    document.getElementById('restoreText').innerHTML =
      'An unsaved session from ' + esc(when) + who + ' was found on this device, ' + whatParts.join(', ') + '.';
    bar.hidden = false;
    document.getElementById('restoreYes').onclick = function () {
      applySession(s); bar.hidden = true;
    };
    document.getElementById('restoreNo').onclick = function () {
      clearSession(); bar.hidden = true;
    };
  }

  function applySession(raw) {
    /* v0.44.0 (review H1/H2): the autosave goes through the same gate as an
     * imported file. A dose time that was NaN when saved is stored as null and
     * would otherwise hang the first forecast after "Restore". */
    var s;
    try { s = cleanSession(raw); }
    catch (e) {
      clearSession();
      alert('The autosaved session could not be restored (' + e.message + ') and was discarded.');
      return;
    }
    state.patient = s.patient;
    state.drug = s.drug;
    state.lloq = s.lloq;
    state.errMult = s.errMult;
    /* absent in sessions saved before v0.20.0 — cleanSession defaults it, never undefined */
    state.recency = s.recency;
    state.doses = s.doses.slice();
    state.obs = s.obs.slice();
    state.report = s.report;
    state.fit = null;
    M.select(state.drug);
    var sel = $('pt-drug'); if (sel) sel.value = state.drug;
    /* Order matters, and must match importJson()'s: applyDrugUI() lays down
     * the drug-scoped defaults — including resetting the trough target to
     * spec.targetDefault, which the drug-switch path depends on — so the
     * session's own values have to be applied AFTER it, not before. Restoring
     * state.target first (as this did until v0.19.1) let applyDrugUI() quietly
     * overwrite a clinician-entered target with the drug default on every
     * autosave restore, while the JSON-import path, which already had this
     * order, kept it. */
    applyDrugUI();
    state.target = s.target;
    if (!(state.target.value > 0)) state.target.value = null;
    /* v0.40.0: the form must hold the restored values BEFORE setMode() below.
     * setMode() -> markStale() -> updateRunReady() -> readPatient() reads the
     * form back into state; with syncInputs() after it (as until now) that
     * read the still-empty form over the restored session -- weight and LLOQ
     * blank, a custom target and the assay multiplier reset to defaults, and
     * markStale()'s autosave then overwrote the good saved copy. */
    setPlanFields(s.plan);
    setPrior(s.priorTx);
    syncInputs();
    /* Steady-state mode's own fields were never restored here at all --
     * mirrors importJson()'s own restoration of the same ss:{dose,interval,
     * anchor,dur} shape exactly, including the same validity guard
     * (a parseable anchor date), so the two restore paths cannot silently
     * disagree about what counts as a valid saved regimen. setMode() is
     * called for BOTH branches, never left implicit -- otherwise a restored
     * ss regimen would sit in the ss-* fields while the page silently stayed
     * on whatever mode the UI happened to already be showing. */
    var restoredMode = s.mode;
    if (restoredMode === 'ss' && s.ss) {
      $('ss-dose').value = s.ss.dose != null ? s.ss.dose : 900;
      $('ss-interval').value = s.ss.interval != null ? s.ss.interval : 14;
      $('ss-anchor').value = toLocalInput(new Date(s.ss.anchor));
      if ($('ss-dur')) $('ss-dur').value = s.ss.dur != null ? s.ss.dur : '';
      setMode('ss');
    } else {
      setMode('full');
    }
    renderDoses();
    renderObs();
    showEmpty();
  }

  function showEmpty() {
    if ($('chartCaption')) $('chartCaption').textContent = '';
    $('chart').innerHTML = '<div class="note">Enter the dosing schedule and press “Run forecast” to see the concentration–time plot.</div>';
    $('fitStatus').innerHTML = '<div class="note">Enter the patient, add the actual doses (and measurements if available), then press “Run forecast”.</div>';
    $('paramBlock').innerHTML = $('troughBlock').innerHTML = $('advisoryBlock').innerHTML = '';
    var ivRunBtn = $('iv-run');
    if (ivRunBtn) {
      ivRunBtn.disabled = true;
      $('iv-out').innerHTML = '<div class="note">Run a forecast in card 3 first. This explorer reuses that fit’s own parameters.</div>';
    }
    $('staleBanner').style.display = 'none';
    updateRunReady();
    updateStepper();
  }

  /* Called once from markStale() when a previous forecast exists and the
   * inputs it was built from have just changed: the on-screen chart, trough
   * table and advisories are for a set of inputs that no longer matches what
   * is on screen, so they are cleared rather than left looking current.
   * Distinct from showEmpty() (data has actually been entered and forecast
   * before here, so "enter the dosing schedule" would be wrong) and does not
   * touch state.fit itself -- the report dialog still offers to print the
   * last run's result, with its own explicit staleness confirm(). Also resets
   * card 4 (the regimen explorer), which reuses this same fit and would
   * otherwise keep showing a scan computed from the now-outdated posterior. */
  function showStaleResults() {
    if ($('chartCaption')) $('chartCaption').textContent = '';
    $('chart').innerHTML = '<div class="note">Forecast cleared because the inputs changed. Press “Run forecast” to see the updated prediction.</div>';
    $('fitStatus').innerHTML = '';
    $('paramBlock').innerHTML = $('troughBlock').innerHTML = $('advisoryBlock').innerHTML = '';
    var ivRunBtn = $('iv-run');
    if (ivRunBtn) {
      ivRunBtn.disabled = true;
      $('iv-out').innerHTML = '<div class="note">Run a forecast in card 3 first. This explorer reuses that fit’s own parameters.</div>';
    }
  }

  /* -------------------- regimen explorer (v0.13.0 / v0.14.0) ---------------
   * Two related questions a clinician asks after a fit, neither answerable
   * before v0.13.0 without hand-entering future doses and refitting once per
   * candidate (measured ~54 s for five candidates):
   *   "if I prolong the interval, what happens?"   -> vary interval, fixed dose
   *   "if I adjust the dose, what happens at steady state?" -> vary dose, fixed interval
   * Both reuse the SAME posterior draws the fit already produced (~1 s total),
   * because the posterior does not depend on the future schedule. Each
   * candidate reports two numbers that must not be collapsed into one:
   *   next          — only the next administration is changed
   *   steady state  — the patient is continued on the new regimen long enough
   *                   for the concentration to re-settle; for a drug that
   *                   accumulates this is usually the decision-relevant one
   * It displays consequences; the regimen choice stays with the clinician, and
   * no candidate is marked as recommended. Prints in the report when used,
   * clearly separated from the individualized default forecast above it. */
  /* v0.41.0: an individualised fit whose parameter search did not converge is
   * not a usable estimate. It used to be shown anyway, e.g. a trough of
   * 925 [924-925] with P 100%, next to a small "treat with caution" note. */
  function fitUnreliable(fit) {
    return !!(fit && fit.hasObs && fit.map && fit.map.converged === false);
  }

  function intervalExplorerAvailable() {
    return !!(state.fit && state.fit.draws && state.fit.draws.length && state.fit.rel &&
              state.fit.rel.dosesRel && state.fit.rel.dosesRel.length && !fitUnreliable(state.fit));
  }

  /* Card 4 is always visible (like cards 2-3, it shows its own "nothing yet"
   * state rather than disappearing) — only the Explore button and its default
   * values depend on a fit actually existing. */
  function showIntervalCard() {
    var runBtn = $('iv-run');
    if (!runBtn) return;
    if (!intervalExplorerAvailable()) {
      runBtn.disabled = true;
      $('iv-out').innerHTML = fitUnreliable(state.fit)
        ? '<div class="note warn">Not available: the last forecast did not converge, so there are no reliable parameters to explore with.</div>'
        : '<div class="note">Run a forecast in card 3 first. This explorer reuses that fit’s own parameters.</div>';
      return;
    }
    runBtn.disabled = false;
    var rel = state.fit.rel;
    var lastAmt = state.fit.planned ? state.fit.planned.amt : rel.dosesRel[rel.dosesRel.length - 1].amt;
    var amtEl = $('iv-amt'), ivEl = $('iv-interval');
    if (amtEl) amtEl.value = lastAmt;
    /* v0.45.0 (review S1): an interval the history does not state unambiguously
     * (loading just ended, or the last two spacings disagree) is not prefilled. */
    var trusted = state.fit.intervalTrusted !== false;
    if (ivEl) {
      ivEl.value = trusted ? fmtDays(state.fit.interval) : '';
      ivEl.placeholder = trusted ? '' : 'enter the interval';
    }
    $('iv-out').innerHTML = trusted
      ? '<div class="note">Press “Explore” to see what this patient’s fitted parameters predict for other doses or intervals.</div>'
      : '<div class="note warn">The dosing interval could not be taken from the entered history (the loading phase has only just ended, or the last two intervals differ). Enter the interval to evaluate, then press “Explore”.</div>';
  }

  async function runIntervalScan() {
    if (!intervalExplorerAvailable()) return;
    var fit = state.fit, rel = fit.rel;
    var vary = $('iv-vary').value === 'dose' ? 'dose' : 'interval';
    var lastAmt = rel.dosesRel[rel.dosesRel.length - 1].amt;

    var amt = parseFloat($('iv-amt').value);
    if (!(amt > 0)) { amt = lastAmt; $('iv-amt').value = amt; }
    var dl = M.drug().dose;
    if (!(amt >= dl.min && amt <= dl.max)) {
      alert('Dose must be between ' + dl.min + ' and ' + dl.max + ' mg for ' + M.drug().label + '.');
      return;
    }
    var iv = parseFloat($('iv-interval').value);
    if (!(iv > 0)) {
      if (fit.intervalTrusted === false) { alert('Enter the dosing interval (days) to evaluate. It could not be taken from the entered history.'); return; }
      iv = fit.interval; $('iv-interval').value = fmtDays(iv);
    }
    if (iv > 365) { alert('Interval must be 365 days or less.'); return; }

    var btn = $('iv-run');
    btn.disabled = true;
    $('iv-status').textContent = 'calculating…';
    try {
      var scan, baseline;
      var onProg = function (f) { $('iv-status').textContent = 'calculating… ' + Math.round(f * 100) + '%'; };
      if (vary === 'dose') {
        var amts = B.candidateAmounts(amt, dl);
        scan = await B.doseScan({
          draws: fit.draws, doses: rel.dosesRel, wt: fit.wt, disease: fit.disease,
          age: fit.age, drug: state.drug, target: state.target.value,
          interval: iv, amounts: amts, onProgress: onProg
        });
        baseline = amt;
      } else {
        var ivs = B.candidateIntervals(iv);
        scan = await B.intervalScan({
          draws: fit.draws, doses: rel.dosesRel, wt: fit.wt, disease: fit.disease,
          age: fit.age, drug: state.drug, target: state.target.value,
          amt: amt, intervals: ivs, onProgress: onProg
        });
        baseline = iv;
      }
      state.fit.intervalScan = { mode: vary, amt: amt, interval: iv, baseline: baseline, rows: scan };
      renderIntervalScan();
      updateStepper();
    } catch (e) {
      $('iv-out').innerHTML = noteHtml('Could not evaluate the regimen: ' + esc(e.message), 'warn');
    } finally {
      btn.disabled = false;
      $('iv-status').textContent = '';
    }
  }

  /* Builds the results TABLE only (no chart, no chrome) — shared by the
   * on-screen fold and the printed report so both show exactly the same
   * numbers. `forPrint` drops the live "current interval/dose" framing in
   * favour of naming the exact values evaluated, since a reader of the
   * printed page has no on-screen state to compare against. */
  function intervalScanTableHtml(sc, forPrint) {
    var tgt = state.target.value;
    var byDose = sc.mode === 'dose';
    /* v0.31.0 (author request): the table now shows steady-state trough only,
     * matching the chart above it -- which dropped its own "next dose only"
     * series back in v0.15.0 for the same reason (two numbers answering
     * different questions read as clutter). "Next" was still computed
     * (bayes.js's intervalScan()/doseScan() keep doing so, other consumers
     * still use it -- see tests/test_v013.js, test_v014.js), only no longer
     * displayed anywhere in this card. */
    /* responsive-cards (screen only): below the phone breakpoint this table's
     * rows become label:value cards via CSS alone (data-label -> ::before),
     * not a second markup path — print keeps the plain <table> unaffected,
     * since a printed page doesn't scroll and doesn't need the phone
     * treatment. See src/app.css. */
    var rowLabel = byDose ? 'Dose' : 'Interval';
    var h = '<table class="' + (forPrint ? 'rp-table' : 'data responsive-cards') + ' iv-table"><thead><tr>' +
      '<th>' + (byDose ? 'Dose' : 'Interval') + '</th>' +
      '<th class="num" title="Trough once the patient has been continued on this regimen long enough to re-approach steady state">Steady-state trough [5–95%]</th>' +
      '<th class="num">P(&gt; ' + tgt + ')</th>' +
      '</tr></thead><tbody>';
    sc.rows.forEach(function (r) {
      var val = byDose ? r.amt : r.interval;
      var isBase = Math.abs(val - sc.baseline) < (byDose ? 0.5 : 0.5);
      var label = byDose ? (fmtC(r.amt) + ' mg') : ('q' + fmtDays(r.interval) + 'd');
      h += '<tr class="' + (isBase ? 'iv-current' : '') + '">' +
        '<td data-label="' + rowLabel + '">' + label + (isBase ? ' <span class="tag-current">entered value</span>' : '') + '</td>' +
        '<td class="num" data-label="Steady-state trough">' + fmtC(r.ss.med) + ' <span class="ci-range">[' + fmtC(r.ss.p5) + '–' + fmtC(r.ss.p95) + ']</span></td>' +
        '<td class="num" data-label="P(steady-state &gt; target)">' + ptaBadge(r.ss.pTarget, r.ss.pCI) + '</td>' +
        '</tr>';
    });
    h += '</tbody></table>';
    var fixedTxt = byDose
      ? 'interval fixed at q' + fmtDays(sc.interval) + 'd'
      : 'dose fixed at ' + fmtC(sc.amt) + ' mg per administration';
    h += '<div class="legend-note"><b>Steady-state trough</b> = the patient is continued on the new regimen until the concentration settles; ' +
      'for a drug that accumulates this is the lower, and usually the decision-relevant, number. ' +
      'Uses the parameters fitted to this patient, with the ' + fixedTxt + '.</div>';
    return h;
  }

  function renderIntervalScan() {
    var sc = state.fit && state.fit.intervalScan;
    if (!sc || !sc.rows.length) return;
    var tgt = state.target.value;
    var byDose = sc.mode === 'dose';
    var xs = sc.rows.map(function (r) { return byDose ? r.amt : r.interval; });
    var h = '';
    var ivChartHost = document.getElementById('iv-out');
    var compact = isCompactWidth(ivChartHost ? ivChartHost.clientWidth : 0);

    /* Only the steady-state curve is charted: "next" and "steady state" can
     * disagree sharply for a drug that accumulates, but two overlapping lines
     * answering different questions read as clutter on this chart. "Next" is
     * still fully computed and shown as its own table column below — nothing
     * is lost, only the graph is simplified. No candidate is ever highlighted
     * as preferred; only the entered (baseline) value is marked. */
    var cfg = {
      compact: compact,
      width: compact ? undefined : 560, height: compact ? undefined : 260,
      xMin: xs[0], xMax: xs[xs.length - 1],
      yMin: 0, yMax: 100,
      xLabel: byDose ? 'Dose per administration (mg)' : 'Dosing interval (days)',
      yLabel: 'P(trough > ' + tgt + ' µg/mL)  %',
      series: [
        { x: xs, y: sc.rows.map(function (r) { return r.ss.pTarget * 100; }), color: '#0e7490', width: 2.2 }
      ],
      points: sc.rows.map(function (r, i) { return { x: xs[i], y: r.ss.pTarget * 100, color: '#0e7490' }; }),
      vlines: [{ x: sc.baseline, color: '#b45309', dash: '4 4' }],
      legend: [
        { label: 'Continuing at this ' + (byDose ? 'dose' : 'interval'), color: '#0e7490', swatch: 'line' },
        { label: 'Entered value', color: '#b45309', swatch: 'line', dash: '4 4' }
      ],
      title: 'Probability of staying above target by ' + (byDose ? 'dose' : 'dosing interval'),
      desc: 'Probability that the trough stays above ' + tgt + ' µg/mL for each candidate ' +
            (byDose ? 'dose' : 'dosing interval') + ', once the patient is continued on it long enough ' +
            'to reach steady state. The values are listed in the table below the chart.'
    };
    h += '<div class="iv-chart" id="ivChart"></div>';
    /* v0.17.0 — this table had no scroll wrapper at all (unlike the dose and
     * measurement tables), so it overflowed the viewport with no scroll
     * affordance on a narrow phone. Wrapped here for the live view; the print
     * copy (intervalScanTableHtml(scP, true) in reportHtml) deliberately
     * stays unwrapped — overflow-x:auto is a screen concept, print has its
     * own table-sizing rules. */
    h += '<div class="tbl-wrap">' + intervalScanTableHtml(sc, false) + '</div>';
    h += noteHtml('This shows what the model predicts. It is not a recommendation. ' +
      'The choice of regimen, and the decision to act on it, remain yours. This exploration also prints in the report when generated.', 'info');

    $('iv-out').innerHTML = h;
    try { C.render(document.getElementById('ivChart'), cfg); } catch (e) { /* table still stands */ }
  }

  // ------------------------- Getting started -------------------------------
  /* Author request (2026-09-15): a short first-time walkthrough, opened in a
   * real second window rather than a modal, so a clinician who has never
   * used the app can keep it open beside the real interface instead of it
   * blocking the thing it describes. One page, not a step-syncing wizard --
   * see the approved plan for why: syncing two windows to the app's own
   * step state is real engineering for a "short" guide, and a stale sync
   * would leave a first-time user worse off than no sync at all. Content
   * carries its own humanizer pass; it is not a paraphrase of the app's own
   * card titles and button labels, it quotes them verbatim on purpose, so
   * this text cannot quietly drift from the real UI without a reader
   * noticing the mismatch immediately. */
  function gettingStartedBodyHtml() {
    return '<p>This tool predicts blood levels of eculizumab, ravulizumab or crovalimab for ' +
      'one specific patient, using their weight and any measured levels you enter. Nothing you ' +
      'type leaves this device. There’s no server involved. Keep this window open and work ' +
      'through the four cards on the main screen in order.</p>' +
      '<ol class="gs-steps">' +
      '<li><b>Drug &amp; patient.</b> Pick the drug, enter the patient’s weight and, for ' +
      'crovalimab only, their age. A trough target is filled in for you; change it only if your ' +
      'local practice uses a different number.</li>' +
      '<li><b>Dosing schedule &amp; measured concentrations.</b> Choose <b>Full schedule</b> if ' +
      'you know the actual dates and doses this patient has received, or <b>Steady state</b> if ' +
      'they’re already on a stable maintenance regimen and you just want to enter the dose ' +
      'and interval. In Full schedule, also answer whether the patient had this drug before the first dose you entered; if they did, ' +
      'enter those earlier doses too, because missing ones make the forecast look better than it is. Add any measured concentrations you have. The app works without them, but a ' +
      'measured level is what lets it personalize the forecast instead of just showing the ' +
      'population average.</li>' +
      '<li><b>Forecast.</b> Press <b>Run forecast</b>. The chart shows the predicted ' +
      'concentration over time; the table below it shows the predicted trough before each future ' +
      'dose and the probability it stays above target. This is a prediction, not a ' +
      'recommendation. The app never suggests a dose or interval; that decision stays yours.</li>' +
      '<li><b>Regimen explorer</b> (optional). Once you’ve run a forecast, this card shows ' +
      'what a different dose or interval would do for this same patient, using the fit you ' +
      'already have. Skip it if you only need the forecast for the regimen already planned.</li>' +
      '</ol>' +
      '<p><b>When you’re done:</b> <b>Print report</b> asks for your name and advice, then ' +
      'builds a one-page printable summary: the chart, the forecast, and your notes together. ' +
      '<b>Export session</b> saves the case as a file you can reopen later or hand to a ' +
      'colleague. If you close the tab by accident, reopening the app offers to restore what you ' +
      'were working on.</p>' +
      '<p>Curious about the model behind the numbers, or the research-use disclaimer? See ' +
      '<b>About</b>, top right.</p>';
  }
  /* Wraps the fragment above into a full HTML document for the real popup
   * window: there is no separate app.css to link to once build.mjs has
   * inlined it into the single shipped file, so the popup carries its own
   * small stylesheet, using the app's own palette (src/app.css's own
   * :root) so it reads as the same product rather than a bolted-on help
   * file. */
  function gettingStartedDocHtml() {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Getting started: complementtdm</title>' +
      '<style>' +
      ':root{--bg:#eef2f6;--card:#fff;--ink:#0f172a;--line:#e2e8f0;--accent:#0e7490;--muted:#64748b}' +
      '*{box-sizing:border-box}' +
      'body{margin:0;background:var(--bg);color:var(--ink);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;' +
      'font-size:14px;line-height:1.55;padding:20px 22px}' +
      'h1{font-size:19px;margin:0 0 4px 0}' +
      '.gs-sub{color:var(--muted);font-size:12.5px;margin:0 0 18px 0}' +
      'p{margin:0 0 12px 0}' +
      'b{color:var(--ink)}' +
      'ol.gs-steps{margin:0 0 16px 0;padding-left:20px}' +
      'ol.gs-steps li{background:var(--card);border:1px solid var(--line);border-radius:8px;' +
      'padding:10px 12px;margin-bottom:10px}' +
      'ol.gs-steps li::marker{color:var(--accent);font-weight:700}' +
      '</style></head><body>' +
      '<h1>Getting started</h1>' +
      '<div class="gs-sub">complementtdm, a short walkthrough for first-time use</div>' +
      gettingStartedBodyHtml() +
      '</body></html>';
  }
  /* A real second window when the browser allows it (window.open only works
   * from a direct click, so this can never auto-open on page load -- that
   * is a real constraint, not a design choice). Reused by name on repeat
   * clicks rather than spawning a new window each time. Falls back to the
   * existing modal pattern if a popup blocker returns null, so the guide
   * stays reachable either way. */
  function openGettingStarted() {
    var w = null;
    try {
      w = window.open('', 'ctdmGettingStarted', 'width=440,height=720,resizable=yes,scrollbars=yes');
    } catch (e) { w = null; }
    if (w) {
      try {
        w.document.open();
        w.document.write(gettingStartedDocHtml());
        w.document.close();
        w.focus();
        return;
      } catch (e) { /* fall through to the modal below */ }
    }
    $('gettingStartedBody').innerHTML = gettingStartedBodyHtml();
    openModal('gettingStartedModal', 'gettingStartedClose');
  }
  function closeGettingStarted() {
    closeModal('gettingStartedModal');
  }

  // ------------------------------ About -----------------------------------
  // Author photo shown at the bottom of the About dialog (v0.35.0,
  // author-provided headshot, already circular-cropped, 170x170 WebP
  // ~29 KB). Base64-encoded so the single-file offline build carries it
  // with no external request, consistent with the rest of this app.
  var AUTHOR_PHOTO_URI = 'data:image/webp;base64,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';

  function aboutHtml() {
    var h = '';
    h += '<h3>Privacy</h3>' +
      '<p>Using this website, no data are remotely stored or processed. All calculations are performed ' +
      'locally on your device opening this website, to guarantee privacy and prevent data leaks.</p>';
    h += '<h3>Research use only</h3>' +
      '<p><b>For research purposes only, not for routine clinical use.</b> This tool is not a certified medical device and has not been clinically validated; validation against prospective data should be performed before routine use. Interpretation requires clinical judgment and local protocols; the models do not cover pregnancy or dialysis-dependent renal failure and, apart from eculizumab (weights from 3 kg), were not developed for paediatric patients. All computations run locally in your browser; no data is transmitted or stored.</p>';
    h += '<h3>Models</h3>';
    h += '<p class="src">For each model, assumptions and simplifications relative to its source are listed. Read them before clinical interpretation.</p>';
    h += '<h3>Trough targets</h3>' +
      '<p>Each drug\'s default target is prefilled from the source below and can be overridden per patient. ' +
      'The target is the only number that turns a PK forecast into a clinical judgement, so its provenance is stated explicitly.</p>' +
      '<ul class="about-list">';
    M.listDrugs().forEach(function (d) {
      var sp = M.spec(d.id);
      if (!sp.targetDefault) return;
      h += '<li><b>' + esc(sp.label) + ':</b> ' + esc(String(sp.targetDefault)) + ' µg/mL. ' +
        esc(sp.targetHint || '') +
        (sp.targetSource ? ' ' + esc(sp.targetSource) : '') +
        (sp.targetSourceUrl ? ' <a href="' + esc(sp.targetSourceUrl) + '" target="_blank" rel="noopener">source</a>' : '') +
        '</li>';
    });
    h += '</ul>';
    h += '<h3>How between-occasion variability (IOV) is handled</h3>' +
      '<p>For eculizumab in aHUS the source model carries between-occasion variability on clearance ' +
      '(variance 0.112) in addition to between-patient variability (0.1546). From the sparse samples of a ' +
      'single patient these two cannot be told apart, so this app <b>folds the occasion variance into the ' +
      'clearance prior</b> (giving 0.2666) and treats multi-occasion samples as one exchangeable block. ' +
      'That is the correct marginal prior for the occasion being fitted, and it is the approach described ' +
      'for MAP-Bayesian forecasting with IOV ' +
      '(<a href="https://bpspubs.onlinelibrary.wiley.com/doi/10.1111/bcp.13901" target="_blank" rel="noopener">Br J Clin Pharmacol, doi:10.1111/bcp.13901</a>).</p>' +
      '<p><b>What this means for the forecast.</b> Occasion-level random effects are not estimated separately, ' +
      'and the occasion component stays folded in after fitting. Because the reported trough is the one before ' +
      'the <i>next</i> dose (a future occasion), its interval is therefore somewhat narrower than the full ' +
      'occasion-to-occasion predictive uncertainty. Re-sample around flares, regimen changes and any event ' +
      'that could shift clearance, rather than relying on a forecast projected far ahead.</p>' +
      '<p>PNH (eculizumab), ravulizumab and crovalimab have no IOV term in their source models, so nothing is folded in for them.</p>' +
      '<h3>Weighting of older samples (optional, off by default)</h3>' +
      '<p>Under <b>Advanced fitting options</b>, older measurements can be given a larger residual error ' +
      'so that they influence the individual fit less than recent ones. A concentration describes the ' +
      'patient as they were on the day it was drawn; the further back that is, the less well it describes ' +
      'them now (partly real change in the patient, partly a dosing history that is less reliably ' +
      'documented the further back one looks.</p>' +
      '<p>This is the existing assay-error multiplier made time-dependent, and nothing more. Each ' +
      'sample\'s residual standard deviation is multiplied by ' +
      '<b>1 + (M − 1) × (1 − e<sup>−age/365 d</sup>)</b>, where age is measured from the newest sample ' +
      'and the preset sets M: low ×1.5, medium ×2, high ×3. The newest sample is therefore never ' +
      'inflated, and because the multiplier saturates at M an old sample is <b>down-weighted but never ' +
      'discarded</b>. At medium a year-old sample carries about 37% of its normal weight, falling ' +
      'towards 25% for much older ones. Since the multiplier acts on the SD, a sample\'s relative weight ' +
      'is exactly 1/M², independent of its concentration.</p>' +
      '<p>It is a statement about the residual error (SIGMA) alone: it applies to every drug and every ' +
      'disease, and is unrelated to the between-occasion variability described above, which is a ' +
      'random-effect (OMEGA) term. Neither M nor the 365-day time constant is taken from a publication, ' +
      'and neither is ever estimated from the patient\'s own data. With the handful of samples a real ' +
      'case carries neither would be identifiable, and a free inflation parameter would simply be driven ' +
      'up until the residuals vanished. They are a clinical judgement about how much to trust older ' +
      'measurements, made explicit and printed in the report.</p>' +
      '<p><b>Two cautions.</b> Widening the residual error widens the reported credible intervals, so a ' +
      'forecast made with this option on is less certain, not more. That is the honest consequence of ' +
      'leaning on fewer samples. And age is not the same thing as relevance: a sample is often old ' +
      'because the patient was stable, and a recent one drawn <i>because</i> something changed. To set ' +
      'aside a sample you believe is unrepresentative, exclude it explicitly rather than relying on its ' +
      'date.</p>';
    M.listDrugs().forEach(function (d) {
      var s = M.spec(d.id);
      h += '<div class="about-model"><b>' + esc(s.label) + '</b>' +
        (s.pending ? ' <span class="badge info" title="This drug is prepared but its NONMEM control stream is not yet available">parameters pending</span>' : '') +
        '<p class="src">' + esc(s.article) + '</p>' +
        (s.reviewUrl ? '<p class="src">' + esc(s.reviewRef || 'FDA review documents:') +
          ' <a href="' + esc(s.reviewUrl) + '" target="_blank" rel="noopener">' + esc(s.reviewUrl) + '</a></p>' : '') +
        '<p>' + esc(s.info) + '</p>';
      if (!s.pending) {
        var t = s.THETA;
        var par = 'CL ' + fmtC(t.CL) + ' L/d · V1 ' + fmtC(t.V1) + ' L · V2 ' + fmtC(t.V2) + ' L · Q ' + fmtC(t.Q) + ' L/d';
        if (t.VMAX > 0) par += ' · Vmax ' + t.VMAX + ' mg/d · Km ' + t.KM + ' µg/mL';
        par += ' · exponents ' + s.EXPO.CLQ + ' (CL,Q' + (t.VMAX > 0 ? ',Vmax' : '') + ') / ' + s.EXPO.V + ' (V)';
        par += ' · residual ' + (s.SIGMA.ADD > 0 ? 'add ' + s.SIGMA.ADD + ' + ' : '') + 'prop ' + s.SIGMA.PROP;
        par += ' · infusion ' + (s.INFUSION_D * 1440 >= 60 ? (s.INFUSION_D * 24).toFixed(1) + ' h' : Math.round(s.INFUSION_D * 1440) + ' min');
        if (s.KA_D > 0) par += ' · SC absorption ka ' + s.KA_D + '/day' + (s.covariateAge ? ' scaled by (age/' + (s.AGE_REF || 36) + ')^' + s.AGE_EXPO_KA : '') + ' · bioavailability F = ' + s.BIOAVAIL_SC;
        var etaNames = s.ETA ? s.ETA.names : ['CL', 'V1'];
        par += ' · estimated random effects: η(' + etaNames.join('), η(') + ')';
        h += '<p class="src">' + par + '</p>';
        if (s.assumptions) {
          h += '<ul class="src">' + s.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>';
        }
        if (s.targetHint) h += '<p class="src">Trough target: ' + esc(s.targetHint) + '</p>';
      } else {
        h += '<p class="src">Parameters pending. Forecasting disabled for this drug.</p>';
      }
      h += '</div>';
    });
    h += '<h3>Version</h3><p>v' + VERSION + '</p>';
    h += '<h3>Contact</h3>' +
      '<p>Developed by <b>Rob ter Heine</b> · Radboudumc, Nijmegen, the Netherlands. For questions or collaboration: <a href="mailto:r.terheine@radboudumc.nl">r.terheine@radboudumc.nl</a></p>' +
      '<p>Research group: <a href="https://www.radboudumc.nl/en/research/research-groups/applied-pharmacometrics" target="_blank" rel="noopener">Radboud Applied Pharmacometrics</a>, Radboudumc, Nijmegen.</p>';
    h += '<div class="about-photo"><img src="' + AUTHOR_PHOTO_URI + '" alt="Photo of Rob ter Heine" width="56" height="56"><span>' +
      esc('Rob ter Heine, Dept. of Pharmacy, Pharmacology & Toxicology, Radboudumc & Radboud Applied Pharmacometrics research group') +
      '</span></div>';
    return h;
  }
  /* ---- modal focus management (v0.13.0) --------------------------------
   * The dialogs previously only toggled `hidden`: a keyboard or screen-reader
   * user who pressed "Print report" stayed focused behind the backdrop and
   * tabbed through an invisible page, unable to reach the Advice textarea.
   * These helpers move focus in, trap Tab inside the dialog, mark the rest of
   * the page aria-hidden, and restore focus to the trigger on close. */
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var modalReturn = null, modalTrap = null;

  function openModal(id, focusId) {
    var el = $(id);
    if (!el) return;
    modalReturn = document.activeElement;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
    var main = document.querySelector('main');
    if (main) main.setAttribute('aria-hidden', 'true');
    var first = focusId && $(focusId) ? $(focusId) : el.querySelector(FOCUSABLE);
    if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
    modalTrap = function (e) {
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (n) {
        return n.offsetParent !== null || n === document.activeElement;
      });
      if (!f.length) return;
      var a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    el.addEventListener('keydown', modalTrap);
  }

  function closeModal(id) {
    var el = $(id);
    if (!el) return;
    if (modalTrap) { el.removeEventListener('keydown', modalTrap); modalTrap = null; }
    el.hidden = true;
    document.body.style.overflow = '';
    var main = document.querySelector('main');
    if (main) main.removeAttribute('aria-hidden');
    if (modalReturn && modalReturn.focus) { try { modalReturn.focus(); } catch (e) { /* ignore */ } }
    modalReturn = null;
  }

  function openAbout() {
    $('aboutBody').innerHTML = aboutHtml();
    openModal('aboutModal', 'aboutClose');
  }
  function closeAbout() {
    closeModal('aboutModal');
  }

  // --------------------------- print report --------------------------------
  /* The printed document is a dedicated sheet (#reportSheet), not the app UI:
   * it tells the sequence data → fit quality → forecast → findings → advice,
   * carries prepared-by/signature lines and the research-use disclaimer. The
   * on-screen app is hidden entirely while printing. */
  function openReportDialog() {
    if (!state.fit) {
      alert('Run a forecast first. The report documents the result of the last run.');
      return;
    }
    if (fitUnreliable(state.fit)) {
      alert('The last forecast did not converge, so there is no reliable result to report. Check the entered doses, amounts and sample times, and run the forecast again.');
      return;
    }
    if (state.stale) {
      if (!confirm('Inputs changed after the last forecast run. The report will document the LAST RUN result, which may not reflect the current inputs. Generate the report anyway?')) return;
    }
    $('rp-prepared').value = state.report.preparedBy;
    $('rp-advice').value = state.report.advice;
    openModal('reportModal', 'rp-prepared');
    document.body.style.overflow = 'hidden';
  }
  function closeReportDialog() {
    closeModal('reportModal');
  }
  function generateReport() {
    state.report.preparedBy = $('rp-prepared').value.trim();
    state.report.advice = $('rp-advice').value.trim();
    closeReportDialog();
    $('reportSheet').innerHTML = reportHtml();
    $('reportSheet').hidden = false;
    /* The report's GOF scatter is an empty div until something draws into it.
     * Render into the report's own host (rpGofChart) — before v0.13.0 both
     * copies shared one id, so only the on-screen one was ever filled and the
     * printed page showed an empty bordered box. */
    if (state.fit && state.fit.rel && state.fit.hasObs) {
      try { renderDiagnostics(state.fit, state.fit.rel, 'rpGofChart', 'rpDiagBody', false); } catch (e) { /* never block printing */ }
    }
    // give the browser a frame to lay out the sheet before print
    requestAnimationFrame(function () { window.print(); });
  }
  // after printing (or cancelling the print dialog) the sheet returns to hidden
  // so it never appears on screen below the app
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('afterprint', function () {
      var sh = document.getElementById('reportSheet');
      if (sh) { sh.hidden = true; sh.innerHTML = ''; }
    });
  }

  /* Both generators take an optional snapshot of the state fields they use,
   * so they can be tested headlessly (snapshot omitted = live state). */
  function findingsLines(snap) {
    var st = snap || state;
    var fit = st.fit;
    var rel = fit.rel;
    var out = [];
    out.push(fit.hasObs
      ? 'The forecast is individualized (MAP-Bayesian estimation with MCMC posterior sampling) on ' +
        rel.obsRel.length + ' measured concentration' + (rel.obsRel.length === 1 ? '' : 's') +
        (rel.excludedObs > 0 ? '; ' + rel.excludedObs + ' measurement(s) outside the simulated window were excluded.' : '.')
      : 'No measured concentrations were available. This is a population (prior) forecast, not an individualized one.');
    if (fit.hasObs) {
      out.push('Individual clearance ' + fmtC(fit.clQ.med) + ' L/day [5–95% ' + fmtC(fit.clQ.p5) + '–' + fmtC(fit.clQ.p95) +
        '], central volume ' + fmtC(fit.v1Q.med) + ' L [5–95% ' + fmtC(fit.v1Q.p5) + '–' + fmtC(fit.v1Q.p95) + '].');
    }
    /* F2 (independent audit, 2026-09-13): `worst` (lowest pTarget) used to be
     * printed as "the next dose" — a later, worse trough was written into the
     * record as though it were the imminent one. `next` (smallest t) and
     * `worst` are now reported separately, and the worst-trough sentence is
     * only emitted when it names a DIFFERENT dose than `next` — otherwise the
     * two sentences would just repeat the same row. */
    var upcoming = fit.troughs.filter(function (tr) { return tr.t > rel.nowRel - 0.02; })
      .sort(function (a, b) { return a.t - b.t; });
    if (upcoming.length) {
      var next = upcoming[0];
      out.push('Predicted true trough before the next dose (' + troughDate(rel, next.t) + '): median ' +
        fmtC(next.med) + ' µg/mL [5–95% ' + fmtC(next.p5) + '–' + fmtC(next.p95) + '], P(trough > ' +
        st.target.value + ' µg/mL) = ' + fmtPct(next.pTarget) + '.');
      var worst = upcoming.reduce(function (a, b) { return b.pTarget < a.pTarget ? b : a; });
      if (worst.t !== next.t) {
        out.push('The lowest predicted attainment among upcoming doses is on ' + troughDate(rel, worst.t) +
          ': median ' + fmtC(worst.med) + ' µg/mL, P(true trough > ' + st.target.value + ' µg/mL) = ' + fmtPct(worst.pTarget) + '.');
      }
      if (upcoming.some(function (tr) { return tr.pTarget < 0.9; })) {
        out.push('The trough target is not predicted to be reached with ≥ 90% probability at one or more upcoming doses.');
      }
    }
    if ((fit.loadingPhase || fit.spacingUnsettled) && !fit.planned) {
      out.push('No next-dose trough is assumed: ' + (fit.loadingPhase ? 'the loading regimen is not finished' : 'the last two dosing intervals differ') +
        ', so the next interval could not be taken from the entered history. A planned regimen would be needed to show one.');
    }
    if (st.obs.length && !st.obs.some(function (o) { return !o.lloq; })) {
      out.push('All measurements are below the LLOQ. Individualization relies entirely on censored (M3) information and is less certain.');
    }
    if (fit.covFallback) {
      out.push('Parameter uncertainty was taken from the population prior (fit curvature was not usable). Interpret the prediction bands with extra caution.');
    }
    if (M.drug().IOV_DISEASES.indexOf(fit.disease) >= 0) {
      // F9 (independent audit, 2026-09-13): the old sentence said predictions
      // are more uncertain than PNH, which is true but does not name the
      // separate, more specific caveat the audit wanted surfaced: because the
      // occasion component is folded into the prior rather than modelled as a
      // future-occasion effect, the interval reported for the NEXT dose is
      // somewhat narrower than the full occasion-to-occasion uncertainty.
      // Both claims are simultaneously true and belong in one sentence, not
      // two competing ones (see INDEPENDENT_AUDIT.md's own reviewer note).
      out.push(fit.disease + ': between-occasion variability in clearance is folded into the prior. Individual predictions are more uncertain than for PNH, and the interval for the next dose is somewhat narrower than the full occasion-to-occasion uncertainty because the occasion effect is not modelled separately.');
    }
    return out;
  }

  function reportHtml(snap) {
    var st = snap || state;
    var fit = st.fit;
    var rel = fit.rel;
    var spec = M.drug();
    var escNl = function (s) { return esc(s).replace(/\n/g, '<br>'); };
    var h = '';

    // 1 — header
    h += '<div class="rp-head">';
    h += '<div class="rp-title">Therapeutic drug monitoring report, ' + esc(spec.label) + '</div>';
    h += '<div class="rp-sub">Generated ' + fmtDate(Date.now()) +
      ' · complementtdm v' + esc(ECU.VERSION) +
      ' · model: ' + esc(spec.label) + ' (' + esc(spec.article) + ')</div>';
    h += '</div>';

    // 2 — patient & data
    h += '<h3 class="rp-h">Patient &amp; data</h3><table class="rp-kv">';
    h += '<tr><td>Pseudonym / code</td><td>' + (st.patient.code ? esc(st.patient.code) : '<i>not entered</i>') + '</td></tr>';
    h += '<tr><td>Weight</td><td>' + st.patient.wt + ' kg</td></tr>';
    if (spec.covariateAge) h += '<tr><td>Age</td><td>' + st.patient.age + ' years (covariate of the absorption rate)</td></tr>';
    if (spec.diseaseCovariate) h += '<tr><td>Disease</td><td>' + esc(st.patient.disease) + '</td></tr>';
    h += '<tr><td>Trough target</td><td>' + st.target.value + ' µg/mL' +
      (st.target.value === spec.targetDefault ? ' (drug default)' : '') +
      (spec.targetSource ? '<br><span class="rp-src">' + esc(spec.targetSource) + '</span>' : '') + '</td></tr>';
    if (st.lloq > 0) h += '<tr><td>Assay LLOQ</td><td>' + st.lloq + ' µg/mL (samples &lt; LLOQ handled with the M3 method)</td></tr>';
    if ((st.errMult || 1) !== 1) h += '<tr><td>Assay error multiplier</td><td>' + st.errMult + '</td></tr>';
    if (fit && fit.recencyMaxMult > 1) h += '<tr><td>Weighting of older samples</td><td>' +
      esc(fit.recency) + ' (residual error up to ×' + fit.recencyMaxMult + ')</td></tr>';
    h += '</table>';

    // Custom infusion times (2026-09-14): the SS summary sentence is the
    // ONLY disclosure point for SS mode (it has no per-dose table on screen
    // or in the report, same as renderDoses() -- a fixed regimen is
    // summarised, not itemised), so a non-default duration is folded into
    // that one sentence rather than silently vanishing from the record.
    var ssDurUsed = rel.ssMode && rel.dosesRel[0] && rel.dosesRel[0].dur != null ? rel.dosesRel[0].dur : null;
    h += '<h3 class="rp-h">Dosing schedule' + (rel.ssMode ? ' (steady state: ' + rel.dosesRel.filter(function (d) { return d.amt; }).length + ' doses at ' + fmtC(rel.dosesRel[0].amt) + ' mg q' + (rel.dosesRel[1] ? fmtC(rel.dosesRel[1].t - rel.dosesRel[0].t) : '?') + 'd' + (ssDurUsed != null ? ', ' + fmtDur(ssDurUsed) + ' infusion' : '') + ')' : '') + '</h3>';
    if (rel.ssMode) {
      h += '<p class="rp-note">Steady state on a fixed regimen; day 0 = the latest dose. Previous cycles were simulated back to steady state.</p>';
    } else {
      if (fit.planned) h += '<p class="rp-note">Planned regimen after the last entered dose (entered by the user): ' +
        fmtC(fit.planned.amt) + ' mg every ' + fmtDays(fit.planned.interval) + ' days.</p>';
      var showDurR = st.doses.some(function (d) { return d.dur != null; });
      h += '<table class="rp-table"><thead><tr><th>Date &amp; time</th><th class="num">Dose (mg)</th>' +
        (spec.adminRoutes ? '<th>Route</th>' : '') +
        (showDurR ? '<th>Duration</th>' : '') + '<th>Status</th></tr></thead><tbody>';
      var now = Date.now();
      st.doses.slice().sort(function (a, b) { return a.t - b.t; }).forEach(function (d) {
        h += '<tr><td>' + fmtDate(d.t) + '</td><td class="num">' + d.amt + '</td>' +
          (spec.adminRoutes ? '<td>' + (d.route === 'sc' ? 'SC' : 'IV') + '</td>' : '') +
          (showDurR ? '<td>' + (d.dur != null && d.route !== 'sc' ? fmtDur(d.dur) : (d.route === 'sc' ? '–' : fmtDur(spec.INFUSION_D) + ' (default)')) + '</td>' : '') +
          '<td>' + (d.t < now ? 'given' : 'planned') + '</td></tr>';
      });
      h += '</tbody></table>';
    }

    h += '<h3 class="rp-h">Measured concentrations</h3>';
    if (rel.obsRel.length) {
      h += '<table class="rp-table"><thead><tr><th>Date &amp; time</th><th class="num">Concentration (µg/mL)</th><th>Relative to schedule</th></tr></thead><tbody>';
      rel.obsRel.forEach(function (o) {
        var conc = o.lloq ? '&lt; ' + (st.lloq || 'LLOQ') + ' (below quantitation)' : fmtC(o.c);
        var near = '';
        var bd = Infinity, dose = null;
        rel.dosesRel.forEach(function (d) { var dd = Math.abs(o.t - d.t); if (dd < bd) { bd = dd; dose = d; } });
        if (dose) {
          var rel2h = (o.t - dose.t) * 24;
          if (rel2h < -1.5) near = Math.abs(rel2h) >= 24 ? Math.round(rel2h / 24) + ' d before dose' : Math.abs(rel2h).toFixed(1) + ' h before dose';
          else if (rel2h <= 2) near = 'trough-level (just before dose)';
          else near = rel2h >= 24 ? Math.round(rel2h / 24) + ' d after dose' : rel2h.toFixed(1) + ' h after dose';
        }
        h += '<tr><td>' + fmtDate(rel.t0ms + o.t * DAY) + '</td><td class="num">' + conc + '</td><td>' + near + '</td></tr>';
      });
      h += '</tbody></table>';
      if (rel.excludedObs > 0) h += '<p class="rp-note">' + rel.excludedObs + ' measurement(s) outside the simulated window were excluded from the fit.</p>';
    } else {
      h += '<p class="rp-note">No measurements entered. The forecast is a population (prior) forecast.</p>';
    }

    // 3 — fit quality
    h += '<h3 class="rp-h">Fit quality</h3><table class="rp-kv">';
    h += '<tr><td>Method</td><td>' + (fit.hasObs ?
      'MAP-Bayesian individualization + MCMC (' + fit.nDraws + ' posterior draws, ' + essText(fit) +
      ', acceptance ' + (fit.acceptance ? fit.acceptance.toFixed(2) : '–') + ')' :
      'Population (prior) forecast, no individualization') + '</td></tr>';
    if (fit.hasObs) {
      h += '<tr><td>Clearance (individual)</td><td>' + fmtC(fit.clQ.med) + ' L/day [5–95% ' + fmtC(fit.clQ.p5) + '–' + fmtC(fit.clQ.p95) + ']</td></tr>';
      var hlR = halfLifeInfo(fit);
      if (hlR) h += '<tr><td>Terminal half-life</td><td>' + halfLifeText(hlR) + '</td></tr>';
      if (hlR && hlR.nonlinear) h += '<tr><td>Saturable elimination</td><td>Vmax ' + fmtC(hlR.vmax) + ' mg/day (scaled to this weight), Km ' +
        fmtC(hlR.km) + ' µg/mL: fixed model values, not estimated. Total clearance at the predicted trough of ' + hlR.concText +
        ' µg/mL is ' + fmtC(hlR.clTotal) + ' L/day (the clearance above is the linear part only).</td></tr>';
      h += '<tr><td>Central volume (individual)</td><td>' + fmtC(fit.v1Q.med) + ' L [5–95% ' + fmtC(fit.v1Q.p5) + '–' + fmtC(fit.v1Q.p95) + ']</td></tr>';
      h += '<tr><td>Random effects ' + etaLabel(fit.map) + '</td><td>' + fmtEtaVec(fit.map) + '</td></tr>';
      if (fit.etaInformation && fit.map.etaNames) {
        var shParts = [];
        for (var si = 0; si < fit.etaInformation.length; si++) {
          shParts.push(fit.map.etaNames[si] + ' ' + Math.round(fit.etaInformation[si] * 100) + '%');
        }
        h += '<tr><td>Random effects informed by the samples (100% = fully determined)</td><td>' + shParts.join(', ') + '</td></tr>';
        var bars = infoBars(fit);
        if (bars) h += '<tr><td colspan="2"><div class="rp-shrink">' +
          '<div class="rp-shrink-h">Data-informativeness per parameter (100% = determined by the samples, 0% = population prior)</div>' + bars + '</div></td></tr>';
        // v0.10.0: individual GOF — residual table + EBE forest in the report
        if (D && fit.obsData && fit.obsData.length) {
          h += '<tr><td colspan="2"><div class="rp-diag" id="rpDiagBody">' +
            '<div class="rp-shrink-h">Individual fit diagnostics</div>' +
            D.gofPanel(fit, M.drug(), function (t) { return fmtDate(rel.t0ms + t * DAY); }, 'rpGofChart') +
            '<div class="rp-shrink-h" style="margin-top:8px">This patient vs the population (empirical Bayes estimates)</div>' +
            D.ebePanel(fit, M.drug()) + '</div></td></tr>';
        }
      }
    }
    h += '<tr><td>Residual error model</td><td>' + residualText(spec) +
      ((st.errMult || 1) !== 1 ? ', scaled ×' + st.errMult : '') + '</td></tr>';
    /* Review C14: the convergence diagnostics shown on screen belong in the
     * signed record too. */
    if (fit.hasObs) {
      var conv = [];
      var rh = (fit.rhat || []).filter(function (r) { return r != null && isFinite(r); });
      if (rh.length) {
        var rnm = (fit.map && fit.map.etaNames) || [];
        var badRh = [];
        (fit.rhat || []).forEach(function (r, i) { if (r != null && r > 1.05) badRh.push(rnm[i] || ('eta' + (i + 1))); });
        conv.push('split R-hat max ' + Math.max.apply(null, rh).toFixed(3) +
          (badRh.length ? ': above 1.05 for ' + badRh.join(', ') + ', the chains did not mix well' : ' (below 1.05, chains mixed)'));
      }
      if (fit.map && fit.map.startGap > 1) conv.push('the parameter search reached different solutions from different starting points (objective-function gap ' + fmtC(fit.map.startGap) + ')');
      if (fit.covFallback) conv.push('parameter uncertainty taken from the population prior (curvature at the optimum not usable)');
      h += '<tr><td>Convergence</td><td>' + esc(conv.join('; ')) + '</td></tr>';
    }
    /* The preset name alone is not auditable — a reader needs to see how much
     * each ACTUAL sample was discounted, at its own individual prediction. */
    if (fit && fit.recencyMaxMult > 1) {
      var rws = (fit.obsData || []).map(function (o) {
        return fmtDate(rel.t0ms + o.t * DAY) + ', ' + Math.round(o.ageDays) + ' d older than the newest sample, ' +
          'residual SD ×' + o.recencyMult.toFixed(2) + ', weight ' + Math.round(100 * o.recencyWeight) + '%' +
          (o.exclude ? ' (excluded from the fit)' : '');
      });
      h += '<tr><td>Older-sample weighting</td><td>' + esc(fit.recency) +
        '. Each measurement\'s residual standard deviation is multiplied by ' +
        '1 + ' + (fit.recencyMaxMult - 1) + ' × (1 − e<sup>−age/' + fit.recencyTau + ' d</sup>), so it is ' +
        'unchanged for the newest sample and rises towards ×' + fit.recencyMaxMult + ' for the oldest. ' +
        'a sample is down-weighted, never discarded. This scales the residual error (SIGMA) only; it is ' +
        'independent of the model\'s random-effect structure. Realised weights: ' +
        rws.map(esc).join('; ') + '.</td></tr>';
    }
    h += '</table>';

    // 4 — forecast (chart + trough table)
    h += '<h3 class="rp-h">Forecast</h3>';
    /* v0.17.0 — the report used to clone whatever SVG happened to be in the
     * live #chart div, which after the phone/desktop chart work could be the
     * compact phone layout if the clinician is printing from a narrow
     * window. The printed page is a fixed A4 document, not a live view, so
     * it must always get the desktop layout — rendered into a detached
     * element here (never touching the live, possibly-compact, on-screen
     * chart) and discarded once its SVG is harvested. */
    var svg = null;
    if (typeof document !== 'undefined' && state.fit) {
      try {
        var offscreenChart = document.createElement('div');
        renderChart(offscreenChart, false);
        svg = offscreenChart.querySelector('svg');
      } catch (e) { svg = null; }
    }
    h += '<div class="rp-chart">' + (svg ? svg.outerHTML : '<p class="rp-note">(chart not available)</p>') + '</div>';
    h += '<div class="rp-legend">Solid line: median predicted concentration · shaded band: 90% credible interval for the true concentration (residual assay error not included) · red points: measured concentrations · dashed horizontal line: trough target (' +
      st.target.value + ' µg/mL).</div>';
    if (fit.troughs.length) {
      h += '<table class="rp-table"><thead><tr><th>Day</th><th>Date</th><th>Status</th><th class="num">Median trough [5–95%] (µg/mL)</th><th class="num">P(true trough &gt; ' +
        st.target.value + ' µg/mL)</th></tr></thead><tbody>';
      var nowRelR = rel.nowRel != null ? rel.nowRel : 0;
      fit.troughs.forEach(function (tr) {
        /* The reader of the record must be able to tell which line is the
         * decision-relevant one, and which assumes a dose nobody has scheduled. */
        var status = tr.assumed
          ? (fit.planned ? '<b>planned next dose</b> (' + fmtC(fit.planned.amt) + ' mg q' + fmtDays(fit.planned.interval) + 'd)'
            : '<b>assumed next dose</b> (q' + fmtDays(fit.interval) + 'd)')
          : (tr.t <= nowRelR ? 'past' : 'upcoming');
        h += '<tr' + (tr.assumed ? ' class="rp-assumed"' : '') + '><td>' + fmtDays(tr.t) + '</td><td>' + troughDate(rel, tr.t) + '</td>' +
          '<td>' + status + '</td>' +
          '<td class="num">' + fmtC(tr.med) + ' [' + fmtC(tr.p5) + '–' + fmtC(tr.p95) + ']</td>' +
          '<td class="num">' + esc(fmtPct(tr.pTarget)) + (fmtPci(tr.pCI) ? ' (' + fmtPci(tr.pCI) + ')' : '') + '</td></tr>';
      });
      h += '</tbody></table>';
      // F9 (independent audit, 2026-09-13): same caveat as the on-screen
      // table, printed here too — the record must carry it, not just the screen.
      if (M.drug().IOV_DISEASES.indexOf(fit.disease) >= 0) {
        h += '<div class="rp-legend">' + esc(fit.disease) + ': between-occasion variability is folded into the prior, so the interval above for the next dose is somewhat narrower than the full occasion-to-occasion uncertainty.</div>';
      }
      if (fit.troughs.some(function (tr) { return tr.assumed; })) {
        h += fit.planned
          ? '<div class="rp-legend">“Planned next dose” is the next administration of the regimen entered by the user (' +
            fmtC(fit.planned.amt) + ' mg q' + fmtDays(fit.planned.interval) + 'd); it has not been given.</div>'
          : '<div class="rp-legend">“Assumed next dose” is not a scheduled administration: no dose was entered at that time, so the app projected one interval (q' +
            fmtDays(fit.interval) + ' d) after the last entered dose.</div>';
      }
    }

    /* Regimen exploration (v0.14.0): printed only when the clinician actually
     * used it, and kept visually and textually distinct from the
     * individualized forecast above — this is a hypothetical the clinician
     * asked about, not the result the fit produced from the entered doses. */
    if (fit.intervalScan && fit.intervalScan.rows && fit.intervalScan.rows.length) {
      var scP = fit.intervalScan;
      h += '<h3 class="rp-h">Regimen exploration, ' +
        (scP.mode === 'dose' ? 'candidate doses' : 'candidate intervals') + '</h3>';
      h += '<p class="rp-note" style="margin-top:0">This is not the forecast above. It shows what this patient’s ' +
        'fitted parameters predict for the candidate ' + (scP.mode === 'dose' ? 'doses' : 'intervals') +
        ' below, evaluated at the clinician’s request. It is not a treatment recommendation.</p>';
      h += intervalScanTableHtml(scP, true);
    }

    // 5 — findings & advice
    h += '<h3 class="rp-h">Model findings</h3><ul class="rp-findings">';
    findingsLines(snap).forEach(function (l) { h += '<li>' + esc(l) + '</li>'; });
    h += '</ul>';
    h += '<h3 class="rp-h">Advice</h3><div class="rp-advice">' +
      (st.report.advice ? escNl(st.report.advice) : '<i>No advice entered.</i>') + '</div>';

    // 6 — signatures
    h += '<table class="rp-sign"><tr>' +
      '<td><div class="rp-sig-role">Prepared by (calculations)</div><div class="rp-sig-name">' +
      (st.report.preparedBy ? esc(st.report.preparedBy) : '<i>not entered</i>') + '</div><div class="rp-sig-line"></div><div class="rp-sig-cap">date &amp; signature</div></td>' +
      '<td><div class="rp-sig-role">Reviewed / authorized by</div><div class="rp-sig-name">&nbsp;</div><div class="rp-sig-line"></div><div class="rp-sig-cap">name, date &amp; signature</div></td>' +
      '</tr></table>';

    // 7 — research-use disclaimer (full text also in the About dialog)
    /* Model scope must travel WITH the report: whoever receives the printed
     * page never opens the About dialog. The exclusion sentence used to appear
     * in About only, and the assumptions nowhere in the report at all. */
    if (spec.assumptions && spec.assumptions.length) {
      h += '<h3 class="rp-h">Model assumptions and scope</h3><ul class="rp-findings">';
      spec.assumptions.forEach(function (a) { h += '<li>' + esc(a) + '</li>'; });
      h += '</ul>';
    }
    h += '<p class="rp-note">For research purposes only, not for routine clinical use. This tool is not a certified medical device and has not been clinically validated; validation against prospective data should be performed before routine use. Interpretation requires clinical judgment and local protocols; the models do not cover pregnancy or dialysis-dependent renal failure and, apart from eculizumab (weights from 3 kg), were not developed for paediatric patients. All computations run locally in the browser. Developed by Rob ter Heine, Radboudumc, Nijmegen (r.terheine@radboudumc.nl).</p>';

    return h;
  }

  function toLocalInput(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes());
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  // testability (Getting started, 2026-09-15): pure string builders, no DOM
  ECU.gettingStartedBodyHtml = gettingStartedBodyHtml;
  ECU.gettingStartedDocHtml = gettingStartedDocHtml;
  /* Testability: the report generator is exposed as a pure function over a
   * snapshot object (the same fields it reads from live state). Not used by
   * the UI itself. */
  ECU.reportHtml = reportHtml;
  ECU.findingsLines = findingsLines;
  ECU.ptaBadge = ptaBadge;
  ECU.parseErrMult = parseErrMult;           // testability (v0.46.0)
  ECU.ageReason = ageReason;                 // testability (v0.46.0)
  ECU.effectiveAge = effectiveAge;           // testability (v0.46.0)
  ECU.resolveDoseRoute = resolveDoseRoute;   // testability (v0.45.0)
  ECU.isDuplicateDose = isDuplicateDose;     // testability (v0.45.0)
  ECU.esc = esc;                      // testability (v0.44.0): quote-safe escaping
  ECU.cleanSession = cleanSession;    // testability (v0.44.0): the session-import gate
  ECU.halfLifeInfo = halfLifeInfo;   // testability (v0.43.0)   // testability (F3/F11, v0.23.0): pure string builder, no DOM
  // testability (custom infusion times, 2026-09-14): pure unit-conversion/
  // formatting functions, no DOM
  ECU.durToMinutes = durToMinutes;
  ECU.minutesToDur = minutesToDur;
  ECU.fmtDur = fmtDur;
  /* Testability: novice-help internals (v0.8.0). */
  ECU.HELP = HELP;
  ECU.helpTextFor = helpTextFor;
  ECU.precisionWord = precisionWord;
  ECU.updateRunReady = updateRunReady;
  /* Testability: shrinkage visual (v0.9.2). */
  ECU.infoBars = infoBars;
  /* Testability: centralised version (v0.12.0). */
  ECU.appVersion = VERSION;
  ECU.updateTargetFold = updateTargetFold;
})();
