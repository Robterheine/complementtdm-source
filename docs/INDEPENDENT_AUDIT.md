# Independent audit handover — mAb TDM v0.22.0

> **Handover for another agent.** This is not a changelog and not a request to
> start coding. It is the independent statistical / clinical-pharmacological /
> UI-design review of v0.22.0, rewritten so a later LLM or developer can pick
> the work up cold, triage it, and implement without re-deriving the findings.
>
> **App reviewed:** v0.22.0 (`src/version.js`, `package.json`).
> **Date of review:** 2026-09-13.
> **Stance:** independent of the v0.13.0 six-specialist audit and of the
> author’s subsequent self-reviews (v0.15–v0.22). Prior *rejected* items are
> listed in §0 and must not be re-raised without new evidence.
> **No code was changed for this review.**
>
> **Second-pass review (2026-09-13, same day, different session).** Every
> concrete code claim under P0/P1 and most of P2 (F2, F3, F5–F14, F17,
> F19–F23) was independently re-derived against the v0.22.0 source — not
> read as prose and trusted — and all of them checked out exactly, including
> line-level details (e.g. F2's `worst`-vs-`next` mix-up, F6's pooled-vs-split
> ESS, F10's SS-mode route forcing). Four amendments below (marked
> **[Amendment]**) tighten severity or add a nuance this pass turned up; one
> new finding (**F24**) was found and added — a fourth stale-string bug, same
> family as F20, that this review missed. Nothing else here needed a
> correction.

Read first, in this order:

1. `README.md` §§1–4, 9, 12, 14, 17.6 (scope, models, engine, conventions,
   known limitations, settled rejections).
2. This file.
3. Then only the source files named under the finding you are implementing.

Golden rules that still apply (README §2): never edit `complementtdm.html` by
hand; time is in **days**; bump `src/version.js` + `package.json` together;
`npm test` 100% green; `node tools/verify_control_streams.mjs` must pass;
**no dose suggestion**; every new check must be shown to go red; `step="any"`
+ JS validation, never a native step grid on a clinical number; `esc()` user
text; research-use disclaimer stays.

---

## 0. Do not re-litigate (README §17.6)

The author reviewed and rejected these. Do not implement them unless new
evidence is attached to the finding:

| Rejected item | Why it stays rejected |
|---|---|
| Raise ravulizumab target 100 → 175 µg/mL | 100 is the TDM-for-interval-prolongation threshold (PMID 33512711) |
| Add PD caveats (LDH, free C5/CH50, breakthrough) | Exposure–response treated as solid |
| Propagate THETA/SIGMA uncertainty into bands | Covariance not available (crovalimab Table 118 RSE% is the only exception, still not requested) |
| Switch crovalimab residual to sparse-sampling SD 14.4, **or** add an on-screen caveat about it (F4) | Re-confirmed 2026-09-13 with the run05-vs-Run-59 gap explained in full (residual variance ~203×, missing ADA-on-CL covariate): **keep run05, no caveat.** No longer an open tension — see F4's own resolution note |
| Model or warn about ADA | ADA assumed absent on every occasion |
| Warn about switching C5 inhibitors | One drug per session |
| Re-add aHUS IOV as a separate future-occasion eta | Folding is the correct marginal prior (doi:10.1111/bcp.13901). **Do** still surface the “interval is somewhat narrower” caveat more visibly (F9) — that was accepted as documentation, not as a model change |

---

## 1. What is already sound — do not “fix”

Treat these as load-bearing. A change here needs a new finding, not taste.

- Control-stream transcription, after the v0.13 NaN-gate repair.
  `tools/verify_control_streams.mjs` + `tests/test_model_verify.js`.
- Exact Gaussian likelihood with log-variance term + M3; `errMult`; recency as
  an SD multiplier with `m(0) = 1` (`src/bayes.js` `makeOfv`, `recencyMult`).
- Multi-chain RW-Metropolis, split-R̂, decaying adaptation, Student-t
  batch-means CI, `covFallback` surfaced.
- Identifiability shown as **information** (`etaInformation` = 1 − var_post/var_prior),
  not classical η-shrinkage. Do not rename it back.
