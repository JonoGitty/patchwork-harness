#!/usr/bin/env bash
# Start a local Jeff server (firelex/jeff) for patchwork-harness's classifiers - ADR-0013, ADR-0019.
#   scripts/jeff/serve.sh            # base + every adapter in ~/jeff-models/adapters, on :8765
# Then: PATCHWORK_HARNESS_JEFF_URL=http://127.0.0.1:8765  (grounding triage --classify, --guard, eval classifier)
#
# One-time setup (WSL, CUDA):
#   mkdir -p ~/jeff-models && cd ~/jeff-models && git clone https://github.com/firelex/jeff.git
#   uv venv .venv --python 3.13
#   uv pip install --python .venv/bin/python torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
#   uv pip install --python .venv/bin/python transformers==5.17.0 fastapi uvicorn peft safetensors huggingface-hub numpy pillow
#   .venv/bin/python -c "from huggingface_hub import snapshot_download as d; d('mstrasser/Jeff-Qwen3.5-0.8B', revision='v1.2', local_dir='Jeff-Qwen3.5-0.8B-v1.2'); [d(f'mstrasser/Jeff-Qwen3.5-0.8B-{a}', local_dir=f'adapters/{a}') for a in ('guard','ground')]"
set -euo pipefail
HOME_J="${JEFF_HOME:-$HOME/jeff-models}"
PORT="${PORT:-8765}"
if curl -s -m 2 "http://127.0.0.1:$PORT/health" | grep -q '"ready"'; then
  echo "jeff already serving on :$PORT"; exit 0
fi
cd "$HOME_J/jeff"
PYTHONPATH=src JEFF_CHECKPOINT="${JEFF_CHECKPOINT:-$HOME_J/Jeff-Qwen3.5-0.8B-v1.2}" JEFF_ADAPTERS="${JEFF_ADAPTERS:-$HOME_J/adapters}" PORT="$PORT" \
  nohup "$HOME_J/.venv/bin/python" -m jeff.server > "$HOME_J/serve.log" 2>&1 &
echo $! > "$HOME_J/serve.pid"
for _ in $(seq 1 90); do
  if curl -s -m 2 "http://127.0.0.1:$PORT/health" | grep -q '"ready"'; then echo "jeff ready on :$PORT (pid $(cat "$HOME_J/serve.pid"))"; exit 0; fi
  sleep 2
done
echo "jeff did not become ready - see $HOME_J/serve.log" >&2; exit 1
