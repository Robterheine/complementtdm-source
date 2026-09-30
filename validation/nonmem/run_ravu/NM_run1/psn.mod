;; at load time (src/model. js's own header comment: "CL 0.00342 L/h and Q
;; 0.0162 L/h become CL 0.08208 L/day and Q 0.3888 L/day" -- an exact linear
;; time rescale, already independently verified structurally equivalent in
;; MODEL_VALIDATION. md's "structure: ravulizumab $DES (ADVAN3, rescaled to
;; days)" check). This file uses the app's own day-scale THETAs directly, and
;; the synthetic dataset's TIME/RATE columns are in days to match -- same
;; model, same units the app itself uses, not a new rescale being introduced.
;; Estimation-engine validation -- ravulizumab.
;; Adapted from ../../ravulizumab.txt for POSTHOC individual estimation with
;; population parameters FIXED at their published values.
;;
;; The original control stream is in HOURS (CL 0.00342 L/h, Q 0.0162 L/h,
;; D1 2.5 h). The app works in DAYS throughout and rescales these uniformly
$PROBLEM    Estimation-engine validation -- ravulizumab POSTHOC
$INPUT      ID TIME AMT RATE DV MDV EVID CMT CENS WT AGE
$DATA      ravu.csv IGNORE=@
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

$THETA  0.08208 FIX ; 1 CL  L/day  (0.00342 L/h x24)
 3.43 FIX ; 2 V1  L
 1.86 FIX ; 3 V2  L
 0.3888 FIX ; 4 Q   L/day  (0.0162 L/h x24)
 0.0239 FIX ; 5 SIGMA proportional variance
$OMEGA  BLOCK(2) FIX
 0.0569
 0.0161 0.0264
$ESTIMATION METHOD=1 LAPLACE LIKE NOABORT MAXEVAL=0 PRINT=1 POSTHOC

