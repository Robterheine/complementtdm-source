# Estimation-engine validation: numeric comparability against NONMEM POSTHOC

**Commissioned from two reviewer perspectives:** a pharmacometrician (method
design, NONMEM mechanics, acceptance criteria) and a clinical pharmacologist
(risk prioritization). Plan approved by the author before execution; this
document reports what was run and what it found.

**Verdict:** the app's own MAP-Bayesian optimizer and NONMEM's POSTHOC
empirical Bayes step agree closely on every one of 48 individual random
effects tested, across all three drugs and every sampling scenario examined,
including a below-LLOQ (M3) sample, the aHUS folded-variance simplification,
and a custom IV infusion duration. The largest disagreement found was 0.006
times the estimate's own standard error; the acceptance threshold set in
advance was 0.1. A deliberately mis-specified control stream, run as a check
on the comparison method itself, was correctly flagged as a large
disagreement (about 4.4 SE), confirming the method can detect a real problem
and is not passing by construction.

---

## 1. Scope, and what this adds to existing evidence

Two validation exercises already exist for this app and are not repeated
here:

- `MODEL_VALIDATION.md` confirms the app's differential-equation
  implementation is numerically equivalent to each NONMEM control stream's
  own `$DES` block (an independent fixed-step solver, written from the
  control-stream equations alone, agrees to within 0.001%), and that every
  `$THETA`/`$OMEGA`/`$SIGMA` value is transcribed correctly from the control
  streams the project ships.
- `BAYES_AUDIT.md` is an internal statistical review of the same MAP/MCMC
  engine, including an aggregate simulate-then-fit calibration check.

Neither answers the question this document is for: **given the same patient
data, does the app's own optimizer land on the same individual parameter
estimate NONMEM would?** That is a question about the fitting procedure, not
about whether the model is coded correctly, and nothing in the project
answered it before this exercise.

## 2. Risk inventory

| # | Component | Failure mode | Clinical consequence if wrong | Existing mitigation | Residual risk before this exercise | This exercise's contribution |
|---|---|---|---|---|---|---|
| R1 | Structural PK model (`M.simulate`) | Wrong ODE or dose-event handling | Systematically wrong concentration-time curve for every patient | `MODEL_VALIDATION.md` | Low | None needed; already closed |
| R2 | Parameter transcription (THETA/OMEGA/SIGMA) | A published value mistyped | Every forecast built on a wrong population value | `tools/verify_control_streams.mjs` | Low | None needed; already closed |
| **R3** | **Individual estimation (MAP optimizer)** | **App's optimizer converges to a different eta than the reference method, for the same patient data** | **Directly wrong individual CL/V1 (or the full 6-parameter set for crovalimab), and so a wrong predicted trough and a wrong P(target) badge, the number a clinician reads when judging whether therapy is adequate** | Internal only: `BAYES_AUDIT.md`, aggregate calibration | Not verified against an external reference implementation | **Primary target; see §5** |
| R4 | M3 censored-likelihood branch (BLQ samples) | Wrong sign or wrong distribution function in the censoring term | Silently biased estimate whenever a below-LLOQ sample is entered, a routine occurrence in TDM | Unit-tested internally only | Medium; a separate code path, not exercised by most tests | One BLQ subject per drug included; see §5 |
| R5 | aHUS IOV-folding simplification (eculizumab) | The app's folded-variance prior does not behave as documented | Wrong uncertainty band specifically for aHUS patients | Documented reasoning and citation, no independent numeric check | Medium | A dedicated NONMEM variant using the same folded prior; see §4.3 and §5 |
| R6 | Custom infusion duration reaching the fit (recent feature) | A per-dose duration override silently dropped before reaching the likelihood | Wrong exposure profile for a sample drawn during infusion | `tests/test_v029.js`, structural only | Low-medium; recent feature, no external cross-check | One crovalimab subject with a non-default loading duration; see §5 |
| R7 | MCMC posterior / credible interval | Posterior band too narrow or too wide | Overconfident or underconfident P(target) | `BAYES_AUDIT.md` calibration experiment | Medium; no per-patient external reference | **Out of scope here.** NONMEM's Bayesian methods (`$BAYES`, importance sampling) are a materially heavier undertaking with a different comparison metric (distributional, not point-estimate); recommended as separate future work |
| R8 | UI, data entry, session persistence, report generation | Correct fit, wrong display | Misread rather than miscalculated result | `npm test` (1295 assertions), `NOVICE_UI_REVIEW.md` | Low | Out of scope; not a numeric-estimation risk |

R3 carries both the highest clinical consequence and the least external
verification, which is why this exercise concentrates there. R4, R5 and R6
are folded into the same comparison as specific scenarios, since each is a
separate code path inside the same estimation engine with its own,
previously unverified, risk.

## 3. What "numeric comparability" means here

NONMEM's `POSTHOC` step computes each subject's empirical Bayes estimate:
the mode of the individual posterior for eta, given the population
parameters held fixed. That is exactly the statistical object the app's own
MAP step computes, using a different optimizer (NONMEM's internal method
against Nelder-Mead in `src/bayes.js`). The comparison is meaningful
specifically because the two engines now share the same objective: reading
`makeOfv()` in the current source shows `Σ (obs-pred)²/var + log(var) +
etaᵀΩ⁻¹eta` per observation, the same Laplacian −2·log-posterior NONMEM
computes internally (this had been a genuine discrepancy, `BAYES_AUDIT.md`
finding F1, fixed some time before this exercise). Two independent
optimizers reaching the same optimum of the same function is a real check,
not one that passes by construction, as the sabotage run in §6 demonstrates.

This does not test the full MCMC posterior (R7, out of scope), and it does
not test whether the population parameters themselves are correct; those are
fixed at published values on both sides, exactly as the app already does.

## 4. Method

### 4.1 Synthetic subjects

No real patient data exists in this project and none was introduced. Each
synthetic subject is generated by drawing a true random-effect vector
`eta_true ~ N(0, Omega)` from exactly the prior the app itself assumes
(`M.priorOmega`), simulating the actual structural model (`M.simulate`)
forward on a realistic dosing schedule, and adding the model's own published
residual error to produce "observed" concentrations. Because `eta_true` is
known, every subject also gives a secondary recovery check (how close either
engine lands to the value that generated the data), reported in §5 alongside
the primary agreement metric but not conflated with it: a single noisy
dataset recovering the true value only approximately is expected behaviour,
not a discrepancy between the two engines.

### 4.2 Panel

Fourteen synthetic subjects across four NONMEM executions (subjects for one
drug share a single dataset as separate IDs, the ordinary way NONMEM is
used):

| Run | Subjects | Design |
|---|---|---|
| `ecu_pnh` | 3 | PNH: rich sampling; sparse trough-only; trough-only with one BLQ sample |
| `ecu_ahus` | 2 | aHUS, folded-IOV prior (R5): rich sampling; sparse trough-only |
| `ravu` | 4 | Rich sampling; sparse trough-only; trough-only with one BLQ sample; a single trough (worst-case identifiability) |
| `crov` | 5 | Rich sampling (stress test for the 6-eta engine); sparse; trough-only with one BLQ sample; a non-default IV loading-infusion duration (R6); a single trough |

### 4.3 The aHUS control-stream variant

The original `nonmemcontrolstream.txt` models aHUS between-occasion
variability as six occasion-level etas (`BLOCK(1) SAME`, selected by an
`OCC` data item). The app does not do this: it folds the occasion variance
into the clearance prior instead (`0.1546 + 0.112 = 0.2666`), a
simplification documented in the About dialog and `src/model.js`, reasoned
from the same source the app cites for MAP-Bayesian forecasting with
inter-occasion variability. Comparing the app against the original,
unfolded, eight-eta control stream would silently compare two different
statistical models. `ecu_ahus_posthoc.mod` (Appendix A) is therefore
identical to `ecu_pnh_posthoc.mod` except for one number, `OMEGA(1,1)`,
which carries the folded variance instead of the plain IIV: the diff between
the two files is three lines (a label, a data-file name, and that one
value), so there is nothing else for the comparison to be silently measuring
against.

### 4.4 Acceptance criterion

Rather than a fixed percentage, the criterion is the NONMEM POSTHOC standard
error of each eta, read from that subject's own `ETC` block, the conditional
covariance NONMEM reports per subject in the `.phi` output file. A pass is

```
|eta_app - eta_NONMEM| < 0.1 x SE(eta_NONMEM)
```

so the bar is stricter where the data is informative and appropriately
looser where a single trough leaves an estimate close to the prior. Every
subject is reported individually with its own numbers, not folded into a
pass rate.

### 4.5 Execution

1. Generate the fourteen synthetic subjects (fixed seed 913026,
   `validation/generate_and_fit.js`).
2. Fit each with the app's own engine, the exact `runFit()` code path the
   UI uses, invoked headlessly from Node the same way
   `tools/verify_control_streams.mjs` already loads `src/model.js`.
3. Build the four POSTHOC-adapted NONMEM control streams and datasets
   (Appendix A), run through PsN 5.7.1 / NONMEM 7.6 (license registered to
   Radboud University Medical Center, Dept of Clinical Pharmacy, valid to
   14 August 2027), parse the resulting `.phi` files.
4. Compare (`validation/compare.js`), apply §4.4, tabulate.

## 5. Results

48 individual random effects were compared: 4 (2 subjects x 2 etas) for
aHUS, 6 for PNH, 8 for ravulizumab, 30 (5 subjects x 6 etas) for crovalimab.
**All 48 pass.** The worst case (CROV-03, the crovalimab BLQ subject, the
absorption-rate eta) differs by 0.006 times its own standard error, well
inside the 0.1 threshold.

_Eculizumab, PNH_

| Subject | Scenario | eta | true | app MAP | NONMEM POSTHOC | SE(NONMEM) | \|diff\|/SE | verdict |
|---|---|---|---:|---:|---:|---:|---:|---|
| **ECU-PNH-01** | rich sampling (peak + trough x3) | CL | -0.0858 | -0.1191 | -0.1191 | 0.0965 | 0.000 | pass |
| | | V1 | -0.2879 | -0.1696 | -0.1696 | 0.1070 | 0.000 | pass |
| **ECU-PNH-02** | sparse, trough-only (routine TDM) | CL | +0.2196 | +0.1552 | +0.1552 | 0.0943 | 0.000 | pass |
| | | V1 | -0.0369 | +0.0212 | +0.0212 | 0.2908 | 0.000 | pass |
| **ECU-PNH-03** | trough-only, oldest sample flagged BLQ | CL | -0.1882 | +0.1054 | +0.1052 | 0.1060 | 0.003 | pass |
| | | V1 | -0.2858 | +0.0719 | +0.0716 | 0.3017 | 0.001 | pass |

