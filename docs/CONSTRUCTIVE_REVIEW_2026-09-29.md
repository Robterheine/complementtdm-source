# Constructive review — mAb TDM v0.41.0

**Rewrite of:** `ADVERSARIAL_REVIEW_2026-09-29.md` (that file is kept unchanged for reference; this one supersedes it for actioning)
**Date:** 2026-09-29 · **Version reviewed:** v0.41.0
**Scope:** statistical correctness, pharmacometric correctness, UI and information design.
**Method:** every claim in the original review was re-checked line by line against the current source, and the headline numbers were re-run headlessly through `tests/util.js`. Findings are marked **verified fresh** (re-run in this audit), **verified by inspection** (read in the source, with references), or **from the original run** (not reproducible today without its exact setup).
**Effect on the app:** none. No source file was changed by either review. For the record, at the time of writing: `npm test` → **1481 passed, 0 failed**; `node tools/verify_control_streams.mjs` → **ALL CROSS-CHECKS PASSED**.

**How to read a finding.** Each item gives a request first, then the evidence, then why it matters, then an acceptance test. Effort: **S** under an hour, **M** about half a day, **L** a day or more. Nothing here asks the app to suggest a dose — every request is about what is computed, shown, or printed.

---

## 0. Audit result

The original review's findings all reproduce in kind. The audit changed five things:

1. **B6 was under-rated and its supporting arithmetic was wrong.** The original said the explorer's steady state was "right by luck (ravulizumab reaches ~0.4% of steady state in 4 cycles)". A fresh simulation shows the 4-cycle trough is **92.1% of the fully-settled value — an ~8% gap**, not 0.4%. The issue is real, so B6 is upgraded from Low to Medium.
2. **C1's "15% of the plot height" does not reproduce.** Fresh measurement: peak p95 435 → axis 514; the next-trough 5–95% band (81–105 µg/mL) is **4.6%** of the axis. The problem is larger than the original stated, not smaller; the number is corrected below.
3. **B3 mislabelled Vmax/Km as "fitted".** They are fixed, allometrically scaled model constants (`model.js:58-59`), not estimated. The request (show them in the individualised view, with a reference concentration) is unchanged.
4. **A1's population-only footnote does not reproduce as stated.** The original said the no-observation band is 95% of the predictive width; fresh runs give **104–130%** (predictive wider). The conclusion still holds in spirit — the omission costs little at high concentrations where IIV dominates — but it is not zero, and the individualised mode is where it matters.
5. **B1's "the model's terminal t½" is over-precise for eculizumab.** With Michaelis–Menten elimination the terminal value depends on which clearance is used (19.7 d vs 10.7 d below). The finding keeps its force from the two linear drugs and from the general point: a one-compartment formula cannot represent a two-compartment model. Wording corrected.

Tone changes: statements imputing carelessness were replaced with user-visible consequences; "unanswerable" (C9) was softened to what actually happens; severity was re-rated in three places (C2 High→Medium, C8 Medium→Low, B6 Low→Medium). Everything else is the original technical content, reorganised so that each item leads with what to change.

---

## 1. Priority table

