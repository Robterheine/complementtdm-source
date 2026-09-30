# mAb TDM — model-informed precision dosing of complement inhibitors

> **Handover document.** This README is written so that another LLM / coding agent
> (or a human developer) can pick the project up cold and continue safely. It covers
> the purpose, the clinical and statistical scope, the architecture and public APIs,
> the user experience, the validation suite, the conventions that must not be broken,
> how-to recipes for the most likely next changes, known limitations, and a roadmap.
>
> **Status:** v0.29.0 · 33 test suites / ~1280 assertions, all green ·
> `node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED` ·
> single-file artifact `complementtdm.html` (~261 KB, works offline from `file://`).
>
> **v0.13.0** was the multidisciplinary-audit release (§17). **v0.14.0** added
> dose scanning to the regimen explorer (§18). **v0.15.0** is a three-reviewer
> response to the author's own use of the app: the forecast chart no longer
> washes out to zero past the last entered dose (it projects a continuation
> at the historical regimen, clearly marked as not entered); the population
> band is now visible underneath the individual one; "Posterior"/"Prior"
> became "Individual prediction"/"Population prediction"; the regimen
> explorer is its own numbered card (4); its chart dropped the "next dose
> only" line (kept as a table column); and fit diagnostics moved to a modal.
> See §19. **v0.16.0** fixed the stepper's numbers to match the numbered
> cards below it (§20). **v0.17.0 makes the app work on a phone as well as a
> desktop**: the forecast, regimen-explorer and diagnostics charts now
> render a genuinely different (not just scaled-down) layout below ~480px —
> larger text, fewer ticks, a wrapped legend below the plot instead of a
> single unreadable row — the trough and regimen-explorer tables become
> stacked cards, the header collapses to a 2×2 button grid, and three
> pre-existing table/touch-target gaps were fixed along the way (§21).
> **v0.18.0** fixed the restore-bar and stepper banners, which sat outside
> `<main>` with their own independently-tuned width and visibly bled to the
> browser edge on a wide desktop window while the cards below stayed in a
> centered, inset column (§22). **v0.19.0**: the regimen explorer's proposed
> intervals are now always whole weeks — a q13d or q17d regimen is
> arithmetically fine but clinically undoable, since it drifts across
> weekdays every cycle — and the novice stepper reaches step 4 again
> ("Explore regimen"), gated on a forecast existing first. See §23.
> Published at <https://robterheine.github.io/complementtdm/>.

---

## 1. What this app is

A **single-file, dependency-free, offline HTML app for therapeutic drug monitoring
(TDM) and PK forecasting of complement inhibitors** — eculizumab, ravulizumab and
crovalimab. It is a clinician-facing *model-informed precision dosing* tool in the
spirit of Insight-RX, but purpose-built around three published/regulatory population
PK models.

Given a patient (weight; age and/or disease only where the selected model uses them),
their **actual** dosing schedule and any measured serum concentrations, the app:

1. individualizes the model to the patient with **MAP-Bayesian estimation** over the
   full random-effects vector,
2. samples the posterior with **MCMC** to get honest uncertainty,
3. forecasts the concentration–time curve and the **trough before each upcoming dose**,
4. reports **P(trough > target)** per dose and a full set of fit diagnostics, and
5. produces a printable **A4 clinical report** with the data, findings, the user's
   free-text advice and signature lines.

Everything runs in the browser. **No server, no network, no external libraries, no
build-time dependencies, no data leaves the device** — which is the whole point for a
hospital setting.

### Who this README is for

- **A new agent/developer** → read §2 (TL;DR), §6 (repo map), §7 (architecture),
  §12 (conventions & gotchas), then §13 (recipes).
- **A reviewer/auditor** → read §3 (scope), §4 (models), §9 (statistics), §11
  (validation), and open `VALIDATION.md`, `MODEL_VALIDATION.md`, `BAYES_AUDIT.md`.

---

## 2. TL;DR for a new agent — start here

```bash
# Run the whole test suite (Node >= 16, no install needed, ~2 minutes)
npm test                 # == node tests/run_all.js

# Rebuild the single-file deliverable after editing index.html / src/*
npm run build            # == node build.mjs  → complementtdm.html

# Pharmacometrician cross-check: app vs the shipped NONMEM control streams
node tools/verify_control_streams.mjs

# Regenerate the independent Python golden vectors (only if simulation changes)
npm run golden           # needs Python >= 3.8
```

**The ten golden rules** (breaking any of these has bitten us before):

1. **Never edit `complementtdm.html` by hand.** It is generated. Edit `index.html`
   and `src/*`, then run `npm run build`.
2. **Keep it dependency-free and offline.** No CDNs, no npm packages, no analytics,
   no `fetch` of external resources. The artifact must work from `file://`.
3. **Time is in DAYS** everywhere in the engine (`src/model.js`, `src/bayes.js`).
   Hour-based control streams are rescaled at transcription. Do not convert back.
   Never pass epoch-milliseconds into `runFit` (see §12 — it explodes the grid).
4. **Bump the version in exactly one place:** `src/version.js`. `package.json` must
   match it; `build.mjs` warns and `tests/test_version.js` fails if they drift.
5. **Run `npm test` after every change** and keep it 100% green. If you change a
   model parameter you must also update the expectation table in
   `tools/verify_control_streams.mjs`.
6. **No dosing strategies, no preprogrammed regimens, no label/SmPC dosing rules.**
   The user enters the regimen; the app never suggests a dose. This is a product
   requirement, not a preference.
7. **All clinical numbers must be traceable** to a source (article / control stream)
   and be reproducible by `tools/verify_control_streams.mjs`. Trough targets carry a
   `targetSource` + `targetSourceUrl` in the spec; keep them there.
7b. **A green check is not evidence until it can go red.** `verify_control_streams.mjs`
   passed unconditionally for four releases because its reference integrator produced
   `NaN` and `NaN > worst` is always false. Any new check must be shown to FAIL when
   the thing it guards is broken.
7c. **Never put a step grid on a clinical number field.** Native constraint validation
   runs *before* the submit handler, so an off-grid value silently prevents entry.
   Use `step="any"` + `novalidate` and validate in JS.
8. **Escape user-entered text** with `esc()` before putting it in HTML (report,
   tables, tooltips). Never interpolate raw user input.
9. **Keep the main screen light.** Long explanations belong in the About dialog,
   tooltips (ⓘ popovers), or collapsed `<details>` — not in always-visible prose.
10. **Research use only.** The disclaimer must stay visible (footer + About) and
    inside the printed report.

---

## 3. Clinical scope — what it does and deliberately does not do

**Does:**

- Individualized PK for eculizumab, ravulizumab, crovalimab (adult population PK).
- Concentration–time forecasting with 5–95% prediction bands; trough table with
  median `[5–95%]` and `P(trough > target)` plus a Monte-Carlo CI for the probability.
- MAP + MCMC individualization on trough and/or peak samples, including samples
  reported below the assay LLOQ (M3 method).
- Population (prior) forecasting when no samples are available.
- Per-parameter **identifiability diagnostics** (shrinkage) and **fit diagnostics**
  (observed-vs-individual-prediction, residuals, EBE-vs-population).
- Session export/import (JSON) and a clinician-ready printed A4 report.

**Deliberately does NOT:**

- ❌ Suggest, optimize or titrate doses. No regimens, no table-3/label strategies,
  no templates. (Removed on purpose in v0.6 — do not reintroduce.)
- ❌ Model anti-drug antibodies (the crovalimab control stream is the ADA-negative
  population; this is documented in About).
- ❌ Cover paediatrics, pregnancy, or dialysis-dependent renal failure.
- ❌ Do population model *validation* (no VPC/bootstrap) — n = 1 per session. Model-level
  calibration is covered instead by the simulate-then-fit study (`tests/test_e2e_fit.js`).
- ❌ Transmit or store any data. Everything is in-memory + optional local JSON export.

**Intended user:** a clinical pharmacologist / pharmacist / physician doing
model-informed TDM on adult patients. **Tone:** clinical, plain-language, cautious.

---

## 4. The three models

Full derivation, unit handling and deviations live in `MODEL_VALIDATION.md`;
the machine-checked transcription lives in `tools/verify_control_streams.mjs`.

All models are linear-or-MM 2-compartment disposition with allometric scaling,
optional SC depot absorption, and fixed IV infusions. Reference weight differs per
model (see below). Concentrations are µg/mL (= mg/L), amounts mg, time days.

| | Eculizumab | Ravulizumab | Crovalimab |
|---|---|---|---|
| Source | ter Avest 2025 (journal) | Ultomiris FDA review (simplified) | PiaSky FDA review, run05 |
| Reference | doi:10.1007/s40262-025-01536-x | [NDA 761108](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2018/761108Orig1s000TOC.html) | [NDA 761388](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2024/761388Orig1s000TOC.html) |
| CL (L/day) | 0.1626 | 0.08208 (= 0.00342 L/h) | 0.0791 |
| V1 / central (L) | 4.299 | 3.43 | 3.23 |
| V2 / peripheral (L) | 2.63 | 1.86 | 2.32 |
| Q (L/day) | 0.6243 | 0.3888 (= 0.0162 L/h) | 0.168 |
| Vmax / Km | 25.64 mg/d / 13.54 | 0 (none) | 0 (none) |
| Allometry CL,Q / V | 0.75 / 1.0 | 0.833 / 0.620 | 0.75 / 0.684 (ref **75 kg**) |
| IIV ω² (etas) | CL 0.1546, V1 0.0812 | CL 0.0569, cov 0.0161, V1 0.0264 | CL .0424, V1 .0502, Q .341, V2 .498, KA .147, F 1.35 (logit) |
| IOV | CL 0.112 in **aHUS** only | none | none |
| Residual σ² | add 19.1 + prop 0.0185 | prop 0.0239 | prop 0.01277 + add 1.02 |
| Infusion | 30 min IV | 2.5 h IV | 1 h IV (assumed for the loading dose) |
| SC absorption | — | — | ka 0.126/day · (age/36)^−0.459, F = 0.83 |
| Disease covariate | yes (PNH/aHUS) | no | no |
| Age covariate | no | no | yes (on ka) |
| Trough target (default) | 75 (≥50 min, ≥75 safe) — PMID 35238929 | 100 (≥100 min, ≥150 conservative) — PMID 33512711 | 75 — PMID 39835421 |
| Maintenance interval default | q14d | q56d | q28d |
| Admin routes | IV only | IV only | **IV loading, then SC** |

**Documented model assumptions** (also surfaced in the app's About dialog and
`MODEL_VALIDATION.md`): crovalimab has no ADA effect, uses the rich-sampling additive
residual term, and assumes a 1-h loading infusion; ravulizumab is a *simplified*
research re-implementation (linear elimination, no IOV, weight only) that needs its own
prospective validation; eculizumab's aHUS IOV is folded into the clearance prior
(occasion-level effects are not separately estimated — unidentifiable from n = 1 TDM).

---

## 5. Requirements, running, building

- **Runtime:** any modern desktop browser (Chrome, Firefox, Safari, Edge). No install.
  Open `complementtdm.html` directly, or double-click it. Works offline.
- **Development:** Node ≥ 16 (no `node_modules`; the test runner is plain Node).
  Optional Python ≥ 3.8 only to regenerate golden vectors.
- **Dev loop:** open `index.html` in a browser (it loads `src/*.js` and `src/app.css`
  individually) or serve the folder with any static server. Edit sources, rebuild with
  `npm run build`, and the standalone artifact is refreshed.

| Command | What it does |
|---|---|
| `npm test` | Runs all 17 suites (`tests/run_all.js`). Exits non-zero on failure. |
| `npm run build` | Inlines CSS + JS into `complementtdm.html`; prints version + build stamp. |
| `npm run golden` | Regenerates `tests/golden.json` from the independent Python reference. |
| `node tools/verify_control_streams.mjs` | Pharmacometrician transcription + structure cross-check. |

---

## 6. Repository map

```
complementtdm.html        GENERATED single-file app — the deliverable. Do not edit.
index.html                Development entry page (loads src/* individually).
build.mjs                 Build script: inlines src/app.css + src/*.js, checks version.

src/
  version.js              SINGLE SOURCE OF TRUTH for the version string (ECU.VERSION).
  model.js                Drug registry, ODE model, parameters, solver, simulation.
  bayes.js                OFV/MAP, Laplace covariance, MCMC, posterior bands, runFit.
  chart.js                Dependency-free SVG chart (bands, series, points, error bars,
                          hover, optional log y-axis).
  diagnostics.js          Fit diagnostics panels (GOF scatter, residual rows, EBE forest).
  ui.js                   All application wiring, rendering, report generation, help.
  app.css                 Styles, including the print stylesheet.

nonmemcontrolstream.txt   Eculizumab source model (NONMEM control stream).
ravulizumab.txt           Ravulizumab source model (FDA-review simplification).
crovalimab.txt            Crovalimab source model (PiaSky FDA review, run05).

tools/
  verify_control_streams.mjs   Parses $THETA/$OMEGA/$SIGMA from the control streams and
                               re-implements $DES independently (fixed-step RK4) —
                               diffs against what the app uses. The pharmacometrician gate.
  calibration_study.mjs        The REAL simulate-then-fit calibration study (npm run
                               calibration): N>=300 per scenario, five scenarios across
                               all three drugs, exact binomial CI on coverage + a PIT
                               histogram. tests/test_e2e_fit.js is only a smoke test.
  gen_golden.py                Independent Python reference simulator → tests/golden.json.
  probe_ident.js               Seeded probe: demonstrates shrinkage behaves as designed.

tests/
  util.js             Shared harness (loads ECMA modules into global ECU; T collector).
  run_all.js          Runner: lists every suite; edit here to add one.
  golden.json         Independent reference concentrations.
  test_model.js       Golden vectors + basic PK sanity.
  test_bayes.js       Likelihood/MAP/MCMC behaviour.
  test_stress.js      Adversarial/edge inputs.
  test_ss.js          Steady-state engine.
  test_drugs.js       Multi-drug registry + FDA-review provenance links.
  test_routes.js      IV/SC routes + pending-drug guards.
  test_crovalimab.js  Crovalimab-specific model checks.
  test_audit.js       Regressions for BAYES_AUDIT findings.
  test_stats.js       Statistical correctness (exact likelihood, ESS, MC intervals).
  test_multieta.js    Dimension-agnostic 6-eta engine, MAP recovery, Laplace, MCMC.
  test_e2e_fit.js     Simulate-then-fit calibration study (prediction-interval coverage).
  test_diagnostics.js GOF/EBE panel geometry + engine exports.
  test_empty_fields.js Blank-field policy (weight/target/LOOQ guards).
  test_report.js      Print-report generation over a snapshot.
  test_usability.js   Static UI/UX assertions (help keys, fixes, log axis, fold, links).
  test_version.js     Centralised-version wiring + package.json sync.
  test_model_verify.js Model-vs-control-stream verification suite (asserts the reported
                      deviations, not merely the tool's exit code).
  test_v013.js        Regressions for every v0.13.0 audit fix, incl. the dose-interval
                      explorer and the split-R-hat / Student-t statistics.
  test_v014.js        Regressions for v0.14.0's dose-scanning regimen explorer.
  test_v015.js        Regressions for v0.15.0: chart continuation independence from
                      the fit/trough table, terminology, card 4, diagnostics modal.
  test_v017.js        Regressions for v0.17.0: chart.js compact-layout unit tests
                      (no legend ever overflows), report-always-desktop landmine,
                      the three found-unwrapped tables, breakpoint consolidation.
  test_v018.js        Regression for v0.18.0: the restore bar and stepper are inside
                      main.layout (not before it), so they share the cards' exact box.
  test_v019.js        Regressions for v0.19.0: every regimen-explorer interval candidate
                      is a multiple of 7 days; the stepper's step 4 exists and is gated
                      correctly on a forecast, then an exploration, actually completing.
  test_session_restore.js
                      Regression for v0.19.1: the two whole-session restore paths
                      (localStorage autosave and JSON import) apply the drug defaults
                      and the session's own trough target in the same order, so a
                      custom target survives a restore.
  test_v021.js        Regressions for v0.21.0: the residual-SD multiplier (closed-form
                      OFV pin, x1 at age 0, saturation at the preset ceiling, identical
                      for every drug/disease, composition with errMult, negative
                      relative times), the preset table and its direction, the state
                      plumbing, and the Advanced-options split. Supersedes test_v020.js.
  test_v022.js        Regression for v0.22.0: once an individual fit exists, the
                      population prediction band is no longer drawn on the forecast
                      chart or in the printed report — only when no concentration data
                      have been fitted does the population band remain. Also pins that
                      the y-axis no longer folds in the (now-hidden) population band's
                      range once hasObs is true.

README.md                 This handover document.
VALIDATION.md             Validation report + review checklist (authoritative changelog).
MODEL_VALIDATION.md       Model-by-model transcription validation vs control streams.
BAYES_AUDIT.md            Statistical audit of the MAP-Bayesian engine.
NOVICE_UI_REVIEW.md       Novice-usability review and resulting UI changes.
40262_2025_Article_1536.pdf   Source article (reference material, not used at runtime).
```

---

## 7. Architecture and public APIs

### 7.1 Data flow (one forecast, end to end)

```
user input (index.html DOM)
   │  read by ui.js: readPatient(), readSS()/relContext()
   ▼
ui state {patient, drug, target, doses[{t ms,amt,route}], obs[{t ms,c,lloq}], lloq, errMult}
   │  relContext() converts ms → DAYS relative to first dose (or the SS anchor)
   ▼
bayes.runFit(input, {progress})            ← the only heavy call
   ├─ M.select(drug); M.priorOmega(disease)         prior
   ├─ buildGrid() + M.simulate()                     prior draws → priorBand
   ├─ makeOfv() + mapEstimate()  (Nelder-Mead)       MAP etas
   ├─ laplaceCov() → covariance (or prior fallback flag)
   ├─ runMCMC() → posterior draws, ESS, acceptance
   ├─ simulateDraws() → posterior band + troughs + P(>target) + MC CI
   └─ etaShrinkageOf() / corrMatrix() → identifiability diagnostics
   ▼
fit {band, priorBand, troughs, map, clQ, v1Q, obsData, etaShrinkage, …}
   ▼
ui.js renderChart() → chart.js render()   (SVG, log axis optional)
ui.js renderResults() → param block, shrinkage bars, diagnostics.js panels
ui.js reportHtml(snapshot) → #reportSheet → window.print()
```

### 7.2 `ECU.model` (`src/model.js`)

```js
ECU.model.drugs                 // registry: { id: spec, … }
ECU.model.listDrugs()           // [{id,label}, …] (order = UI order)
ECU.model.select(id)            // set the 'current' drug (global side effect!)
ECU.model.drug()                // current spec
ECU.model.spec(id)              // spec by id (or current)
ECU.model.requireReady(id)      // throws if the drug is 'pending' (no params)
ECU.model.priorOmega(disease, id?)      // { cl, v1?, cov?, dims, vars[] } — the Ω prior
ECU.model.omegaVars(id?, disease?)      // variance vector
ECU.model.etaDim(id?)                    // number of estimated etas
ECU.model.indivParams(wt, disease, a, b, c, d, e)  // legacy 2-eta positional call
ECU.model.indivParamsVec(wt, disease, etaVec, id?, age?)  // full-dimension params
ECU.model.effClearance(p, c) / effHalfLife(p, c)   // at a concentration c
ECU.model.simulate(doses, outTimes, p, opts)       // adaptive Dormand–Prince 5(4)
// opts: { rtol, id }   doses: [{t:days, amt:mg, route?:'iv'|'sc', bolus?}]
```

Backwards-compatible aliases (`ECU.model.THETA`, `.OMEGA`, `.SIGMA`,
`.INFUSION_DURATION_D`) mirror the eculizumab spec for historical callers/tests.

### 7.3 `ECU.bayes` (`src/bayes.js`)

```js
ECU.bayes.runFit(input, cb?)    // async; the main entry point
// input: { wt(kg, required 35–200), age?, disease, drug?, doses[{t,amt,route?}],
//          obs[{t,c,lloq}], lloq, target, seed?, mcmcIters?, errMult?,
//          priorDraws?, windowStart? }   // windowStart: left edge of the plot grid (SS mode)
// cb:    { progress(fraction, message) }
// returns (selected fields):
//   hasObs, disease, wt, age, target, omega,
//   map {etaCL, etaV1, etaVec, etaNames, ofv, params},
//   acceptance, nDraws, essCL, essV1, essAll,
//   etaShrinkage[], etaCorr[][], etaDim, covFallback,
//   band {p5,med,p95}, priorBand {p5,med,p95}, grid[], troughs[{t,med,p5,p95,pTarget,pCI}],
//   clQ {p5,med,p95}, v1Q {p5,med,p95}, obsData[{t,c,lloq,ipred}],
//   popTypical, clPostDraws, v1PostDraws, runtimeMs
ECU.bayes.mulberry32(seed) / gaussFactory(rng)   // deterministic RNG helpers
ECU.bayes.makeOfv / mapEstimate / laplaceCov / runMCMC
ECU.bayes.priorDraws(n, omega, rng) / auxDraws / simulateDraws / subsample
ECU.bayes.ess / etaShrinkageOf / corrMatrix / batchMeansCI / quantileSorted
ECU.bayes.statsOfMatrix / probAbove / modalInterval / buildGrid / troughTimesOf
```