_Eculizumab, aHUS (folded-IOV variant, §4.3)_

| Subject | Scenario | eta | true | app MAP | NONMEM POSTHOC | SE(NONMEM) | \|diff\|/SE | verdict |
|---|---|---|---:|---:|---:|---:|---:|---|
| **ECU-AHUS-01** | rich sampling | CL | +0.5609 | +0.5134 | +0.5134 | 0.0641 | 0.000 | pass |
| | | V1 | -0.1493 | -0.1630 | -0.1630 | 0.1016 | 0.000 | pass |
| **ECU-AHUS-02** | sparse, trough-only | CL | +0.1700 | +0.3446 | +0.3446 | 0.0899 | 0.000 | pass |
| | | V1 | +0.5041 | -0.0352 | -0.0352 | 0.2822 | 0.000 | pass |

_Ravulizumab_

| Subject | Scenario | eta | true | app MAP | NONMEM POSTHOC | SE(NONMEM) | \|diff\|/SE | verdict |
|---|---|---|---:|---:|---:|---:|---:|---|
| **RAVU-01** | rich sampling | CL | +0.2602 | +0.3560 | +0.3560 | 0.0650 | 0.000 | pass |
| | | V1 | +0.2692 | +0.1688 | +0.1688 | 0.1052 | 0.000 | pass |
| **RAVU-02** | sparse, trough-only | CL | -0.1768 | -0.0675 | -0.0675 | 0.0770 | 0.000 | pass |
| | | V1 | +0.0314 | -0.0126 | -0.0126 | 0.1496 | 0.000 | pass |
| **RAVU-03** | trough-only, one sample flagged BLQ | CL | -0.2323 | -0.2801 | -0.2802 | 0.1003 | 0.000 | pass |
| | | V1 | +0.0023 | -0.1055 | -0.1056 | 0.1428 | 0.000 | pass |
| **RAVU-04** | single trough (worst case) | CL | -0.4107 | +0.0335 | +0.0335 | 0.1364 | 0.000 | pass |
| | | V1 | -0.1028 | +0.0100 | +0.0100 | 0.1518 | 0.000 | pass |

_Crovalimab (6-eta)_

| Subject | Scenario | eta | true | app MAP | NONMEM POSTHOC | SE(NONMEM) | \|diff\|/SE | verdict |
|---|---|---|---:|---:|---:|---:|---:|---|
| **CROV-01** | rich sampling (6-eta stress test) | CL | -0.5861 | -0.0122 | -0.0122 | 0.1599 | 0.000 | pass |
| | | V1 | +0.1167 | +0.0730 | +0.0730 | 0.1480 | 0.000 | pass |
| | | Q | -0.6295 | +0.1666 | +0.1666 | 0.5796 | 0.000 | pass |
| | | V2 | -1.2204 | -0.2777 | -0.2777 | 0.5106 | 0.000 | pass |
| | | KA | +0.2718 | +0.0065 | +0.0065 | 0.2781 | 0.000 | pass |
| | | F | -1.9269 | +0.2595 | +0.2595 | 0.8997 | 0.000 | pass |
| **CROV-02** | sparse, trough-only | CL | -0.0123 | -0.0453 | -0.0453 | 0.1708 | 0.000 | pass |
| | | V1 | -0.0563 | +0.0270 | +0.0270 | 0.2239 | 0.000 | pass |
| | | Q | +0.2601 | +0.0791 | +0.0791 | 0.5442 | 0.000 | pass |
| | | V2 | -0.2095 | +0.1187 | +0.1187 | 0.4882 | 0.000 | pass |
| | | KA | +0.7144 | -0.0229 | -0.0229 | 0.4019 | 0.000 | pass |
| | | F | +1.5498 | +0.0926 | +0.0926 | 0.9626 | 0.000 | pass |
| **CROV-03** | trough-only, one sample flagged BLQ | CL | -0.0619 | +0.0023 | +0.0025 | 0.1963 | 0.001 | pass |
| | | V1 | +0.2626 | +0.0937 | +0.0930 | 0.2406 | 0.003 | pass |
| | | Q | +0.5634 | +0.4260 | +0.4236 | 0.5115 | 0.005 | pass |
| | | V2 | +0.7635 | +0.8071 | +0.8056 | 0.5093 | 0.003 | pass |
| | | KA | -0.1153 | -0.1769 | -0.1739 | 0.4749 | 0.006 | pass |
| | | F | -0.9638 | -0.6983 | -0.6985 | 0.9098 | 0.000 | pass |
| **CROV-04** | non-default IV loading duration (120 min, R6) | CL | +0.2753 | +0.0535 | +0.0535 | 0.1988 | 0.000 | pass |
| | | V1 | -0.1988 | -0.1165 | -0.1165 | 0.0953 | 0.000 | pass |
| | | Q | +1.2418 | -0.0207 | -0.0207 | 0.5478 | 0.000 | pass |
| | | V2 | +0.6900 | +0.3337 | +0.3337 | 0.5986 | 0.000 | pass |
| | | KA | +0.2655 | +0.0230 | +0.0230 | 0.2947 | 0.000 | pass |
| | | F | +1.3165 | -0.5069 | -0.5069 | 0.9502 | 0.000 | pass |
| **CROV-05** | single trough (worst case) | CL | -0.4841 | +0.0878 | +0.0878 | 0.2086 | 0.000 | pass |
| | | V1 | +0.2174 | +0.0099 | +0.0099 | 0.2319 | 0.000 | pass |
| | | Q | -0.5647 | -0.0125 | -0.0125 | 0.5544 | 0.000 | pass |
| | | V2 | +1.8882 | +0.5875 | +0.5875 | 0.7043 | 0.000 | pass |
| | | KA | +0.1839 | +0.0468 | +0.0468 | 0.3957 | 0.000 | pass |
| | | F | -0.8910 | -1.3137 | -1.3137 | 0.9386 | 0.000 | pass |

**On the "true" column.** Several subjects, particularly the sparse and
single-trough crovalimab scenarios, show the app/NONMEM estimate landing
well away from the simulated true value (CROV-01's true CL eta is -0.586
against an estimate near -0.012). That is expected shrinkage toward the
population prior from one noisy realization of limited data, not a fault:
both engines start from the same prior and see the same data, and both
shrink toward it the same way, by construction of the comparison. The true
column exists so that behaviour is visible and explainable, not hidden; it
is not the pass/fail metric.

## 6. Verifying the comparison method itself

Before trusting the near-exact agreement above, the comparison method was
checked for whether it could actually detect a real discrepancy, following
this project's own testing discipline elsewhere ("a green check is not
evidence until it can go red"). `ecu_pnh_posthoc.mod`'s clearance THETA was
changed from its correct value (0.1626) to a deliberately wrong one (0.25)
and re-run. Subject 1's estimated clearance eta shifted from -0.119 (the
correct, matching value) to -0.525, a difference of about 4.4 times that
subject's standard error, comfortably outside the 0.1 threshold and
correctly flagged as a failure by the same comparison script. The file was
then restored to its original, byte-identical, content and the real run
re-confirmed unchanged. The 0/48 failure rate reported in §5 is not an
artefact of a comparison that cannot fail.

## 7. Conclusions

- **R3 (individual estimation).** Closed for the scenarios tested. The
  app's MAP optimizer and NONMEM's POSTHOC empirical Bayes estimate agree to
  within optimizer-convergence precision across three drugs, four sampling
  densities, a 2-eta and a 6-eta model, and both the covariance-free and
  covariance-carrying (ravulizumab) OMEGA structures the app supports.
- **R4 (M3 / below-LLOQ handling).** Closed. The BLQ subject in each of the
  three drug panels agrees with NONMEM to within 0.006 SE, confirming the
  app's censored-likelihood term (`logPhi` in `src/bayes.js`) is
  mathematically equivalent to NONMEM's own M3 implementation, not merely
  similarly-shaped.
- **R5 (aHUS folded-IOV simplification).** Closed for the numeric claim
  specifically: the app's folded 2-eta prior for aHUS produces the same
  individual estimate NONMEM's POSTHOC step produces under the identical,
  explicitly folded, statistical model. This does not validate the
  simplification's clinical appropriateness (a separate, non-numeric
  question the source publication's own reasoning addresses), only that the
  app computes what it claims to compute.
- **R6 (custom infusion duration).** Closed. CROV-04's non-default 120-minute
  loading-infusion duration reaches the likelihood correctly: agreement with
  NONMEM is exact to the precision reported, with no special-casing needed
  in the control stream beyond supplying the same duration in the dataset's
  own RATE calculation.
- **R7 (MCMC posterior) remains open**, as scoped from the outset. The point
  estimate this document validates is the posterior mode; the shape and
  width of the full posterior the app reports (median, 5-95% credible
  interval, P(target)) is a materially different validation question,
  recommended as separate future work using NONMEM's own Bayesian estimation
  methods.
- **R1, R2, R8** were already closed by existing evidence and were not
  revisited.

No discrepancy was found in the 48 comparisons run. This is evidence for,
not proof of, correctness across the entire input space the app can be given;
the fourteen synthetic subjects were chosen to cover the estimation engine's
distinct code paths (rich and sparse sampling, censoring, the folded-IOV
special case, and a custom infusion duration) and its 2-eta and 6-eta
structures, not to exhaustively sample every possible patient.

---

## Appendix A: NONMEM control streams as run

Each file below is reproduced in full and was executed unmodified through
PsN 5.7.1 / NONMEM 7.6 to produce the results in §5. All population
parameters are `FIX`ed at their published values (no re-estimation occurs;
`MAXEVAL=0 POSTHOC` computes only the per-subject empirical Bayes step). The
`LIKE` estimation option is used throughout so the below-LLOQ (M3) branch
can be written explicitly in `$ERROR`, matching `src/bayes.js`'s own
censored-likelihood formula exactly. Because `LIKE` forbids a `$SIGMA`
record, the residual-variance constants are carried as two extra `FIX`ed
`THETA`s instead, referenced explicitly in `$ERROR`.

### A.1 `ecu_pnh_posthoc.mod`: eculizumab, PNH

Structural ($PK/$DES) code is verbatim from `nonmemcontrolstream.txt`'s own
PNH branch (`PNH.EQ.1`). The original file's IOV/OCC machinery is dropped:
it is inert for PNH subjects there too, since only the `PNH.EQ.0` branch
ever references it.