| Item | Area | Request in one line | Sev | Effort | Audit status |
|---|---|---|---|---|---|
| **A1** | Stats | Decide whether the headline probability is for the *true* trough or the *next reported* trough, and label it | High | M | verified fresh |
| **A2** | Stats | Never print a zero-width Monte-Carlo interval | High | S | verified fresh |
| **A3** | Stats | Print the worst-case ESS (and which eta), not the clearance ESS | High | S | verified fresh |
| **B1** | PM | Stop presenting a one-compartment number as a half-life | High | S–M | verified fresh |
| **C1** | UI | Scale the chart so the trough decision region is readable | High | M | corrected measure |
| **C3** | UI | Keep the phone legend inside the canvas | High | S | verified by inspection |
| **C4** | UI | Make the chart tooltip reachable by touch and keyboard | High | M | verified by inspection |
| **C9** | UI | Give the partial-history gate a safe third answer | High | M | verified by inspection |
| **A4** | Stats | Make the Monte-Carlo interval on P visible on screen | Med | S | verified by inspection |
| **A5** | Stats | Document (or remove) the chain-boundary assumption in `batchMeansCI` | Med | S | verified fresh |
| **B2** | PM | State the concentration a clearance/half-life figure refers to | Med | S | verified by inspection |
| **B3** | PM | Show fixed Vmax/Km and the reference concentration in the individual view | Med | S | corrected wording |
| **B4** | PM | Print residual error as an SD and a CV, with units | Med | S | verified by inspection |
| **B6** | PM | Scale the explorer's settling cycles to the drug, not a fixed horizon | Med | S | corrected evidence |
| **C2** | UI | Give the target label a halo so it does not sit on the data | Med | S | verified by inspection |
| **C5** | UI | Build the chart caption from what the chart actually draws | Med | S | verified by inspection |
| **C6** | UI | Stop printing the trough timestamp one minute before the dose | Med | S | verified by inspection |
| **C7** | UI | Stop uppercasing `µg/mL` into `ΜG/ML` | Med | S | verified by inspection |
| **C10** | UI | Allow cancelling a run; show elapsed time | Med | M | from original run |
| **A6** | Code | Remove or clearly mark the dead `ess()` implementation | Low | S | verified by inspection |
| **A7** | Stats | Disclose kept-phase adaptation in the report | Low | S | verified by inspection |
| **B5** | PM | Guard/flag the y-axis cap (latent, not currently reachable) | Low | S | verified by inspection |
| **C8** | UI | Use `fmtDays` in the Day column | Low | S | verified by inspection |
| **C11** | UI | Offer bulk dose entry | Low | M | verified by inspection |
| **C12** | UI | Make the explorer's candidate set informative for every patient | Low | M | from original run |
| **C13** | UI | Show a date, not just "Day 245", in the chart tooltip | Low | S | verified by inspection |
| **C14** | UI | Include convergence warnings in the printed report | Low | S | verified by inspection |

---

## 2. What is working — protect this in any fix

Worth stating so that refactoring does not trade a good property for a fix:

- **Estimation core.** The Gaussian likelihood includes the η-dependent `log σ²` term; M3 censoring is `−2 log Φ((LLOQ−pred)/σ)`; the variance floor is documented as a MAP guard, not a data term (`bayes.js:203`). Multi-start MAP reports `startGap`; `converged` distinguishes a contracted simplex from an exhausted one; the Laplace fallback is flagged (`covFallback`) and reaches the precision wording. `splitRhat` and `bulkEss` share `splitChainStats`, so both diagnostics describe the same segments.
- **Model transcription.** `node tools/verify_control_streams.mjs` passes with maximum relative deviations **2.7×10⁻⁴ %** (eculizumab $DES), **9.2×10⁻⁶ %** (ravulizumab) and **7.2×10⁻⁷ %** (crovalimab) across the checked time points.
- **Disclosure culture.** The latent-interval caveat appears on screen (`ui.js:1215`) and in the report legend (`ui.js:2742`); the IOV narrowness caveat appears in both; duplicate-dose confirmation, the stale-forecast clearing and the `esc()`-everywhere discipline are all real. Fixes below should extend these habits, not work around them.
- **Testability.** `reportHtml` is a pure function of a snapshot and already has a suite; `chart.render` is cfg-in/SVG-out. Both make the rendering fixes in this review cheap to pin down.
- **Golden rules are load-bearing.** The requests below are written to keep the app dependency-free and offline, keep time in days in the engine, keep the app from suggesting doses, and keep `complementtdm.html` generated.

---

## 3. Statistics and inference

### A1 — Decide what the headline probability is for, then say so *(High, verified fresh)*

**Request.** Add a Σ-inclusive predictive quantity (`P(next reported result > target)`, and optionally its band) and either make it the headline or label the current quantity explicitly everywhere it is read as a prediction of the next lab result. Keep the latent credible interval as the shaded band, clearly labelled.

