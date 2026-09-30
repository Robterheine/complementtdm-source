# Novice clinical pharmacologist — UI review of complementtdm (v0.7.2)

**Reviewer stance:** a novice clinical pharmacologist opening the app for the first
time to do a real TDM case. I know what a trough is, I know my patient is on
eculizumab/ravulizumab/crovalimab, but I have never run a Bayesian
individualization and the vocabulary inside the tool (MAP, LLOQ, η, IOV, M3,
ESS) is new to me.  
**Date:** 2026-09-09 · **App reviewed:** `complementtdm.html` v0.7.2 (source `index.html`)  
**Brief:** keep the interface uncrowded, surface help where it is needed, and
only add instruction where a novice would otherwise stall. If the current design
is already optimal, say so.

> No code was changed for this review. Citations like `index.html:42` /
> `src/ui.js:…` point to the current source.

---

## 1. Verdict in one paragraph

The interface is **already close to optimal for its audience.** Three-panel
layout (Patient → Schedule+Chart → Forecast) mirrors the real task order,
empty-by-default fields force mindful data entry (v0.7.1), the per-drug
placeholders and the optional Age/Disease rows are exactly the right kind of
progressive disclosure, and the single primary action — the big teal
**Run forecast** — is unmissable. Most novices will complete a population
forecast on the first try without reading any documentation.

The remaining friction is not about adding more text — it is about *where*
help appears, what is hidden behind a `title` tooltip that a novice will never
hover, and a few places where the engine's honesty ("population forecast",
"stale inputs") is phrased in developer language. Five focused, low-intrusion
changes would make the app feel beginner-safe without making it wordy. Two
small bugs should be fixed regardless.

**Overall grade from a novice perspective: B+ → A- after the five fixes.**

---

## 2. What is already excellent (please keep)

1. **Task order is left-to-right, top-to-bottom.** Header drugs → Patient →
   dosing → concentrations → Run → results reads like a checklist. No hunting.
2. **Empty by default.** Weight, target and doses start blank with `e.g. 70` /
   `e.g. 900` placeholders — the novice is not tricked into accepting a drug
   default they did not intend (v0.7.1 fix). This is the correct policy.
3. **Per-drug progressive disclosure.** Weight always, Age only for crovalimab
   (`index.html:28` `covariateAge`), Disease only when it is a covariate
   (`spec.diseaseCovariate`), route selector only when `adminRoutes` exists,
   model note + target hint adapt (`#modelNote`, `#targetHint`). The novice
   never sees a field they cannot affect.
4. **Two schedule modes in one toggle.** Full schedule vs Steady state
   (`#modeSeg`) avoids the most common novice error (typing an entire history
   when the patient is simply on `q2w` maintenance). The helper line *Day 0 =
   latest dose* is well placed.
5. **The forecast reads without statistics.** Bands + median line + target
   dashed line + trough table with `P(> target)` colour badges is immediately
   legible. The `details` "How to read these results" (`index.html:118`) does
   not crowd the screen yet is one click away — correct trade-off.
6. **Research-use disclaimer travels with the report.** Footer + report footer
   + About modal carry the same message, so a printed report cannot be
   separated from its caveat.
7. **Everything is local/no-login.** "all computation local, no data leaves
   this device" in the header subtitle removes the novice's first worry
   (patient data).

If no change were made, the app would still be usable for routine TDM by a
novice who has been shown one example case. The suggestions below are polish,
not rescue.

---

## 3. Where a novice stumbles (observed pain points)

### 3.1 "Where do I start?" — no guided first step
On fresh load every data field is blank (good), but the page is equally blank
everywhere — there is no visual cue that **Weight + at least one Dose → Run**
is the minimum for a useful plot. A novice adds a concentration first, presses
Run, and gets *Add at least one dose first* (`src/ui.js:relContext`). The error
is correct but comes late. The empty chart says only *Enter the dosing schedule
and press Run* — which a novice who has not scrolled down may not see.