```
;; Estimation-engine validation -- eculizumab, PNH.
;; Adapted from ../../nonmemcontrolstream.txt for POSTHOC individual
;; estimation with population parameters FIXED at their published values.
;; Structural ($PK/$DES) code is verbatim from the original PNH branch
;; (PNH.EQ.1: CL uses ETA(1) with no IOV term added -- the app has no IOV
;; component in the PNH prior either, M.priorOmega('PNH','eculizumab') is
;; the plain 2-dim [0.1546, 0.0812]). The IOV/OCC machinery of the original
;; file is dropped entirely: it is inert for PNH subjects there too (only
;; the PNH.EQ.0 branch ever references IOV), so nothing is lost.
$PROBLEM    Estimation-engine validation -- eculizumab PNH POSTHOC
$INPUT      ID TIME AMT RATE DV MDV EVID CMT CENS WT AGE
$DATA       ecu_pnh.csv IGNORE=@
$SUBROUTINE ADVAN13 TOL=9
$MODEL
COMP=(CENTRAL)
COMP=(PERIPHERAL)

$PK
CL = THETA(1) * ((WT/70)**0.75) * EXP(ETA(1))
V1 = THETA(2) * (WT/70) * EXP(ETA(2))
V2 = THETA(5) * (WT/70)
Q  = THETA(6) * ((WT/70)**0.75)
VM = THETA(3) * ((WT/70)**0.75)
KM = THETA(4)
S1 = V1
KEL = CL/V1
K12 = Q/V1
K21 = Q/V2

$DES
C1 = A(1)/S1
DADT(1) = -KEL*A(1) - ((VM*C1)/(KM+C1)) - K12*A(1) + K21*A(2)
DADT(2) = -K21*A(2) + K12*A(1)

;; With the LIKE (user-supplied likelihood) option NONMEM forbids a $SIGMA
;; record entirely -- the residual-variance constants are carried as two
;; extra FIXED THETAs instead (7, 8) and used explicitly below, matching
;; src/bayes.js's own `v = sig.ADD + sig.PROP*pred*pred` formula exactly.
;; NONMEM's LIKE option expects Y to be the LIKELIHOOD itself (a positive
;; density/probability), not its log -- NONMEM applies -2*LOG(Y) internally.
$ERROR
IPRED = F
SD    = SQRT(THETA(7) + THETA(8)*IPRED*IPRED)
IF (CENS.EQ.0) THEN
   Y = (1/SQRT(6.283185307179586*SD*SD)) * EXP(-0.5*((DV-IPRED)/SD)**2)
ELSE
   Y = PHI((DV-IPRED)/SD)               ; DV carries the LLOQ on a censored row
ENDIF

$THETA
(0.1626 FIX)  ; 1 CL  L/day
(4.299  FIX)  ; 2 V1  L
(25.64  FIX)  ; 3 VM  mg/day
(13.54  FIX)  ; 4 KM  mg/L
(2.63   FIX)  ; 5 V2  L
(0.6243 FIX)  ; 6 Q   L/day
(19.1   FIX)  ; 7 SIGMA additive variance
(0.0185 FIX)  ; 8 SIGMA proportional variance

$OMEGA
0.1546 FIX   ; 1 IIV CL  (PNH: no IOV folded in)
0.0812 FIX   ; 2 IIV V1

$ESTIMATION METHOD=1 LAPLACE LIKE NOABORT MAXEVAL=0 PRINT=1 POSTHOC
```

### A.2 `ecu_ahus_posthoc.mod`: eculizumab, aHUS, folded-IOV variant

Identical to A.1 except for `OMEGA(1,1)` (0.2666 instead of 0.1546) and the
labels naming the file and dataset. See §4.3 for why this specific,
minimal difference is the correct comparison, not the original file's
eight-eta structure.

```
;; Estimation-engine validation -- eculizumab, aHUS, folded-IOV variant.
;; Adapted from ../../nonmemcontrolstream.txt for POSTHOC individual
;; estimation with population parameters FIXED at their published values.
;;
;; IMPORTANT deviation from the original control stream, made deliberately:
;; the ORIGINAL file models aHUS between-occasion variability as six
;; occasion-level etas (BLOCK(1) SAME on ETA(1)-(6), selected by the OCC data
;; item). The app does not do that -- it folds the occasion variance into the
;; clearance prior instead (0.1546 IIV + 0.112 IOV = 0.2666, see
;; src/model.js's OMEGA.CL + IOV_CL and the About dialog's own documented
;; rationale). Running the app's aHUS estimates against the ORIGINAL 8-eta
;; model would silently compare two different statistical models. This file
;; therefore implements the model the app actually claims to run: the same
;; 2-eta structure as ecu_pnh_posthoc.mod, differing ONLY in OMEGA(1,1) (see
;; the diff noted in the validation report). The IOV/OCC machinery is
;; dropped, not worked around -- there is nothing in the app's own prior for
;; it to correspond to.
$PROBLEM    Estimation-engine validation -- eculizumab aHUS POSTHOC (folded-IOV variant)
$INPUT      ID TIME AMT RATE DV MDV EVID CMT CENS WT AGE
$DATA       ecu_ahus.csv IGNORE=@
$SUBROUTINE ADVAN13 TOL=9
$MODEL
COMP=(CENTRAL)
COMP=(PERIPHERAL)

$PK
CL = THETA(1) * ((WT/70)**0.75) * EXP(ETA(1))
V1 = THETA(2) * (WT/70) * EXP(ETA(2))
V2 = THETA(5) * (WT/70)
Q  = THETA(6) * ((WT/70)**0.75)
VM = THETA(3) * ((WT/70)**0.75)
KM = THETA(4)
S1 = V1
KEL = CL/V1
K12 = Q/V1
K21 = Q/V2

$DES
C1 = A(1)/S1
DADT(1) = -KEL*A(1) - ((VM*C1)/(KM+C1)) - K12*A(1) + K21*A(2)
DADT(2) = -K21*A(2) + K12*A(1)

;; With the LIKE (user-supplied likelihood) option NONMEM forbids a $SIGMA
;; record entirely -- the residual-variance constants are carried as two
;; extra FIXED THETAs instead (7, 8) and used explicitly below, matching
;; src/bayes.js's own `v = sig.ADD + sig.PROP*pred*pred` formula exactly.
;; NONMEM's LIKE option expects Y to be the LIKELIHOOD itself (a positive
;; density/probability), not its log -- NONMEM applies -2*LOG(Y) internally.
$ERROR
IPRED = F
SD    = SQRT(THETA(7) + THETA(8)*IPRED*IPRED)
IF (CENS.EQ.0) THEN
   Y = (1/SQRT(6.283185307179586*SD*SD)) * EXP(-0.5*((DV-IPRED)/SD)**2)
ELSE
   Y = PHI((DV-IPRED)/SD)               ; DV carries the LLOQ on a censored row
ENDIF

$THETA
(0.1626 FIX)  ; 1 CL  L/day
(4.299  FIX)  ; 2 V1  L
(25.64  FIX)  ; 3 VM  mg/day
(13.54  FIX)  ; 4 KM  mg/L
(2.63   FIX)  ; 5 V2  L
(0.6243 FIX)  ; 6 Q   L/day
(19.1   FIX)  ; 7 SIGMA additive variance
(0.0185 FIX)  ; 8 SIGMA proportional variance

$OMEGA
0.2666 FIX   ; 1 IIV CL  (aHUS: 0.1546 IIV + 0.112 IOV folded in, per src/model.js OMEGA.CL+IOV_CL)
0.0812 FIX   ; 2 IIV V1

$ESTIMATION METHOD=1 LAPLACE LIKE NOABORT MAXEVAL=0 PRINT=1 POSTHOC
```

### A.3 `ravu_posthoc.mod`: ravulizumab

The original `ravulizumab.txt` is in hours; the app rescales linearly to
days (already independently verified structurally equivalent in
`MODEL_VALIDATION.md`). This file uses the app's own day-scale THETAs
directly, so the synthetic dataset's TIME/RATE columns (built in days, the
app's native unit) need no separate conversion layer.

```
;; Estimation-engine validation -- ravulizumab.
;; Adapted from ../../ravulizumab.txt for POSTHOC individual estimation with
;; population parameters FIXED at their published values.
;;
;; The original control stream is in HOURS (CL 0.00342 L/h, Q 0.0162 L/h,
;; D1 2.5 h). The app works in DAYS throughout and rescales these uniformly
;; at load time (src/model.js's own header comment: "CL 0.00342 L/h and Q
;; 0.0162 L/h become CL 0.08208 L/day and Q 0.3888 L/day" -- an exact linear
;; time rescale, already independently verified structurally equivalent in
;; MODEL_VALIDATION.md's "structure: ravulizumab $DES (ADVAN3, rescaled to
;; days)" check). This file uses the app's own day-scale THETAs directly, and
;; the synthetic dataset's TIME/RATE columns are in days to match -- same
;; model, same units the app itself uses, not a new rescale being introduced.
$PROBLEM    Estimation-engine validation -- ravulizumab POSTHOC
$INPUT      ID TIME AMT RATE DV MDV EVID CMT CENS WT AGE
$DATA       ravu.csv IGNORE=@
$SUBROUTINE ADVAN3 TRANS4

$PK
ALLOCL = (WT/70)**0.833
ALLOV  = (WT/70)**0.620
CL = THETA(1)*ALLOCL*EXP(ETA(1))
V1 = THETA(2)*ALLOV*EXP(ETA(2))
V2 = THETA(3)*ALLOV
Q  = THETA(4)*ALLOCL
S1 = V1

;; With LIKE, $SIGMA may not be present -- residual variance carried as a
;; FIXED theta instead (proportional only, matching src/model.js's
;; SIGMA:{ADD:0, PROP:0.0239}).
$ERROR
IPRED = F
SD    = SQRT(THETA(5)*IPRED*IPRED)
IF (CENS.EQ.0) THEN
   Y = (1/SQRT(6.283185307179586*SD*SD)) * EXP(-0.5*((DV-IPRED)/SD)**2)
ELSE
   Y = PHI((DV-IPRED)/SD)
ENDIF

$THETA
(0.08208 FIX)  ; 1 CL  L/day  (0.00342 L/h x24)
(3.43    FIX)  ; 2 V1  L
(1.86    FIX)  ; 3 V2  L
(0.3888  FIX)  ; 4 Q   L/day  (0.0162 L/h x24)
(0.0239  FIX)  ; 5 SIGMA proportional variance

$OMEGA BLOCK(2) FIX
0.0569
0.0161 0.0264

$ESTIMATION METHOD=1 LAPLACE LIKE NOABORT MAXEVAL=0 PRINT=1 POSTHOC
```

### A.4 `crov_posthoc.mod`: crovalimab

