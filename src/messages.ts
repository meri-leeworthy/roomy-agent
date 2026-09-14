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
  /** Target message id of a reply attachment, when the message is a reply
   *  (`space.roomy.attachment.reply.v0` → reply edge). Present on wire DTOs
   *  post-Stage-1 appserver; used for continuation threading. */
  replyTo?: string;
}

export interface AgentIdentity {
  agentDid: string;
  agentHandle: string;
  agentName: string;
}

/** Fenced code blocks (``` / ~~~), including a fence left open to end of text. */
const FENCED_CODE = /(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g;
/** Inline code spans — single backticks, never spanning a newline. */
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * Whether the message carries a DID-authoritative `#didMention` facet for the
 * agent. This is the same signal the appserver routes `#mention` frames from,
 * so it never depends on message text — it is the only signal that means the
 * agent was *addressed*, as opposed to its name merely appearing.
 */
export function isMentionedByFacet(msg: IncomingMessage, identity: AgentIdentity): boolean {
  const mime = msg.mimeType ?? "";
  if (mime !== "application/vnd.roomy.richtext+json") return false;
  try {
    const blocks = deserializeBody(mime, decodeContentBytes(msg.content));
    return Array.isArray(blocks) && extractMentionDids(blocks).includes(identity.agentDid);
  } catch {
    return false;
  }
}

/**
 * Decide whether a message mentions the agent. The DID is authoritative (a
 * `#didMention` facet is a stable, unambiguous match); plain-text matching is a
 * best-effort fallback for messages not authored with a rich mention.
 */
export function isMentioned(msg: IncomingMessage, identity: AgentIdentity): boolean {
  const { agentDid, agentHandle, agentName } = identity;

  if (isMentionedByFacet(msg, identity)) return true;

  // Strict fallback: only an explicit @Name / @handle / @did mention counts.
  // A bare substring of the agent's name (e.g. "Chanterelle" appearing in a
  // report, thinking trace, or forwarded message) must NOT trigger the agent.
  // Code is blanked first: reports and traces quote `@Agent` inside fenced
  // blocks and inline spans, and a quoted name is not an address — matching it
  // spawned spurious agent sessions that re-ran work already done. The text
  // outside code is untouched, so a real `@Name` still triggers.
  const text = (msg.content ?? "").replace(FENCED_CODE, " ").replace(INLINE_CODE, " ");
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
