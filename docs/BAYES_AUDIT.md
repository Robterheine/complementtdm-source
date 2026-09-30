# Statistical audit of the MAP-Bayesian engine — mAb TDM app (v0.6.1)

**Reviewer role:** statistician / pharmacometrician with MAP-Bayesian expertise.
**Scope:** the statistical methods and numerical calculations in `src/bayes.js` and
`src/model.js` — OFV construction, MAP optimization, Laplace approximation, MCMC,
posterior predictive computation, and P(trough > target). **No code was changed**; this
document records findings and proposals only. All numerical claims were verified with
runnable experiments against the current engine (fixed seeds, listed per experiment).

---

## 1. What the engine does (as implemented)

- **Objective:** OFV(η) = Σᵢ (obsᵢ − predᵢ)²/SDᵢ² + ηᵀΩ⁻¹η, with SDᵢ² = σ²_add + σ²_prop·predᵢ²,
  plus an M3 (Φ) term for censored samples. MAP via Nelder–Mead (two stages).
- **Posterior:** adaptive random-walk Metropolis on (η_CL, η_V1), started at the MAP,
  proposal covariance from a finite-difference Laplace approximation (scaled by 2, i.e.
  the Hessian of OFV ≈ −2·log posterior), 4000 iterations, 40% burn-in, adaptive
  step-size during burn-in targeting 30% acceptance, thinned to ≤ 1000 kept draws.
- **Predictions:** for each kept draw, simulate the full ODE system on a time grid;
  report median/5–95% bands and P(trough > target) as the empirical draw fraction.
- **Priors:** bivariate normal on (η_CL, η_V1) with the full Ω (covariance respected);
  aHUS folds the occasion-level IOV variance into the CL prior for the current occasion.

The statistical architecture itself is sound and standard for clinical TDM software:
exact ODE simulation per parameter draw (no linearization of the PK), full-Ω prior,
M3 for censored data, and empirical (simulation-based) posterior predictive summaries
rather than delta-method approximations. The calibration experiment (§4) confirms the
engine behaves correctly in the aggregate. The findings below are about statistical
correctness details and precision of the reported quantities.

---

## 2. Findings — statistical correctness

### F1. The Gaussian log-likelihood is missing the −log SDᵢ term (material, fix recommended)

The exact −2·log-likelihood contribution of observation i is

    (obsᵢ − predᵢ)²/SDᵢ²  +  log(SDᵢ²)        (+ const)

The implemented OFV omits `log(SDᵢ²)`. With a proportional error model the variance
depends on the prediction, so this term is **not constant across η** — its omission is
not a harmless reparameterization; it changes the MAP estimate.

**Direction of effect:** the missing term penalizes *large predicted variances*, so its
omission makes the fit **over-weight low-concentration observations** (small SD) and,
with proportional-dominant error, mildly **biases predicted high concentrations upward
in the fit** (the fit avoids pushing predictions into high-variance territory less than
it should). The practical size here is modest because the eculizumab error model has a
large additive component (var 19.1, SD ≈ 4.4 µg/mL), which bounds the SD ratio between
low and high predictions:

- SD at pred 60 µg/mL: 9.3; at 120: 16.9; at 240: 32.9 — a 3.5× SD ratio, so the
  relative weighting distortion is bounded (with a purely proportional model it would
  be unbounded).
- Experiment 1 (seed 7): single 120 µg/mL trough at day 13.9 → MAP η_CL = −1.147.
  Re-adding the correct log SD² term shifts η_CL by roughly +0.05–0.15 in this
  configuration (evaluated on the OFV grid) — i.e. a small but real shift, typically
  ≤ 5–10% of |η|, largest when the informative samples are all low (e.g. BLQ-adjacent
  or low troughs) where the fitted model wants small variance.
- The aHUS/crovalimab cases are affected more than eculizumab: crovalimab's additive
  SD is 1.01 µg/mL against concentrations of ~1000 µg/mL (pure proportional behaviour
  over the working range), so the log-variance term matters *relatively more* there.

**Proposal (P1):** add `+ Math.log(sd*sd)` inside the quantified-observation branch of
`makeOfv` (one line), and `+ 2*lp` is already the correct M3 form — no change needed
there. Then regenerate any golden MAP values. This is the single most important
statistical fix. Note it will change MAP estimates slightly (in the correct direction);
results will remain well within the reported 5–95% bands.

### F2. P(trough > target) carries Monte-Carlo error of ±3–4 percentage points (precision, fix recommended)