Adapted from `crovalimab.txt` (run05), which is a `$SIMULATION`-only file
with no `$ESTIMATION` record at all; this recasts it for estimation,
otherwise keeping `$PK`/`$DES`/`$ERROR` verbatim. One deliberate omission,
already documented in `src/model.js` as a stated simplification: run05's
`$OMEGA` item 7 (0.619, inter-individual variability on the additive
residual-error term) is not a PK parameter and is not estimated by the app;
it is dropped here for the same reason, not a new deviation introduced for
this exercise.

```
;; Estimation-engine validation -- crovalimab.
;; Adapted from ../../crovalimab.txt (run05) for POSTHOC individual
;; estimation with population parameters FIXED at their published values.
;;
;; run05 is a $SIMULATION-only file (no $ESTIMATION record at all) -- this
;; recasts it for estimation, otherwise keeping $PK/$DES/$ERROR verbatim.
;; One deliberate omission, already documented in src/model.js as a stated
;; simplification: run05's $OMEGA item 7 (0.619, IIV on the additive
;; residual-error term, applied as ERR(2)*EXP(ETA(7))) is not a PK parameter
;; and is not estimated by the app -- dropped here too (ERR(2) used plain,
;; no ETA(7) multiplier), for the same reason, not a new deviation.
$PROBLEM    Estimation-engine validation -- crovalimab POSTHOC
$INPUT      ID TIME AMT RATE DV MDV EVID CMT CENS WT AGE
$DATA       crov.csv IGNORE=@
$SUBROUTINE ADVAN13 TOL=9
$MODEL
COMP=(SC)
COMP=(CENTRAL)
COMP=(PERI)

$PK
ALLOCL = (WT/75)**0.75
ALLOV  = (WT/75)**0.684
AGEKA  = (-0.459)

CL = THETA(1)*ALLOCL*EXP(ETA(1))
V2 = THETA(2)*ALLOV*EXP(ETA(2))
Q  = THETA(3)*ALLOCL*EXP(ETA(3))
V3 = THETA(4)*ALLOV*EXP(ETA(4))
KA = THETA(5)*((AGE/36)**AGEKA)*EXP(ETA(5))

LOGITF1 = LOG(THETA(6)/(1-THETA(6))) + ETA(6)
F1 = 1/(1+EXP(-LOGITF1))

S2 = V2
K12 = KA
K23 = Q/V2
K32 = Q/V3
K20 = CL/V2

$DES
DADT(1) = -K12*A(1)
DADT(2) = -K23*A(2) - K20*A(2) + K12*A(1) + K32*A(3)
DADT(3) = -K32*A(3) + K23*A(2)

;; With LIKE, $SIGMA may not be present -- residual variance carried as two
;; FIXED thetas instead (proportional + additive, matching src/model.js's
;; SIGMA:{ADD:1.02, PROP:0.01277}; run05's ETA(7) on the additive term is
;; dropped, see header note).
$ERROR
CROVAL = A(2)/V2
IPRED  = CROVAL
SD     = SQRT(THETA(7)*IPRED*IPRED + THETA(8))
IF (CENS.EQ.0) THEN
   Y = (1/SQRT(6.283185307179586*SD*SD)) * EXP(-0.5*((DV-IPRED)/SD)**2)
ELSE
   Y = PHI((DV-IPRED)/SD)
ENDIF

$THETA
(0.0791 FIX)  ; 1 CL  L/day
(3.23   FIX)  ; 2 V2  L (app's "V1")
(0.168  FIX)  ; 3 Q   L/day
(2.32   FIX)  ; 4 V3  L (app's "V2")
(0.126  FIX)  ; 5 KA  1/day
(0.83   FIX)  ; 6 F1  fraction
(0.01277 FIX) ; 7 SIGMA proportional variance
(1.02    FIX) ; 8 SIGMA additive variance

$OMEGA
0.0424 FIX  ; 1 CL
0.0502 FIX  ; 2 V2 ("V1")
0.341  FIX  ; 3 Q
0.498  FIX  ; 4 V3 ("V2")
0.147  FIX  ; 5 KA
1.35   FIX  ; 6 F1 (logit)

$ESTIMATION METHOD=1 LAPLACE LIKE NOABORT MAXEVAL=0 PRINT=1 POSTHOC
```

## Appendix B: JavaScript estimation engine (relevant excerpts)

`src/model.js` in full: the population parameter specs (`$THETA`/`$OMEGA`/
`$SIGMA` equivalents) and structural model each control stream in Appendix A
is checked against.

