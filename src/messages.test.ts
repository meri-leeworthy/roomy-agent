import { test } from "node:test";
import assert from "node:assert/strict";
import { isMentioned, isTrigger, type AgentIdentity, type IncomingMessage } from "./messages.js";

const IDENTITY: AgentIdentity = {
  agentDid: "did:plc:littlefox000000000000000",
  agentHandle: "meri-little-fox.roomy.chat",
  agentName: "Little Fox",
};

function msg(content: string, mimeType = "text/markdown"): IncomingMessage {
  return {
    id: "01M00000000000000000000000",
    roomId: "01M00000000000000000000001",
    authorDid: "did:plc:chanterelle000000000000",
    authorName: "Chanterelle",
    content,
    mimeType,
    timestamp: "2026-09-14T00:00:00.000Z",
  };
}
/** A richtext message carrying a #didMention facet for `did`. */
function facetMsg(authorDid: string, mentionDid: string, label = "Little Fox"): IncomingMessage {
  const blocks = [
    {
      $type: "space.roomy.richtext.blocks#text",
      text: `@${label}`,
      facets: [
        {
          index: { byteStart: 0, byteEnd: label.length + 1 },
          features: [{ $type: "space.roomy.richtext.facet#didMention", did: mentionDid }],
        },
      ],
    },
  ];
  const content = Buffer.from(
    JSON.stringify({ $type: "space.roomy.richtext.document", blocks }),
  ).toString("base64");
  return {
    id: "01M00000000000000000000009",
    roomId: "01M00000000000000000000001",
    authorDid,
    authorName: "Chanterelle",
    content,
    mimeType: "application/vnd.roomy.richtext+json",
    timestamp: "2026-09-14T00:00:00.000Z",
  };
}


test("a real @Name address triggers", () => {
  assert.equal(isMentioned(msg("@Little Fox please review this"), IDENTITY), true);
  assert.equal(isMentioned(msg("hey @Little Fox — ping"), IDENTITY), true);
});

test("a bare name without @ does not trigger", () => {
  assert.equal(isMentioned(msg("Little Fox reported the result"), IDENTITY), false);
});

test("a quoted @Name inside a fenced code block does not trigger", () => {
  const report = [
    "## Why we had duplicate sessions",
    "",
    "Journal evidence:",
    "",
    "```",
    "1789095282211254  565077  roomy-agent.service  [respond] mention from Chanterelle: @Little Fox TASK-72 …",
    "1789095282214721  710893  omp-bridge.service   [respond] mention from Chanterelle: @Little Fox TASK-72 …",
    "```",
    "",
    "No agent is addressed by this message.",
  ].join("\n");
  assert.equal(isMentioned(msg(report), IDENTITY), false);
});

test("a quoted @Name inside an inline code span does not trigger", () => {
  assert.equal(isMentioned(msg("posting with `@Little Fox` in the body"), IDENTITY), false);
});

test("an unclosed fence still suppresses the rest of the message", () => {
  assert.equal(isMentioned(msg("```\n@Little Fox TASK-1\nno closing fence"), IDENTITY), false);
});

test("an address outside a fence still triggers even with a fence present", () => {
  const mixed = ["```", "@Little Fox is quoted here", "```", "", "@Little Fox this one is real"].join("\n");
  assert.equal(isMentioned(msg(mixed), IDENTITY), true);
});

test("a #didMention facet is authoritative regardless of body text", () => {
  const blocks = [
    {
      $type: "space.roomy.richtext.blocks#text",
      text: "@Little Fox",
      facets: [
        {
          index: { byteStart: 0, byteEnd: 11 },
          features: [{ $type: "space.roomy.richtext.facet#didMention", did: IDENTITY.agentDid }],
        },
      ],
    },
  ];
  const content = Buffer.from(
    JSON.stringify({ $type: "space.roomy.richtext.document", blocks }),
  ).toString("base64");
  assert.equal(
    isMentioned(msg(content, "application/vnd.roomy.richtext+json"), IDENTITY),
    true,
  );
});

const SELF = IDENTITY.agentDid;

test("a self-authored facet self-mention triggers (scheduled self-prompt)", () => {
  assert.equal(isTrigger(facetMsg(SELF, SELF), IDENTITY), true);
});

test("a self-authored plain-text @Name does NOT trigger — no reply recursion", () => {
  // The load-bearing invariant: agent output quotes its own name. If plain text
  // triggered here, every posted report would start another session.
  const self = (content: string) => ({ ...msg(content, "text/markdown"), authorDid: SELF });
  assert.equal(isTrigger(self("@Little Fox"), IDENTITY), false);
  const report = self("Scheduled check done — Little Fox idle.\n\n@Little Fox noted above.");
  assert.equal(isTrigger(report, IDENTITY), false);
});

test("a self-authored facet mention of ANOTHER agent does not trigger this one", () => {
  assert.equal(isTrigger(facetMsg(SELF, "did:plc:someoneelse0000000000000"), IDENTITY), false);
});

test("another author's plain-text @Name still triggers (unchanged behaviour)", () => {
  const fromOther = { ...msg("@Little Fox please review"), authorDid: "did:plc:meri000000000000000000" };
  assert.equal(isTrigger(fromOther, IDENTITY), true);
});
