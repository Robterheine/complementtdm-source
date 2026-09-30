# Validation report — mAb TDM app (v0.19.0)

**Model basis:**
- Eculizumab: ter Avest M, et al. *Model-Informed Precision Dosing of Eculizumab in
  Patients with Paroxysmal Nocturnal Hemoglobinuria.* Clin Pharmacokinet
  2025;64:1139–1147 (doi:10.1007/s40262-025-01536-x) — final population PK model,
  NONMEM control stream provided with this project.
- Ravulizumab: a simplified population PK model from the Ultomiris (ravulizumab) FDA
  review — the final NONMEM control stream shipped with this project
  (`ravulizumab.txt`). FDA review documents:
  https://www.accessdata.fda.gov/drugsatfda_docs/nda/2018/761108Orig1s000TOC.html
- Crovalimab: the population PK model from the PiaSky (crovalimab) FDA review
  (NDA 761388, Integrated Review; Table 118 / PoP PK study report poppk-1119348) —
  the final NONMEM control stream (`crovalimab.txt`, run05) shipped with this project.
  FDA review documents:
  https://www.accessdata.fda.gov/drugsatfda_docs/nda/2024/761388Orig1s000TOC.html

**Scope (v0.6):** a clean multi-drug TDM/forecasting tool. The user selects the drug
(eculizumab, ravulizumab or crovalimab; extensible registry), enters the patient, the
actual dosing schedule and measured concentrations; the app individualizes (MAP-Bayes +
MCMC) and forecasts. **No dosing strategies, templates, or preprogrammed regimens are
included** — no article/label/SmPC dosing rules — so the app never suggests a dose.

**Interface (v0.6):** only covariates the selected model actually uses are asked for —
weight always; disease (PNH/aHUS) **only for eculizumab** (a covariate there via aHUS
between-occasion variability); **age only for crovalimab** (covariate of the SC
absorption rate); ravulizumab shows neither. Field limits (dose range, measurement
range, target range) and tooltips are **driven by the drug spec**, so the UI is
consistent per model. The research-use disclaimer, version, per-model documentation
**and each model's assumptions** (e.g. crovalimab: no ADA effect, rich-sampling residual
error, assumed 1-h loading infusion) live in the **About** dialog; the main interface is
clean, and the printed summary carries the disclaimer and credit.

All checks are automated in `tests/` (`npm test`). Randomised checks use fixed seeds
and are deterministic. **500/500 assertions pass** (model, Bayesian engine, stress,
steady-state engine, multi-drug registry, administration-route/pending-drug,
crovalimab, audit regressions, statistical correctness, multi-eta engine,
simulate-then-fit calibration, empty-defaults policy, print report,
novice-usability suite, centralised-version suite, model verification vs control
streams).

## v0.19.0 — weekly-only interval candidates; stepper step 4 restored

**Date:** 2026-09-12 · **Suite:** 23 suites / 805 assertions, all green ·
`node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

Two items of direct author feedback. README §23 has the full account.

**V1 — regimen-explorer candidates snapped to whole weeks.** `B.candidateIntervals()`
previously rounded fractional day-multipliers to the nearest whole day, which could
(and for a 14-day baseline at 1.25×, did) land on a non-multiple-of-7 value — clinically
undoable, since a fixed non-weekly interval drifts across weekdays every cycle.
Redesigned to build candidates directly from whole-week offsets around the current
interval (itself rounded to the nearest week first). Verified for eight baselines
(7, 10, 14, 21, 28, 42, 56, 84 days): every returned candidate divides evenly by 7,
7-8 distinct candidates are returned in every case (the old design could collapse to
fewer for a short baseline), and an end-to-end `intervalScan()` run confirms every
regimen actually evaluated — not just proposed — is a whole week. `B.doseScan()` is
explicitly confirmed unaffected: it keeps the clinician's own entered interval exactly
as entered.

**V2 — stepper step 4 re-added.** v0.16.0 had removed a fourth stepper step on the
reasoning that the regimen explorer (card 4) is optional and downstream. Feedback was
that the stepper should still reach 4, matching the fourth card. Re-added, gated on
`state.fit` (forecast run) for "active" and `state.fit.intervalScan` (exploration
actually run) for "done" — mirroring the existing gating pattern used for step 3.

No model, statistical, or drug-spec code changed in either fix.

---

## v0.18.0 — restore-bar/stepper width fixed to match the cards

**Date:** 2026-09-12 · **Suite:** 22 suites / 745 assertions, all green ·
`node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

Author-reported, with a screenshot: on a wide desktop window the restore bar and
stepper visibly bled to the browser edge while the cards below sat in a centered,
inset column. Root cause: both elements lived outside `<main class="layout">` with
their own independently-tuned `max-width`/`margin:auto` (1180px/1720px) that only
approximated `main.layout`'s own box (also 1180px, but with an 18px padding inset the
bars' separate rules did not replicate). Fixed by moving both inside `<main>` as flex
siblings of the cards, deleting their own width rules entirely, so they get their
width from the identical mechanism the cards already use (flex-stretch) rather than a
second, separately-tuned approximation. Verified directly: at a 673px test viewport,
`getBoundingClientRect()` on the restore bar, the stepper and the first card returned
identical left/right/width. Presentation-only; no model, statistical, or behavioural
code changed. README §22 has the full account.

---

## v0.17.0 — phone + desktop responsive plan, implemented in full

**Date:** 2026-09-12 · **Suite:** 21 suites / 732 assertions, all green ·
`node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

Backup taken before this work began (`complementtdm backup 12SEP26.zip`, sibling to the
project directory, matching the author's own backup convention — a full copy of the
v0.16.0 working state). Presentation-only release: no model parameter, likelihood term,
MCMC/Laplace code, or drug spec changed. README §21 has the full account.

**V1 — chart.js compact layout is unit-testable and provably non-overflowing.**
`countLegendRows()` runs the exact greedy-wrap packing the legend renderer itself uses,
*before* the bottom margin is sized, so the reserved height always matches the actual
legend content. `tests/test_v017.js` asserts directly — not by visual inspection — that
no `<text>` y-coordinate exceeds the computed viewBox height across 0-, 2- and 6-item
legends (this app's real range: the main forecast chart alone can show up to 6 legend
items). The desktop path (`cfg.compact` omitted) is asserted byte-identical to the
pre-v0.17.0 output.

**V2 — the print-corruption landmine, verified directly in the browser, not just by
code review.** Before the fix, the report cloned whatever SVG was currently in the live
`#chart` div; once charts could render compact, printing from a narrow window would
have baked a phone-sized chart into the fixed-A4 report. Measured directly: at a 375px
viewport, the live chart's viewBox was `340×407` while the same click's generated
report chart was `960×440` — confirming the fix (a detached-element render, forced
non-compact) actually decouples the two, not merely that the code looks like it should.

**V3 — three pre-existing table-overflow defects, unrelated to the redesign, found and
fixed while scoping it.** The regimen-explorer's 5-column table, the diagnostics
residual-sample table, and the trough table all had no `overflow-x` scroll fallback at
all — confirmed by reading the markup each table renders into, not assumed. All three
now wrap in the existing `.tbl-wrap` pattern already used by the dose/observation
tables; the print copies deliberately do not, since `overflow-x:auto` is a screen-only
concept and print already has its own table-sizing rules.

**V4 — breakpoint consolidation checked for cascade risk before merging.** Three
scattered single-purpose media queries (700px once, 560px twice) collapsed into exactly
one block per breakpoint value. Per the responsive plan's own risk list, the two 560px
blocks' properties were diffed for overlap before merging — none existed — so the
merge could not silently reorder which rule wins on a shared selector.