> **Side effect to remember:** `runFit` calls `M.select(drug)`. Tests must restore
> the default drug afterwards (several suites end with `M.select('eculizumab')`).

### 7.4 `ECU.chart` (`src/chart.js`)

```js
ECU.chart.render(el, cfg)   // draws an SVG into el
// cfg: { width, height, xMin, xMax, yMin?, yMax, logY?, xLabel, yLabel,
//        bands[{x,lo,hi,fill}], hband?, hlines[{y,color,dash,label}],
//        vlines[{x,color,dash}], series[{x,y,color,dash,width}],
//        points[{x,y,color,cls?,data?,hollow?}],
//        errorBars[{x,lo,hi,color,width,cap}], legend[{label,color,dash,swatch}],
//        hover{times,rows}, futureFrom? }
ECU.chart.niceTicks(min, max, n)   // linear ticks
ECU.chart.logTicks(lo, hi)         // 1-2-5 per decade (log axis)
```

### 7.5 `ECU.diagnostics` (`src/diagnostics.js`)

```js
ECU.diagnostics.gofChart(fit, spec)       // SVG element/string for obs-vs-ipred
ECU.diagnostics.residualRows(fit, spec)   // per-sample residual table rows
ECU.diagnostics.ebeChart(fit, spec)       // EBE-vs-population forest
ECU.diagnostics.gofPanel(fit, spec, fmtDate)   // full GOF panel HTML
ECU.diagnostics.ebePanel(fit, spec)            // full EBE panel HTML
ECU.diagnostics.summaryHint(fit)              // 'good' | 'warn' | 'bad' | ''
```

### 7.6 `ECU.ui` exports (`src/ui.js`) — test hooks

```js
ECU.appVersion / ECU.VERSION     // central version
ECU.reportHtml(snapshot)         // pure report generator (snapshot = the fields it reads)
ECU.findingsLines(snapshot)      // model-findings bullet list
ECU.HELP / ECU.helpTextFor(key, el)   // ⓘ popover text (two-tier help)
ECU.precisionWord(fit) / ECU.updateRunReady() / ECU.shrinkBars(fit)
ECU.updateTargetFold()
```

`ui.js` guards all DOM work behind `typeof document !== 'undefined'`, so the module
can be `require`d in Node for static/DOM-free assertions. Most UI tests read
`index.html` / `src/*.js` as text and assert on structure — that is intentional: it
keeps the suite dependency-free (no jsdom).

### 7.7 Drug spec shape (what a model is made of)

```js
{
  id, label,
  article, info,                       // About: citation + one-paragraph description
  reviewRef?, reviewUrl?,              // About: FDA-review reference link (optional)
  pending?,                            // true = prepared but no parameters yet (blocked)
  sourceUnits?,                        // original control-stream time unit, for docs
  THETA: { CL, V1, VMAX, KM, V2, Q },  // fixed effects (per reference weight)
  EXPO:  { CLQ, V },                   // allometric exponents (CL,Q,Vmax) / (V1,V2)
  WT_REF?, AGE_REF?, AGE_EXPO_KA?,     // non-default references / age effect on ka
  OMEGA: { CL, V1, COV },              // legacy 2-eta IIV (kept for backward compat)
  ETA?: { names[], vars[], fLogitIdx? }, // canonical full-dimension IIV
  OMEGA_AUX?: { ka, f, fLogit? },      // optional extra etas
  IOV_CL, IOV_DISEASES: [],            // inter-occasion variability (disease-gated)
  SIGMA: { ADD, PROP },                // residual error variances
  INFUSION_D,                          // IV infusion duration [days]
  KA_D?, BIOAVAIL_SC?, adminRoutes?,   // SC absorption + route scheme
  covariateAge?, diseaseCovariate?,    // which covariate fields the UI shows
  samplePeak,                          // sampling-time hint (plain language)
  dose: { min, max, step, default },   // dose-field conventions
  ssIntervalDefault, obsValMax,
  targetRange: { min, max }, targetDefault, targetHint,
  diseaseNotes?, assumptions: [], yMaxCap?
}
```

---

## 8. User experience — friendliness and simplicity

The UI is deliberately restrained. A first-time user is guided by structure, not by
walls of text; long explanations live behind ⓘ popovers, collapsed sections, or the
About dialog.

### Workflow (three numbered cards)

1. **Drug & patient** (`#patientCard`) — drug selector **at the top**, then the
   covariates the *selected* model actually uses (weight always; disease for
   eculizumab; age for crovalimab), the optional patient ID, and the **folded**
   trough target.
2. **Dosing schedule & measured concentrations** (`#chartCard`) — either a dated
   **Full schedule** timeline, or **Steady state (dose + interval)**; then the
   measurement table + add form (with the `< LLOQ` flag).
3. **Forecast** (`#resultsCard`) — chart (+ **Log scale (y-axis)** toggle), the Run
   button with a plain-language readiness hint, collapsed **Advanced options (assay)**
   (LLOQ + assay-error multiplier), "How to read these results", then results.

### Novice affordances (keep these working)

- **Stepper** under the header (weight → doses → samples → Run), dismissible.
- **Run button stays disabled** with a plain reason until the minimum is entered.
- **ⓘ popovers** (click/tap/keyboard) in prescriber language for the six fields where
  novices stall; native `title` hover tooltips remain as the second tier.
- **Empty by default** — no data field is prefilled *(exception: the trough target is
  prefilled with the drug default, on purpose, and shown in the folded summary)*.
- **Non-blocking undo toast** instead of `confirm()` for "clear all".
- **Colour language:** green = fine, amber = caution, grey = "no information yet"
  (never red for a statistically-correct prior-anchored estimate).

### Recent UI decisions worth preserving

- **Drug selector at the top**; the old `modelNote` paragraph was removed from the
  main screen (its content lives in About) — the main screen must stay low-text.
- **Trough target is folded** into a `<details>` showing the value in use, so it can't
  change by accident. It is **prefilled with the drug's default** and re-prefilled on
  a drug switch; the summary, the `P(> target)` column and the dashed target line
  always agree. `init()` also honours a browser-restored drug selection on reload.
- **LLOQ + assay-error multiplier** live in a collapsed "Advanced options (assay)"
  fold in the Forecast card.
- **Log-scale y-axis** is a view-only toggle (values stay µg/mL; decades snapped).
- **Identifiability is shown, not hidden:** per-eta shrinkage bars (v0.9.2) plus a
  "Fit diagnostics" `<details>` (v0.10.0) with the GOF scatter/residuals and the
  EBE-vs-population forest. All appear on screen *and* in the print report.
- **Footer** is one line: purpose · research-use · author · email · version · research
  group link. Long disclaimer/citations are in About and the printed report.

### Print report

`Print report` opens a small dialog (prepared-by + free-text **Advice**, both stored
in the session), then renders a dedicated `#reportSheet` (not the app UI) and calls
`window.print()`. Sections: header (model + source) → patient & data → dosing schedule
→ measurements → fit quality (incl. shrinkage visual + diagnostics) → forecast (chart +
trough table) → model findings → Advice → signature lines → research-use disclaimer.
The screen UI is hidden by `@media print`; the sheet is emptied on `afterprint`.

---

## 9. Statistical engine (what it does, and why it is sound)

Full audit in `BAYES_AUDIT.md`; the correctness suite is `tests/test_stats.js`.

- **Likelihood** — exact Gaussian with the log-variance (Jacobian) term, plus the
  **M3** contribution for `< LLOQ` samples: `P(obs < LLOQ) = Φ((LLOQ − pred)/SD)`.
  The residual SD comes from the drug's `SIGMA`, inflated by the assay-error
  multiplier when the user sets one. Censored samples require a known LLOQ — the
  engine throws rather than treating them as 0.
- **MAP** — Nelder–Mead over the full eta vector, with per-dimension steps scaled to
  the prior SDs. OFV = −2·log posterior (data + prior). `map.ofv` is finite on success.
- **Laplace** — curvature at the mode gives the parameter covariance (N×N for the
  multi-eta drugs). If the curvature is unusable, `covFallback = true` is surfaced
  and the app tells the user to interpret bands cautiously.
- **MCMC** — random-walk Metropolis with a proposal Cholesky from the Laplace
  covariance; deterministic seed; per-eta **ESS** reported. Acceptance ~0.3 in tests.
- **Posterior bands / troughs** — prior and posterior draws are pushed through the
  model on a grid; the band is the 5th–95th percentile; troughs are evaluated
  pre-dose (exact landing) with `P(> target)` and a **batch-means Monte-Carlo 95%
  CI** on that probability (the draws are autocorrelated, so a naive binomial SE
  would be too optimistic).
- **Identifiability** — `etaShrinkage = 1 − var(posterior)/var(prior)` per eta
  (0 = the samples taught us nothing → prior-anchored) and the posterior correlation
  matrix. Behaviourally verified: crovalimab ka/F shrinkage ≈ 0 from troughs alone,
  improving when a peak is added (`tools/probe_ident.js`).
- **Honest uncertainty** — `tests/test_e2e_fit.js` simulates 24 patients from the full
  prior, adds residual error, and runs the *complete* pipeline as a fast smoke test; at
  N=24 it cannot distinguish 90% coverage from 99% and is not calibration evidence (see
  golden rule 7b and `INDEPENDENT_AUDIT.md` F1). The real calibration evidence is
  `npm run calibration` (`tools/calibration_study.mjs`): N=300 per scenario, five
  scenarios across all three drugs, production MCMC. All five scenarios PASS
  (89.3–90.0% coverage, every 95% CI containing 0.90, every PIT histogram statistically
  flat) — full results in `VALIDATION.md` §V2a.

---

## 10. Numerical model & solver

- 2-compartment disposition; optional Michaelis–Menten (eculizumab) and optional SC
  depot; allometric scaling; fixed-duration IV infusions.
- Solver: adaptive **Dormand–Prince 5(4)**, splitting exactly at every dose and
  observation time (pre-dose trough semantics; no step-over error at events).
- Validated to ≤1.2×10⁻⁸ relative error against an independent Python RK4 reference
  (`tests/golden.json`, `npm run golden`) and against the analytic linear solution.
- Time units are **days**; hour-based control streams are rescaled uniformly at
  transcription (an exact linear time rescale) — verified by
  `tools/verify_control_streams.mjs` (0.00% `$DES` deviation for all three models).

---

## 11. Validation and the test suite

Run everything with `npm test` (~2 min; it prints per-suite pass/fail and a total).
The suite is intentionally dependency-free: pure Node, fixed seeds, deterministic.

**What each layer proves**

| Layer | Suite(s) | Proves |
|---|---|---|
| Model correctness | `test_model` | Golden vectors vs an independent Python reference; analytic 2-cmt bolus check; PK sanity. |
| Control-stream fidelity | `tools/verify_control_streams.mjs`, `test_model_verify` | Parameters transcribed exactly; `$DES` structure reproduced independently (also run as a suite subprocess); band-only ka/F aux sampling. |
| Bayesian engine | `test_bayes`, `test_stats`, `test_audit` | Exact likelihood/M3, MAP, ESS, MC intervals, audit regressions. |
| Multi-eta engine | `test_multieta` | 6-eta MAP recovery, Laplace, MCMC, correlated priors. |
| Calibration | `test_e2e_fit` | Prediction intervals are honestly calibrated (simulate-then-fit). |
| Multi-drug | `test_drugs`, `test_routes`, `test_crovalimab` | Registry, unit rescale, IV/SC routes, pending guards, provenance links. |
| Steady state | `test_ss` | Pre-roll to steady state, negative-time windows, scope limits. |
| Diagnostics | `test_diagnostics` | GOF/EBE geometry; engine exports consistent with posterior quantiles. |
| Safety of inputs | `test_empty_fields`, `test_stress` | Blank/hostile inputs fail loudly, never silently simulate nonsense. |
| Report | `test_report` | Report structure/fields over a snapshot. |
| UI/UX (static) | `test_usability` | Help keys, fixes, log axis, folded target, links, placeholder. |
| Versioning | `test_version` | `src/version.js` ↔ `package.json` sync and wiring. |

**Adding a suite:** create `tests/test_<name>.js` exporting
`async function run()` that returns `t.summary()`, then add
`require('./test_<name>')` to the `suites` array in `tests/run_all.js`.
Use `tests/util.js` (`u.T` with `.ok/.eq/.close/.closeTo/.info`). Load modules with
`require('../src/<mod>.js')` after `global.ECU = global.ECU || {}` (util.js does this).

