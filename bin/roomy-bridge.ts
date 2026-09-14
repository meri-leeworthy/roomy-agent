#!/usr/bin/env node
import { Command } from "commander";
import { listen } from "../src/index.js";
import { authenticate, loadConfig } from "../src/auth.js";

const program = new Command();

program
  .name("roomy-bridge")
  .description("Roomy → omp bridge: emit mention events as NDJSON on stdout")
  .option("--space <id>", "Space ID (defaults to every space the agent has joined)")
  .option("--room <id>", "Room ID (defaults to all rooms in the space)")
  .option("--no-mention-only", "Emit every message, not just mentions")
  .option("--duration <ms>", "Stop after this many ms (0 = run forever)", "0")
  .option("--include-self", "Also emit the agent's own messages (scheduled self-prompt; triggers only on an explicit facet self-mention)")
  .option("--authorized-dids <dids>", "Comma-separated DIDs allowed to trigger responses (default: $OMP_BRIDGE_AUTHORIZED_DIDS; empty = anyone mentioned)")
  .action(async (options: {
    space?: string;
    room?: string;
    mentionOnly: boolean;
    duration: string;
    includeSelf?: boolean;
    authorizedDids?: string;
  }) => {
    const config = loadConfig();
    const auth = await authenticate(config);
    await listen(auth, {
      spaceId: options.space,
      roomId: options.room,
      mentionOnly: options.mentionOnly,
      durationMs: Number(options.duration),
      includeSelf: options.includeSelf,
      authorizedDids: (options.authorizedDids ?? process.env.OMP_BRIDGE_AUTHORIZED_DIDS ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  });

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(2);
});