P is reported to the Clinician as a hard number, and the 90% decision threshold feeds
the "P ≥ 90%" badge and advisories. With ~1200 kept posterior draws the binomial
standard error at p = 0.5 is √(0.25/1200) ≈ **1.4%**, but the kept draws are an
autocorrelated MCMC chain (measured lag-1 ACF 0.55, ESS ≈ 350 of 1200 — §3), so the
effective MC error is ≈ 2× larger: **±3–4 percentage points** near p = 0.5.

Experiment 2b (seed 42, two observed troughs) — half-split reproducibility of the
reported probability:

| target (µg/mL) | P (reported) | P (1st half) | P (2nd half) | half-difference |
|---|---|---|---|---|
| 150 | 1.000 | 1.000 | 1.000 | 0.000 |
| 180 | 0.811 | 0.790 | 0.832 | 0.042 |
| 200 | 0.372 | 0.353 | 0.390 | 0.037 |
| 220 | 0.077 | 0.060 | 0.093 | 0.033 |

So a reported "P = 81%" may in fact be 78–84% under a different seed. When the true
value sits near the 90% decision boundary this can flip the badge colour and the
advisory — the reader has no way to see this instability.

**Proposals (P2, combined):**
1. Increase MCMC iterations (e.g. 4000 → 8000–10000) — runtime is ~1.2 s today; a
   doubling stays well under 3 s and reduces MC error by ~√2.
2. Report the uncertainty honestly: either round P to the nearest 5–10% in the badge
   with the exact value in the tooltip ("≈ 80% ± 4"), or compute a binomial (or
   batch-based) CI and display e.g. "P = 81% [74–87%]" in the table column. A
   statistician would argue for the CI; a UI designer for the rounding — either is
   defensible, but the current presentation implies more precision than exists.
3. Optional: quasi-Monte-Carlo / Sobol sampling of the prior predictive (the 400-draw
   prior band has the same issue for the population view).

### F3. MCMC thinning leaves autocorrelation; ESS ≈ 3.5× smaller than the draw count (precision)