**Evidence.** `simulateDraws` returns the latent concentration per posterior draw; the residual term `ADD + PROP·pred²` is applied only inside the likelihood (`makeOfv`), never to the draws used for the band or `probAbove`. Re-running the standard case in this audit and adding one assay-error draw per posterior draw (app's own SIGMA: additive 19.1 (µg/mL)², proportional 0.0185) gives:

| Trough | Latent P | Next-result P | Latent band | Next-result band |
|---:|---:|---:|---|---|
| day 42 | 24% | **41%** | 65.5–80.2 | 52.9–91.5 |
| day 56 | 85% | **67%** | 72.6–90.2 | 59.8–102.3 |
| day 70 | 98% | **78%** | 76.7–96.6 | 63.9–108.9 |
| day 84 | 99% | **83%** | 79.0–100.3 | 65.4–112.2 |
| day 98 | 100% | **86%** | 80.4–103.0 | 66.7–115.7 |
| day 112 (assumed next dose) | 100% | **87%** | 81.1–104.8 | 67.6–115.3 |

The next-trough band roughly doubles (23.7 → 47.7 µg/mL). In the no-measurement (population) mode the effect is smaller but not zero: predictive/latent width ratios from 1.04 (late, high concentrations) to 1.30 (early, low concentrations) — IIV dominates at high concentrations, as the original review said, but adding assay error is never free.

**Why it matters.** A TDM question is usually "if I draw a level before the next dose, will it be above target?" The current number answers a different, also-valid question about the patient's true concentration, and it is disclosed as such (`ui.js:1215`, `ui.js:2742`). The residual difficulty is that the badge colour and the printed `P` are easy to read as the first question. The choice is a product decision (§6); the code change is small either way — one Gaussian per draw, seeded so reports stay reproducible.

**Acceptance test.** With the standard case, assert `P(next result)` is within ~1 point of a direct Monte-Carlo computation, and that it is materially lower than the latent P where latent P is near 1. Red-first: temporarily compute it without the Σ term and confirm the assertion fails.

### A2 — Never print a zero-width interval *(High, verified fresh)*

**Request.** When `batchMeansCI` returns a point interval, render `> 99%` or `< 1%` (or an explicit "no failures in n draws" statement) and omit the interval. Apply the same guard in `ptaBadge` and in the report.

**Evidence.** `batchMeansCI` clamps its output to [0,1] (`bayes.js:1625-1648`). A constant input matrix returns `[1,1]` or `[0,0]` exactly. The fresh standard fit printed `0% (0–0%)` at the first two troughs; the original run also produced `100% (100–100%)`. The report prints `' (' + round(ci[0]) + '–' + round(ci[1]) + '%)'`; `ptaBadge` puts "Monte-Carlo 95% interval 100–100%" in a `title`. With 2400 draws and zero failures, the honest one-sided statement is "> 99%" (rule of three: 3/2400 = 0.125%).

**Why it matters.** A printed interval of exactly [100,100] reads as infinite precision in a signed clinical document.

**Acceptance test.** Unit-test `batchMeansCI` on all-above and all-below matrices; add a rendered-output assertion on `reportHtml` for a synthetic fit with `pCI = [1,1]` and `[0,0]` that no `x–x%` interval is emitted.

### A3 — Report the worst-informed ESS, not the clearance ESS *(High, verified fresh)*

**Request.** Print `ESS ≈ min` plus the name of the worst eta (`ESS ≈ 268 (min V1)`), and list `essAll` alongside eta names in the diagnostics. Keep `essCL` as the fallback for legacy fit objects.

**Evidence.** `precisionWord` correctly judges on `essMin` (`ui.js:393-400`), but the on-screen line (`ui.js:1170`) and the report (`ui.js:2677`) print `fit.essCL`. Re-run here, crovalimab with six etas: `essAll = [300, 268, 316, 355, 400, 355]` — printed 300, worst 268. The original run found `CL 263, F 106`. Which eta is worst depends on the sampling design; that is precisely why the report should not print the best case by default.

**Why it matters.** Crovalimab's own assumptions warn that absorption and clearance can trade off under sparse SC sampling. The screen can say "intermediate (ESS ≈ 300)" while the worst parameter — the one the app itself flags as the trade-off risk — is far less informed.

**Acceptance test.** Rendered-output test on `reportHtml` with a synthetic fit whose `essAll` minimum is far below `essCL`, asserting the minimum and its eta name appear.

### A4 — Make the Monte-Carlo interval on P visible on screen *(Medium, verified by inspection)*

**Request.** Render the interval beside the badge (e.g. a small always-visible `±` figure), or a per-row `details`. Keep the badge a pure function.

**Evidence.** `ptaBadge` (`ui.js:174-183`) puts the interval only in `title=`; the report prints it inline. `title` is unreachable by touch and by keyboard, so the two renderings of the same table carry different information.

**Acceptance test.** Assert the badge markup contains the interval outside the title attribute.

### A5 — Record the chain-boundary assumption in `batchMeansCI` *(Medium, verified fresh)*

**Request.** Comment the assumption at the call site, and consider computing batch means per chain and pooling the within-chain variances. Keep the current interval width.

**Evidence.** Kept draws are concatenated across chains (`postMat`, `bayes.js:1257`), and `batchMeansCI` cuts 12 consecutive batches through that concatenation (`bayes.js:1313`). In the fresh standard fit, the day-42 interval `[20.6–27.3]` matches an ESS-based calculation (`±1.96·√(p(1−p)/542) = ±3.6` points, observed half-width 3.35). So the estimator is fine today; the risk is a future change to `keepEvery`/`maxKeep` that misaligns batches and chains. The original review's first hypothesis here (interval too narrow) was already retracted as a false positive.

**Acceptance test.** A property test: shuffle chain lengths, verify the pooled interval stays within a tolerance of a per-chain pooled estimate.

### A6 — Remove or clearly mark the dead `ess()` implementation *(Low, verified by inspection)*

**Request.** Delete `ess()` and its tests, or keep it test-only with an explicit comment and clean arithmetic.

**Evidence.** `ess` (`bayes.js:434`) is not used by `runFit` (which uses `bulkEss` via `splitChainStats`) but is still exported (`bayes.js:1687`) and exercised by tests. It contains a self-correcting `tau` computation with the author's own inline commentary — the least self-evident code in the file and the first thing a reader will try to reconcile with `bulkEss`.

**Acceptance test.** If deleted: `npm test` green after removing its tests; no production reference remains.

### A7 — Disclose kept-phase adaptation in the report *(Low, verified by inspection)*

**Request.** One sentence in "Fit quality", e.g. "the proposal step size continues to adapt with a decaying gain during sampling", or a note that R-hat/ESS assume a time-homogeneous kernel in spirit only.

**Evidence.** `runMCMC` adapts `logS` during the kept phase with a `1/√adaptWin` gain (`bayes.js:583`), which satisfies diminishing adaptation in spirit; the kept draws are then not strictly from a fixed kernel. Normal practice, worth a line in the signed document.

**Acceptance test.** Rendered-output assertion that the sentence appears when a fit was run.

---

## 4. Pharmacometrics

### B1 — Stop presenting a one-compartment number as a half-life *(High, verified fresh)*

**Request.** Either (a) rename the figure to what it is — a local central-compartment elimination time constant at the last trough — in both the screen (`Eff. t½ at trough (approx.)`) and the report, and add one sentence that it is not the terminal half-life; or (b) additionally show the slow-phase t½ computed from the two-compartment parameters. For eculizumab, state that Michaelis–Menten elimination makes a single terminal t½ ill-defined and which approximation is shown.

**Evidence.** `effHalfLife = ln2·V1/(CL + Vmax/(Km+C))` (`model.js:439-442`) ignores the peripheral compartment. Fresh numbers:

| Case | Displayed | Slow eigenvalue, linear CL | Slow eigenvalue, CL_eff at trough |
|---|---:|---:|---:|
| Eculizumab, fitted (ηCL 0.43) | **5.65 d** | 19.7 d | 10.7 d |
| Ravulizumab, typical | **29.0 d** | 45.9 d | — (linear) |
| Crovalimab, typical | **28.3 d** | 53.1 d | — (linear) |

The two linear drugs are unambiguous: the displayed number is 1.6–1.9× shorter than the model's slow-phase value. The eculizumab row shows why "the model's terminal t½" needs care — with MM elimination the answer depends on whether the linear component or the instantaneous effective clearance is used, and both differ from the displayed value by a factor of 1.9–3.5.

The screen label already says "at trough (approx.)" and the report says "Half-life near the trough" (`ui.js:1149`, `ui.js:1166`), so this is not hidden; the risk is that a clinician reads "half-life" as the published terminal value and reasons about interval settling from it — which is the app's stated primary use case.

**Acceptance test.** Unit-test an eigenvalue helper against a known two-compartment case; rendered-output test asserting the report line carries the qualifier and, for ravulizumab/crovalimab, matches the eigenvalue value.

### B2 — State the concentration a clearance (or half-life) figure refers to *(Medium, verified by inspection)*

**Request.** Add the reference concentration to the screen and report line, and optionally the 5–95% range across draws (the draws already exist; `clDraws`/`v1Draws` are computed per draw at `bayes.js:1360`).

**Evidence.** The report's explanation honestly says "It shortens at higher concentrations (saturable clearance)" (`ui.js:1166`), but neither the number nor the report states the concentration at which it was evaluated (the last trough), and there is no interval.

**Acceptance test.** Assert the rendered line contains the concentration at which the value was evaluated.

### B3 — Show fixed Vmax/Km and the reference concentration for eculizumab *(Medium, verified by inspection; wording corrected)*

**Request.** In the individualised view, add one line giving the MM context: fixed `Vmax` (scaled allometrically), `Km`, and the concentration at which the quoted CL applies. (The original review called these "fitted" — they are not; correct the request, keep the intent.)

**Evidence.** For eculizumab, clearance is `CL + Vmax/(Km+C)` with fixed `VMAX 25.64 mg/day`, `KM 13.54 mg/L` at 70 kg, scaled by `EXPO.CLQ` (`model.js:58-63`). The no-observation branch shows both; the individualised branch (`ui.js:1140-1168`) shows only CL and V1.

**Acceptance test.** Rendered-output assertion that the individualised report view mentions Vmax/Km for eculizumab.

### B4 — Print residual error as an SD and a CV, with units *(Medium, verified by inspection)*

**Request.** Render `additive SD 4.4 µg/mL + proportional CV 13.6%` and keep the NONMEM variances in parentheses for control-stream cross-checking.

**Evidence.** The report currently prints `additive 19.1 + proportional 0.0185` (`ui.js:2703-2705`) — two variances with no units. Conversion: √19.1 = 4.37 µg/mL; √0.0185 = 13.6% CV.

**Acceptance test.** Rendered-output assertion on the report's Fit quality table.

### B5 — Guard or flag the chart y-axis cap *(Low, verified by inspection)*

**Request.** Add a small "axis clipped" marker if any series/band exceeds the cap, and a test that the maximum supported dose/weight for each drug stays below it. No user-visible change today.

**Evidence.** `yMax = min(max·1.18, chartYMaxCap)` with cap 2400 for eculizumab (`ui.js:631`) and 12000 for crovalimab; `Y()` clamps silently. The original run could not trigger it (extreme case p95 1557), so this is a latent-defect guard, not a live bug. It becomes live the day a cap is lowered or a drug is added.

**Acceptance test.** For each drug's maximal dose/weight/interval combination, assert max band p95 ≤ cap.

### B6 — Scale the explorer's settling cycles to the drug *(Medium, upgraded and corrected)*

**Request.** Choose the number of forward cycles from accumulation, not a fixed 200-day horizon: `n = ceil(ln(1−q)/ln(1−e^{−λ_z·iv}))` with q = 1e-3 or 1e-4, capped (30 is enough for all three drugs), or else document the fixed horizon and its error.

**Evidence.** `scanOneRegimen` uses `nCycles = max(3, min(30, ceil(horizon/iv)))` with `horizon` defaulting to 200 days (`bayes.js:1480`), so ravulizumab q8w settles with 4 cycles. Fresh simulation of a ravulizumab regimen: trough after 4 cycles = **92.1%** of the 60-cycle value (~8% low); after 11 cycles = 99.98%. For crovalimab q4w the explorer uses 8 cycles, whose gap is similar in kind. The original review's supporting claim ("~0.4% of steady state in 4 cycles") did not reproduce and is withdrawn; the defect it dismissed is real.

**Why it matters.** The explorer's `ss` column is the number that matters for a routine interval change, and it is systematically low for slowly-accumulating regimens — conservative in direction, but not correct. The closed-form count is drug-agnostic: 13 cycles for ravulizumab (0.1%), 6 for crovalimab, 8 for eculizumab.

**Acceptance test.** For each drug and its default interval, compare the explorer's `ss` against a 100-cycle reference and require agreement within 0.1–0.5%.

---

## 5. UI and information design

### C1 — Scale the chart so the trough decision region is readable *(High, corrected measure)*

**Request.** Add a trough-zoom mode (and consider making it the default when the peak dwarfs the trough): zoom the y-axis to roughly `[0, 1.4·max(trough p95, target)]`, let peaks clip with a marker, keep Full and Log options.

**Evidence.** The axis is sized by the peak p95 (`ui.js:999-1008`). Fresh standard case: peak p95 435 → axis 514; the next-trough 5–95% band is 81–105 µg/mL, so the decision region is **4.6% of the plot height** (the original review said ~15% — that figure does not reproduce; the corrected number makes the case stronger). On a phone-sized card that is a strip a few pixels tall.

**Why it matters.** The chart's job is "does the next trough clear target?", and that region currently occupies a sliver at the bottom of an axis driven by the post-dose peak. The trough table carries the numbers, so this is a readability/interaction issue, not a data issue.

**Acceptance test.** A layout test asserting the requested `yMax` for a case with peak ≫ trough; visual check at 390 px.

### C2 — Give the target label a halo *(Medium, verified by inspection; re-rated from High)*

**Request.** Add `paint-order="stroke"` with a white stroke (one attribute) and/or move the label to the axis rather than 5 px above the line.

**Evidence.** `chart.js:228` writes the target label at `x = m.l + iw − 6`, `text-anchor: end`, `y = targetY − 5`, with no background. The target sits at the bottom of the interesting region, where troughs and observations live. This obscures data but the fix is one attribute, hence Medium rather than High.

**Acceptance test.** Snapshot/geometry assertion that the label's bounding box does not intersect the last-trough point markers, or visual review at both widths.

### C3 — Keep the phone legend inside the canvas *(High, verified by inspection)*

**Request.** Shorten the one long label at source (`"Projected dose (not entered)"`, with the assumption moved into a `<title>`), add `<title>` children to legend items, and make `countLegendRows` use the same uncapped width the renderer uses.

**Evidence.** `countLegendRows` caps each item at `Math.min(iw, …)` for row packing (`chart.js:81`), but the renderer writes the full string (`chart.js:284`). The label at `ui.js:1069` is 68 characters; at compact font size 14 the estimate is 68 × 7.84 + 24 ≈ 557 units against a 340-unit viewBox, so most of it renders off-canvas. The row reservation is correct and irrelevant; the item is simply longer than the card.

**Acceptance test.** Render a compact chart with the real legend and assert every text x + estimated width ≤ viewBox width.

### C4 — Make the chart tooltip reachable by touch and keyboard *(High, verified by inspection)*

**Request.** Bind `pointerdown`/`pointermove` (covers mouse, pen, touch), add `tabindex="0"` and arrow-key stepping on the hover rect, and expose the tooltip via `aria-live="polite"`.

**Evidence.** `chart.js` binds only `mousemove` and `mouseleave` (lines 332, 367); the hover rect has no `tabindex`. On the phone layout — which v0.17.0 rebuilt as a first-class target — the tooltip is unreachable by touch; keyboard users cannot reach it either. The trough table is a good fallback, but it does not carry the curve, the peak, or the comparison against an observation.

**Acceptance test.** A headless render test can at least assert the rect has `tabindex` and that pointer handlers are registered; manual check on a touch device.

### C5 — Build the chart caption from what the chart actually draws *(Medium, verified by inspection)*

**Request.** Generate the caption in `ui.js` next to `renderChart` from the same legend array, instead of hard-coding it in `index.html`.

**Evidence.** `index.html:246` always renders "Population = model only, no patient data yet … faint dotted amber = a projected future dose". Since v0.22.0 the population band is deliberately not drawn once an individual fit exists (`ui.js:1001-1046`), and the projected-dose marker only exists when a continuation was computed. Live legend with four measurements: Individual prediction, Observation, Dose, Today, Projected dose — while the caption still explains a population band that is not on screen.

**Acceptance test.** Rendered-caption test for both states (with and without measurements, with and without a projection).

### C6 — Stop printing the trough timestamp one minute before the dose *(Medium, verified by inspection)*

**Request.** Format the trough time from the dose time (the trough is defined as the pre-dose draw), or label the column "pre-dose (≈ dose time)" and round for display. Keep the engine's `−1e-6` day offset.

**Evidence.** `troughTimesOf` returns `doses[i].t − 1e-6` days (`bayes.js:947-952`); `fmtDate` resolves to the minute (`ui.js:108`). A 09:00 dose therefore renders `08:59` in the on-screen table, the printed report and the findings line. In a signed record, a timestamp that disagrees with the dosing record by a minute is a needless query.

**Acceptance test.** Rendered-output test: for a 09:00 dose, the printed trough row reads 09:00 (or carries the pre-dose label).

### C7 — Stop uppercasing `µg/mL` into `ΜG/ML` *(Medium, verified by inspection)*

**Request.** `text-transform: none` for unit headers, or wrap the unit in a span with `text-transform: none`.

**Evidence.** `table.data th { text-transform: uppercase }` (`app.css:137-139`); U+00B5 MICRO SIGN uppercases (via CSS) to U+039C GREEK CAPITAL MU, so `P(> 75 µg/mL)` renders as `P(> 75 ΜG/ML)` — a different character in the app's most important column header.

**Acceptance test.** Assert the computed style or the literal header string; a rendered-output report test covers the same string family.

### C8 — Use `fmtDays` in the Day column *(Low, verified by inspection; re-rated from Medium)*

**Request.** `fmtDays(tr.t)` in the trough table and the report.

**Evidence.** The Day column uses `fmtC(tr.t)` (`ui.js:1204`; report table likewise), so whole-number schedule days render `14.0 … 98.0 … 112`. `fmtDays` exists for exactly this (`ui.js:187`). Cosmetic, but it is one call.

**Acceptance test.** Rendered-output assertion that day 14 prints as `14`, not `14.0`.

### C9 — Give the partial-history gate a safe third answer *(High, verified by inspection)*

**Request.** Add a third option to the v0.41.0 prior-treatment gate: "Yes — treat the first entered dose as already at steady state", implemented by extending `windowStart` backwards by a stated number of half-lives of the historical regimen (the same machinery steady-state mode already uses), with the assumption printed in the report. This needs the author's clinical sign-off.

**Evidence.** The gate (`index.html:160-164`) offers only "No" and "Yes, earlier doses are missing"; answering "Yes" disables Run (`ui.js:316-321`) with the hint "Enter the earlier doses (then answer No), or use Steady state mode". For the common consultation — a patient on a stable q14d regimen with the last 8 doses and 4 troughs available — entering the missing history means up to 26 individual form submissions (no bulk entry, C11), and Steady state mode is not equivalent if the regimen changed recently. Note also that the gate can currently be bypassed by answering "No" when it is not true, so the third option would protect data integrity as well as workflow.

**Why it matters.** The v0.41.0 gate fixed a real failure mode (missing history biasing clearance low, P falsely ~100%). A safe third answer keeps that protection while making the honest answer productive.

**Acceptance test.** With a full simulated history and only a suffix entered, the third option reproduces the full-history trough within a stated tolerance; the report prints the back-extension assumption.

### C10 — Allow cancelling a run; show elapsed time *(Medium, from the original run)*

**Request.** Check a cancel flag in the MCMC chunk loop (it already yields every 200 iterations via `tick()`), and show a live elapsed-time readout. A worker is the larger option; the flag is the small one.

**Evidence.** Measured on this machine (node, so a real device is slower): eculizumab 4.9 s, crovalimab 9.0 s, ravulizumab q8w with a year of history 13.6 s; fresh eculizumab run 5.3 s. The README says ≈2–3 s. Run disables the button and blocks in chunks with no abort control; the only `cancel` element is the report dialog's.

**Acceptance test.** With a simulated long run, cancel returns the UI to the idle state within one chunk.

### C11 — Offer bulk dose entry *(Low, verified by inspection)*

**Request.** A paste-lines or CSV-style dose input (date, amount, optional duration/route) that validates and de-duplicates like the single form. Pairs directly with C9.

**Evidence.** Historical doses are added one at a time; the gate can require dozens of them.

**Acceptance test.** Paste 26 doses: one confirmation, one table update, same fit as manual entry of the same doses.

### C12 — Make the explorer's candidate set informative for every patient *(Low, verified fresh)*

**Request.** Report the consequence of the candidate set rather than eight near-duplicates: for example, mark the candidates that are trivially below target and offer a dose scan when no interval in the current range attains the target. Keep within the "no dose suggestions" rule — report consequences of candidates the clinician asks about.

**Evidence.** For the standard case the explorer's intervals give q7d 339, q14d 94.6 (P 100%), q21d 26.0, q28d 5.56, q35d 1.34, q42d 0.38, q56d 0.04, q70d 0.00 — six of eight are `P 0%` and below 10 µg/mL, i.e. the interval question has a binary answer and the table spends most of its space on the impossible half.

**Acceptance test.** A rendered-table test that infeasible candidates are collapsed or annotated.

### C13 — Show a date in the chart tooltip *(Low, verified by inspection)*

**Request.** Pass the date through `cfg` and show "Day 245 · 12 Mar 2027".

**Evidence.** The tooltip says `Day 245` (`chart.js:349`); the table below gives a date. Small consistency fix.

**Acceptance test.** Tooltip string contains both.

### C14 — Include convergence warnings in the printed report *(Low, verified by inspection)*

**Request.** Add the R-hat > 1.05 warning (and `startGap`, and `covFallback`) to the report's Fit quality or findings section, as on screen.

**Evidence.** The on-screen advisory lists the affected etas (`ui.js:1301-1306`); the printed report has no R-hat row. The report is the artefact that leaves the building. Latent in the fresh runs (R-hat 1.006–1.008), structural nonetheless.

**Acceptance test.** Rendered-output assertion with a synthetic fit whose R-hat exceeds 1.05.

---

## 6. Product decisions to make (not defects)

1. **A1 — which probability is the headline?** P(true trough > target) and P(next reported result > target) answer different questions and both are defensible. Recommendation: show both, headline the one the consult asks about ("will the next lab result be above target?"), and keep the latent band labelled as the true-concentration interval. Requires a stated preference before implementation.
2. **B1 — what half-life should be displayed at all?** Off/relabel/eigenvalue variants are in the finding; the decision is whether a nonlinear model should ever show a single terminal number.
3. **C9 — the third gate answer.** Back-extension length, and exactly how the assumption is worded in the report, need the author's clinical judgement.
4. **C1 — the default chart scale.** Trough-zoom by default vs Full by default is a presentation preference; the trough table insures either choice.
5. **C11 — input scope.** Bulk entry could be paste-only or file import; scope accordingly.

---

## 7. Suggested order of work

0. **Harness first (S).** Add rendered-output assertions to the existing `reportHtml` suite and a compact-legend geometry test. The A2/A3/B4/C6/C7/C8/C13/C14 class is text the app prints; only rendered output can catch it.
1. **One-sitting text fixes (S each):** C6, C7, C8, C2, C13, C14. All display-only, all currently put wrong-looking text into the record.
2. **Printed-report correctness:** A2, A3, B4. Small edits + the new assertions.
3. **Report context:** B1, B2, B3. Naming and two added lines.
4. **A1** (needs decision 1). The highest clinical-value change; self-contained; keep the latent band.
5. **Phone usability:** C3, C4, C5.
6. **Workflow:** C9 (needs decision 3), then C11.
7. **Remaining:** C1, C10, B6, A4, A5, A6, A7, B5, C12.

Per this repo's rule: each item is pinned by a test that is **shown red against the current code first**, then green (rule 7b). Version bumps go through `src/version.js` + `package.json`; `complementtdm.html` is regenerated by `node build.mjs`, never hand-edited; `npm test` and `node tools/verify_control_streams.mjs` must both pass before completion.

---

## Appendix A — audit log (disposition of the original findings)

| Original item | Disposition |
|---|---|
| A1 | Kept. Population-only aside corrected (ratios 1.04–1.30; original 0.95 not reproduced). |
| A2 | Kept, verified fresh in both directions. |
| A3 | Kept; note that which eta is worst is sampling-dependent (fresh: V1 268 vs CL 300; original: F 106 vs CL 263). |
| A4, A5, A6, A7 | Kept; A5 re-confirmed benign with a fresh ESS comparison. |
| B1 | Kept with corrected framing: "terminal t½" is not uniquely defined for the MM model; "printed as a headline" softened to "line under How this was calculated", where it is already qualified. |
| B2 | Kept. |
| B3 | Kept with wording corrected: Vmax/Km are fixed, not fitted. |
| B4 | Kept. |
| B5 | Kept as latent guard. |
| B6 | Kept, **upgraded Low→Medium**, original supporting arithmetic withdrawn (fresh: ~8% shortfall at 4 cycles). |
| C1 | Kept, **measure corrected** (4.6%, not ~15%). |
| C2 | Kept, **re-rated High→Medium** (one-attribute fix, obscures rather than misreports). |
| C3–C7, C9–C14 | Kept; C9 "unanswerable" softened to the actual paths (manual entry, SS mode, or an untrue "No"). |
| C8 | Kept, **re-rated Medium→Low** (cosmetic). |
| §5 non-findings | Retained and extended; the duplicate-entry false positive remains documented so it is not re-investigated. |

## Appendix B — reproduction recipe used in this audit

Standard case (all runs headless via `tests/util.js`; eculizumab fit ≈5.3 s):

- doses: `t = 0, 14, …, 98` days, `amt = 900`, route `iv`
- measurements: `t = 56, 70, 84, 98` days minus 1e-6, `c = 78, 95, 82, 88`
- `runFit({ wt: 70, disease: 'PNH', drug: 'eculizumab', lloq: 0, target: 75, seed: 20250907 })`
- result: CL 0.251 [0.220–0.288] L/day; V1 4.09 [2.62–6.83] L; ESS CL 701 / V1 542; R-hat 1.006 / 1.008; acceptance 0.297; nDraws 2400; covFallback false; runtime 5.3 s

Supporting checks: A1 adds one Gaussian assay-error draw per posterior draw using SIGMA (ADD 19.1, PROP 0.0185) at each trough time (seed 99991); A2 calls `batchMeansCI` on constant matrices and reads the printed strings; B1 computes the slow eigenvalue of the linear disposition; B6 simulates ravulizumab 1200 mg q8w IV for n cycles and reads the trough before dose n at `(n−1)·56 − 1e-6`; C1 reads `chartBand.p95` max and the next-trough band; A5 compares the app interval with `1.96·√(p(1−p)/ESS)`.

No application code was modified in producing either this review or the original.