**V5 — process.** Two parallel specialist reviews (UI design, HTML/CSS implementation
mechanics), both grounded in the actual current CSS/markup rather than a green-field
redesign, reconciled into one plan before any code was written — matching the process
used for v0.13.0 and v0.15.0. Full implementation verified in the browser at a 375px
viewport and at desktop width, covering: the forecast chart, the regimen explorer
(chart + card table), the diagnostics modal (compact GOF chart), the header action
grid, and print-from-mobile — not merely unit-tested.

---

## v0.15.0 — three-reviewer UI/terminology response, chart continuation

**Date:** 2026-09-12 · **Suite:** 20 suites / 687 assertions, all green ·
`node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

Direct feedback from the author using the app on his own forecasts. Reviewed by three
parallel specialist agents (UI design, clinical pharmacology, code quality) before any
code was written, matching the v0.13.0 audit process; README §19 has the full account.
Validation-relevant items:

**V1 — chart-only forecast continuation, proven independent of the fit.** The plotted
concentration curve previously came from the clinician's real doses only and washed
out to zero past the last of them. `runFit` now additionally computes `chartBand` /
`chartPriorBand` from a simulation that continues the regimen at the patient's own
historical dose/interval (`chartProjectedDoses`), for the chart alone. Directly
verified in `tests/test_v015.js`: with this continuation added, the individual
clearance (`clQ.med`) and every entry of `fit.troughs` (median, 5–95%, the "assumed
dose" flag) are bit-for-bit identical to a run without it. This holds by construction,
not coincidence: `virtualTroughTime` evaluates one instant *before* the first projected
dose's administration time, and a dose cannot affect a concentration before it is
given — so the trough table is causally blind to whatever the chart projects forward.
No model parameter changed.

**V2 — no other model or statistical code touched.** This release is UI/labelling and
one clearly-scoped display feature; the MAP/MCMC engine, likelihood, and all three drug
specs are unchanged from v0.14.0. `node tools/verify_control_streams.mjs` deviations are
therefore unchanged: eculizumab 2.70e-4 %, ravulizumab 9.16e-6 %, crovalimab 7.23e-7 %.

**V3 — a hardcoded DOM selector caught before shipping, not after.** Converting fit
diagnostics from an inline `<details>` to a modal meant removing the `id="diagBlock"`
element that `renderDiagnostics`'s hover-sync had hardcoded a query against
(`document.querySelectorAll('#diagBlock .res-row')`). The code-quality reviewer's brief
flagged this specifically as a landmine — removing the id without updating the selector
would have left hover-sync silently matching nothing, forever, with no error, in both
the on-screen modal and (already only cosmetically, since print has no hover) the
printed report. Fixed by parameterising the rows-container id; `tests/test_v015.js`
asserts the old hardcoded string is gone and that both call sites pass their own
correct container id.

**V4 — terminology change carries no numeric risk.** "Posterior"/"Prior (population)"
→ "Individual prediction"/"Population prediction" touches only string literals in
`src/ui.js` (chart legend, series/row labels, report table). No computed value, test
oracle, or exported function name changed. The MCMC engine's own vocabulary
(`etaInformation`, `posterior draws` in the statistical exposition) is deliberately
untouched — see README §19.2 for why that distinction is intentional, not inconsistent.

---

## v0.14.0 — regimen explorer generalized to dose scanning

**Date:** 2026-09-12 · **Suite:** 19 suites / 634 assertions, all green ·
`node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

Direct response to a clinical-pharmacologist question: "if I adjust a dose, show me
the predicted trough and its 90% credible interval at steady state." The v0.13.0
interval explorer (this file, entry above, item V6) computed exactly this quantity
internally (`ss.med`, `ss.p5`, `ss.p95`) but only while scanning candidate *intervals*
at a fixed dose. `B.doseScan()` adds the missing axis: fixed interval, varying dose,
sharing the same underlying computation (`scanOneRegimen`) so the two entry points are
provably consistent — `tests/test_v014.js` confirms `intervalScan` and `doseScan`
return bit-identical steady-state quantiles at an overlapping (dose, interval) point.

**A definitional defect was found and fixed during browser verification, not code
review.** The "next trough" quantity — trough before the next scheduled administration
— is well-defined for an interval change (the delay itself lengthens the decay window)
but is a tautology for a dose change: a trough measured *before* an administration
cannot depend on that administration's amount. The first implementation nonetheless
reused the same evaluation time for both axes, and empirical testing in the browser
showed every candidate dose (650/1300/2600 mg) producing the numerically identical
"next" value — correct arithmetic, wrong question. Fixed by evaluating "next" one dosing
cycle later for a dose scan (after the first administration at the candidate amount,
rather than before it); interval scanning is unaffected. This is recorded as a
methodology note: **a value that never changes across a parameter sweep is a signal to
check the definition, not just the arithmetic** — the same category of defect (a check
that could not fail) as V1 in the v0.13.0 entry above.

