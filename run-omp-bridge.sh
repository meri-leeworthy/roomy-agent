#!/bin/bash
# Roomy -> agent bridge runner (Chanterelle agent).
# Emits mention events to downstream consumers over a pipe. See README for the
# pipeline (`roomy-bridge | roomy-cli respond`).
set -euo pipefail
export PATH=/home/exedev/node/bin:/home/exedev/.local/bin:$PATH
cd "$(dirname "$0")"
export $(grep -vE '^\s*#|^\s*$' .env | xargs)
export APPSERVER_URL=https://api.roomy.space
export APPSERVER_DID=did:web:api.roomy.space
export OLLAMA_CLOUD_API_KEY=$(grep OLLAMA_CLOUD_API_KEY /home/exedev/.omp/agent/ollama-cloud.env | cut -d= -f2-)
# Only these DIDs may trigger prompts (comma-separated). Meri.
export OMP_BRIDGE_AUTHORIZED_DIDS="${OMP_BRIDGE_AUTHORIZED_DIDS:-did:plc:mmyj7mk7kh3jqhw6zs4prbuk}"
exec npx tsx bin/roomy-bridge.ts \
  --space did:plc:drzgt2m6lmcel62gfbzjeap3 \
  --duration 0
