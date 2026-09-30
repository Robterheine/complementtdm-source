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