**Report inclusion.** The v0.13.0 explorer never printed (`no-print`), so a clinician
who used it to decide on a regimen change had no way to document that reasoning in the
patient record. `reportHtml()` now includes a **Regimen exploration** section whenever
one was run, using the identical table-building function as the screen (`
intervalScanTableHtml`, `forPrint=true` swaps in the report's own table styling), with
an explicit statement that it is not the individualized forecast and not a
recommendation.

**Terminology:** "Sustained trough" → **"Steady-state trough"** (the standard
pharmacometric term) throughout the UI, help text and report.

No model parameter, likelihood term, or MCMC/Laplace code changed in this release —
scope was confined to the regimen-exploration feature and its presentation.

---

## v0.13.0 — multidisciplinary audit remediation + dose-interval explorer

**Date:** 2026-09-12 · **Suite:** 18 suites / 602 assertions, all green ·
`node tools/verify_control_streams.mjs` → `ALL CROSS-CHECKS PASSED`.

A six-specialist audit (clinical pharmacology, nephrology, haematology,
pharmacometrics, statistics, interface design) of v0.12.0 produced ~66 findings.
README §17 records the full disposition including what was deliberately rejected.
Validation-relevant items:

**V1 — the structural cross-check was vacuous and is now real.**
`tools/verify_control_streams.mjs` passed its $DES comparison unconditionally from
v0.8.1 to v0.12.0: `rk4Sim` received `outTimes` as `{t,V}` objects and read `e.t`/`e.V`
as flat values, making every reference concentration `NaN`; `compareConc` used
`rel > worst`, and `NaN > 0` is false, so `worst` never left 0. The tool printed
"max relative deviation 0.00%" against an all-`NaN` reference, and
`tests/test_model_verify.js` asserted only the exit code.
*Consequence:* MODEL_VALIDATION.md §6's claim that an independent integrator agreed to
better than 0.01% had no evidence behind it for four releases.
*Repair:* time/volume unpacked, explicit observed-compartment index, hard failure on any
non-finite or degenerate reference, `{id}` passed to all three `M.simulate` calls.
*Repairing it immediately exposed two real defects in the crovalimab reference block*
that the `NaN` had masked — it read compartment 0 (the SC depot) rather than the central
compartment, and omitted the allometric scaling (WT_REF 75 kg, tested at 70 kg).
**Post-repair deviations (now genuine evidence):** eculizumab 2.70e-4 %,
ravulizumab 9.16e-6 %, crovalimab 7.23e-7 % — all far inside the 0.02% gate.
`test_model_verify.js` now asserts each deviation is present, parseable, strictly > 0
(an exact 0 would mean the reference never ran) and below the gate.

**V2 — calibration evidence right-sized.** `tests/test_e2e_fit.js` (N=24) cannot
distinguish 90% interval coverage from 99% (95% binomial range at that N ≈ 75–98%), and
its observed ~92–96% indicates conservative rather than well-calibrated intervals. It is
now labelled a smoke test in code and in README §9/§11. The real instrument is
`tools/calibration_study.mjs` (`npm run calibration`): N≥300 per scenario, five scenarios
spanning all three drugs plus sparse trough-only and aHUS designs, production MCMC
settings, exact (Wilson) binomial CI on coverage with PASS only when it contains 0.90,
and a PIT histogram with a uniformity test to catch bias and mis-scaled spread that a
single coverage number hides. Over-coverage is reported as a failure, not a success.
Its previous 3400 mg crovalimab dose (not a real dose) was replaced with the EMA schedule.

**V2a — the real calibration run, filed (independent audit F1, 2026-09-13).** V2 above
described the instrument but never quoted a result — the audit found this directly: "the
real study … has no recorded result in the repo," and the number that *was* on file
(96% over N=24) is exactly the smoke test's own admitted limitation, cited as if it were
calibration evidence. `npm run calibration` was run in full (N=300/scenario, production
MCMC, fixed seeding — `mulberry32(20260912)`, per-patient `seed: 4242 + i`, both inside
`tools/calibration_study.mjs`). All five scenarios passed:

```
== crovalimab-sc-peak+troughs ==
   n = 300 (failures 0)
   90% trough-interval coverage : 90.0%  [95% CI 86.1–92.9%]  PASS
   90% eta(CL)-interval coverage: 89.0%
   PIT histogram (10 bins, flat = calibrated): 32 29 24 30 30 24 34 27 39 31
   PIT uniformity: chi2 = 6.1 on 9 df, p = 0.728

== crovalimab-sc-troughs-only ==
   n = 300 (failures 0)
   90% trough-interval coverage : 89.7%  [95% CI 85.7–92.6%]  PASS
   90% eta(CL)-interval coverage: 90.0%
   PIT histogram (10 bins, flat = calibrated): 37 36 21 32 22 35 23 38 28 28
   PIT uniformity: chi2 = 12.7 on 9 df, p = 0.177

== eculizumab-pnh-troughs ==
   n = 300 (failures 0)
   90% trough-interval coverage : 89.3%  [95% CI 85.3–92.3%]  PASS
   90% eta(CL)-interval coverage: 89.7%
   PIT histogram (10 bins, flat = calibrated): 29 32 28 24 33 36 30 24 34 30
   PIT uniformity: chi2 = 4.7 on 9 df, p = 0.858

== eculizumab-ahus-troughs ==
   n = 300 (failures 0)
   90% trough-interval coverage : 89.7%  [95% CI 85.7–92.6%]  PASS
   90% eta(CL)-interval coverage: 89.7%
   PIT histogram (10 bins, flat = calibrated): 31 29 29 23 38 34 26 28 33 29
   PIT uniformity: chi2 = 5.4 on 9 df, p = 0.799

== ravulizumab-iv-troughs ==
   n = 300 (failures 0)
   90% trough-interval coverage : 90.0%  [95% CI 86.1–92.9%]  PASS
   90% eta(CL)-interval coverage: 91.7%
   PIT histogram (10 bins, flat = calibrated): 31 25 24 42 33 29 26 29 28 33
   PIT uniformity: chi2 = 8.2 on 9 df, p = 0.515

ALL SCENARIOS CALIBRATED
```

Every scenario's coverage CI contains 0.90 with neither systematic over- nor
under-coverage (the highest point estimate, 90.0%, sits exactly at nominal, not padded
above it — over-coverage would itself be a failure per this tool's own design, not a
safer outcome), and every PIT histogram is statistically flat (all five χ² tests
p > 0.1, the crovalimab-sc-troughs-only case closest at p = 0.177). This is now the
calibration evidence for this app; `tests/test_e2e_fit.js` remains a fast smoke test
only and must not be cited as calibration evidence (see V2). Re-running with the same
tool version should reproduce this table exactly, given the fixed seeding above.

**V3 — crovalimab parameters re-verified against Table 118.** Every structural
parameter, covariate exponent, IIV term (as variance = CV²) and residual-error term in
`src/model.js` matches the PiaSky population-PK report exactly; IIV F 1.3456 vs the
stored 1.35 is rounding only. Deliberately unimplemented Table 118 items, left unchanged
by instruction: `CLs` 0.0341 L/day, `Kd` 0.0144 /day, ADA-on-CL 0.247, the
sparse-sampling additive RUV (SD 14.4 → variance 207.36 vs the rich-sampling 1.02 in use,
a factor 203) and the IIV on additive RUV (CV 0.787). The sparse/rich choice remains
declared in the crovalimab `assumptions` and now also prints in the report.
*Note:* Table 118 is **Run 59 (final model)** whereas the app transcribes **run05**.

**V4 — inference robustness.** MCMC now runs 4 chains from overdispersed starts with
split-R̂ per eta (warned above 1.05); Nelder–Mead reports `converged` and a dispersed-start
`startGap` (a stalled simplex previously returned `ok: true` and its parameters were shown
to the user as the individual PK); post-burn-in adaptation gain decays as 1/√window to
satisfy diminishing adaptation; acceptance is reported over kept iterations only; the
batch-means Monte-Carlo interval uses `t(0.975, nBatches−1)` = 2.201 at 12 batches instead
of 1.96 (the interval was ~11% too narrow, in the direction that matters at the 90% badge);
`keepEvery` uses `ceil` so `maxKeep` is honoured.

**V5 — entry-form validation defect.** Both add-forms relied on native constraint
validation, which runs before the submit handler — so an off-grid value silently prevented
entry with no app-level message. `step="1"` on concentration made **every** decimal
unenterable (0.8, 7.3, 12.5 µg/mL) while the app's own formatter displays two decimals
below 10 µg/mL; crovalimab's `min:100/step:50` rejected 340, 680 and 1020 mg — every real
maintenance dose. No test exercised either form. Fixed with `step="any"` + `novalidate`
and JS-side validation; `tests/test_v013.js` now submits both forms with real values.

**V6 — dose-interval explorer (new capability).** Interval prolongation is a primary use
of TDM for these agents and was impractical: it required hand-entering future doses and a
full refit per candidate (measured 54 s for five intervals). Since the posterior is
independent of the future schedule, `B.intervalScan()` evaluates candidates from the kept
draws (0.7 s for eight intervals) and reproduces the manual refits (q21d 76 vs 78 µg/mL;
q28d 22 vs 22). It reports **next trough** (next administration delayed only) and
**sustained trough** (continued at that interval) separately, because they diverge sharply
— for the worked eculizumab case at q28d, 117 µg/mL (P ≥ 90%) versus 25 µg/mL (P 0%).
Reporting only the former would be falsely reassuring at the decision point. The feature
applies no threshold and recommends no interval, so the no-dose-suggestion scope (§ Scope)
is preserved.

**V7 — report completeness.** App version and model identity in the header; model
assumptions block; the paediatric/pregnancy/dialysis exclusion sentence restored (it was
present in About but had been dropped from the report); trough-table status column
distinguishing past / upcoming / assumed-next-dose; target provenance printed; the report's
GOF panel given its own element id (it shared `id="gofChart"` with the on-screen copy, so
the printed box was always empty) and `print-color-adjust: exact` so the shrinkage, EBE and
residual graphics survive a default print.

**V8 — clinical-data integrity.** Per-sample *In fit* toggle with a reason, so a sample
drawn after plasma exchange, apheresis or CRRT can be kept on record and out of the
likelihood (previously such a sample was fitted exactly and produced a confidently wrong
clearance that every diagnostic reported as good). Dates carry the year everywhere
including the report; out-of-range timestamps and order-of-magnitude dose/concentration
entries are challenged; session autosave with an explicit Restore/Discard offer.

**V9 — terminology.** The 5–95% band is described as a **credible interval for the true
concentration** (it excludes residual assay error) rather than a "prediction interval";
`etaShrinkage` renamed to `etaInformation` / "data-informativeness" because the computed
quantity runs opposite in polarity to classical η-shrinkage and would invert the meaning
for a pharmacometrician reader. Neither change alters any computed value.

---

## v0.12.0 — log y-axis, folded trough target, central version, research-group link

Four interface/maintenance changes; **no estimation or model change** (all three
models and their parameters are untouched — the control-stream cross-check still
reports 0.00% $DES deviation).

- **Log-scale y-axis option** (`src/chart.js` + the "Log scale (y-axis)" toggle in
the Forecast card). Values stay in µg/mL; only the vertical spacing changes. The
axis snaps to whole decades with a 1-2-5 tick sequence (`logTicks`), so the grid
stays readable when the band or target spans more than about 10-fold. View-only:
toggling re-renders without a refit. Default off (linear), so nothing changes for
existing users.
- **Folded trough target.** The target now sits in a collapsed `<details>` in the
Drug & patient card: the summary always shows the value actually used by the
forecast and the plot, while editing requires an explicit open — an accidental
click or scroll can no longer change it. The field is **prefilled with the selected
drug's default target** (eculizumab/crovalimab 75 µg/mL, ravulizumab 100 µg/mL) and
is reset to the new drug's default on a drug switch, so the summary, the
P(trough > target) column and the dashed target line always agree.
- **Centralised version number.** `src/version.js` is the single source of truth
(`ECU.VERSION`). It feeds the browser title, the header, the footer, the About
dialog and the session export; `build.mjs` and `tests/test_version.js` fail/warn if
`package.json` drifts from it. Bump one string per change.
- **Research-group link.** "Radboud Applied Pharmacometrics"
(https://www.radboudumc.nl/en/research/research-groups/applied-pharmacometrics) is
linked in the footer and in the About dialog next to the contact details.

**Verified:** `tests/test_version.js` (14 assertions) — version parsed from
`src/version.js`, matches `package.json`, index.html loads it before `ui.js` and
exposes the header/footer placeholders, build.mjs inlines it; `test_usability.js`
extended (67 assertions) — log toggle + `logTicks(1,100)` 1-2-5 coverage, folded
target contains `pt-target`, version placeholders, research-group links, generic
patient-ID placeholder, About review-reference link, styles present; `test_drugs.js`
extended — the ravulizumab (NDA 761108) and crovalimab (NDA 761388) FDA-review
reference URLs are present on the specs and surfaced in About. 500/500 assertions
pass.

## v0.10.0 — individual fit diagnostics (GOF + EBE vs population)

Two new expert-oriented panels, collapsed by default in the results card under
"Fit diagnostics" and included in the print report:

- **Observed vs individual prediction** — scatter with identity line and a
  ±2 SD band from the drug's own residual error model
  (SD = √(σ²_add + σ²_prop · pred²)), plus a per-sample residual strip with
  colour-coded relative residuals (green ≤ 30%, amber 30–60%, red > 60%).
  Censored (<LLOQ) samples are listed as censored (M3) — no fake predictions.
- **EBE vs population** — forest rows for CL and V1: posterior median and
  5–95% range as % departure from the *covariate-adjusted* population typical
  value (η = 0 at the patient's weight/age), colour-coded against ±40%
  population variability. The caption cross-references the shrinkage bars.

**New engine exports (bayes.runFit):** `obsData[i].ipred` (median posterior
prediction at each observation time — observation times are merged into the
posterior simulation grid), `popTypical` (indivParams at η = 0), and the
unsorted posterior `clPostDraws`/`v1PostDraws`. The MAP/MCMC estimation itself
is unchanged; the panels are presentation-only over the existing posterior.

**Verified:** `tests/test_diagnostics.js` (32 assertions) — engine exports
consistent with clQ/v1Q quantiles, GOF band geometry matches the error model,
residual thresholds, EBE % departures, noise-free end-to-end fit (residuals
< 5%, GOF points on the identity line), graceful degradation for population
fits. HTML/obs-time plumbing exercised in the browser.

## v0.9.2 — shrinkage visual in results card and print report

The per-eta identifiability diagnostics introduced in v0.9.1 are now also
rendered as a compact colour-coded bar chart (one row per eta: bar length =
share of the random effect informed by the patient's samples; green ≥ 50%,
amber 30–49%, grey < 30% = prior-anchored). No calculation changed — this is
purely a presentation of the same shrinkage values.

- Results card: bars appear under the parameter block whenever an
  individualized fit has shrinkage diagnostics.
- Print report: a "Data-informativeness per parameter" row carries the same
  visual; the text summary is kept for the record.
- Print stylesheet keeps the bars legible on paper (white background, darker
  fills).

## v0.9.1 — identifiability diagnostics + end-to-end calibration study

Two additions following the v0.9.0 multi-eta work — both diagnostic-only, neither
changes MAP/MCMC estimates or any transcribed parameter:

- **Identifiability diagnostics in `runFit`** (`src/bayes.js`):
  - `etaShrinkage`: per-eta shrinkage toward the population prior
    (1 − posterior variance / prior variance, from the kept MCMC draws;
    0 = data uninformative for that eta, 1 = well determined).
  - `etaCorr`: posterior correlation matrix across the etas (exposes trade-offs
    such as CL↔F under SC-only sampling).
  - **UI advisory:** when one or more etas have shrinkage < 0.3, the results card
    shows a gentle info note naming them, explaining that the estimate stays close
    to the population model, and suggesting a peak sample (1–2 weeks post-dose for
    SC drugs) alongside the trough to separate absorption from elimination.
  - **Print report:** the fit-quality table gains a "random effects informed by
    the samples" row (per-eta shrinkage as percentages).
  - Verified behaviour (`tools/probe_ident.js`): with 2 SC troughs only,
    η(KA) shrinkage ≈ 0.00 (prior-anchored, correctly reported); adding an SC
    peak raises F shrinkage 0.41 → 0.55 and relaxes corr(CL,F) 0.35 → 0.26.
- **End-to-end simulate-then-fit calibration study** (`tests/test_e2e_fit.js`,
  part of `npm test`): for 24 seeded prior-simulated crovalimab patients (all six
  etas from $OMEGA), generate a peak + 2 troughs with residual error, run the
  complete `runFit` pipeline as the UI does, and compare against ground truth:
  - **90% trough-interval coverage: 96%** (binomial range for p = 0.9,
    n = 24: 75–98%) — the prediction intervals are honestly calibrated;
  - η(CL) 90% posterior-interval coverage: 92%;
  - 0 pipeline failures; between-patient predicted-trough CV 28%
    (individualization propagates to the forecast);
  - shrinkage diagnostics finite and in [0, 1] for every patient.
- Suite count: **428 assertions** across 14 suites.

## v0.9.0 — full multi-eta MAP-Bayes for all models (former #3, now implemented)

The Bayesian engine is now **dimension-agnostic** and estimates **every population PK
random effect of each control stream**:

- **Eculizumab:** η(CL), η(V1) (2-eta, unchanged). Between-occasion clearance
  variability (IOV, aHUS only) remains folded into the CL prior — it is an
  occasion-level effect, not identifiable from within-occasion TDM data.
- **Ravulizumab:** η(CL), η(V1) with the $OMEGA BLOCK(2) covariance (0.0161)
  propagated through MAP, Laplace and MCMC (unchanged).
- **Crovalimab (the change):** all six disposition etas of run05 are now estimated
  jointly — [CL, V2(central), Q, V3, KA, F] with ω² = [0.0424, 0.0502, 0.341,
  0.498, 0.147, 1.35(logit)]. Only $OMEGA item 7 (IIV on the additive residual
  error, not a PK parameter) stays out of the estimation. Implementation:
  `ETA: {names, vars, fLogitIdx}` on the spec; `priorOmega()` returns the full
  diagonal; `bayes.js` generalized (OFV, Nelder–Mead with per-dimension steps
  scaled to the prior SDs, 6×6 Laplace Hessian, 6×6 proposal Cholesky, prior
  draws). MCMC uses 10,000 iterations for dims > 2 (vs 8,000) to compensate for
  the slower mixing of higher-dimensional chains.
- **Numerical verification** (seeded, part of the suite in
  `tests/test_multieta.js`): MAP recovery from 2 SC troughs over 40
  prior-simulated patients — median |η(CL)| error 0.107, p90 0.273, bias −0.003,
  0 optimizer failures; 6×6 Laplace covariance valid (no fallback, condition ≈ 22)
  with posterior variances ≤ priors (Q and ka ≈ prior from 2 SC troughs —
  correctly weakly identified); MCMC in 6D healthy (acceptance ≈ 0.30,
  ESS(ηCL) ≈ 380 at 10,000 iterations; full `runFit` ≈ 6 s in Node — covered by
  the progress bar in the browser).
- The v0.8.1 band-only ka/F aux sampling (`OMEGA_AUX`/`auxDraws`) is kept only
  for backward compatibility with the legacy 2-eta draw path; full-eta drugs no
  longer use it (the posterior draws already carry ka/F).
- UI: the results card and print report show the full eta vector with the
  spec's names (η(CL), η(V1), η(Q), η(V2), η(KA), η(F) for crovalimab) via the
  new dimension-agnostic `etaLabel`/`fmtEtaVec` helpers.

## v0.8.1 — pharmacometrician-audit follow-up (#1 guard-rail, #2 crovalimab band honesty)

No UI changes — engine + test guard-railing only:

- **#1 — control-stream cross-check in the suite.** `tools/verify_control_streams.mjs`
  (the pharmacometrician's transcription + $DES-equivalence check) is now wired
  into `npm test` via `tests/test_model_verify.js`: the suite spawns the script and
  fails if it does not exit 0 with "ALL CROSS-CHECKS PASSED". Any future edit to
  `src/model.js` or the shipped control streams that breaks a $THETA/$OMEGA/$SIGMA
  value or the ODE structure now breaks the build. The same suite also asserts the
  new aux-sampling contract (see below).
- **#2 — crovalimab band honesty (ka/F).** Crovalimab's IIV on SC absorption rate
  ka (ω² 0.147) and bioavailability F (ω² 1.35 on the logit scale, $OMEGA items 5–6)
  is now **sampled from the population prior in the band simulations only**
  (prior predictive bands and the posterior predictive bands conditional on the
  fitted CL/V1). New `OMEGA_AUX: {ka: 0.147, f: 1.35, fLogit: true}` on the
  crovalimab spec; `src/bayes.js:auxDraws()` generates per-draw `{etaKA, etaF}`
  (F on the logit scale, clamped to (0.01, 0.99)); `src/model.js:withRoutes()`
  applies them as `ka·exp(etaKA)` and `logit⁻¹(logit(F)+etaF)`; both band paths
  in `bayes.js:runFit()` carry an `auxPerDraw` array (never used in MAP/MCMC, so
  individualization behaviour is unchanged). SC-dosed crovalimab bands are now
  honestly wider — typically a clearly visible widening at the 5–95% band edges
  for SC troughs — while IV-only drugs and MAP results are unaffected.
- **#3 — full multi-eta MAP — deferred by design** (see §8). Recorded as a planned
  future fidelity improvement, not implemented now; the 2-eta design remains the
  documented trade-off.
- Cross-link: see `MODEL_VALIDATION.md` for the full pharmacometrician validation
  that these changes preserve; see `tools/verify_control_streams.mjs` for the
  reproducible check.

## v0.8.0 — novice-usability improvements (P1–P5 of NOVICE_UI_REVIEW.md)

Implemented with **no statistical or engine changes** — all edits are in the UI layer
(`index.html`, `src/app.css`, `src/ui.js`):

- **P1 — guided first step:** a one-line, dismissible stepper under the header
  (*1 weight · 2 doses · 3 samples · 4 Run*); each dot fills as the step is completed.
  The Run forecast button is **disabled with a plain-language reason** ("Enter the
  patient's weight and at least one dose to run the forecast.") instead of alerting
  after the click; readiness is re-evaluated on every input/mode/drug change.
- **P2 — two-tier help:** six ⓘ popover buttons (weight, age, trough target, LLOQ,
  < LLOQ checkbox, assay-error multiplier) with prescriber-language text, opening on
  click/tap (Escape or outside click closes; positioned within the viewport). The
  P-badges get the same treatment for their dynamic probability text incl. the
  Monte-Carlo interval. **All ~30 existing native hover tooltips are retained** —
  the scheme adds tap-capable help without removing anything. Technical wording
  (ka equations, allometric references) stays in the titles and the About dialog.
- **P3 — prescriber-first results:** the results card leads with "Individualized to
  this patient's N measured concentrations" or "Population forecast — no samples
  fitted yet"; the Bayesian diagnostics (MAP CL/V1 with ranges, η, draws/ESS/
  acceptance, runtime wording removed) moved into a collapsed "How this was
  calculated" details block that also adds a qualitative **sampling-precision word**
  (good / intermediate / low — consider re-sampling; from ESS and the Laplace
  fallback flag).
- **P4 — consistency fixes:** the age field is empty-by-default (placeholder
  `e.g. 36`, matching the v0.7.1 policy); the assay-error multiplier legend now says
  "Default 1 — leave unchanged unless your lab advises otherwise"; "clear all" no
  longer uses a blocking native `confirm()` — it clears immediately with a
  **6-second Undo toast**; switching to a drug without a disease covariate clears
  the stale hidden disease value and note.
- **P5 — report expectation:** once the run button is ready, a faint line under it
  reads "You will be asked who prepared the report when you print."
- New suite `tests/test_usability.js` (37 assertions): ⓘ markers for the six fields,
  HELP map completeness, native titles preserved (two-tier scheme), stepper/toast/
  run-hint elements, empty-by-default age, version bump, precisionWord buckets,
  helpTextFor lookup, report generators still exported.

## v0.7.2 — print report

The former “Print summary” (which printed the app UI with buttons hidden) is replaced
by a generated, print-only **report document** with a clinician-facing structure:

- **Report dialog** (opens on “Print report”): free-text **Prepared by** and
  **Advice** fields. Both are optional, stored in the session and exported/imported
  with it; the dialog pre-fills them on repeat prints. The main screen is unchanged —
  these fields exist only for the report.
- **Report sections**: header (drug, model source, generation time, prepared by) →
  patient & data (pseudonym, weight, age/disease when covariates, target, LLOQ,
  error multiplier) → dosing schedule (given/planned; steady-state summarized) →
  measured concentrations (incl. < LLOQ flagging and each sample's position relative
  to the nearest dose) → fit quality (method, posterior CL/V1 [5–95%], η, draws/ESS,
  residual error model) → forecast (chart SVG + trough table with P(> target)) →
  **model findings** (auto-generated, incl. honest population-fit and all-BLQ
  statements) → **Advice** (the clinician's free text, printed verbatim with visible
  placeholder when empty) → signature lines (prepared by / reviewed by) → disclaimer
  footer.
- Printing replaces the app UI entirely (the app and its forms never print); the
  report sheet is removed again after printing. A stale-inputs confirm guards
  printing a report that documents the *last run* after inputs changed.
- Regression suite `tests/test_report.js` (25 assertions): report HTML generation for
  individualized and population fits, escaping of prepared-by/advice/pseudonym,
  verbatim advice with line breaks, visible placeholders for empty fields, no
  NaN/undefined leaks, presence of all essential sections.

## v0.7.1 — empty-by-default input policy

All data fields (weight, trough target, dose, interval) now start **empty** — no
pre-filled values. Consequences that were verified:

- Blank weight and a non-finite target are **rejected by the engine** (`runFit` throws
  a clear error) rather than silently simulated — a blank weight would previously
  have produced zero allometric clearance. The UI validates before running and the
  engine re-guards independently (defense in depth).
- A blank trough target falls back to the selected drug's `targetDefault` for
  computation (eculizumab/crovalimab 75, ravulizumab 100 µg/mL); the field itself
  stays empty and shows the drug's default as a grey placeholder plus the target hint.
- Dose/interval fields show per-drug example placeholders (`e.g. 900`); `applyDrugUI`
  no longer overwrites any user-entered value, so switching mode or re-selecting a
  drug cannot clobber entered data. Drug switch clears only the (per-drug) target.
- Session import of older files that predate this policy still works (values load as
  entered).
- Regression suite `tests/test_empty_fields.js` (10 assertions): blank-weight/NaN
  guards, no-NaN trough statistics on a blank-field population run, per-drug default
  targets.

## v0.7 — statistical audit remediation (BAYES_AUDIT.md P1–P8)

The Bayesian engine was audited by a statistician (see `BAYES_AUDIT.md`) and all
eight proposals were implemented:

- **P1 — exact likelihood.** The OFV now includes the Gaussian log-variance term
  `log SD²` for quantified observations (constant-across-η only with a purely additive
  error model). MAP estimates shift slightly (in the correct direction); a variance
  floor (10⁻⁶) guards the degenerate pred→0 case. Regression: the OFV is verified
  against the closed-form −2logL of a 1-compartment bolus case (`tests/test_stats.js`).
- **P2 — honest probability.** P(trough > target) now carries a Monte-Carlo 95%
  interval computed by batch means over the chain order (12 batches; respects
  autocorrelation), shown in the badge tooltips; the trough-table legend mentions it.
- **P3 — mixing and ESS.** MCMC default 8000 iterations (was 4000), keeping up to 2400
  draws (keep-every 2), with gentle continued step-size adaptation during sampling;
  an initial-monotone-positive-sequence (Geyer) ESS estimator is reported in the
  results meta line ("ESS ≈ …"). Post-fix ESS ≈ 700 of 2400 (typical 2-obs fit).
- **P4 — Laplace robustness.** `laplaceCov` returns `{cov, fallback, h}`, retries at
  h/2 and keeps the better-conditioned positive-definite estimate; the prior-based
  fallback (now flagged, surfaced as a caution note in the UI) only triggers when the
  curvature is genuinely unusable (e.g. BLQ-only data). The MCMC step-size is
  initialized from the proposal scale instead of a fixed 0.6.
- **P5 — MAP refinement.** Third Nelder–Mead stage (step 0.02) tightens flat
  posteriors.
- **P6 — prior band.** Prior predictive draws 400 → 1000 (stable 5–95% tails).
- **P7 — assumptions.** Documented in About: crovalimab CL estimated from SC samples
  absorbs absorption (ka/F) variability; eculizumab aHUS multi-occasion samples are
  pooled with occasion variability folded into the CL prior.
- **P8 — assay-error multiplier.** Advanced input (0.1–10, default 1) under
  "Advanced (assay error)" in the patient card; scales SD² by its square so a noisier
  local assay automatically shrinks the individualization toward the population.
  Included in session export/import.

**Post-fix calibration re-check** (24 prior-simulated patients, 2 noisy troughs each,
4000-iteration chains): coverage of the true next trough in the reported 5–95% band
**96%** (nominal 90%); median trough error −4.3 µg/mL; P interval bracketed the
reported P in 24/24 fits. Full-chain runtime ≈ 1 s in Node (≈ 2–3 s in the browser).

---

## 1. Model transcription

| Parameter | Value (70 kg) | Control stream `$THETA` | Units | Implementation |
|---|---|---|---|---|
| Linear clearance CL | 0.1626 | THETA(1) | L/day | `THETA.CL` |
| Central volume V1 | 4.299 | THETA(2) | L | `THETA.V1` |
| Max. MM rate Vmax | 25.64 | THETA(3) | mg/day | `THETA.VMAX` |
| MM constant Km | 13.54 | THETA(4) | mg/L (=µg/mL) | `THETA.KM` |
| Peripheral volume V2 | 2.63 | THETA(5) | L | `THETA.V2` |
| Intercompartmental flow Q | 0.6243 | THETA(6) | L/day | `THETA.Q` |
| IIV CL (ω²) | 0.1546 | `$OMEGA` | – | `OMEGA.CL` |
| IIV V1 (ω²) | 0.0812 | `$OMEGA` | – | `OMEGA.V1` |
| IOV CL, aHUS only (ω²) | 0.112 | `$OMEGA BLOCK(1)… SAME ×6` | – | `OMEGA_IOV_CL` |
| Residual: additive variance | 19.1 | `$SIGMA` ERR(1) | µg²/mL² | `SIGMA.ADD` |
| Residual: proportional variance | 0.0185 | `$SIGMA` ERR(2) | – | `SIGMA.PROP` |

- Time unit **days**, doses mg, concentrations mg/L = µg/mL (as in the control stream).
- Doses administered as **fixed 30-minute IV infusions** (per approved specification).
- Allometry: CL, Vmax, Q ∝ (WT/70)^0.75; V1, V2 ∝ (WT/70).
- Structural model: two compartments; elimination from central = linear (CL·C) +
  Michaelis–Menten (Vmax·C/(Km+C)). `dadt1 = −kel·A1 − Vmax·C/(Km+C) − k12·A1 + k21·A2`,
  `dadt2 = −k21·A2 + k12·A1`, `C = A1/V1`.
- Residual error: `Y = IPRED + ε1 + IPRED·ε2`, SD² = 19.1 + 0.0185·pred² (Radboudumc
  assay). Only this residual error model is used; no assay selector is exposed.

## 1b. Ravulizumab model (multi-drug registry)

The ravulizumab control stream (`ravulizumab.txt`) is an ADVAN3 (two-compartment),
linear-elimination model — no Michaelis–Menten term. **Time in the control stream is
hours; all rates are scaled uniformly to per-day** (an exact linear time rescale):

| Parameter | Control stream | Scaled to days (engine) |
|---|---|---|
| Linear clearance CL | 0.00342 L/h | 0.08208 L/day |
| Central volume V1 | 3.43 L | 3.43 L |
| Peripheral volume V2 | 1.86 L | 1.86 L |
| Intercompartmental flow Q | 0.0162 L/h | 0.3888 L/day |
| Allometric exponents | 0.833 (CL/Q), 0.62 (V) | same |
| IIV block | ω²_CL 0.0569, cov 0.0161, ω²_V1 0.0264 | same (bivariate prior) |
| Residual | proportional only 0.0239 | same (additive = 0) |
| Infusion duration | D1 = 2.5 h | 2.5/24 day |
| IOV | none | none (same prior for PNH and aHUS) |

Engine checks (automated in `tests/test_drugs.js`):
- scaled parameters reproduce the control-stream values to machine precision;
- prior sampling reproduces the **correlated** omega block (Cholesky factor; sample
  covariance within Monte-Carlo tolerance) and the MAP penalty uses the full bivariate
  quadratic form — the eculizumab prior (covariance 0) is unchanged bit-for-bit;
- 80-kg, 3000 mg q8w reaches steady state (trough ≈ 356 µg/mL, peak ≈ 1150 µg/mL,
  approx. t½ ≈ 28 d — plausible for ravulizumab's long half-life);
- MAP recovers simulated eta(CL), eta(V1) from sparse trough/peak samples.

**Caveat:** this is a simplified research re-implementation of the FDA-review PoP PK
(linear elimination, no IOV, weight only as covariate). It reproduces the control
stream exactly but has **not** been independently validated for TDM and requires its
own prospective validation — this is flagged in the app and the README.

## 2. Numerical (ODE) verification

Independent Python RK4 reference implementation (`tools/gen_golden.py`, h = 5×10⁻⁴ d,
event-aware) generated `tests/golden.json` (5 scenarios: PNH/aHUS, 55–95 kg, several
user-typed schedules, plus a Vmax=0 scenario). JS solver (Dormand–Prince 5(4),
adaptive) compared at rtol 1e-9/atol 1e-12 — **max relative deviation 1.2×10⁻⁸** across
all scenarios (mean ~2–5×10⁻⁹).

Analytic closed-form check (linear 2-compartment bolus, Vmax=0, superposition of two
exponentials): **max relative deviation 1.7×10⁻¹¹**.

Default in-app tolerance is rtol 1e-6 (≈ NONMEM `TOL=6`), >100× tighter than the
residual error and without measurable effect on likelihoods.

## 3. Model-consistency anchors (PK only, typical η = 0)

| Check | Model | Article |
|---|---|---|
| Steady-state trough, 83 kg, 900 mg q2w | 129.6 µg/mL | observed median 153 (IQR 101–219) |
| Peak, 83 kg, 900 mg q2w | 299.6 µg/mL | observed median 327 (IQR 265–405) |

Observed concentrations include dose-escalated patients and assay variability, so
model-vs-observation offsets are expected. Population-level trough-distribution
comparisons (n = 3000, NHANES-like weights, prior IIV) agree with the article at the
clinically relevant boundaries: 900 mg q2w gives 3.5% of patients with steady-state
troughs < 50 µg/mL (article: 3.2%) and 96.5% > 50 µg/mL (article ~96.8%).

## 4. Bayesian engine diagnostics (fixed seeds)

- **MAP recovery** (n=80 simulated patients, 3 sparse observations each: trough–peak–
  trough): median |error η_CL| = 0.088, p90 = 0.290; median |error η_V1| = 0.116.
- **Laplace 90%-interval coverage**: η_CL 83%, η_V1 91% (nominal 90%).
- **MCMC** (adaptive random-walk Metropolis): mean acceptance 0.35 (target 0.30);
  posterior medians track the MAP (mean |posterior median − MAP| = 0.049 on η_CL).
- End-to-end forecast incl. MCMC completes in ≈1–2 s in a browser and ≈0.2 s in Node.
- M3 handling of below-LLOQ observations (Φ-based likelihood term) verified finite and
  sensible.

## 4b. Administration routes & pending-drug guard

The engine implements subcutaneous dosing via a depot compartment with first-order
absorption (rate ka, day⁻¹) and bioavailability F, activated per dose by
`route: 'sc'`; IV doses are unchanged. Pending specs (placeholder drugs awaiting a
control stream) are guarded: `indivParams`, `simulate` and `runFit` throw a clear
"parameters not yet available" error instead of computing nonsense, and the selector
entry is disabled.

Automated in `tests/test_routes.js`:
- pending spec guard on a synthetic placeholder (indivParams / simulate / runFit all
  refuse with a clear error);
- SC depot absorption: peak later and lower than the same IV dose (flip-flop);
- SC/IV area-under-the-curve ratio ≈ bioavailability (F = 0.75) within truncation;
- mixed IV-loading + SC-maintenance schedule simulates finitely and stays positive;
- ka = 0 (IV-only drug) rejects an SC dose with a clear error;
- eculizumab/ravulizumab keep ka = 0 (IV only) and simulate unchanged by the refactor.

## 4c. Crovalimab model (PiaSky FDA review, control stream run05)

The crovalimab control stream (`crovalimab.txt`, run05) is a 3-compartment model in
**days** — no unit conversion applied: SC depot (CMT 1, bioavailability F1 = 0.83,
logit-transformed with IIV constraining it < 1) → central compartment (CMT 2, also the
IV dosing and observation compartment) ↔ peripheral compartment (CMT 3); linear
clearance.

| Parameter | Control stream / Table 118 | Implementation |
|---|---|---|
| CL | 0.0791 L/day (RSE 6.7%) | `THETA.CL` |
| V2 (central) | 3.23 L (RSE 1.3%) | `THETA.V1` |
| Q | 0.168 L/day (RSE 12.4%) | `THETA.Q` |
| V3 (peripheral) | 2.32 L (RSE 7.2%) | `THETA.V2` |
| ka | 0.126 /day (RSE 13.0%) | `KA_D` |
| F1 | 0.830 (RSE 7.7%) | `BIOAVAIL_SC` |
| WT on CL, Q | 0.750 (FIX), reference 75 kg | `EXPO.CLQ`, `WT_REF` |
| WT on V2, V3 | 0.684 (RSE 8.1%) | `EXPO.V` |
| Age on ka | −0.459 (RSE 26.5%): ka = 0.126·(age/36)^−0.459 | `AGE_EXPO_KA`, `AGE_REF` |
| IIV CL (ω²) | 0.0424 (CV 20.6%) | `OMEGA.CL` |
| IIV V2 (ω²) | 0.0502 (CV 22.4%) | `OMEGA.V1` |
| Residual | prop 0.01277 + add 1.02 (variances; CV 11.3%, SD 1.01) | `SIGMA.PROP`, `SIGMA.ADD` |

Not individually estimated: the IIV on additive error (0.619, $OMEGA item 7) is
folded out — the fit uses prop + additive only. **All six disposition etas are
estimated since v0.9.0** ($OMEGA items 1–6; see the v0.9.0 section above).
(Note: Table 118 of the FDA review reports higher
IIV values for Q/V3/ka — 0.584/0.706/0.383 — a different parameterization; the
control stream, which the app implements, is treated as authoritative.)

Automated in `tests/test_crovalimab.js` (45 assertions):
- transcription: THETA/OMEGA/SIGMA/covariate relations match the control stream to
  machine precision; target default 75 µg/mL; age flagged as a UI covariate;
- covariate relations: CL/Q/V allometry on (WT/75), ka age scaling with the −0.459
  exponent (older → slower absorption), fallback to the reference age when omitted;
- routes: IV loading peaks at end of infusion, SC dose peaks days later and lower;
  IV appears in plasma immediately; SC/IV AUC ratio ≈ F = 0.83 (0.72–0.95 window for
  tail truncation);
- typical patient (75 kg, 36 y, 2400 mg IV loading + 3400 mg SC q2w × 30 cycles):
  finite simulation, repeating steady-state troughs (< 2% drift), trough plausible for
  C5 inhibition, and the post-hoc decline over ~53 days consistent with the reported
  terminal half-life;
- MAP recovery: runFit with age threaded through recovers simulated etas from four SC
  troughs (|Δη| < 0.6); CL posterior in a sensible range; P(target) computed.

Browser verification (v0.6.1, live app): label-like regimen (2400 mg IV + 3400 mg SC
q2w, one measured trough) individualizes (CL 0.10 L/day) with P ≥ 90% at upcoming
troughs; steady-state mode (3400 mg SC q2w, day 0 = latest dose) shows repeating SC
cycles around ~1030 µg/mL [610–1750] with the chart y-axis extended past the old
eculizumab-tuned cap; no console errors.

**Assumptions implemented relative to run05** (surfaced in the app's About dialog):

1. **No ADA effect.** The run05 control stream implements the ADA-negative population
   only — no ADA-on-CL covariate is present or applied. (The ADA-on-CL estimate of
   0.247 in the FDA review belongs to the fuller model-development analysis, not to
   the control stream.) ADA-positive patients are outside the model's scope.
2. **Rich-sampling residual error.** The additive residual term (SD 1.01 mg/L) is the
   rich-sampling estimate; the sparse-sampling additive error (SD 14.4 mg/L, Table 118)
   is not used, so sparse TDM samples are weighted relatively strongly in the MAP fit.
3. **Infusion duration assumption.** The IV loading-dose infusion duration (1 h) is an
   operational assumption — the control stream does not fix D1.
4. **Full multi-eta engine (v0.9.0).** All population PK random effects are
   estimated (crovalimab: all 6 disposition etas). With sparse SC-only sampling,
   absorption (ka, F) and clearance can partly trade off; the estimate stays
   anchored to the population prior — posterior variances shrink toward the
   prior exactly where the data carry no information.

## 5. Steady-state (dose + interval) mode

A patient already at steady state on a fixed regimen is entered with dose, interval
(days) and latest-dose date. Day 0 = latest dose; ~240 days of cycles are synthesized
backwards (pre-roll), and the regimen is continued forward as virtual doses, so chart
and trough table span negative (history) to positive (forecast) days. Verified:

- negative-time observations individualize (MAP finite, troughs on both sides of day 0);
- the pre-roll converges to the repeating cycle (deterministic typical-curve check:
  successive troughs agree < 0.2%; eculizumab accumulates slowly at maintenance troughs,
  terminal half-life ~2–3 weeks, which is why the pre-roll is ~240 days);
- observations older than the synthesized history are excluded with a visible warning;
- aHUS folded-IOV prior keeps bands finite.

## 6. Stress testing & misuse handling

Engine suite: no-dose guard; 4000 mg doses at 35/200 kg; observation exactly at a dose
time equals the pre-dose trough; duplicate observation times; multi-year history with
early + late observations (regression for windowing/horizon); extreme 2000 µg/mL
measurements; censored-only (<LLOQ) data; unreachable/trivial trough targets;
OFV finite over η ∈ [−3, 3]²; full-year weekly regimens. Multi-drug registry suite:
spec conversion, correlated-eta sampling, ravulizumab steady state and MAP recovery
(§1b).

Browser misuse battery (scripted): empty schedule → friendly prompt; measurement before
the first dose → excluded with visible warning; duplicates and extreme values → clean
runs; double-click Run → guarded; remove-all asks for confirmation; narrow viewports →
no horizontal overflow. No console errors in any scenario.

## 7. Audit trail (bug fixes found during verification)

- **DOPRI5 coefficient** missing in the 7th-stage error weight → solver error estimate
  NaN under tight tolerance; fixed and validated against the Python reference.
- **Effective-clearance formula** in the half-life helper divided incorrectly (MM term
  has mg/day, not L/day); corrected to CL_eff = CL + Vmax/(Km + C) and re-verified.
- **Modal-interval tie** on loading schedules distorted the forecast trough placement;
  the interval is now computed on the more recent half of the schedule.
- **Long-history truncation**: the display window covers the last year of history +
  1.5 intervals ahead while the simulation integrates from the true first dose
  (regression-tested with a 4-year q2w schedule, 1442 days).
- **Steady-state pre-roll for slow SC absorption** (v0.6): crovalimab's ka ≈ 0.126/day
  (depot t½ ≈ 5.5 d) needs extra pre-roll cycles beyond the eculizumab-tuned ~240 days
  so early displayed cycles are not still ramping (§5).
- **Silent drop of blank-valued censored samples** (v0.6.1 audit fix A1): a '< LLOQ'
  measurement entered without a numeric concentration was filtered out by
  `isFinite(o.c)` in `runFit`, so the patient silently fell back to the population
  forecast while the UI suggested individualization. The filter now keeps flagged
  censored samples (`isFinite(o.c) || o.lloq`); the M3 likelihood never used the
  value, so a BLQ sample with and without a numeric value yields the identical MAP
  (asserted in `tests/test_audit.js`). The obs form now accepts an empty concentration
  field for censored samples and stores `c: null`.
- **Chart hover xMin offset** (v0.6.1 audit fix A2): the hover→time mapping
  (`(px − m.l)/iw · xMax`) ignored a non-zero `xMin`, so in steady-state mode
  (xMin ≈ −28 d) tooltips and the guide line were offset by |xMin| days. Corrected to
  `xMin + (px − m.l)/iw · (xMax − xMin)` and regression-tested at the plot edges and
  centre.

- **Regimen evaluation at true steady state**: candidate evaluations now pre-roll
  ~240 days instead of 5–9 doses from an empty patient, which understated steady-state
  troughs by ~20–25% (the strategy panel once disagreed with the chart by ~25%). No
  strategies remain in v0.3, but the steady-state forecast itself is built on the same
  converged pre-roll as the engine test above.
- **Chart target-line label double-escaping**: `targetLabel()` pre-escaped `>` so the
  SVG label (set via textContent) rendered `&gt;`. The label now returns raw text and
  only the HTML table header escapes it.
- **runFit side effect**: `runFit(drug)` leaves the module-level drug selection on the
  requested drug; tests restore it explicitly. (In the app the selection is always set
  by the UI before a run, so this is not a user-facing issue.)

## 8. Known limitations

- Fixed-effect uncertainty (RSEs, e.g. Km 37.4%) is not propagated; extrapolation below
  ~20 µg/mL is therefore more confident than the underlying Km precision warrants.
- Crovalimab: all six disposition etas are estimated (v0.9.0). With sparse
  SC-only sampling, ka/F and CL are only weakly separated — the posterior stays
  anchored to the population prior where the data are uninformative (this is
  the statistically correct behaviour; the former 2-eta engine instead absorbed
  absorption variability into the individual clearance estimate). Since v0.9.1
  the app reports per-eta shrinkage so the user can see which parameters the
  samples actually informed, and the end-to-end calibration study
  (`tests/test_e2e_fit.js`) confirms the 90% trough intervals are honest
  (96% coverage over 24 simulated patients).
  **No ADA effect is modelled** — the run05 control stream implements the
  ADA-negative population only, so ADA-positive patients need additional individual
  caution and are outside the model's scope.
- Model estimated in 27 PNH + 48 aHUS patients (Radboudumc cohort); no paediatric,
  pregnancy or dialysis-dependent ESRD coverage; renal function and age were not model
  covariates (eculizumab).
- aHUS single-occasion individualization is intrinsically limited by between-occasion
  variability (reflected in wider posterior bands).
- Research prototype — **not a medical device**; prospective validation is required
  before routine clinical use.

## 8b. Formerly deferred — implemented in v0.9.0

- **#3 — Full multi-eta MAP/Bayes** was implemented in v0.9.0 (see the v0.9.0
  section above): crovalimab now estimates all six disposition etas; the engine
  is dimension-agnostic for future drugs. Re-verified via the control-stream
  cross-check, the seeded MAP-recovery probe and the full test suite.
  The only remaining unestimated variability is the IIV on the additive
  residual error ($OMEGA item 7 — not a PK parameter) and, for eculizumab aHUS,
  the occasion-level IOV (folded into the prior by design).

## 9. Multidisciplinary review checklist

| Role | Scope of review | Status |
|---|---|---|
| Pharmacometrician | Model transcription (both drugs), unit conversions, correlated IIV, ODE tolerance, M3, golden vectors | ☐ |
| Clinical pharmacologist | Error model choice, infusion durations, sampling-time conventions, target setting | ☐ |
| Nephrologist (aHUS) | IOV/uncertainty messaging, ravulizumab aHUS applicability, out-of-scope populations | ☐ |
| Hematologist (PNH) | TDM interpretation conventions | ☐ |
| UI designer | Workflow (incl. drug switching), covariate prompts (disease only for eculizumab), About dialog, layout, print summary, privacy | ☐ |

Sign-off requires confirming the above sections against the source article and the
clinical governance context in which the tool will be used.