### 3.2 Tooltips: excellent coverage, wrong delivery and pitch
A full inventory shows the app is already **generously documented in hover
texts** — about **30 native `title` tooltips**, covering every header button
(About, Print report, Export/Import), every patient field (drug, weight, age,
disease, target, LLOQ, assay error), the schedule controls (mode options, dose
date/amount/route, steady-state dose/interval/anchor, clear all), the sampling
form (including a per-drug dynamic hint on the sample time: *"trough just
before the next dose, peak ≈ 30–60 min after start of the infusion"*), and the
results (Run button, trough-table column headers, and the P-badges, whose
titles even carry the live Monte-Carlo interval).

So **coverage is not the gap — delivery and wording are**:

1. **Native `title` tooltips are hover-only and ≈ 1 s delayed.** They do not
   appear on touch devices (ward tablets), cannot be reached by keyboard, and
   screen readers routinely skip them. The novice who most needs *What is
   LLOQ?* is exactly the one who will never trigger the answer.
2. **Long titles get truncated** by browsers after a few lines — the weight
   and assay-multiplier tooltips (2–3 sentences) lose their endings.
3. **Wording is pitched at the modeller, not the prescriber.** Example
   (crovalimab age): *"covariate of the SC absorption rate: ka = 0.126 ·
   (age/36)^-0.459 per day"* — precise, but the sentence a novice needs is
   *"older patients absorb more slowly"*. Likewise `wtTooltip` explains the
   allometric reference weight (75 kg) when the novice needs *why the field is
   required*.

### 3.3 Jargon in the results card that a novice cannot decode
The results card is honest — and honesty is good — but its shorthand assumes
prior Bayesian training:

- `Individualized: MAP-Bayes + MCMC (2400 posterior draws, ESS ≈ 567,
  acceptance 0.31) · computed in 1240 ms` (`src/ui.js:renderResults`) — a
  novice reads six unknown acronyms and a millisecond count they cannot act on.
- `η(CL), η(V1) (MAP)` and `CL 0.14 [0.11–0.19] L/day` — no plain-language
  anchor.
- `Eff. t½ at trough (approx.)` — the novice does not know this is saturable
  and therefore concentration-dependent.
- The trough table header *P(> 75 µg/mL)* with a hover-defined Monte-Carlo
  interval — the core clinical number is the least explained element on the
  page.

None of this is wrong; it is simply written for the modeller rather than the
clinician. A novice's trust comes from understanding *what the numbers mean
for the dose*, not from seeing the sampler diagnostics.

### 3.4 Advanced section is well-hidden but still technical
`Advanced (assay error)` collapsed by default is the right call (`index.html:47`).
When opened, its one-sentence legend is good, but its `title` repeats the
model language (*residual error*, *shrink less aggressively*) and the field
itself (`value="1"` with `0.1–10`) invites experimentation with no guardrail
other than the title. A novice wonders: *should I touch this?* and has no
answer.

### 3.5 A few low-level inconsistencies
- **Age starts at 36** (`index.html:29` `value="36"`) while the empty-by-default
  policy (`NOVICE`/`v0.7.1`) says every data field should be blank. 36 is
  crovalimab's reference age — informative for the modeller, but it reads as a
  patient value. It also means switching to crovalimab silently populates a
  patient field.
- **Assay error multiplier starts at 1** (`value="1"`) for the same reason —
  arguably a sensible default, but inconsistent with the stated policy; worth
  documenting as the one intentional exception.
- **Disease selector** keeps `PNH` selected even when hidden (ravulizumab,
  crovalimab). Harmless, but a novice who toggles drugs back and forth sees the
  value snap back without explanation; the note wiring (`diseaseNote`) is only
  visible when the row is visible.
- **`clear all` is styled as a link** (`button.linklike`) in the dosing header
  — easy to hit accidentally when the intent was *add dose*; it currently
  triggers a native `confirm()` which blocks the preview harness in tests and,
  more importantly, gives no undo.

None of these breaks a case, but they erode the sense that *the tool behaves
exactly as it looks* — which matters for clinical trust.

### 3.6 Report flow is sound but discovers its fields late
`Print report → Generate report` opens a modal with **Prepared by** and
**Advice** (`#reportModal`). This is the right separation (advice is the
clinician's, not the model's). From a novice perspective, though, the two most
important report fields are discovered only at print time, after the
forecast has been run. The novice who exports a session and re-imports it on
another machine does get the values back, but there is no hint earlier that
*you will be asked who did the calculations*.

---

## 4. Recommendations — keep it simple, add help where the hand hovers

All recommendations follow the principle *progressive disclosure + plain
language + help at the point of confusion*. They are ordered by impact and
deliberately small — the interface does not need more chrome, it needs fewer
moments of doubt.

### P1 — Make the first step visible without adding a manual (high impact, tiny change)

- Add a persistent, dismissible one-line guide directly under the header
  (or as a top card): *1 · enter weight · 2 · add doses · 3 · add samples if
  you have them · 4 · Run forecast*. Four dots with the current step filled.
  It collapses after the first successful run (preference, not required).
- Disable **Run forecast** with a plain-language reason rather than alerting on
  click. E.g. button disabled + helper line: *Enter weight and at least one
  dose to run*. Today the button is enabled, the alert fires afterwards
  (`src/ui.js:runFit` weight/rel checks). A disabled primary button teaches
  the required fields faster than a dialog, especially for a novice who is
  scanning for what to do next.
- **Keep the chart's empty state one line:** it already does this well;
  no change needed beyond the stepper.

*Alternative considered:* a full onboarding overlay or tour — rejected. It
would add clutter for every return visit. A stepper is one line, always
useful, trivially dismissible.

### P2 — Two-tier help: ⓘ popovers for the critical six, tooltips for the rest (high impact)

The inventory above changes the recommendation: the app does not need *more*
tooltips — it needs a **two-tier help scheme** that keeps what works and fixes
what does not:

- **Tier 1 (promote):** the **six fields where a novice actually stalls** get
  a small **ⓘ** button next to the label, opening a one-sentence popover on
  **click and tap** (keyboard-accessible, hover supported for mouse users).
  Popover text is the current title **rewritten in prescriber language**
  (rewordings below), kept to 1–2 short sentences to survive small screens.
  The technical sentence (ka equations, allometric references) moves to the
  About modal — it stays available, just not in the field.
- **Tier 2 (keep):** all ~30 existing native `title` tooltips stay exactly as
  they are — they cost nothing, serve mouse users who explore, and the
  dynamic ones (per-drug sample-time hint, P-badge Monte-Carlo interval) are
  genuinely good. Where a title is 3 sentences long, split it: first sentence
  stays as `title`, the rest migrates to the ⓘ popover or About.

The six promoted fields:

| Field | Today (`title`, excerpt) | Proposed ⓘ popover (prescriber language) |
|---|---|---|
| Weight | *Body weight in kg — covariate on clearance and volumes. Eculizumab/ravulizumab scale allometrically to 70 kg; crovalimab to 75 kg.* | *Body weight — the model uses it to adjust clearance and volumes. Enter the current weight in kg.* |
| Trough target | *The trough concentration you want to maintain — used for P(trough > target)… reset when you switch drugs.* | *The lowest trough you want to keep. The table shows P(> target) — the chance the true trough stays above this number. Left empty, the drug's usual target is used.* |
| LLOQ | *Lower limit of quantification… M3 likelihood method.* | *Lowest concentration your lab can measure reliably (see the lab report, e.g. 10 µg/mL). Samples below this are still useful — tick "< LLOQ" when you add them.* |
| < LLOQ checkbox | *Mark this sample as below the lower limit of quantification.* | *Tick when the lab reported the result as below the measurement limit. Enter no value; the app uses the LLOQ above.* |
| Assay error | *Scales the model's residual error to your local assay… shrink less aggressively…* | *Leave at 1 unless your lab advises otherwise. Raise it only if your assay is noisier than the model assumes — the forecast then leans more on typical patients.* |
| Age (crovalimab) | *…ka = 0.126 · (age/36)^-0.459 per day. Older patients absorb more slowly.* | *Age in years — older patients absorb the under-the-skin dose more slowly. The model uses this to adjust the absorption rate.* |

*Why not just keep `title` everywhere?* `title` is not accessible, not
touchable, slow (≈ 1 s hover delay), truncated when long, and screen readers
often skip it. A ⓘ popover is the standard pattern in clinical software and
adds zero visual weight when closed — the interface stays exactly as quiet as
it is today.

### P3 — Rewrite the results card for a prescriber (medium impact, no new UI)

- Keep the badge table and the chart exactly as they are — they are the best
  part of the novice experience.
- Replace the top *method line* with two layers: a **plain first line**, then
  a collapsible technical line.

  **Proposed first line (always visible):**
  > *Individualized to this patient's 2 sample(s) — or — Population forecast (no
  > samples fitted yet).*

  **Collapsed `details` "How this was calculated" (one click):**
  > *Best-fit clearance 0.14 L/day [90% plausible 0.11–0.19], central volume
  > 4.1 L [3.6–4.8]; half-life near trough ≈ 11 days (shorter at higher
  > concentrations). 2400 posterior draws. Intermediate precision.*

  Map `MAP → Best fit`, `η → individual shift from typical`, `ESS/acceptance`
  → a qualitative precision word (*good / intermediate / low — re-sample
  suggested*) with the numbers in parentheses, not as the headline.
  The runtime (`computed in 1240 ms`) can move into the details line — a
  novice does not need it to trust the advice.

