# bb-plugin-px0

Browse a BB thread's working directory in an embedded [px0](https://px0.ai)
code navigator, without leaving the thread.

px0 is a local web server, so BB can host it in a panel: the plugin starts
`px0` on the thread's workspace directory and renders it in an iframe beside
the conversation. Launched with `-no-agent`, so it navigates and reads rather
than edits.

## Design

Three entries, because BB separates trust levels:

### `host.ts` — process manager

Full-trust Node on the machine that owns the workspace, which is not
necessarily the machine running the BB server. The only entry allowed to spawn
processes, so px0 lives here. It keeps one px0 per absolute directory in a
`Map`, so two threads on the same worktree share a process.

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

### `app.tsx` — the surfaces

A `threadPanelAction` with `layout: "flush"` rendering the iframe, and an
`experimental_threadHeaderAction` button that opens it.

## Notes

`-no-agent` removes px0's editing affordance. It is not a hardened read-only
sandbox — it is a local server the iframe can talk to. That is fine for your
own machine and worth knowing before it points anywhere else.

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
