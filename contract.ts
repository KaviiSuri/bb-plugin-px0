// Shared RPC contract between server.ts (runs in the BB server) and host.ts
// (runs full-trust on the machine that owns the workspace). Both sides import
// this file, so the wire shape can never drift.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const serverSchema = z.object({
  /** Absolute workspace directory px0 was started on. */
  path: z.string(),
  /** Loopback port px0 is listening on, on the workspace's own host. */
  port: z.number().int().min(1).max(65535),
  /** Whether it was launched with editing disabled. */
  readOnly: z.boolean(),
  startedAt: z.number(),
});

export type Px0Server = z.infer<typeof serverSchema>;

export const hostContract = defineRpcContract({
  /**
   * Start px0 on `path`, or return the already-running server for that exact
   * path. Idempotent: two threads on the same worktree share one process.
   */
  ensure: {
    input: z
      .object({
        path: z.string().min(1),
        readOnly: z.boolean(),
        /** Explicit binary path from settings; empty means "probe". */
        binaryPath: z.string(),
      })
      .strict(),
    output: serverSchema,
  },
  /** Stop the px0 server for one path. */
  stop: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.object({ stopped: z.boolean() }).strict(),
  },
  /** Every px0 server this host currently owns. */
  list: {
    input: z.null(),
    output: z.object({ servers: z.array(serverSchema) }).strict(),
  },
});
