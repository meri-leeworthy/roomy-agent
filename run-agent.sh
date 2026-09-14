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

# Both stages must stay alive, so this script supervises them instead of
# letting bash's pipeline semantics hide a dead one. A plain
# `bridge | responder` does NOT fail fast: bash waits for EVERY stage, so a
# bridge stage that dies leaves the responder running and the unit reporting
# `active` with a silently broken mention path (2026-09-14: 66 minutes of dead
# bridge hidden behind Restart=always; the cron self-check kept skipping with
# "responder busy"). Here the first stage to exit takes the other down and the
# script exits non-zero, so systemd restarts the whole pipeline within
# RestartSec. The responder's queue heal (requeueStaleActive) retries the
# interrupted job exactly once.
#
# Each stage runs in its OWN process group, via job control (`set -m`, below):
# `npx tsx …` is a wrapper whose real `node` child is a separate process.
# Signalling only the wrapper leaves that child reparented to init and still
# subscribed to production — the orphan-duplicate-bridge trap (2026-09-14, pids
# 204256/204531). Job control makes `$!` the group leader, so killing the
# negative pid takes the wrapper, its `sh`, and the node child down together.
# (`setsid` does not work here — it forks, so `$!` is not the pgid; verified:
# a group kill by `$!` left 4 orphans.)
#
# --include-self lets the agent trigger itself on a #didMention facet of its own
# DID — the scheduled self-check posts such a mention from cron. The bridge's
# isTrigger guard triggers on a self-authored message ONLY when it carries that
# facet, so the agent's own reports (which mention its name in plain text) can
# never start another session.
# Job control: `set -m` puts each background stage in its own process group and
# makes `$!` that group's leader, which is what makes the group kill in
# cleanup() take every descendant down (wrappers included).
set -m
RUNDIR="$(mktemp -d /tmp/roomy-bridge.XXXXXX)"
FIFO="$RUNDIR/bridge.ndjson"
mkfifo "$FIFO"

npx tsx bin/roomy-bridge.ts --space "$SPACE" --duration 0 --include-self >"$FIFO" &
BRIDGE_PGID=$!
npx tsx /home/exedev/roomy/packages/cli/src/cli.ts respond \
    --cwd /home/exedev/roomy \
    --include-self \
    --system-prompt-file "$OMP_SYSTEM_PROMPT_FILE" <"$FIFO" &
RESPONDER_PGID=$!

cleanup() {
  kill -TERM -- "-$BRIDGE_PGID" "-$RESPONDER_PGID" 2>/dev/null || true
  rm -rf "$RUNDIR"
}
trap 'cleanup; exit 143' INT TERM

# `wait -n` returns as soon as ANY stage exits — the whole point. (Bare `wait`
# would wait for both, which is exactly the bug being fixed.) It needs no
# arguments, so bash 4.3+ suffices; `-e` is off around it because a stage
# dying is the signal here, not an error.
set +e
wait -n
STATUS=$?
set -e
echo "run-agent: a pipeline stage exited (status $STATUS) — dropping the other and restarting" >&2
cleanup
wait 2>/dev/null || true
# Never a clean shutdown: an unexpected stage exit must make systemd restart us.
if [ "$STATUS" -eq 0 ]; then STATUS=1; fi
exit "$STATUS"