- Regimen explorer architecture: consequences for named regimens, no preferred
  row, next vs steady-state not collapsed. **Copy on the forecast card** is
  what breaks the no-suggestion rule (F3), not the explorer itself.
- Offline, no CDN, `esc()`, restore-bar offered not silent, compact charts,
  print chart rendered off-screen (never clone the live SVG).
- `applySession` / `importJson` ordering: `applyDrugUI()` first, then session
  target. Do not invert. Pinned by `tests/test_session_restore.js`.

---

## 2. Suggested order of work

Do not start with a drive-by refactor. The calibration result (F1) can change
the priority of everything statistical.

1. **F1** — run and file the N≥300 calibration. If a scenario fails, stop and
   report; do not paper over it with UI copy.
2. **F2** — printed-report “next dose” vs worst trough (record-grade error).
3. **F3** — strip recommendation language from badges / howto / advisories.
4. **F4** — crovalimab run05 vs Run 59 decision (needs the author; do not
   silently transcribe Run 59). Now filed as P1 (§3), not P0 — see that
   section's reviewer note — but kept early here because F7 (next) also
   touches the crovalimab dosing model and the two are easiest to reason
   about together.
5. **F7** then **F5** — loading-interval continuation; chart/explorer draw count.
6. Remaining P1, then P2. P3 only if asked.

Each code change: bump `src/version.js` + `package.json`, add a suite (or
extend the relevant `test_v0xx.js`), confirm the new assertion goes **red**
on sabotaged code (golden rule 7b), `npm test`, `npm run build`, dated
section in `VALIDATION.md`.

---

## 3. Findings

Severity: **P0** ship-blocker / record error / missing evidence.
**P1** major clinical or statistical misread.
**P2** important, not immediately dangerous.
**P3** polish.

---

### P0

#### F1 — The N≥300 calibration was designed and never filed
- **Domain:** statistics / governance
- **Where:** `tools/calibration_study.mjs` (the instrument);
  `tests/test_e2e_fit.js` (smoke test, N=24, correctly labelled);
  `VALIDATION.md` V2 (describes the tool, quotes no numbers);
  `MODEL_VALIDATION.md` §5 still cites “96% coverage over 24 seeded patients”;
  `README.md` §9 still leans on the smoke test as “calibration evidence” in
  one leftover sentence.
- **What is wrong:** The real study (5 scenarios, N≥300, Wilson CI must
  contain 90%, over-coverage = fail, PIT uniformity) has no recorded result
  in the repo. The number that *is* on file (96% of a 90% interval) is
  exactly the failure mode the study treats as “too wide.”
- **Do this:**
  1. `npm run calibration` (slow; production MCMC; expect tens of minutes).
  2. Paste the five `== <name> ==` blocks verbatim into a new
     `VALIDATION.md` section, including PIT histograms.
  3. Stop citing N=24 as calibration. Point `MODEL_VALIDATION.md` §5 and
     `README.md` §9 at the new section.
  4. If any scenario’s CI excludes 0.90, that is an **engine finding**, not a
     docs finding — come back before touching UI.
- **Do not:** lower N, skip PIT, or treat over-coverage as a pass.
- **Verify:** the pasted numbers match a re-run with the same seeds
  (`mulberry32(20260912)` inside the tool, per-patient `seed: 4242 + i`).

#### F2 — Printed report labels the worst trough as “the next dose”
- **Domain:** clinical + UI (record-grade)
- **Where:** `src/ui.js` `findingsLines()`, currently:

```js
var upcoming = fit.troughs.filter(function (tr) { return tr.t > rel.nowRel - 0.02; });
var worst = upcoming.reduce(function (a, b) { return b.pTarget < a.pTarget ? b : a; });
out.push('Predicted trough before the next dose (' + fmtDate(rel.t0ms + worst.t * DAY) + ')…');
```

- **What is wrong:** `worst` is the upcoming trough with the **lowest**
  `pTarget`. The sentence says it is the trough before the **next** dose. A
  later, worse trough is written into the clinical record as the imminent
  one. Screen table is fine (one row per dose); only the findings paragraph
  and therefore the printed report lie.
