# mAb TDM — model-informed precision dosing for complement C5 inhibitors

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live app](https://img.shields.io/badge/live%20app-open-0e7490.svg)](https://robterheine.github.io/complementtdm/)

A **single-file, offline web app** for therapeutic drug monitoring (TDM) of three
complement C5 inhibitors: **eculizumab**, **ravulizumab** and **crovalimab**. You enter a
patient's weight, the doses they actually received and any measured serum concentrations.
The app fits a published population pharmacokinetic model to that patient (Bayesian
individualization), then forecasts the concentration–time curve, the trough before each
upcoming dose, and the probability that the trough stays above a target.

**Try it:** <https://robterheine.github.io/complementtdm/> — or download
[`complementtdm.html`](complementtdm.html) and open it in a browser. It works from `file://`
with no server, no network and no installation.

> **Research use only. Not a medical device.** The models need prospective validation
> before routine clinical use. The app never suggests, recommends or optimizes a dose or
> dosing interval; it shows what the model predicts and the decision stays with the clinician.

---

## What it does

- **Individualizes** a population PK model to one patient from their own samples
  (peaks, troughs, or both), including samples reported below the assay's lower limit of
  quantification.
- **Forecasts** the concentration–time curve with a 5–95 % credible band, and a table of the
  **predicted trough before each dose** with the median, the 5–95 % range and
  **P(true trough > target)**, including a Monte-Carlo interval on that probability.
- **Works without samples** too: a population forecast from weight (and age or disease where
  the model uses them).
- **Regimen explorer:** reuses the fitted posterior to show the steady-state trough and
  P(> target) for other intervals *or* other doses, with no refit. It displays consequences
  only and never marks a regimen as preferred.
- **Fit diagnostics:** observed vs individual prediction, residuals, how much each
  individual parameter was actually informed by the samples (versus staying on the
  population prior), and sampler convergence.
- **Prints an A4 report** with the patient, dosing schedule, measurements, forecast,
  findings, your free-text advice and signature lines.
- **Saves and restores** sessions as JSON (and autosaves locally in the browser).
- **Runs on a phone:** charts switch to a genuinely different compact layout on narrow screens.

### The four-step workflow

1. **Drug & patient:** pick the drug, enter weight (plus age for crovalimab, disease for
   eculizumab) and, if you want, a different trough target.
2. **Doses & samples:** enter the dosing history (*full schedule*) or, for a patient on a
   stable regimen, a dose + interval (*steady state*). Add measured concentrations. Optional:
   per-dose infusion duration, a planned regimen, LLOQ, an assay-error multiplier, and a flag
   to exclude a sample (for example one drawn after plasma exchange) while keeping it on record.
3. **Run forecast:** chart, parameters, trough table and advisories.
4. **Explore regimen** (optional): what a different dose or interval would do for this patient.

---

## How it works

```
weight / age / disease ─┐
dosing history ─────────┼─► population PK model (ODE) ─► MAP-Bayes ─► Laplace ─► MCMC posterior ─┐
measured levels (+LLOQ) ┘                                                                        │
                                                                                                 ▼
            troughs, P(> target), bands, half-life, diagnostics, regimen explorer, report  ◄─ posterior draws
```

**Models.** Each drug is a self-contained specification (parameters, variability, residual
error, allometric scaling, hints) in `src/model.js`:

| | Eculizumab | Ravulizumab | Crovalimab |
|---|---|---|---|
| Structure | 2-compartment, parallel linear + Michaelis–Menten elimination | 2-compartment, linear | 3-compartment: SC depot → central ⇄ peripheral, linear |
| Source | ter Avest *et al.*, Clin Pharmacokinet 2025;64:1139–1147 ([doi:10.1007/s40262-025-01536-x](https://doi.org/10.1007/s40262-025-01536-x)) | Ultomiris FDA review, simplified ([NDA 761108](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2018/761108Orig1s000TOC.html)) | PiaSky FDA review, run05 ([NDA 761388](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2024/761388Orig1s000TOC.html)) |
| Covariates | weight; disease (PNH/aHUS) | weight | weight; age on the SC absorption rate |
| Variability | IIV on CL, V1; between-occasion CL in aHUS | IIV on CL, V1 (correlated) | IIV on CL, V1, Q, V2, ka, F (logit) |
| Routes | IV | IV | IV loading dose, then SC |
| Default trough target | 75 µg/mL | 150 µg/mL (≥ 100 minimum) | 75 µg/mL |

Time is in days, concentrations in µg/mL (= mg/L), doses in mg. The two FDA-review models are
transcriptions of the final NONMEM control streams shipped in this repository
([`crovalimab.txt`](crovalimab.txt), [`ravulizumab.txt`](ravulizumab.txt),
[`nonmemcontrolstream.txt`](nonmemcontrolstream.txt)); a model value is only ever changed by
re-transcribing its source.

**Numerics.** Concentrations come from an adaptive Dormand–Prince 5(4) ODE solver, with IV
infusions and SC depot doses handled as events.

**Individualization.**
1. **MAP-Bayes:** minimise `Σ (obs − pred)² / σ² + log σ² + ηᵀ Ω⁻¹ η` over the full
   random-effects vector (2 for eculizumab and ravulizumab, 6 for crovalimab). Residual
   variance follows the published model (`σ² = add + prop · pred²`); the assay-error multiplier
   scales it. Below-LLOQ samples use the **M3 method**, `−2 log Φ((LLOQ − pred)/σ)`. Multi-start
   Nelder–Mead reports when the starts disagree.
2. **Laplace approximation:** the curvature at the optimum gives the proposal covariance
   (`2 H⁻¹`).
3. **MCMC:** adaptive random-walk Metropolis, four chains from over-dispersed starts
   (8 000 iterations; 10 000 for the 6-eta crovalimab posterior), about 2 400 kept draws. Every
   prediction is computed by pushing the posterior draws through the model, so uncertainty in the
   individual parameters carries through to the troughs.
4. **Diagnostics:** split R̂ and split-chain bulk effective sample size per parameter, acceptance,
   and a per-parameter "informed by your data" measure. A fit that does not converge is shown as
   *not reliable* and its predictions are withheld.

**What the headline probability means.** `P(true trough > target)` is computed from the
*latent* concentration of each posterior draw. Assay (residual) error is deliberately left out,
and the table, tooltips and report say so, so a measured level can differ from the band.

**Safeguards for real-world data entry.** The app asks whether the patient was treated before
the first entered dose (missing earlier doses make a patient look like a slow eliminator and the
forecast falsely reassuring). During a drug's loading phase, or when the last two dosing
intervals disagree, it does not guess the next interval: it shows no assumed next-dose trough
and no projected doses until you enter a planned regimen. Dose, date, concentration and unit
plausibility are checked, and imported session files are validated before use.

**Reproducibility.** The sampler seed is fixed, so the same inputs give the same numbers.

---

## What it deliberately does not do

- Suggest, optimize or titrate a dose or interval.
- Model anti-drug antibodies (the crovalimab stream is the ADA-negative population).
- Model a patient who was switched from one drug to another: a session models one drug throughout.
- Validate the models in children, pregnancy or dialysis-dependent renal failure. Crovalimab refuses
  age < 12 years and flags 12–16; eculizumab accepts weights down to 3 kg, with a caution that the
  lowest weights rely on allometric extrapolation.
- Propagate uncertainty in the population parameters (only between-patient and posterior
  uncertainty).
- Send, store or sync anything. Nothing leaves the device; the only persistence is an optional
  local autosave and JSON export you control.

---

## Validation

- **Transcription:** `node tools/verify_control_streams.mjs` re-implements each NONMEM `$DES` /
  `ADVAN` system independently and compares it with the app's model: maximum relative deviation
  ≤ 2.7 × 10⁻⁴ % for all three drugs.
- **Against NONMEM:** for 14 simulated subjects across the three drugs (rich, sparse, trough-only,
  single-trough and below-LLOQ designs), the app's MAP estimates agree with NONMEM `POSTHOC`
  empirical-Bayes estimates to within 0.006 of NONMEM's own standard error
  ([`validation/results_table.md`](validation/results_table.md)).
- **Calibration:** `npm run calibration` runs a simulate-then-fit study (300 patients per scenario,
  five scenarios, the production MCMC). All five scenarios give 89.3–90.0 % coverage of the nominal
  90 % trough interval with flat PIT histograms
  ([`docs/VALIDATION.md`](docs/VALIDATION.md)).
- **Test suite:** `npm test` runs 50 suites, about 1 670 assertions, dependency-free. New checks are
  shown to fail against the broken code before they are trusted.

---

## Running, building and testing

Requires **Node ≥ 16** for development only. The app itself has no dependencies.

```bash
npm test                          # full test suite (about 5 minutes)
node tools/verify_control_streams.mjs   # app vs NONMEM control streams
npm run build                     # inline index.html + src/* into complementtdm.html
npm run calibration               # the long simulate-then-fit calibration study
```

`index.html` here is the **build template**; `complementtdm.html` is the generated single-file
app (never edit it by hand). The version lives in one place, `src/version.js`, and must match
`package.json`.

```
src/model.js        drug specifications, ODE solver, simulation
src/bayes.js        MAP, Laplace, MCMC, diagnostics, runFit, regimen explorer
src/chart.js        dependency-free SVG charts
src/diagnostics.js  fit-diagnostic panels
src/ui.js           forms, session handling, tables, report
src/app.css         styles (including phone layout and print)
tests/              50 suites (Node, no install)
tools/              control-stream cross-check, calibration study, golden-vector generator
validation/         NONMEM post-hoc comparison, run files and report
docs/               developer guide, validation write-ups, audit and review notes
```

The developer guide ([`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)) covers the
architecture, public APIs, conventions and the reasoning behind each release.

---

## Sources and licensing

The code is released under the [MIT License](LICENSE). The pharmacokinetic models are
transcriptions of published or regulatory sources listed above; please cite those sources
when you use the corresponding model. Trough targets are taken from
[PMID 35238929](https://pubmed.ncbi.nlm.nih.gov/35238929/) (eculizumab),
[PMID 33512711](https://pubmed.ncbi.nlm.nih.gov/33512711/) (ravulizumab) and
[PMID 39835421](https://pubmed.ncbi.nlm.nih.gov/39835421/) (crovalimab). The eculizumab
article itself is not redistributed here.

## Author

Rob ter Heine, [Radboud Applied Pharmacometrics](https://www.radboudumc.nl/en/research/research-groups/applied-pharmacometrics),
Radboudumc, Nijmegen — <r.terheine@radboudumc.nl>