**Two gates before calling anything done:**
1. `npm test` → 100% green.
2. `node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

If you change a model parameter, update **both** the spec in `src/model.js` **and** the
expectation table at the top of `tools/verify_control_streams.mjs`, then re-run both.

---

## 12. Conventions, invariants and gotchas

**Conventions**

- Vanilla ES5-style JS modules attaching to `globalThis.ECU`; no imports, no bundler
  (except `build.mjs`, which just concatenates). Keep it that way.
- UI strings are plain-language for clinicians; technical detail goes in the About
  dialog / `title` attributes.
- All model docs cite their source; new capability must be traceable.
- Bump `src/version.js` on every change (and keep `package.json` in step).
- Document user-visible changes in `VALIDATION.md` (it is the authoritative changelog).

**Gotchas that have actually bitten us**

1. **Time units.** The engine is in *days*; the UI converts ms→days in `relContext()`.
   Passing raw epoch-ms into `runFit`/`buildGrid` makes the grid loop iterate ~10⁸
   times and V8 throws a cryptic *"Too many properties"* error. (A unit-sanity guard
   is a known nice-to-have — see §15.)
2. **Weight is mandatory.** `runFit` throws for weight outside 35–200 kg; without it
   allometric scaling would silently evaluate to zero clearance.
3. **LLOQ required for censored samples.** Any `obs[i].lloq` without `lloq > 0` throws.
4. **`runFit` mutates the selected drug** (`M.select(drug)`). Restore it in tests.
5. **A malformed CSS rule silently swallows everything after it.** An unclosed `.note {`
   once killed all later styles, which made the ⓘ popovers invisible in some browsers.
   Keep `app.css` braces balanced (the popover/modal/stepper styles are all downstream
   of each other).
6. **`complementtdm.html` is generated.** Tests read `index.html`/`src/*`; the artifact
   only matters for the user. Always rebuild after source edits.
7. **`esc()` everything** that comes from the user before it reaches HTML.
8. **No DOM in tests.** Keep engine code DOM-free and guard UI code with
   `typeof document !== 'undefined'` so `require('../src/ui.js')` works in Node.
9. **Chart legend** uses a crude text-width estimate; at very narrow widths labels can
   touch. Cosmetic, pre-existing.
10. **Browser form restoration** on reload restores the drug `<select>`; `init()`
    re-syncs state from it so the prefilled target can't disagree with the shown drug.

---

## 13. How-to recipes

### Add a new drug

1. Obtain its final NONMEM control stream; add the `.txt` to the repo.
2. Add one spec object to `DRUGS` in `src/model.js` (copy an existing spec; fill
   `THETA/EXPO/OMEGA or ETA/SIGMA/INFUSION_D`, covariates, `dose`, `targetDefault`,
   `targetHint`, `assumptions`, `article`, plus `KA_D`/`BIOAVAIL_SC`/`adminRoutes` for
   SC dosing). Transcribe units to **days**.
3. Add the parsed expectations and an independent `$DES` re-implementation to
   `tools/verify_control_streams.mjs`; run it — it must report 0.00% deviation.
4. Add a suite (e.g. `tests/test_<drug>.js`) with structural flags, a steady-state or
   MAP-recovery check, and provenance; register it in `tests/run_all.js`.
5. Nothing else changes: MAP, Laplace, MCMC and the UI are dimension-agnostic.
   (Set `pending: true` to ship a placeholder that is listed but blocked.)

### Change a model parameter
Update `src/model.js` **and** the expectation table in
`tools/verify_control_streams.mjs`; run `npm test` + the cross-check; note it in
`VALIDATION.md`.

### Add a UI field
Add the markup to `index.html` (with an ⓘ `data-help` key and a `title`), read/write it
in `readPatient()`/`syncInputs()`, wire it in `wire()`, add HELP text in `ui.js`, add a
static assertion to `tests/test_usability.js`, then rebuild.

### Add a diagnostic panel
Build it in `src/diagnostics.js` as a pure function over the `fit` object, render it in
`renderResults()` (inside the `diagBlock` details) and in `reportHtml()`, add CSS, and
test the geometry in `tests/test_diagnostics.js`.

### Release a change
1. Bump `src/version.js` (and `package.json`).
2. `npm test` and `node tools/verify_control_streams.mjs`.
3. `npm run build`.
4. Add a dated section to `VALIDATION.md`.

---

## 14. Known limitations and risks

- **Research use only** — not a certified medical device, not prospectively validated.
  The printed report and About both say so; keep it that way.
- **Crovalimab** models the ADA-negative population only; the residual error uses the
  rich-sampling additive term (sparse samples are weighted strongly); the 1-h loading
  infusion is an operational assumption.
- **Ravulizumab** is a *simplified* re-implementation (linear, no IOV, weight-only).
- **Eculizumab aHUS** between-occasion variability is folded into the CL prior
  (occasion effects are not separately identifiable from n = 1 TDM).
- **Sparse SC-only sampling** leaves ka/F only weakly identified — the app reports this
  via shrinkage rather than hiding it.
- **No paediatric/pregnancy/renal-replacement support.**
- **Performance:** a full run is a few seconds in the browser (MCMC-dominated), covered
  by a progress bar; the E2E test is the slowest suite (~60 s).
- **Report formatting** is tuned for A4 print; PDF is via the browser print dialog.
- **Accessibility** is reasonable (aria-expanded, role=status, keyboard popovers) but
  has not had a formal WCAG audit.

---

## 15. Nice-to-have roadmap (candidates for the next agent)

> Items completed in v0.13.0 (multi-chain MCMC + R-hat, Nelder-Mead convergence
> detection, the real calibration study, model/version in the report header, log-axis
> and view-preference persistence via session autosave) have been removed from this
> list — see §17.

**Correctness / robustness**

- A **unit-sanity guard** in `runFit`/`buildGrid` that fails with a clear message when
  timestamps look like milliseconds (see §12.1).
- Separate **occasion-level random effects** for eculizumab aHUS when >1 occasion of
  data is available.
- Optional **crovalimab ADA effect** if a suitable model becomes available.
- Peak-only and mixed sampling designs in `tools/calibration_study.mjs`.

**Validation / governance**

- A prospective-validation dataset and protocol; store results in `VALIDATION.md`.
- A machine-readable **model provenance registry** (source, date, reviewer) and a
  `CHANGELOG.md` generated alongside version bumps.

**UX / product**

- Inline model-provenance tooltip next to the drug selector.
- Optional multi-sample **VPC-style overlay** for expert users (clearly labelled as
  n = 1).
- Screen-reader / WCAG audit; printable PDF export button; i18n (Dutch first).

**Nice to have but out of scope for now:** population-level pooling, dose suggestion
(the product explicitly forbids it), and any server-side component.

---

## 16. Documentation index, disclaimer, contact

- `VALIDATION.md` — validation report + review checklist + version-by-version changelog.
- `MODEL_VALIDATION.md` — model-by-model transcription vs the NONMEM control streams.
- `BAYES_AUDIT.md` — statistical audit of the MAP-Bayesian engine and its resolution.
- `NOVICE_UI_REVIEW.md` — novice-usability review and the resulting UI changes.

**Disclaimer.** Decision-support prototype — **research use only.** Not a certified
medical device and not clinically validated; validation against prospective data should
be performed before routine use. Interpretation requires clinical judgment and local
protocols. The models do not cover paediatric patients, pregnancy, or dialysis-dependent
renal failure. All computation is local; no data is transmitted or stored.

**Developed by Rob ter Heine** · Radboudumc, Nijmegen, the Netherlands ·
[Radboud Applied Pharmacometrics](https://www.radboudumc.nl/en/research/research-groups/applied-pharmacometrics) ·
[r.terheine@radboudumc.nl](mailto:r.terheine@radboudumc.nl)


## 17. What changed in v0.13.0, and why

A six-specialist audit (clinical pharmacology, nephrology, haematology,
pharmacometrics, statistics, interface design) reviewed v0.12.0 independently and
raised ~66 findings. The author triaged them one by one. This section records the
outcome so a later agent does not re-litigate settled decisions.

### 17.1 Fixed — correctness and safety

| # | What was wrong | What was done |
|---|---|---|
| 1 | **The cross-check tool passed against nothing.** `rk4Sim` received `outTimes` as `{t,V}` objects but read `e.t`/`e.V` as flat values, so every reference concentration was `NaN`. `compareConc` tested `rel > worst`, and `NaN > 0` is false, so `worst` stayed 0 and it printed "0.00% deviation · ALL CROSS-CHECKS PASSED" unconditionally. `test_model_verify.js` asserted only `status === 0`, laundering the false pass into a green suite. | Unpack time/volume, carry an explicit observed-compartment index, fail on any non-finite or degenerate reference. **Repairing it immediately exposed two real bugs in the crovalimab reference** that the `NaN` had hidden: it read compartment 0 (the SC *depot*) instead of the central compartment, and omitted crovalimab's allometric scaling (ref weight 75 kg, tested at 70 kg). Both fixed; the test now asserts the reported deviations are present, parseable, strictly > 0 and < 0.02%. Current: eculizumab 2.7e-4 %, ravulizumab 9.2e-6 %, crovalimab 7.2e-7 %. |
| 2 | **Real doses and all decimal concentrations were silently unenterable.** Both add-forms relied on native constraint validation, which runs *before* the submit handler — so an off-grid value meant the handler never fired. `step="1"` on concentration rejected 0.8, 7.3, 12.5 µg/mL (while the app's own formatter displays two decimals below 10). Crovalimab's `min:100/step:50` rejected 340, 680 and 1020 mg — every real maintenance dose. | `step="any"` + `novalidate` on both forms; the drug spec no longer pushes a step grid onto the input; range and plausibility are checked in JS where the messages are ours. |
| 3 | **Crovalimab dosing was wrong.** Spec default was 3400 mg — not a crovalimab dose — and `ssIntervalDefault` was 14 d. | EMA PiaSky posology: 1000 mg IV loading, 340 mg SC weekly ×4, then 680 mg (≥40–<100 kg) or 1020 mg (≥100 kg) q4w. Default 680 mg, interval 28 d. |
| 4 | **A next-dose trough was invented at a hardcoded 14 days** regardless of drug, so a single-dose ravulizumab entry (q8w) reported a trough six weeks early, at a far higher concentration, with P≈100%. | `modalInterval` falls back to the drug's own `ssIntervalDefault`; the projected row is tagged **assumed dose** on screen and in the report, with its interval named. |
| 5 | **No way to keep a sample on record but out of the fit.** A single post-plasma-exchange sample was fitted exactly and became a permanent, confidently-wrong clearance that every diagnostic reported as a good fit. | Per-sample **In fit** toggle plus a free-text reason. Excluded samples stay on the chart and in the report but contribute nothing to the likelihood; `fit.nExcluded` drives an on-screen notice. |
| 6 | **Model assumptions were attached to the wrong drug.** Ravulizumab's list claimed aHUS IOV folding — it has `IOV_CL: 0` and no disease covariate. Eculizumab, which actually does fold IOV, had no `assumptions` array at all, so About showed none for it. | Moved and expanded; a test now asserts every non-pending drug declares at least one assumption. |
| 7 | **Dates carried no year anywhere**, including the printed report, so a mistyped year was invisible while silently re-anchoring day 0. | `fmtDate` includes the year; timestamps outside ~3 years back / 1 year ahead are challenged, naming the parsed date. |
| 8 | **The report was not record-grade.** No app version, no model assumptions, the paediatric/pregnancy/dialysis exclusion sentence present in About but deleted from the report, and the diagnostics graphics printed blank — the report's GOF panel shared `id="gofChart"` with the on-screen one (so only the latter was ever filled) and the shrinkage/EBE/residual graphics are CSS backgrounds dropped by default print settings. | Version + model identity in the header, assumptions block, full exclusion sentence restored, `gofPanel` takes a host id and the report renders into `rpGofChart`, `print-color-adjust: exact` on the affected selectors, and a past/upcoming/assumed status column on the trough table. |

### 17.2 Fixed — how the numbers are described

- **Credible, not prediction, interval.** The 5–95% band is the range of *noise-free* model predictions, so it is a credible interval for the true concentration; the report called it a "prediction interval" while measured points were overlaid on it. A reader would see future measurements fall outside it far more often than 10% and conclude the model had failed. Renamed everywhere, with the exclusion of assay error stated.
- **`etaShrinkage` → `etaInformation`.** The computed quantity (`1 − var(posterior)/var(prior)`) and its plain-language tooltip were both correct, but classical η-shrinkage runs the *other way* — high means the data were uninformative. A pharmacometrician reading "CL 85%" in the report would draw exactly the opposite conclusion. Renamed throughout code, UI, report and README; the value is unchanged.

### 17.3 Fixed — statistical robustness

- **Multi-chain MCMC with split-R̂.** One chain from one start cannot detect failure to converge; ESS measures mixing *within* whatever region the chain found. The iteration budget is now split across 4 chains from starts dispersed ~2 proposal SDs from the mode, pooled, with split-R̂ per eta and a UI warning above 1.05.
- **Nelder–Mead convergence is detected.** `ok` was false only when the *initial* value was non-finite, so a simplex that merely exhausted `maxIter` returned `ok: true` — and its parameters are reported to the user as the patient's individual PK. Now carries `converged`, refits from a dispersed start, and reports `startGap` (the OFV disagreement between starts); both surface as advisories.
- **Diminishing adaptation.** Post-burn-in step-size adaptation used a constant gain, which violates the diminishing-adaptation condition, so the kept chain was not guaranteed to target the posterior. The gain now decays as `1/√(window)`.
- **Acceptance is reported over kept iterations only** (it previously averaged in the adaptation phase and read high — README claimed ~0.3 against an observed 0.46).
- **Batch-means CI uses Student t.** 12 batches carry 11 df, so the 1.96 multiplier made the Monte-Carlo interval ~11% too narrow — in the direction that matters at the 90% badge boundary. Now `t(0.975, nBatches−1)`.
- **`keepEvery` uses `ceil`**, so `maxKeep` is actually honoured.
- **Calibration study.** `tests/test_e2e_fit.js` (N=24) cannot distinguish 90% coverage from 99% — the 95% binomial range at that N is ~75–98% — yet README cited it as calibration evidence, and 96% coverage of a 90% interval indicates *conservative* intervals rather than good ones. It is now explicitly a smoke test; the real study is `npm run calibration` (`tools/calibration_study.mjs`): N≥300, five scenarios across all three drugs including sparse trough-only and aHUS, exact binomial CI, PIT histogram with a uniformity test, and it treats over-coverage as a failure. Its unrealistic 3400 mg crovalimab dose was replaced with the EMA schedule.

### 17.4 New — dose-interval explorer

Routine TDM for these agents is largely about **prolonging the dosing interval**, and
v0.12.0 could not answer that question usefully. The information was there and the model
was right, but extracting it meant hand-entering every future dose and re-running a full
MAP+MCMC fit once per candidate interval — measured at **54 s for five intervals** — while
the default view showed only the current interval's troughs. For a worked case
(eculizumab 900 mg q2w, troughs ~190 µg/mL) the app reported "P ≥ 90%" with no hint that
q3w is borderline and q4w fails.

The posterior does not depend on the future schedule, so every candidate can be evaluated
by pushing the *same* kept draws through a different forward regimen. `B.intervalScan()`
does this on a subsample of the draws — **0.7 s for eight intervals**, reproducing the
manual refits (q21d: 76 vs 78 µg/mL; q28d: 22 vs 22). A collapsed **Dose-interval
explorer** in the Forecast card renders a chart of P(trough > target) against interval
plus a table, reporting two distinct quantities:

- **Next trough** — only the next administration is delayed. Assumes nothing further.
- **Sustained trough** — the patient is continued on that interval until the
  concentration settles.

These can disagree sharply and must not be collapsed: for the worked case at q28d the
next trough is 117 µg/mL (P ≥ 90%) while the sustained trough is 25 µg/mL (P 0%).
Showing only the former would be falsely reassuring at exactly the decision point.

**This does not violate the no-dose-suggestion rule (§3).** It reports consequences for
intervals the clinician asks about; it applies no threshold, marks no interval as
recommended, and says so on screen.

### 17.5 New — data safety, accessibility, UX

- **Session autosave** to `localStorage` (same-origin, never leaves the device) with an
  explicit *Restore / Discard* bar — offered, never applied silently, because quietly
  reinstating another patient's data into a blank-looking form would be worse than losing
  it. Plus a `beforeunload` guard. State previously lived only in a closure, so a
  back-swipe on a ward tablet destroyed an hour of entry.
- **Order-of-magnitude challenges** on dose and concentration (a 10× transposition lands
  inside the permitted range, so the range check alone cannot catch it), a duplicate-dose
  guard, and entry fields that clear after a successful add.
- **Modal focus management** — `openModal`/`closeModal` move focus in, trap Tab, mark the
  page `aria-hidden`, and restore focus to the trigger. Keyboard users previously tabbed
  through an invisible page behind the backdrop, unable to reach the Advice textarea.
- **Contrast** — the 5–95% interval was `#94a3b8` on white (2.56:1, failing WCAG AA) beside
  a full-contrast median; now `#475569` (7.4:1). Same for past rows and weak-parameter keys.
- **Chart text alternative** — `role="img"` with a generated `<title>`/`<desc>` carrying the
  drug, whether the forecast is individualised, and the next trough with its interval and
  probability. A screen-reader user previously got nothing at all from the forecast.
- The below-LLOQ error pointed at the patient card; the LLOQ lives in the Forecast card's
  assay fold. It now opens that fold and focuses the field.

### 17.6 Considered and deliberately NOT changed

Do not re-raise these without new evidence — each was reviewed and rejected by the author:

| Finding | Decision |
|---|---|
| Raise the ravulizumab target from 100 µg/mL (auditor argued for a label-derived 175) | **Rejected** at the time. 100 µg/mL is the threshold relevant when TDM is used to *prolong the dosing interval*, which is this app's purpose (PMID 33512711). Later revised by the author: the shipped default is now 150 µg/mL — still the same interval-prolongation threshold, applied more conservatively; the label-derived 175 remains rejected. |
| Add pharmacodynamic caveats (LDH, free C5/CH50, breakthrough, extravascular haemolysis) | **Rejected.** The exposure–response relationship for these agents is considered solid and robust. |
| Propagate THETA/SIGMA uncertainty into the bands | **Not done** — the covariance data are not available. (Note for a future agent: the crovalimab Table 118 the author holds does carry RSE% per parameter, so this is feasible for that drug if ever wanted.) |
| Use crovalimab's sparse-sampling residual error (SD 14.4) instead of the rich-sampling term (SD 1.01) — a ~203× variance difference, confirmed arithmetically against Table 118 | **Model unchanged by instruction.** The published model must be used as-is. It was already disclosed in `assumptions`; that disclosure now also prints in the report. |
| Model or warn about anti-drug antibodies | **Rejected.** ADA is assumed absent on every occasion, for every drug. |
| Support or warn about switching between C5 inhibitors | **Rejected.** A session models one drug throughout. |
| Re-add the aHUS IOV variance when forecasting a future occasion | **Not done — the folding approach is correct** (doi:10.1111/bcp.13901). Because the split is unidentifiable from one patient's sparse data, folding gives the correct marginal prior for the occasion being fitted. The consequence — that the interval for an *upcoming* dose is therefore somewhat narrower than full occasion-to-occasion predictive uncertainty — is now stated explicitly in About and in the eculizumab assumptions. |

**Verification note.** Every eta and residual-error term in the crovalimab spec was
re-checked against Table 118 of the PiaSky population-PK report and matches exactly
(IIV as variance = CV²; IIV F 1.3456 vs the stored 1.35 is rounding). Unimplemented
Table 118 items, left alone by instruction: `CLs` 0.0341 L/day, `Kd` 0.0144 /day, the
ADA-on-CL covariate, the sparse additive RUV and the IIV on additive RUV. Note the table
is **Run 59 (final model)** while the app transcribes **run05** — worth a look if model
fidelity is ever revisited.

---

## 18. What changed in v0.14.0, and why

**Prompted directly by a clinical-pharmacologist use case.** The v0.13.0 explorer
(§17.4) could answer "what if this patient's interval changes?" but not the equally
common "if I adjust this dose, what is the predicted trough — with its 90% credible
interval — at steady state?" The underlying engine already computed exactly that
number (the `ss` field on every scanned point is precisely the steady-state median +
5–95% credible interval), but there was no way to hold the interval fixed and scan
candidate **doses** instead of intervals.

**What was built.** `src/bayes.js` refactored the interval-scan loop body into a
shared `scanOneRegimen()`, and added:
- `B.doseScan(opts)` — fixed interval, varying dose (the direct answer to the
  question above: the row whose dose matches the one being considered *is* the
  predicted steady-state trough and CI for that change).
- `B.candidateAmounts(current, doseSpec)` — candidate doses snapped to the drug's
  own dosing granularity and clamped to its permitted range (verified to include
  the real 340/680/1020 mg crovalimab doses).

The card (now **Regimen explorer**, `#intervalCard`) gained a **Vary: Interval | Dose**
selector and an editable interval field (`#iv-interval`) alongside the existing dose
field; whichever is not being varied stays fixed at the value entered. Both entry
points share one rendering function (`intervalScanTableHtml`), which is also what the
report calls, so the screen and the printed page can never show different numbers for
the same exploration.

**A defect found while verifying this in the browser, not by inspection.** The first
implementation reused the v0.13.0 "next trough" definition unchanged — the trough
evaluated strictly *before* the next scheduled administration. For an interval change
that is correct (the longer gap already shows up there). For a **dose** change it is a
tautology: a trough measured before a dose is given cannot possibly depend on that
dose's amount, and indeed every candidate dose produced the numerically identical
"next" value (169 µg/mL regardless of 650, 1300 or 2600 mg) — technically correct,
completely uninformative, and easy to mistake for a bug rather than a definition
problem. Fixed by evaluating "next" one cycle later for a dose scan (`nextCycle=2`,
i.e. after the first administration at the new amount rather than before it); interval
scanning is unaffected (`nextCycle=1`, unchanged). `tests/test_v014.js` pins the
regression directly: it asserts the pre-fix invariance would fail
(`next.med` must differ by >50 µg/mL between a 650 mg and a 2600 mg candidate) and that
interval-scan's steady-state numbers are bit-identical to before the refactor.

**Report inclusion.** The v0.13.0 explorer was `no-print` and never reached the
printed page even when a clinician used it to decide on a regimen change — a
significant gap given the underlying question ("what should this dose be changed to")
is exactly the kind of reasoning a record should capture. `reportHtml()` now prints a
**Regimen exploration** section whenever `fit.intervalScan` is set (i.e. only when the
clinician actually ran one), visually and textually separated from the individualized
forecast above it, with an explicit "this is not the forecast above… not a treatment
recommendation" note repeated in print.

**Terminology.** "Sustained trough" renamed to **"Steady-state trough"** throughout
(table headers, legends, help text) — the standard pharmacometric term, and the one a
clinical pharmacologist would expect; §17.2's `etaShrinkage`→`etaInformation` rename
follows the same logic of using the term of art rather than an approximate synonym.

**Design rationale for presentation (why it looks the way it does).** Per the
originating question — "let a clinical pharmacologist say how to present these data" —
the design follows three rules a pharmacometrician would apply to any MIPD output:
1. **Never collapse "next" and "steady state" into one number.** They can disagree by
   a factor of several-fold for a drug that accumulates (eculizumab, q28d worked
   example: next 117 µg/mL P≥90% vs steady-state 25 µg/mL P 0%), and showing only the
   optimistic one is the specific failure mode this feature exists to prevent.
2. **Always pair the median with its 90% credible interval**, never the point estimate
   alone — consistent with the rest of the app (§9) and with how the original interval
   explorer was built.
3. **State explicitly that this is exploration, not a recommendation**, both on screen
   and in print, every time — the app's absolute no-dose-suggestion rule (§3) does not
   bend for this feature; it reports consequences for regimens the clinician names, and
   marks none of them as preferred.

---

---

## 19. What changed in v0.15.0, and why

Direct feedback from the author using his own app, addressed with a three-reviewer
process: an experienced UI designer, a clinical pharmacologist, and a code reviewer
who specifically hunts for landmines each wrote an independent brief on the same six
items; all three converged cleanly (no conflicting recommendations), and the synthesis
below is what shipped.

**19.1 The forecast chart no longer implies therapy has stopped.** The plotted
concentration curve was built only from the clinician's real entered doses, so past the
last of them it could only wash out toward zero — for a q8w maintenance drug, this
looked exactly like a failing regimen or a patient taken off therapy, even mid-course.
`runFit` now runs a **separate, display-only** simulation (`chartBand`/`chartPriorBand`/
`chartProjectedDoses` in `src/bayes.js`) that continues the regimen at the patient's own
historical dose and interval, filling the plotting horizon. This is a genuinely separate
computation from the fit: `ctx.doses` (what MAP/MCMC sees), `troughs`/`troughStats`
(the trough table), and `fit.band`/`fit.priorBand` (kept for any other consumer) are
**all untouched** — verified directly in `tests/test_v015.js`, which checks the
individual clearance and every trough are bit-for-bit identical whether or not the
chart continuation runs. (`virtualTroughTime` lands one instant *before* the projected
dose's own administration time, so it is causally blind to it regardless — PK cannot
see a dose before it is given.) The projected dose is drawn as a light dotted amber
line, legended **"Projected dose (not entered)"**, distinct from both the real "Dose"
line and "Today" — never implying a recommendation to continue at that regimen.

**19.2 "Posterior"/"Prior" renamed to "Individual prediction"/"Population prediction"**
on the chart, its legend, and the report's Fit quality table ("Clearance (individual)",
not "(posterior)") — a clinician reading this while dosing a patient should not need to
know what a posterior distribution is. The **statistical exposition** ("How this was
calculated", the About dialog, "N posterior draws, ESS ≈ …") deliberately keeps the
technical terms — that text is explicitly explaining the method, so the vocabulary is
appropriate there; only the headline results were renamed.

**19.3 Band z-order fixed.** The wider population band was pushed into the chart's
`bands` array *after* the narrower individual band, and SVG paints in array/DOM order —
so the wider, paler band was painted **on top**, muting the individually-informative
band underneath it in the overlap region, and making the population band read as barely
present. Swapping the push order (population first/underneath, individual
second/on top) was the entire fix — no alpha or color change needed once the order was
corrected.

**19.4 Regimen explorer promoted to its own numbered card (4).** It was a collapsed
`<details>` fold nested inside card 3 ("Forecast"), which undersold a feature the author
uses routinely and broke the "three visible steps" mental model the numbering
establishes. It is now `<div class="card" id="regimenCard">` with
`<h2><span class="stepnum">4</span> Regimen explorer</h2>`, matching cards 1–3 — and,
like cards 2–3, it is **always visible** rather than hidden until a fit exists: with no
fit yet, the Explore button is disabled and the panel says "Run a forecast in card 3
first" (the same disabled-with-a-reason pattern the Run button itself already used).

**19.5 The regimen-explorer chart no longer plots "changing the next dose only."** Two
overlapping lines answering different questions (steady state vs. one changed dose)
read as clutter; the steady-state curve is the one that matters most of the time. The
**"Next trough" table column is unchanged** — nothing computed is lost, only the graph
is simplified. (The clinical pharmacologist's brief flagged one scenario where "next"
specifically matters — judging whether a single interim dose correction worked before
steady state is reached — which is exactly why the column, not just the number, stays.)

**19.6 Fit diagnostics moved from an inline `<details>` to a modal.** A small button
next to the individualized parameters (`Fit diagnostics <hint> ›`) opens it, reusing the
`openModal`/`closeModal` focus-trap infrastructure built in v0.13.0 for the About/Print
dialogs — no new modal pattern was invented. **The landmine the code reviewer's brief
caught:** `renderDiagnostics`'s point↔residual-row hover-sync was hardcoded to
`document.querySelectorAll('#diagBlock .res-row')`; removing `#diagBlock` (the old
`<details>`'s id) without updating that selector would have made hover-sync silently
match nothing, forever, with no error — the classic "worked in dev, dead in prod" bug
this specific reviewer persona exists to catch. `renderDiagnostics` now takes the
rows-container id as a parameter; the on-screen path scopes it to the modal body
(`diagModalBody`) and the printed report scopes it separately to its own container
(`rpDiagBody`) — the report's own diagnostics chart (`rpGofChart`) is unaffected either
way, confirmed by rendering the printed report end-to-end in the browser.

**Process note.** All six items were reviewed by three parallel specialist agents (UI
design, clinical pharmacology, code quality) before any code was written, matching the
process used for the v0.13.0 audit. Their recommendations converged without conflict —
notably, the code reviewer independently derived the same "population underneath,
individual on top" z-order fix the designer proposed, and caught the diagnostics
hover-sync landmine that neither the designer's nor the pharmacologist's brief could
have been expected to find.

---

---

## 20. What changed in v0.16.0, and why

The novice stepper (under the header) showed four numbered steps — 1 Enter weight,
2 Add doses, 3 Add samples (optional), 4 Run forecast — independent of, but
coincidentally the same count as, the four numbered cards below it (1 Drug & patient,
2 Dosing schedule & measured concentrations, 3 Forecast, 4 Regimen explorer). Once card
4 was added in v0.13.0, "4" meant two different things on the same screen: the
stepper's "Run forecast" and the card structure's "Regimen explorer". Fixed by merging
the stepper's "Add doses" and "Add samples" into one step 2 (both already live in card
2), giving a 3-step stepper — 1/2/3 — that matches cards 1/2/3 exactly. Card 4 gets no
onboarding step: it's a downstream tool used after a forecast exists, not part of the
minimum path to a first result. No functional change — `updateStepper()`'s completion
logic is otherwise identical.

---

## 21. What changed in v0.17.0, and why

Prompted by the author testing the app on his own phone. A senior UI designer and an
HTML/CSS engineer independently reviewed the actual CSS and markup (not a redesign from
scratch) and produced two briefs; this section records what was reconciled from them
and built. Full plan preserved as a published artifact referenced in the project
history; nothing here is new scope beyond that plan.

**21.1 The central problem: charts are one SVG string with the font size baked in.**
`src/chart.js` built every chart — forecast, regimen explorer, diagnostics scatter — as
a fixed-viewBox SVG (960×440 for the main chart) with literal `font-size="12"`
attributes in the `<text>` elements, scaled to its container via
`style="width:100%"`. On a 1440px desktop that's crisp 12px text; squeezed into a
~340px phone card, the same markup renders at roughly 4–5 actual screen pixels.
Continuously scaling one wide layout down cannot fix this.

**Fix:** `chart.js`'s `render(el, cfg)` now takes an optional `cfg.compact` flag and, when
set, draws a genuinely different narrow layout — larger fonts (12→15 for ticks, 11.5→14
for the legend), fewer ticks (y: 6→4, x: 8→4), the rotated y-axis label dropped
(redundant next to the legend/title, and the space is worth more than the label), and
the legend moved from a single top-right row to a **wrapped, multi-row block below the
plot** — the single-row right-to-left layout cannot fit this app's legends (up to 6
items) at any font size that reads on a phone. The compact layout's height is *derived*,
not guessed: `countLegendRows()` runs the identical greedy-wrap packing the legend
renderer itself uses, *before* the bottom margin is sized, so a 2-item legend and a
6-item one each get exactly the height they need — verified in `tests/test_v017.js` by
asserting no `<text>` y-coordinate ever exceeds the computed viewBox height, across
0-, 2- and 6-item legends. The desktop path (`cfg.compact` omitted) is byte-identical to
pre-v0.17.0 output — confirmed directly, not just "no visible difference."

The caller (`src/ui.js`) decides compact from the **container's own `clientWidth`**
(never `window.innerWidth` — a card's padding makes its available width narrower than
the raw viewport), via a shared `isCompactWidth()` helper at a 480px threshold. Every
chart call site (`renderChart`, `renderIntervalScan`, `renderDiagnostics`) now measures
its own host and re-renders on a debounced (~180ms) `window resize` — cheap, because
these are pure string builders over a fit whose MAP+MCMC has already run; nothing gets
refit on resize.

**21.2 A landmine that would have silently corrupted the printed report.** The report
used to clone whatever SVG happened to be sitting in the live `#chart` div
(`document.getElementById('chart').querySelector('svg')`). Once the chart could render
compact, printing from a narrow browser window would have baked the phone-sized chart
into the fixed-A4 report. Fixed by rendering the report's chart into a **detached**
`<div>` (`renderChart(offscreenChart, false)` — the new second parameter forces
non-compact regardless of the live viewport), harvesting its SVG, and discarding the
element — the live, possibly-compact, on-screen chart is never touched. Verified in the
browser: at a 375px viewport, the live chart's viewBox was `340×407` while the same
click's generated report chart was `960×440`. The diagnostics chart's print path already
hardcoded `560×400` before this release (`renderDiagnostics`'s existing behaviour); it
now takes an explicit `forceCompact=false` parameter instead of an unconditional
hardcode, so the same guarantee is explicit rather than incidental.

**21.3 Three pre-existing table/touch-target gaps, found while doing this work.**
- The regimen-explorer's results table (5 columns) had **no scroll wrapper at all** —
  unlike the dose and measurement tables. It overflowed a phone viewport today, before
  any of this release's redesign, with no scroll affordance.
- The diagnostics modal's residual-sample table had the same gap.
- The trough table had the same gap too.

All three now sit in `<div class="tbl-wrap">` on screen (`overflow-x:auto`); the print
copies deliberately stay unwrapped, since print doesn't scroll and already has its own
sizing rules (`.rp-table`).

**21.4 Row-wise tables become cards below 560px.** The trough table and the
regimen-explorer table are row-wise comparisons — each row is one candidate, read
across its own columns — so horizontal scroll is the wrong pattern: a clinician
shouldn't have to scroll sideways to see a probability next to the dose it belongs to.
Below the phone breakpoint both convert to stacked label:value cards via **CSS alone**:
every `<td>` already carries a `data-label` attribute written at render time
(`data-label="Steady-state trough"` etc.), and `table.data.responsive-cards tbody
td::before { content: attr(data-label); }` supplies the label — one `<table>` markup
serves both the desktop table and the phone card layout, so print is unaffected and
there is no second code path to keep in sync.

**21.5 Breakpoints consolidated.** Three ad hoc, single-purpose media queries at two
different values (700px once, 560px twice, scattered across the file) collapsed into
exactly one `@media (max-width: 700px)` and one `@media (max-width: 560px)` block, each
documented with what the two tiers mean: 700px is a light touch (form rows that pair a
date with a number stack instead of forcing two cramped columns); 560px is where the
real restructuring happens (grids collapse, tables become cards, the header becomes a
grid, touch targets grow). No property existed in both duplicate blocks being merged —
checked before merging, not after, per the responsive plan's own risk list.

**21.6 Header and touch targets.** The header's four actions (About / Print report /
Export / Import) stay as four buttons rather than collapsing to a menu — this is a
clinical tool used a handful of times per session, and hiding "Print report" behind a
tap, or risking a mistapped icon on session export/import, costs more than a clean 2×2
grid does below 560px. Three controls measured under a comfortable touch target got
padding or (where `box-sizing:border-box` made padding-alone ineffective on a
fixed-size element) explicit dimension increases: the ⓘ popover buttons (16×16px →
30×30px), the modal close button, and the stepper's "dismiss" link.

**21.7 What did not change.** No model parameter, likelihood term, MCMC/Laplace code,
or drug spec — this release is presentation only. `main.layout`'s single-column card
stack, the existing `.tbl-wrap` pattern on the dose/obs tables, modal max-width
behaviour, and the numbered-card information architecture were all confirmed already
correct for both phone and desktop and were deliberately left alone.

**Process note.** Reviewed by two parallel specialist agents (a senior UI designer, an
HTML/CSS engineer) grounded in the actual current CSS/markup before any code was
written — matching the process used for v0.13.0 and v0.15.0. Both independently flagged
the chart-legibility problem as the central issue and converged on the same mechanism
(container-width-aware re-render, not continuous CSS scaling); the coder's brief
additionally caught the print-landmine in §21.2 and the two unwrapped tables in §21.3
that the design-only brief could not have been expected to find by inspection alone.

---

---

## 22. What changed in v0.18.0, and why

Direct feedback from the author, with a screenshot: on a wide desktop browser window,
the amber "unsaved session" restore bar and the yellow novice stepper both visibly bled
to the browser's left and right edges, while the white cards below them sat in a
centered column with a large grey gutter on both sides. "Shouldn't the bar that can be
dismissed be just as wide as the other blocks?"

**Root cause.** Both `#restoreBar` and `#stepper` lived *outside* `<main class="layout">`
— direct children of `<body>`, immediately before `<main>` opened — with their own
independently-tuned `max-width` (1180px and 1720px respectively) and `margin: … auto`
for centering. `main.layout` itself is `max-width: 1180px; margin: 0 auto`, with its own
18px horizontal padding creating the inset the cards (its flex children, which set no
width of their own — they simply stretch to fill it) visibly sit inside. Two independent
box models, tuned to *look* similar, is exactly the kind of thing that only approximately
matches: below 1180px+36px of viewport width the bars filled the full available width
(no `max-width` constraint reached) while the cards stayed inset by main.layout's own
padding; above it, `.stepper`'s 1720px cap meant it could be wider than the cards even
once both were "centered."

**Fix:** moved both `<div>`s to be the first two children *inside* `<main class="layout">`,
before the first card, and deleted their own `max-width`/`margin` rules entirely. They
now get their width from the exact same mechanism the cards already use — flex-stretch
inside `main.layout`'s `display:flex; flex-direction:column` — so they are *structurally*
guaranteed to match the cards' left and right edges at every viewport width, not tuned to
approximate it. Verified directly (not just visually): at a 673px test viewport, all
three elements' `getBoundingClientRect()` returned identical `left`/`right`/`width`.

**One extra polish, not strictly requested but consistent with the fix:** `.stepper` had
been styled as a flat, edge-to-edge banner (background colour + a bottom border only, no
side borders or rounded corners), which suited its old full-bleed position but would have
looked visually inconsistent sitting in the same inset column as the cards and the
already-boxed restore bar. It now gets a full border and border-radius matching that
convention. `.restore-bar` already had this styling, so it needed no visual change beyond
the width fix.

No functional/behavioural change — `updateStepper()`, `offerRestore()`, and the print
rules that hide both elements (`#stepper, #helpPop, … { display: none !important; }` and
`.restore-bar { display: none !important; }`) are ID/class selectors, unaffected by
moving the elements to a new parent.

---

---

## 23. What changed in v0.19.0, and why

Two pieces of direct author feedback on the regimen explorer and the stepper.

**23.1 Regimen-explorer intervals are now always whole weeks.** `B.candidateIntervals()`
generated candidates by applying fractional multipliers (0.75×, 1.25×, 1.5×, ...) to the
current interval and rounding to the nearest whole **day** — arithmetically reasonable,
but it could and did produce non-week values: 14 days × 1.25 = 17.5, which rounds to 18,
not a multiple of 7. An "every 18 days" or "every 6 days" regimen is clinically
undoable — it drifts across weekdays every cycle (a Monday infusion becomes Wednesday,
then Friday, ...), and every real regimen for these agents is in fact quoted in weeks
(q2w, q4w, q8w...), never in an odd number of days.

**Fix:** candidates are now built directly from a spread of **week** offsets around the
current interval (itself first rounded to the nearest week), rather than fractional
day-multipliers snapped afterwards. The old post-hoc rounding also collapsed several
multipliers onto the same week for a short baseline — 0.75× and 1× of 14 days both round
to 2 weeks — losing candidates exactly on the *prolongation* side, this app's primary use
case. The new spread (`[-1, 0, 1, 2, 3, 4, 6, 8]` weeks) gives 7–8 distinct candidates for
every baseline tested (7, 10, 14, 21, 28, 42, 56, 84 days), always favouring longer
candidates over shorter ones, and every single one is exactly divisible by 7 —
`tests/test_v019.js` asserts this directly for eight baselines plus an end-to-end
`intervalScan()` run, rather than trusting the arithmetic by inspection. `B.doseScan()`
(the *dose*-varying mode) is unaffected: it keeps the clinician's own entered interval
fixed exactly as entered, whatever it is — only the interval-scan candidates are subject
to the weekly constraint, since only those are *proposed* by the app rather than entered
by the clinician.

**23.2 The stepper reaches step 4 again.** v0.16.0 deliberately dropped a fourth stepper
step on the reasoning that the regimen explorer (card 4) is a downstream, optional tool
with no "onboarding" moment of its own. Feedback was that the stepper should still count
to 4, matching the fourth numbered card, the same way steps 1–3 already match cards 1–3.
Re-added as `<i>4</i> Explore regimen (optional)` — gated on step 3 (Run forecast) being
done first, exactly as step 3 is itself gated on steps 1–2, and marked "done" the moment
`state.fit.intervalScan` is set (i.e. the clinician has actually run an exploration, not
merely opened the card). No change to the rule that the explorer is optional and
downstream — only to whether the stepper counts it.

---

## 24. What changed in v0.19.1, and why

**24.1 A custom trough target was silently lost when an autosaved session was restored.**

The app has two paths that rehydrate a whole session: `applySession()` (the localStorage
autosave behind the "Restore" bar) and `importJson()` (an exported `.json` session file).
They disagreed about ordering, and only one of them was right.

`applyDrugUI()` resets the trough target to the selected drug's default — in both the DOM
field and `state.target.value`. That is deliberate and load-bearing: the drug-switch
handler has no other mechanism for moving the target when the model changes, and the
difference is not cosmetic (eculizumab 75 vs ravulizumab 150 µg/mL drives the forecast,
the P(trough > target) column and the plot's target line). `importJson()` therefore called
`applyDrugUI()` **first** and assigned `state.target` afterwards, so the drug defaults were
laid down and then overwritten by the session's own value. `applySession()` did the
opposite — assigned `state.target`, then called `applyDrugUI()`, which promptly destroyed
it. Restoring an autosaved session reverted a clinician-entered target to the drug default,
with no error and a UI that looked entirely correct.

Because the two paths disagreed, the bug was invisible to anyone testing with the JSON
export, which is how it survived several releases.

**Fix:** `applySession()` now follows `importJson()`'s ordering contract exactly —
`applyDrugUI()` lays down the drug-scoped defaults, the session's own values are applied on
top (including the same `!(value > 0)` guard against a corrupt stored target that
`importJson()` already had), and `syncInputs()` then pushes them to the DOM. The two
restore paths **converge** rather than diverging further. The `state.target` assignment
also had to move, not just the two calls be swapped: `applyDrugUI()` overwrites the state
as well as the field, so reordering the calls alone would have left `syncInputs()` writing
the drug default into the field.

The other candidate fix — making the prefill in `applyDrugUI()` conditional on "no target
entered yet" — was rejected: it fixes this bug and breaks drug switching, since that path
depends on the reset being unconditional. `tests/test_session_restore.js` pins both halves,
so that fix cannot be applied silently later.

**On the test.** `src/ui.js` needs a DOM and this suite is deliberately Node-only (see
`tests/util.js`, which loads only `model.js` and `bayes.js`), so the assertions are
structural: they slice `applySession`, `importJson` and `applyDrugUI` out of the source and
pin the call/assignment order within each. The ordering invariant *is* the fix, so pinning
the order pins the behaviour. Per golden rule 7b, the suite was written first and confirmed
to fail against the pre-fix code — 16 passed, 2 failed, on exactly the ordering assertion
and the divergence-guard assertion — before the fix was applied.

---

## 25. What changed in v0.20.0, and why

**25.1 Optional time-dependent weighting of older samples.** A new advanced fitting
option, **off by default**. Switched on, each measurement's proportional residual error is
inflated according to how long ago it was taken:

```
v_i = [ADD + PROP·pred²]·errMult²  +  IOV_CL·(1 − e^(−age_i/τ))·pred²
```

*Rationale.* A patient's clearance drifts between occasions, so part of the apparent
misfit of a months-old concentration is drift rather than measurement error. Treating it
as measurement error — which is what inflating σ does — lets the fit lean on recent
samples without discarding old ones.

*Why this shape, and not "+x% per month".* Three properties, each asserted in
`tests/test_v020.js`:

1. **Zero at age 0.** The newest sample is never discounted, under any tier.
2. **It saturates** at `IOV_CL`, the drug's own published between-occasion variance. An
   old sample is down-weighted but *never discarded*, and the ceiling therefore comes from
   the model rather than from a chosen constant. An unbounded ramp asserts that a two-year-
   old sample is worthless, which the variance decomposition contradicts: the permanent
   between-patient component does not decay at all.
3. **Proportional, not additive.** A clearance perturbation produces a multiplicative error
   in concentration, so the functional form matches the mechanism. The additive assay term
   is left alone — assay error does not age.

Only τ is a setting. **Low = weak discounting = long τ**: low 1095 d, medium 365 d, high
122 d (×3 spacing, round clinical units). At three months these add roughly 12% / 16% /
24% CV on top of the assay error. That direction is the single most likely thing for a
later refactor to invert, so it is pinned numerically rather than left to the labels.

*Scope.* `IOV_CL` is 0 for eculizumab/PNH, ravulizumab and crovalimab, so for those the
option is an **exact** no-op and the control is disabled with the reason shown inline —
visible but unavailable, rather than hidden. Borrowing eculizumab's 0.112 for the others
would be cross-drug extrapolation of a variance component, the same move the project
already declines for ADA and drug switching. Availability is decided by `M.iovVar()`, the
same predicate `M.priorOmega()` uses to fold IOV into the prior, so the two cannot drift.

*What τ is not.* It is not taken from any publication, and it is **never estimated from
the patient's own data**: with the handful of samples a real case carries it is not
identifiable, and because the app uses an exact Gaussian likelihood with its log-variance
term, a free inflation parameter would simply be driven up until the residuals vanished.
Keeping it a deterministic function of each sample's age also keeps `log(v)` constant in
η, so the optimiser cannot game it.

*Limitations, documented in About rather than buried.* The source model treats occasions
as exchangeable — it contains no timescale at all — so any τ > 0 asserts more persistence
than the publication itself supports; the presets are a clinical judgement, not a fitted
quantity. The discount is applied as residual error while the occasion variance remains
folded into the clearance prior, so the reported credible intervals are, if anything,
somewhat *narrower* than a full occasion-level treatment would give: the existing caveat
about a future-occasion trough applies with more force when the option is on, not less.
Two samples from the same past occasion are treated as independent, which over-weights
them slightly. The inflation applies to the whole residual, so it also discounts what an
old sample said about volume, which does not drift between occasions. And age is not
relevance: a sample is often old *because* the patient was stable, and a recent one drawn
*because* something changed — the per-sample exclude flag remains the right instrument for
"this sample is unrepresentative".

*Disclosure.* The setting is never silent. An on-screen advisory names τ and how many
samples were affected; the report carries the setting, the formula, and each sample's
**realised** weight at its own individual prediction — the preset name alone is not
auditable, the per-sample number is.

*Age is measured from the newest fitted sample*, not from the wall clock. A session must
refit to the same numbers tomorrow, and a report must be reproducible from its own JSON
export; anchoring to `Date.now()` would break both and make the golden suite
time-dependent.

**25.2 Advanced options split into assay settings and fitting options.** "Advanced options
(assay)" held the LLOQ and the assay error multiplier in the Forecast card. Those are
properties of the *assay*, not of the fit, and the LLOQ in particular was two cards away
from the "< LLOQ" checkbox that requires it — a gap the code papered over with a special
case that opened the fold and re-focused the field. Both moved into their own **"Assay
settings (LLOQ, error multiplier)"** fold in card 2, directly below the measurements;
card 3's fold became **"Advanced fitting options"** and holds the new control alone. The
markup moved verbatim, so the existing usability assertions that pin its ⓘ buttons,
`title`s and legend note still hold.

The control is a native `<select>`, not a segmented group: four options with these labels
wrap 2+2 at 375 px into an ambiguous two-row widget, whereas a select is one full-width
31 px target that opens the OS picker, gets label/keyboard/AT behaviour for free, and can
be disabled in one line — which §25.1's scope rule requires.

**25.3 Two bugs found by driving the built artifact, not by reading the code.**

- The hint line quotes τ, but the `change` handler read the new preset and marked the
  forecast stale without refreshing it — so choosing "High" left "All measurements are
  weighted equally" on screen under a control that now said High.
- **In steady-state mode the relative-time origin is the latest dose, so every sample taken
  before it has a negative time.** The per-sample bookkeeping seeded its "newest sample"
  scan at 0, which for an all-negative schedule is later than every actual sample: the
  newest one was reported as slightly aged and slightly discounted on a fit that had
  correctly left it alone, and the advisory said "2 of 2 measurements" where the truth was
  1 of 2. `makeOfv` was never affected — it takes the true maximum of the sorted times — so
  this was a disclosure bug rather than a fitting one, which arguably makes it worse.
  Both are now pinned by assertions that were confirmed to go red against the broken code.

**On verification.** Per golden rule 7b, every numeric assertion in `tests/test_v020.js`
was checked against deliberately sabotaged code before being trusted: removing the
inflation term turns 5 assertions red, dropping the `recency:` line from the `runFit`
input object turns 1 red, and restoring the old `recNewest = 0` seed turns 4 red. The
closed-form assertion reconstructs the exact OFV difference between "off" and each tier
from first principles, so it also catches a term placed inside `errMult²`, applied before
the variance floor, or missing its log-variance penalty.

---

## 26. What changed in v0.21.0, and why

**26.1 The weighting of older samples is now a residual-error setting, and nothing else.**

v0.20.0 shipped §25.1 with the magnitude of the discount taken from each model's
between-occasion clearance variance, `IOV_CL`. That was the wrong level of the model, and
the author said so directly: **IOV is an OMEGA term; residual error is SIGMA.** Down-
weighting an old measurement is a statement about how much to trust that measurement — a
Σ-level claim — and tying it to a random-effect parameter had one immediately visible
consequence: `IOV_CL` is 0 for eculizumab/PNH, ravulizumab and crovalimab, so the option
was disabled in three of the four drug/disease combinations, with an explanation that
correctly described the implementation and completely missed the point.

v0.21.0 re-expresses it as what it always should have been: **the existing assay-error
multiplier, made time-dependent.**

```
SD_i   = SD_base(pred_i) · errMult · m(age_i)
m(age) = 1 + (M − 1) · (1 − e^(−age/365 d))
```

The preset sets **M**, i.e. how much the residual error grows: low ×1.5, medium ×2, high
×3. The time constant is shared, so the three tiers have the same shape and differ only in
strength. `errMult` and `m` compose on the SD, because they do the same thing to it.

What this buys, beyond correctness of framing:

- **It applies to every drug and every disease.** Nothing is consulted from the model's
  random-effect structure. The multiplier for a 365-day-old sample is byte-identical
  across eculizumab (both diseases), ravulizumab and crovalimab, and the test asserts
  exactly that.
- **The realised weight is exactly 1/m².** Because the multiplier acts on the SD rather
  than adding a variance term, a sample's relative weight no longer depends on its
  concentration — which makes it simple to state, simple to print, and simple to audit.
  At medium, a year-old sample carries 37% of its normal weight; at high, 20%.
- **The two invariants that motivated the shape survive.** m(0) = 1 exactly, so the newest
  sample is never inflated; and m saturates at M, so an old sample is down-weighted but
  never discarded.

| age | low (×1.5) | medium (×2) | high (×3) |
|---|---|---|---|
| 1 month | 0.93 | 0.86 | 0.75 |
| 3 months | 0.81 | 0.67 | 0.48 |
| 6 months | 0.70 | 0.51 | 0.31 |
| 1 year | 0.58 | 0.38 | 0.20 |
| saturation | 0.44 | 0.25 | 0.11 |

(relative weight, 1/m²)

Neither M nor the 365-day time constant is taken from a publication, and neither is ever
estimated from the patient's own data — with the handful of samples a real case carries
neither would be identifiable, and a free inflation parameter would simply be driven up
until the residuals vanished. Both are deterministic functions of a sample's age, so
`log(v)` stays constant in η and the optimiser cannot game them. They are a clinical
judgement about how much to trust older measurements, made explicit and printed in the
report.

**Two cautions, stated in About rather than buried.** Widening the residual error widens
the reported credible intervals, so a forecast made with this option on is *less* certain,
not more — the honest consequence of leaning on fewer samples. And age is not the same
thing as relevance: a sample is often old because the patient was stable, and a recent one
drawn *because* something changed. The per-sample exclude flag remains the right instrument
for "this sample is unrepresentative".

**26.2 What was removed.** `M.iovVar()` stays in `src/model.js` — it is a genuine
de-duplication of the predicate `priorOmega()` uses to fold IOV into the aHUS clearance
prior, and that behaviour is unchanged — but nothing in `src/bayes.js` or `src/ui.js`
consults it for this feature any more, and `tests/test_v021.js` asserts that directly. The
availability gate (`recencyApplies`, `syncRecencyAvailability`) is gone; the control is
never shipped disabled. `tests/test_v020.js` is replaced by `tests/test_v021.js`.

**On verification.** Two sabotages were used to confirm the suite can go red: removing the
multiplier from `makeOfv` turns 8 assertions red, and inverting the low/high ceilings turns
4 red. The closed-form assertion reconstructs the exact OFV difference between "off" and
each tier from first principles — deliberately on **eculizumab/PNH**, the combination
v0.20.0 refused to apply this to — so it also catches a multiplier squared in the wrong
place, applied before the variance floor, or missing its log-variance penalty. The feature
was then driven end-to-end in the built artifact on **ravulizumab**, which has no IOV term
at all: a 420-day-old sample correctly reported at 18% of its normal weight.

---

## 27. What changed in v0.22.0, and why

**27.1 The population prediction band is no longer shown once an individual fit exists.**

Direct author feedback: the forecast chart plotted the population 5-95% band underneath
the individual band whenever measurements had been fitted (a v0.15.0 fix improved the
paint order so the narrower individual band was not muted, but both were still drawn).
Once a fit has used the patient's own measured concentrations, the population range is no
longer the relevant uncertainty for that patient, and showing it invited exactly the
misreading a clinician must not make: that the wider population range still matters
alongside the individual one.

**Fix.** `renderChart()`'s `fit.hasObs` branch (already the correct, existing gate —
`obsFit.length > 0`, true precisely when an individual fit was actually performed) no
longer pushes the population band or its legend entry at all; only the individual band is
drawn. The y-axis scaling was updated to match: it now folds in the population band's
range only when that band is actually being plotted, so a wide, invisible population band
can no longer stretch the axis and visually flatten the individual band that replaced it.
**Nothing changes when no concentration data have been added** (`hasObs === false`) — that
remains a pure population forecast, and the population band is the only thing there is to
show.

The same `renderChart()` function builds the printed report's chart (offscreen, then
grabbed as an SVG — see `reportHtml()`), so the fix applies to the printed report
automatically; both were verified directly in the built artifact via `rp-generate`, the
report's actual generation path (`window.print` stubbed out so the header-less browser
used for verification does not hang on the native print dialog).

**27.2 A now-obsolete assertion was rewritten, not deleted.** `tests/test_v015.js` had
pinned the *paint order* of the two bands ("population pushed before individual, so it
paints underneath") — that assertion is meaningless once the population band is not pushed
at all in the `hasObs` branch, and was replaced with one that pins the individual band is
still drawn there; the file's changelog comment records the supersession and points to
`tests/test_v022.js` for the current behaviour.

**On verification.** `tests/test_v022.js` slices `renderChart()`'s two branches directly
out of the source (correcting an initial brace-matching bug in the test itself, caught
immediately by a wrong string coming back) and asserts the population band and its legend
entry are absent from the `hasObs` branch while still present, unchanged, in the no-data
branch; a companion engine-level check confirms the individual and population medians
genuinely differ once a fit has used real data, so hiding the population band is hiding
real, different information rather than a no-op. Per golden rule 7b, reintroducing the
population band into the `hasObs` branch was confirmed to turn 2 assertions red before the
fix was trusted.

---

## 28. What changed in v0.23.0, and why

First implementation batch from `INDEPENDENT_AUDIT.md`'s second-pass review (F2, F3, F11 — see
that file's own severity/ordering notes for how this batch was chosen).

**28.1 A later, worse trough was printed as "the next dose."** `findingsLines()` picked the
upcoming trough with the *lowest* P(trough > target) and labelled it "before the next dose" —
if a nearer dose looked fine and a later one looked worse, the later one's numbers were written
into the printed record under the nearer dose's own description. Fixed: "next" is now strictly
the smallest-t upcoming row; "worst" (lowest P) is reported in its own sentence, on its own
date, and only when it is not the same row as "next" — so a well-attained regimen never grows a
redundant second sentence, and a genuinely worse later dose is named honestly rather than
folded into the wrong one.

**28.2 Three places recommended a dose or interval change.** `ptaBadge()`'s intermediate/bad
titles ("a dose or interval change may be needed" / "consider adjusting the dose or interval"),
the low-attainment advisory ("consider a dose or interval change"), and one `#howto` bullet
("suggests considering a change") all violated this project's own long-standing rule that the
app never suggests a dose (README golden rules, §2) — the rule was already enforced everywhere
else (the regimen explorer explicitly refuses to mark a "winner"); these three spots had drifted
from it. All three now report probability only, non-directively — colour and the 90% threshold
remain a *display* cut for attainment against the clinician's own chosen target, never a
decision rule.

**28.3 A badge above 90% hid its own number.** `ptaBadge()` printed the literal string
"P ≥ 90%" once `p >= 0.9`, so a 91% and a 99% forecast were indistinguishable on screen. It now
always prints the actual rounded percent, at every threshold; the colour bucketing (≥90% ok,
≥50% warn, else bad) is unchanged.

`ptaBadge` is now exported as `ECU.ptaBadge` (it was previously internal to `ui.js`) purely for
headless testability — same pattern as the existing `ECU.findingsLines`/`ECU.reportHtml`
exports, no behavioural change.

**On verification.** `tests/test_v023.js`'s three groups of assertions were each confirmed to
go red before being trusted (golden rule 7b): reverting F2's fix flips 6 assertions (with one
test-side robustness fix along the way — a naive `worstLine[0].indexOf(...)` crashed outright
against the sabotaged code rather than failing gracefully, so the assertion was rewritten to
guard on `worstLine.length` first); reverting F3/F11's `ptaBadge()` fix flips 4. Verified live in
the built artifact: a real report on a synthetic case shows the correct per-row date/median/P
with no cross-contamination between rows, no dose-suggestion phrase anywhere in `src/ui.js` or
`index.html`, and no literal "P ≥ 90%" text on any badge.

---

## 29. What changed in v0.24.0, and why

Second implementation batch from `INDEPENDENT_AUDIT.md` (F5, F7, F16). F4's checkpoint —
whether to transcribe crovalimab's Run 59 residual error, or add an on-screen caveat while
keeping run05 — was presented to the author with the full run05-vs-Run-59 gap explained
(~203× residual-variance difference, missing ADA-on-CL covariate). **Decision: keep run05,
add no caveat.** Recorded as closed in `INDEPENDENT_AUDIT.md` §0/F4; it consumed no version
number, since nothing in the app changed.

**29.1 The chart could auto-project a loading dose forever.** Crovalimab's EMA regimen is
5 doses (1 IV + 4 weekly SC) before q28d maintenance begins. Until a 6th, genuinely-
maintenance dose is entered, every spacing on file is a loading spacing — `modalInterval()`'s
"later half of doses" heuristic has nothing else to look at and returns q7d, which the chart's
display-only continuation block would then auto-project indefinitely: a q7d "projected dose"
line stretching forward with no end, for a drug about to move to q28d. Same failure class as
the v0.13.0 hardcoded-interval bug, different trigger.

**Fix:** the crovalimab spec (`src/model.js`) declares `loadingDoseCount: 5` — a genuine,
EMA-posology-derived fact about the drug, in the same family as its existing `adminRoutes`
declaration. While `doses.length <= loadingDoseCount`, `runFit` suppresses the chart's
continuation entirely and sets `fit.loadingPhase = true`, which the UI turns into an on-screen
advisory naming the reason ("the interval used so far is the loading schedule's, not the
eventual maintenance interval") rather than a silently missing projection. `loadingDoseCount`
is 0/undefined for every other drug, so this is a no-op elsewhere — confirmed directly: a
5-dose eculizumab schedule on a deliberately **prolonged** q3w interval (this app's whole
purpose) is never mistaken for a loading phase. The real trough table, the real fit, and the
`assumed`-dose row's own existing caveat are untouched — F7 only gates the display-only
continuation, never anything decision-relevant.

**29.2 The regimen explorer's probabilities had no uncertainty band at all.** The trough
table's P(trough > target) has carried a Monte-Carlo 95% interval (`batchMeansCI`, batch means
over the kept chain, respecting autocorrelation) since v0.13.0. The regimen explorer's matching
`next`/`ss` probabilities never got one, even though `regimenScanSetup`'s `subsample()` already
keeps the chain in order — the same batch-means method applies directly, just over a shorter
(250-draw) chain. `scanOneRegimen` now returns `pCI` on both `next` and `ss`; the explorer's
`ptaBadge()` calls (shared by the on-screen table and the printed-report copy, both going
through `intervalScanTableHtml`) now pass it through. The CI **honestly widens** relative to
the trough table's full-chain CI, rather than presenting a subsampled estimate as exact; with
fewer than 12 batch-mean rows `batchMeansCI` returns `null`, which `ptaBadge` already handled
safely (same null-safety the trough table's own `pCI` already relied on).

**On verification.** Three separate sabotages were used to confirm `tests/test_v024.js` can go
red before being trusted (golden rule 7b): disabling the F7 loading guard flips 2 assertions;
removing F5's `pCI` computation from `scanOneRegimen` flips 20; removing the UI-side wiring
(F16) while leaving the engine untouched flips a *different* 2 — proving the engine and UI
assertions are independently meaningful, not one assertion in disguise. Verified live in the
built artifact: a real crovalimab schedule entered dose-by-dose shows the loading advisory and
no "Projected dose" chart line until the 6th (maintenance) dose is added, at which point the
projection resumes; a real regimen-explorer scan renders genuine "Monte-Carlo 95% interval"
text on its badges, not just a field silently present on the underlying object.

---

## 30. What changed in v0.25.0, and why

Third implementation batch from `INDEPENDENT_AUDIT.md` (F6) — the widest-blast-radius item
in the whole audit, since it rewrites a core MCMC diagnostic that every fit's reported
precision word depends on.

**30.1 ESS was pooled across chains; R-hat was already split-chain.** `essAll` was computed
by mapping the single-chain Geyer initial-positive-sequence estimator (`ess()`) over `draws`
— every chain's kept iterations concatenated into one array — while `splitRhat()` correctly
worked on the unpooled per-chain `chains`. The two diagnostics were not even measuring the
same thing: concatenating chains that never mixed does not reliably bias a pooled
autocorrelation estimate in one direction, so R-hat could flag a problem that pooled ESS
either hid or, just as easily, exaggerated for an unrelated reason.

**Fix:** a genuine split-chain **bulk ESS** (Vehtari et al. 2021 — the same method Stan
uses), sharing its chain-halving with `splitRhat()` through one new helper,
`splitChainStats()`, so the two diagnostics can never silently disagree about what counts as
"the segments under comparison." Each split-chain's autocovariance is centred on **that
split-chain's own mean**, then averaged across split-chains, before Geyer's initial monotone
positive sequence (same style as the pre-existing single-chain `ess()`) truncates the lag
sum — centering on a shared grand mean instead would leak a genuine between-chain difference
into the within-chain autocorrelation estimate as spurious correlation, understating ESS even
for chains that are each individually well-mixed.

Two synthetic cases confirm both directions of R-hat/ESS disagreement the old pooled
approach could produce: a chain that never moved gives R-hat ≈ 14 **and** bulk ESS ≈ 8 of 800
(both correctly flag it) — the case the audit itself named — while two chains that **agree**
with each other but each drift slowly give R-hat ≈ 1.0 (fine) **and** bulk ESS ≈ 14 of 800
(still correctly low, despite R-hat seeing nothing wrong). Only measuring one of the two
diagnostics would have missed the second case entirely.

**30.2 `essMin`, not just `essCL`.** A 6-eta crovalimab posterior can have `ka` or `F` poorly
mixed while `CL` looks fine — the diagnostic badge (`precisionWord()`) only ever consulted
`essCL`. It now prefers `fit.essMin` (the minimum finite value across every eta's own bulk
ESS) when present, falling back to `essCL` when `essMin` is absent — a strict superset of the
old behaviour, so the existing `essCL`-only synthetic tests in `tests/test_usability.js` are
untouched and still pass unmodified. No threshold retune was needed or attempted: 100/300
stayed as they were, per the audit's own caution not to "copy 100/300 blindly onto 6-eta
crovalimab" without evidence the new values actually fall outside them.

**On verification.** Four separate sabotages were used to confirm `tests/test_v025.js` can go
red before being trusted (golden rule 7b) — and the first attempt at one of them exposed a
real gap in the suite's own design, worth recording plainly: reverting `runFit`'s wiring back
to the old pooled `ess()` call **passed every assertion unmodified**, because the suite's
end-to-end checks (essAll.length, essMin ≤ essCL, etc.) stay internally consistent regardless
of which function computed the numbers — they were checking the *shape* of the answer, not
that the *right code path* produced it. A direct source-level assertion pinning the exact
`bulkEss(mcmc.chains, ed)` call was added and confirmed to flip red on that same sabotage.
Two further sabotages (reverting `bulkEss`'s per-segment centering to a shared grand mean;
reverting `precisionWord()` to ignore `essMin`) were each confirmed red on their own —
the centering sabotage needed a purpose-built case (two near-i.i.d. chains with a modest mean
gap) after the original two cases turned out insensitive to it, since a chain that has
already collapsed to zero variance or is being swamped by a huge mean gap doesn't discriminate
the centering convention either.

---

## 31. What changed in v0.26.0, and why

Fourth implementation batch from `INDEPENDENT_AUDIT.md` (F8). Two unrelated input bounds,
bundled by the audit because both were "the wrong walls" — one too permissive where the
model has no data, the other too strict where it likely still has some.

**31.1 Crovalimab now gates on age; the other two drugs do not.** Crovalimab's SC absorption
rate, `ka = 0.126 · (age/36)^-0.459`, is an adult-population formula, but the shared age input
accepted 1–100 uniformly — a 1-year-old passed the same check as a 40-year-old, with nothing
disclosing that the model has never seen pediatric data. Per the author's explicit
instruction (this app does not attempt to independently re-derive pediatric-appropriateness
per drug — that judgement is the author's, a clinical pharmacologist's, to make):

- **Eculizumab: no change.** Judged suitable for children and adults; no age covariate, no
  gate.
- **Ravulizumab: a plain factual note, not a warning.** Its `drugHint` line and `assumptions`
  now state "Developed for adults" — displayed as fact because the model has no age
  covariate to gate on at all, not because a patient's age triggered anything.
- **Crovalimab: a three-tier gate.** Age < 12 is refused outright (`runFit` throws, both at
  the UI's pre-flight alert and as an engine-level backstop for any caller that bypasses the
  UI — JSON import, a direct test, a future headless caller); age 12–16 runs but sets
  `fit.pediatricWarn = true`, surfaced as a passive, non-blocking advisory ("was not
  developed for children") in the same register as the app's other disclosures, per the
  author's explicit choice of a passive note over a confirm-and-proceed gate; age ≥ 17 is
  silent. The two thresholds (`pediatricBlockAge: 12`, `pediatricWarnAge: 17`) are declared
  on the crovalimab spec — the author's own clinical judgement about acceptable
  extrapolation, not derived from a pediatric validation study (none exists; this app does
  not cover pediatrics, per its own stated scope).

**31.2 Weight widened from 35–200 kg to 25–300 kg, uniformly.** The old bound was an
unsourced hard refusal that excluded real, plausible obese PNH/aHUS patients outright rather
than flagging the extrapolation — a shape mismatch, since allometric scaling degrades
gradually with distance from the studied population rather than failing at a cliff. The
audit's recipe offered two paths: replace the hard cap with a warning-and-extrapolation flag,
or simply raise it. The author chose the simpler of the two — a wider hard bound, applied
identically across all three drugs (weight is a covariate everywhere via allometric scaling,
with no drug-specific reason to distinguish them) — "should capture all adults." Enforced at
every site that previously checked 35–200: the engine throw (`src/bayes.js`), the run-button
readiness check and the run-click pre-flight alert (`src/ui.js`), and the `#pt-wt` input's
HTML `min`/`max`.

**On verification.** Four sabotages were used to confirm `tests/test_v026.js` can go red
before being trusted (golden rule 7b), and two of them exposed real gaps worth recording
plainly. Removing the pediatric block/warn logic entirely flipped 7 assertions cleanly.
Reverting the weight bound to 35–200 initially **crashed** an unrelated assertion instead of
failing it gracefully — an eculizumab pediatric-gate check had used `wt: 30`, valid only
under the *new* 25–300 kg bound, so a completely different sabotage took down a test that
had nothing to do with weight; fixed by using a weight safely inside both the old and new
bounds for every assertion whose actual subject is something else. Reverting
`updateRunReady()`'s age gate to a hardcoded `12` **passed every assertion unmodified** on
the first attempt, because the source-level check for `pediatricBlockAge` used an unscoped
`indexOf()` that also matched an unrelated, correctly-written occurrence of the same literal
string in `runFit()`'s own pre-flight alert a few hundred lines later — fixed by scoping the
assertion to `updateRunReady`'s own function body specifically, the same slicing technique
several earlier `test_v0*.js` suites already use for exactly this reason. Removing the
ravulizumab hint text flipped 1 assertion cleanly. Verified live in the built artifact: the
pediatric advisory renders for a 14-year-old crovalimab patient, the Run button stays
disabled for an 8-year-old, and ravulizumab's hint reads "Developed for adults" once actually
switched to (a `data:`-URL sandbox quirk in the verification browser — not a real bug — made
an in-place drug switch briefly look like it hadn't updated; using the app's own "clear all"
control before switching gave a clean re-check).

---

## 32. What changed in v0.27.0, and why

A real bug, not an audit finding — reported directly by the author while testing steady-state
eculizumab, and worth documenting with the same rigor as the audit batches.

**32.1 The chart's continuation drew a flattened, shortened cycle instead of a periodic
sawtooth.** A screenshot showed peaks alternating tall/tall/tall/**short/short**/tall for a
genuinely periodic dosing regimen (fixed dose, fixed interval) — physically, every cycle
should look identical. Root cause: `grid` (the time points the chart is evaluated at) was
built from the real, entered doses alone, **before** `chartProjectedDoses` (the display-only
continuation past the last real dose, v0.15.0) was computed. `buildGrid()` adds fine
per-dose time points — near each dose's peak and its own pre-dose instant — only for the
doses it is given, so every projected dose's peak/trough fell in a region with nothing but
the coarse half-day background grid. The underlying simulation itself was genuinely periodic
throughout (confirmed directly: the pre-dose trough at every *real* dose stayed numerically
constant to within rounding) — the bug was purely in what the chart chose to *sample* for
rendering, not in the PK math.

**Fix:** the (pure, dose-list-only) computation of `chartProjectedDoses` and `loadingPhase`
moved earlier in `runFit`, before `grid` is built, and `grid` is now built from
`doses.concat(chartProjectedDoses)` instead of `doses` alone. `buildGrid()` only reads doses
to add time points around them — it has no other effect — so this cannot change `ctx.doses`,
the MAP/MCMC likelihood, or `troughs`, all of which continue to use the real `doses` array
exactly as before, unchanged, elsewhere in the function. The duplicate dose-list computation
that used to live further down (inside the chart-continuation simulation block itself) was
removed rather than left as a second copy.

**On verification.** `tests/test_v027.js` reproduces the exact scenario (steady-state
eculizumab, a 1-day interval, two observations near day 0 — the same shape of case the
author was testing) and pins the fix three ways: `buildGrid()` given extra doses only ever
*adds* grid points, never removes or moves existing ones (a general safety property, checked
directly); grid density around a projected dose is comparable to a real dose's own window,
not the bare ~3-point background grid (with the one legitimate exception — the very last
projected dose's trailing window is genuinely truncated by the forecast horizon itself, which
the test accounts for rather than papering over); and, most directly, every pre-dose trough
across the whole continuation reads the same concentration to within noise. Confirmed to go
red (golden rule 7b): reverting the fix reproduces a 119.5 µg/mL swing between doses that
should read identically — the same magnitude and shape as the author's own screenshot — and
flips 9 of the suite's 21 assertions. Verified visually in the browser both before (the
reported artifact, reproduced) and after (a clean, uniform repeating sawtooth) the fix.

