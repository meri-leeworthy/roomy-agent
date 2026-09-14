#!/bin/bash
# Roomy -> omp agent bridge (Chanterelle) — full pipeline.
# roomy-bridge (emit only: WS + mention detection -> NDJSON) | roomy-cli respond (responder).
set -euo pipefail
export NODE_OPTIONS=--dns-result-order=ipv4first
export PATH=/home/exedev/node/bin:/home/exedev/.local/bin:$PATH
cd "$(dirname "$0")"

# Roomy creds (handle/app-password) + appserver. Production appserver.
set -a; source .env; set +a
export APPSERVER_URL=https://api.roomy.space
export APPSERVER_DID=did:web:api.roomy.space

# omp / ollama-cloud creds + workflow context.
export OLLAMA_CLOUD_API_KEY=$(grep OLLAMA_CLOUD_API_KEY /home/exedev/.omp/agent/ollama-cloud.env | cut -d= -f2-)
export OMP_SYSTEM_PROMPT_FILE="${OMP_SYSTEM_PROMPT_FILE:-/home/exedev/.omp/workflow-context.md}"

# Only these DIDs may trigger prompts. Meri + coordinator (Chanterelle).
export OMP_BRIDGE_AUTHORIZED_DIDS="${OMP_BRIDGE_AUTHORIZED_DIDS:-did:plc:mmyj7mk7kh3jqhw6zs4prbuk}"

SPACE=did:plc:drzgt2m6lmcel62gfbzjeap3

# Note: `set -o pipefail` (above) makes the pipeline exit if EITHER side dies.
#
# --include-self lets the agent trigger itself on a #didMention facet of its own
# DID — the scheduled self-check posts such a mention from cron. The bridge's
# isTrigger guard triggers on a self-authored message ONLY when it carries that
# facet, so the agent's own reports (which mention its name in plain text) can
# never start another session.
exec npx tsx bin/roomy-bridge.ts --space "$SPACE" --duration 0 --include-self \
  | npx tsx /home/exedev/roomy/packages/cli/src/cli.ts respond \
      --cwd /home/exedev/roomy \
      --include-self \
      --system-prompt-file "$OMP_SYSTEM_PROMPT_FILE"
