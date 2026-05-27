"""
v3 matching engine.

Goal: rank inventory lots by *closeness* to the customer COA along MT (Mass Tone),
RT (Tint Tone) and Tinting Strength.

Vector:
   V = [MT_DL, MT_Da, MT_Db, RT_DL, RT_Da, RT_Db, w_str * strength_norm]
   where strength_norm = (lot.Strength - coa.strength_mid) / coa.strength_halfwidth
   (omitted if strength missing on either side; falls back to 6-D)
   w_str = 0.5  -> strength contributes half a color axis

Three distance signals between each lot's V and the target T (target = zeros for
deltas, zero for strength_norm since target itself is the midpoint):
   1) Euclidean         d_eu  = ||V - T||_2
   2) Cosine            d_cos = 1 - cos(V, T)   (skipped if ||T|| < 0.1)
   3) Scaled-Euclidean  d_kn  = ||scaler(V) - scaler(T)||_2  (per-axis variance normalized)

Each distance is z-scored across the candidate pool (robust mean+std), then
blended:
   score = w_eu * z_eu + w_cos * z_cos + w_kn * z_kn

Default weights: equal (1/3 each), re-normalized when cosine is dropped (1/2 each).
Lower score = better match. Sort ascending. Magnitude is preserved by z-scoring
so the gap between rank 1 and rank 2 means something (unlike rank-sum).

Within-tolerance flag stays per-axis from COA limits; out-of-spec lots filtered
out unless `in_spec_only=False`.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np
from sklearn.preprocessing import StandardScaler

MT_METHOD = "Method I a"
RT_METHOD = "Method I b"

# Tunable
STRENGTH_WEIGHT = 0.5         # half-weight of a color axis
COSINE_DROP_THRESHOLD = 0.1   # if ||target|| < this, drop cosine signal
DIRECTION_FLOOR = 0.05        # |COA delta| below this -> axis direction-agnostic (noise floor)
BLEND_WEIGHTS = {"euclid": 1.0, "cosine": 1.0, "knn": 1.0, "age": 0.5}


def _direction_match(lot_mt: Dict[str, Any], lot_rt: Dict[str, Any],
                     coa_mt: Dict[str, Any], coa_rt: Dict[str, Any]) -> Dict[str, Any]:
    """Per-axis sign check vs COA target deltas.

    Lot delta sign must match COA delta sign on each axis where |COA delta| >= floor.
    Axes where COA is near zero are skipped (no meaningful direction).
    Returns {"mt": {ax: True/False/None}, "rt": {...}, "all": bool, "reasons": [...]}.
    """
    out = {"mt": {}, "rt": {}, "reasons": []}
    def check(block_label, lot_block, coa_block):
        d = out["mt"] if block_label == "MT" else out["rt"]
        for ax in ("DL", "Da", "Db"):
            coa_v = coa_block.get(ax)
            lot_v = lot_block.get(ax)
            if coa_v is None or lot_v is None:
                d[ax] = None
                continue
            if abs(coa_v) < DIRECTION_FLOOR:
                d[ax] = None  # direction-agnostic
                continue
            ok = (coa_v >= 0 and lot_v >= 0) or (coa_v <= 0 and lot_v <= 0)
            d[ax] = bool(ok)
            if not ok:
                out["reasons"].append(
                    f"{block_label} {ax} sign mismatch: COA {coa_v:+.2f} vs lot {lot_v:+.2f}"
                )
    check("MT", lot_mt, coa_mt)
    check("RT", lot_rt, coa_rt)
    flags = [v for v in list(out["mt"].values()) + list(out["rt"].values()) if v is not None]
    out["all"] = all(flags) if flags else True
    return out


def _strength_norm(s: Optional[float], coa_rt: Dict[str, Any]) -> Optional[float]:
    """Normalize strength deviation to a half-band unit. None if either side missing."""
    if s is None:
        return None
    lo, hi = coa_rt.get("strength_lo"), coa_rt.get("strength_hi")
    if lo is None or hi is None or hi <= lo:
        return None
    mid = (lo + hi) / 2.0
    halfwidth = (hi - lo) / 2.0
    if halfwidth <= 0:
        return None
    return STRENGTH_WEIGHT * (s - mid) / halfwidth


def _vec(block_mt: Dict[str, Any], block_rt: Dict[str, Any], coa_rt: Dict[str, Any]) -> Optional[np.ndarray]:
    """Build per-lot vector. 6-D color always; +1 strength dim if both lot & COA strength available."""
    color = [
        block_mt.get("DL"), block_mt.get("Da"), block_mt.get("Db"),
        block_rt.get("DL"), block_rt.get("Da"), block_rt.get("Db"),
    ]
    if any(v is None for v in color):
        return None
    s_norm = _strength_norm(block_rt.get("Strength"), coa_rt)
    arr = color + ([s_norm] if s_norm is not None else [])
    return np.array(arr, dtype=float)


def _target(coa_mt: Dict[str, Any], coa_rt: Dict[str, Any], include_strength: bool) -> Optional[np.ndarray]:
    """Target = COA's MT+RT delta values (NOT zeros — COA carries its own measured deltas).
    For strength: target axis sits at the band midpoint = 0 in normalized space."""
    color = [
        coa_mt.get("DL"), coa_mt.get("Da"), coa_mt.get("Db"),
        coa_rt.get("DL"), coa_rt.get("Da"), coa_rt.get("Db"),
    ]
    if any(v is None for v in color):
        return None
    return np.array(color + ([0.0] if include_strength else []), dtype=float)


def _cosine_dist(a: np.ndarray, b: np.ndarray) -> float:
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return float(np.linalg.norm(a - b))  # fallback
    return float(1.0 - np.dot(a, b) / (na * nb))


def _zscore(arr: np.ndarray) -> np.ndarray:
    """Robust-ish z-score. Std of zero -> return zeros."""
    mu = float(np.mean(arr))
    sd = float(np.std(arr))
    if sd < 1e-9:
        return np.zeros_like(arr)
    return (arr - mu) / sd


def _within(lot_mt: Dict[str, Any], lot_rt: Dict[str, Any], coa_mt: Dict[str, Any], coa_rt: Dict[str, Any]) -> Dict[str, Any]:
    """Return per-axis within-spec flags + overall."""
    def axis_in(val, lo, hi):
        if val is None: return None
        if lo is None and hi is None: return True
        if lo is not None and val < lo: return False
        if hi is not None and val > hi: return False
        return True

    out = {"mt": {}, "rt": {}}
    for ax in ("DL", "Da", "Db", "DE"):
        out["mt"][ax] = axis_in(lot_mt.get(ax), coa_mt.get(f"{ax}_lo"), coa_mt.get(f"{ax}_hi"))
        out["rt"][ax] = axis_in(lot_rt.get(ax), coa_rt.get(f"{ax}_lo"), coa_rt.get(f"{ax}_hi"))
    # DE_max overrides DE_hi
    if coa_mt.get("DE_max") is not None and lot_mt.get("DE") is not None:
        out["mt"]["DE"] = lot_mt["DE"] <= coa_mt["DE_max"]
    if coa_rt.get("DE_max") is not None and lot_rt.get("DE") is not None:
        out["rt"]["DE"] = lot_rt["DE"] <= coa_rt["DE_max"]

    overall = all(v is True for v in list(out["mt"].values()) + list(out["rt"].values()))
    out["all"] = overall
    return out


def rank_lots(
    lots: List[Dict[str, Any]],
    coa: Dict[str, Any],
    *,
    required_tests: Optional[List[str]] = None,
    grade_strict: bool = True,
    in_spec_only: bool = True,
) -> List[Dict[str, Any]]:
    coa_mt = coa.get("mass_tone") or {}
    coa_rt = coa.get("tint_tone") or {}

    required = set(required_tests or [])
    required.update({MT_METHOD, RT_METHOD})
    grade_target = (coa.get("grade") or "").strip()

    # Skip lot_nos appearing on multiple columns. They're ambiguous for
    # fulfillment until master is cleaned up (UI surfaces them as DATA ISSUE).
    from collections import Counter
    lot_no_counts = Counter((lot.get("lot_no") or "").strip() for lot in lots)
    dup_lot_nos = {k for k, n in lot_no_counts.items() if k and n > 1}

    candidates: List[Dict[str, Any]] = []
    for lot in lots:
        if (lot.get("lot_no") or "").strip() in dup_lot_nos:
            continue
        if lot.get("qty_mt", 0) <= 0:
            continue
        if grade_strict and grade_target and str(lot.get("grade", "")).strip() != grade_target:
            continue
        present = set(lot.get("present_methods", []))
        if not required.issubset(present):
            continue
        blocks = lot.get("blocks", {})
        mt_b = blocks.get(MT_METHOD, {}) or {}
        rt_b = blocks.get(RT_METHOD, {}) or {}
        v = _vec(mt_b, rt_b, coa_rt)
        if v is None:
            continue
        candidates.append({"lot": lot, "vec": v, "mt": mt_b, "rt": rt_b})

    if not candidates:
        return []

    # We support mixed-dim vectors (6 vs 7 if strength missing). Run scoring per-dim.
    # In practice almost all lots in the pool will have strength populated; split as needed.
    out: List[Dict[str, Any]] = []

    # Compute per-dim distances (separately for 6-D vs 7-D candidates so vector ops align)
    by_dim: Dict[int, List[int]] = {}
    for i, c in enumerate(candidates):
        by_dim.setdefault(len(c["vec"]), []).append(i)

    eu_all = np.zeros(len(candidates))
    co_all = np.zeros(len(candidates))
    kn_all = np.zeros(len(candidates))
    co_dropped_any = False

    for dim, idxs in by_dim.items():
        include_strength = (dim == 7)
        target = _target(coa_mt, coa_rt, include_strength=include_strength)
        if target is None:
            continue
        vecs = np.array([candidates[i]["vec"] for i in idxs])
        # Euclidean
        eu = np.linalg.norm(vecs - target, axis=1)
        # Cosine — drop if target near origin (delta values all ~ 0)
        target_norm = float(np.linalg.norm(target))
        if target_norm < COSINE_DROP_THRESHOLD:
            co = None
            co_dropped_any = True
        else:
            co = np.array([_cosine_dist(v, target) for v in vecs])
        # KNN-style: scale by per-axis std of pool, then Euclid
        stack = np.vstack([vecs, target.reshape(1, -1)])
        scaler = StandardScaler().fit(stack)
        vs = scaler.transform(vecs)
        ts = scaler.transform(target.reshape(1, -1))[0]
        kn = np.linalg.norm(vs - ts, axis=1)
        for j, i in enumerate(idxs):
            eu_all[i] = eu[j]
            co_all[i] = co[j] if co is not None else np.nan
            kn_all[i] = kn[j]

    # Age signal: older lots first (FIFO depletion).
    # Master layout: per-grade columns are arranged L->R with newer to the right;
    # within a grade, higher lot_no = newer. So older = lower (col, lot_no_numeric).
    # Rank ordinally within grade so cross-grade pools don't bias by column position alone.
    def _lot_no_num(s: str) -> float:
        digits = "".join(ch for ch in (s or "") if ch.isdigit())
        return float(digits) if digits else float("inf")  # unknown -> treat as newest

    age_all = np.zeros(len(candidates))
    # Group candidate indices by grade, then rank by (col, lot_no_num)
    from collections import defaultdict
    grade_groups: Dict[str, List[int]] = defaultdict(list)
    for i, c in enumerate(candidates):
        grade_groups[str(c["lot"].get("grade", "")).strip()].append(i)
    for _g, idxs in grade_groups.items():
        keys = [(int(candidates[i]["lot"].get("col", 0) or 0),
                 _lot_no_num(candidates[i]["lot"].get("lot_no", ""))) for i in idxs]
        order = sorted(range(len(idxs)), key=lambda k: keys[k])
        # rank 0 = oldest -> lowest (best) age score
        for rank_pos, k in enumerate(order):
            age_all[idxs[k]] = float(rank_pos)

    # z-score each signal across whole pool
    z_eu = _zscore(eu_all)
    z_kn = _zscore(kn_all)
    z_age = _zscore(age_all)
    cosine_valid = not np.isnan(co_all).all()
    if cosine_valid:
        # If some cosines are NaN (mixed targets), impute with mean before zscore
        finite_mask = ~np.isnan(co_all)
        co_filled = np.where(finite_mask, co_all, float(np.mean(co_all[finite_mask])) if finite_mask.any() else 0.0)
        z_co = _zscore(co_filled)
    else:
        z_co = None

    # Blend (re-normalize weights when cosine dropped)
    w = dict(BLEND_WEIGHTS)
    if not cosine_valid:
        w["cosine"] = 0.0
    total_w = sum(w.values())
    w = {k: v / total_w for k, v in w.items()}
    blended = (
        w["euclid"] * z_eu
        + w["knn"] * z_kn
        + (w["cosine"] * z_co if z_co is not None else 0.0)
        + w["age"] * z_age
    )

    # Ordinal ranks per signal — for the detail row only
    def ordinal_rank(arr: np.ndarray) -> np.ndarray:
        order = np.argsort(arr, kind="stable")
        ranks = np.empty_like(order)
        ranks[order] = np.arange(len(arr))
        return ranks + 1

    r_eu = ordinal_rank(eu_all)
    r_kn = ordinal_rank(kn_all)
    r_co = ordinal_rank(co_all if cosine_valid else np.zeros_like(eu_all))
    r_age = ordinal_rank(age_all)

    # Pre-compute final spec + direction status per candidate so overall rank
    # respects tiers (in-spec lots always rank ahead of out-of-spec, etc.).
    cand_within: List[Dict[str, Any]] = []
    cand_direction: List[Dict[str, Any]] = []
    cand_strength_in: List[bool] = []
    for c in candidates:
        w = _within(c["mt"], c["rt"], coa_mt, coa_rt)
        d = _direction_match(c["mt"], c["rt"], coa_mt, coa_rt)
        s = c["rt"].get("Strength")
        s_lo, s_hi = coa_rt.get("strength_lo"), coa_rt.get("strength_hi")
        strength_in = True
        if s is not None and (s_lo is not None or s_hi is not None):
            if s_lo is not None and s < s_lo: strength_in = False
            elif s_hi is not None and s > s_hi: strength_in = False
        w["strength"] = strength_in
        w["all"] = w["all"] and strength_in
        cand_within.append(w)
        cand_direction.append(d)
        cand_strength_in.append(strength_in)

    def _tier_for(idx: int) -> int:
        spec_ok = bool(cand_within[idx]["all"])
        dir_ok = bool(cand_direction[idx]["all"])
        return (0 if spec_ok else 2) + (0 if dir_ok else 1)

    # Overall rank = order by (tier asc, blended asc). Out-of-spec gets ranked
    # only after every in-spec lot.
    composite_keys = [(_tier_for(i), float(blended[i])) for i in range(len(candidates))]
    order_overall = sorted(range(len(candidates)), key=lambda k: composite_keys[k])
    r_blend = np.empty(len(candidates), dtype=int)
    for pos, k in enumerate(order_overall):
        r_blend[k] = pos + 1

    for i, c in enumerate(candidates):
        lot = c["lot"]
        within = cand_within[i]
        direction = cand_direction[i]
        s = c["rt"].get("Strength")
        s_lo, s_hi = coa_rt.get("strength_lo"), coa_rt.get("strength_hi")
        strength_in = cand_strength_in[i]

        reasons: List[str] = []
        for ax in ("DL", "Da", "Db", "DE"):
            if within["mt"].get(ax) is False:
                v = c["mt"].get(ax)
                lo, hi = coa_mt.get(f"{ax}_lo"), coa_mt.get(f"{ax}_hi")
                if ax == "DE" and coa_mt.get("DE_max") is not None:
                    reasons.append(f"MT {ax} {v:+.2f} > max {coa_mt['DE_max']:.2f}")
                else:
                    reasons.append(f"MT {ax} {v:+.2f} outside [{lo:+.2f}, {hi:+.2f}]")
            if within["rt"].get(ax) is False:
                v = c["rt"].get(ax)
                lo, hi = coa_rt.get(f"{ax}_lo"), coa_rt.get(f"{ax}_hi")
                if ax == "DE" and coa_rt.get("DE_max") is not None:
                    reasons.append(f"RT {ax} {v:+.2f} > max {coa_rt['DE_max']:.2f}")
                else:
                    reasons.append(f"RT {ax} {v:+.2f} outside [{lo:+.2f}, {hi:+.2f}]")
        if strength_in is False and s is not None:
            reasons.append(f"Strength {s:.2f} outside [{s_lo}, {s_hi}]")
        within["reasons"] = reasons

        out.append({
            "lot_id": lot.get("lot_id") or lot["lot_no"],
            "lot_no": lot["lot_no"],
            "col_letter": lot.get("col_letter"),
            "grade": lot["grade"],
            "qty_mt": lot["qty_mt"],
            "last_edited": lot.get("last_edited"),
            "mass_tone": c["mt"],
            "tint_tone": c["rt"],
            "all_blocks": lot.get("blocks", {}),
            "present_methods": lot.get("present_methods", []),
            "is_super": len(lot.get("present_methods", []) or []) > 2,
            "scores": {
                "euclid": float(eu_all[i]),
                "cosine": float(co_all[i]) if cosine_valid and not np.isnan(co_all[i]) else None,
                "knn": float(kn_all[i]),
                "z_euclid": float(z_eu[i]),
                "z_cosine": float(z_co[i]) if z_co is not None else None,
                "z_knn": float(z_kn[i]),
                "age": float(age_all[i]),
                "z_age": float(z_age[i]),
                "blended": float(blended[i]),
                "blend_weights": w,
                "strength_dim_used": len(c["vec"]) == 7,
                "cosine_used": cosine_valid,
            },
            "ranks": {
                "euclid": int(r_eu[i]),
                "cosine": int(r_co[i]) if cosine_valid else None,
                "knn": int(r_kn[i]),
                "age": int(r_age[i]),
                "consensus": int(r_blend[i]),  # field name kept for back-compat; now = blended rank
            },
            "within": within,
            "direction": direction,
        })

    # Hard tiers (best -> worst):
    #   tier 0: in-spec  + direction OK
    #   tier 1: in-spec  + direction mismatch
    #   tier 2: out-spec + direction OK
    #   tier 3: out-spec + direction mismatch
    # Blended score (color + age) only re-orders within a tier.
    def _tier(r):
        spec_ok = bool(r["within"]["all"])
        dir_ok = bool(r["direction"]["all"])
        return (0 if spec_ok else 2) + (0 if dir_ok else 1)
    out.sort(key=lambda r: (_tier(r), r["scores"]["blended"]))
    if in_spec_only:
        out = [r for r in out if r["within"]["all"]]
    return out


def fulfill_exact(ranked: List[Dict[str, Any]], qty: float) -> List[Dict[str, Any]]:
    """Greedy: pick top lots, partial cut on last to hit qty exactly.

    Super lots (those with extra test methods beyond MT+RT) are *deprioritized*:
    we exhaust all eligible non-super lots first, then dip into super lots only
    if the request can't be filled without them.
    """
    remaining = float(qty)
    picks: List[Dict[str, Any]] = []
    # Two passes preserve ranked order within each group.
    non_super = [r for r in ranked if not r.get("is_super")]
    super_lots = [r for r in ranked if r.get("is_super")]
    for r in non_super + super_lots:
        if remaining <= 1e-6:
            break
        if not (r.get("within") or {}).get("all"):
            continue  # never auto-fulfill from out-of-spec lots
        avail = float(r.get("qty_mt", 0))
        if avail <= 0:
            continue
        take = min(avail, remaining)
        picks.append({
            "lot_id": r.get("lot_id") or r["lot_no"],
            "lot_no": r["lot_no"],
            "consume_mt": round(take, 3),
        })
        remaining -= take
    return picks


if __name__ == "__main__":
    from v3_master import parse_master
    from v3_coa import get_customer_effective
    m = parse_master()
    cust = get_customer_effective("Himalaya paints")
    print("Customer:", cust["name"], "grade:", cust["grade"])
    print("Target MT:", cust["mass_tone"])
    print("Target RT:", cust["tint_tone"])
    ranked = rank_lots(m["lots"], cust, grade_strict=False)
    print(f"Ranked {len(ranked)} candidates")
    for r in ranked[:5]:
        print(f"  #{r['ranks']['consensus']:3d} {r['lot_no']:10s} grade={r['grade']:6s} qty={r['qty_mt']:.1f} "
              f"euc={r['scores']['euclid']:.3f} cos={r['scores']['cosine']:.3f} knn={r['scores']['knn']:.3f} "
              f"within={r['within']['all']}")