---

## 33. What changed in v0.28.0, and why

Fifth implementation batch from `INDEPENDENT_AUDIT.md` — F9, F12, F13, F20, F21, F22, F24,
bundled into a single release at the author's own request (all seven are small, independent,
single-file changes with no engine/model risk, exactly the class the audit's own §5 table
flagged as safe to bundle). Also files **F1**, the real calibration study, which finished
mid-batch. F4 and F14 remain author decisions recorded in `INDEPENDENT_AUDIT.md` §0/F4 and
this file's own record of the F14 conversation — F14 is not yet implemented (Option A: make
the existing "true trough" disclosure more visible, still pending).

**33.1 F1 — the real calibration study is filed.** `npm run calibration` (N=300/scenario,
five scenarios, production MCMC) ran to completion: **all five scenarios PASS**, coverage
89.3–90.0% with every 95% CI containing 0.90 and every PIT histogram statistically flat
(all five χ² tests p > 0.1). Full table in `VALIDATION.md` §V2a. The two places that cited
the N=24 smoke test as if it were calibration evidence — `MODEL_VALIDATION.md` §5 and one
sentence in README §9 — now point at the real study instead.

**33.2 F9 — the aHUS interval-narrowness caveat now lives where it's read.** It was buried
in the About dialog and one findings-paragraph sentence that only said predictions are "more
uncertain than PNH" — true, but not the more specific claim the audit wanted surfaced: because
the occasion component is folded into the prior rather than modelled as a future-occasion
effect, the interval for the *next dose specifically* is somewhat narrower than the full
occasion-to-occasion uncertainty. Merged into one sentence (not left as two competing ones) in
`findingsLines()`, and added to both the on-screen and printed trough-table legends — the
table a consultant actually reads before advising on the next dose.

