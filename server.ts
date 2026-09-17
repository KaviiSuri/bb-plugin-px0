import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type Px0Server } from "./contract";

const unavailableSchema = z
  .object({
    status: z.literal("unavailable"),
    message: z.string(),
  })
  .strict();

const openResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      path: z.string(),
      localUrl: z.string().url(),
      shareUrl: z.string().url().nullable(),
    })
    .strict(),
  unavailableSchema,
]);

export type OpenForThreadResult = z.infer<typeof openResultSchema>;

const stopResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      path: z.string(),
      stopped: z.boolean(),
    })
    .strict(),
  unavailableSchema,
]);

export const rpcContract = defineRpcContract({
  open_for_thread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: openResultSchema,
  },
  stop_for_thread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: stopResultSchema,
  },
});

interface ThreadLocation {
  hostId: string;
  path: string;
}

type ThreadLocationResult =
  | { status: "ready"; location: ThreadLocation }
  | { status: "unavailable"; message: string };

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "px0 binary path",
      default: "",
    },
    readOnly: {
      type: "boolean",
      label: "Disable px0 editing",
      default: true,
    },
  });

  // Creating the client is load-safe. Calls are made only from RPC and CLI
  // handlers, after this plugin generation has become active.
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const activePorts = new Map<string, Set<number>>();
  const serversByPath = new Map<string, Map<string, number>>();

  async function resolveThreadLocation(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ThreadLocationResult> {
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (thread.environmentId === null) {
      return {
        status: "unavailable",
        message: "This thread does not have a working directory yet.",
      };
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal,
    });
    if (environment.path === null) {
      return {
        status: "unavailable",
        message: "This thread's working directory is still being prepared.",
      };
    }

    return {
      status: "ready",
      location: {
        hostId: environment.hostId,
        path: environment.path,
      },
    };
  }

  function rememberServer(hostId: string, server: Px0Server): void {
    let ports = activePorts.get(hostId);
    if (ports === undefined) {
      ports = new Set<number>();
      activePorts.set(hostId, ports);
    }
    let paths = serversByPath.get(hostId);
    if (paths === undefined) {
      paths = new Map<string, number>();
      serversByPath.set(hostId, paths);
    }
    const previousPort = paths.get(server.path);
    if (previousPort !== undefined && previousPort !== server.port) {
      ports.delete(previousPort);
    }
    ports.add(server.port);
    paths.set(server.path, server.port);
  }

  function forgetServer(hostId: string, path: string): void {
    const paths = serversByPath.get(hostId);
    const port = paths?.get(path);
    if (port === undefined) return;

    paths?.delete(path);
    activePorts.get(hostId)?.delete(port);
    if (paths?.size === 0) serversByPath.delete(hostId);
    if (activePorts.get(hostId)?.size === 0) activePorts.delete(hostId);
  }

  function replaceServers(hostId: string, servers: Px0Server[]): void {
    activePorts.set(hostId, new Set(servers.map((server) => server.port)));
    serversByPath.set(
      hostId,
      new Map(servers.map((server) => [server.path, server.port])),
    );
  }

  function declareActivePorts(hostId: string): void {
    bb.hosts.declareSharedPorts(hostId, [
      ...(activePorts.get(hostId) ?? new Set<number>()),
    ]);
  }

  async function shareUrlFor(
    hostId: string,
    port: number,
  ): Promise<string | null> {
    try {
      declareActivePorts(hostId);
      const { label, baseDomain } =
        await bb.hosts.ensureSharedPortTunnel(hostId);
      return `https://${label}--${port}.${baseDomain}`;
    } catch (cause) {
      bb.log.debug(
        `px0 sharing unavailable for host ${hostId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  }

  async function redeclareAfterStop(hostId: string): Promise<void> {
    try {
      declareActivePorts(hostId);
    } catch (cause) {
      bb.log.debug(
        `could not update px0 shared ports for host ${hostId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async function openForThread(threadId: string, signal?: AbortSignal) {
    const resolved = await resolveThreadLocation(threadId, signal);
    if (resolved.status === "unavailable") return resolved;

    const { hostId, path } = resolved.location;
    const { binaryPath, readOnly } = await settings.get();
    const server = await host.call(
      "ensure",
      { path, binaryPath, readOnly },
      { hostId, signal },
    );
    rememberServer(hostId, server);

    return {
      status: "ready" as const,
      path,
      localUrl: `http://127.0.0.1:${server.port}`,
      shareUrl: await shareUrlFor(hostId, server.port),
    };
  }

  async function stopForThread(threadId: string, signal?: AbortSignal) {
    const resolved = await resolveThreadLocation(threadId, signal);
    if (resolved.status === "unavailable") return resolved;

    const { hostId, path } = resolved.location;
    const { servers } = await host.call("list", null, { hostId, signal });
    replaceServers(hostId, servers);
    const { stopped } = await host.call("stop", { path }, { hostId, signal });
    if (stopped) forgetServer(hostId, path);
    await redeclareAfterStop(hostId);
    return { status: "ready" as const, path, stopped };
  }

  bb.rpc.register(rpcContract, {
    open_for_thread: ({ threadId }) => openForThread(threadId),
    stop_for_thread: ({ threadId }) => stopForThread(threadId),
  });

  const usage = [
    "Usage:",
    "  bb px0 list [thread-id] [--json]",
    "  bb px0 stop [thread-id] [--json]",
    "",
    "When thread-id is omitted, the command uses the current BB thread.",
  ].join("\n");

  bb.cli.register({
    name: "px0",
    summary: "Inspect and stop px0 code navigators",
    commands: [
      {
        name: "list",
        summary: "List px0 navigators on a thread's host",
        usage: "bb px0 list [thread-id] [--json]",
      },
      {
        name: "stop",
        summary: "Stop the px0 navigator for a thread",
        usage: "bb px0 stop [thread-id] [--json]",
      },
    ],
    async run(argv, context) {
      const json = argv.includes("--json");
      const positional = argv.filter((argument) => argument !== "--json");
      const [command, explicitThreadId, ...extra] = positional;
      if (extra.length > 0) return { exitCode: 1, stderr: usage };
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }

      const threadId = explicitThreadId ?? context.threadId;
      if (threadId === undefined) {
        return {
          exitCode: 1,
          stderr: "No BB thread is active. Pass a thread id explicitly.",
        };
      }

      if (command === "list") {
        const resolved = await resolveThreadLocation(threadId, context.signal);
        if (resolved.status === "unavailable") {
          return { exitCode: 1, stderr: resolved.message };
        }
        const { hostId } = resolved.location;
        const { servers } = await host.call("list", null, {
          hostId,
          signal: context.signal,
        });
        replaceServers(hostId, servers);
        await redeclareAfterStop(hostId);
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ hostId, servers })
            : servers.length === 0
              ? "No px0 navigators are running on this host."
              : servers
                  .map(
                    (server) =>
                      `${server.path}\n  http://127.0.0.1:${server.port}  ${server.readOnly ? "read-only" : "editing enabled"}`,
                  )
                  .join("\n"),
        };
      }

      if (command === "stop") {
        const result = await stopForThread(threadId, context.signal);
        if (result.status === "unavailable") {
          return { exitCode: 1, stderr: result.message };
        }
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(result)
            : result.stopped
              ? `Stopped px0 for ${result.path}.`
              : `No px0 navigator is running for ${result.path}.`,
        };
      }

      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    activePorts.clear();
    serversByPath.clear();
    bb.log.info("disposed");
  });
}
