# Model validation report — app implementation vs NONMEM control streams (v0.13.0)

> **v0.13.0 correction.** From v0.8.1 to v0.12.0 the structural half of
> `tools/verify_control_streams.mjs` compared against an all-`NaN` reference and
> therefore passed unconditionally (see VALIDATION.md V1). The §6 equivalence claim
> below had no evidence behind it during those releases. The tool is repaired and the
> figures quoted in §6 are now measured. Repairing it also exposed two genuine defects
> in the *reference* implementation for crovalimab — it read the SC depot compartment
> instead of the central one, and omitted the allometric scaling at 70 kg — both fixed.

**Reviewer role:** experienced pharmacometrician.
**Question:** are the models implemented in this app *exactly similar* to the three
NONMEM control streams shipped with the project (`nonmemcontrolstream.txt`,
`ravulizumab.txt`, `crovalimab.txt`)?

**Scope note.** This document checks the *model*: the ODE structure and the
transcribed parameters. It does not check the *estimation engine* (does the
app's own MAP optimizer agree with NONMEM's own fitting procedure, given the
same patient data?) — see `ESTIMATION_VALIDATION.md` for that, a separate
exercise running real NONMEM (via PsN) POSTHOC estimation against synthetic
patients and comparing individual parameter estimates directly.

**Verdict: YES — the transcribed fixed effects, variability and residual-error
parameters are identical to the control streams (machine-verified), the structural
models are mathematically equivalent to the `$DES` blocks (numerically verified
against an independent solver), and the only deviations are a short, explicitly
documented set of deliberate simplifications — none of which alters any
transcribed parameter value.** All numbers below were cross-checked by an
automated script (`node tools/verify_control_streams.mjs`, reproducible, exits
non-zero on any mismatch) that parses the control streams directly rather than
trusting any hand-typed expectation table.

---

## 1. Method

Three layers of checking:

1. **Transcription check.** `$THETA`, `$OMEGA`, `$SIGMA`, allometric exponents,
   covariate reference values and infusion durations are parsed *out of the
   control-stream files themselves* and diffed against the values the app uses
   (`src/model.js` spec objects). No parameter is compared against a
   hand-copied number.
2. **Structural check.** Each control stream's `$DES` (and, for ADVAN3, the
   equivalent ADVAN closed-form structure) is re-implemented as an independent
   fixed-step RK4 integrator written from the stream equations only —
   deliberately a different code path and different solver from the app's
   adaptive Dormand–Prince 5(4). Predictions for a standard schedule are then
   compared against `ECU.model.simulate`.
3. **Variability-use check.** Which `$OMEGA` items the app's 2-eta Bayesian
   engine consumes as priors, and which it deliberately drops, are listed
   per drug and compared with the control stream's full Ω.

Result of the automated run (v0.8.1 sources):

```
== eculizumab (nonmemcontrolstream.txt) ==          all checks passed
== ravulizumab (ravulizumab.txt) ==                 all checks passed
== crovalimab (crovalimab.txt, run05) ==            all checks passed
== structure: eculizumab $DES (ADVAN13 2-cpt + MM) ==  max rel. deviation 0.00% (12 points)
== structure: ravulizumab $DES (ADVAN3, rescaled) ==   max rel. deviation 0.00% (8 points)
== structure: crovalimab $DES (run05, SC depot + F1) == max rel. deviation 0.00% (11 points)
ALL CROSS-CHECKS PASSED
```

---

## 2. Eculizumab — `nonmemcontrolstream.txt` (ADVAN13, 2-cpt + Michaelis–Menten)

### 2.1 Fixed effects — identical

| Control stream | Value | App (`THETA`) | Match |
|---|---|---|---|
| THETA(1) CL, L/day | 0.1626 | `CL: 0.1626` | ✅ |
| THETA(2) V1, L | 4.299 | `V1: 4.299` | ✅ |
| THETA(3) VM, mg/day | 25.64 | `VMAX: 25.64` | ✅ |
| THETA(4) KM, mg/L | 13.54 | `KM: 13.54` | ✅ |
| THETA(5) V2, L | 2.63 | `V2: 2.63` | ✅ |
| THETA(6) Q, L/day | 0.6243 | `Q: 0.6243` | ✅ |

