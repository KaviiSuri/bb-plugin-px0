# bb-plugin-px0

Browse a BB thread's working directory in an embedded [px0](https://px0.ai)
code navigator, without leaving the thread.

px0 is a local web server, so BB can host it in a panel: the plugin starts
`px0` on the thread's workspace directory and renders it in an iframe beside
the conversation. It is read-only by default. When editing is enabled, px0
sends its file-and-line-aware edit prompt back to the BB thread that opened the
panel, and BB performs the edit.

## Design

Three entries, because BB separates trust levels:

### `host.ts` — process manager

Full-trust Node on the machine that owns the workspace, which is not
necessarily the machine running the BB server. The only entry allowed to spawn
processes, so px0 lives here. Read-only panels keep one px0 per absolute
directory, so two threads on the same worktree share a process. Editable
panels use one process per directory and BB thread because px0 0.1.5 does not
identify the browser client that submitted an edit.

Three constraints shaped this file:

- **Idle eviction.** BB stops a host worker after five minutes with no active
  call, watch, or lease — which would kill px0 under an open panel. The entry
  holds an `experimental_retainWorker()` lease while any child is alive and
  disposes it when the last one exits.
- **PATH.** Host code gets the normalized user PATH without BB's own
  variables, and `~/.local/bin` (where px0 installs) is often missing from it.
  The binary is probed across known install locations, with a settings
  override taking precedence.
- **Ports.** A free loopback port is reserved via a throwaway listener and
  handed to `-port`, then polled until px0 answers, so callers get a URL that
  is actually serving rather than one that is about to be.

### `server.ts` — resolution and brokering

Resolves a thread to a directory: `threads.get` gives `environmentId`, then
`environments.get` gives the workspace `path` and its `hostId`. It calls the
host entry on that specific host and returns a URL.

For clients that are not on the workspace machine (phone, web), it can wrap the
port with `bb.hosts.declareSharedPorts` plus `ensureSharedPortTunnel` and return
an `https://` share URL, falling back to loopback when the machine is not
enrolled in BB Connect.

It also owns the `bb px0 agent-run` bridge used by editable px0 sessions. The
bridge sends px0's prompt to the originating thread, waits for that turn to
finish, and returns its output to px0. If the thread is already running, the
bridge refuses the edit instead of steering or silently queueing it.

px0 0.1.5 can execute a custom agent command but omits custom commands from
the UI's detected-harness list, leaving its pinned composer inaccessible. For
editable sessions only, the host places a loopback adapter in front of px0
that adds the pinned `bb` command to px0's two agent-metadata responses. It
also verifies the browser's origin before rebasing agent POSTs onto px0's
internal loopback origin; non-agent traffic streams through unchanged. This
compatibility adapter can go away when px0 exposes pinned custom commands in
its UI.

### `app.tsx` — the surfaces

A `threadPanelAction` with `layout: "flush"` rendering the iframe, and an
`experimental_threadHeaderAction` button that opens it.

## Notes

The default `readOnly` setting launches px0 with `-no-agent`. Turning it off
pins px0's custom agent command to BB; px0's built-in coding agents are not
used. Enable it with `bb plugin config px0 set readOnly false`. Read-only mode
is not a hardened sandbox. px0 remains a local server the iframe can talk to.

## Development

```
npm install
bb plugin build .      # dist/{server,host,app}.js
npx tsc --noEmit
bb plugin install .
bb plugin dev          # rebuild and reload on save
```

## License

MIT
