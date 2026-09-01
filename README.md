# Roomy → agent bridge

Emit-only bridge: subscribes to the Roomy appserver and writes **one NDJSON
line per mention event** to stdout. It owns the WebSocket connection, mention
detection, and the authorization allowlist — and **nothing else**. It never
runs an agent and never posts replies; downstream consumers do that (see
`roomy-cli respond` in the Roomy monorepo for the reference responder).

```
Roomy room ──WS──▶ appserver (mention detection) ──#mention──▶ roomy-bridge ──NDJSON──▶ responder
```

## Pipeline

The agent pipeline is two processes and a pipe:

```bash
roomy-bridge --space <sid> | roomy-cli respond
```

- `roomy-bridge` — this repo. Auth, WebSocket, dedupe, NDJSON to stdout.
- `roomy-cli respond` — the responder. Reads NDJSON from stdin; per event
  fetches room context, runs omp, posts the reply. (Lives in the roomy repo.)

Both halves read the same `ATPROTO_*` / `APPSERVER_*` env vars. `roomy-bridge`
must be restarted for bridge changes; the responder is independent and can be
updated without touching the connection.

## NDJSON event schema

One JSON object per line:

```json
{
  "kind": "mention",
  "spaceId": "did:...",
  "roomId": "...",
  "message": {
    "id": "...",
    "roomId": "...",
    "authorDid": "did:plc:...",
    "authorName": "...",
    "content": "plain text of the message",
    "mimeType": "text/markdown",
    "timestamp": "..."
  },
  "explicit": true
}
```

- `kind` — always `"mention"` today; future event kinds are distinguishable here.
- `message.content` is plaintext; richtext bodies are decoded.
- `explicit` — true when the message carried a DID-authoritative mention facet,
  false when matched via the plain-text `@Name` fallback.

## Setup

```bash
cp .env.example .env   # edit ATPROTO_IDENTIFIER / ATPROTO_APP_PASSWORD
pnpm install
pnpm build             # or: npx tsx bin/roomy-bridge.ts
```

## Usage

```bash
# All joined spaces, forever
roomy-bridge

# One space, for 30s (testing)
roomy-bridge --space did:plc:... --duration 30000

# Mention-only (default) vs every message
roomy-bridge --no-mention-only

# Authorization allowlist (env var also supported)
OMP_BRIDGE_AUTHORIZED_DIDS=did:plc:meri roomy-bridge
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--space <id>` | (all joined) | Space to listen in |
| `--room <id>` | (all rooms) | Specific room (requires --space) |
| `--no-mention-only` | mention-only | Emit every message, not just mentions |
| `--duration <ms>` | 0 (forever) | Stop after this many ms |
| `--include-self` | off | Also emit the agent's own messages (testing) |
| `--authorized-dids <dids>` | `$OMP_BRIDGE_AUTHORIZED_DIDS` | Comma-separated DIDs allowed to trigger responses |

## Deployment

`omp-bridge.service` is a systemd unit for the emit side (the responder runs
as the bridge process in production today; see the roomy repo for the CLI
respond command). Install:

```bash
sudo cp omp-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now omp-bridge
```

## Notes

- The bridge keeps a `mentions:<did>` subscription plus per-room fallback
  subscriptions. New rooms/threads are picked up by a 60s refresh.
- On WebSocket drop, the SDK reconnects with exponential backoff and re-sends
  all topics automatically. Mentions during the offline window are missed —
  the responder can't answer what the bridge never saw.
- Both `#mention` and `#messageDiff` frames are consumed with id-dedup (a
  mention arrives on both paths).
