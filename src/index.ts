import { sync, transport } from "@roomy-space/sdk";
import { isMentioned, type AgentIdentity, type IncomingMessage } from "./messages.js";

const { SyncConnection } = sync;
type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

/** Authenticated context the bridge needs to talk to the appserver.
 *  Structurally compatible with the CLI's AuthState ({ agent, xrpc }). */
export interface BridgeAuth {
  agent: { did?: string; session?: { handle?: string } };
  xrpc: DirectXrpcClient;
}

export interface BridgeOptions {
  /** Space to listen in. When omitted, listens to every space the agent joined. */
  spaceId?: string;
  /** Specific room; defaults to all rooms in the space. */
  roomId?: string;
  /** Only emit messages that mention the agent. Default true. */
  mentionOnly?: boolean;
  /** DIDs allowed to trigger responses. Messages from any other DID are
   *  filtered out entirely. Empty/undefined keeps the default behavior
   *  (any mention is emitted). */
  authorizedDids?: string[];
  /** How long to keep listening (ms). 0 = forever. */
  durationMs?: number;
  /** Also emit the agent's own messages (testing). Default false. */
  includeSelf?: boolean;
  /** Logger; defaults to console.error. */
  log?: (msg: string) => void;
}

/**
 * One mention event, emitted as a single NDJSON line on stdout so any
 * downstream consumer (`roomy-cli respond`, a script, another agent) can pick
 * it up over a pipe. `content` is plaintext; the bridge does not decode rich
 * bodies further than that.
 */
export interface MentionEvent {
  /** Event kind — always "mention" for now; future event kinds (e.g. edits)
   *  will be distinguishable by this field. */
  kind: "mention";
  spaceId: string;
  roomId: string;
  /** The message that mentioned the agent. */
  message: IncomingMessage;
  /** True when the message carried a DID-authoritative mention facet;
   *  false when matched via the plain-text fallback. */
  explicit: boolean;
}

/**
 * Listen to Roomy over the appserver WebSocket and write mention events to
 * stdout as NDJSON, one line per event.
 *
 * Default: subscribes to the server-side `mentions:<did>` topic (one
 * subscription, all spaces). With `mentionOnly: false` it falls back to
 * per-room subscriptions and emits every message.
 */
