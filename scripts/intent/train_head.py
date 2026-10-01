"""Train the custom intent head for `patchwork-harness run --lane auto` (ADR-0018).

    python scripts/intent/train_head.py --data labels.jsonl [--out ~/.patchwork-harness/intent/head.json]

`labels.jsonl`: one {"text": "...", "label": "fast"|"planned"|"unclear"} per line.
Today that is the blind-judge consensus set; later, outcome labels from the
audit trail (lane taken + gate / hidden check / review result) append to it.

The head is a logistic regression over BAAI/bge-small-en-v1.5 embeddings
(CLS token, normalised). It is small enough to live in one JSON file: the
server (serve_head.py) re-embeds the goal and applies the weights. The file
records how it was trained and its cross-validated accuracy against the
constant baseline, so a retrain can be compared before it is trusted.

Needs: torch, transformers, scikit-learn (the Kev venv has all three).
"""
import argparse
import collections
import datetime as dt
import json
import os

import numpy as np
import torch
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from transformers import AutoModel, AutoTokenizer

EMBEDDER = "BAAI/bge-small-en-v1.5"
CLASSES = ["fast", "planned", "unclear"]
MAX_CHARS = 1500


def embed(texts, dev):
    tok = AutoTokenizer.from_pretrained(EMBEDDER)
    model = AutoModel.from_pretrained(EMBEDDER).to(dev).eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(texts), 32):
            b = tok([t[:MAX_CHARS] for t in texts[i : i + 32]], padding=True, truncation=True, max_length=512, return_tensors="pt").to(dev)
            out.append(torch.nn.functional.normalize(model(**b).last_hidden_state[:, 0], dim=-1).cpu().numpy())
    return np.vstack(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default=os.path.expanduser("~/.patchwork-harness/intent/head.json"))
    ap.add_argument("--C", type=float, default=2.0)
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(a.data, encoding="utf-8") if l.strip()]
    rows = [r for r in rows if r.get("label") in CLASSES and r.get("text")]
    y = np.array([CLASSES.index(r["label"]) for r in rows])
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    X = embed([r["text"] for r in rows], dev)

    # cross-validated accuracy, recorded against the constant baseline
    accs = []
    for seed in range(5):
        pred = np.zeros(len(y), dtype=int)
        for tr, te in StratifiedKFold(5, shuffle=True, random_state=seed).split(X, y):
            c = LogisticRegression(max_iter=3000, class_weight="balanced", C=a.C).fit(X[tr], y[tr])
            pred[te] = c.predict(X[te])
        accs.append(float((pred == y).mean()))
    constant = float(np.bincount(y).max() / len(y))

    clf = LogisticRegression(max_iter=3000, class_weight="balanced", C=a.C).fit(X, y)
    head = {
        "version": 1,
        "embedder": EMBEDDER,
        "pooling": "cls",
        "max_chars": MAX_CHARS,
        "classes": [CLASSES[i] for i in clf.classes_],
        "coef": clf.coef_.tolist(),
        "intercept": clf.intercept_.tolist(),
        "trained_on": len(rows),
        "label_counts": dict(collections.Counter(r["label"] for r in rows)),
        "cv_accuracy": round(float(np.mean(accs)), 4),
        "constant_baseline": round(constant, 4),
        "data": os.path.abspath(a.data),
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    if head["cv_accuracy"] <= head["constant_baseline"]:
        raise SystemExit(f"REFUSED: cv accuracy {head['cv_accuracy']} does not beat the constant baseline {head['constant_baseline']}")
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(head, open(a.out, "w"), indent=1)
    print(f"head written to {a.out}: {len(rows)} labels {head['label_counts']}, cv accuracy {head['cv_accuracy']:.1%} vs constant {constant:.1%}")


if __name__ == "__main__":
    main()