- **Do this:**
  - `next` = upcoming trough with the smallest `t` (the next administration).
  - `worst` = min `pTarget` among upcoming, reported separately **if it is
    not the same row**.
  - Keep dates on both.
  - The “≥ 90% at one or more upcoming doses” bullet can stay, as a third
    sentence, because it does not name a date.
- **Pin:** a unit test over `findingsLines` with two upcoming troughs
  (e.g. t=14 P=0.99, t=28 P=0.40) must contain the date of t=14 in the
  “next dose” sentence and must not call t=28 the next dose. Write the test
  first; confirm it fails on current code (rule 7b).
- **Do not:** drop the worst-trough sentence. Clinicians need both.

#### F3 — Forecast-card copy already recommends a dose change
- **Domain:** clinical + UI. Violates product rule README §2.6 / §3
  (“No dosing strategies… The user enters the regimen; the app never
  suggests a dose”).
- **Where:**
  - `src/ui.js` `ptaBadge()` — warn title: *“a dose or interval change may
    be needed”*; bad title: *“consider adjusting the dose or interval”*.
  - `src/ui.js` advisory block: *“Target unlikely to be reached at one or
    more upcoming doses — consider a dose or interval change.”*
  - `index.html` `#howto`: *“below 90% on upcoming doses suggests
    considering a change.”*
- **What is wrong:** The explorer (card 4) correctly refuses to mark a
  winner. The forecast card (card 3) and the printed findings tell the
  reader to change the regimen. Colour + 90% is being used as a decision
  rule, not as an attainment report.
- **Do this:**
  - Badges report the probability (and the MC CI). Colour = attainment vs
    the user-chosen target, not an instruction.
  - How-to and advisory: state that P is below 90% at named dates. Do not
    say “consider changing.”
  - Advice belongs in the user’s free-text Advice field on the report.
- **Related, do in the same pass if cheap:** F11 (always print the percent;
  “P ≥ 90%” hides 91 vs 99).
- **Pin:** `test_usability.js` / a new `test_v023.js` grepping `src/ui.js`
  and `index.html` for `consider adjusting`, `consider a dose`, `suggests
  considering`. Must be zero hits in user-visible strings.
- **Do not:** remove colour, the 90% threshold as a *display* cut, or the
  explorer. Do not add a “recommended interval” column.

---

### P1

#### F4 — Crovalimab transcribes run05, not FDA-final Run 59 **[Amendment: moved here from P0]** — **CLOSED, no action (author decision, 2026-09-13)**

> **Author decision.** Presented both options (transcribe Run 59's
> sparse-sampling residual, or add a persistent on-screen caveat while
> keeping run05). Author chose: **keep run05 exactly as it is, with no new
> caveat of any kind** — not Option A, and explicitly not Option B's own
> caveat either. This is a deliberate, informed rejection, made after the
> run05-vs-Run59 discrepancy was explained in full (the ~203× residual-
> variance gap, the missing ADA-on-CL covariate) — not an oversight. Do not
> re-raise without new evidence, per this file's own §0 convention for
> settled rejections. The existing disclosure already in `assumptions`
> (`src/model.js`) and the report (README §17.6) is unchanged and stays as
> the only disclosure — no on-screen caveat was added on top of it.

> **Reviewer note (retained for context).** F1–F3 are either a false claim
> currently on file (F1) or a live rule violation on the shipped page right
> now (F2, F3) — nothing stands between the reader and the defect. F4 is a
> **disclosed** limitation: the run05-vs-Table-118 gap is named in
> `README.md` §17.6, and per that same section the disclosure "now also
> prints in the report." That is a materially different risk profile from
> F1–F3 and does not meet the same ship-blocker bar. The severity tag was
> overstated relative to F1–F3 — which turned out to matter, since the
> author's own resolution was "no action," a call that would have read as
> far more surprising under a P0 label than it does under P1.

- **Domain:** clinical pharmacology (largest PK-fidelity gap)
- **Where:** `src/model.js` crovalimab spec; `crovalimab.txt` (run05);
  `VALIDATION.md` V3; README §17.6 verification note.
