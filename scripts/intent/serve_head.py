"""Serve the custom intent head over the System One wire format (ADR-0018).

    python scripts/intent/serve_head.py [--head ~/.patchwork-harness/intent/head.json] [--port 8010]

Then point patchwork-harness at it:  PATCHWORK_HARNESS_INTENT_URL=http://127.0.0.1:8010

POST /v1/systemone  {state, questions}: every "choice" question is answered
with the head's probabilities mapped onto its criteria. The head's "fast"
class is reported as "direct" (patchwork-harness sums answer + direct), "planned" and
"unclear" map through, any other criterion gets 0.
GET /health         what is loaded, how it was trained.

Local only: binds 127.0.0.1. Needs torch + transformers (the Kev venv).
"""
import argparse
import hashlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

ap = argparse.ArgumentParser()
ap.add_argument("--head", default=os.path.expanduser("~/.patchwork-harness/intent/head.json"))
ap.add_argument("--port", type=int, default=8010)
args = ap.parse_args()

HEAD = json.load(open(args.head))
W = np.array(HEAD["coef"])
B = np.array(HEAD["intercept"])
MODEL_ID = "intent-head-" + hashlib.sha256(json.dumps(HEAD["coef"]).encode()).hexdigest()[:8]
DEV = "cuda" if torch.cuda.is_available() else "cpu"
TOK = AutoTokenizer.from_pretrained(HEAD["embedder"])
EMB = AutoModel.from_pretrained(HEAD["embedder"]).to(DEV).eval()


def classify(text: str) -> dict:
    with torch.no_grad():
        b = TOK([text[: HEAD["max_chars"]]], truncation=True, max_length=512, return_tensors="pt").to(DEV)
        v = torch.nn.functional.normalize(EMB(**b).last_hidden_state[:, 0], dim=-1).cpu().numpy()[0]
    z = W @ v + B
    p = np.exp(z - z.max())
    p /= p.sum()
    return dict(zip(HEAD["classes"], (float(x) for x in p)))


def state_text(state) -> str:
    if isinstance(state, dict) and isinstance(state.get("request"), str):
        return state["request"]
    return state if isinstance(state, str) else json.dumps(state)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "model": MODEL_ID, "device": DEV, **{k: HEAD[k] for k in ("embedder", "classes", "trained_on", "label_counts", "cv_accuracy", "constant_baseline", "created_at")}})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/systemone":
            return self._send(404, {"error": "not found"})
        t0 = time.time()
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            probs = classify(state_text(req.get("state")))
            answers = {}
            for qid, q in (req.get("questions") or {}).items():
                if q.get("type") != "choice":
                    return self._send(400, {"error": f"question '{qid}': only choice questions are supported"})
                mapped = {k: 0.0 for k in q.get("criteria", {})}
                if "direct" in mapped:
                    mapped["direct"] = probs.get("fast", 0.0)
                for k in ("planned", "unclear"):
                    if k in mapped:
                        mapped[k] = probs.get(k, 0.0)
                total = sum(mapped.values()) or 1.0
                mapped = {k: v / total for k, v in mapped.items()}
                top = max(mapped, key=mapped.get)
                answers[qid] = {"type": "choice", "choice": top, "probabilities": mapped, "confidence": mapped[top]}
            self._send(200, {"model": MODEL_ID, "answers": answers, "latency_ms": round((time.time() - t0) * 1000, 1)})
        except Exception as e:  # a bad request never kills the server
            self._send(400, {"error": str(e)[:300]})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"intent head {MODEL_ID} ({HEAD['trained_on']} labels, cv {HEAD['cv_accuracy']:.1%}) on http://127.0.0.1:{args.port} [{DEV}]", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()
