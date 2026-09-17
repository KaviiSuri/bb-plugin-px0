// bb-plugin-px0 — host entry.
//
// Full-trust Node running on the machine that owns the workspace (which is not
// necessarily the machine running the BB server). This is the only place
// allowed to spawn processes, so px0 lives here.
//
// Read-only px0 processes are shared by directory. Editable processes are
// scoped to a BB thread so their custom agent command always talks back to the
// panel's originating conversation. The worker holds a retain lease while any
// child is alive so BB's five-minute idle eviction does not kill the servers.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type Px0Server } from "./contract";

interface Entry {
  server: Px0Server;
  child: ChildProcess;
  adapter: HttpServer | null;
  ready: Promise<void>;
}

/** session key → running px0. Module state is fine: one worker per plugin per host. */
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

function entryKey(path: string, threadId: string | null): string {
  return threadId === null
    ? `read-only\0${path}`
    : `editable\0${threadId}\0${path}`;
}

/** Ask the OS for a free loopback port, then hand it straight to px0. */
function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
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

async function pickDifferentPort(excluded: number): Promise<number> {
  let port = await pickPort();
  while (port === excluded) port = await pickPort();
  return port;
}

/**
 * px0 0.1.5 runs custom command templates, but its UI only opens the composer
 * when the selected harness also appears in the built-in detection list. Add
 * the pinned custom `bb` harness to the two metadata responses the UI reads.
 */
function exposePinnedCustomHarness(body: Buffer): Buffer {
  try {
    const value = JSON.parse(body.toString()) as {
      agent?: unknown;
      agentPinned?: unknown;
      agents?: unknown;
      selected?: unknown;
      pinned?: unknown;
      harnesses?: unknown;
    };
    const selected =
      typeof value.selected === "string"
        ? value.selected
        : typeof value.agent === "string"
          ? value.agent
          : "";
    const pinned = value.pinned === true || value.agentPinned === true;
    const key = Array.isArray(value.harnesses) ? "harnesses" : "agents";
    const harnesses = value[key];
    if (
      pinned &&
      selected !== "" &&
      Array.isArray(harnesses) &&
      !harnesses.some(
        (harness) =>
          typeof harness === "object" &&
          harness !== null &&
          "name" in harness &&
          harness.name === selected,
      )
    ) {
      value[key] = [
        {
          name: selected,
          cmd: "BB thread",
          installed: true,
          models: [],
          model: "",
        },
        ...harnesses,
      ];
    }
    return Buffer.from(JSON.stringify(value));
  } catch {
    return body;
  }
}

function startAgentUiAdapter(
  publicPort: number,
  upstreamPort: number,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((request, response) => {
      const pathname = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      ).pathname;
      const patchMetadata =
        pathname === "/api/meta" ||
        pathname === "/api/agent/harnesses";
      const headers = {
        ...request.headers,
        host: `127.0.0.1:${upstreamPort}`,
      };
      if (patchMetadata) headers["accept-encoding"] = "identity";
      const agentMutation =
        request.method === "POST" && pathname.startsWith("/api/agent/");
      if (agentMutation) {
        let originHost = "";
        try {
          originHost = new URL(request.headers.origin ?? "").host;
        } catch {
          // Rejected below with the same deliberately vague message as px0.
        }
        if (originHost === "" || originHost !== request.headers.host) {
          response.writeHead(403, { "content-type": "text/plain" });
          response.end("request did not come from px0");
          return;
        }
        headers.origin = `http://127.0.0.1:${upstreamPort}`;
      }
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: upstreamPort,
          path: request.url,
          method: request.method,
          headers,
        },
        (upstreamResponse) => {
          if (!patchMetadata) {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              upstreamResponse.headers,
            );
            upstreamResponse.pipe(response);
            return;
          }

          const chunks: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          upstreamResponse.on("end", () => {
            const body = exposePinnedCustomHarness(Buffer.concat(chunks));
            const headers = { ...upstreamResponse.headers };
            delete headers["content-length"];
            headers["content-length"] = String(body.byteLength);
            response.writeHead(upstreamResponse.statusCode ?? 502, headers);
            response.end(body);
          });
        },
      );
      upstream.on("error", (cause) => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain" });
        }
        response.end(`Could not reach px0: ${cause.message}`);
      });
      request.pipe(upstream);
    });
    server.once("error", reject);
    server.listen(publicPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
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

function stopEntry(key: string): boolean {
  const entry = entries.get(key);
  if (entry === undefined) return false;
  entries.delete(key);
  entry.adapter?.close();
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
  for (const key of [...entries.keys()]) stopEntry(key);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ensure: async ({ path, readOnly, threadId, binaryPath }, context) => {
      const sessionThreadId = readOnly ? null : threadId;
      const key = entryKey(path, sessionThreadId);
      const existing = entries.get(key);
      if (existing !== undefined) {
        // Surface a start failure to this caller too, not just the first one.
        await existing.ready;
        return existing.server;
      }

      const binary = resolveBinary(binaryPath);
      const upstreamPort = await pickPort();
      const port = readOnly
        ? upstreamPort
        : await pickDifferentPort(upstreamPort);
      const args = [
        "-no-open",
        "-no-telemetry",
        "-quiet",
        "-port",
        String(upstreamPort),
        ...(readOnly
          ? ["-no-agent"]
          : ["-agent", `bb px0 agent-run ${threadId} {prompt}`]),
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
        threadId: sessionThreadId,
        startedAt: Date.now(),
      };
      let adapter: HttpServer | null = null;
      const ready = waitUntilServing(upstreamPort, child, context.signal)
        .then(async () => {
          if (!readOnly) {
            adapter = await startAgentUiAdapter(port, upstreamPort);
            const entry = entries.get(key);
            if (entry !== undefined) entry.adapter = adapter;
          }
        })
        .catch(
          (cause: unknown) => {
            entries.delete(key);
            adapter?.close();
            child.kill("SIGKILL");
            const detail = stderr.trim();
            throw new Error(
              `${cause instanceof Error ? cause.message : String(cause)}` +
                (detail === "" ? "" : `\n${detail}`),
            );
          },
        );
      entries.set(key, { server, child, adapter, ready });

      child.once("exit", () => {
        adapter?.close();
        if (entries.get(key)?.child === child) entries.delete(key);
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

    stop: async ({ path, threadId }) => {
      let stopped = false;
      for (const [key, entry] of [...entries]) {
        if (
          entry.server.path === path &&
          (entry.server.readOnly || entry.server.threadId === threadId)
        ) {
          stopped = stopEntry(key) || stopped;
        }
      }
      return { stopped };
    },

    list: async () => ({
      servers: [...entries.values()].map((entry) => entry.server),
    }),
  },
  dispose: async () => {
    stopAll();
  },
});