- **What is missing vs Table 118 (Run 59), already enumerated:**
  - `CLs` 0.0341 L/day
  - `Kd` 0.0144 /day
  - ADA-on-CL 0.247
  - sparse additive RUV SD 14.4 (variance 207.36) vs rich-sampling 1.02 in
    use — factor ~203
  - IIV on additive RUV (CV 0.787 / ω² 0.619, currently dropped)
- **What is wrong:** Sparse TDM troughs are weighted as if they were
  rich-sampling concentrations. ADA-positive patients are silently treated
  as ADA-negative. README §17.6 rejected “switch to sparse SD 14.4” *by
  instruction* (“use the published model as-is”) while also noting that
  Table 118 is Run 59 and the app is run05. Those two statements conflict.
- **Do this (needs the author, do not guess):**
  - **Option A (preferred if the author agrees):** transcribe Run 59 for the
    residual-error model used at TDM sampling density (sparse additive),
    keep ADA off (still rejected as a modelled effect) but keep the
    ADA-negative scope banner.
  - **Option B (if the model must stay run05):** a **persistent on-screen**
    caveat on crovalimab, not only About/report: *“rich-sampling residual;
    sparse troughs are weighted too strongly.”* Same sentence in the
    printed report header for that drug.
- **Do not:** silently swap SIGMA.ADD to 207.36 without updating
  `tools/verify_control_streams.mjs` and without the author’s call.
  Verification against `crovalimab.txt` (run05) would then *fail*, which is
  correct — the expectation table would have to track Run 59 instead, and
  the control-stream file would have to be replaced.
- **Pin:** whichever option is chosen, a test that the chosen disclosure or
  the new SIGMA is actually what `runFit` uses.

#### F5 — Chart and explorer bands use 250 draws; the table uses the full chain
- **Where:** `src/bayes.js` `runFit` chart-continuation block
  (`subsample(..., 250)`); `regimenScanSetup` `maxDraws || 250`;
  trough table uses full `postMat`.
- **Risk:** The picture (and explorer P) can disagree with the number the
  clinician quotes. Explorer P has **no** batch-means CI.
- **Do:** same kept draws as the trough table, *or* a legend note “display
  subsample, n=250”. Add `pCI` on explorer `next`/`ss` via `batchMeansCI`
  if you keep a subsample — then the CI will honestly widen.
- **Pin:** `tests/test_v015.js` already asserts continuation does not
  change troughs. Add: explorer `ss.pTarget` at the current interval
  agrees with the matching trough-table P within the MC CI.

#### F6 — ESS is Geyer IPS on concatenated chains, not split-chain bulk ESS
- **Where:** `src/bayes.js` `ess()`; `runFit` computes `essAll` by mapping
  `ess` over `draws` (the pooled array). `splitRhat` is computed on
  `chains`; ESS is not.
- **Risk:** R̂ can warn while ESS still looks large, or the reverse. UI
  `precisionWord()` uses only `essCL`. **[Amendment]** Pooling non-mixed
  chains does not bias ESS in one guaranteed direction — concatenating
  chains stuck in different regions raises the series' apparent
  autocorrelation too, which can pull pooled ESS down as well as up. The
  failure mode is real (pooled ESS is not the diagnostic the R̂ literature
  pairs it with) but "ESS still looks large" is the illustrative case, not
  the only one; state it as "disagrees with R̂ in either direction," not
  as a one-way failure.
- **Do:** split-chain bulk ESS (Vehtari / Stan). Warn on min ESS across
  etas, not only CL. Thresholds in `precisionWord` may need a re-tune;
  do not copy 100/300 blindly onto 6-eta crovalimab.
- **Pin:** a two-chain synthetic example where chain 2 never moved: R̂
  high **and** bulk ESS low.

#### F7 — Chart continuation / assumed trough inherit `modalInterval`
- **Where:** `src/bayes.js` `modalInterval()` (mode of the later half of
  spacings; fallback `ssIntervalDefault`); chart continuation
  `lastDose + pc * interval`; assumed-dose trough `virtualTroughTime`.
- **Risk:** Crovalimab weekly loading (q7d ×4) then q28d maintenance — if
  the later half of *entered* doses is still weekly, the app projects q7d
  forever and reports an assumed trough a week later at a high
  concentration with P≈100%. Same class as the v0.13 hardcoded-q14d bug,
  different trigger.