- The trough table's `P(> 75 µg/mL)` badge already has a title with the
  Monte-Carlo interval — surface that interval on click as well (a tiny
  popover *30% (95% interval 28–33%)*) so the novice learns that the
  probability is itself uncertain.

### P4 — One-line fixes for the inconsistencies (low effort, high polish)

- Make **Age empty by default** (remove `value="36"`, add `placeholder="e.g. 36"`)
  and show the reference-age sentence only in the ⓘ popover / About — same
  policy as weight/target. Keep assay error multiplier at `1` but mark it in
  the UI as *default 1 — leave unchanged unless your lab advises otherwise*
  (one-line legend, which already exists — just reword).
- Restyle `clear all` from a link to a secondary button with an icon and move
  it to the card footer (*Clear schedule*), or keep its position but require
  no `confirm()` — instead move deleted doses to a 6-second *Undo* toast.
  The native `confirm()` is the only blocking dialog in the app and caused
  the automated preview harness to hang during the last verification.
- When a drug without a disease covariate is selected, clear the stale
  `diseaseNote` text and reset the `select` to its first option explicitly,
  so toggling drugs does not carry a hidden value.

### P5 — Surface the report's human fields one step earlier (tiny, optional)

- Add a faint helper line under **Run forecast**: *You will be asked who
  prepared the report when you print.* — one sentence, no field, no clutter.
  It sets the expectation without adding inputs to the main screen (which the
  design correctly keeps out of the main flow). No earlier field is needed;
  the modal is the right place for Prepared-by/Advice.