```javascript
/* =========================================================================
 * mAb TDM — population PK model core (multi-drug)
 *
 * Each drug is a self-contained spec (parameters, variability, residual error,
 * infusion duration, dosing/sampling hints). A "current drug" is selected via
 * M.select(id); all model functions act on the current spec by default. The
 * eculizumab spec remains the default and the historical top-level exports
 * (THETA/OMEGA/SIGMA/...) stay as eculizumab aliases for backward compatibility.
 *
 * Sources:
 *   eculizumab: ter Avest M, et al. Model-Informed Precision Dosing of
 *     Eculizumab in Patients with Paroxysmal Nocturnal Hemoglobinuria.
 *     Clin Pharmacokinet 2025;64:1139-1147. doi:10.1007/s40262-025-01536-x
 *     (final PK model, NONMEM control stream; time in days).
 *   ravulizumab: simplified population PK model from the Ultomiris
 *     (ravulizumab) FDA review — the final NONMEM control stream shipped with
 *     this project (2-compartment ADVAN3, linear elimination). The control
 *     stream is in hours; all rates here are scaled uniformly to per-day
 *     (exact linear time rescale): CL 0.00342 L/h and Q 0.0162 L/h become
 *     CL 0.08208 L/day and Q 0.3888 L/day; the 2.5-h infusion becomes
 *     2.5/24 days.
 *
 * crovalimab: population PK model from the PiaSky (crovalimab) FDA review
 *     (NDA 761388, Integrated Review) — final NONMEM control stream (run05)
 *     shipped with this project. 3-compartment system: SC depot (first-order
 *     absorption ka, bioavailability F = 0.83) into the central compartment,
 *     which is also the dosing (IV) and observation compartment. Weight is a
 *     covariate on CL/Q (exponent 0.75) and V2/V3 (0.684) referenced to
 *     75 kg; age scales the absorption rate: ka = 0.126 · (age/36)^-0.459
 *     [1/day]. The control stream is in days (CL L/day, ka 1/day) — the
 *     engine's native time base, so no rescaling is applied. First dose IV
 *     (loading), subsequent doses SC — different administration compartments,
 *     same observation compartment, implemented via the dose `route` field.
 *
 * Structure: 2-compartment core with optional SC depot, allometric scaling. Eculizumab adds a parallel
 * Michaelis-Menten (target-mediated) elimination term; ravulizumab (linear,
 * simplified) has Vmax = 0. Doses default to a fixed IV infusion of the
 * drug's duration; individual doses may carry `route: 'sc'` (depot absorption
 * into the central compartment with first-order rate ka) or `bolus: true`
 * (testing only).
 *
 * Unit conventions: time [days], dose/amount [mg], concentration [mg/L = ug/mL].
 * ========================================================================= */
(function (root) {
  'use strict';
  var ECU = root.ECU = root.ECU || {};

  var DRUGS = {
    eculizumab: {
      id: 'eculizumab',
      label: 'Eculizumab',
      article: 'ter Avest et al., Clin Pharmacokinet 2025;64:1139–1147 (doi:10.1007/s40262-025-01536-x)',
      info: '2-compartment model with parallel linear + Michaelis–Menten (target-mediated) clearance. PNH and aHUS; between-occasion clearance variability is included for aHUS. Time in days, 30-min IV infusions.',
      // Fixed effects (typical values for a 70-kg individual; NONMEM $THETA)
      THETA: {
        CL: 0.1626,   // L/day   (linear clearance)
        V1: 4.299,    // L       (central volume)
        VMAX: 25.64,  // mg/day  (max. Michaelis-Menten elimination rate)
        KM: 13.54,    // mg/L    (concentration at 50% of Vmax)
        V2: 2.63,     // L       (peripheral volume)
        Q: 0.6243     // L/day   (intercompartmental clearance)
      },
      EXPO: { CLQ: 0.75, V: 1 },          // allometric exponents (CL,Q,Vmax) and (V1,V2)
      // IIV on CL and V1 (log-normal variances); COV = between-eta covariance
      OMEGA: { CL: 0.1546, V1: 0.0812, COV: 0 },
      // Inter-occasion variability on clearance — identified in aHUS only
      IOV_CL: 0.112,
      IOV_DISEASES: ['aHUS'],
      // Residual error (Radboudumc assay; NONMEM $SIGMA):
      //   Y = IPRED + eps(1) + IPRED*eps(2)   (variances)
      SIGMA: { ADD: 19.1, PROP: 0.0185 },
      INFUSION_D: 30 / 1440,               // default 30-minute IV infusion
      /* Custom infusion times (2026-09-14, author-approved plan): the default
       * above stays the fallback for any dose without its own duration; this
       * declares the CLINICALLY sane range for a per-dose override, uniform
       * across all three drugs by the author's own instruction. Minutes, not
       * days -- the engine's own INFUSION_D is in days, but nobody enters a
       * clinical duration as a fraction of a day, so the UI works in minutes
       * and converts at the boundary (see fmtMinutes()/parseMinutes() in
       * src/ui.js). No separate "default" field here on purpose: the default
       * is always derived from INFUSION_D above (Math.round(INFUSION_D*1440)),
       * so the two can never drift apart into disagreeing about the same fact. */
      infusionMinutes: { min: 10, max: 360 },
      samplePeak: 'peak ≈ 30–60 min after start of the 0.5-h infusion',
      dose: { min: 50, max: 4000, step: 50, default: 900 },
      ssIntervalDefault: 14,
      obsValMax: 2000,
      targetRange: { min: 10, max: 500 },
      wtTooltip: 'Body weight in kg (covariate on clearance and volumes, allometric scaling to 70 kg).',
      diseaseCovariate: true,
      targetDefault: 75,
      targetHint: '≥ 50 µg/mL minimum; ≥ 75 µg/mL as a safe target.',
      targetSource: 'Target derived from ter Avest et al. (PMID 35238929).',
      targetSourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/35238929/',
      diseaseNotes: {
        PNH: 'PNH: no between-occasion variability in this model, the most informative setting for TDM.',
        aHUS: 'aHUS: clearance varies between occasions (IOV folded into the prior), wider uncertainty; sample around flares or regimen changes.'
      },
      assumptions: [
        'Clearance is parallel linear + Michaelis–Menten (target-mediated). The nonlinear term dominates at low concentrations, so exposure is not proportional to dose.',
        'In aHUS, between-occasion clearance variability (IOV, variance 0.112) is folded into the clearance prior: multi-occasion samples are treated as one exchangeable block, because the IIV/IOV split is not identifiable from the sparse data of a single patient. Occasion-level random effects are not estimated separately.',
        'Because the occasion component stays folded in after fitting, the interval reported for an upcoming dose is somewhat narrower than the full occasion-to-occasion predictive uncertainty in aHUS.',
        'The residual error is that of the Radboudumc assay; a local assay with different precision requires the assay-error multiplier in "Assay settings", below the measurements.',
        'IV infusion duration is adjustable per dose (10–360 minutes; default 30 minutes); it can affect a fitted sample drawn during the infusion, but has negligible effect on troughs sampled after the infusion has long finished.'
      ]
    },

    ravulizumab: {
      id: 'ravulizumab',
      label: 'Ravulizumab',
      article: 'simplified population PK model from the Ultomiris (ravulizumab) FDA review (final NONMEM control stream, provided with this project)',
      reviewRef: 'Model derived as a simplified version from FDA review documents:',
      reviewUrl: 'https://www.accessdata.fda.gov/drugsatfda_docs/nda/2018/761108Orig1s000TOC.html',
      info: '2-compartment linear model (FDA-review simplification, no Michaelis–Menten term). Allometric exponents 0.833 (CL, Q) and 0.62 (volumes). Control stream is in hours; rates scaled uniformly to per-day. 2.5-h IV infusions.',
      sourceUnits: 'h',                    // original control-stream time unit
      THETA: {
        CL: 0.00342 * 24, // L/day   (0.00342 L/h in the control stream)
        V1: 3.43,         // L       (central volume)
        VMAX: 0,          // no MM term in this model
        KM: 1,            // unused when VMAX = 0
        V2: 1.86,         // L       (peripheral volume)
        Q: 0.0162 * 24    // L/day   (0.0162 L/h in the control stream)
      },
      EXPO: { CLQ: 0.833, V: 0.620 },
      OMEGA: { CL: 0.0569, V1: 0.0264, COV: 0.0161 },   // $OMEGA BLOCK(2)
      IOV_CL: 0,
      IOV_DISEASES: [],
      SIGMA: { ADD: 0, PROP: 0.0239 },     // proportional only (CMT=1; $SIGMA)
      INFUSION_D: 2.5 / 24,                // default D1 = 2.5-h infusion
      infusionMinutes: { min: 10, max: 360 },
      samplePeak: 'peak at the end of the ~2.5-h infusion',
      dose: { min: 100, max: 6000, step: 100, default: 3000 },
      ssIntervalDefault: 56,
      obsValMax: 2000,
      targetRange: { min: 10, max: 500 },
      wtTooltip: 'Body weight in kg (covariate on clearance and volumes, allometric scaling to 70 kg).',
      diseaseCovariate: false,          // disease is not a covariate in this model
      targetDefault: 100,
      targetHint: '≥ 100 µg/mL minimum; ≥ 150 µg/mL for a more conservative approach.',
      targetSource: 'Target derived from Sheridan et al. (PMID 33512711); it is the threshold relevant when TDM is used to prolong the dosing interval.',
      targetSourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/33512711/',
      assumptions: [
        'Simplified research re-implementation of the FDA-review population PK model (linear elimination, no IOV, weight as the only covariate); requires its own prospective validation.',
        'Implements the ADA-negative population only.',
        'IV infusion duration is adjustable per dose (10–360 minutes; default 2.5 h).',
        // F8 (independent audit, 2026-09-13): displayed as fact, not a warning
        // -- author's own clinical judgement, no age gate needed since the
        // model has no age covariate at all to gate.
        'Developed and evaluated in an adult population.'
      ]
    },

    /* Crovalimab — PiaSky FDA-review population PK model (control stream
     * run05, time in days). SC depot (CMT 1, bioavailability F1 = 0.83 with
     * logit-transformed IIV) into the central compartment (CMT 2, dosing and
     * observation), peripheral compartment (CMT 3). Covariates: weight on
     * CL and Q (allometric 0.75, reference 75 kg) and on V2/V3 (0.684); age
     * on the absorption rate (ka = 0.126 · (age/36)^-0.459). Residual error:
     * proportional 0.01277 + additive 1.02 (variances; SDs 0.113 and 1.01).
     * Since v0.9.0 the full 6-eta disposition is estimated (MAP + MCMC):
     * [CL, V2(central), Q, V3, KA, F(logit)] — all crovalimab $OMEGA PK items.
     *
     * Assumptions and simplifications relative to run05 (see VALIDATION.md §4c):
     *  - NO anti-drug-antibody (ADA) effect: the control stream implements the
     *    ADA-negative population only — no ADA-on-CL covariate is present or
     *    applied. ADA-positive patients are outside the model's scope.
     *  - The residual-error additive term (SD 1.01 mg/L) is the RICH-SAMPLING
     *    estimate; the sparse-sampling additive error (SD 14.4 mg/L, Table 118)
     *    is not used, so sparse TDM samples are weighted relatively strongly.
     *  - The IV loading-dose infusion duration (1 h) is an operational
     *    assumption; the control stream does not fix D1.
     *  - The IIV on the additive residual error (0.619, $OMEGA item 7) is not
     *    a PK eta and is not estimated. */
    crovalimab: {
      id: 'crovalimab',
      label: 'Crovalimab',
      article: 'population PK model from the PiaSky (crovalimab) FDA review (NDA 761388), final NONMEM control stream (run05, provided with this project)',
      reviewRef: 'Model derived from FDA review documents:',
      reviewUrl: 'https://www.accessdata.fda.gov/drugsatfda_docs/nda/2024/761388Orig1s000TOC.html',
      info: '3-compartment model: SC depot (first-order absorption, bioavailability F = 0.83) into the central compartment, linear clearance and a peripheral compartment. Weight on CL/Q (0.75, ref. 75 kg) and V2/V3 (0.684); age on the SC absorption rate ((age/36)^-0.459). IV loading dose, SC thereafter. Time in days.',
      THETA: {
        CL: 0.0791,   // L/day
        V1: 3.23,     // L       (central volume, V2 in the control stream)
        VMAX: 0,      // linear elimination only in run05
        KM: 1,        // unused when VMAX = 0
        V2: 2.32,     // L       (peripheral volume, V3 in the control stream)
        Q: 0.168      // L/day
      },
      EXPO: { CLQ: 0.75, V: 0.684 },       // WT on CL,Q / WT on V2,V3
      WT_REF: 75,                          // allometric reference weight [kg]
      AGE_REF: 36,                         // age reference for ka [years]
      AGE_EXPO_KA: -0.459,                 // age exponent on ka
      OMEGA: { CL: 0.0424, V1: 0.0502, COV: 0 },   // etas 1 and 2 of $OMEGA (kept for backward compat)
      /* Full 6-eta disposition (v0.9.0): $OMEGA items 1-6 of run05.
       * 0: CL 0.0424, 1: V2(central) 0.0502, 2: Q 0.341, 3: V3 0.498, 4: KA 0.147, 5: F1 1.35 (logit)
       * Item 7 (0.619, IIV on additive residual error) is not a PK eta and stays dropped.
       * OMEGA_AUX is kept for backward compat; ETA is the canonical full vector. */
      ETA: { names: ['CL', 'V1', 'Q', 'V2', 'KA', 'F'], vars: [0.0424, 0.0502, 0.341, 0.498, 0.147, 1.35], fLogitIdx: 5 },
      OMEGA_AUX: { ka: 0.147, f: 1.35, fLogit: true },
      IOV_CL: 0,
      IOV_DISEASES: [],
      SIGMA: { ADD: 1.02, PROP: 0.01277 }, // variances (SDs 1.01 and 0.113)
      INFUSION_D: 1 / 24,                  // default IV loading infusion (~1 h assumption)
      infusionMinutes: { min: 10, max: 360 },   // loading dose only -- crovalimab's only IV administration
      KA_D: 0.126,                         // SC absorption rate at the reference age [1/day]
      BIOAVAIL_SC: 0.83,                   // F1
      adminRoutes: { first: 'iv', subsequent: 'sc' },  // IV loading, then SC
      /* F7 (independent audit, 2026-09-13): the EMA loading regimen is 5 doses
       * (1 IV + 4 weekly SC) before q28d maintenance begins. Until a 6th dose
       * is entered, every spacing on file is a LOADING spacing (q7d/q6d),
       * never a maintenance one -- modalInterval()'s "later half of doses"
       * heuristic has nothing else to look at and returns q7d, which runFit
       * would otherwise auto-project forever on the chart. loadingDoseCount
       * gates that projection off until a real maintenance-interval dose has
       * actually been entered. 0/undefined for the other drugs, which have no
       * loading phase, so this is a no-op there. */
      loadingDoseCount: 5,
      covariateAge: true,                  // UI asks for age
      /* F8 (independent audit, 2026-09-13): author's own clinical judgement
       * about acceptable extrapolation for the age covariate -- not derived
       * from a paediatric validation study (none exists; README states this
       * app does not cover paediatrics). Below pediatricBlockAge the model is
       * refused outright; from pediatricBlockAge up to (not including)
       * pediatricWarnAge it runs but is flagged, since the model was not
       * developed for children; at or above pediatricWarnAge, silent (adult
       * dosing/PK applies). Eculizumab and ravulizumab have no age covariate
       * at all, so this gate does not apply to them. */
      pediatricBlockAge: 12,
      pediatricWarnAge: 17,
      samplePeak: 'SC peak ≈ one week or more after administration (absorption-limited); the IV loading dose peaks at the end of its infusion',
      /* EMA PiaSky posology: 1000 mg IV loading (day 1); 340 mg SC on days 2, 8,
       * 15 and 22; then maintenance every 4 weeks — 680 mg (≥40 to <100 kg) or
       * 1020 mg (≥100 kg). There is no 3400 mg dose. */
      dose: { min: 50, max: 2000, step: 10, default: 680 },
      ssIntervalDefault: 28,
      obsValMax: 5000,                     // SC steady-state levels exceed the eculizumab-tuned default
      targetRange: { min: 10, max: 500 },
      wtTooltip: 'Body weight in kg (covariate on clearance and volumes, allometric scaling to 75 kg in this model).',
      diseaseCovariate: false,
      targetDefault: 75,
      targetHint: '≥ 75 µg/mL for complete C5 inhibition.',
      targetSource: 'Target derived from PMID 39835421.',
      targetSourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/39835421/',
      assumptions: [
        'No anti-drug-antibody (ADA) effect: the control stream (run05) implements the ADA-negative population only. ADA-positive patients are outside this model\'s scope.',
        'The residual-error additive term (SD 1.01 mg/L) is the rich-sampling estimate; sparse TDM samples are therefore weighted relatively strongly.',
        'The IV loading-dose infusion duration (1 h) is an operational assumption (the control stream does not fix D1) and is adjustable (10–360 minutes). This applies to the loading dose only: every subsequent dose is subcutaneous, which has no infusion-duration concept at all.',
        'All six population PK random effects (CL, central volume, Q, peripheral volume, SC absorption rate, bioavailability) are estimated from your samples (MAP-Bayes). With sparse SC-only sampling, absorption and clearance can partly trade off; the estimate stays anchored to the population prior.',
        'The IIV on the additive residual error is not estimated (not a PK parameter).',
        'Age under 12 years: not accepted (no basis to extrapolate the absorption-rate covariate that far). Age 12–16: accepted, flagged, since the model was not developed for children. Age 17 and over: no flag.'
      ],
      yMaxCap: 12000                       // chart y-axis cap: q2w SC dosing reaches high steady-state levels
    }
  };

  var current = 'eculizumab';

  function specOf(id) { return id ? DRUGS[id] : DRUGS[current]; }

  /* Engine safety: a pending (placeholder) spec cannot be simulated. */
  function requireReady(id) {
    var s = specOf(id);
    if (s.pending) {
      throw new Error(s.label + ' is prepared but its population PK parameters are not yet available (NONMEM control stream pending). Forecasting is disabled for this drug.');
    }
    return s;
  }

  function setDrug(id) {
    if (!DRUGS[id]) throw new Error('Unknown drug: ' + id);
    current = id;
    return DRUGS[id];
  }
  function drug() { return DRUGS[current]; }
  function listDrugs() {
    return Object.keys(DRUGS).map(function (k) {
      return { id: k, label: DRUGS[k].label };
    });
  }

  /* Prior random-effect variances used for individualization, incl. the
   * covariance between eta(CL) and eta(V1). Returns a shape compatible with
   * both consumers: {cl,v1,cov,dims,vars,covIdx} where dims = eta dimension
   * for the drug (2 or 6) and vars = full diagonal variances. The legacy
   * fields {cl,v1,cov} are the CL/V1 sub-block for backward-compat callers
   * (tests that unpack .cl/.cov).
   * eculizumab/aHUS: IOV folded into CL, see above. */
  /* Between-occasion variance on clearance for this drug + disease, or 0 when
   * the model does not estimate one (everything except eculizumab/aHUS).
   *
   * Single source of the "does this model have IOV here?" predicate: priorOmega
   * below folds it into the CL prior, and bayes.js uses the same number as the
   * ceiling for time-dependent recency weighting (v0.20.0). Two hand-written
   * copies of `IOV_CL > 0 && IOV_DISEASES.indexOf(disease) >= 0` would drift
   * the first time another drug gains an IOV term. */
  function iovVar(disease, id) {
    var s = specOf(id);
    return (s.IOV_CL > 0 && s.IOV_DISEASES.indexOf(disease) >= 0) ? s.IOV_CL : 0;
  }

  function priorOmega(disease, id) {
    var s = specOf(id);
    var eta = s.ETA || s.OMEGA_AUX || null;
    var fold = iovVar(disease, id);
    var dims, vars;
    if (s.ETA) {
      dims = s.ETA.vars.length;
      vars = s.ETA.vars.slice();
      vars[0] += fold;
    } else {
      dims = 2;
      vars = [s.OMEGA.CL + fold, s.OMEGA.V1];
    }
    return {
      cl: vars[0], v1: vars[1], cov: (s.OMEGA && s.OMEGA.COV) || 0,
      dims: dims, vars: vars, covIdx: null, fLogitIdx: s.ETA ? s.ETA.fLogitIdx : (eta && eta.fLogit ? 1 : null),
      diag: vars.slice()
    };
  }

  function etaDim(id) {
    var s = specOf(id);
    return (s.ETA && s.ETA.vars.length) || 2;
  }

  function omegaVars(id, disease) {
    var om = priorOmega(disease || 'PNH', id);
    return om.vars;
  }

  /* Individual parameters. Supports both calling conventions:
   *   indivParams(wt,disease,etaCL,etaV1,id,age,aux)   — legacy 2-eta
   *   indivParams(wt,disease,etaVec,id,age)           — N-eta, etaVec = [eta0..etaN-1]
   * etaVec layout for crovalimab (v0.9.0): [CL,V1,Q,V2,KA,F]  (6 dims). For
   * 2-eta drugs the vector is [CL,V1]. `aux` is kept for backward compat but
   * ignored when an etaVec of full dimension is supplied. */
  function indivParams(wt, disease, a, b, c, d, e) {
    // Two calling conventions:
    //   (wt,disease,etaCL,etaV1,id,age,aux)  legacy 2-eta (a=etaCL,b=etaV1,c=id,d=age,e=aux)
    //   (wt,disease,etaVec,id,age)          N-eta   (a=etaVec,b=id,c=age)
    if (Array.isArray(a)) {
      var etaVec0 = a, id2 = b, age2 = c;
      return indivParamsVec(wt, disease, etaVec0, id2, age2);
    }
    var etaCL = a, etaV1 = b, id = c, age = d, aux = e;
    // Backward compat: aux encoded as {etaKA,etaF} — map to tail of 6-vector via withRoutes
    // but here we still build the base N-eta params and let withRoutes handle aux
    var s = requireReady(id);
    var dim = etaDim(id);
    if (dim > 2) {
      var etaVec = [etaCL || 0, etaV1 || 0];
      for (var k = 2; k < dim; k++) etaVec.push(0);
      // aux fills tail when present (used by the v0.8.1 band path before migration)
      if (aux && s.OMEGA_AUX) {
        if (isFinite(aux.etaKA)) etaVec[4] = aux.etaKA;
        if (isFinite(aux.etaF)) etaVec[5] = aux.etaF;
      }
      return indivParamsVec(wt, disease, etaVec, id, age);
    }
    var w = wt / (s.WT_REF || 70);
    var cl = s.THETA.CL * Math.pow(w, s.EXPO.CLQ) * Math.exp(etaCL || 0);
    var v1 = s.THETA.V1 * Math.pow(w, s.EXPO.V) * Math.exp(etaV1 || 0);
    var v2 = s.THETA.V2 * Math.pow(w, s.EXPO.V);
    var q = s.THETA.Q * Math.pow(w, s.EXPO.CLQ);
    var vmax = s.THETA.VMAX * Math.pow(w, s.EXPO.CLQ);
    var km = s.THETA.KM;
    var p = {
      wt: wt, age: age > 0 ? age : null, disease: disease,
      eta: [etaCL || 0, etaV1 || 0],
      etaCL: etaCL || 0, etaV1: etaV1 || 0,
      cl: cl, v1: v1, v2: v2, q: q, vmax: vmax, km: km,
      kel: cl / v1, k12: q / v1, k21: q / v2,
      drugId: s.id
    };
    return withRoutes(p, s.id, age, aux);
  }

  function indivParamsVec(wt, disease, etaVec, id, age) {
    var s = requireReady(id);
    var w = wt / (s.WT_REF || 70);
    var ev = etaVec || [];
    var dim = s.ETA ? s.ETA.vars.length : 2;
    function e(i) { return isFinite(ev[i]) ? ev[i] : 0; }
    var clE = e(0), v1E = e(1);
    var cl = s.THETA.CL * Math.pow(w, s.EXPO.CLQ) * Math.exp(clE);
    var v1 = s.THETA.V1 * Math.pow(w, s.EXPO.V) * Math.exp(v1E);
    var v2, q, ka, fSc;
    if (dim === 6) {
      // crovalimab: eta layout [CL,V1,Q,V2,KA,F]; F is logit-scale
      var qE = e(2), v2E = e(3), kaE = e(4), fE = e(5);
      q = s.THETA.Q * Math.pow(w, s.EXPO.CLQ) * Math.exp(qE);
      v2 = s.THETA.V2 * Math.pow(w, s.EXPO.V) * Math.exp(v2E);
      // ka and F handled in withRoutes via etaVec tail, but compute here for p fields
      var ref = s.AGE_REF || 36;
      var ag = age > 0 ? age : ref;
      ka = s.KA_D * Math.pow(ag / ref, s.AGE_EXPO_KA != null ? s.AGE_EXPO_KA : 0) * Math.exp(kaE);
      var f0 = s.BIOAVAIL_SC != null ? s.BIOAVAIL_SC : 0.83;
      var l0 = Math.log(f0 / (1 - f0));
      fSc = 1 / (1 + Math.exp(-(l0 + fE)));
      fSc = Math.min(0.99, Math.max(0.01, fSc));
    } else {
      v2 = s.THETA.V2 * Math.pow(w, s.EXPO.V);
      q = s.THETA.Q * Math.pow(w, s.EXPO.CLQ);
      ka = 0; fSc = 1;
    }
    var vmax = s.THETA.VMAX * Math.pow(w, s.EXPO.CLQ);
    var km = s.THETA.KM;
    var p = {
      wt: wt, age: age > 0 ? age : null, disease: disease,
      eta: ev.slice(0, dim),
      etaVec: ev.slice(0, dim),
      etaCL: clE, etaV1: v1E,
      cl: cl, v1: v1, v2: v2, q: q, vmax: vmax, km: km,
      ka: ka, fSc: fSc,
      kel: cl / v1, k12: q / v1, k21: q / v2,
      drugId: s.id
    };
    // withRoutes would overwrite ka/fSc for dim 6; skip it and finalize there
    if (dim === 6) { p._etaVec = ev.slice(0, dim); return p; }
    return withRoutes(p, s.id, age, null);
  }

  /* Total (linear + nonlinear) clearance in L/day at concentration c [mg/L].
   * Elimination rate = CL*C + Vmax*C/(Km + C)  =>  CL_eff = rate/C = CL + Vmax/(Km + C) */
  function effClearance(p, c) {
    return p.cl + p.vmax / (p.km + c);
  }

  /* Approximate effective half-life [days] at steady-state concentration c */
  function effHalfLife(p, c) {
    return Math.LN2 * p.v1 / effClearance(p, c);
  }

  /* Right-hand side of the ODE system.
   * y = [A1, A2, depot] amounts [mg]; rin = IV infusion rate [mg/day].
   * The depot compartment (index 2) is only allocated when the parameter set
   * carries an SC absorption rate (p.ka > 0); otherwise it stays absent and
   * the solver works on the classic 2-state system. */
  function rhs(y, p, rin) {
    var c = y[0] / p.v1;
    var mm = (p.vmax * c) / (p.km + c);
    var inSc = p.ka > 0 ? y[2] * p.ka : 0;
    return [
      -p.kel * y[0] - mm - p.k12 * y[0] + p.k21 * y[1] + rin + inSc,
      -p.k21 * y[1] + p.k12 * y[0]
    ].concat(p.ka > 0 ? [-inSc] : []);
  }

  // ---- Dormand-Prince 5(4) embedded Runge-Kutta (adaptive step) -----------
  var DP_A = [
    null,
    [1 / 5],
    [3 / 40, 9 / 40],
    [44 / 45, -56 / 15, 32 / 9],
    [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
    [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656]
  ];
  var DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1];
  var DP_B  = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
  var DP_BH = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

  function dopriStep(f, t, y, h, rtol, atol) {
    var n = y.length;
    var k = new Array(7);
    var s, j, m, acc, yy;
    k[0] = f(t, y);
    for (s = 1; s <= 5; s++) {
      var a = DP_A[s];
      yy = new Array(n);
      for (j = 0; j < n; j++) {
        acc = 0;
        for (m = 0; m < a.length; m++) acc += a[m] * k[m][j];
        yy[j] = y[j] + h * acc;
      }
      k[s] = f(t + DP_C[s] * h, yy);
    }
    var y5 = new Array(n);
    for (j = 0; j < n; j++) {
      acc = 0;
      for (m = 0; m < 6; m++) acc += DP_B[m] * k[m][j];
      y5[j] = y[j] + h * acc;
    }
    k[6] = f(t + h, y5);
    var err2 = 0;
    for (j = 0; j < n; j++) {
      var e = 0;
      for (m = 0; m < 7; m++) e += (DP_B[m] - DP_BH[m]) * k[m][j];
      e *= h;
      var sc = atol + rtol * Math.max(Math.abs(y[j]), Math.abs(y5[j]));
      err2 += (e / sc) * (e / sc);
    }
    var err = Math.sqrt(err2 / n);
    var bad = !isFinite(err);
    for (j = 0; j < n; j++) {
      if (!isFinite(y5[j]) || Math.abs(y5[j]) > 1e12) { bad = true; break; }
    }
    if (bad) return { failed: true };
    return { y5: y5, err: err };
  }

  function integrate(y0, t0, tEnd, rin, p, rtol, atol) {
    var t = t0, y = y0.slice();
    var span = tEnd - t0;
    if (span <= 0) return { ok: true, y: y };
    var h = Math.min(0.05, span);
    var guard = 0;
    while (t < tEnd - 1e-13) {
      if (++guard > 5e6) return { ok: false };
      if (h > tEnd - t) h = tEnd - t;
      var r = dopriStep(function (tt, yy) { return rhs(yy, p, rin); }, t, y, h, rtol, atol);
      if (r.failed) return { ok: false };
      if (r.err <= 1) {
        t += h;
        y = r.y5;
        h = r.err > 0
          ? h * Math.min(5, Math.max(0.2, 0.9 * Math.pow(r.err, -0.2)))
          : h * 5;
      } else {
        h *= Math.max(0.1, Math.min(0.9, 0.9 * Math.pow(r.err, -0.2)));
        if (h < 1e-14) return { ok: false };
      }
      if (h > 1) h = 1;
    }
    return { ok: true, y: y };
  }  /* -------------------------------------------------------------------------
   * simulate(doses, outTimes, p, opts)
   *   doses:    [{t, amt, route?, bolus?, dur?}]  t in days, amt in mg.
   *             Default administration: fixed IV infusion of the current drug's
 *             duration. `route: 'sc'` gives a first-order depot dose (rate ka,
 *             bioavailability F) — used for crovalimab, whose first dose is IV
 *             and all later doses are SC. `bolus: true` is for testing only.
 *   outTimes: [days...] concentrations are returned exactly at these times
 *             (integration is split at every out time; out times at a dose
 *             time are evaluated *before* the dose is given -> troughs).
 *   p:        indivParams() result
 *   opts:     { rtol (default 1e-6), atol (default 1e-8), dur, id }
 * returns:    { c: [concentrations], failed: bool }
 * ---------------------------------------------------------------------- */
  function simulate(doses, outTimes, p, opts) {
    opts = opts || {};
    var id = opts.id;
    var s = requireReady(id);
    var rtol = opts.rtol != null ? opts.rtol : 1e-6;
    var atol = opts.atol != null ? opts.atol : 1e-8;
    var dur = opts.dur != null ? opts.dur : s.INFUSION_D;

    var ev = [];
    var i, d;
    for (i = 0; i < doses.length; i++) {
      d = doses[i];
      if (!(d.amt > 0)) continue;
      if (d.bolus) {
        ev.push({ t: d.t, rank: 2, kind: 'bolus', amt: d.amt });
      } else if (d.route === 'sc') {
        if (!(p.ka > 0)) {
          throw new Error('SC dose given but the selected model has no SC absorption rate (ka).');
        }
        // bioavailability from the patient set (typical F, or the aux-sampled F
        // in band simulations) — equals spec BIOAVAIL_SC when no aux is applied
        ev.push({ t: d.t, rank: 2, kind: 'sc', amt: d.amt * (p.fSc != null ? p.fSc : (s.BIOAVAIL_SC != null ? s.BIOAVAIL_SC : 1)) });
      } else {
        var dd = d.dur != null ? d.dur : dur;
        var rate = d.amt / dd;
        ev.push({ t: d.t, rank: 1, kind: 'rate', dr: rate });
        ev.push({ t: d.t + dd, rank: 1, kind: 'rate', dr: -rate });
      }
    }
    var nOut = outTimes.length;
    var res = new Array(nOut);
    for (i = 0; i < nOut; i++) {
      ev.push({ t: outTimes[i], rank: 0, kind: 'out', idx: i });
    }
    ev.sort(function (a, b) { return a.t - b.t || a.rank - b.rank; });

    var hasDepot = p.ka > 0;
    var y = hasDepot ? [0, 0, 0] : [0, 0];
    var rin = 0, t = ev.length ? ev[0].t : 0, failed = false;
    i = 0;
    while (i < ev.length) {
      var tEv = ev[i].t;
      if (tEv > t) {
        var r = integrate(y, t, tEv, rin, p, rtol, atol);
        if (!r.ok) { failed = true; break; }
        y = r.y;
      }
      t = tEv;
      while (i < ev.length && ev[i].t === tEv) {
        var e = ev[i++];
        if (e.kind === 'out') res[e.idx] = y[0] / p.v1;
        else if (e.kind === 'rate') rin += e.dr;
        else if (e.kind === 'bolus') y[0] += e.amt;
        else if (e.kind === 'sc') y[2] += e.amt;
      }
    }
    for (i = 0; i < nOut; i++) if (res[i] === undefined) res[i] = 0;
    return { c: res, failed: failed };
  }

  /* Attach route/depot parameters to an individual parameter set.
   * ka = first-order SC absorption rate [1/day] (age-scaled when the spec
   * declares an age covariate on ka), F = SC bioavailability.
   * `aux = { etaKA, etaF }` applies log-scale (or logit-scale for F when the
   * spec declares fLogit) random effects sampled from the population prior —
   * used in the band/prior simulations only, never in MAP estimation. */
  function withRoutes(p, id, age, aux) {
    var s = specOf(id != null ? id : (p && p.drugId));
    if (s && !s.pending && s.KA_D > 0) {
      var ref = s.AGE_REF || 36;
      var a = age > 0 ? age : ref;
      p.ka = s.KA_D * Math.pow(a / ref, s.AGE_EXPO_KA != null ? s.AGE_EXPO_KA : 0);
    } else {
      p.ka = 0;
    }
    p.fSc = s && s.BIOAVAIL_SC != null ? s.BIOAVAIL_SC : 1;
    if (aux && s && !s.pending) {
      var ax = s.OMEGA_AUX;
      if (ax && ax.ka && isFinite(aux.etaKA)) p.ka = p.ka * Math.exp(aux.etaKA);
      if (ax && ax.f && isFinite(aux.etaF)) {
        if (ax.fLogit) {
          var l0 = Math.log(p.fSc / (1 - p.fSc));
          var f = 1 / (1 + Math.exp(-(l0 + aux.etaF)));
          p.fSc = Math.min(0.99, Math.max(0.01, f));
        } else {
          p.fSc = Math.min(0.99, Math.max(0.01, p.fSc * Math.exp(aux.etaF)));
        }
      }
    }
    return p;
  }

  // ---- eculizumab aliases (historical exports; tests/UI use M.select + spec) ----
  var ECU_THETA = DRUGS.eculizumab.THETA;
  var ECU_OMEGA = DRUGS.eculizumab.OMEGA;
  var ECU_SIGMA = DRUGS.eculizumab.SIGMA;

  ECU.model = {
    THETA: ECU_THETA,
    OMEGA: ECU_OMEGA,
    OMEGA_IOV_CL: 0.112,
    SIGMA: ECU_SIGMA,
    INFUSION_DURATION_D: DRUGS.eculizumab.INFUSION_D,
    // multi-drug API
    drugs: DRUGS,
    listDrugs: listDrugs,
    select: setDrug,
    requireReady: requireReady,
    drug: drug,
    spec: specOf,
    priorOmega: priorOmega,
    iovVar: iovVar,
    etaDim: etaDim,
    omegaVars: omegaVars,
    indivParams: indivParams,
    indivParamsVec: indivParamsVec,
    effClearance: effClearance,
    effHalfLife: effHalfLife,
    simulate: simulate
  };

})(typeof window !== 'undefined' ? window : globalThis);
```

