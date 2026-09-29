"""ADR-0013 Phase 2 — score the classifier against blind judge labels.

    python3 scripts/score_calibration.py <calibration-dir>

Reads items.jsonl (with the classifier's p) and labels-*.jsonl (one per
blind judge: {"id", "label": 1|0}). Only items every judge agrees on are
scored: judge disagreement means the question was unclear, and a noisy
label can't grade anything (Archestra's lesson). Prints the report and
writes results.json.
"""
import json
import sys
from pathlib import Path

HI, LO = 0.7, 0.3  # ADR-0013 bands


def load(p: Path):
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def auc(pos, neg):
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def main(d: Path):
    items = {r["id"]: r for r in load(d / "items.jsonl") if r.get("p") is not None}
    judges = sorted(d.glob("labels-*.jsonl"))
    if len(judges) < 2:
        sys.exit("need at least two labels-*.jsonl files")
    labels = {j.stem: {r["id"]: int(r["label"]) for r in load(j)} for j in judges}
    ids = [i for i in items if all(i in lab for lab in labels.values())]
    agree = [i for i in ids if len({lab[i] for lab in labels.values()}) == 1]

    # Cohen's kappa for the first two judges
    a, b = (labels[j.stem] for j in judges[:2])
    po = sum(a[i] == b[i] for i in ids) / len(ids)
    pa, pb = sum(a[i] for i in ids) / len(ids), sum(b[i] for i in ids) / len(ids)
    pe = pa * pb + (1 - pa) * (1 - pb)
    kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0

    y = {i: labels[judges[0].stem][i] for i in agree}
    p = {i: items[i]["p"] for i in agree}
    n = len(agree)
    base = sum(y.values()) / n
    const_acc = max(base, 1 - base)
    acc = sum((p[i] >= 0.5) == bool(y[i]) for i in agree) / n
    brier = sum((p[i] - y[i]) ** 2 for i in agree) / n
    brier_const = sum((base - y[i]) ** 2 for i in agree) / n

    def band(lo, hi):
        ids_ = [i for i in agree if lo <= p[i] <= hi]
        sup = sum(y[i] for i in ids_)
        return {"n": len(ids_), "labelled_supported": sup, "labelled_unsupported": len(ids_) - sup}

    hi, mid, lo = band(HI, 1.0), band(LO + 1e-9, HI - 1e-9), band(0.0, LO)
    wrong_high = sorted(
        ({"id": i, "p": round(p[i], 3), "kind": items[i]["kind"], "claim": items[i]["claim"]}
         for i in agree if p[i] >= HI and y[i] == 0),
        key=lambda r: -r["p"])
    wrong_low = sorted(
        ({"id": i, "p": round(p[i], 3), "kind": items[i]["kind"], "claim": items[i]["claim"]}
         for i in agree if p[i] <= LO and y[i] == 1),
        key=lambda r: r["p"])
    by_kind = {}
    for k in sorted({items[i]["kind"] for i in agree}):
        ks = [i for i in agree if items[i]["kind"] == k]
        by_kind[k] = {
            "n": len(ks),
            "supported_rate": round(sum(y[i] for i in ks) / len(ks), 3),
            "accuracy@0.5": round(sum((p[i] >= 0.5) == bool(y[i]) for i in ks) / len(ks), 3),
        }

    res = {
        "items_with_p": len(items),
        "labelled_by_all": len(ids),
        "judges": [j.stem for j in judges],
        "judge_agreement": round(len(agree) / len(ids), 3),
        "kappa_first_two": round(kappa, 3),
        "scored_consensus_n": n,
        "base_rate_supported": round(base, 3),
        "constant_baseline_accuracy": round(const_acc, 3),
        "classifier_accuracy@0.5": round(acc, 3),
        "auc": None if (v := auc([p[i] for i in agree if y[i]], [p[i] for i in agree if not y[i]])) is None else round(v, 3),
        "brier": round(brier, 4),
        "brier_constant": round(brier_const, 4),
        "band_likely_supported(>=0.7)": hi,
        "band_uncertain": mid,
        "band_likely_unsupported(<=0.3)": lo,
        "wrong_high(p>=0.7, labelled unsupported)": wrong_high,
        "wrong_low(p<=0.3, labelled supported)": wrong_low,
        "by_kind": by_kind,
    }
    (d / "results.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