- **Do:** if the derived interval is not a whole-week multiple of the
  drug’s `ssIntervalDefault` (or the last ≥2 spacings disagree), **do not
  auto-project**. Banner: enter the next planned dose, or switch to
  Steady state. Optionally prefer `ssIntervalDefault` with an explicit
  “assumed q4w maintenance, not the loading interval” tag.
- **Pin:** crovalimab doses at t=0 (IV 1000), t=1,8,15,22 (SC 340) must
  **not** produce an assumed q7d continuation without a warning. Write
  this test first.

#### F8 — Age 1–100 and weight 35–200 are the wrong walls
- **Where:** `src/ui.js` `runFit` / `updateRunReady` (age 1–100 when
  `covariateAge`); `src/bayes.js` `runFit` throws if `wt` not in 35–200;
  crovalimab `ka = 0.126 · (age/36)^-0.459` (`src/model.js` `indivParamsVec`).
- **Risk:** A 12-year-old is accepted; paediatrics are declared out of
  scope. A 210 kg PNH patient cannot run at all. A 32 kg adult cannot
  either. Allometry outside the estimation range is silent.
- **Do:**
  - Age <18 (crovalimab): block, or warn-and-acknowledge. README §3 says
    no paediatrics.
  - Weight: warning + “extrapolated allometry” flag outside the model’s
    observed range, rather than a hard 35–200 fail. If a hard cap stays,
    raise the top end (obese PNH/aHUS is real) and document it.
- **Do not:** add a paediatric model. There isn’t one in this repo.

#### F9 — aHUS next-occasion intervals are too narrow, and that sentence is buried
- **Where:** folding is correct (`priorOmega` adds `IOV_CL` into Ω_CL for
  aHUS). Caveat lives in `spec.assumptions` and About, not on the trough
  table the consultant reads.
- **Do:** one line on every aHUS trough table and in `findingsLines` /
  the printed report: *“Between-occasion variability is in the prior, not
  as a separate future-occasion effect — the interval for the next dose
  is somewhat narrower than full occasion-to-occasion uncertainty.”*
- **Do not:** unfold IOV into a future eta (rejected, §0).

#### F10 — Crovalimab route defaults
- **Where:** full-schedule dose form shows a route `<select>` but does not
  auto-set first=IV, subsequent=SC (`adminRoutes` is used as a visibility
  flag). SS mode (`relContextSS`) forces `adminRoutes.subsequent` (SC) on
  **every** synthesised dose, including the pre-roll — wrong if “latest
  dose” is still the IV load.
- **[Amendment]** The full-schedule handler (`src/ui.js`, the `doseForm`
  submit) already contains an auto-route-by-position branch —
  `state.doses.length === 0 ? ar.first : ar.subsequent` — but it is dead
  code as shipped: `index.html`'s `#dose-route` select offers only the two
  literal options `iv`/`sc` (no third "auto" value), so `rv` is always one
  of those and the ternary's first branch always fires. The select simply
  defaults to its first `<option>`, IV, and stays there across additions
  (only `dose-amt` is cleared after submit) — so every dose is silently IV
  until the clinician manually flips it, for every dose, every time. Either
  wire the existing auto branch up (add a real "Auto" option and default to
  it) or delete the dead branch — leaving it in place invites a future
  reader to believe auto-routing already works.
- **Do:** auto-route from `adminRoutes` with manual override; refuse SS
  mode (or warn) until the patient is actually on maintenance. Document
  that SS crovalimab = maintenance SC, not the loading sequence.
- **Pin:** first added crovalimab dose defaults to IV; the second to SC;
  SS-mode doses are all SC and the UI says so.

#### F11 — “P ≥ 90%” hides the number
- **Where:** `ptaBadge` when `p >= 0.9`. Print uses the same helper.
- **Do:** always print the percent (`P 94%`, still green). Keep the MC CI
  in the tooltip **and** consider showing it on-badge when the CI crosses
  90% (ties to F16).
- **Pin:** a badge for p=0.91 contains `91`, not only `≥ 90`.