### What *not* to do

- Do not add a persistent instruction column or a left-hand help pane — it
  would crowd the three-panel layout that is the app's best feature.
- Do not add more fields *Required* asterisks everywhere — the Run button's
  disabled-state + the alert on weight already teach the requirement; an
  asterisk wall makes the form look bureaucratic.
- Do not rechrome the chart legend — it is already minimal and the ⓘ pattern
  above covers the only missing explanation (what the bands are).

---

## 5. Implementation note (if you want these built)

All five are scoped to `index.html` + `src/app.css` + `src/ui.js`:

- P1: stepper + Run-button disabled logic (derive `canRun` from `wt != null &&
  doses.length>0` in `syncInputs`/`markStale`; no model change).
- P2: six `<button class="info" aria-label="What is …?">ⓘ</button>` markers
  beside the promoted labels + one delegated click/outside-click handler and a
  shared popover element in `ui.js` (pure CSS positioning, no dependency);
  per-drug popover text for Weight/Age read from the spec (extend
  `wtTooltip` with a `wtHelp`/`ageHelp` prescriber variant so the per-drug
  reference weights stay documented). P-badge popover reuses the same
  mechanism for the Monte-Carlo interval.
- P3: rewrite `renderResults` strings + add a `<details>How this was
  calculated</details>` inside `#paramBlock` (no statistical change).
- P4: `index.html` attribute edits + `clear all` handler.
- P5: one-line note in `#resultsCard`.

The report suite (`tests/test_report.js`) already guards "no NaN/undefined in
printed text" — extend it with *no `title`-only help remains on Weight/LLOQ/
Target* once P2 lands. The 334-assertion suite has headroom for the stepper
state test.

---

## 6. Bottom line for a novice user

> *I could run a population forecast in under a minute with no help. To use
> measured concentrations confidently, I needed to hover for definitions that
> did not appear on touch, and the forecast header made me feel I should already
> know what MAP/ESS meant. With the stepper telling me what to enter first and
> one-tap ⓘ help on Weight/LLOQ/Target, I would have no questions left — the
> tool would feel as simple as the dose table it already is.*

The interface is not crowded and does not need to become so. A handful of
plain-language surfaces in exactly the places where a novice pauses will make
it feel intuitive without adding a single extra card or paragraph.

---

*Prepared in the requested novice-clinical-pharmacologist voice. No app files
were modified. — Freebuff review agent*