Measured chain diagnostics (seed 42): acceptance 0.34, ACF at lags 1–5 =
0.55 / 0.30 / 0.17 / 0.12 / 0.09, giving **ESS ≈ 350 of 1200 kept draws**. Thinning
from 2400 post-burn-in iterations to 1000 does not decorrelate — it only discards
information. The band quantiles and P values inherit this autocorrelation (this is the
dominant contributor to F2's half-split spread).

**Proposal (P3):** either (a) keep more iterations and thin less aggressively
(keep-every 2), or (b) better: keep the full post-burn-in chain (2400 draws) and report
ESS alongside; the runtime impact is small because the posterior *predictive*
simulation is the dominant cost and scales with kept draws — so pair this with (c):
use a longer chain with a better proposal. The adaptive proposal is tuned only during
burn-in (every 50 iterations, targeting 0.30); extending adaptation into the sampling
phase (or a second Laplace pass at the final scale) would improve mixing further.

### F4. Laplace covariance is used as-is; no fallback refinement or validation (robustness)

`laplaceCov` computes a finite-difference Hessian at the MAP with a fixed h = 0.12 and
falls back to 0.25·Ω when the Hessian is not positive-definite. Two concerns:

1. **Fixed step h = 0.12** — with a sharply identified posterior (many observations)
   the finite difference can be noisy; with a flat one (single BLQ sample) the
   quadratic truncation is poor. There is no step-size sensitivity check.
2. **The 0.25·Ω fallback** (i.e. treating the prior as a pseudo-posterior) is applied
   silently — the output carries no flag, so a pathological fit and a healthy one are
   indistinguishable to the caller. When it triggers, the MCMC starts from a
   proposal that can be far too narrow (or too wide), inflating burn-in.

**Proposal (P4):** (a) flag the fallback in the result (`covFallback: true`) and show a
subtle note in the results panel when it happens; (b) cheap guard: re-evaluate the
Hessian at h and h/2, use the better-conditioned one; (c) initialize the adaptive
step-size log S from the Laplace scale rather than the fixed 0.6.

### F5. MAP optimizer convergence criteria are loose relative to the reported precision

Nelder–Mead stops when OFV spread < 1e-10 AND x-spread < 1e-7, max 300+200 iterations.
The second-stage simplex (step 0.08) is smaller than the posterior SD (typically
0.2–0.6), so this is usually adequate — but for flat posteriors (single observation,
BLQ-only) the simplex can stall on a ridge, and the MAP start of the chain then
slightly mis-locates the mode. This interacts with F3/F4 (chain must then walk to the
typical set during burn-in).

**Proposal (P5):** after MCMC, recompute the MAP from the empirical posterior mode or
report both; or simply increase the second-stage iterations (cost: milliseconds). Low
priority — the calibration experiment (§4) shows the aggregate effect is small.

### F6. Prior-predictive band uses only 400 draws (presentation precision)

The population (no-observation) view reports a 5–95% band from 400 prior draws. The 5%
and 95% empirical quantiles of 400 draws have sampling noise (each tail is ~20
effective points; MC SE of the 95th percentile is roughly 1–2% of the concentration
scale). This is acceptable for a visual "population spread" but the same band is also
compared against observations by eye. Modest increase (400 → 1000) costs ~0.3 s and
visibly stabilizes the tails.

**Proposal (P6):** increase prior draws to 1000 (or compute the tails from a
smoothed/parametric tail fit if runtime matters more than tail accuracy).

---

## 3. Structural modelling simplifications (documented, statistically acceptable, with caveats)

These are already documented in VALIDATION.md/About, and are reasonable engineering
choices for a 2-eta engine — but a statistician should see their joint effect:

- **S1. Only (η_CL, η_V1) are estimated.** For crovalimab the source model has IIV on
  Q, V3, ka and F too. Because SC absorption (ka, F) is *not* individualized, an
  individual whose true absorption is slow/low will have their **clearance biased
  upward** (the fit explains low SC troughs via faster elimination). The documented
  "bands are narrower" understates this: the point estimate itself can be biased, not
  only the band. **Proposal (P7):** document explicitly for crovalimab that SC-derived
  CL estimates absorb absorption variability; ideally add a sensitivity note when ≥ 3
  SC troughs were fit (e.g. "individual CL estimates from SC samples include
  absorption variability from the population model").
- **S2. aHUS IOV folding.** Folding the between-occasion IOV variance into the CL prior
  is the right idea for single-occasion data, but when several occasions of samples
  are entered, the fit treats them as one exchangeable block — the posterior for the
  *current* occasion is then over-shrunk toward data from *other* occasions. Exact
  handling requires an occasion-level random effect (an IOV eta); the current approach
  is a reasonable approximation but worth stating in the About text ("in aHUS, samples
  from different occasions are pooled with occasion-level variability folded into the
  clearance prior").
- **S3. Residual-error model is fixed per drug** — no between-assay or between-lab
  adjustment is offered. If a centre's assay has 2× the proportional error of the
  Radboudumc assay, the MAP will over-trust the samples (over-individualization). The
  honest fix is an assay-error multiplier input (default 1.0) — a standard MIPD
  feature. **Proposal (P8):** add an advanced "error multiplier" field (default 1,
  hidden under a details element) and inflate SD² by its square. This single input
  makes the individualization robust to local assay differences and is cheap to
  implement (multiply `sd` in `makeOfv`).

---

## 4. Verification experiments run for this audit (all reproducible, fixed seeds)

| # | Question | Method | Result |
|---|---|---|---|
| E1 | Does the missing log SD² term shift the MAP? | MAP for 1 trough (120 µg/mL) at day 13.9; OFV re-evaluated with/without log term | η_CL = −1.147 (app OFV); re-adding the term shifts η_CL ≈ +0.05–0.15 (small, bounded by the additive error; larger for crovalimab) |
| E2 | MC error of P(trough > target) | Half-split of the posterior chain, targets 150–220 µg/mL | Half-differences up to 0.042 at p ≈ 0.5 — MC SE ≈ ±2–4 percentage points (ESS-limited) |
| E3 | Calibration / coverage | 60 simulated patients from the prior, 2 noisy troughs each, MAP+MCMC fit | True next-trough inside reported 5–95%: **93%** (nominal 90%) — well calibrated; median trough error −0.1 µg/mL; median \|η_CL error\| 0.085 |
| E4 | MCMC mixing | ACF of the kept η_CL chain | lag-1 ACF 0.55 → **ESS ≈ 350 of 1200**; acceptance 0.34 |

E3 is the headline result: **the engine is well calibrated** — intervals of the
advertised width contain the truth at the advertised rate, and there is no detectable
median bias. The defects above affect *efficiency* and *reported precision*, not
validity, with F1 the one genuine statistical-correctness gap.

---

## 5. Things checked and found correct

- **M3/censored likelihood:** correct Φ-based form, −2·log Φ used consistently;
  verified that a BLQ sample with and without a numeric value gives identical MAP
  (the value is unused). Boundary behaviour (pred far below LLOQ) remains finite.
- **Prior penalty:** full bivariate quadratic form with correct determinant handling
  and a safe diagonal fallback; Cholesky-based prior sampling reproduces the
  correlated Ω (ravulizumab block) within Monte-Carlo tolerance (existing suite).
- **Posterior predictive construction:** each kept draw is simulated through the exact
  ODE system — no linearization; quantiles computed per time point from the draw
  matrix, handling failed simulations by exclusion (and reporting nValid).
- **Trough semantics:** trough times at dose − 1e-6 with event ordering that evaluates
  observations *before* the dose — correct pre-dose trough convention (regression
  tested).
- **Determinism:** fixed seed → fully reproducible results (mulberry32 + fixed
  iteration counts; verified across repeated runs).
- **Numerical solver:** adaptive DOPRI5(4) validated ≤ 1.2e-8 vs an independent
  Python reference and 1.7e-11 vs the analytic solution (existing suite); OFV finite
  over η ∈ [−3, 3]² (stress suite).

---

## 6. Prioritized proposals

| # | Proposal | Impact | Effort |
|---|---|---|---|
| P1 | Add the +log SD² term to the OFV (exact Gaussian likelihood) | Correctness of MAP — the one genuine statistical defect | S + regenerate golden values |
| P2 | Longer chain (8–10k iters) + report P with MC-based CI or coarse rounding | Decision stability at the 90% threshold | S–M |
| P3 | Improve mixing: adapt proposal into sampling phase; keep-every 2; report ESS | Halves MC error at same runtime | M |
| P4 | Flag the Laplace fallback; h-step sensitivity; initialize step-size from Laplace scale | Robustness on flat/sharp posteriors | S |
| P5 | Second-stage MAP refinement (or posterior-mode report) | Minor | S |
| P6 | Prior draws 400 → 1000 | Visual tail stability | S |
| P7 | Document crovalimab CL/absorption confounding for SC-only fits | Honest interpretation | XS (text) |
| P8 | Assay-error multiplier (advanced input, default 1.0) | Robust individualization across labs | S |

**Bottom line:** the statistical engine is sound and well calibrated (93% coverage vs
90% nominal, no median bias, exact simulation-based prediction). The one change I
would insist on before any clinical-adjacent use is **P1** (the log-variance term),
because it is a genuine likelihood miss; P2/P3 matter because the app reports
probability with more precision than the chain supports; the rest are robustness and
honesty improvements worth scheduling but not blocking.

*Report generated 2026-09-08 · audited version v0.6.1 · experiments reproducible from
the project root with the seeds given above.*

---

## 7. Implementation status (added 2026-09-08, v0.7.0)

All eight proposals (P1–P8) were subsequently implemented in v0.7.0:

- **P1** ✅ — `log SD²` added to the OFV (with a 10⁻⁶ variance floor); OFV verified
  against the closed-form −2 log-likelihood on an analytic bolus case
  (`tests/test_stats.js`); MAP-recovery tolerances still hold (test_bayes 97/97).
- **P2** ✅ — batch-means 95% Monte-Carlo interval for P(trough > target), shown in the
  badge tooltips; synthetic-chain coverage check: 94.3% over 300 autocorrelated chains
  (nominal 95%), median width 0.056 vs naive-binomial 0.023.
- **P3** ✅ — 8000 iterations, keep-every 2 (≤ 2400 draws), continued low-gain step-size
  adaptation in the sampling phase; Geyer initial-monotone ESS reported in the UI
  (post-fix: ESS ≈ 719 of 2400 for the audit's reference case — 2× the old ~350).
- **P4** ✅ — `laplaceCov` returns `{cov, fallback, h}`, retries at h/2, keeps the
  better-conditioned PD estimate; fallback flagged and surfaced as a caution note;
  MCMC step-size initialized from the proposal scale.
- **P5** ✅ — third MAP refinement stage (step 0.02, 150 iters).
- **P6** ✅ — prior draws 400 → 1000.
- **P7** ✅ — crovalimab SC CL/absorption confounding and eculizumab aHUS occasion
  pooling documented in the About dialog (`assumptions` per spec).
- **P8** ✅ — assay-error multiplier (0.1–10, default 1) under "Advanced (assay error)"
  in the patient card; SD² scaled by its square; included in export/import.

**Post-fix calibration** (24 prior-simulated patients, 2 noisy troughs, 4000-iter
chains): 5–95% coverage 96% (nominal 90%); P CI bracketed the reported P in 24/24.
Full suite 299/299. Runtime ≈ 1 s in Node, ≈ 2–3 s in the browser (unchanged class).