#### F12 — localStorage can hold a named patient’s concentrations on a shared PC
- **Where:** `src/ui.js` `LS_KEY = 'complementtdm.session.v1'`;
  `saveSession()` writes `patient` (incl. `code`), doses, obs.
  Restore is offered, not silent — good — but one slot, no PIN, ward PC.
- **Do:** do not persist `patient.code` (or persist it only behind an
  explicit “remember name on this device”). Offer “this device is shared
  → discard now.” Keep JSON export as the portable path.
- **Do not:** add a server. That violates the product.

---

### P2

#### F13 — How-to omits “bands exclude assay error”
- **Where:** `index.html` `#howto` (“90% plausible range for the true
  concentration”). The exclusion sentence is only under the trough table
  (`src/ui.js` around the `credible interval for the true concentration`
  legend). Chart `<desc>` in `src/chart.js` is closer to correct.
- **Do:** repeat the exclusion in How-to, chart `<desc>`, and the first
  results line. Users overlay points on a noise-free band and will see
  ~10%+ of future labs outside it.
- **Pin:** `test_usability.js` already greps help keys; add a grep that
  `#howto` mentions assay error / residual.

#### F14 — P(trough > target) is not P(next lab > target)
- **Where:** `probAbove` on noise-free simulations; documented as a
  credible interval for the true concentration.
- **Do:** rename the column to make the latent-true meaning obvious, **or**
  add a second posterior-*predictive* P (draw residual error). Do not
  silently swap the definition — it would move every badge.
- **Needs the author** if you add a second number (two P columns is a UI
  decision).

#### F15 — Recency weighting is unpublished clinical judgement
- **Where:** `src/bayes.js` `RECENCY_TAU_DAYS = 365`,
  `RECENCY_MAX = {off:1, low:1.5, medium:2, high:3}`; control in
  `index.html` `#pt-recency`; About text is good, the `<select>` labels
  are not (“Low — residual error up to ×1.5”).
- **Do:** keep off by default. Change the visible label to say it **makes
  the forecast less certain**. Do not estimate τ from the patient.
- **Do not:** re-tie it to `IOV_CL` (that was v0.20, reversed in v0.21).

#### F16 — MCMC seed is fixed, so seed-to-seed error is invisible
- **Where:** `src/ui.js` `var SEED = 20250907`; passed into every `runFit`.
- **Do:** keep the default seed (reports must reproduce). Surface the
  already-computed `pCI` on the badge, especially when it straddles 90%.
- **Do not:** randomise the seed in production. That makes the printed
  report non-reproducible from the JSON.

#### F17 — Eculizumab residual is the Radboudumc assay
- **Where:** `src/model.js` eculizumab `SIGMA` / `assumptions`; errMult
  default 1 in a collapsed fold (`#assayOptions`).
- **Do:** if the user sets an LLOQ (i.e. they are thinking about *their*
  assay) and `errMult` is still 1, one-line “this residual error is the
  Radboudumc assay; change the multiplier if your lab differs.”
- **Do not:** guess a centre-specific multiplier.

#### F18 — Ravulizumab looks as authoritative as eculizumab in the selector
- **Where:** `index.html` `#pt-drug`; ravulizumab `assumptions[0]` already
  says “simplified research re-implementation.”
- **Do:** a short provenance chip next to the selector when ravulizumab
  (or crovalimab run05) is selected. Main screen stays low-text — one
  line, not a paragraph (`#drugHint` is the existing slot).

#### F19 — `pt-target` still has `step="5"`
- **Where:** `index.html` `<input … id="pt-target" … step="5">`.
- **Risk:** same *family* as the v0.13 concentration landmine (golden rule
  7c), but **[Amendment]** not the same severity: `#pt-target` sits inside
  `#targetFold`/`#patientCard`, outside any `<form>` — unlike the v0.13
  dose/concentration fields, nothing ever calls `reportValidity()`/
  `checkValidity()` on it and there is no submit to silently block. Typing
  72 or 77.5 directly is read correctly by `readPatient()`'s `parseFloat`.
  The real, still-worth-fixing effects are narrower: the ↑/↓ spinner steps
  by 5 (skips values a clinician might want), and it violates golden rule
  7c's own blanket wording ("never," no form-context carve-out) even where
  the v0.13 failure mode can't fire. Fix it for consistency and to close
  the spinner gap, not because it silently blocks entry the way v0.13 did.
