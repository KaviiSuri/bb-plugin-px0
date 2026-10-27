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
  /** Whether px0's coding-harness actions are disabled. Direct edits remain available. */
  agentDisabled: z.boolean(),
  /** The BB thread px0 sends agent prompts to. Null for shared sessions. */
  threadId: z.string().nullable(),
  /** Version reported by the px0 binary that owns this server. */
  px0Version: z.string(),
  startedAt: z.number(),
});

export type Px0Server = z.infer<typeof serverSchema>;

export const hostContract = defineRpcContract({
  /**
   * Start px0 on `path`, or return its existing server. Sessions without the
   * BB agent bridge are shared by path; bridged sessions are isolated by
   * path and thread.
   */
  ensure: {
    input: z
      .object({
        path: z.string().min(1),
        agentDisabled: z.boolean(),
        /** Originating BB thread for agent-bridged sessions. */
        threadId: z.string().min(1),
        /** Explicit binary path from settings; empty means "probe". */
        binaryPath: z.string(),
        /** Configured BB app origin allowed to embed this workspace. */
        frameOrigin: z.string().url().optional(),
      })
      .strict(),
    output: serverSchema,
  },
  /** Stop the px0 server for one path. */
  stop: {
    input: z
      .object({
        path: z.string().min(1),
        threadId: z.string().min(1),
      })
      .strict(),
    output: z.object({ stopped: z.boolean() }).strict(),
  },
  /** Every px0 server this host currently owns. */
  list: {
    input: z.null(),
    output: z.object({ servers: z.array(serverSchema) }).strict(),
  },
});
