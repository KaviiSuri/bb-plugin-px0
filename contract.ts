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
  /** The BB thread px0 sends edits to. Null for shared read-only servers. */
  threadId: z.string().nullable(),
  startedAt: z.number(),
});

export type Px0Server = z.infer<typeof serverSchema>;

export const hostContract = defineRpcContract({
  /**
   * Start px0 on `path`, or return its existing server. Read-only servers are
   * shared by path; editable servers are isolated by path and thread.
   */
  ensure: {
    input: z
      .object({
        path: z.string().min(1),
        readOnly: z.boolean(),
        /** Originating BB thread for editable sessions. */
        threadId: z.string().min(1),
        /** Explicit binary path from settings; empty means "probe". */
        binaryPath: z.string(),
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