- **Do:** `step="any"`. Range stays checked in JS.
- **Pin:** grep in `test_usability.js` / `test_v013.js` that no clinical
  number input has `step` other than `any`. Extend that grep to
  `#pt-target`.

#### F20 — Engine LLOQ error still says “patient card”
- **Where:** `src/bayes.js` `runFit` throw:
  *“enter the assay LLOQ in the patient card.”*
  LLOQ moved to card 2 assay fold in v0.20. The UI path
  (`src/ui.js` obs-form handler) already opens that fold.
- **Do:** fix the string. The UI path is the one users hit; the engine
  throw is the backstop (tests, JSON import).
- **Pin:** grep the old phrase; must be gone.

#### F21 — No millisecond-timestamp guard
- **Where:** `src/bayes.js` `buildGrid` / `runFit`. Known nice-to-have,
  README §12.1 / §15.
- **Do:** if any dose/obs `t` looks like epoch-ms (`abs(t) > 1e5` days ≈
  274 years, or `t > 1e11`), throw a clear error. Do not attempt to
  rescale — the UI converts ms→days in `relContext()`; a bad caller is a
  bug.
- **Pin:** `runFit({doses:[{t: Date.now(), amt:900}], …})` throws and
  does not hang. Confirm the test goes red if the guard is removed.

#### F22 — Stepper step 1 ≠ card 1
- **Where:** `index.html` stepper “1 Enter weight”; card 1 is “Drug &
  patient” and the drug selector is first.
- **Do:** “1 Drug & weight” (or “1 Drug & patient”). v0.16/v0.19 already
  fought this numbering; don’t invent a fifth meaning for “1”.

#### F23 — Printed report can leave the ward unsigned
- **Where:** `index.html` `#rp-prepared` optional; `reportHtml` prints
  whatever is there.
- **Do:** require a name before Generate, or watermark “unsigned.”
  Research-use disclaimer already prints — keep it.

#### F24 — eculizumab `assumptions[3]` points at a fold name that no longer exists