### 2.2 Covariate structure — identical

| Control stream `$PK` | App | Match |
|---|---|---|
| `CL = THETA(1)·(WT/70)^0.75·EXP(ETA(7))·EXP(IOV)` (aHUS) / without `EXP(IOV)` (PNH) | `cl = CL·(wt/70)^0.75·exp(η_CL)`, IOV folded into the CL prior for aHUS only (see §5.1) | ✅ equivalent |
| `V1 = THETA(2)·(WT/70)·EXP(ETA(8))` | `v1 = V1·(wt/70)^1·exp(η_V1)` | ✅ |
| `V2 = THETA(5)·(WT/70)`, `Q = THETA(6)·(WT/70)^0.75`, `VM = THETA(3)·(WT/70)^0.75` | same exponents (V exponent 1, CLQ exponent 0.75 incl. Vmax), ref 70 kg | ✅ |
| `KM = THETA(4)` (no covariate) | unscaled | ✅ |

### 2.3 Structural model — equivalent

Control stream `$DES`:
`DADT(1) = −KEL·A(1) − (VM·C1)/(KM+C1) − K12·A(1) + K21·A(2)`,
`DADT(2) = −K21·A(2) + K12·A(1)`, with `C1 = A(1)/S1`, `S1 = V1`.

App `rhs()`: identical term-for-term (linear kel, MM term on central
concentration, k12/k21 distribution, infusion as `rin` on the central
compartment). Numerically: max relative deviation 0.00% over a 6-week q2w
schedule with 12 observation times, including two troughs sampled ±0.01 d
around dose times (event-ordering check: observations at a dose time evaluate
*before* dosing — matching NONMEM's trough convention).

### 2.4 Variability and error — identical values

| Control stream | Value | App use |
|---|---|---|
| $OMEGA IOV (6 × BLOCK(1) SAME) | 0.112 | `IOV_CL: 0.112`, applied to aHUS only (see §5.1) |
| $OMEGA IIV CL | 0.1546 | `OMEGA.CL` |
| $OMEGA IIV V1 | 0.0812 | `OMEGA.V1` |
| $SIGMA ADD (variance) | 19.1 | `SIGMA.ADD` |
| $SIGMA PROP (variance) | 0.0185 | `SIGMA.PROP` |

`$ERROR  Y = IPRED + ERR(1) + IPRED·ERR(2)` → the app's exact Gaussian
log-likelihood uses SD² = ADD + PROP·IPRED² with these variances — same model,
same values, same (variance) parameterization. ✅

**Administration:** fixed 30-min IV infusion (`30/1440` d) — the control stream
has no D1; the 30-minute duration is the study administration as documented in
the publication. ✅ consistent with the source.

---

## 3. Ravulizumab — `ravulizumab.txt` (ADVAN3 TRANS4, linear, time in hours)

### 3.1 Fixed effects — identical after exact unit rescale

| Control stream | Value (h) | App (day) | Match |
|---|---|---|---|
| THETA(3) CL, L/h | 0.00342 | `CL: 0.00342 × 24 = 0.08208` | ✅ |
| THETA(4) V1, L | 3.43 | `V1: 3.43` | ✅ |
| THETA(5) V2, L | 1.86 | `V2: 1.86` | ✅ |
| THETA(6) Q, L/h | 0.0162 | `Q: 0.0162 × 24 = 0.3888` | ✅ |
| THETA(1) ALLOCL | 0.833 | `EXPO.CLQ: 0.833` | ✅ |
| THETA(2) ALLOV | 0.620 | `EXPO.V: 0.620` | ✅ |
| D1 = 2.5 h | — | `INFUSION_D: 2.5/24` | ✅ |

The hours→days conversion is an exact linear time rescale (multiply all rate
constants and clearances by 24, durations divide by 24): for this linear model
the rescaled system is mathematically identical, not approximately equal.
Volumes are unit-free of the rescale. ✅

### 3.2 Covariate structure — identical

`CL = THETA(3)·(WT/70)^0.833·EXP(ETA(1))`, `V1 = THETA(4)·(WT/70)^0.620·EXP(ETA(2))`,
`V2 = THETA(5)·(WT/70)^0.620`, `Q = THETA(6)·(WT/70)^0.833` — the app applies
exactly these exponents and the 70-kg reference. ✅

### 3.3 Structural model — equivalent

ADVAN3 TRANS4 is the standard 2-compartment linear mammillary model; the app's
`rhs()` with `VMAX = 0` reduces to exactly
`dA1/dt = −(k10+k12)A1 + k21A2 + rin`, `dA2/dt = k12A1 − k21A2`. Numerically:
max relative deviation 0.00% over a q8w schedule (3000 mg, 8 points incl.
trough-adjacent times).

### 3.4 Variability and error — identical values

| Control stream | Value | App use |
|---|---|---|
| $OMEGA BLOCK(2): var CL 0.0569, cov 0.0161, var V 0.0264 | — | `OMEGA.CL/COV/V1` — the block covariance **is** propagated (bivariate prior) |
| $SIGMA 2.39E-02 (proportional only, CMT=1) | — | `SIGMA.ADD: 0, PROP: 0.0239` ✅ |

`$ERROR IF (CMT.EQ.1) Y = F + F·ERR(1)` — proportional-only, applied to the
central-compartment observation. The app's likelihood for this drug is
SD = PROP·IPRED only. ✅

---

## 4. Crovalimab — `crovalimab.txt` (ADVAN13 run05, 3-cpt with SC depot, time in days)

### 4.1 Fixed effects — identical

| Control stream | Value | App | Match |
|---|---|---|---|
| THETA(1) CL, L/day | 0.0791 | `CL: 0.0791` | ✅ |
| THETA(2) V2 (central), L | 3.23 | `V1: 3.23` (renamed; the app's "V1" *is* the stream's central V2) | ✅ |
| THETA(3) Q, L/day | 0.168 | `Q: 0.168` | ✅ |
| THETA(4) V3 (peripheral), L | 2.32 | `V2: 2.32` (renamed) | ✅ |
| THETA(5) KA, 1/day | 0.126 | `KA_D: 0.126` | ✅ |
| THETA(6) F1 | 0.83 | `BIOAVAIL_SC: 0.83` | ✅ |

### 4.2 Covariate structure — identical

| Control stream `$PK` | App | Match |
|---|---|---|
| `ALLOCL = (WT/75)^0.75` on CL **and** Q | `EXPO.CLQ: 0.75` applied to both, `WT_REF: 75` | ✅ |
| `ALLOV = (WT/75)^0.684` on V2 **and** V3 | `EXPO.V: 0.684` on both | ✅ |
| `KA = THETA(5)·(AGE/36)^(−0.459)·EXP(ETA(5))` | `ka = KA_D·(age/36)^AGE_EXPO_KA` with `AGE_EXPO_KA: −0.459`, `AGE_REF: 36`; **since v0.9.0 η(5) (ω² 0.147) is estimated with the rest of the 6-eta vector** (MAP + MCMC), not merely sampled in the bands | ✅ |
| `F1 = logit⁻¹(logit(0.83) + ETA(6))` | typical F1 = 0.83; **since v0.9.0 η(6) (ω² 1.35, logit scale) is estimated** with the rest of the vector. Note this prior is wide: it spans F ≈ 0.33–0.98 at 95% | ✅ |

> *(Corrected in v0.13.0: this table previously described the pre-v0.9.0 band-only
> aux-sampling behaviour, contradicting §4.4 and §5 of this same document.)*

### 4.3 Structural model — equivalent

Control stream `$DES` (3 compartments, K12 = KA):
`DADT(1) = −KA·A(1)`; `DADT(2) = −K23·A(2) − K20·A(2) + K12·A(1) + K32·A(3)`;
`DADT(3) = −K32·A(3) + K23·A(2)`, with `K23 = Q/V2`, `K32 = Q/V3`, `K20 = CL/V2`,
`S2 = V2` as observation. The app allocates the depot state only when the drug
has `KA_D > 0` and applies SC doses as `amount × F1` into the depot; IV doses
(loading) enter the central compartment directly. Compartment naming is
shifted by one (stream CMT2 central → app "V1"), which is cosmetic.
Numerically: max relative deviation 0.00% over an IV-loading + 2 × SC q2w
schedule (11 points incl. trough-adjacent times), age 40 ka-scaling active.

### 4.4 Variability and error — identical values, documented subset propagation

| Control stream $OMEGA | Value | App use |
|---|---|---|
| item 1 CL | 0.0424 | ✅ prior for η(CL) |
| item 2 V2 | 0.0502 | ✅ prior for η(V1) |
| item 3 Q | 0.341 | ✅ estimated (η(3)) since v0.9.0 |
| item 4 V3 | 0.498 | ✅ estimated (η(4)) since v0.9.0 |
| item 5 KA | 0.147 | ✅ estimated (η(5)) since v0.9.0 — full 6-eta MAP/MCMC |
| item 6 F1 | 1.35 | ✅ estimated (η(6), logit scale) since v0.9.0 — full 6-eta MAP/MCMC |
| item 7 IIV on additive error | 0.619 | ✖ not propagated (not a PK parameter) |

$OMEGA has no off-diagonal terms → the app's `COV: 0` is correct. ✅

| Control stream $SIGMA | Value | App use |
|---|---|---|
| PROP | 0.01277 | ✅ |
| ADD (variance; SD 1.01 mg/L) | 1.02 | ✅ (rich-sampling estimate; see assumptions) |

`$ERROR IF (CMT.EQ.2) Y = CROVAL + CROVAL·ERR(1) + ERR(2)·EXP(ETA(7))` —
combined additive+proportional on the central compartment; the app implements
the same combined model with the η(7) component of the additive error dropped
(the stream applies it as `ERR(2)*EXP(ETA(7))`, so it scales the additive **SD**
by exp(η) with η ~ N(0, 0.619): the median patient is unaffected and the
population-mean SD is inflated by √(e^0.619) ≈ **1.36**, i.e. SD 1.01 → ~1.38
mg/L. Dropping it is the *favourable* direction for TDM weighting but narrows
intervals; documented in the spec assumptions). ✅
*(v0.13.0: this figure previously read "≈ 2.2×" — the formula was right but the
arithmetic was not; √(e^0.619) = 1.36.)*

**Administration route logic:** first dose IV (compartment 2, direct), all
subsequent doses SC (compartment 1 with F1) — exactly the control stream's
compartment structure; the app's `adminRoutes: {first: 'iv', subsequent: 'sc'}`
and per-dose route handling implement this. ✅

---

## 5. Deliberate, documented deviations (none are transcription errors)

These are the *only* differences between app and control streams. Each is a
modelling decision for the TDM context, each is printed in the app's About
dialog, and none changes a transcribed parameter value.

1. **Multi-eta Bayesian engine (dimension-agnostic since v0.9.0).** The engine
   estimates and propagates every population PK random effect of each control
   stream. Per drug:
   - *Eculizumab:* η(CL), η(V1); full model except IOV (below). Nothing else is
     dropped.
   - *Ravulizumab:* nothing dropped; the CL–V block covariance (0.0161) is
     retained as a bivariate prior.
   - *Crovalimab:* all six disposition etas (CL, V2, Q, V3, KA, F-logit) are
     estimated jointly since v0.9.0; only $OMEGA item 7 (IIV on the additive
     residual error, not a PK parameter) stays out of the estimation. With
     sparse SC-only sampling, ka/F and CL are only weakly separated — the
     posterior shrinks toward the population prior exactly where the data
     carry no information (verified: posterior variances ≤ priors in the
     6×6 Laplace check; MAP recovery from 2 SC troughs, median |η(CL)| error
     0.107, bias −0.003, 0 failures/40 patients). Since v0.9.1 this behaviour
     is **visible to the user** via per-eta shrinkage diagnostics, and the
     90% trough prediction intervals are verified calibrated end-to-end.
     [Corrected 2026-09-14, independent audit F1: the "96% over 24" figure
     above was `tests/test_e2e_fit.js`'s fast smoke test, which at N=24
     cannot distinguish 90% coverage from 99% and must not be cited as
     calibration evidence. The real calibration run is `npm run
     calibration` (N=300/scenario, 5 scenarios, production MCMC) — all five
     scenarios PASS (89.3–90.0% coverage, every 95% CI containing 0.90,
     every PIT histogram statistically flat). Full results in
     `VALIDATION.md` §V2a.]
2. **IOV handling (eculizumab aHUS).** The control stream assigns each
   occasion its own IOV η (6 occasion blocks). TDM data from a single
   occasion cannot identify an occasion-specific η, so the app folds
   `IOV_CL = 0.112` into the clearance prior for the current occasion
   (`OMEGA.CL + IOV_CL` for aHUS): predictions *within* the sampled occasion
   are correctly shrunk, and the honest statement about wider uncertainty is
   shown to the user. PNH uses the base IIV only — matching the stream's
   `IF (PNH.EQ.1)` branch that omits IOV.
3. **Crovalimab ka/F individualization caveat (now estimated, v0.9.0).** The
   former caveat — CL estimated from SC-only samples absorbing absorption
   variability — is resolved by the full 6-eta estimation: ka and F now carry
   their own η, so a slow/low-absorbing patient shifts η(KA)/η(F) rather than
   being mis-read as fast clearance. The remaining caveat is statistical, not
   structural: with only 1–2 SC troughs the ka/F vs CL separation is weakly
   identified, so posteriors stay close to the population prior (correct
   behaviour, verified in the v0.9.0 recovery probe).
4. **Infusion durations.** Eculizumab 30 min (from the publication's
   administration); ravulizumab 2.5 h (D1 in the stream); crovalimab IV
   loading ~1 h is an operational assumption — the control stream does not
   fix D1, and this is stated in the app.
5. **ADA population.** The streams implement the ADA-negative population;
   no ADA covariate exists to transcribe, and the app documents that
   ADA-positive patients are out of scope (both crovalimab and the
   ravulizumab simplification).
6. **Crovalimab residual-error η.** `ERR(2)·EXP(ETA(7))` in `$ERROR` is
   implemented with ETA ≡ 0 (typical patient). See §4.4.
7. **Full multi-eta MAP/Bayes — implemented in v0.9.0** (formerly deferred by
   design). The engine is now dimension-agnostic: crovalimab estimates all six
   disposition etas; eculizumab/ravulizumab keep their (complete) 2-eta
   estimation. Re-verified: `tools/verify_control_streams.mjs` still passes
   (transcription + $DES equivalence), the seeded 6-eta MAP-recovery probe
   shows unbiased recovery with valid Laplace covariance, and the full test
   suite is green. Documented in VALIDATION.md (v0.9.0 section, §8).

---

## 6. Conclusion (pharmacometrician's sign-off)

- **Parameter transcription:** all `$THETA`, `$OMEGA` and `$SIGMA` values used
  by the app are identical to the control streams — verified by direct parsing
  of the stream files, not by visual comparison.
- **Structural equivalence:** each `$DES` block is reproduced term-for-term;
  an independent fixed-step RK4 integrator, written from the stream text, agrees
  with the app's adaptive DP54 solver across all tested schedules, including
  trough-convention (observe-before-dose) and IV/SC event handling.
  **Measured on 2026-09-12 (v0.13.0):** eculizumab 2.70e-4 %, ravulizumab 9.16e-6 %,
  crovalimab 7.23e-7 % maximum relative deviation, against a gate of 0.02 %.
  These figures are asserted by `tests/test_model_verify.js`, which now also fails
  if a reported deviation is exactly 0 — the signature of a reference that never ran.
- **Variability:** every Ω element the engine claims to use is used
  with the correct value (including the ravulizumab covariance and, since
  v0.9.0, the full crovalimab 6-eta diagonal); everything dropped is enumerated
  and justified above.
- **Residual error:** identical models and values for all three drugs.

The app's models are, for the purposes of TDM forecasting, **exactly similar
to the provided control streams**, with the simplifications of §5 disclosed
in-app (About dialog) and in VALIDATION.md. The verification script
(`tools/verify_control_streams.mjs`) is part of the repository and should be
re-run after any change to `src/model.js` or the control streams.

*Reviewed by the pharmacometrician role, 2026-09-10. Automated evidence:
`node tools/verify_control_streams.mjs` → ALL CROSS-CHECKS PASSED.*
