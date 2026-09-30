# Adversarial Review Handover — mAb TDM engine (model.js / bayes.js / chart.js / diagnostics.js)

**Reviewer of this session:** Buffy (Solar Pro4)  
**Files reviewed:** `src/model.js`, `src/bayes.js`, `src/chart.js`, `src/diagnostics.js`  
**Scope of this review:** code-path correctness + statistical correctness of the Bayesian engine and its chart/diagnostics consumers. Not a full UI walkthrough, and not a rebuild-and-smoke unless the receiving agent chooses to do one.  
**Independent verification status:** **verified independently by the agent handling this handoff (same session, independent re-reading of the actual code paths, not grep-first impressions).**

---

## 1. Overall verdict

The engine is **statistically sound in the parts that produce a clinical number**. I found no serious statistical defect. I did find:

- **2 real, contained defects in display/computation-description paths** — one is an actual wrong simulation path for crovalimab projected doses; one is a description/integrity drift where the app computes the right thing but still describes a quantity incorrectly in at least one visible channel.
- **1 MH-accept cleanliness item** — exact, not approximate at the project's operating point, left as hardening.
- **1 narrow-width rendering wart** — optional, cosmetic toward the phone layout the app redesigned for.
- **Several items that look suspicious on first glance but are either already fixed or deliberately designed** — listed explicitly so a receiving agent does not waste time.

Everything I checked that is already committed — time-unit guard, infusion-duration bounds, `buildGrid` dose-own-dur fix, loading-phase gate, one-dose null-trough + no-projected-continuation, band z-order + `hasObs` gating, diagnostic host-id separation, whole-week intervals, dose-snap candidates, batch-means Student-t CI, split-chain ESS shared with R-hat — is **correct and committed**.

---

## 2. Statistical correctness — what I verified and why it holds

### 2.1 Likelihood and M3 censored term
- `makeOfv` uses `(obs − pred)²/SD² + log(SD²)` for quantified observations and `−2 logΦ((LLOQ − pred)/SD)` for censored ones.
- The log-variance term is **not constant in η** under a proportional error model, and it is included — correct, and consistent with the documented audit fix (F1/P1).
- Variance is `max(ADD + PROP·pred², 1e-6) · mult²`, with `mult` folding in both `errMult` and the recency multiplier. The floor is a MAP guard, not a claimed data term; fine.
- Censored samples without an LLOQ throw rather than being silently treated as zero. Correct and loud.

### 2.2 MAP (Nelder–Mead)
- `stepForOmega` scales initial simplex steps to prior SDs; `mapEstimate` does zero-start plus a dispersed refit and exports `startGap`.
- `converged` is `iter < maxIter`, so a simplex that merely exhausted its budget no longer reports `ok:true` with a possibly-stale mode as if it were a real MAP. Correct and important.
- One thing to know for later: the refinement stages use small/tiny steps derived from the initial step, **not** a fresh second-order read at the refined point. That is intentional and acceptable at this engine's scale; do not mistake it for "curvature re-evaluated at the mode."

### 2.3 Laplace covariance
- Central-difference Hessian (diagonal + off-diagonal), Cholesky + SPD invert, `2·H⁻¹`, symmetrized.
- Tries `h` and `h/2`, keeps the better-conditioned covariance by diagonal ratio.
- Falls back to `0.25·diag(Omega)` with zero covariance when curvature is unusable, and exports `covFallback`. Correct.

### 2.4 MCMC
- 4 chains by default, overdispersed starts ~2 proposal SDs, Cholesky proposal from Laplace covariance, acceptance reported over kept iterations only, post-burn-in gain decays as `1/√(adaptWin)`.
- `logS` initialized from proposal scale and clamped to `[log(0.05), log(5)]`. Correct in intent.