> **[New finding — found in the second-pass review of 2026-09-13, missed by
> this audit's first pass.]**

- **Domain:** UI text, same stale-string family as F20.
- **Where:** `src/model.js`, eculizumab `assumptions[3]`:
  *"The residual error is that of the Radboudumc assay; a local assay with
  different precision requires the assay-error multiplier under Advanced
  options."* This text is also what prints in the report/About via the
  drug-spec assumptions list.
- **What is wrong:** "Advanced options" does not exist as a fold name
  anywhere in the shipped UI. The v0.20.0/v0.21.0 Advanced-options split
  moved the assay-error multiplier into `#assayOptions`, labelled **"Assay
  settings (LLOQ, error multiplier)"**, in card 2 — and even the *other*
  fold (card 3, holding only the recency control) was renamed **"Advanced
  fitting options."** So the sentence sends a reader looking for a menu
  that was renamed twice and no longer contains the control it names.
- **Do:** `s/under Advanced options/in "Assay settings", below the
  measurements/` (or equivalent). One string.
- **Pin:** grep `src/model.js` for the literal `Advanced options`; must be
  zero hits (mirrors F20's pin on the LLOQ engine-throw string).
- **Do not:** touch `#advancedForecast`'s current name ("Advanced fitting
  options") — that one is correct as of v0.21.0.

---

### P3 — polish, only if asked

- Formal WCAG pass (2×2 header focus order, diagnostics modal on phone,
  log-axis toggle accessible name).
- Dutch UI (intended users). i18n is on the README roadmap; do not
  hard-split strings across `index.html` and `ui.js` without a plan.
- If chart continuation stays at 250 draws, say so in the legend (subset
  of F5).
- `src/model.js` `iovVar` comment still describes v0.20 recency-as-IOV.
  Behaviour is v0.21. Comment-only; do not retie recency to IOV.
- Infusion duration not user-editable. Troughs are almost insensitive;
  peaks are not. Low priority for this product’s use (interval
  prolongation).
- No warning that the typed dose may not match the label weight band
  (ravulizumab / crovalimab). A non-directive “label band for this
  weight is X mg” is information, not a suggestion — only if the author
  wants it. Do not add a “correct dose is…” control.

---

## 4. Implementation recipes (once the author has picked items)

### F2 — findingsLines

Edit only `findingsLines` in `src/ui.js`. Sort `upcoming` by `t`. Emit
next-dose sentence from `upcoming[0]`. If another row has lower
`pTarget`, emit a second sentence with **that** date. Reuse `fmtDate` /
`fmtC` / `fmtPct`. Mirror any parallel wording in About only if it
repeats the bug (it currently does not).

Test without jsdom: `ECU.findingsLines` is already exported. Build a
minimal `snap` with `fit.troughs` of two future rows and `fit.rel.nowRel`
in the past. Assert on the strings.

### F3 — recommendation language

Single pass over `ptaBadge`, the advisory `ad.push` near
`upcoming.some(... pTarget < 0.9)`, and `#howto` in `index.html`.
`findingsLines` already uses non-directive wording for the 90% bullet
(*“is not predicted to be reached with ≥ 90% probability”*) — keep that
register. Update `tests/test_usability.js` help-text assertions if they
pin the old howto sentence.

### F19 — target step

One attribute in `index.html`. Extend the existing “no step grid”
assertion. Rebuild.

### F1 — calibration filing

No production-code change unless a scenario fails. If it fails, open a
new finding; do not “fix coverage” by inflating residual error or
widening Laplace fallback.

### Version / docs for any code change

1. `src/version.js` and `package.json` (today `0.22.0` → `0.23.0` for the
   first code drop, not for this markdown file).
2. `npm test` and `node tools/verify_control_streams.mjs`.
3. `npm run build`.
4. Dated section in `VALIDATION.md`.
5. Do **not** hand-edit `complementtdm.html`.

---

## 5. Files the next agent will actually touch

| Finding | Files |
|---|---|
| F1 | `VALIDATION.md`, `MODEL_VALIDATION.md`, `README.md` §9 (no `src/*` unless calibration fails) |
| F2 | `src/ui.js` (`findingsLines`), new test |
| F3, F11 | `src/ui.js` (`ptaBadge`, advisory), `index.html` (`#howto`), usability test |
| F4 | **stop and ask**; then either `src/model.js` + `crovalimab.txt` + `tools/verify_control_streams.mjs` **or** `src/ui.js` / `index.html` caveat only |
| F5 | `src/bayes.js` (`runFit` continuation, `regimenScanSetup`) |
| F6 | `src/bayes.js` (`ess`, `runFit`), `src/ui.js` (`precisionWord`) |
| F7 | `src/bayes.js` (`modalInterval` / continuation / `virtualTroughTime`), `src/ui.js` banner |
| F8 | `src/ui.js` guards, maybe `src/bayes.js` `runFit` weight throw |
| F9 | `src/ui.js` trough legend + `findingsLines` |
| F10 | `src/ui.js` dose-add + `relContextSS` |
| F12 | `src/ui.js` `saveSession` / restore bar |
| F13 | `index.html` `#howto`, `src/chart.js` `<desc>` |
| F19 | `index.html` `#pt-target` |
| F20 | `src/bayes.js` throw string |
| F21 | `src/bayes.js` `runFit`/`buildGrid` |
| F22 | `index.html` stepper label |
| F23 | `src/ui.js` report modal handler |
| F24 | `src/model.js` (eculizumab `assumptions[3]`) |

Engine / model / MCMC code is **not** implicated by F2, F3, F11, F13,
F19, F20, F22, F23, F24. Prefer those if the brief is “small safe drop.”

---

## 6. Out of scope for the next agent unless explicitly asked

- Dose suggestion, label/SmPC strategy tables, “recommended” highlighting.
- Paediatric / pregnancy / dialysis models.
- ADA model, drug-switch model, PD (LDH/C5) overlays.
- Server, analytics, npm runtime dependencies, editing `complementtdm.html`.
- Replacing Nelder–Mead or DP54.
- i18n, PDF export, WCAG audit (P3).

---

*Independent review of v0.22.0. Handover only — no code was changed in
producing this file. Bump `src/version.js` when you start changing the app,
not when you only add this document.*
