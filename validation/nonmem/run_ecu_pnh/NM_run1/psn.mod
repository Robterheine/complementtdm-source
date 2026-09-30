;; (PNH. EQ.1: CL uses ETA(1) with no IOV term added -- the app has no IOV
;; component in the PNH prior either, M.priorOmega('PNH','eculizumab') is
;; the plain 2-dim [0.1546, 0.0812]). The IOV/OCC machinery of the original
;; file is dropped entirely: it is inert for PNH subjects there too (only
;; the PNH.EQ.0 branch ever references IOV), so nothing is lost.
;; Estimation-engine validation -- eculizumab, PNH.
;; Adapted from ../../nonmemcontrolstream.txt for POSTHOC individual
;; estimation with population parameters FIXED at their published values.
;; Structural ($PK/$DES) code is verbatim from the original PNH branch
$PROBLEM    Estimation-engine validation -- eculizumab PNH POSTHOC
$INPUT      ID TIME AMT RATE DV MDV EVID CMT CENS WT AGE
$DATA      ecu_pnh.csv IGNORE=@
$SUBROUTINE ADVAN13 TOL=9
$MODEL      COMP=(CENTRAL) COMP=(PERIPHERAL)
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

$THETA  0.1626 FIX ; 1 CL  L/day
 4.299 FIX ; 2 V1  L
 25.64 FIX ; 3 VM  mg/day
 13.54 FIX ; 4 KM  mg/L
 2.63 FIX ; 5 V2  L
 0.6243 FIX ; 6 Q   L/day
 19.1 FIX ; 7 SIGMA additive variance
 0.0185 FIX ; 8 SIGMA proportional variance
$OMEGA  0.1546  FIX  ; 1 IIV CL  (PNH: no IOV folded in)
 0.0812  FIX  ;   2 IIV V1
$ESTIMATION METHOD=1 LAPLACE LIKE NOABORT MAXEVAL=0 PRINT=1 POSTHOC