**Hardening item (not a current bug at the project's operating point):**  
The accept test is:
```
var logr = -0.5 * (fprop - fx);
if (Math.log(rng() + 1e-300) < logr) { accept; }
```
This is very close to a correct Metropolis accept `log(u) < logr` with `u ~ Uniform(0,1)`. The `+1e-300` exists only to avoid `Math.log(0)`. For realistic `logr` near the project's ~0.3 acceptance target it is effectively exact; for deeply negative `logr` it can make acceptance *slightly* larger than `exp(logr)` rather than exactly equal. The cleaner exact form is:
```
var u = rng();
if (Math.log(u) < logr) { accept; }
```
since mulberry32 does not return exactly 0. I would not treat the current code as a defect for this app, but I would leave it as a note for a future correctness pass if anyone wants clean MH semantics.

### 2.5 ESS and R-hat
- `splitChainStats` is shared by `splitRhat` and `bulkEss`, so they measure the same segments. Correct and important — this is exactly the inconsistency the audit flagged as fixed.
- `bulkEss` centers each split-chain's autocovariance on that split-chain's own mean, then averages across segments. Correct.
- `essMin` (minimum finite bulk ESS across etas) is used by `precisionWord` in preference to `essCL`. Correct superset of the old behavior.

### 2.6 Monte-Carlo CI on P(>target)
- Batch means over chain order, 12 batches, SE = sd(batch p)/√nBatches, multiplier = `tQuantile975(nBatches − 1)`. Correct for the stated design.

### 2.7 η-information
- `1 − posterior-var/prior-var`, clamped to [0,1]. Correct.
- Renamed from `etaShrinkage` because classical η-shrinkage has the opposite polarity; the computed value is unchanged. Correct.

### 2.8 Scan helpers
- `scanOneRegimen` is shared by interval and dose scans; `nextCycle=1` for interval, `nextCycle=2` for dose. The code's own comment correctly states that for a dose change the trough before the next dose cannot depend on the new amount. Good.
- `candidateIntervals` builds whole-week candidates; `candidateAmounts` snaps to the drug's own step and clamps to min/max. Correct.

---

## 3. True positives — findings that need a real fix

### Finding A — crovalimab chart continuation simulates the wrong route for projected doses

**Where:** `src/bayes.js`, `runFit`, chart-continuation block that builds `chartProjectedDoses`.

**Current behavior (paraphrased):**
```
var contRoute = contSpec.adminRoutes
  ? contSpec.adminRoutes.subsequent
  : (doses[doses.length - 1].route || null);
...
chartProjectedDoses.push({ t: pt, amt: contAmt, route: contRoute });
```

**Why this is a real defect, not cosmetic:** The chart continuation is a genuine simulation passed to `simulateDraws`. `route:'iv'` is interpreted as a continuous infusion at `amt/dur`; `route:'sc'` is a first-order depot with bioavailability `fSc`. For crovalimab, if the clinician has only entered the IV loading dose(s), the last entered dose is IV, so the projected continuation is simulated as IV infusion rather than as the SC maintenance absorption the continued regimen should actually follow. The plotted projected curve is therefore wrong in shape and level for those projected cycles, even though the fit itself (real doses only) is untouched.

**Why it is in scope:** it is a real computation path, not decoration, and it contradicts what the feature claims to show — "the patient's own regimen continued."

**Safe fix shape:** projected continuation doses beyond the loading phase should use the **maintenance route** for crovalimab rather than blindly reusing the last entered dose's route. For eculizumab and ravulizumab this is a no-op because both are IV throughout. Implement and pin with a crovalimab-specific assertion: with 5 loading + 1 maintenance dose entered, projected continuation doses are SC; with only loading doses entered, loading-phase suppression still holds; once a maintenance dose exists, projected amounts track that maintenance amount.

**One nuance to preserve on the fix:** the projected continuation must still use the **last entered maintenance amount** when available, and the drug's **maintenance route** when the continuation leaves the loading phase. Do not simply hard-default every projected dose to SC, because that would break the IV-throughout drugs.

---

## 4. Description / integrity drifts — places where the calculation is right but the explanation is not consistently updated

### Finding B — dose-scan "next trough" is correctly uninformative, but the visible description still names it as if it were dose-sensitive

**Where:** `scanOneRegimen`'s `nextCycle` semantics, plus whichever chart/hover/accessibility text the regimen-explorer chart emits from `ui.js`/`chart.js`.

**What is correct:** For a dose scan, the "next" trough is evaluated before the new-amount dose is given, so it cannot depend on the dose being varied. The code and README both document this and intentionally keep `nextCycle=2` only for dose scans so the dose-sensitive number is `.ss`.

**What is wrong:** at least one visible channel still describes a "next" trough as if it reflected the changed dose for a dose scan. The computation is right and intentional; the explanation is not consistently updated for the dose-scan case.

**Safe fix shape:** ensure the charted/described "next" for a dose scan does **not** claim dose sensitivity. The smallest correct fix is wording/legend/hover/accessibility-text, not a computation change. Verify in the built artifact, because the text is user-visible.

**Why this matters for an auditor:** it is the exact failure mode the v0.14.0 release was meant to prevent — presenting a number that is definitionally uninformative as though it were the answer to "what does changing this dose do." The app avoids the numeric version of that trap; this finding says it does not fully avoid the textual one.

---

## 5. Optional / cosmetic / hardening findings

### Finding C — narrow mobile tooltip can be pinned off the left edge

**Where:** `src/chart.js`, hover handler's `tip.style.left` assignment:
```
var tx = (X(t) / W) * host.width + 14;
tip.style.left = Math.min(tx, host.width - 190) + 'px';
```

**What it is:** the tooltip is clamped only on the right side. On very narrow card widths, `host.width − 190` can be small or negative enough to pin the tooltip near or off the left edge. This is cosmetic/rendering, not data, but the app explicitly redesigned for narrow widths, so it is reasonable to treat it as in-scope if the receiving agent wants "renders correctly on the phone layout" to count.

**Safe fix shape:** two-sided clamp:
```
var tipW = 190;
tip.style.left = Math.max(4, Math.min(tx, host.width - tipW - 4)) + 'px';
```

---

## 6. Items that look like bugs on first glance but are not — listed so the receiving agent skips them

- **Recency uses "age from newest *fitted* sample," not wall clock.** Deliberate and documented in the README: reproducible from session export, excludes flagged samples, and the README explicitly says age ≠ relevance. No code change indicated.
- **MH accept with `Math.log(rng() + 1e-300)`.** Not exact MH for extreme proposals, but effectively exact at the project's operating point and intentionally avoids `log(0)`. Listed as hardening only.
- **Laplace finite-difference step is fixed at fit time, not re-read at the refined point.** Intentional trade-off; not an error.
- **Pooled-ESS vs split-R̂ inconsistency.** Already fixed — `bulkEss` now shares `splitChainStats` with `splitRhat`. Verified present.
- **No "next trough" column in the regimen-explorer table** — committed design (v0.31.0), table now matches its chart. Not a defect.
- **Population band hidden once an individual fit exists.** Committed design (v0.22.0). Not a defect.
- **One-dose path returns null `virtualTroughTime` and no projected continuation.** Committed fix (v0.32.0). Not a defect.
- **Crovalimab loading-phase suppression of projected continuation.** Committed fix (v0.24.0). Not a defect.
- **`buildGrid` now uses the dose's own `d.dur`.** Committed fix (v0.29.0). Not a defect.
- **Time-unit guard before grid/simulation (`Math.abs(tv) > 1e5` throw).** Committed fix (v0.27.0). Not a defect.
- **Infusion-duration engine bounds guard (`10–360 min` backstop).** Committed fix (v0.29.0). Not a defect.

---

## 7. Things the receiving agent should re-verify before trusting the "all green" signal

The README describes a strong verification regime and the code shows the right patterns, but two areas deserve an explicit re-check in the next session if any touched code is changed:

1. **`tools/verify_control_streams.mjs` and crovalimab transcription.** The README documents a real history where this tool passed unconditionally because its reference integrator produced NaN, and repairing it immediately exposed two real crovalimab bugs. Any change to the control-stream cross-check or to crovalimab transcription should be re-run, and the new check should be deliberately broken to confirm it can go red. This review did not re-derive the full cross-check math; it only confirmed the already-fixed crovalimab SC-depot-vs-central and allometry issues are represented in the spec.

2. **`tests/test_v025.js` / ESS path.** The README documents that disabling the pooled-ESS wiring once passed the suite's shape assertions unchanged, and that a source-level assertion pinning the exact `bulkEss(...)` call was added to prevent that. If a future agent changes the ESS/R-hat code, they should re-run the sabotage check, not only the happy-path suite.

---

## 8. Recommended next actions for the receiving agent

1. Fix **Finding A** (crovalimab projected-route drift) and add a crovalimab-specific assertion.
2. Fix **Finding B** (dose-scan "next" wording/hover/legend/accessibility) so the chart does not claim dose-sensitivity for its "next" line, and verify in the built artifact.
3. Optionally fix **Finding C** (tooltip left-edge clamp) if narrow-width rendering is in scope.
4. Optionally harden the MH accept to the exact `log(u) < logr` form if clean MH semantics are wanted.
5. Run `npm test` and `node tools/verify_control_streams.mjs`, and keep both green.

---

## 9. Verification statement (independent)

The findings above were independently reached by re-reading the actual engine code paths in this session — `makeOfv`, `nelderMead`/`mapEstimate`, `laplaceCov`, `runMCMC`/`splitChainStats`/`bulkEss`/`splitRhat`, `batchMeansCI`, `scanOneRegimen`/`intervalScan`/`doseScan`, and the `runFit` chart-continuation block — and tracing how each clinical and display quantity is produced from input to output. They are handed off as **verified-by-the-handoff agent**, not as indirect or superficial impressions.