export async function listen(auth: BridgeAuth, opts: BridgeOptions): Promise<void> {
  const { agent, xrpc } = auth;
  const log = opts.log ?? ((m: string) => console.error(`[bridge] ${m}`));
  const identity = await resolveAgentIdentity(xrpc, agent);

  // The downstream consumer (e.g. `roomy-cli respond`) can die at any point.
  // Writing to its (now broken) pipe emits an async 'error' event (EPIPE) on the
  // stdout socket; with no handler, an unhandled 'error' event crashed the whole
  // bridge and took the roomy→omp pipeline down with it. Handle it as a clean
  // exit signal so systemd restarts the bridge fresh instead of the pipeline
  // dying on the EPIPE. process.exit(0) here is safe: at this point there is no
  // consumer left to emit to, and the WebSocket sub is torn down with the proc.
  process.stdout.on("error", (err) => {
    log(`stdout pipe closed (${err.message}); exiting`);
    process.exit(0);
  });

  const authorized = opts.authorizedDids?.map((d) => d.trim()).filter(Boolean) ?? [];

  const emit = (evt: MentionEvent) => {
    // NDJSON contract: one JSON object per line, no trailing newline beyond
    // the line terminator. Downstream consumers read line-by-line. A broken
    // pipe is handled by the process.stdout 'error' handler installed above
    // (which exits cleanly) rather than an unhandled EPIPE crash.
    process.stdout.write(`${JSON.stringify(evt)}\n`);
  };

  const scopedRooms = opts.spaceId || opts.roomId
    ? await resolveRooms(xrpc, opts.spaceId, opts.roomId)
    : new Map<string, string>();

  // Rooms we've subscribed to (a fallback to the server-side mentions topic so
  // mentions still get caught if the appserver doesn't emit #mention, and so a
  // room/thread created after startup is picked up on the next refresh).
  const subscribedRooms = new Set<string>();
  // Dedupe message ids across the #mention and #messageDiff paths (a mention
  // message arrives on both), pruning entries older than 10 minutes.
  const seen = new Map<string, number>();

  const processMessage = (msg: IncomingMessage, roomId: string, spaceId: string) => {
    if (!msg.id) return;
    const now = Date.now();
    for (const [k, v] of seen) if (now - v > 600_000) seen.delete(k);
    if (seen.has(msg.id)) return;
    seen.set(msg.id, now);
    if (msg.authorDid === identity.agentDid && !opts.includeSelf) return;

    const mentioned = isMentioned(msg, identity);
    const mentionOnly = opts.mentionOnly ?? true;
    if (mentionOnly && !mentioned) return;

    if (authorized.length > 0 && !authorized.includes(msg.authorDid)) {
      log(`ignoring message from unauthorized DID ${msg.authorDid}`);
      return;
    }

    emit({
      kind: "mention",
      spaceId,
      roomId,
      message: msg,
      explicit: mentioned,
    });
  };

  const ensureRoomSubs = () => {
    for (const roomId of scopedRooms.keys()) {
      if (subscribedRooms.has(roomId)) continue;
      conn.subscribe({ kind: "room", id: roomId });
      subscribedRooms.add(roomId);
      log(`Listening on room ${roomId}`);
    }
  };

  const wsOrigin = xrpc.appserverUrl.replace(/^http/, "ws");
  const wsUrl = `${wsOrigin.replace(/\/+$/, "")}/xrpc/space.roomy.sync.subscribe`;

  const conn = new SyncConnection({
    wsUrl,
    fetchTicket: async () => {
      const res = await xrpc.procedure("space.roomy.auth.getConnectionTicket", {});
      return res.ticket;
    },
    logger: (m) => log(m),
    // If the appserver stays unreachable / wedges (e.g. a stale auth token
    // makes every ticket fetch 404 while the process spins in a reconnect
    // loop), give up after this many consecutive failures and exit so the
    // systemd supervisor restarts this process fresh — clearing the wedged
    // in-memory state. Without this it would retry forever, silently.
    maxReconnectAttempts: 25,
    onGiveUp: (info) => {
      log(
        `Giving up after ${info.attempt} consecutive reconnect failures (unreachable appserver); ` +
          `exiting for systemd restart`,
      );
      process.exit(1);
    },
  });

  conn.onFrame((frame) => {
    const t = frame.header["t"];
    if (t !== "#mention" && t !== "#messageDiff") return;
    const body = frame.body as {
      spaceId?: string;
      roomId?: string;
      ops?: { op?: string; message?: IncomingMessage }[];
    };
    if (!body.roomId) return;
    if (t === "#messageDiff") {
      const sId = scopedRooms.get(body.roomId);
      if (!sId) return;
      for (const op of body.ops ?? []) {
        if (op.op !== "add" || !op.message) continue;
        processMessage(op.message, body.roomId, sId);
      }
      return;
    }
    // #mention: frame carries the space id directly.
    const sId = body.spaceId;
    if (!sId) return;
    if (opts.spaceId || opts.roomId) {
      // Scope mentions by the explicit space/room ids (not the rooms known at
      // startup), so a mention in a room/thread created after startup gets
      // through. The room-diff path already maps via scopedRooms.
      if (opts.roomId && body.roomId !== opts.roomId) return;
      if (opts.spaceId && sId !== opts.spaceId) return;
    }
    for (const op of body.ops ?? []) {
      if (op.op !== "add" || !op.message) continue;
      processMessage(op.message, body.roomId, sId);
    }
  });

  await conn.connect();

  // The server-side mentions topic is the primary, authoritative signal.
  conn.subscribe({ kind: "mentions", id: identity.agentDid });
  log(`Listening for mentions of ${identity.agentName || identity.agentDid}`);

  // Also subscribe to the rooms we can see, so mention detection still works
  // via isMentioned (facet + plain-text fallback) if the appserver doesn't emit
  // #mention frames, and so new rooms/threads are covered by periodic refresh.
  ensureRoomSubs();
  const refreshTimer = setInterval(async () => {
    try {
      const fresh = await resolveRooms(xrpc, opts.spaceId, opts.roomId);
      for (const [roomId, spaceId] of fresh) scopedRooms.set(roomId, spaceId);
      ensureRoomSubs();
    } catch (error) {
      log(`room refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 60_000);

  const shutdown = () => {
    clearInterval(refreshTimer);
    conn.close();
  };
  if (opts.durationMs && opts.durationMs > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, opts.durationMs);
    await promise;
    shutdown();
  } else {
    const { promise, reject } = Promise.withResolvers<never>();
    const onSignal = (sig: string) => {
      shutdown();
      reject(new Error(sig));
    };
    process.on("SIGINT", () => onSignal("Interrupted"));
    process.on("SIGTERM", () => onSignal("Terminated"));
    await promise;
  }
}

async function resolveAgentIdentity(
  xrpc: DirectXrpcClient,
  agent: BridgeAuth["agent"],
): Promise<AgentIdentity> {
  const agentDid = agent.did ?? "";
  const agentHandle = agent.session?.handle ?? "";
  let agentName = agentDid;
  try {
    const profile = await xrpc.query("space.roomy.user.getProfile", { actor: agentDid });
    if (profile?.displayName) agentName = profile.displayName;
  } catch {
    // best-effort
  }
  return { agentDid, agentHandle, agentName };
}

async function resolveRooms(
  xrpc: DirectXrpcClient,
  spaceId?: string,
  roomId?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (roomId) {
    if (!spaceId) throw new Error("--room requires --space");
    out.set(roomId, spaceId);
    return out;
  }

  const spaceIds = spaceId
    ? [spaceId]
    : (await listSpaces(xrpc)).filter((s) => s.isMember).map((s) => s.id);

  for (const sid of spaceIds) {
    const { categories, orphans } = await listRooms(xrpc, sid);
    for (const r of [...categories.flatMap((c) => c.channels), ...orphans]) {
      out.set(r.id, sid);
    }
  }
  return out;
}

async function listSpaces(xrpc: DirectXrpcClient): Promise<{ id: string; isMember: boolean }[]> {
  const result = await xrpc.query("space.roomy.space.getSpaces", {});
  return result.spaces.map((s) => ({ id: s.id, isMember: s.isMember }));
}

async function listRooms(
  xrpc: DirectXrpcClient,
  spaceId: string,
): Promise<{ categories: { channels: { id: string }[] }[]; orphans: { id: string }[] }> {
  const meta = await xrpc.query("space.roomy.space.getMetadata", { spaceId });
  return {
    categories: meta.sidebar.categories.map((cat) => ({
      channels: cat.channels.map((ch) => ({ id: ch.id })),
    })),
    orphans: meta.sidebar.orphans.map((ch) => ({ id: ch.id })),
  };
}
