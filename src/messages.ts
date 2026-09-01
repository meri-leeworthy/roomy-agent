import { deserializeBody, blocksToPlaintext, extractMentionDids } from "@roomy-space/sdk";

/** A message as delivered by the appserver sync frames. */
export interface IncomingMessage {
  id: string;
  roomId: string;
  authorDid: string;
  authorName: string;
  content: string;
  mimeType?: string;
  timestamp: string;
}

export interface AgentIdentity {
  agentDid: string;
  agentHandle: string;
  agentName: string;
}

/**
 * Decide whether a message mentions the agent. The DID is authoritative (a
 * `#didMention` facet is a stable, unambiguous match); plain-text matching is a
 * best-effort fallback for messages not authored with a rich mention.
 */
export function isMentioned(msg: IncomingMessage, identity: AgentIdentity): boolean {
  const { agentDid, agentHandle, agentName } = identity;
  const mime = msg.mimeType ?? "";

  if (mime === "application/vnd.roomy.richtext+json") {
    try {
      const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
      if (Array.isArray(blocks)) {
        const dids = extractMentionDids(blocks);
        if (dids.includes(agentDid)) return true;
      }
    } catch {
      // fall through to text matching
    }
  }

  // Strict fallback: only an explicit @Name / @handle / @did mention counts.
  // A bare substring of the agent's name (e.g. "Chanterelle" appearing in a
  // report, thinking trace, or forwarded message) must NOT trigger the agent.
  const text = msg.content ?? "";
  const needles = [agentName, agentHandle, agentDid].filter(Boolean);
  return needles.some((n) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Multi-word names (e.g. "Little Fox"): allow whitespace between words
    // after the leading @, so `@Little Fox` and `@Little\nFox` both match.
    const spaced = esc.replace(/\\ /g, "\\s*");
    return new RegExp(`@${spaced}(?![\\w-])`, "i").test(text);
  });
}

/** Extract plain text from a message regardless of mime type. */
export function plaintext(msg: IncomingMessage): string {
  const mime = msg.mimeType ?? "";
  if (mime === "application/vnd.roomy.richtext+json") {
    try {
      const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
      if (Array.isArray(blocks)) return blocksToPlaintext(blocks);
    } catch {
      // fall through
    }
  }
  return msg.content ?? "";
}

/** The appserver base64-encodes non-text content blobs (e.g. richtext JSON) on
 * the wire; decode back to bytes before parsing. */
function decodeContentBytes(content: string): Uint8Array {
  return Buffer.from(content, "base64");
}