**33.3 F12 — patient identifiers no longer sit in browser storage.** `saveSession()`'s
autosave persisted `patient.code` (a name or MRN-like identifier) to `localStorage`
indefinitely — a real exposure on a shared ward PC. It is now blanked before every autosave;
everything else needed to resume a session (doses, measurements, target, drug) carries no
identifying value on its own. The JSON export still carries the code, unchanged — that
remains the deliberate, portable, user-initiated path, not something written silently in the
background.

**33.4 F13 — `#howto` now says what the trough-table legend already said.** The band's
5–95% range excludes assay error, so a future measured value may fall outside it — stated in
the trough-table legend since earlier work, but never in the How-to-read-results panel a
first-time user is more likely to actually open.

**33.5, 33.6 F20, F24 — two stale strings from the v0.20.0 Advanced-options split.** The
engine's LLOQ-without-a-set-LLOQ error still said "enter the assay LLOQ in the patient
card," and eculizumab's `assumptions[3]` still pointed local-assay users at "Advanced
options" — both fold names that stopped existing when LLOQ and the assay-error multiplier
moved into "Assay settings." Both now name the actual location.

**33.7 F21 — a caller passing milliseconds instead of days now gets a clear error.** The
engine's time unit is days throughout, but nothing stopped a future or headless caller from
passing epoch-millisecond timestamps (the UI itself converts ms → days in `relContext()`
before doses/obs ever reach `runFit`, so this could only affect a caller that bypasses the
UI). Without a guard, `buildGrid()`'s day-stepped loop would silently attempt on the order of
10⁸ iterations instead of failing fast. `runFit` now checks every dose and observation time
and throws immediately — confirmed to fire in well under a second, not after a hang — while a
real steady-state pre-roll (80 cycles × 56 days = −4480 d) stays far under the 1e5-day
threshold and is completely unaffected.

