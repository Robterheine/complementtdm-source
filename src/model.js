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
      weightRange: { min: 3, max: 300 },   // kg; author's scope decision (see assumptions)
      obsValMin: 0.01,
      obsValMax: 10000,
      obsTypicalMax: 1000,                 // above this: 'check the unit' confirmation, not a block
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
        'IV infusion duration is adjustable per dose (10–360 minutes; default 30 minutes); it can affect a fitted sample drawn during the infusion, but has negligible effect on troughs sampled after the infusion has long finished.',
        'Body weight is accepted from 3 to 300 kg. The lower limit is the author\u2019s scope decision so that very young children can be monitored; the source model was developed in a population that included small children, but weights near the lower limit rely on allometric scaling from the 70 kg reference and should be interpreted with particular care.'
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
      weightRange: { min: 25, max: 300 },
      obsValMin: 0.01,
      obsValMax: 10000,
      obsTypicalMax: 3000,
      targetRange: { min: 10, max: 500 },
      wtTooltip: 'Body weight in kg (covariate on clearance and volumes, allometric scaling to 70 kg).',
      diseaseCovariate: false,          // disease is not a covariate in this model
      targetDefault: 150,
      targetHint: '≥ 100 µg/mL minimum; 150 µg/mL applied here as the more conservative default.',
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
      weightRange: { min: 25, max: 300 },
      obsValMin: 0.01,
      obsValMax: 10000,
      obsTypicalMax: 3000,
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

  /* Terminal (slow-phase) half-life [days] of the two-compartment
   * disposition: λz = (s − √(s² − 4·k10·k21))/2 with s = k10 + k12 + k21 and
   * k10 = CL_eff/V1. The SC depot (crovalimab) only feeds the central
   * compartment and does not change it. With Michaelis–Menten elimination
   * (eculizumab) CL_eff depends on concentration, so the value holds at `c`.
   * v0.43.0, replacing effHalfLife() in the UI (review B1). */
  function terminalHalfLife(p, c) {
    var k10 = effClearance(p, c > 0 ? c : 0) / p.v1;
    var k12 = p.q / p.v1, k21 = p.q / p.v2;
    var s = k10 + k12 + k21;
    var lz = (s - Math.sqrt(Math.max(0, s * s - 4 * k10 * k21))) / 2;
    return lz > 0 ? Math.LN2 / lz : NaN;
  }

  /* Approximate effective half-life [days] at steady-state concentration c.
   * One-compartment (ignores the peripheral compartment); no longer shown in
   * the UI since v0.43.0, kept for its existing tests. */
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
    /* v0.44.0 (review H2): events are grouped below with `ev[i].t === tEv`,
     * which is never true for NaN, so the index stops advancing and the loop
     * never ends. Refuse a non-finite time up front instead of hanging. */
    for (i = 0; i < outTimes.length; i++) {
      if (!isFinite(outTimes[i])) throw new Error('simulate(): an output time is not a finite number.');
    }
    for (i = 0; i < doses.length; i++) {
      d = doses[i];
      if (!(d.amt > 0)) continue;
      if (!isFinite(d.t)) throw new Error('simulate(): a dose time is not a finite number.');
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
        if (!(dd > 0) || !isFinite(dd)) throw new Error('simulate(): an infusion duration is not a positive number.');
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
    terminalHalfLife: terminalHalfLife,
    simulate: simulate
  };

})(typeof window !== 'undefined' ? window : globalThis);
