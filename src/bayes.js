/* =========================================================================
 * mAb TDM — Bayesian engine (MAP estimation + MCMC posterior)
 *
 * Individualization:
 *   - MAP-Bayes: minimizes OFV(eta) = sum_i (obs_i - pred_i)^2 / SD_i^2
 *                + eta' Omega^-1 eta          (observed concentrations)
 *                with an M3 (probability-below-LLOQ) term for censored
 *                observations, SD_i^2 = SIGMA.ADD + SIGMA.PROP * pred_i^2.
 *   - Posterior: adaptive random-walk Metropolis on the full eta vector
 *                (dimension = the drug's $OMEGA disposition etas — 2 for
 *                eculizumab/ravulizumab, 6 for crovalimab) started at the MAP,
 *                proposal covariance from the Laplace approximation.
 *   - Prior for a new patient: eta ~ N(0, Omega); for aHUS the clearance
 *     variance is IIV + IOV folded (see model.priorOmega).
 * ========================================================================= */
(function (root) {
  'use strict';
  var ECU = root.ECU = root.ECU || {};
  var M = ECU.model;

  // ------------------------------ RNG -------------------------------------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussFactory(rng) {
    var spare = null;
    return function () {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u, vv, s;
      do { u = rng() * 2 - 1; vv = rng() * 2 - 1; s = u * u + vv * vv; }
      while (s === 0 || s >= 1);
      var f = Math.sqrt(-2 * Math.log(s) / s);
      spare = vv * f;
      return u * f;
    };
  }

  // ---------------------- Normal CDF (for M3/LLOQ) ------------------------
  // erfc via Chebyshev method (Numerical Recipes, ~1e-7 relative accuracy)
  var ERF_COF = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
    2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15
  ];
  function erfc(x) {
    var Z = Math.abs(x), T = 2 / (2 + Z), ty = 4 * T - 2;
    var d = 0, dd = 0, tmp, j;
    for (j = ERF_COF.length - 1; j > 0; j--) {
      tmp = d; d = ty * d - dd + ERF_COF[j]; dd = tmp;
    }
    var ans = T * Math.exp(-Z * Z + 0.5 * (ERF_COF[0] + ty * d) - dd);
    return x >= 0 ? ans : 2 - ans;
  }
  function logPhi(z) {
    if (z > 6) return 0;
    if (z < -6) return -0.5 * z * z - Math.log(-z) - 0.9189385332046727;
    return Math.log(0.5 * erfc(-z / Math.SQRT2));
  }

  // --------------------------- OFV factory --------------------------------
  /* eta' Omega^-1 eta. Supports both calling forms:
   *   omegaQuad(om, e0, e1)            legacy 2-eta
   *   omegaQuad(om, etaVec)  or  omegaQuadVec(om, etaVec)  N-eta
   * For dims>2, Omega is taken as diagonal except for the 2x2 CL-V1 block
   * when cov != 0 (ravulizumab); crovalimab (6-eta) is fully diagonal.
   */
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

  /* Time-dependent recency weighting (v0.21.0) -----------------------------
   *
   * An optional, off-by-default advanced fitting option: older concentrations
   * are given a larger residual error, so they pull the individual fit less
   * than recent ones. Rationale: a measurement describes the patient as they
   * were on the day it was drawn, and the further back that is, the less well
   * it describes them now — partly drift in the patient, partly a dosing
   * history that is less reliably documented the further back one looks.
   *
   * This is a statement about SIGMA and nothing else. It is exactly the
   * existing assay-error multiplier (errMult) made time-dependent: the same
   * uniform scaling of the residual SD, applied per observation according to
   * its age rather than once for the whole assay. It therefore applies to
   * every drug and every disease, needs nothing from the model's random-effect
   * structure, and is entirely independent of whether a given model happens to
   * estimate between-occasion variability (which is an OMEGA term).
   *
   *   SD_i = SD_base(pred_i) * errMult * m(age_i)
   *   m(age) = 1 + (Mmax - 1) * (1 - exp(-age / TAU))
   *
   * m(0) = 1 exactly: the newest sample is never inflated. m saturates at
   * Mmax, so an old sample is down-weighted but never discarded. Because the
   * multiplier is applied to the SD, a sample's relative weight in the fit is
   * exactly 1/m^2 -- independent of its concentration, which makes it easy to
   * state and easy to audit.
   *
   * The preset sets Mmax, i.e. HOW MUCH the residual error grows; the time
   * constant is shared, so all three tiers have the same shape and differ only
   * in strength. Neither Mmax nor TAU is estimated from the patient's own data
   * (with the handful of samples a real case carries neither is identifiable,
   * and a free inflation parameter would simply be driven up until the
   * residuals vanished); both are deterministic functions of a sample's age,
   * so the log-variance term below stays constant in eta. */
  var RECENCY_TAU_DAYS = 365;
  var RECENCY_MAX = { off: 1, low: 1.5, medium: 2, high: 3 };

  function recencyMaxMult(preset) {
    var v = RECENCY_MAX[preset];
    return typeof v === 'number' && isFinite(v) && v >= 1 ? v : 1;
  }

  /* Residual-SD multiplier for a sample of the given age, in days. */
  function recencyMult(preset, ageDays) {
    var mx = recencyMaxMult(preset);
    if (mx <= 1 || !(ageDays > 0)) return 1;
    return 1 + (mx - 1) * (1 - Math.exp(-ageDays / RECENCY_TAU_DAYS));
  }

  /* ctx: { wt, age?, disease, drug?, doses, obs:[{t,c,lloq}], lloq,
   *        omega:{cl,v1,cov}, rtol?, errMult?, recency? }
   * Returns ofv(eta) = -2 log[p(D|eta) p(eta)] up to a constant.
   *
   * Likelihood terms (exact Gaussian, v0.7.0):
   *   quantified:  (obs-pred)^2/SD^2 + log(SD^2)     <- log-variance term is NOT
   *   constant across eta with a proportional error model; omitting it biases MAP
   *   (audit finding F1/P1).
   *   censored:    -2 log Phi((LLOQ - pred)/SD)      (M3; value unused)
   * errMult (assay-error multiplier, default 1) inflates SD — local assays with
   * larger error must trust samples less (audit P8). */
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

  // --------------------------- Nelder-Mead --------------------------------
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

  function stepForOmega(omega) {
    // Initial simplex steps scaled to prior SDs (keeps 6D search well-conditioned)
    var vars = omega.vars || [omega.cl, omega.v1];
    var n = omega.dims || vars.length || 2;
    var s = new Array(n);
    for (var i = 0; i < n; i++) {
      var sd = Math.sqrt(Math.max(vars[i], 1e-9));
      // wider variances (e.g. F logit ~1.35) get larger steps but capped
      s[i] = Math.min(0.9, Math.max(0.15, 0.8 * sd));
    }
    return s;
  }

  // ----------------------- small matrix helpers (generic N≤6) --------------
  function matCopy(A) { return A.map(function (r) { return r.slice(); }); }
  function choleskyDecomp(A) {
    var n = A.length, L = new Array(n);
    for (var i = 0; i < n; i++) { L[i] = new Array(n).fill(0); }
    for (var k = 0; k < n; k++) {
      var s = 0; for (var j = 0; j < k; j++) s += L[k][j] * L[k][j];
      var d = A[k][k] - s;
      if (!(d > 1e-12)) return null;
      L[k][k] = Math.sqrt(d);
      for (var ii = k + 1; ii < n; ii++) {
        var s2 = 0; for (var jj = 0; jj < k; jj++) s2 += L[ii][jj] * L[k][jj];
        L[ii][k] = (A[ii][k] - s2) / L[k][k];
      }
    }
    return L;
  }
  function invertSPD(A) {
    var n = A.length;
    var L = choleskyDecomp(A);
    if (!L) return null;
    // invert via forward/back substitution on identity columns
    var inv = new Array(n); for (var i2 = 0; i2 < n; i2++) inv[i2] = new Array(n).fill(0);
    for (var col = 0; col < n; col++) {
      var y = new Array(n).fill(0);
      for (var r = 0; r < n; r++) {
        var acc = (r === col ? 1 : 0);
        for (var kk = 0; kk < r; kk++) acc -= L[r][kk] * y[kk];
        y[r] = acc / L[r][r];
      }
      var xcol = new Array(n).fill(0);
      for (var rr = n - 1; rr >= 0; rr--) {
        var acc2 = y[rr];
        for (var k2 = rr + 1; k2 < n; k2++) acc2 -= L[k2][rr] * xcol[k2];
        xcol[rr] = acc2 / L[rr][rr];
      }
      for (var r2 = 0; r2 < n; r2++) inv[r2][col] = xcol[r2];
    }
    return inv;
  }
  function isPositiveDefinite(A) { return !!choleskyDecomp(A); }

  // ----------------------- Laplace approximation --------------------------
  /* Covariance of the posterior ~ 2 * H^-1 with H = Hessian of OFV at the MAP.
   * Generic over eta dimension. Returns { cov, fallback, h }.
   * Hessian via central differences (h tried at h and h/2, best conditioned wins).
   */
  function laplaceCov(ofv, x, omega, h) {
    h = h || 0.12;
    var n = x.length;
    var vars = (omega && omega.vars) ? omega.vars : [omega.cl, omega.v1];
    function hessAt(step) {
      var f00 = ofv(x);
      var H = new Array(n); for (var a = 0; a < n; a++) { H[a] = new Array(n).fill(0); }
      // diagonal
      for (var i = 0; i < n; i++) {
        var xp = x.slice(); xp[i] += step;
        var xm = x.slice(); xm[i] -= step;
        var fp = ofv(xp), fm = ofv(xm);
        if (!isFinite(fp) || !isFinite(fm)) return null;
        H[i][i] = (fp - 2 * f00 + fm) / (step * step);
      }
      // off-diagonal
      for (var ii = 0; ii < n; ii++) for (var jj = ii + 1; jj < n; jj++) {
        var pp = x.slice(); pp[ii] += step; pp[jj] += step;
        var pm = x.slice(); pm[ii] += step; pm[jj] -= step;
        var mp = x.slice(); mp[ii] -= step; mp[jj] += step;
        var mm = x.slice(); mm[ii] -= step; mm[jj] -= step;
        var fpp = ofv(pp), fpm = ofv(pm), fmp = ofv(mp), fmm = ofv(mm);
        if (!isFinite(fpp) || !isFinite(fpm) || !isFinite(fmp) || !isFinite(fmm)) return null;
        var v = (fpp - fpm - fmp + fmm) / (4 * step * step);
        H[ii][jj] = v; H[jj][ii] = v;
      }
      return H;
    }
    function covFromH(H) {
      if (!H) return null;
      for (var d = 0; d < n; d++) if (!(H[d][d] > 0)) return null;
      if (!isPositiveDefinite(H)) return null;
      var inv = invertSPD(H);
      if (!inv) return null;
      var cov = new Array(n); for (var r3 = 0; r3 < n; r3++) {
        cov[r3] = new Array(n);
        for (var c3 = 0; c3 < n; c3++) cov[r3][c3] = 2 * inv[r3][c3];
      }
      // symmetrize
      for (var a2 = 0; a2 < n; a2++) for (var b2 = a2 + 1; b2 < n; b2++) {
        var avg = (cov[a2][b2] + cov[b2][a2]) / 2;
        cov[a2][b2] = cov[b2][a2] = avg;
      }
      return cov;
    }
    function condScore(cov) {
      var diag = cov.map(function (r, i) { return r[i]; });
      var mx = Math.max.apply(null, diag), mn = Math.min.apply(null, diag);
      return mx / Math.max(1e-12, mn);
    }
    var best = null, bestCond = Infinity, bestH = h;
    [h, h / 2].forEach(function (step) {
      var cov = covFromH(hessAt(step));
      if (cov) {
        var cond = condScore(cov);
        if (isFinite(cond) && cond < bestCond) { best = cov; bestCond = cond; bestH = step; }
      }
    });
    if (best) return { cov: best, fallback: false, h: bestH };
    // fallback: 0.25 * Omega diagonal (0 covariance)
    var fb = new Array(n); for (var r = 0; r < n; r++) {
      fb[r] = new Array(n).fill(0);
      fb[r][r] = 0.25 * (vars[r] != null ? vars[r] : 1);
    }
    return { cov: fb, fallback: true, h: h };
  }

  /* Effective sample size of a (possibly autocorrelated) chain, via the initial
   * monotone positive sequence estimator (Geyer 1992) on the autocorrelation.
   * Audit P3: the kept MCMC draws are autocorrelated; ESS is what the reported
   * Monte-Carlo precision actually rests on. */
  function ess(chain) {
    var n = chain.length;
    if (n < 4) return n;
    var mean = 0, i;
    for (i = 0; i < n; i++) mean += chain[i];
    mean /= n;
    var d0 = 0;
    for (i = 0; i < n; i++) d0 += (chain[i] - mean) * (chain[i] - mean);
    if (d0 <= 0) return n;
    // autocovariances per lag, up to n/4
    var maxLag = Math.min(Math.floor(n / 4), 200);
    var acov = new Array(maxLag + 1);
    for (var lag = 0; lag <= maxLag; lag++) {
      var acc = 0;
      for (i = 0; i < n - lag; i++) acc += (chain[i] - mean) * (chain[i + lag] - mean);
      acov[lag] = acc / n;
    }
    // Geyer initial positive sequence: sum Gamma_m = rho_{2m} + rho_{2m+1}
    // while the pairs stay positive, then enforce monotone decrease.
    var tau = 1;  // = rho_0 term (2*acov[0]/(2*acov[0]) ... see below)
    var prev = Infinity;
    var pairSum = 0;
    for (var m = 0; 2 * m + 1 <= maxLag; m++) {
      var gamma = (acov[2 * m] + acov[2 * m + 1]) / acov[0];
      if (gamma <= 0) break;
      if (gamma > prev) gamma = prev;   // monotone decrease
      prev = gamma;
      pairSum += gamma;
    }
    tau = 1 + 2 * pairSum * (acov[0] > 0 ? 1 : 0);
    // tau here = 1 + 2*sum(rho); wait: rho_k = acov[k]/acov[0]; sum of pairs already
    // includes rho_0 + rho_1 in the m=0 pair, so:
    tau = 1 + 2 * (pairSum - (acov[0] / acov[0]));  // remove the double-counted rho_0
    if (!(tau > 0)) tau = 1;
    var out = n / tau;
    return Math.max(1, Math.min(n, out));
  }

  // ------------------------------- MCMC -----------------------------------
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* Adaptive random-walk Metropolis. OFV = -2 log posterior (up to const). */
  async function runMCMC(ofv, x0, cov, opts, rng, onProgress) {
    opts = opts || {};
    var iters = opts.iters || 4000;
    var maxKeep = opts.maxKeep || 1000;
    var chunk = opts.chunk || 200;
    /* v0.13.0: the total iteration budget is split across several chains from
     * overdispersed starts so that split-R-hat can detect a chain that never
     * found the posterior. Effective sample size measures mixing *within*
     * whatever region a chain reached and cannot see that failure. */
    var nChains = Math.max(1, Math.floor(opts.chains || 1));
    var perChain = Math.max(100, Math.floor(iters / nChains));
    var burnIn = Math.floor(perChain * 0.4);
    // ceil (not floor) so maxKeep is actually honoured across all chains
    var keepEvery = Math.max(1, Math.ceil((perChain - burnIn) * nChains / maxKeep));

    // Cholesky of the proposal covariance (symmetrized, N x N; N = eta dim).
    // For N = 2 this is algebraically identical to the former hand-written
    // 2x2 factor, so 2-eta chains remain reproducible.
    var nD = x0.length;
    var C = new Array(nD);
    for (var ci = 0; ci < nD; ci++) {
      C[ci] = new Array(nD);
      for (var cj = 0; cj < nD; cj++) C[ci][cj] = (cov[ci][cj] + cov[cj][ci]) / 2;
    }
    for (ci = 0; ci < nD; ci++) if (!(C[ci][ci] > 0)) C[ci][ci] = 1e-4;
    var Lc = choleskyDecomp(C);
    if (!Lc) { // proposal covariance not PD: safe diagonal fallback
      Lc = new Array(nD);
      for (ci = 0; ci < nD; ci++) { Lc[ci] = new Array(nD).fill(0); Lc[ci][ci] = Math.sqrt(C[ci][ci]); }
    }

    // Initialize the step-size from the proposal (Laplace) scale rather than a
    // fixed 0.6 — a sharply identified posterior starts smaller, a flat one
    // larger, which shortens burn-in (audit P4c).
    var meanVar = 0;
    for (ci = 0; ci < nD; ci++) meanVar += C[ci][ci];
    var logS0 = Math.log(Math.min(2, Math.max(0.05, Math.sqrt(meanVar / nD))));

    var g = gaussFactory(rng);
    var z = new Array(nD), prop = new Array(nD);
    var draws = [], chains = [];
    var accPost = 0, nPost = 0, logS = logS0;
    var totalIters = perChain * nChains, done = 0;

    for (var chain = 0; chain < nChains; chain++) {
      var x = x0.slice();
      if (chain > 0) {
        /* Overdispersed start: ~2 proposal SDs from the mode. Chains that agree
         * from here have genuinely mixed; a chain stuck elsewhere shows up as
         * split-R-hat > 1. */
        for (ci = 0; ci < nD; ci++) z[ci] = g();
        for (ci = 0; ci < nD; ci++) {
          var dsp = 0;
          for (var dj = 0; dj <= ci; dj++) dsp += Lc[ci][dj] * z[dj];
          x[ci] += 2 * dsp;
        }
      }
      var fx = ofv(x);
      if (!isFinite(fx)) { x = x0.slice(); fx = ofv(x); }

      logS = logS0;
      var accWin = 0, adaptWin = 0;
      var chainDraws = [];

      for (var it = 0; it < perChain; it++) {
        for (ci = 0; ci < nD; ci++) z[ci] = g();
        for (ci = 0; ci < nD; ci++) {
          var accL = 0;
          for (var cj2 = 0; cj2 <= ci; cj2++) accL += Lc[ci][cj2] * z[cj2];
          prop[ci] = x[ci] + Math.exp(logS) * accL;
        }
        var fprop = ofv(prop);
        var accepted = false;
        if (isFinite(fprop)) {
          var logr = -0.5 * (fprop - fx);
          if (Math.log(rng() + 1e-300) < logr) { x = prop.slice(); fx = fprop; accepted = true; }
        }
        if (accepted) accWin++;
        if (it >= burnIn) { nPost++; if (accepted) accPost++; }

        if (it < burnIn && (it + 1) % 50 === 0) {
          var rate = accWin / 50; accWin = 0;
          logS += (rate - 0.3);
          logS = Math.min(Math.max(logS, Math.log(0.05)), Math.log(5));
        } else if (it >= burnIn && (it + 1) % 200 === 0) {
          /* Continued adaptation repairs a mis-tuned burn-in scale (audit P3),
           * but a constant gain violates the diminishing-adaptation condition,
           * so the kept chain would not be guaranteed to target the posterior.
           * v0.13.0: the gain now decays as 1/sqrt(window), which satisfies it. */
          adaptWin++;
          var rateS = accWin / 200; accWin = 0;
          logS += (0.25 / Math.sqrt(adaptWin)) * (rateS - 0.3);
          logS = Math.min(Math.max(logS, Math.log(0.05)), Math.log(5));
        }
        if (it >= burnIn && ((it - burnIn) % keepEvery === 0)) chainDraws.push(x.slice());

        done++;
        if (onProgress && done % chunk === 0) { onProgress(done / totalIters); await tick(); }
      }

      chains.push(chainDraws);
      for (var kd = 0; kd < chainDraws.length; kd++) draws.push(chainDraws[kd]);
    }

    var rhat = null;
    if (nChains > 1) {
      rhat = [];
      for (var rd = 0; rd < nD; rd++) rhat.push(splitRhat(chains, rd));
    }
    return {
      draws: draws,
      chains: chains,
      nChains: nChains,
      rhat: rhat,
      // acceptance over the kept (post-burn-in) iterations only — the previous
      // figure averaged in the adaptation phase and read high
      acceptance: nPost ? accPost / nPost : 0,
      logS: logS
    };
  }

  /* Shared preamble for split-R-hat AND split-chain bulk ESS (F6, independent
   * audit 2026-09-13): both diagnostics need the SAME definition of "the
   * segments under comparison" -- each chain halved, the shorter segment
   * length used throughout -- or R-hat warning and ESS looking fine could be
   * silently comparing different data. Returns null when there are too few
   * segments or the within-segment variance is degenerate (mirrors
   * splitRhat's own pre-v0.24.0 guards exactly, just factored out). */
  function splitChainStats(chains, dim) {
    var segs = [], c, h;
    for (c = 0; c < chains.length; c++) {
      var ch = chains[c];
      if (!ch || ch.length < 4) continue;
      h = Math.floor(ch.length / 2);
      segs.push(ch.slice(0, h));
      segs.push(ch.slice(h, 2 * h));
    }
    if (segs.length < 2) return null;
    var n = Infinity, s, k;
    for (s = 0; s < segs.length; s++) n = Math.min(n, segs[s].length);
    if (!(n > 1)) return null;
    var means = [], vars = [];
    for (s = 0; s < segs.length; s++) {
      var m = 0;
      for (k = 0; k < n; k++) m += segs[s][k][dim];
      m /= n;
      var v = 0;
      for (k = 0; k < n; k++) { var d = segs[s][k][dim] - m; v += d * d; }
      means.push(m); vars.push(v / (n - 1));
    }
    var mm = 0, j;
    for (j = 0; j < means.length; j++) mm += means[j];
    mm /= means.length;
    var B = 0;
    for (j = 0; j < means.length; j++) B += (means[j] - mm) * (means[j] - mm);
    B = B * n / (means.length - 1);
    var W = 0;
    for (j = 0; j < vars.length; j++) W += vars[j];
    W /= vars.length;
    if (!(W > 1e-14)) return null;
    var varPlus = ((n - 1) / n) * W + B / n;
    return { segs: segs, n: n, means: means, W: W, varPlus: varPlus };
  }

  /* Split-R-hat (Gelman et al.): each chain is halved and the between-segment
   * variance is compared with the within-segment variance. ~1 means the chains
   * describe the same distribution; > 1.05 is a convergence warning. Returns
   * null when there are too few segments or the within-variance is degenerate. */
  function splitRhat(chains, dim) {
    var st = splitChainStats(chains, dim);
    return st ? Math.sqrt(st.varPlus / st.W) : null;
  }

  /* Split-chain bulk ESS (Vehtari et al. 2021 / Stan), replacing a pooled
   * single-chain ess() call that ran Geyer's estimator on ALL chains
   * concatenated together (F6, independent audit 2026-09-13). Concatenating
   * unmixed chains does not reliably bias the pooled estimate in one
   * direction -- it can read too high or too low -- which is exactly why a
   * pooled number cannot be trusted alongside split-R-hat: the two were not
   * even asking the same question. This uses the SAME chain-halving as
   * splitRhat (splitChainStats), so a fit that R-hat flags as unmixed is
   * measured by the same segments ESS reports on, not a different pooling.
   *
   * Per split-chain autocovariance is centered on that split-chain's OWN mean,
   * then averaged across split-chains -- a chain stuck in a different region
   * contributes its own (possibly high) autocorrelation without dragging
   * another chain's estimate toward a spurious cross-chain mean. Geyer's
   * initial monotone positive sequence (same style as the single-chain ess()
   * above) truncates the lag sum; rho at lag 0 is fixed at 1 by definition
   * (Vehtari et al.), not derived from dividing something by itself. */
  function bulkEss(chains, dim) {
    var st = splitChainStats(chains, dim);
    if (!st || !(st.varPlus > 1e-14)) return null;
    var segs = st.segs, n = st.n, means = st.means, W = st.W, varPlus = st.varPlus;
    if (n < 4) return segs.length * n;
    var maxLag = Math.min(Math.floor(n / 4), 200);
    var acovBar = new Array(maxLag + 1).fill(0);
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s], m = means[s];
      for (var lag = 0; lag <= maxLag; lag++) {
        var acc = 0;
        for (var k = 0; k < n - lag; k++) acc += (seg[k][dim] - m) * (seg[k + lag][dim] - m);
        acovBar[lag] += (acc / n) / segs.length;
      }
    }
    function rhoHat(lag) { return lag === 0 ? 1 : 1 - (W - acovBar[lag]) / varPlus; }
    var prev = Infinity, pairSum = 0;
    for (var mLag = 0; 2 * mLag + 1 <= maxLag; mLag++) {
      var gamma = rhoHat(2 * mLag) + rhoHat(2 * mLag + 1);
      if (gamma <= 0) break;
      if (gamma > prev) gamma = prev;
      prev = gamma;
      pairSum += gamma;
    }
    var tau = -1 + 2 * pairSum;
    if (!(tau > 0)) tau = 1;
    var total = segs.length * n;
    var out = total / tau;
    return Math.max(1, Math.min(total, out));
  }

  // ------------------------- Prior / draws --------------------------------
  /* Sample eta vectors from N(0, Omega) via the Cholesky factor. Omega is
   * diagonal except the 2x2 CL-V1 block when cov != 0 (ravulizumab).
   * Dimension = omega.dims (falls back to 2 for legacy {cl,v1,cov} objects);
   * for crovalimab the full 6-eta vector (incl. ka, F-logit) is drawn.
   * For 2-eta omega this is algebraically identical to the former hand-written
   * factor, so seeded chains stay reproducible. */
  function priorDraws(n, omega, rng) {
    var g = gaussFactory(rng);
    var vars = omega.vars || [omega.cl, omega.v1];
    var nD = omega.dims || vars.length || 2;
    var cov = new Array(nD);
    for (var i = 0; i < nD; i++) {
      cov[i] = new Array(nD).fill(0);
      cov[i][i] = Math.max(0, vars[i] != null ? vars[i] : 0);
    }
    if (Math.abs(omega.cov || 0) > 1e-12 && nD >= 2) cov[0][1] = cov[1][0] = omega.cov;
    var L = choleskyDecomp(cov);
    if (!L) { // degenerate omega: independent draws
      L = new Array(nD);
      for (i = 0; i < nD; i++) { L[i] = new Array(nD).fill(0); L[i][i] = Math.sqrt(Math.max(1e-9, vars[i] || 0)); }
    }
    var out = [];
    for (var d = 0; d < n; d++) {
      var z = new Array(nD), v = new Array(nD).fill(0);
      for (i = 0; i < nD; i++) z[i] = g();
      for (i = 0; i < nD; i++) for (var j = 0; j <= i; j++) v[i] += L[i][j] * z[j];
      out.push(v);
    }
    return out;
  }

  /* Population-prior random effects for the auxiliary (non-estimated)
   * parameters — ka and SC bioavailability (crovalimab $OMEGA items 5 and 6).
   * Sampled once per band draw; NEVER used in MAP estimation or the MCMC
   * likelihood, so individualization behaviour is unchanged. F is sampled on
   * the logit scale when the spec declares fLogit (matching the control
   * stream's logit-transformed F1). */
  function auxDraws(n, drugId, rng) {
    var s = M.spec(drugId);
    if (!s || !s.OMEGA_AUX) return null;
    var g = gaussFactory(rng);
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
      out[i] = { etaKA: Math.sqrt(s.OMEGA_AUX.ka) * g(), etaF: Math.sqrt(s.OMEGA_AUX.f) * g() };
    }
    return out;
  }

  function subsample(arr, n) {
    if (arr.length <= n) return arr.slice();
    var step = arr.length / n, out = [];
    for (var i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  // --------------------- Simulation across draws --------------------------
  async function simulateDraws(draws, doses, times, wt, disease, onProgress, chunk, age, drugId, auxPerDraw) {
    var etaDim = M.etaDim ? M.etaDim(drugId) : 2;
    var mat = new Array(draws.length);
    for (var d = 0; d < draws.length; d++) {
      var dr = draws[d];
      // Full-dimension eta vectors (N-eta engine) already carry ka/F
      // (crovalimab) in the tail; the aux mechanism applies only to legacy
      // 2-eta draws used by older band paths/tests.
      var p = dr.length >= etaDim
        ? M.indivParams(wt, disease, dr, drugId, age)
        : M.indivParams(wt, disease, dr[0], dr[1], drugId, age, auxPerDraw ? auxPerDraw[d] : null);
      var sim = M.simulate(doses, times, p, { rtol: 1e-6, id: drugId });
      mat[d] = sim.failed ? null : sim.c;
      if (onProgress && d % (chunk || 64) === 0) {
        onProgress(d / draws.length);
        await tick();
      }
    }
    return mat;
  }

  function quantileSorted(sorted, q) {
    if (!sorted.length) return NaN;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /* mat: rows = draws (may contain null), cols = times. */
  function statsOfMatrix(mat) {
    var nCol = 0;
    for (var i = 0; i < mat.length; i++) if (mat[i]) { nCol = mat[i].length; break; }
    var med = [], p5 = [], p95 = [];
    var col = new Array(mat.length);
    for (var c = 0; c < nCol; c++) {
      var k = 0;
      for (var r = 0; r < mat.length; r++) if (mat[r]) col[k++] = mat[r][c];
      col.length = k;
      if (!k) { med.push(NaN); p5.push(NaN); p95.push(NaN); continue; }
      col.sort(function (a, b) { return a - b; });
      med.push(quantileSorted(col, 0.5));
      p5.push(quantileSorted(col, 0.05));
      p95.push(quantileSorted(col, 0.95));
    }
    return { med: med, p5: p5, p95: p95, nValid: mat.filter(function (r) { return r; }).length };
  }

  function probAbove(mat, colIdx, threshold) {
    var ok = 0, n = 0;
    for (var r = 0; r < mat.length; r++) {
      if (!mat[r]) continue;
      n++;
      if (mat[r][colIdx] > threshold) ok++;
    }
    return n ? ok / n : 0;
  }

  // --------------------------- Grid helpers -------------------------------
  /* Per-eta DATA-INFORMATIVENESS: 1 - posterior variance / prior variance.
   * 0 = the samples taught us nothing about this eta (it stays on the
   * population prior); 1 = it is fully determined by the measurements.
   *
   * Deliberately NOT called shrinkage: classical eta-shrinkage is
   * 1 - SD(EBE)/omega across a POPULATION, where HIGH means the data were
   * uninformative — the opposite polarity to this quantity. Reporting this
   * number under that name inverts its meaning for a pharmacometrician reader
   * (renamed in v0.13.0; the value and its interpretation are unchanged). */
  function etaInformationOf(draws, omega) {
    if (!draws || draws.length < 4) return null;
    var nD = draws[0].length;
    var vars = omega.vars || [omega.cl, omega.v1];
    var out = [];
    for (var i = 0; i < nD; i++) {
      var mean = 0, d;
      for (d = 0; d < draws.length; d++) mean += draws[d][i];
      mean /= draws.length;
      var v = 0;
      for (d = 0; d < draws.length; d++) v += (draws[d][i] - mean) * (draws[d][i] - mean);
      v /= Math.max(1, draws.length - 1);
      var priorVar = vars[i] != null ? vars[i] : 1;
      var sh = 1 - v / Math.max(priorVar, 1e-12);
      out.push(Math.max(0, Math.min(1, sh)));
    }
    return out;
  }

  /* Pearson correlation matrix across the kept draws (per eta column).
   * Exposes the posterior trade-offs: e.g. |corr(etaCL, etaF)| ≈ 0.8 under
   * SC-only sampling means clearance and bioavailability are not separately
   * informed by the data. Returns null when the draws carry no variance. */
  function corrMatrix(draws) {
    if (!draws || draws.length < 4) return null;
    var nD = draws[0].length;
    var means = new Array(nD).fill(0);
    var r, d;
    for (d = 0; d < draws.length; d++) for (r = 0; r < nD; r++) means[r] += draws[d][r];
    for (r = 0; r < nD; r++) means[r] /= draws.length;
    var sds = new Array(nD).fill(0);
    for (d = 0; d < draws.length; d++) for (r = 0; r < nD; r++) {
      var dv = draws[d][r] - means[r];
      sds[r] += dv * dv;
    }
    for (r = 0; r < nD; r++) sds[r] = Math.sqrt(sds[r] / Math.max(1, draws.length - 1));
    var C = new Array(nD);
    for (r = 0; r < nD; r++) {
      C[r] = new Array(nD).fill(0);
      C[r][r] = 1;
    }
    for (var a = 0; a < nD; a++) for (var b = a + 1; b < nD; b++) {
      var cov = 0;
      for (d = 0; d < draws.length; d++) cov += (draws[d][a] - means[a]) * (draws[d][b] - means[b]);
      cov /= Math.max(1, draws.length - 1);
      var denom = sds[a] * sds[b];
      var corr = denom > 1e-12 ? cov / denom : 0;
      if (!isFinite(corr)) corr = 0;
      corr = Math.max(-1, Math.min(1, corr));
      C[a][b] = C[b][a] = corr;
    }
    return C;
  }

  /* Modal inter-dose interval of the more recent half of the schedule (the
   * loading phase of a regimen can otherwise distort the overall mode). */
  /* Most common spacing between the later doses. When it cannot be derived
   * (a single dose), fall back to the SELECTED DRUG's own maintenance interval
   * rather than a hardcoded 14 days — for a q8w drug such as ravulizumab the
   * old fallback reported a trough six weeks too early, at a far higher
   * concentration and with P(>target) near 1 (v0.13.0). */
  function modalInterval(doses, fallback) {
    var def = fallback > 0 ? fallback : (M.drug().ssIntervalDefault || 14);
    var best = def, bestN = 0;
    var counts = {};
    /* v0.45.0 (review S1): a drug with a declared loading phase (crovalimab: five
     * doses) reads its interval from the post-loading doses only. Counting the
     * loading spacings made the app assume the 7-day loading interval for six to
     * eight doses, i.e. weekly maintenance. */
    var lc = M.drug().loadingDoseCount || 0;
    var src = (lc > 0 && doses.length > lc) ? doses.slice(lc) : doses;
    var start = Math.max(1, Math.floor(src.length / 2));
    for (var i = start; i < src.length; i++) {
      var k = Math.round((src[i].t - src[i - 1].t) * 100) / 100;
      if (!(k > 0)) continue;
      counts[k] = (counts[k] || 0) + 1;
      /* >= : on a tie the MOST RECENT interval wins. The old strict > kept the
       * oldest mode, so weekly x4 then q14d (seven doses) stayed at q7d. */
      if (counts[k] >= bestN) { bestN = counts[k]; best = k; }
    }
    return best;
  }

  /* v0.45.0 (review S1): true when the last two spacings disagree -- an interval
   * was just changed, or the loading phase just ended -- so the interval derived
   * from the history is not a reliable statement of the regimen. Tolerance: a
   * day or two of jitter, or a quarter of the interval, is not a change (14 then
   * 17 days is one late dose; 14 then 21 is an extension). Like modalInterval,
   * a drug with a loading phase is judged on its post-loading doses only. */
  function spacingUnsettled(doses) {
    var lc = M.drug().loadingDoseCount || 0;
    var src = (lc > 0 && doses.length > lc) ? doses.slice(lc) : doses;
    var n = src.length;
    if (n < 3) return false;
    var g1 = src[n - 1].t - src[n - 2].t, g2 = src[n - 2].t - src[n - 3].t;
    if (!(g1 > 0 && g2 > 0)) return false;
    return Math.abs(g1 - g2) > Math.max(2, 0.25 * Math.max(g1, g2));
  }

  function buildGrid(doses, horizon, interval, windowStart, dur) {
    var lo = windowStart || 0;
    var seen = Object.create(null);
    var pts = [];
    function add(v) {
      if (v < lo - 1e-9 || v > horizon + 1e-9) return;
      var k = Math.round(v * 1e6) / 1e6;
      if (!seen[k]) { seen[k] = 1; pts.push(k); }
    }
    for (var t = lo; t <= horizon + 1e-9; t += 0.5) add(t);
    var dur = dur != null ? dur : M.drug().INFUSION_D;
    for (var i = 0; i < doses.length; i++) {
      var d = doses[i];
      for (var s = 0; s <= 8; s++) add(d.t + s * 0.1);
      add(d.t - 1e-6);
      /* Custom infusion times (2026-09-14): this used to add the point at
       * `d.t + dur` -- the DRUG-WIDE default duration, not this dose's own.
       * For a dose with a custom `d.dur` (now possible: 10-360 min, all
       * comfortably inside the fixed s*0.1 backdrop's own 0-0.8-day span
       * above, so no other change is needed here), the true end-of-infusion
       * instant was never added, only an irrelevant point at wherever the
       * DEFAULT infusion would have ended -- the same class of "grid built
       * for the wrong dose shape" bug fixed in v0.27.0 for a different
       * trigger (the chart's projected-continuation doses). */
      add(d.t + (d.dur != null ? d.dur : dur));
    }
    var hStart = Math.max(lo, horizon - 1.5 * (interval || 14));
    for (var t2 = hStart; t2 <= horizon + 1e-9; t2 += 0.25) add(t2);
    pts.sort(function (a, b) { return a - b; });
    return pts.slice(0, 5000);
  }

  /* Trough times: just before each dose from the 2nd onward + one virtual
   * next dose at lastDose + modal interval. */
  function troughTimesOf(doses, interval, planned, noAssume) {
    var out = [];
    for (var i = 1; i < doses.length; i++) out.push(doses[i].t - 1e-6);
    var vt = noAssume ? null : virtualTroughTime(doses, interval, planned);
    if (vt != null) out.push(vt);
    return out.sort(function (a, b) { return a - b; });
  }

  /* The one trough that does NOT correspond to an entered dose: it assumes the
   * next administration happens one interval after the last entered one. The UI
   * labels this row so it is never read as scheduled data.
   *
   * v0.32.0: requires at least TWO real doses. With only one, `interval` is
   * necessarily modalInterval()'s drug-default fallback (there is no second
   * dose to derive a real one from) -- projecting a continuation from that
   * would not be "the patient's own regimen, continued," it would be a guess
   * dressed up as one. Author-reported: entering exactly one dose showed a
   * second, "assumed" one on both the chart and the trough table that had
   * nothing to do with anything the clinician had actually entered. */
  /* v0.40.0: `planned` (truthy) means the clinician entered the future
   * regimen themselves, so the interval is theirs, not derived from history,
   * and a single entered dose is enough. */
  function virtualTroughTime(doses, interval, planned) {
    if (!doses.length || (doses.length < 2 && !planned)) return null;
    var iv = interval > 0 ? interval : (M.drug().ssIntervalDefault || 14);
    return doses[doses.length - 1].t + iv - 1e-6;
  }

  // ------------------------------ runFit ----------------------------------
  /* input: { wt, age?, disease, doses:[{t,amt,route?}], obs:[{t,c,lloq?}],
   *          lloq, target, seed?, mcmcIters? }
   * cb:    { progress(frac, msg) }
   * returns fit result (see README). */
  async function runFit(input, cb) {
    var T0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    cb = cb || {};
    var prog = cb.progress || function () {};
    var drug = input.drug || M.drug().id;
    if (!M.drugs[drug]) throw new Error('Unknown drug: ' + drug);
    M.select(drug);   // model functions below act on the selected spec
    if (M.drug().pending) {
      throw new Error(M.drug().label + ' is prepared but its population PK parameters are not yet available (NONMEM control stream pending).');
    }
    var disease = input.disease || 'PNH';
    var age = input.age > 0 ? input.age : null;
    var omega = M.priorOmega(disease);
    var rng = mulberry32(input.seed != null ? input.seed : 20250907);
    var doses = input.doses.slice().sort(function (a, b) { return a.t - b.t; });
    // Observations may have negative times (e.g. steady-state mode, where day 0 is
    // the latest dose and troughs were drawn before it). The UI filters out samples
    // taken before the first dose in full-schedule mode.
    var obs = (input.obs || [])
      .filter(function (o) { return isFinite(o.t) && (isFinite(o.c) || o.lloq); })
      .map(function (o) { return { t: o.t, c: o.c, lloq: !!o.lloq, exclude: !!o.exclude, note: o.note || '' }; });
    /* v0.13.0 — samples the clinician has flagged (drawn after plasma exchange,
     * apheresis or CRRT, or with a documented pre-analytical problem) are still
     * shown on the chart and printed in the report, but contribute nothing to
     * the likelihood. Without this, one such sample is fitted exactly and
     * becomes a permanent, confidently-wrong individual clearance that every
     * diagnostic then reports as a good fit. */
    var obsFit = obs.filter(function (o) { return !o.exclude; });
    // A censored sample is only usable when the LLOQ is actually known — without
    // it the M3 likelihood is undefined. Fail loudly rather than silently treating
    // the sample as a concentration of 0.
    if (obsFit.some(function (o) { return o.lloq && !(input.lloq > 0); })) {
      throw new Error('A measurement is flagged below LLOQ but no LLOQ value is set — enter the assay LLOQ under Assay settings.');
    }

    if (!doses.length) throw new Error('At least one dose is required to run a forecast.');
    /* F21 (independent audit, 2026-09-13): the engine's time unit is DAYS
     * everywhere. A caller that accidentally passes epoch-milliseconds (a
     * plausible mistake for any future/headless caller building `doses`/`obs`
     * straight from Date.now()-style values, since the UI itself converts
     * ms -> days in relContext() before doses/obs ever reach runFit) would not
     * fail loudly — buildGrid()'s day-stepped loop would just iterate roughly
     * 10^8 times trying to cover a multi-million-day horizon, silently hanging
     * rather than erroring. 1e5 days is ~274 years — far beyond any real
     * relative time this app ever produces, and far below any real epoch-ms
     * value (Date.now() is on the order of 10^12) — so this cannot reject a
     * legitimate case while catching the mistake immediately, before any
     * simulation work starts. */
    var allTimes = doses.map(function (d) { return d.t; }).concat(obs.map(function (o) { return o.t; }));
    if (allTimes.some(function (tv) { return Math.abs(tv) > 1e5; })) {
      throw new Error('A dose or measurement time looks like milliseconds, not days — this engine’s time unit is days throughout. Convert to days before calling runFit.');
    }
    /* v0.44.0 (review H2): NaN is not caught by the comparison above (NaN > 1e5
     * is false), and a NaN event time used to send simulate() into an infinite
     * loop -- an unparseable date in an imported session froze the tab. Observation
     * times are already filtered by isFinite above; dose times are checked here. */
    if (doses.some(function (d) { return !isFinite(d.t); })) {
      throw new Error('A dose has no valid time (not a number) — check the dose dates.');
    }
    /* Custom infusion times (2026-09-14, author-approved plan). `d.dur` is in
     * DAYS (the engine's native unit) throughout -- the UI works in minutes
     * and converts at its own boundary, exactly like dose-dt/obs-dt already
     * convert epoch-ms to days before reaching here. This is a defensive
     * backstop, the same dual-layer pattern already used for weight and age
     * (UI-level alert + engine-level throw): a non-positive duration would
     * make `rate = amt/dd` in M.simulate() infinite or negative, and the
     * clinical 10-360 min bound is exactly the kind of fact a units mistake
     * (minutes entered as hours, or vice versa) would violate immediately --
     * catching it here means a caller that bypasses the UI (JSON import, a
     * future headless caller, a test) cannot silently feed the ODE a
     * nonsensical rate. spec.infusionMinutes is the SAME bound the UI itself
     * enforces, not a second, independently-chosen number. */
    var infusionRangeD = M.drug().infusionMinutes
      ? { min: M.drug().infusionMinutes.min / 1440, max: M.drug().infusionMinutes.max / 1440 }
      : null;
    if (infusionRangeD) {
      doses.forEach(function (d) {
        if (d.dur == null || d.route === 'sc' || d.bolus) return;
        if (!(d.dur >= infusionRangeD.min && d.dur <= infusionRangeD.max)) {
          throw new Error('A dose’s infusion duration (' + Math.round(d.dur * 1440) + ' min) is outside the ' +
            M.drug().infusionMinutes.min + '–' + M.drug().infusionMinutes.max + ' minute range — check the units (minutes, not hours or days).');
        }
      });
    }
    /* Author-approved plan (2026-09-14): a sample drawn WHILE an infusion is
     * still running is real -- either the concentration is genuinely still
     * rising (mid zero-order-infusion), or, just as likely in practice, the
     * sample was drawn through the same line the infusion is running
     * through and is contaminated/diluted -- either way it "may impact
     * estimation," in the author's own words, and the clinician should be
     * told, not left to notice a discordant fit on their own. Checked
     * against every FITTED sample only (obsFit) -- an excluded sample does
     * not reach the likelihood, so it cannot impact estimation regardless.
     * Every IV dose has SOME duration (custom or the drug default), so this
     * check is well-defined uniformly across full-schedule and steady-state
     * doses alike, with no special-casing between the two. */
    var samplesDuringInfusion = [];
    obsFit.forEach(function (o) {
      doses.forEach(function (d) {
        if (d.route === 'sc' || d.bolus) return;
        var dd = d.dur != null ? d.dur : M.drug().INFUSION_D;
        if (o.t > d.t + 1e-9 && o.t < d.t + dd - 1e-9) {
          samplesDuringInfusion.push({ obsT: o.t, doseT: d.t, doseDurMin: Math.round(dd * 1440) });
        }
      });
    });
    // Body weight is a covariate of every model — without it the allometric
    // scaling would silently evaluate to zero clearance. Fail loudly instead.
    // F8 (independent audit, 2026-09-13): widened from 35-200 kg -- the old
    // hard cap refused a real, plausible obese PNH/aHUS patient outright
    // rather than flagging the extrapolation. The range is the author's own
    // per-drug scope decision (spec.weightRange; v0.38.0 lowered eculizumab's
    // minimum to 3 kg so very young children can be monitored).
    var wtRange = M.drug().weightRange || { min: 25, max: 300 };
    if (!(input.wt >= wtRange.min && input.wt <= wtRange.max)) {
      throw new Error('Body weight is required (' + wtRange.min + '–' + wtRange.max + ' kg) — it is a covariate of the model.');
    }
    /* F8 (independent audit, 2026-09-13): engine-level backstop, mirroring the
     * weight check above -- the UI already refuses to run below this age, but
     * a direct call (JSON import, a test, a future headless caller) must not
     * silently extrapolate the absorption-rate covariate into a range with no
     * data at all. pediatricWarnAge (12-16 inclusive here) is a WARNING, not a
     * throw -- exported as pediatricWarn below for the UI to disclose. Only
     * crovalimab declares these fields; this is a no-op for the other two. */
    if (M.drug().pediatricBlockAge && age != null && age < M.drug().pediatricBlockAge) {
      throw new Error(M.drug().label + ' requires an age of at least ' + M.drug().pediatricBlockAge +
        ' years — the model was not developed for younger children.');
    }
    var pediatricWarn = !!(M.drug().pediatricWarnAge && age != null &&
      age >= (M.drug().pediatricBlockAge || 0) && age < M.drug().pediatricWarnAge);
    var target = input.target != null ? input.target : null;
    if (target != null && !isFinite(target)) {
      throw new Error('The trough target must be a number — correct or clear the field.');
    }
    /* v0.40.0 (user feedback): an optional clinician-entered regimen for AFTER
     * the last entered dose. When given, it replaces modalInterval()'s guess
     * from the history (which reverts to the old interval right after an
     * interval extension, and to the loading interval right after loading)
     * for everything forward-looking: the chart continuation, the "next dose"
     * trough row and the forecast horizon. It never reaches the likelihood:
     * the fit itself uses the entered doses only, exactly as before. */
    var planned = (input.planned && input.planned.amt > 0 && input.planned.interval > 0)
      ? { amt: +input.planned.amt, interval: +input.planned.interval } : null;
    var interval = planned ? planned.interval : modalInterval(doses);
    var lastDose = doses[doses.length - 1].t;
    var maxObs = obs.length ? Math.max.apply(null, obs.map(function (o) { return o.t; })) : 0;
    // Forecast window: last year of recorded history + 1.5 intervals ahead of the
    // last dose (or just after the latest observation). The simulation always
    // integrates from the true first dose for correctness.
    var horizon = Math.max(lastDose + 1.5 * interval, maxObs + 7);
    // Explicit window (steady-state mode passes a negative start so previous
    // cycles are shown); otherwise the last year of recorded history is used.
    var windowStart = input.windowStart != null
      ? input.windowStart
      : Math.max(0, lastDose - 365);
    /* Chart-only continuation doses (v0.15.0), computed here — BEFORE the
     * grid — rather than down in the chart-continuation block below, where
     * they used to be computed. Reason (found 2026-09-14, driving the real
     * app): buildGrid() adds fine per-dose time points (near each dose's
     * peak and pre-dose instant) only for the doses it is GIVEN. When the
     * grid was built from `doses` alone and the chart simulation was then
     * run over `doses.concat(chartProjectedDoses)`, every projected dose's
     * peak/trough fell in a region with only the coarse half-day background
     * grid — no fine points at all — so the RENDERED curve for those cycles
     * silently flattened into a shorter, duller hump than the real ones on
     * either side of it, even though the underlying simulation itself was
     * perfectly periodic (confirmed: the pre-dose trough at every REAL dose
     * stayed numerically constant; only the visual sampling of the
     * projected ones was sparse). `buildGrid` only reads doses to add time
     * points around them — it has no other effect — so folding
     * `chartProjectedDoses` in here is safe: it cannot change `ctx.doses`,
     * `troughs`, or anything the fit itself depends on, all of which
     * continue to use the real `doses` array exactly as before, elsewhere
     * in this function. See `loadingPhase`'s own comment below for why the
     * continuation can be empty (crovalimab, still in its loading phase). */
    var contSpec = M.drug();
    /* v0.45.0 (review S1): the loading guard now runs through the FIRST
     * MAINTENANCE dose (loadingDoseCount + 1 doses). The sixth crovalimab dose is
     * the first maintenance one and the gap to the next is still unknown; with
     * only five covered, six to eight doses read the loading spacing as q7d. */
    var loadingPhase = doses.length > 0 && doses.length <= (contSpec.loadingDoseCount ? contSpec.loadingDoseCount + 1 : 0);
    var unsettled = spacingUnsettled(doses);
    /* May the app assume or project a next administration? Only when the regimen
     * is the clinician's own (planned) or the history states one unambiguously.
     * Otherwise it does not guess: no assumed trough, no projected doses, and the
     * regimen explorer is not prefilled with a guessed interval. */
    var assume = !!planned || (!loadingPhase && !unsettled);
    var intervalTrusted = !!planned || (doses.length >= 2 && !loadingPhase && !unsettled);
    var contRoute = contSpec.adminRoutes ? contSpec.adminRoutes.subsequent : (doses[doses.length - 1].route || null);
    var contAmt = planned ? planned.amt : doses[doses.length - 1].amt;
    var chartProjectedDoses = [];
    /* v0.32.0: also requires at least two real doses, same reasoning as
     * virtualTroughTime() above -- with only one dose, `interval` is
     * necessarily the drug-default fallback, and drawing a "continuation"
     * from a single data point is a guess, not a continuation. */
    if (assume && (doses.length >= 2 || planned)) {
      for (var pc = 1; pc <= 30; pc++) {
        var pt = lastDose + pc * interval;
        if (pt >= horizon) break;
        chartProjectedDoses.push({ t: pt, amt: contAmt, route: contRoute });
      }
    }
    var grid = buildGrid(doses.concat(chartProjectedDoses), horizon, interval, windowStart, M.drug().INFUSION_D);

    // ---- prior predictive ----
    prog(0.02, 'Prior predictive simulation…');
    var priorEta = priorDraws(input.priorDraws || 1000, omega, rng);   // audit P6: 400 → 1000 (stable band tails)
    // v0.8.1: sample the non-estimated absorption variability (crovalimab ka, F)
    // from the population prior in the BAND simulations only (MAP/MCMC unchanged)
    // v0.8.1 band-only aux sampling is superseded for full-eta drugs: the
    // prior draws already carry every eta (ka/F included). Aux applies only
    // while a drug still runs the legacy 2-eta engine (draw dim < eta dim).
    var priorAux = omega.dims > 2 ? null : auxDraws(priorEta.length, drug, rng);
    var priorMat = await simulateDraws(priorEta, doses, grid, input.wt, disease,
      function (f) { prog(0.02 + 0.16 * f, 'Prior predictive simulation…'); }, 64, age, drug, priorAux);
    var priorBand = statsOfMatrix(priorMat);

    // ---- MAP + MCMC ----
    var mapRes = null, cov = null, covInfo = null, draws = null, acceptance = 0;
    var essCL = null, essV1 = null, essAll = null, essMin = null;
    var etaInformation = null, etaCorr = null;
    var rhat = null, nChains = 0;
    if (obsFit.length) {
      var ctx = { wt: input.wt, age: age, disease: disease, drug: drug, doses: doses, obs: obsFit, lloq: input.lloq || 0, omega: omega, rtol: 1e-6, errMult: input.errMult, recency: input.recency };
      var ofv = makeOfv(ctx);
      prog(0.22, 'MAP estimation…');
      await tick();
      mapRes = mapEstimate(ofv, stepForOmega(omega));   // full-dimension MAP (v0.9.0)
      if (!mapRes.ok || !isFinite(mapRes.f)) {
        throw new Error('MAP estimation failed (simulation error). Please check inputs.');
      }
      covInfo = laplaceCov(ofv, mapRes.x, omega, 0.12);
      cov = covInfo.cov;
      // audit P2/P3: 8000 iterations, keep-every 2 → up to 2400 kept draws;
      // runtime stays ≈ 2–3 s in the browser.
      // v0.9.0: higher-dimensional posteriors (crovalimab 6-eta) get more
      // iterations to reach the same effective sample size.
      var mcmc = await runMCMC(ofv, mapRes.x, cov, {
        iters: input.mcmcIters || (omega.dims > 2 ? 10000 : 8000),
        maxKeep: 2400,
        // v0.13.0: split the budget across chains from overdispersed starts so
        // split-R-hat can detect a chain that never reached the posterior
        chains: input.mcmcChains || 4
      }, rng, function (f) { prog(0.3 + 0.45 * f, 'MCMC posterior sampling…'); });
      draws = mcmc.draws;
      acceptance = mcmc.acceptance;
      rhat = mcmc.rhat;
      nChains = mcmc.nChains;
      if (!draws.length) draws = [mapRes.x.slice()];
      /* F6 (independent audit, 2026-09-13): essAll used to run the pooled,
       * single-chain ess() on ALL chains concatenated together -- so R-hat
       * (already split-chain) and ESS could silently be measuring different
       * things, and a chain that never mixed would not reliably show up as
       * low ESS. bulkEss() uses the SAME chain-halving as splitRhat. */
      essAll = [];
      for (var ed = 0; ed < mapRes.x.length; ed++) {
        essAll.push(bulkEss(mcmc.chains, ed));
      }
      essCL = essAll[0];
      essV1 = essAll.length > 1 ? essAll[1] : null;
      // Worst-informed parameter, not just CL: a 6-eta crovalimab posterior
      // can have ka or F poorly mixed while CL looks fine. null entries
      // (too few usable segments) are excluded rather than treated as 0.
      var essFinite = essAll.filter(function (v) { return v != null && isFinite(v); });
      essMin = essFinite.length ? Math.min.apply(null, essFinite) : null;
      // v0.9.1 identifiability diagnostics: per-eta shrinkage toward the prior
      // (1 − posterior variance / prior variance; 0 = data uninformative for
      // that eta, ~1 = well determined) and the conditional correlation matrix
      // of the posterior draws (which etas trade off, e.g. ka/F vs CL under
      // SC-only sampling). Surfaced by the UI as sampling advice.
      etaInformation = etaInformationOf(draws, omega);
      etaCorr = corrMatrix(draws);
    } else {
      draws = priorEta;
    }

    // ---- posterior predictive on grid + troughs (within the display window) ----
    var troughs = troughTimesOf(doses, interval, planned, !assume).filter(function (t) { return t >= windowStart - 1e-9; });
    // the one trough that assumes a next dose rather than reflecting an entered one
    var virtualT = assume ? virtualTroughTime(doses, interval, planned) : null;
    var outTimes = grid.concat(troughs);
    prog(0.8, 'Posterior predictive simulation…');
    // v0.8.1: the posterior band also carries the population absorption
    // variability (ka, F) — conditional on the fitted CL/V1 posteriors
    var postAux = omega.dims > 2 ? null : (obsFit.length ? auxDraws(draws.length, drug, rng) : priorAux);
    // v0.10.0: individual predictions are needed at the observation times for
    // the GOF diagnostics — merge obs times into the posterior simulation grid
    // (dedup within 1e-6; remember indices so the diagnostics can find them).
    var obsTimes = obs.map(function (o) { return o.t; });
    var simTimes = outTimes.slice();
    var obsTimeIdx = obsTimes.map(function (t) {
      for (var k = 0; k < simTimes.length; k++) if (Math.abs(simTimes[k] - t) < 1e-6) return k;
      simTimes.push(t);
      return simTimes.length - 1;
    });
    var postMat = await simulateDraws(draws, doses, simTimes, input.wt, disease,
      function (f) { prog(0.8 + 0.18 * f, 'Posterior predictive simulation…'); }, 64, age, drug, postAux);

    var gridMat = postMat.map(function (row) { return row ? row.slice(0, grid.length) : null; });
    var band = statsOfMatrix(gridMat);

    /* ---- chart-only continuation (v0.15.0) --------------------------------
     * `band`/`priorBand` above are computed from the clinician's REAL doses
     * only, so past the last of them the curve can only wash out toward
     * zero — which looks like therapy has stopped even for a patient still
     * on a q8w maintenance regimen. This block runs a SEPARATE, display-only
     * simulation that continues the regimen at the patient's own historical
     * dose/interval, for the chart alone. It must never reach:
     *   - `ctx.doses` / the MAP+MCMC likelihood — already computed above,
     *     from the real doses only, and untouched here;
     *   - `troughs`/`troughStats` (below) — computed from the real `doses`;
     *     `virtualTroughTime` lands one instant BEFORE the first projected
     *     dose's administration time, so it is causally identical whichever
     *     doses array reaches it (PK cannot see a dose before it is given) —
     *     it must keep using the real `doses` so nothing here can silently
     *     shift the "assumed dose" trough that the table already reports.
     *
     * `chartProjectedDoses` itself (and `loadingPhase`) is computed earlier
     * now, before `grid` — see that comment for why (grid resolution around
     * the projected doses, not a fit-affecting change) — this block only
     * runs the simulation over it. */
    var chartBand = band, chartPriorBand = priorBand;
    if (chartProjectedDoses.length) {
      var chartDoses = doses.concat(chartProjectedDoses);
      // Display-only curve, not a decision number: subsampled draws keep this
      // cheap (same tradeoff the regimen explorer already makes).
      var chartPriorEta = subsample(priorEta, 250);
      var chartPriorAux = priorAux ? subsample(priorAux, 250) : null;
      var chartPostDraws = subsample(draws, 250);
      var chartPostAux = postAux ? subsample(postAux, 250) : null;
      var priorChartMat = await simulateDraws(chartPriorEta, chartDoses, grid, input.wt, disease, null, 64, age, drug, chartPriorAux);
      chartPriorBand = statsOfMatrix(priorChartMat);
      var postChartMat = await simulateDraws(chartPostDraws, chartDoses, grid, input.wt, disease, null, 64, age, drug, chartPostAux);
      chartBand = statsOfMatrix(postChartMat);
    }

    if (target == null) target = M.drug().targetDefault || 75;
    var troughStats = troughs.map(function (t, i) {
      var col = grid.length + i;
      var stat = {
        t: t,
        med: quantileSortedOfColumn(postMat, col, 0.5),
        p5: quantileSortedOfColumn(postMat, col, 0.05),
        p95: quantileSortedOfColumn(postMat, col, 0.95),
        pTarget: probAbove(postMat, col, target),
        // true for the single projected row: no dose was entered at this time,
        // the app assumed one interval after the last entered dose
        assumed: virtualT != null && Math.abs(t - virtualT) < 1e-9
      };
      // audit P2: Monte-Carlo 95% interval for P via batch means over the chain
      // order (respects autocorrelation; ~12 batches).
      if (obsFit.length) stat.pCI = batchMeansCI(postMat, col, target);
      return stat;
    });

    // parameter quantiles across draws
    var clArr = [], v1Arr = [];
    for (var i = 0; i < draws.length; i++) {
      var p = M.indivParams(input.wt, disease, draws[i], drug, age);
      clArr.push(p.cl); v1Arr.push(p.v1);
    }
    clArr.sort(function (a, b) { return a - b; });
    v1Arr.sort(function (a, b) { return a - b; });

    // v0.10.0 diagnostics exports: posterior CL/V1 per draw (unsorted, chain
    // order) + median individual prediction at each observation time + the
    // covariate-adjusted population typical parameters for this patient.
    var ipredAtObs = null;
    if (obs.length && obsTimeIdx.length) {
      ipredAtObs = obsTimeIdx.map(function (ci) {
        var vals = [];
        for (var r = 0; r < postMat.length; r++) if (postMat[r]) vals.push(postMat[r][ci]);
        vals.sort(function (a, b) { return a - b; });
        return quantileSorted(vals, 0.5);
      });
    }
    /* Per-observation recency bookkeeping. The preset name is not auditable on
     * its own — what a reader needs is how much each ACTUAL sample was
     * discounted. Because the inflation multiplies the residual SD, the
     * realised relative weight is exactly 1/m^2, with no dependence on the
     * sample's concentration.
     *
     * Seed the "newest sample" scan from the first fitted observation, NOT from
     * 0: in steady-state mode the relative-time origin is the LATEST DOSE, so
     * every sample taken before it has a negative time, and seeding at 0 would
     * make the newest sample look slightly aged. Same reference makeOfv uses,
     * so the two can never disagree. */
    var recNewest = obsFit.length ? obsFit[0].t : 0;
    for (var rn = 1; rn < obsFit.length; rn++) if (obsFit[rn].t > recNewest) recNewest = obsFit[rn].t;
    function recencyOf(o) {
      var ageD = recNewest - o.t;
      if (ageD < 0) ageD = 0;
      var m = recencyMult(input.recency, ageD);
      return { ageDays: ageD, mult: m, weight: 1 / (m * m) };
    }

    var popTyp = null;
    try { popTyp = M.indivParams(input.wt, disease, new Array(omega.dims).fill(0), drug, age); } catch (e) { popTyp = null; }
    var clDraws = [], v1Draws = [];
    if (obsFit.length) {
      for (var di = 0; di < draws.length; di++) {
        var pd = M.indivParams(input.wt, disease, draws[di], drug, age);
        clDraws.push(pd.cl); v1Draws.push(pd.v1);
      }
    }

    var T1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    return {
      hasObs: obsFit.length > 0,
      disease: disease,
      wt: input.wt,
      age: age,
      target: target,
      omega: omega,
      map: mapRes ? {
        etaCL: mapRes.x[0], etaV1: mapRes.x[1],
        etaVec: mapRes.x.slice(),
        etaNames: M.spec(drug).ETA ? M.spec(drug).ETA.names.slice() : ['CL', 'V1'],
        ofv: mapRes.f,
        // v0.13.0: a Nelder-Mead simplex that merely ran out of iterations no
        // longer looks like a success; startGap is the OFV disagreement between
        // the dispersed starts (large = possible local optimum).
        converged: mapRes.converged !== false,
        startGap: mapRes.startGap != null ? mapRes.startGap : 0,
        params: M.indivParams(input.wt, disease, mapRes.x, drug, age)
      } : null,
      acceptance: acceptance,
      rhat: rhat,
      nChains: nChains,
      nDraws: draws.length,
      essCL: essCL,
      essV1: essV1,
      essAll: essAll,
      essMin: essMin,
      etaInformation: etaInformation,
      etaCorr: etaCorr,
      etaDim: omega.dims,
      covFallback: covInfo ? covInfo.fallback : false,
      errMult: input.errMult != null && input.errMult > 0 ? input.errMult : 1,
      /* echo the recency setting back so the UI, the report and a saved
       * session all describe the fit that was actually run */
      recency: recencyMaxMult(input.recency) > 1 ? input.recency : 'off',
      recencyMaxMult: recencyMaxMult(input.recency),
      recencyTau: RECENCY_TAU_DAYS,
      draws: draws,
      interval: interval,
      planned: planned,
      horizon: horizon,
      windowStart: windowStart,
      grid: grid,
      priorBand: priorBand,
      band: band,
      // display-only: the chart plots these, continuing the regimen past the
      // last real dose; troughs/fitting above are unaffected (see comment
      // above chartBand's computation)
      chartPriorBand: chartPriorBand,
      chartBand: chartBand,
      chartProjectedDoses: chartProjectedDoses,
      loadingPhase: loadingPhase,
      spacingUnsettled: unsettled,
      intervalTrusted: intervalTrusted,
      pediatricWarn: pediatricWarn,
      samplesDuringInfusion: samplesDuringInfusion,
      troughs: troughStats,
      clQ: { p5: quantileSorted(clArr, 0.05), med: quantileSorted(clArr, 0.5), p95: quantileSorted(clArr, 0.95) },
      v1Q: { p5: quantileSorted(v1Arr, 0.05), med: quantileSorted(v1Arr, 0.5), p95: quantileSorted(v1Arr, 0.95) },
      /* v0.10.0 diagnostics exports */
      obsData: obs.map(function (o, i) {
        var rw = recencyOf(o);
        return { t: o.t, c: o.c, lloq: o.lloq, exclude: o.exclude, note: o.note,
                 ipred: ipredAtObs ? ipredAtObs[i] : NaN,
                 ageDays: rw.ageDays, recencyMult: rw.mult, recencyWeight: rw.weight };
      }),
      nExcluded: obs.length - obsFit.length,
      popTypical: popTyp,
      clPostDraws: obsFit.length ? clDraws : null,
      v1PostDraws: obsFit.length ? v1Draws : null,
      runtimeMs: T1 - T0
    };
  }

  /* ------------------- dose-interval explorer (v0.13.0) -------------------
   * Routine TDM for these agents is largely about PROLONGING the dosing
   * interval, and until v0.13.0 answering "can this patient move from q2w to
   * q3w?" meant hand-entering every future dose and re-running the whole fit
   * once per candidate interval — about a minute of work per question, for a
   * posterior that is identical across all of them.
   *
   * The posterior does not depend on the future schedule, so each candidate can
   * be evaluated by pushing the SAME kept draws through a different forward
   * regimen. Two quantities are returned per candidate interval:
   *
   *   next — the trough before the next administration if it is delayed to
   *          that interval. Directly answerable, assumes nothing beyond the
   *          one delayed dose.
   *   ss   — the trough once the patient has been continued on that interval
   *          long enough to re-approach steady state. This is the number that
   *          matters for a routine change, and for drugs that accumulate it is
   *          materially lower than `next`.
   *
   * This reports consequences for intervals the clinician asks about. It does
   * not choose one: no threshold is applied and no interval is recommended.
   *
   * opts: { draws, doses, wt, disease, age, drug, target, amt, intervals[],
   *         maxDraws?, horizonDays?, onProgress? }
   */
  /* One candidate regimen (a dose amount + an interval), evaluated on the
   * SAME kept draws as the fit. Shared by intervalScan (fixed dose, varying
   * interval) and doseScan (fixed interval, varying dose) so a dose change and
   * an interval change are answered by the same code, not two copies of it. */
  async function scanOneRegimen(sub, doses, last, amt, iv, route, drug, wt, disease, age, target, horizon, nextCycle) {
    // enough cycles to re-approach steady state on the candidate regimen
    var nCycles = Math.max(3, Math.min(30, Math.ceil(horizon / iv)));
    var fwd = doses.slice();
    for (var c = 1; c <= nCycles; c++) {
      fwd.push({ t: last.t + c * iv, amt: amt, route: route });
    }
    /* "next" is the earliest trough that can possibly reflect the change being
     * explored. For an INTERVAL change (nextCycle=1) that is simply the trough
     * before the delayed next dose — the longer gap already shows up there.
     * For a DOSE change (nextCycle=2) the trough right before that same next
     * dose is, by definition, evaluated BEFORE the new amount is given, so it
     * cannot depend on it at all — confirmed to be numerically invariant to
     * `amt`. The earliest point that reflects a changed AMOUNT is one cycle
     * later, after that first new-amount dose has been administered. */
    var nc = nextCycle > 0 ? nextCycle : 1;
    var tNext = last.t + nc * iv - 1e-6;
    var tSS = last.t + nCycles * iv - 1e-6;         // trough once re-settled (steady state)
    var mat = await simulateDraws(sub, fwd, [tNext, tSS], wt, disease, null, 64, age, drug, null);
    return {
      amt: amt, interval: iv, nCycles: nCycles,
      next: {
        med: quantileSortedOfColumn(mat, 0, 0.5),
        p5: quantileSortedOfColumn(mat, 0, 0.05),
        p95: quantileSortedOfColumn(mat, 0, 0.95),
        pTarget: probAbove(mat, 0, target),
        // F5/F16 (independent audit, 2026-09-13): the explorer's P had no
        // uncertainty band at all, unlike the trough table's matching
        // batchMeansCI (subsample() keeps chain order, so this is the same
        // batch-means method on a shorter chain -- the CI honestly widens
        // versus the full-chain trough table, rather than pretending the
        // subsampled P is exact. null (fewer than 12 batches) is handled by
        // ptaBadge already, same as the trough table's own pCI.
        pCI: batchMeansCI(mat, 0, target)
      },
      ss: {
        med: quantileSortedOfColumn(mat, 1, 0.5),
        p5: quantileSortedOfColumn(mat, 1, 0.05),
        p95: quantileSortedOfColumn(mat, 1, 0.95),
        pTarget: probAbove(mat, 1, target),
        pCI: batchMeansCI(mat, 1, target)
      }
    };
  }

  function regimenScanSetup(opts) {
    var draws = opts.draws || [];
    var doses = (opts.doses || []).slice().sort(function (a, b) { return a.t - b.t; });
    if (!draws.length || !doses.length) return null;
    var drug = opts.drug || M.drug().id;
    var spec = M.spec(drug);
    return {
      doses: doses,
      last: doses[doses.length - 1],
      drug: drug,
      target: opts.target != null ? opts.target : (spec.targetDefault || 75),
      // Future administrations follow the maintenance route (SC for crovalimab).
      route: spec.adminRoutes ? spec.adminRoutes.subsequent : (doses[doses.length - 1].route || null),
      // Subsampled draws keep this interactive; quantiles stay stable because
      // subsample() takes an evenly spaced slice of the chain, not the head.
      sub: subsample(draws, opts.maxDraws || 250),
      horizon: opts.horizonDays || 200
    };
  }

  /* Fixed dose, varying interval — "what if this patient's interval changes?" */
  async function intervalScan(opts) {
    var s = regimenScanSetup(opts);
    if (!s) return [];
    var amt = opts.amt > 0 ? opts.amt : s.last.amt;
    var ivs = opts.intervals || [];
    var out = [];
    for (var k = 0; k < ivs.length; k++) {
      if (!(ivs[k] > 0)) continue;
      out.push(await scanOneRegimen(s.sub, s.doses, s.last, amt, ivs[k], s.route,
        s.drug, opts.wt, opts.disease, opts.age, s.target, s.horizon, 1));
      if (opts.onProgress) { opts.onProgress((k + 1) / ivs.length); await tick(); }
    }
    return out;
  }

  /* Fixed interval, varying dose — "what if this patient's dose changes?" This
   * is the direct answer to "I adjusted a dose — show me the predicted trough
   * and its 90% credible interval at steady state": the row whose amount
   * equals the dose being considered IS that answer, read from `.ss`. */
  async function doseScan(opts) {
    var s = regimenScanSetup(opts);
    if (!s) return [];
    var iv = opts.interval > 0 ? opts.interval : (M.spec(s.drug).ssIntervalDefault || 14);
    var amts = opts.amounts || [];
    var out = [];
    for (var k = 0; k < amts.length; k++) {
      if (!(amts[k] > 0)) continue;
      out.push(await scanOneRegimen(s.sub, s.doses, s.last, amts[k], iv, s.route,
        s.drug, opts.wt, opts.disease, opts.age, s.target, s.horizon, 2));
      if (opts.onProgress) { opts.onProgress((k + 1) / amts.length); await tick(); }
    }
    return out;
  }

  /* Candidate intervals around a baseline (the current one by default): the
   * same interval, then progressively longer ones (interval prolongation is
   * the usual direction for these drugs), plus one shorter for context. Whole
   * days, deduplicated. */
  /* v0.19.0 — every candidate is a whole number of WEEKS, not just a whole
   * number of days. An interval like "every 13 days" or "every 6 days" is
   * arithmetically fine but clinically undoable: it drifts across weekdays
   * every cycle (a Monday appointment becomes Sunday, then Saturday, ...),
   * and every real regimen for these agents is in fact quoted in weeks
   * (q2w, q4w, q8w...), never in an odd number of days. Candidates are built
   * directly from a spread of WEEK offsets around the current interval
   * (rounded to the nearest week first) rather than fractional multipliers
   * snapped afterwards — snapping fractional multipliers post-hoc collapsed
   * several of them onto the same week for a short baseline (e.g. 0.75x and
   * 1x of 14 days both round to 2 weeks), losing candidates exactly where
   * interval prolongation — this app's primary use case — most needs them.
   * The spread favours longer candidates (prolongation) with one shorter
   * week kept for context, matching the direction already used elsewhere
   * in the regimen explorer. */
  function candidateIntervals(current) {
    var cur = current > 0 ? current : 14;
    var curWeeks = Math.max(1, Math.round(cur / 7));
    var weekOffsets = [-1, 0, 1, 2, 3, 4, 6, 8];
    var seen = {}, out = [];
    weekOffsets.forEach(function (dw) {
      var wk = Math.max(1, curWeeks + dw);
      var v = wk * 7;
      if (!seen[v]) { seen[v] = 1; out.push(v); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /* Candidate doses around a baseline (the current one by default), snapped to
   * the drug's own dosing granularity (`doseSpec.step`) so every candidate is a
   * value a clinician would actually consider, and clamped to the spec's
   * permitted range. */
  function candidateAmounts(current, doseSpec) {
    var cur = current > 0 ? current : ((doseSpec && doseSpec.default) || 100);
    var step = (doseSpec && doseSpec.step > 0) ? doseSpec.step : 1;
    var min = (doseSpec && doseSpec.min > 0) ? doseSpec.min : step;
    var max = (doseSpec && doseSpec.max > 0) ? doseSpec.max : Infinity;
    var mult = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    var seen = {}, out = [];
    mult.forEach(function (m) {
      var v = Math.max(min, Math.min(max, Math.round((cur * m) / step) * step));
      if (!seen[v]) { seen[v] = 1; out.push(v); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /* Monte-Carlo 95% interval for P(column > threshold) via batch means over the
   * chain order: the kept draws are autocorrelated, so the naive binomial SE
   * underestimates the true MC error. ~12 consecutive batches; SE = sd(batch p)/√nb
   * (batch means over a Markov chain are approximately independent). */
  function batchMeansCI(mat, col, threshold) {
    var ps = [];
    var nBatches = 12;
    var okRows = [];
    for (var r = 0; r < mat.length; r++) if (mat[r]) okRows.push(mat[r][col]);
    var n = okRows.length;
    if (n < nBatches) return null;
    var per = Math.floor(n / nBatches);
    for (var b = 0; b < nBatches; b++) {
      var ok = 0;
      for (var i = b * per; i < (b + 1) * per; i++) if (okRows[i] > threshold) ok++;
      ps.push(ok / per);
    }
    var mean = ps.reduce(function (a, c) { return a + c; }, 0) / nBatches;
    if (nBatches < 3) return [mean, mean];
    var varr = ps.reduce(function (a, c) { return a + (c - mean) * (c - mean); }, 0) / (nBatches - 1);
    var se = Math.sqrt(varr / nBatches);
    /* The SE is estimated from nBatches batch proportions, so it carries
     * nBatches-1 degrees of freedom: the normal multiplier 1.96 makes the
     * interval ~11% too narrow at 12 batches, in exactly the direction that
     * matters at the 90% decision badge. Use Student t instead (v0.13.0). */
    var mult = tQuantile975(nBatches - 1);
    return [
      Math.max(0, mean - mult * se),
      Math.min(1, mean + mult * se)
    ];
  }

  /* Two-sided 97.5% Student-t quantile. Small-df values are tabulated (the only
   * ones this engine uses); beyond the table the normal limit is accurate to
   * better than 1%. */
  var T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
              2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101,
              2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052,
              2.048, 2.045, 2.042];
  function tQuantile975(df) {
    if (!(df >= 1)) return 1.96;
    if (df <= 30) return T975[Math.floor(df) - 1];
    return 1.96 + (2.042 - 1.96) * (30 / df);
  }

  function quantileSortedOfColumn(mat, col, q) {
    var vals = [];
    for (var r = 0; r < mat.length; r++) if (mat[r]) vals.push(mat[r][col]);
    vals.sort(function (a, b) { return a - b; });
    return quantileSorted(vals, q);
  }

  ECU.bayes = {
    mulberry32: mulberry32,
    gaussFactory: gaussFactory,
    makeOfv: makeOfv,
    recencyMult: recencyMult,
    recencyMaxMult: recencyMaxMult,
    RECENCY_TAU_DAYS: RECENCY_TAU_DAYS,
    mapEstimate: mapEstimate,
    laplaceCov: laplaceCov,
    runMCMC: runMCMC,
    priorDraws: priorDraws,
    auxDraws: auxDraws,
    subsample: subsample,
    simulateDraws: simulateDraws,
    ess: ess,
    splitRhat: splitRhat,
    splitChainStats: splitChainStats,
    bulkEss: bulkEss,
    tQuantile975: tQuantile975,
    etaInformationOf: etaInformationOf,
    corrMatrix: corrMatrix,
    batchMeansCI: batchMeansCI,
    quantileSorted: quantileSorted,
    statsOfMatrix: statsOfMatrix,
    probAbove: probAbove,
    modalInterval: modalInterval,
    spacingUnsettled: spacingUnsettled,
    buildGrid: buildGrid,
    troughTimesOf: troughTimesOf,
    virtualTroughTime: virtualTroughTime,
    intervalScan: intervalScan,
    doseScan: doseScan,
    candidateIntervals: candidateIntervals,
    candidateAmounts: candidateAmounts,
    runFit: runFit
  };

})(typeof window !== 'undefined' ? window : globalThis);