**33.8 F22 — the stepper's step 1 now matches card 1.** Card 1 is "Drug & patient," with the
drug selector as its own first field, but step 1 said "Enter weight" — the same
numbers-must-match-cards principle already enforced for steps 2–4. Now reads "Drug & weight."
The one known existing-test break this causes (`tests/test_usability.js`'s own pinned
assertion for the old wording) was updated in the same commit, not left to fail.

**On verification.** All seven code findings were verified with the same discipline as every
other batch, just run as one consolidated pass rather than one per finding, per the author's
request: `tests/test_v028.js`'s 29 assertions were each confirmed to go red under a dedicated
sabotage (nine sabotages in total, since F9 was verified in three parts — the merged sentence,
the on-screen legend, and the report legend independently, since a single combined check would
not have told a missing on-screen addition apart from a missing report one). One sabotage
round caught a real gap in the test's own design: an `>= 3` occurrence-count threshold for the
IOV-disease gate did not change when removing just one of F9's two new additions, because two
uses of that gate already existed before this batch (the pre-existing advisory and
`findingsLines`'s own guard) — fixed with an exact count (4) plus two additional assertions
that each target one specific addition by its distinguishing CSS class (`legend-note` vs
`rp-legend`), so either one going missing is independently detectable. `npm test`
(1214 assertions) and `node tools/verify_control_streams.mjs` both pass; verified live in the
built artifact — stepper label, `#howto` note, and the aHUS caveat appearing twice in a real
printed report (once from `findingsLines`, once from the trough-table legend).

---

## 34. What changed in v0.29.0, and why

**Custom infusion times**, for every IV administration route across all three drugs — a new
feature, not an audit finding, built from a four-person planning panel's own written plan
(clinical pharmacometrician, hospital pharmacist, UI designer, coder) that the author reviewed
and approved before any code was written.

**34.1 The engine already had this, dormant.** The panel's own finding, verified independently
before building anything on it: `M.simulate()` already reads a per-dose `d.dur` override
(`var dd = d.dur != null ? d.dur : dur;`) when computing a zero-order infusion's rate — nothing
in the UI or any test had ever set it. Both call sites that matter (`makeOfv`, the MAP/MCMC
likelihood, and `simulateDraws`, the band/chart simulation) pass `doses` straight through with
no stripping, so a per-dose duration reaches the *real* fit end-to-end with zero changes to
either function. SC doses have no duration concept at all — an instantaneous depot deposit,
absorption governed entirely by `ka` — so "custom infusion time for all administration routes"
correctly means IV-only; SC was never a smaller version of this feature, it's a non-question.

**34.2 The decisions, all author's own:**
- Duration reaches the real simulation and likelihood — not display-only, unlike the
  superficially similar v0.27.0 chart-continuation fix. A mismatched assumed-vs-actual
  duration during a fitted peak sample is a real source of bias, not a rendering artifact.
- **10–360 minutes, uniform across all three drugs** — one bound (`infusionMinutes`), not
  three different ones. Declared once per drug spec purely for traceability alongside the
  existing `dose: {min,max,step,default}` convention; no separate "default" field exists
  anywhere — the default is always *derived* from each drug's own `INFUSION_D`
  (`durToMinutes(INFUSION_D)`), so the two numbers can never independently drift apart.
- **Steady-state mode gets one scalar setting, applied uniformly** to every synthesised dose
  (historical pre-roll and future cycles alike) — not a per-dose value nobody has real
  timestamps for. Crovalimab's SS regimen is 100% SC maintenance (no IV dose exists in that
  mode at all), so the field is hidden there, not merely defaulted.
- **A new, non-blocking warning** when a *fitted* sample's time falls inside a dose's own
  infusion window — "may impact estimation," the author's own framing, covering both a
  genuinely still-rising concentration and the more mundane possibility that the sample was
  drawn through the same line the infusion is running through. Checked against every IV
  dose's own duration, custom or the drug's default — every IV dose has *some* duration, so
  the check is well-defined uniformly across full-schedule and steady-state doses with no
  special-casing between the two. An excluded sample is never flagged: it cannot impact an
  estimation it never reaches.
- **No claim of negligibility at trough is made anywhere.** The panel's own reasoning
  (eculizumab's Michaelis–Menten term makes a "should be negligible" claim plausible but not
  free) was explicitly not going to be verified before shipping — the author's call, and a
  coherent one: since duration now reaches the real fit, the actual math speaks for itself:
  nothing needs to assert what a real trough for this patient's own posterior does either way.

**34.3 Units — the one place this could have silently repeated the F21 mistake.** The engine's
own unit is *days*, everywhere (`INFUSION_D`, `d.dur`) — nobody enters a clinical duration as a
fraction of a day. The UI works in **minutes** throughout and converts at exactly one boundary
(`durToMinutes()`/`minutesToDur()`), the same pattern `dose-dt`/`obs-dt` already use for
epoch-ms → days. A dedicated round-trip test (45 minutes → exactly `45/1440` days → the ODE's
own rate event actually ends near t=45min, not near some other value) exists specifically
because this is exactly the class of mistake F21 (v0.28.0) fixed for a different boundary. An
engine-level bounds guard (the same dual-layer pattern already used for weight and age: a
UI-level alert plus an engine-level throw) rejects anything outside 10–360 minutes as a
units-mismatch — including the literal case of "5" meant as 5 hours landing in the field as 5
*days* — before it ever reaches the ODE as a nonsensical rate.

**34.4 `buildGrid()` needed the same class of fix v0.27.0 made for a different trigger.** The
function added a fine grid point at a dose's true peak/end-of-infusion instant using the
*drug-wide default* duration (`add(d.t + dur)`), not that dose's own (`d.dur`) — so a custom
duration's true peak was never resolved, only an irrelevant point at wherever the *default*
infusion would have ended. Fixed with the one-line change the bug actually needed
(`add(d.t + (d.dur != null ? d.dur : dur))`); the existing fixed-step background grid already
comfortably spans the entire 10–360 minute clinical range, so no wider structural change was
required.

**34.5 Two silent-drop boundaries, found and fixed before they could ship broken.** Neither
`relContext()` (full-schedule) nor `relContextSS()` (steady-state) originally carried `.dur`
through when building the `dosesRel` array that actually reaches `runFit` — every other piece
of this feature could have been individually correct and the whole thing would still have been
completely inert end-to-end, with no error anywhere. Both fixed. The same check was repeated
for `exportJson()`/`importJson()` (a saved-and-reopened session would otherwise silently lose
every custom duration) and the steady-state scalar's own export/import pair.

**On verification.** Eight sabotages were used to confirm `tests/test_v029.js`'s 66
assertions can go red before being trusted (golden rule 7b): the two silent-drop boundaries
above, the `buildGrid()` fix, the during-infusion detection, the engine bounds guard, the
dose-add handler's storage, and `exportJson()`'s dose mapping — each flips a distinct,
correctly-attributed set of assertions, not a shared catch-all. One test-side lesson repeated
from a previous batch: disabling the during-infusion detection crashed an assertion outright
(`.samplesDuringInfusion[0]` on an empty array) instead of failing gracefully — fixed by
guarding the array's length before indexing into it, the same class of fix already applied
once before in this project's own history. `npm test` (1280 assertions) and
`node tools/verify_control_streams.mjs` both pass; verified live in the built artifact across
every path — full-schedule route-gating (visible for IV, hidden for SC, live on a route
change), a custom 5h crovalimab loading-dose duration producing both the Duration-column
disclosure and a correctly-worded, correctly-dated during-infusion warning, steady-state
route-gating (hidden for crovalimab, shown for ravulizumab), the SS report summary naming a
non-default duration, and a real JSON export round-trip recovering the exact stored value.

---

## 35. What changed in v0.30.0, and why

**The localStorage autosave never covered steady-state mode's own fields** —
`ss-dose`, `ss-interval`, `ss-anchor`, and (since v0.29.0) `ss-dur`. Found by the author
immediately after v0.29.0 shipped, not from the independent audit.

**35.1 Two distinct symptoms, one missing piece.** `saveSession()`/`applySession()`/
`offerRestore()` had only ever captured `state.doses`/`state.obs` (full-schedule mode's own
records) plus the drug/target/patient/report fields shared by both modes — `exportJson()`/
`importJson()` (the JSON-file path) already had its own `ss: {dose, interval, anchor, dur}`
block, but the autosave path never grew the equivalent. That produced two separate failures:
a steady-state session *with* measurements entered restored those measurements on reload, but
silently lost the regimen itself and even which mode the app should be in; a steady-state
session with *no* measurements yet (just the regimen configured) was never even offered a
restore in the first place, because `loadSession()`'s "is there anything worth restoring" guard
only ever checked `doses`/`obs` length — a pure regimen-only session read as completely empty.

**35.2 The fix mirrors `exportJson()`/`importJson()`'s own shape exactly**, so the two restore
paths cannot silently disagree about what a valid saved regimen looks like:
- `saveSession()` now records `mode: currentMode()` and an `ss: {dose, interval, anchor, dur}`
  block (via `readSS(false)`) whenever the session was in steady-state mode.
- `loadSession()`'s guard gained a third condition — `hasSSRegimen` — alongside the existing
  doses/obs length checks, so a configured-but-unmeasured regimen now counts as worth restoring.
- `applySession()` restores the four fields back into the DOM and explicitly calls `setMode()`
  for *both* branches (never left implicit), using the same `isFinite(Date.parse(...))` anchor
  validity guard `importJson()` already uses — restoring the field values while silently leaving
  the UI on whatever mode it happened to already be showing would leave a configured regimen
  invisible.
- `offerRestore()`'s prompt text now names the steady-state regimen (dose and interval) for an
  `s.mode === 'ss'` session, instead of unconditionally reading "N dose(s), N measurement(s)" —
  which would have rendered as the actively misleading "0 dose(s)" for a pure regimen-only
  session, exactly the case this fix exists for.

**On verification.** `tests/test_v030.js` (15 assertions, source-slicing the four functions'
bodies the same way `tests/test_session_restore.js` already does, since none of them are
reachable without a DOM) was written before any fix and confirmed to fail all 11
fix-dependent assertions against the unfixed code (golden rule 7b). Five separate sabotages —
removing `saveSession()`'s `mode` field, removing its `ss` block, reverting `loadSession()`'s
relaxed guard, removing `applySession()`'s whole SS-restoration branch, and reverting
`offerRestore()`'s prompt — were each confirmed to flip exactly the assertions attributable to
that piece and no others, then the file was diffed byte-for-byte against a pre-sabotage backup
to confirm a clean restore each time. `npm test` (1295 assertions) and
`node tools/verify_control_streams.mjs` both pass; verified live in the built artifact by
configuring a steady-state-only regimen with a custom infusion duration and no measurements,
reloading the page, and confirming the restore bar appears with the regimen named correctly and
restores the dose/interval/anchor/duration into the right fields with the app correctly back in
steady-state mode.

---

## 36. What changed in v0.30.1, and why

**Two author-requested wording changes**, neither an audit finding nor a bug — the header's
privacy strapline and the About dialog both understated what the app actually guarantees.

**36.1 Header strapline.** `index.html`'s `.sub` line ("Model-informed TDM and PK forecasting
· all computation local, no data leaves this device") is replaced with the author's own wording,
naming what the app is (precision dosing of therapeutic monoclonal antibodies for
complement-mediated diseases) ahead of the privacy note, rather than compressing both into one
clause.