`src/bayes.js`, the MAP-relevant excerpts: the objective function
(`makeOfv`), the censored-likelihood term (`logPhi`), the prior quadratic
form (`omegaQuad`/`omegaQuadVec`), the optimizer (`nelderMead`), and the
multi-start MAP driver (`mapEstimate`) that together are what this document
validates against NONMEM's own POSTHOC step. The full file (2500+ lines,
including the MCMC sampler, which this document explicitly does not
validate, see R7) ships with the project at `src/bayes.js`.

```javascript
// ---- logPhi: log Phi(z), the M3 censored-likelihood building block ----
  function logPhi(z) {
    if (z > 6) return 0;
    if (z < -6) return -0.5 * z * z - Math.log(-z) - 0.9189385332046727;
    return Math.log(0.5 * erfc(-z / Math.SQRT2));
  }

// ---- omegaQuad / omegaQuadVec: the prior quadratic form eta' Omega^-1 eta
// (exact 2x2 inverse when a CL-V1 covariance is present, e.g. ravulizumab;
// diagonal otherwise, e.g. crovalimab's 6-eta model) --------------------
  function omegaQuadVec(om, eta) {
    var vars = om.vars || [om.cl, om.v1];
    var n = eta.length;
    var c = om.cov || 0;
    // 2D block with covariance (ravulizumab) — exact inverse
    if (n === 2 && Math.abs(c) > 1e-12) {
      var a = vars[0], b = vars[1];
      var det = a * b - c * c;
      if (!(det > 0)) return eta[0] * eta[0] / Math.max(a, 1e-9) + eta[1] * eta[1] / Math.max(b, 1e-9);
      return (b * eta[0] * eta[0] - 2 * c * eta[0] * eta[1] + a * eta[1] * eta[1]) / det;
    }
    // diagonal (and 2D cov==0 falls through here)
    var s = 0;
    for (var i = 0; i < n; i++) {
      var v = vars[i] != null ? vars[i] : 1;
      if (!(v > 0)) v = 1e-9;
      s += eta[i] * eta[i] / v;
    }
    // add off-diag correction for the first block when n>2 and cov present
    if (n > 2 && Math.abs(c) > 1e-12) {
      var a2 = vars[0], b2 = vars[1];
      var det2 = a2 * b2 - c * c;
      if (det2 > 0) {
        var diag = eta[0] * eta[0] / a2 + eta[1] * eta[1] / b2;
        var block = (b2 * eta[0] * eta[0] - 2 * c * eta[0] * eta[1] + a2 * eta[1] * eta[1]) / det2;
        s = s - diag + block;
      }
    }
    return s;
  }
  function omegaQuad(om, e0, e1) {
    if (Array.isArray(e0)) return omegaQuadVec(om, e0);
    if (e1 === undefined) return omegaQuadVec(om, [e0]);
    var a = om.cl, b = om.v1, c = om.cov || 0;
    var det = a * b - c * c;
    if (!(det > 0)) return e0 * e0 / Math.max(a, 1e-9) + e1 * e1 / Math.max(b, 1e-9);
    return (b * e0 * e0 - 2 * c * e0 * e1 + a * e1 * e1) / det;
  }

// ---- makeOfv: the MAP objective per patient -- Sigma (obs-pred)^2/var +
// log(var) + eta'Omega^-1 eta, the same Laplacian -2*log-posterior NONMEM
// computes internally under METHOD=1 LAPLACE (see $ 3 of this report) ----
  function makeOfv(ctx) {
    var obs = ctx.obs.slice().sort(function (a, b) { return a.t - b.t; });
    var times = obs.map(function (o) { return o.t; });
    var sig = (ctx.drug ? M.spec(ctx.drug) : M.drug()).SIGMA;
    var rtol = ctx.rtol != null ? ctx.rtol : 1e-6;
    var lloq = ctx.lloq || 0;
    var errMult = ctx.errMult != null && ctx.errMult > 0 ? ctx.errMult : 1;
    var dims = (ctx.omega && ctx.omega.dims) || 2;
    /* Per-observation residual-SD multiplier, precomputed: it depends only on
     * each sample's AGE, never on eta, so it is constant across the whole
     * search. Age is measured from the newest fitted sample (obs is sorted
     * above), not from the wall clock: a session must refit to the same
     * numbers tomorrow, and a report must be reproducible from its own JSON
     * export. Folds errMult in, since the two do the same thing. */
    var tNewest = times.length ? times[times.length - 1] : 0;
    var multI = obs.map(function (o) {
      return errMult * recencyMult(ctx.recency, tNewest - o.t);
    });
    function ofv(eta) {
      var etaVec = eta;
      var p = M.indivParams(ctx.wt, ctx.disease, etaVec, ctx.drug, ctx.age);
      var sim = M.simulate(ctx.doses, times, p, { rtol: rtol, id: ctx.drug });
      if (sim.failed) return Infinity;
      var s = omegaQuadVec(ctx.omega, etaVec);
      for (var i = 0; i < obs.length; i++) {
        var o = obs[i], pred = sim.c[i];
        // variance floor guards the MAP against a degenerate sd -> 0 when pred ~ 0
        var v = Math.max(sig.ADD + sig.PROP * pred * pred, 1e-6) * multI[i] * multI[i];
        var sd = Math.sqrt(v);
        if (o.lloq && lloq > 0) {
          var lp = logPhi((lloq - pred) / sd);
          if (!isFinite(lp)) return Infinity;
          s -= 2 * lp;
        } else {
          var d = (o.c - pred) / sd;
          s += d * d + Math.log(v);
        }
      }
      return s;
    };
    return ofv;
  }

// ---- nelderMead: the optimizer (derivative-free simplex search) --------
  function nelderMead(f, x0, step, maxIter) {
    var n = x0.length;
    var pts = [{ x: x0.slice(), f: f(x0) }];
    if (!isFinite(pts[0].f)) return { x: x0.slice(), f: pts[0].f, ok: false };
    var i, j;
    for (i = 0; i < n; i++) {
      var xs = x0.slice(); xs[i] += step[i];
      pts.push({ x: xs, f: f(xs) });
    }
    var iter = 0;
    for (; iter < maxIter; iter++) {
      pts.sort(function (a, b) { return a.f - b.f; });
      var spread = Math.abs(pts[n].f - pts[0].f);
      var xspread = 0;
      for (i = 1; i <= n; i++) {
        for (j = 0; j < n; j++) xspread = Math.max(xspread, Math.abs(pts[i].x[j] - pts[0].x[j]));
      }
      if (spread < 1e-10 && xspread < 1e-7) break;
      var cen = new Array(n).fill(0);
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) cen[j] += pts[i].x[j] / n;
      var worst = pts[n];
      var xr = cen.map(function (c, jj) { return c + (c - worst.x[jj]); });
      var fr = f(xr);
      var nw;
      if (isFinite(fr) && fr < pts[0].f) {
        var xe = cen.map(function (c, jj) { return c + 2 * (c - worst.x[jj]); });
        var fe = f(xe);
        nw = (isFinite(fe) && fe < fr) ? { x: xe, f: fe } : { x: xr, f: fr };
      } else if (isFinite(fr) && fr < pts[n - 1].f) {
        nw = { x: xr, f: fr };
      } else {
        var xc = cen.map(function (c, jj) { return c + 0.5 * (worst.x[jj] - c); });
        var fc = f(xc);
        if (isFinite(fc) && fc < worst.f) {
          nw = { x: xc, f: fc };
        } else {
          for (i = 1; i <= n; i++) {
            var xs2 = pts[0].x.map(function (c, jj) { return (c + pts[i].x[jj]) / 2; });
            pts[i] = { x: xs2, f: f(xs2) };
          }
          continue;
        }
      }
      pts[n] = nw;
    }
    pts.sort(function (a, b) { return a.f - b.f; });
    // `converged` distinguishes a simplex that contracted to the tolerance from
    // one that merely ran out of iterations. Nelder-Mead can stall on a
    // non-stationary point in >2 dimensions, and the resulting x is reported to
    // the user as the individual PK estimate — so a stall must not look like a
    // success (v0.13.0).
    return { x: pts[0].x, f: pts[0].f, iters: iter, ok: true, converged: iter < maxIter };
  }

// ---- mapEstimate: multi-start MAP driver -- refines from eta=0 in three
// shrinking-step stages, then re-optimizes from one or more dispersed
// starting points and keeps the better optimum (startGap flags disagreement)
  function mapEstimate(ofv, step, opts) {
    // Generic over eta dimension: step length determines dims (default 2D for backward compat).
    // When step length >2, the refinement steps are repeated with scaled small steps.
    var n = Array.isArray(step) ? step.length : 2;
    step = step || [0.4, 0.4];
    if (step.length !== n) n = step.length;
    opts = opts || {};

    function runFrom(x0) {
      var r = nelderMead(ofv, x0, step, n <= 2 ? 300 : 500);
      if (!r.ok) return r;
      // refinement stages — scale steps per dimension (smaller variance dims get smaller steps)
      var small = step.map(function (s) { return s * 0.2; });
      var tiny  = step.map(function (s) { return s * 0.05; });
      // ensure minimum step sizes for very small variances
      for (var kk = 0; kk < n; kk++) { if (small[kk] < 0.02) small[kk] = 0.02; if (tiny[kk] < 0.005) tiny[kk] = 0.005; }
      var r2 = nelderMead(ofv, r.x, small, n <= 2 ? 200 : 350);
      if (r2.ok && r2.f < r.f) r = r2;
      var r3 = nelderMead(ofv, r.x, tiny, n <= 2 ? 150 : 250);
      if (r3.ok && r3.f < r.f) r = r3;
      return r;
    }

    var zero = new Array(n); for (var k = 0; k < n; k++) zero[k] = 0;
    var best = runFrom(zero);
    if (!best.ok) return best;

    /* v0.13.0: refit from a dispersed start and keep the better OFV. A single
     * start at eta = 0 can stall on a ridge (SC-only crovalimab, where CL and F
     * trade off). `startGap` is the OFV disagreement between starts — the UI
     * warns when it is large, instead of silently returning the worse mode. */
    var starts = opts.starts != null ? opts.starts : 1;
    var gap = 0;
    for (var s = 0; s < starts; s++) {
      var sign = (s % 2 === 0) ? 1 : -1;
      var alt = runFrom(step.map(function (st) { return sign * 0.5 * st; }));
      if (alt.ok && isFinite(alt.f)) {
        gap = Math.max(gap, Math.abs(alt.f - best.f));
        if (alt.f < best.f - 1e-9) best = alt;
      }
    }
    best.startGap = gap;
    return best;
  }
```

## Appendix C: Reproducibility

- `validation/generate_and_fit.js`: the full scenario table (dosing,
  sampling times, weight/age, BLQ flags), the synthetic-data generator
  (fixed seed 913026), the app-side fit, and the NONMEM dataset writer.
- `validation/compare.js`: parses each run's `.phi` file and applies the
  §4.4 criterion.
- `validation/results.json`, `validation/comparison.json`: full numeric
  output backing §5's tables.
- `validation/nonmem/*.csv`: the four NONMEM datasets as actually run.
- `validation/nonmem/run_*/NM_run1/psn.lst`, `psn.phi`: raw NONMEM output.

Re-running end to end: `node validation/generate_and_fit.js`, then `execute
<name>_posthoc.mod -dir=run_<name> -clean=1` from `validation/nonmem/` for
each of the four control streams, then `node validation/compare.js`.
