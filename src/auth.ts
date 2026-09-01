import { AtpAgent } from "@atproto/api";
import { transport } from "@roomy-space/sdk";

const { ServiceAuthClient, DirectXrpcClient: DirectXrpcClientClass } = transport;
type DirectXrpcClient = InstanceType<typeof DirectXrpcClientClass>;

export interface AuthState {
  agent: AtpAgent;
  xrpc: DirectXrpcClient;
}

export interface Config {
  appserverUrl: string;
  appserverDid: string;
  identifier: string;
  appPassword: string;
}

export function loadConfig(): Config {
  const appserverUrl =
    process.env.APPSERVER_URL ||
    process.env.VITE_APPSERVER_WS_ORIGIN?.replace(/^ws(s?):\/\//, "http$1://") ||
    "http://localhost:8080";
  return {
    appserverUrl,
    appserverDid: process.env.APPSERVER_DID || "did:web:api.roomy.space",
    identifier: process.env.ATPROTO_IDENTIFIER || "",
    appPassword: process.env.ATPROTO_APP_PASSWORD || "",
  };
}

/**
 * Authenticate via ATProto app password and wire up a DirectXrpcClient.
 *
 * Uses the same pattern as app-lite's test-mode auth:
 * 1. Login to the account's PDS (resolved from the DID document) with identifier + app password
 * 2. Create ServiceAuthClient for token management
 * 3. Create DirectXrpcClient pointed at the appserver
 */
export async function authenticate(config: Config): Promise<AuthState> {
  if (!config.identifier || !config.appPassword) {
    throw new Error(
      "Authentication required. Set ATPROTO_IDENTIFIER and ATPROTO_APP_PASSWORD environment variables.",
    );
  }

  const pds = await resolvePds(config.identifier);
  const agent = new AtpAgent({ service: pds });
  await agent.login({ identifier: config.identifier, password: config.appPassword });
  if (!agent.did) throw new Error("Login failed — no DID returned");

  const serviceAuth = new ServiceAuthClient(agent);
  const xrpc = new DirectXrpcClientClass(
    config.appserverUrl,
    config.appserverDid,
    serviceAuth,
  );

  return { agent, xrpc };
}

/**
 * Resolve the PDS service endpoint for an account.
 *
 * The bridge can't assume every account lives on bsky.social — Roomy accounts
 * (and other custom-handle accounts) are hosted on their own PDS. We resolve
 * the account's DID via the PLC directory and read the
 * `AtprotoPersonalDataServer` service endpoint from the DID document. Falls
 * back to bsky.social when resolution fails so existing behaviour is preserved.
 */
async function resolvePds(identifier: string): Promise<string> {
  if (process.env.ATPROTO_PDS) return process.env.ATPROTO_PDS;

  try {
    const did = identifier.startsWith("did:")
      ? identifier
      : await resolveHandleToDid(identifier);
    const doc = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
    if (doc.ok) {
      const json = (await doc.json()) as {
        service?: { type?: string; serviceEndpoint?: string }[];
      };
      const pds = json.service?.find((s) => s.type === "AtprotoPersonalDataServer");
      if (pds?.serviceEndpoint) return pds.serviceEndpoint;
    }
  } catch {
    // fall through to default
  }
  return "https://bsky.social";
}

async function resolveHandleToDid(handle: string): Promise<string> {
  // Try the Bluesky resolver first (handles DNS + PLC lookups reliably).
  try {
    const resp = await fetch(
      `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    );
    if (resp.ok) {
      const json = (await resp.json()) as { did?: string };
      if (json.did) return json.did;
    }
  } catch {
    // fall through to PLC directory
  }
  const resp = await fetch(
    `https://plc.directory/resolve?handle=${encodeURIComponent(handle)}`,
  );
  if (!resp.ok) throw new Error(`Could not resolve handle: ${handle}`);
  const json = (await resp.json()) as { did?: string };
  if (!json.did) throw new Error(`Could not resolve handle: ${handle}`);
  return json.did;
}