**36.2 About dialog.** A new, standalone **Privacy** section is now the first thing `aboutHtml()`
renders — ahead of "Research use only" — carrying the author's own sentence verbatim: "Using this
website, no data are remotely stored or processed. All calculations are performed locally on your
device opening this website, to guarantee privacy and prevent data leaks." The pre-existing
privacy sentence inside "Research use only" ("All computations run locally in your browser — no
data is transmitted or stored.") is left as-is — it was not asked to be removed, and the two say
the same thing from different angles without contradicting each other.

**On verification.** Text-only change to two static strings; no test asserts either sentence's
former wording (checked by grep before editing). `npm test` (1295 assertions, unchanged) and
`node tools/verify_control_streams.mjs` both still pass.

---

## 37. What changed in v0.30.2, and why

**Every em-dash removed from the app's user-facing text.** Not an audit
finding or a bug — a copy-editing pass, at the author's request, running his
own `humanizer` skill against all UI text (`index.html`'s static markup, and
the string literals in `src/ui.js` / `src/model.js` that render into the DOM:
labels, tooltips, alerts, the About dialog, the printed report, drug hints
and assumptions). Code comments were explicitly out of scope — developer-only
prose that never reaches a screen.

**What the audit found.** One pattern, applied consistently: an em-dash (—)
used as a clause separator, ~96 instances across the three files. Everything
else — buzzwords, filler phrases, clichés, overclaiming verbs — came back
clean; the many editing passes already applied throughout this project kept
the prose disciplined. Each instance was replaced with whichever of comma,
period, semicolon or parenthesis the specific sentence actually called for,
reviewed individually rather than a blind find-and-replace — a few needed
real restructuring (e.g. a double-em-dash parenthetical in the About dialog's
IOV explanation, and in crovalimab's ADA assumption in `src/model.js`, both
rewritten with actual parentheses).

**One instance the original audit missed, caught during implementation:**
`precisionWord()`'s `'low — consider re-sampling or additional samples'`
return value (`src/ui.js`) — it renders in the "Sampling precision" line but
isn't a plain string literal reachable by the same text-scan the audit used
to enumerate candidates, since it's inside a function return. Found and fixed
in the same pass; caught here rather than left as a residual em-dash the next
audit would have to rediscover.

**On verification.** Three test assertions were pinned to the literal old
wording (`tests/test_usability.js`, `tests/test_v025.js` ×2 — all checking
`precisionWord()`'s exact return string, plus one checking the assay-error
legend's now-capitalized "Leave unchanged..." after the sentence split) and
were updated to the new wording; every other assertion in the suite passed
unchanged, confirming no other test happened to pin text this pass touched.
`npm test` (1295 assertions) and `node tools/verify_control_streams.mjs`
both pass. This was a wording-only change with no logic touched, so no new
test coverage was added for it.

---

## 38. What changed in v0.31.0, and why

**The regimen explorer's table now shows steady-state trough only**, matching
its own chart above it. Author request, not an audit finding.

The chart dropped its "next dose only" series back in v0.15.0, on the
reasoning that two lines answering different questions read as clutter and
that the steady-state value is the one that usually matters for a drug that
accumulates. The table right below it never got the same treatment: it kept
a "Next trough" and a "Steady-state trough" pair of columns side by side, so
the chart and the table disagreed about how much to show for the same
regimen scan.

**What changed, precisely.** `intervalScanTableHtml()` no longer renders the
"Next trough [5–95%]" column, its accompanying P(next > target) badge, or
the legend note explaining what "Next trough" meant. The steady-state column
is untouched. The chart's own accessibility description, which promised
"the effect of changing only the next dose" was listed in the table below
it, no longer makes that promise, since it would now be false. The
regimen-explorer's ⓘ popover, which explained both trough concepts side by
side, now describes steady-state trough only — while there, its two
remaining em-dashes were also removed, matching the rest of the app after
v0.30.2's pass, an oversight in that pass rather than new scope here.

**What did not change.** `src/bayes.js`'s `intervalScan()`/`doseScan()`
still compute the "next" trough exactly as before — nothing about the
underlying data changed, only what this one table chooses to display.
Other consumers of that data (`tests/test_v013.js`, `tests/test_v014.js`)
keep exercising it as a data-layer concern, independent of the table's own
presentation choices.

**On verification.** A new suite, `tests/test_v031.js` (12 assertions),
source-slices `intervalScanTableHtml()`, `renderIntervalScan()` and the
`ivexplore` help text and was confirmed to fail all 6 of its
fix-dependent assertions against the pre-change code before the fix (golden
rule 7b), then confirmed to pass afterwards. Two existing tests
(`tests/test_v015.js`, `tests/test_v024.js`) had assertions from earlier
releases that specifically pinned "next" as present in this table; both were
updated to assert its absence instead, with the reasoning left in a comment
so a future reader isn't left wondering why a test flipped polarity. `npm
test` (1307 assertions) and `node tools/verify_control_streams.mjs` both
pass.

---

## 39. What changed in v0.32.0, and why

**A single entered dose no longer draws a second, assumed one.** Real bug,
reported live: with exactly one dose on file, the forecast chart showed two
vertical dose lines, one real and one labelled "Projected dose (not
entered)" in the legend; the trough table below it showed one "assumed
dose" row that didn't correspond to anything actually entered.

**Root cause.** `modalInterval()` correctly falls back to the selected
drug's own default maintenance interval (its own v0.13.0 fix) whenever there
aren't enough real doses to derive a genuine one from. With exactly one
dose, that's always the case, since an interval needs two dose times to
exist at all. `virtualTroughTime()` (the trough table's "assumed dose" row)
and the chart's own continuation logic both used that fallback unconditionally,
regardless of how many real doses were actually on file. So with one dose,
both drew a "continuation" that wasn't continuing anything the clinician had
entered, just a guess at the drug's typical interval, presented visually
indistinguishably in structure from the two-or-more-dose case where the
interval genuinely comes from the patient's own history.

**Fix.** Both `virtualTroughTime()` and the chart's continuation logic now
require at least two real doses before projecting anything. With exactly
one dose, the chart shows only that dose's own decay curve, and the trough
table falls back to its existing "Add planned doses to see predicted
troughs" empty state, no new UI path, both already-existing, already-tested.
`modalInterval()` itself is unchanged and still used correctly elsewhere
(prefilling the steady-state interval field, the regimen explorer) — this
fix is narrowly about whether its fallback gets *acted on* to draw a
continuation, not about the fallback value itself.

**On verification.** A new suite, `tests/test_v032.js` (11 assertions),
covers `virtualTroughTime()` and `troughTimesOf()` directly, a full one-dose
`runFit()` (confirms zero chart-projected doses and zero trough rows), a
full two-dose `runFit()` (confirms the continuation and the assumed row are
both still there, unchanged), and crovalimab's own loading-phase gate
(unaffected — it was already suppressing the continuation for a different
reason, and still does). Two sabotages, disabling each of the two new
guards independently, were each confirmed to flip exactly the assertions
attributable to that guard and no others, then the file was restored and
diffed byte-identical. One pre-existing test (`tests/test_v013.js`) had an
assertion pinned to the old single-dose `virtualTroughTime()` behaviour,
moved to a genuine two-dose case where an interval actually exists. One
other pre-existing test (`tests/test_v029.js`) crashed on the fix, since its
fixture used a single dose incidentally, not because it was testing anything
about this behaviour, and read `fit.troughs[0]` expecting it to exist,
fixed by giving that fixture a second dose, which is what the test's own
actual subject (explicit-vs-omitted infusion duration parity) needed anyway.
`npm test` (1318 assertions) and `node tools/verify_control_streams.mjs`
both pass. Verified live: entering exactly one dose now shows a single
decay curve with no "Projected dose" legend entry and an honest "add more
doses" trough-table state, instead of a fabricated second dose.

---

## 40. What changed in v0.33.0, and why

**A "Getting started" guide, opened in its own browser window.** New feature, from
an approved plan, not an audit finding. Audience: a clinician using the app for the
first time, not a pharmacometrician.

**Why a real second window, not a modal.** The author asked for this specifically,
and it is the right call for a walkthrough: a modal blocks the card underneath it,
which is the wrong shape for something meant to be read *while* using the app, not
instead of it. The trade-off, and it is a real one, not a preference: a window can
only be opened from a direct click, since browsers block `window.open()` otherwise,
so this could never have auto-opened on first visit even if that had seemed
desirable.

**One scrollable page, not a step-syncing wizard.** A design considered and
deliberately not built: a popup that advances in step with whichever of the app's
four cards the user is actually on, using the step state `updateStepper()` already
tracks internally. Rejected for this pass, not as a limitation discovered too late
but as a call made up front: syncing two separate windows is real engineering for
something meant to stay short, and a sync bug would leave a first-time user looking
at a guide one step behind or ahead of what they are actually doing, which is worse
than a guide that just sits still and lets them scroll. If a static page turns out
not to be enough once real users try it, live-syncing is a genuine follow-up, not a
dead end, since the state it would need already exists.

**Where the content lives, and why there is only one copy of it.**
`gettingStartedBodyHtml()` (`src/ui.js`) builds the five-step guide once, as a
string; `gettingStartedDocHtml()` wraps that same fragment in a complete HTML
document (its own small stylesheet, since `build.mjs` inlines `app.css` into the
single shipped file, so there is no separate stylesheet left for a popup window to
link to) for the real window, opened by name (`ctdmGettingStarted`) so a second
click reuses it instead of spawning another one. The identical fragment is reused,
unstyled by that popup stylesheet, as the body of a same-pattern-as-About fallback
modal (`#gettingStartedModal`) for the rare case a popup blocker refuses
`window.open()` outright, so the guide stays reachable either way rather than
silently doing nothing.

**The guide content quotes the app's own labels, on purpose.** Every card title and
button name it mentions (`Drug & patient`, `Run forecast`, `Print report`, `Export
session`, `About`) is copied verbatim from the real UI, not paraphrased, so the text
cannot quietly drift out of sync with the interface it describes without a reader
noticing the mismatch immediately, and so the test suite can check it directly
rather than trusting a human proofread alone.

**On the copy itself.** Written and then audited against the author's own
`humanizer` skill (v1.9.0) before shipping: no em-dash anywhere in the final text
(the skill's one zero-threshold rule), no filler, concrete references to the real
controls rather than vague description, and it states the app's own no-suggested-
dose principle explicitly, since a first-time reader should learn that before they
start rather than discover it by trial and error.

**On verification.** A new suite, `tests/test_v033.js` (28 assertions), checks the
button placement and label, the fallback modal's structure, that the guide content
exists exactly once and is reused by both wrappers, that all four card titles and
four control labels appear verbatim, that the never-suggests-a-dose sentence is
present, that no em-dash survived, and that the popup is opened by name (reused, not
multiplied) with a working popup-blocker fallback. Two sabotages, breaking the
named-window reuse and removing the no-suggested-dose sentence independently, were
each confirmed to flip exactly the assertion attributable to that change and no
others, then the file was restored and diffed byte-identical. `npm test` and
`node tools/verify_control_streams.mjs` both pass. Verified live: the button opens a
genuine second window beside the app (not over it), a second click reuses that same
window rather than opening another, and the content is readable at the window's
default size.

---

## 41. What changed in v0.34.0, and why

**Wider, uniform plausible-concentration bounds.** Author report, live use: the
measurement field's plausibility bounds were too narrow. Instruction: use a single
0.01–10000 µg/mL range for all three drugs.

**What was there before.** The upper bound was per-drug and inconsistent — 2000
µg/mL for eculizumab and ravulizumab, 5000 µg/mL for crovalimab (SC steady-state
levels there run higher) — enforced twice: the native `min`/`max` on the `#obs-val`
input in `index.html`, and a plausibility `alert()` in the `obsForm` submit handler
in `src/ui.js` that rejected anything above it as a likely decimal or unit error.
There was no lower bound at all beyond "not negative" (`c >= 0`), so a mistyped
value like `0.0003` µg/mL, three orders of magnitude off a real sample, was accepted
without comment.

**Fix.** `src/model.js` gets a new `obsValMin` field alongside the existing
`obsValMax`, both now `0.01` and `10000` on all three drug specs — kept as
per-drug fields rather than a hardcoded shared constant, matching the project's own
existing spec-driven-field convention (golden rule/`tests/test_audit.js`'s B1), so a
future drug could still differ without touching the shared logic. `index.html`'s
`#obs-val` native `min`/`max` move to `0.01`/`10000`. `applyDrugUI()` now syncs both
bounds from the spec instead of only the max. The `obsForm` handler gets a new
low-end check, `!below && c < minC`, with an alert worded to match the pre-existing
high-end one ("below the plausible range … check for a decimal or unit error"); the
high-end check itself is unchanged in behaviour, only its default constant moved
from 2000 to 10000. Neither check applies to a below-LLOQ entry, same as before —
that's a censoring flag, not a plausibility-checked quantified value. The unrelated,
non-blocking 8-fold-median sanity `confirm()` (a separate check comparing a new
sample against the patient's own prior samples) is untouched.

**On verification.** A new suite, `tests/test_v034.js` (18 assertions), checks the
new bounds on all three specs, the native HTML attributes, `applyDrugUI()`'s sync of
both fields, and the submit handler's low-end check (wording, `!below` guard, and
that it runs before the high-end check), plus a guard that the unrelated
median-sanity dialog is still present unchanged. Confirmed red first: reverting all
three edits (`src/model.js`, `index.html`, `src/ui.js`) to their pre-fix state failed
14 of the 18 assertions, then a byte-identical restore brought it back to 18/18. One
pre-existing suite, `tests/test_audit.js` (its B1 spec-driven-field-conventions
check), had three assertions pinned to the old per-drug max values (5000/2000/2000);
updated to the new uniform 10000. `npm test` and `node tools/verify_control_streams.mjs`
both pass.

---

## 42. What changed in v0.35.0, and why

**Author photo in the About dialog.** Author request: a small circular photo, with
name and research group, at the bottom of the About dialog.

**What was added.** The author-provided headshot (already circular-cropped, 170×170
WebP, about 29 KB) is embedded as a base64 `data:` URI in a new module-level
`AUTHOR_PHOTO_URI` constant in `src/ui.js`, right before `aboutHtml()`. Embedding it
inline, rather than referencing a separate image file, keeps the single-file
offline build's own guarantee intact: everything the app needs ships in one HTML
file, with no external request, even for this. `aboutHtml()` appends a new
`.about-photo` block after the existing Contact section: a 56px circular `<img>`
next to a caption naming the author, department and research group, styled in
`src/app.css` to match the modal's existing small-print convention (same muted
color and font size as the other `.src`-class text, a thin top border separating
it from Contact above). The caption text goes through `esc()`, the same escaping
every other piece of dynamic content in `aboutHtml()` already uses, and — per this
project's own em-dash-free convention, applied earlier to all app text — uses a
comma rather than the em-dash in the author's own dictated wording.

**On verification.** A new suite, `tests/test_v035.js` (11 assertions), checks that
the photo is a real embedded data URI (not a placeholder or external reference),
that the `.about-photo` block sits after Contact at the bottom of the dialog and
actually uses that URI, that the caption names the author and research group
through `esc()`, that no em-dash survived, and that the CSS renders it small and
circular. Confirmed red first: removing the constant, the appended block, and the
CSS rule together failed 7 of 11 assertions, then a byte-identical restore brought
it back to 11/11. `npm test` (1375 assertions) and `node tools/verify_control_streams.mjs`
both pass. Verified live: the photo renders as a small circle at the bottom of the
About dialog, beneath Contact, with the caption text beside it.

---

## 43. What changed in v0.36.0, and why

**Chart hover tooltip: a two-sided edge clamp.** An external adversarial review
(`adversarial_review_engine_statistical_correctness_handoff.md`, reviewer "Buffy
(Solar Pro4)") handed off three findings. Before acting on any of them, each was
independently re-checked against the actual current code, not taken on the
reviewer's word.

**Two of the three findings did not reproduce and were not acted on.** "Finding A"
claimed crovalimab's chart-continuation doses could be simulated with the wrong
administration route (IV instead of SC) when only IV loading doses had been
entered. The actual code (`src/bayes.js`'s `contRoute`) already selects the route
from the drug's own `adminRoutes.subsequent` whenever that field exists — which it
does only for crovalimab — never from the last entered dose's own route; and the
whole continuation block is gated off entirely during the loading phase. The "safe
fix" the review proposed is already exactly what ships. "Finding B" claimed a
visible channel still describes the regimen explorer's dose-scan "next" trough as
dose-sensitive; every channel that could describe it — the table
(`intervalScanTableHtml`) and the chart config (`renderIntervalScan`) — was
checked, and neither mentions "next" at all any more (both were scrubbed of it in
v0.15.0 and v0.31.0 respectively). Neither finding named a location that survives
inspection of the code as it stands today.

**The third, "Finding C," did reproduce and is fixed here.** `src/chart.js`'s hover
handler clamped the tooltip only on the right edge:
```
tip.style.left = Math.min(tx, host.width - 190) + 'px';
```
On a card narrower than about 194px — well within reach of the phone layout this
app was explicitly redesigned for (v0.17.0) — `host.width - 190` can be small or
negative, pinning the tooltip near or off the *left* edge instead of the intended
right-side clamp. Fixed with a two-sided clamp, `Math.max(4, Math.min(tx, host.width
- tipW - 4))`, keeping the tooltip at least 4px from either edge regardless of card
width.

**On verification.** A new suite, `tests/test_v036.js` (7 assertions), source-slices
the hover handler to confirm the two-sided clamp expression ships as written, and
replicates the small pure formula to check the cases that matter: a narrow card
where the old formula would have gone negative now floors at 4px, a narrower card
still is checked the same way, and wide-card behaviour (both edges) is confirmed
unchanged in spirit from before. Confirmed red first: reverting to the old
one-sided clamp failed exactly the two assertions that check for it, then a
byte-identical restore brought the suite back to 7/7. `npm test` and
`node tools/verify_control_streams.mjs` both pass.

---

## 44. What changed in v0.37.0, and why

**A stale forecast is cleared, not just flagged.** Author report, live use: after
running a forecast, removing or changing a measured concentration left the old
chart, trough table and advisories fully displayed underneath the amber "Inputs
changed" banner — easy to miss, and the stale numbers otherwise looked exactly like
current ones, which could read as "a new forecast is not necessary."

**What was there before.** `markStale()` (called from every dose/measurement/
patient-field mutation) set `state.stale = true` and showed the banner, but never
touched the chart or the `paramBlock`/`troughBlock`/`advisoryBlock` containers —
they kept showing whatever the last successful `runFit()` had rendered, unchanged,
right below the banner.

**Fix.** A new `showStaleResults()` clears the chart (replaced with a placeholder
explaining *why* it's empty, distinct from the "nothing entered yet" copy
`showEmpty()` uses — this state had real data and a real fit, it's just stale) and
empties `fitStatus`/`paramBlock`/`troughBlock`/`advisoryBlock` outright. It also
resets card 4 (the regimen explorer), which reuses the same fit's posterior draws
and would otherwise keep showing a scan computed from now-outdated parameters.
`markStale()` calls it exactly once — guarded on a fit existing and this being the
first mutation since the last run, so retyping in an already-stale field doesn't
re-clear an already-empty display on every keystroke. `state.fit` itself is
deliberately left untouched (unlike "Clear all" or a drug switch, which already
discard it entirely): `openReportDialog()`'s own pre-existing staleness `confirm()`
still offers to print the last run's result if the clinician explicitly chooses to,
and that behaviour is unchanged.

**On verification.** A new suite, `tests/test_v037.js` (14 assertions), source-slices
`markStale()` and `showStaleResults()` (no DOM in the node harness, same convention
as other UI tests) to confirm the guarded, once-only call; that every result surface
(chart, fitStatus, paramBlock, troughBlock, advisoryBlock, card 4's explorer button
and output) is actually cleared; that the chart placeholder's wording is honest about
*why* it's empty rather than reusing `showEmpty()`'s "nothing entered yet" copy; and
that `state.fit` is never nulled by this path. Confirmed red first: reverting both
functions to their pre-fix state failed 10 of the 14 assertions, then a
byte-identical restore brought it back to 14/14. `npm test` and
`node tools/verify_control_streams.mjs` both pass.

---

## 45. What changed in v0.38.0, and why

**Eculizumab now accepts body weights from 3 kg.** Author request: the 25 kg lower
limit excluded very young children who should be able to have TDM, and, per the
author, the eculizumab source model was developed on small children as well.
Ravulizumab (an adult model) and crovalimab (age-gated, with its own paediatric
rules) keep 25 kg. The upper limit stays 300 kg for all three.

**From a hardcoded literal to a spec field.** The weight bound used to be the literal
`25–300` copied into four places (`runFit`'s engine check, `updateRunReady`,
`updateStepper`, the run-click alert) plus the HTML input's `min`/`max`. A per-drug
bound cannot live in four copies, so it is now `weightRange: { min, max }` on each
drug spec, read at every one of those sites through two small helpers
(`weightRange()`, `weightInRange()`), and `applyDrugUI()` syncs the input's own
`min`/`max` to the selected drug. The refusal message names the drug's own range
(for eculizumab "3–300 kg", for the others "25–300 kg").

**Disclosure.** Two things said "the models do not cover paediatric patients", which
was no longer true for eculizumab. The About dialog and the printed report now read
"…and, apart from eculizumab (weights from 3 kg), were not developed for paediatric
patients." Eculizumab's model assumptions (shown in About and the report) gain an
entry stating the 3–300 kg range, that the lower limit is the author's scope
decision, and that weights near it rely on allometric scaling from the 70 kg
reference and deserve particular care. Nothing in the model itself changed: the
allometric exponents (0.75 on clearance, 1 on volumes) apply at any weight, so a
3 kg patient is an extrapolation of the same equations, not a different model. A
3 kg / 10 kg / 70 kg eculizumab forecast was run as a sanity check: finite bands, and
central volume scaling from about 0.14 L to 4.7 L as expected.

**On verification.** A new suite, `tests/test_v038.js` (19 assertions), covers the
per-drug spec values, the engine (eculizumab accepts 3 and 10 kg and refuses 2.9 and
301; ravulizumab and crovalimab still refuse 10 kg; 25 kg still runs everywhere), the
absence of any remaining hardcoded `25–300` in `bayes.js` and `ui.js`, the HTML
default, and the disclosure text. Two sabotages (spec minimum back to 25; engine
ignoring the spec) each flipped exactly the assertions attributable to them, then
files were restored byte-identical. `tests/test_v026.js`, which pinned the old
literal as source text, now asserts what is still true there (the old 35–200 bound is
gone, 25 kg runs for every drug); the sites themselves are pinned in the new suite.

---

## 46. What changed in v0.39.0, and why

**The run-button hint now names the weight range when a weight was entered but is
out of range.** A colleague entered 8 kg and got the disabled Run forecast button
with "Enter the patient's weight to run the forecast." — although a weight *had*
been entered. The refusal was legitimate (ravulizumab and crovalimab accept
25–300 kg; only eculizumab accepts 3–300 kg since v0.38.0), but the message gave no
hint of that and read as a bug. The run-click alert and the engine error already
named the range; only this passive hint did not.

**Fix.** `updateRunReady()` keeps the old wording when the weight field is blank or
not a number, and otherwise says which range applies to which drug, read from the
drug's own `weightRange` (no numbers hardcoded in the message): "Enter a weight
between 25 and 300 kg for Ravulizumab to run the forecast." The sentence frame and
the age and dose reasons are unchanged. The age hint has the same shape (it says
"the patient's age" even for an out-of-range age) and was deliberately left alone;
only the reported message was changed.

**On verification.** A new suite, `tests/test_v039.js` (8 assertions), source-slices
`updateRunReady()` (no DOM in the node harness) to check the blank/entered
distinction, the range and drug name coming from the spec, and the unchanged
sentence frame. Confirmed red first (4 of 8 failed before the fix), and a sabotage
restoring the old one-line reason flipped the same 4 before a byte-identical
restore. Also checked live in the browser on all three drugs at 8 kg.

---

## 47. What changed in v0.40.0, and why

Two items of user feedback, plus a third bug found while fixing the first.

**47.1 Restoring a session broke the forecast.** After the autosave "Restore" bar or
"Import session", the weight and LLOQ came back blank (so Run forecast stayed disabled),
a custom trough target came back as the drug default, and the assay-error multiplier as 1.
The restore then autosaved, overwriting the good saved copy. The second half was the
dangerous one: a user who re-typed the weight got a forecast against the wrong target and
assay settings, with nothing on screen saying so.

Cause: both restore paths called `setMode()` before `syncInputs()`. `setMode()` →
`markStale()` → `updateRunReady()` → `readPatient()` reads the form back into `state`, and
the form was still empty. `importJson()` had this order since at least v0.16.0 (checked
against the 12 September backup); `applySession()` gained it in v0.30.0, when mode
restoration was added in the same order. Fix: `syncInputs()` (and the new planned-regimen
fields) now run before `setMode()` in both paths. The existing restore tests missed it
because they check source text and never run the page; the new test pins the order, and
the bug was reproduced and then confirmed fixed in the browser for both paths.

**47.2 Import dropped the "excluded from fit" flag.** `exportJson()` writes each sample's
`exclude` flag and note, but `importJson()` only read time, value and LLOQ, so an excluded
sample silently went back into the fit after an export/import round trip. Now both are read.

**47.3 An optional planned regimen.** Past the last entered dose, the chart's projected
doses and the "assumed next dose" trough used the most common gap in the second half of the
history, with the last dose's amount. That lags behind exactly the change this app is for:
q14d for months then one or two q21d doses still projected q14d, and the label start
(600 mg weekly ×4, then 900 mg) projected 900 mg weekly. In one test case the projected q14d
reported P(trough > 120) = 99% while the q21d regimen the patient was actually on gave 58%.

Card 2 (full-schedule mode) now has "Planned regimen after the last entered dose
(optional)": a dose and an interval (1–365 days; dose within the drug's own range, both or
neither, checked when the forecast runs). When filled in, `runFit` receives
`planned: {amt, interval}` and uses it for the chart continuation, the next-dose trough row
and the forecast horizon, and a single entered dose is then enough to project (the
clinician supplied the regimen, so the v0.32.0 two-dose rule doesn't apply). It never
reaches the likelihood; the MAP estimate is identical with and without it (tested).
Crovalimab's loading-phase suppression still applies. The chart legend, trough table and
printed report say "planned dose (entered regimen, 900 mg q21d)" instead of "assumed"; with
no plan they now say which interval was assumed from the history. The plan is autosaved,
exported/imported, marks the forecast stale when edited, and is cleared on a drug switch
(its dose belongs to the previous drug). It is hidden in steady-state mode, which already
defines its own regimen. This fits the rule that the app never suggests a dose: the
continuation becomes the clinician's own choice instead of the app's guess.

**On verification.** A new suite, `tests/test_v040.js` (33 assertions): restore order in
both paths, the import keeping `exclude`/`note`, and the planned regimen in the engine
(interval, amount, spacing, next-trough time, horizon, unchanged MAP, one-dose projection,
invalid plans ignored, crovalimab loading phase) and its UI wiring. The engine change was
written before its test, so three sabotages were run afterwards (engine ignoring the plan,
old restore order, import dropping `exclude`); each turned exactly its own assertions red,
then files were restored byte-identical. `tests/test_v027.js` pinned the old
`troughTimesOf(doses, interval)` call text and now pins the new one (still the real doses).
Browser checks: restore bar and JSON import both bring back weight, LLOQ, target,
multiplier, plan and exclusions, and the forecast runs; plan vs no plan changes the legend
and the next-dose row as described; a half-filled plan is refused with an alert.

---

## 48. What changed in v0.41.0, and why

Fixes from an adversarial review. Each failure was reproduced before it was fixed.

**48.1 Incomplete dosing history.** A patient on 900 mg q14d for a year, with only the last
three doses entered and a true trough of 174 µg/mL: the fit read the drug carried over from
the undocumented doses as slow elimination (clearance 0.065 against a true 0.161 L/day), and
the regimen explorer reported q21d as P(trough > 75) = 100% while the true steady-state
trough was 59. Nothing asked whether earlier doses existed. Full-schedule mode now asks
"Was the patient treated with this drug before the first dose entered above?", with neither
answer preselected. The forecast only runs on "No"; "Yes" asks for the earlier doses or
Steady state mode (which assumes a long-established regimen, so it doesn't ask). The answer
is autosaved, exported, restored before `setMode()` (see v0.40.0), reset on a drug switch and
on "clear all" (undo restores it), and the Getting started guide mentions it.

**48.2 A non-converged fit was shown as a result**, e.g. a trough of 925 [924–925] with
P 100%, beside a small "treat with caution" note. `fitUnreliable()` (an individualised fit
whose parameter search did not converge) now withholds the trough table, probabilities,
parameters, regimen explorer and report; the curve stays, marked "Not reliable", only to help
find the input problem. The old advisory was removed because it contradicted withholding.

**48.3 Implausible inputs went straight into the fit.**
- Trough target: the HTML `min`/`max` were never enforced, so 5 µg/mL was accepted and gave
  P ≈ 100% for almost any regimen. The drug's `targetRange` is now enforced in the run hint
  and on the run click.
- Implausibly high levels: the fold check only compares against earlier samples, so a first
  sample of 7000 µg/mL went in unchallenged. Each drug now has `obsTypicalMax` (eculizumab
  1000, ravulizumab and crovalimab 3000 µg/mL) above which every sample asks to confirm the
  unit. It is a confirmation, not a block; the hard limit stays 10,000.
- Duplicate doses: the check covered 5 minutes, so a dose entered twice an hour apart doubled
  the exposure. It now covers 24 hours (a confirmation; crovalimab's day-1/day-2 loading may
  trigger it, which is intended).
- Future-dated samples: accepted silently up to a year ahead. They now ask for confirmation.

**On verification.** `tests/test_v041.js` (28 assertions, source-level; no DOM in the
harness) was red first (27 of 28). Three sabotages (no prior-treatment gate, unconverged fit
shown, 5-minute duplicate window) each turned exactly their own assertions red, then files
were restored byte-identical. In the browser: the unanswered and "Yes" states block the run
with their own hint; target 5, a duplicate dose, a 7000 µg/mL first sample and a
future-dated sample each ask; the exact inputs that produced "925 [924–925], P 100%" on
v0.40.0 now show "Not reliable" with the table, explorer and report withheld; a normal fit
still shows everything; steady-state mode doesn't ask the new question.

---

## 49. What changed in v0.42.0, and why

Text and report fixes from `CONSTRUCTIVE_REVIEW_2026-09-29.md` (items A1-labels, A2, A3,
B4, C2, C3, C5, C6, C7, C8, C13, C14). Each was checked against the code before fixing;
most are things the app prints into the signed report, so they are now tested on the
rendered output of `reportHtml`, `ptaBadge` and the chart, not on source text.

- **A1 (author's decision: the probability stays for the TRUE trough, assay error left
  out).** No calculation change; the column headers now read "P(true trough > … µg/mL)" on
  screen and in the report, and the header tooltip says assay error is not included.
- **A2.** A probability that rounds to 0 or 100% is printed as "< 1%" / "> 99%", and a
  Monte-Carlo interval that rounds to zero width ("(0–0%)", "(100–100%)") is omitted: a
  finite chain cannot show certainty.
- **A3.** The report and "How this was calculated" printed the clearance ESS; they now print
  the lowest ESS and its parameter ("lowest ESS ≈ 542 (V1)").
- **B4.** Residual error is printed as "additive SD 4.4 µg/mL + proportional CV 13.6%", with
  the NONMEM variances in brackets for cross-checking.
- **C2.** White halo behind the target label on the chart.
- **C3 + C5.** The 68-character projected-dose legend label added in v0.40.0 ran off a
  phone-width chart. Legend labels are short again ("Projected dose (not entered)",
  "Planned dose"); the regimen detail moved into the caption, which is now built from what
  the chart actually draws (individual vs population band, measurements, projection or plan)
  instead of fixed text describing a population band that isn't drawn after a fit.
- **C6 + C8.** Troughs are computed 1e-6 day before the dose, so a 09:00 dose printed its
  trough at 08:59; shown at the dose minute now, and the Day column prints whole days.
- **C7.** The uppercase table-header style turned µg/mL into "ΜG/ML" (Greek capital mu),
  which reads as mg/mL. Units in headers are wrapped in `.unit { text-transform: none }`.
- **C13.** The chart tooltip shows the date next to the day number.
- **C14.** The report's Fit quality section has a Convergence row: split R-hat maximum (and
  which parameters exceed 1.05), multi-start disagreement, and the covariance fallback.

**On verification.** `tests/test_v042.js` (25 assertions) was red first (22 of 25). Two
sabotages (old percentage/interval formatting; old trough time) turned exactly their own
assertions red; files restored byte-identical. Two older tests were updated for the
intended behaviour: `test_v040` (the plan wording moved from the legend to the caption) and
`test_v024` (picks an explorer row whose interval has a real width, since zero-width ones
are no longer printed). Browser check at phone width: no legend text outside the canvas,
"CONC (µg/mL)", trough rows at 09:00 with "P < 1%", tooltip with date.

---

## 50. What changed in v0.43.0, and why

**Terminal half-life instead of a one-compartment "effective" half-life** (review B1, the
author's choice), with the concentration and saturable-elimination context it needs (B2, B3).

The old "Eff. t½ at trough" was ln2·V1/CL_eff, which ignores the peripheral compartment: it
showed 29.0 days for a typical ravulizumab patient whose model terminal half-life is 45.9
days, and a clinician reasoning about interval extension would read the shorter number.

`M.terminalHalfLife(p, c)` (model.js) computes the slow-phase half-life of the
two-compartment disposition, λz = (s − √(s² − 4·k10·k21))/2 with s = k10 + k12 + k21 and
k10 = CL_eff/V1. Crovalimab's SC depot only feeds the central compartment and does not change
it. For ravulizumab and crovalimab CL_eff = CL and the value is concentration-independent. For
eculizumab CL_eff = CL + Vmax/(Km + C), so the value is evaluated at the predicted true trough
before the next dose and says so ("10.8 days at a trough of 91 µg/mL"); it is shorter at lower
concentrations. `halfLifeInfo(fit)` (ui.js) gives the median and 5–95% range across up to 400
posterior draws.

Shown in the individual view ("Terminal t½", with the eculizumab concentration in the label),
in "How this was calculated", and in the report's Fit quality section. For eculizumab a
"Saturable elimination" row gives the fixed, weight-scaled Vmax and Km, states that they are
model values rather than estimates, gives the total clearance at the trough, and notes that
the clearance shown is the linear part only (B3; the review originally called these "fitted",
which it corrected itself). `M.effHalfLife` remains in model.js for its existing tests but is
no longer shown.

**On verification.** `tests/test_v043.js` (19 assertions) was red first. The engine is checked
against the closed-form eigenvalue for each drug, against the review's reference value (45.9 d),
and independently against the late log-slope of a simulated ravulizumab bolus (45.90 d). Two
sabotages (the old one-compartment formula; dropping the concentration qualifier) turned
exactly their own assertions red; files restored byte-identical. In the browser the eculizumab
test case shows 10.8 days [9.4–13.6] at 91 µg/mL, in line with the review's 10.7 days.

---

## 51. What changed in v0.44.0, and why

**Input safety** (`REVIEW_2026-09-30.md`, findings H1 and H2). Both were found by driving the
built app, not by the suite: no test ever executed `ui.js` in a DOM.

**H1: an imported session file could run script.** `esc()` escaped `& < >` but not quotes, and
three imported values reached `innerHTML` unescaped. A dose amount of `900<img onerror=…>` ran
script; a sample note containing `"` broke out of its `value=""` attribute. Fixed twice over:
all three `esc()` helpers (`ui.js`, `diagnostics.js`, `chart.js`) now escape `"` and `'`, and
the three raw sinks (dose amount, LLOQ in the table and in the advisory) are escaped. More
importantly, every stored session now passes through one pure gate, `cleanSession()` (exported
as `ECU.cleanSession`), for **both** the JSON import and the autosave restore: amounts, LLOQ,
weight, age, target and durations must be finite numbers (numeric strings are coerced), routes
must be `iv`/`sc`/empty, dates must parse, a quantified sample must have a concentration. A bad
file is refused whole, with a message that names the entry ("dose 2 has no valid date"). Free
text (notes, names) is kept verbatim and escaped on output. A refused autosave is discarded
with a message instead of half-loading.

**H2: a NaN dose time froze the tab.** `simulate()` groups events with `ev[i].t === tEv`, which
is never true for NaN, so the loop never advanced. The F21 guard (`|t| > 1e5`) is false for
NaN, so an unparseable date in an imported file hung the browser. `simulate()` now throws on a
non-finite dose time, output time or infusion duration, and `runFit` refuses a non-finite dose
time up front with a message. The second layer is deliberate: a headless caller that skips
`runFit` is covered too.

**On verification.** `tests/test_v044.js` (47 assertions) was red first (13 failures, including
both hang checks timing out). The NaN checks run in a child process with a 20-second timeout, so
against the old code a hang is a failed assertion rather than a stuck test run. Sabotage:
removing the quote escaping turned exactly its three assertions red; removing both NaN guards
turned the five hang/throw assertions red (removing only the `runFit` one stays green, because
`simulate()` also catches the NaN, which is the point of having two layers). Files restored
byte-identical. In the built app, the original hostile file is refused with a clear message, the
breakout note is stored as inert text with no injected attributes, and a valid file still
imports. **Not added:** a jsdom smoke test. The suite is dependency-free and offline by design
(rule 2), so the DOM wiring is checked in the browser pane for each release and the boundary
logic is kept in pure, exported functions that Node can test.

---

## 52. What changed in v0.45.0, and why

**Outputs that looked reassuring for the wrong reason** (`REVIEW_2026-09-30.md`: S1, U1, U4).

**S1: the projected regimen was the loading regimen.** F7 (v0.25.0) suppressed the chart's
projected doses while a crovalimab patient had five or fewer doses. But the sixth dose is the
*first maintenance* dose, and the gap to the next is not yet known. With the standard start
(IV day 1; SC days 2, 8, 15, 22; 680 mg on day 29) `modalInterval` still read the weekly loading
spacing for six, seven and eight doses, so the app assumed **680 mg weekly** and printed
P > 99 % in the assumed-dose row: about four times the real exposure. Eculizumab had the same
fault at seven doses (weekly ×4, then q14d), because on a tie `modalInterval` kept the *oldest*
mode. What now happens:

- The loading guard runs through the first maintenance dose (`loadingDoseCount + 1`).
- For a drug with a declared loading phase, the interval is read from the post-loading doses
  only; ties go to the most recent interval (`>=`).
- New `B.spacingUnsettled(doses)`: if the last two spacings disagree by more than
  `max(2 d, 25 %)`, an interval was just changed and the app does not guess which one
  continues. (14 then 17 days is one late dose and stays settled; 14 then 21 is an extension.)
- When the loading guard or the unsettled gate applies and no planned regimen is entered, the
  fit has **no assumed next-dose trough and no projected doses**, says so in an on-screen
  advisory and in the report's findings, and the regimen explorer's interval is **left blank**
  (Explore asks for it) instead of being prefilled with a guess.
- A regimen the clinician typed (the v0.40.0 planned regimen) is theirs and bypasses all of the
  above; `fit.loadingPhase` still reports that loading is not finished.
- `fit.spacingUnsettled` and `fit.intervalTrusted` are new result fields. A single dose with no
  plan is also not trusted, so the explorer no longer prefills the drug default there.
- This supersedes the review's wording that the *row* should go in every case: F7 had
  deliberately kept the tagged row, and the plan bypass keeps the clinician in charge. The
  real trough table (one row per entered dose) is untouched.

**U1: crovalimab doses after the first were entered as IV (F10).** The Route select offered
only `iv`/`sc` and stayed on IV, so the coded "first IV, later SC" fallback was unreachable and
340 mg SC doses were silently fitted as IV. The select now has **Auto (IV first, then SC)** as
its default (`ECU.resolveDoseRoute`), the infusion-duration field follows the resolved route,
and a later dose explicitly set to IV asks "Crovalimab is given IV only for the first
(loading) dose; later doses are SC. Add this dose as IV anyway?".

**U4: the 24-hour duplicate prompt fired on the standard crovalimab start.** IV at 14:00 on
day 1 and the first SC dose at 09:00 next day are 19 h apart. `ECU.isDuplicateDose` only
treats doses as duplicates when the route matches.

**On verification.** `tests/test_v045.js` (51 assertions) was red first (30 of 39 at that point).
Six sabotages each turned exactly their own assertions red (tie-break back to `>`; loading guard
back to five doses; planned no longer bypassing; spacing gate disabled; route resolver always
IV; duplicate rule ignoring route); files restored byte-identical. Three older assertions
encoded the old behaviour and were updated deliberately: `test_v024` (the 6th dose is still
loading; the 7th ends it), `test_v040` (a plan is projected during loading; without one it is
not) and `test_v027` (the `troughTimesOf` call gained a switch). In the built app with the
standard crovalimab start and the Route select untouched: doses resolve to IV, SC, SC…, no
duplicate prompt, the trough table has the five real rows and no assumed row, the loading
advisory appears, the explorer interval is blank with an explanation, and Explore asks for it
rather than guessing.

---

## 53. What changed in v0.46.0, and why

**Small input and layout fixes** (`REVIEW_2026-09-30.md`: U2, U3, U5, T1, D2, and the unsorted
measurement table from U6). Each was reproduced in the built app first.

- **U2: the assay error multiplier was silently reset.** A value outside 0.1–10 was replaced
  by 1 with no message and the typed number still in the field: a typed 50 gave output
  identical to 1, while a valid 3 moved P(day-28 trough > 75) from 96 % to 69 %. New
  `ECU.parseErrMult` (empty = default 1 and valid; anything else outside 0.1–10, or not a
  number, is invalid). An invalid value now blocks the run with a named reason in the Run hint
  ("an assay error multiplier between 0.1 and 10 (Assay settings, below the measurements)"),
  and `runFit` refuses it as well. `state.errMultOk` carries the result.
- **U3: ~400 px of blank space in card 1 on a phone.** At ≤ 700 px the session row is a flex
  column, and `.sess-field { flex: 1 1 128px }` (170 px for the drug) then applied as a
  *height*: the 32 px trough-target fold sat in a 128 px box. Inside the 700 px block the
  fields are now `flex: 0 0 auto`. Measured at 375 px: the fields are 51–52 px tall (fold
  32 px) and the card is 392 px. The desktop rule is untouched.
- **U5: age below the minimum was not explained.** `ECU.ageReason` names the rule ("an age of
  12 years or more for Crovalimab"; "the patient's age" only when nothing is entered; a
  maximum of 100). v0.39.0 had fixed exactly this for weight.
- **T1: "re-run" could not help.** The R-hat advisory said "re-run, or add a sample", but the
  seed is a constant, so a re-run reproduces the same chain. It now says "add a sample, or
  check the entered doses and times".
- **D2: a hidden age leaked into the export.** The age typed for crovalimab stayed in the
  session after switching to a drug with no age covariate and was written to its export.
  `ECU.effectiveAge` keeps the age only when the drug uses it, and `readPatient` now reads it
  *after* selecting the drug (it used to read it first).
- **U6 (part): the measurement table is sorted by time**, as the dose table already was.
  Exclusion and removal act on the right row after sorting (checked in the browser).

**Not done, on purpose:** the rest of U6 (edit a row in place, a duplicate-sample guard, undo for
a single removal) and the other deferred items from the review (D1 DST drift in displayed
times, P1 explorer horizon, T2 standardised residuals, the X1 wording items).

**On verification.** `tests/test_v046.js` (40 assertions) was red first (14 failures). Six
sabotages (multiplier range check removed; phone CSS rule removed; age message reverted;
"re-run" restored; age ignoring the covariate; sample sort removed) each turned exactly their
own assertions red; files restored byte-identical. In the built app: restoring an autosave
goes through the new session gate without error; a multiplier of 50 disables Run with the
named reason and 3 is accepted; age 8 reads "Enter an age of 12 years or more for Crovalimab";
the export after switching drugs has `age: null`.

**A correction to an older test, found by the v0.45.0 gate.** `tests/test_e2e_fit.js` compared
its last predicted trough with the truth at a hard-coded day 69.999 ("last dose day 56 + 14").
The schedule's last dose is day 57, and the old code's wrong q7d guess put the assumed trough
at day 64, which happened to sit near day 70. With the interval now read correctly (q28d) the
assumed trough is at day 85 and coverage fell to 17 %. The test now takes the truth at the
trough time the app actually predicted (coverage 88 %, inside the 75–98 % binomial range).

---

*Version 0.46.0. Bump `src/version.js` on every change and keep `package.json` in step.*
