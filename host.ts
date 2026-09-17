// bb-plugin-px0 — host entry.
//
// Full-trust Node running on the machine that owns the workspace (which is not
// necessarily the machine running the BB server). This is the only place
// allowed to spawn processes, so px0 lives here.
//
// One px0 process per absolute directory, reused across threads and reloads of
// the panel. The worker holds a retain lease while any child is alive so BB's
// five-minute idle eviction does not kill the servers out from under an open
// panel.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type Px0Server } from "./contract";

interface Entry {
  server: Px0Server;
  child: ChildProcess;
  ready: Promise<void>;
}

/** path → running px0. Module state is fine: one worker per plugin per host. */
const entries = new Map<string, Entry>();

/** Keeps the worker (and therefore the children) alive while servers run. */
let lease: { dispose: () => void } | null = null;

const BINARY_CANDIDATES = [
  join(homedir(), ".local", "bin", "px0"),
  "/opt/homebrew/bin/px0",
  "/usr/local/bin/px0",
];

function resolveBinary(configured: string): string {
  const candidates =
    configured.trim() === ""
      ? BINARY_CANDIDATES
      : [configured.trim(), ...BINARY_CANDIDATES];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  // Fall back to PATH resolution and let spawn report ENOENT with context.
  return "px0";
}

/** Ask the OS for a free loopback port, then hand it straight to px0. */
function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a loopback port for px0."));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilServing(
  port: number,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`px0 exited before it started serving (${child.exitCode ?? child.signalCode}).`);
    }
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`px0 did not start serving on port ${port} within 20s.`);
}

function stopEntry(path: string): boolean {
  const entry = entries.get(path);
  if (entry === undefined) return false;
  entries.delete(path);
  entry.child.kill("SIGTERM");
  const child = entry.child;
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000).unref?.();
  if (entries.size === 0) {
    lease?.dispose();
    lease = null;
  }
  return true;
}

function stopAll(): void {
  for (const path of [...entries.keys()]) stopEntry(path);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ensure: async ({ path, readOnly, binaryPath }, context) => {
      const existing = entries.get(path);
      if (existing !== undefined && existing.server.readOnly === readOnly) {
        // Surface a start failure to this caller too, not just the first one.
        await existing.ready;
        return existing.server;
      }
      // A read-only/editable flip needs a fresh process.
      if (existing !== undefined) stopEntry(path);

      const binary = resolveBinary(binaryPath);
      const port = await pickPort();
      const args = [
        "-no-open",
        "-no-telemetry",
        "-quiet",
        "-port",
        String(port),
        ...(readOnly ? ["-no-agent"] : []),
        path,
      ];
      const child = spawn(binary, args, {
        cwd: path,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      child.stdout?.resume();
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2_000);
      });

      const server: Px0Server = {
        path,
        port,
        readOnly,
        startedAt: Date.now(),
      };
      const ready = waitUntilServing(port, child, context.signal).catch(
        (cause: unknown) => {
          entries.delete(path);
          child.kill("SIGKILL");
          const detail = stderr.trim();
          throw new Error(
            `${cause instanceof Error ? cause.message : String(cause)}` +
              (detail === "" ? "" : `\n${detail}`),
          );
        },
      );
      entries.set(path, { server, child, ready });

      child.once("exit", () => {
        if (entries.get(path)?.child === child) entries.delete(path);
        if (entries.size === 0) {
          lease?.dispose();
          lease = null;
        }
      });
      // Independent of any in-flight call: keep the worker while px0 runs.
      lease ??= context.experimental_retainWorker();
      // Kill children when the worker itself is torn down.
      context.lifecycle.signal.addEventListener("abort", stopAll, {
        once: true,
      });

      await ready;
      return server;
    },

    stop: async ({ path }) => ({ stopped: stopEntry(path) }),

    list: async () => ({
      servers: [...entries.values()].map((entry) => entry.server),
    }),
  },
  dispose: async () => {
    stopAll();
  },
});
