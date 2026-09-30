#!/usr/bin/env python3
"""Generate golden concentration vectors for the eculizumab PK model with an
independent Python implementation (event-aware fixed-step RK4, h=5e-4 days).

Model: two-compartment, parallel linear + Michaelis-Menten elimination,
allometric scaling — ter Avest et al., Clin Pharmacokinet 2025;64:1139-1147
(final PK model, NONMEM control stream). Time in days, mg, mg/L (= ug/mL).
Units identical to the JS implementation in src/model.js.

Output: tests/golden.json  [{name, wt, disease, doses, times, c:[...]}]
"""
import json
import os

CL, V1, VMAX, KM, V2, Q = 0.1626, 4.299, 25.64, 13.54, 2.63, 0.6243
DUR = 30.0 / 1440.0
H = 5e-4


def params(wt, vmax0=False):
    w = wt / 70.0
    cl = CL * w ** 0.75
    v1 = V1 * w
    v2 = V2 * w
    q = Q * w ** 0.75
    vmax = 0.0 if vmax0 else VMAX * w ** 0.75
    return {
        "cl": cl, "v1": v1, "v2": v2, "q": q, "vmax": vmax, "km": KM,
        "kel": cl / v1, "k12": q / v1, "k21": q / v2,
    }


def rhs(y, p, rin):
    c = y[0] / p["v1"]
    mm = p["vmax"] * c / (p["km"] + c)
    return (-p["kel"] * y[0] - mm - p["k12"] * y[0] + p["k21"] * y[1] + rin,
            -p["k21"] * y[1] + p["k12"] * y[0])


def rk4_step(f, t, y, h):
    k1 = f(t, y)
    k2 = f(t + h / 2, (y[0] + h * k1[0] / 2, y[1] + h * k1[1] / 2))
    k3 = f(t + h / 2, (y[0] + h * k2[0] / 2, y[1] + h * k2[1] / 2))
    k4 = f(t + h, (y[0] + h * k3[0], y[1] + h * k3[1]))
    return (y[0] + h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
            y[1] + h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]))


def simulate(doses, times, p, dur=DUR, h=H):
    """doses: [(t, amt)] infusions; returns concentrations at `times`."""
    events = []
    for t, amt in doses:
        rate = amt / dur
        events.append((t, "rate", rate))
        events.append((t + dur, "rate", -rate))
    events += [(t, "out", i) for i, t in enumerate(times)]
    events.sort(key=lambda e: e[0])

    y = (0.0, 0.0)
    rin = 0.0
    cur = events[0][0]
    res = [0.0] * len(times)
    for ev in events:
        t, kind, val = ev
        if t > cur:
            n = int(round((t - cur) / h))
            if n < 1:
                n = 1
            hh = (t - cur) / n
            for _ in range(n):
                y = rk4_step(lambda tt, yy: rhs(yy, p, rin), cur, y, hh)
                cur += hh
        if kind == "rate":
            rin += val
        elif kind == "out":
            res[val] = y[0] / p["v1"]
    return res


SCENARIOS = [
    {
        "name": "pnh70_standard",
        "wt": 70,
        "disease": "PNH",
        "doses": [(0, 600), (7, 600), (14, 600), (21, 600),
                  (28, 900), (42, 900), (56, 900), (70, 900)],
        "times": [0.25, 1, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 84, 98],
    },
    {
        "name": "pnh83_standard",
        "wt": 83,
        "disease": "PNH",
        "doses": [(0, 600), (7, 600), (14, 600), (21, 600),
                  (28, 900), (42, 900), (56, 900), (70, 900)],
        "times": [0.25, 7, 14, 21, 28, 42, 56, 70, 84],
    },
    {
        "name": "ahus55_smpc",
        "wt": 55,
        "disease": "aHUS",
        "doses": [(0, 1200), (7, 1200), (14, 1200), (21, 1200), (28, 1200),
                  (42, 1200), (56, 1200), (70, 1200)],
        "times": [0.25, 7, 14, 21, 28, 42, 56, 70, 84],
    },
    {
        "name": "pnh95_loading",
        "wt": 95,
        "disease": "PNH",
        "doses": [(0, 2100), (14, 900), (28, 900), (42, 900), (56, 900)],
        "times": [0.25, 1, 7, 14, 21, 28, 42, 56, 70],
    },
    {
        "name": "pnh70_vmax0",
        "wt": 70,
        "disease": "PNH",
        "vmax0": True,
        "doses": [(0, 900), (14, 900), (28, 900)],
        "times": [0.25, 1, 3, 7, 14, 21, 28, 35, 42, 56],
    },
]


def main():
    out = []
    for sc in SCENARIOS:
        p = params(sc["wt"], vmax0=sc.get("vmax0", False))
        c = simulate(sc["doses"], sc["times"], p)
        out.append({
            "name": sc["name"],
            "wt": sc["wt"],
            "disease": sc["disease"],
            "vmax0": sc.get("vmax0", False),
            "doses": [{"t": t, "amt": a} for t, a in sc["doses"]],
            "times": sc["times"],
            "c": c,
        })
        print("scenario %-18s done (%d points)" % (sc["name"], len(c)))
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "tests", "golden.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print("wrote", os.path.abspath(path))


if __name__ == "__main__":
    main()
