import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:3000" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
});
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, waitFor } = await import("@testing-library/react");

test("BB file opener opens the linked file and navigates without replacing its iframe", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const opener = app.fileOpeners.find(opener => opener.extensions.includes("ts"));
  assert.ok(opener, "BB must register px0 for agent-linked source files");
  assert.ok(opener.extensions.includes("md"));
  const props = {
    path: "/work/repo/src/file.ts",
    source: { kind: "host" as const, threadId: "thread", environmentId: "env", projectId: "project" },
    experimental_lineRange: { startLineNumber: 42, endLineNumber: 45 },
    Original: () => createElement("p", null, "BB preview"),
  };
  const slot = renderSlot(opener, props, { rpc: {
    open_for_thread: () => ({ status: "ready", path: "/work/repo", environmentId: "env",
      hostId: "host", localUrl: "http://127.0.0.1:7777", shareUrl: null }),
  } });
  try {
    await waitFor(() => assert.ok(slot.container.querySelector("iframe")));
    const frame = slot.container.querySelector("iframe")!;
    const src = frame.src;
    assert.equal(new URL(src).searchParams.get("path"), "src/file.ts");
    assert.equal(new URL(src).searchParams.get("line"), "42");
    const messages: unknown[] = [];
    frame.contentWindow!.postMessage = (data: unknown) => { messages.push(data); };
    await act(async () => {
      window.dispatchEvent(new dom.window.MessageEvent("message", {
        source: frame.contentWindow, origin: "http://127.0.0.1:7777", data: { type: "bb-px0-ready" },
      }));
    });
    const next = { ...props, experimental_lineRange: { startLineNumber: 80, endLineNumber: 80 } };
    slot.lifecycle.rerender(createElement(opener.component, next));
    await waitFor(() => assert.deepEqual(messages.at(-1), { type: "bb-px0-open-file", path: "src/file.ts", line: 80 }));
    assert.equal(slot.container.querySelector("iframe"), frame);
    assert.equal(frame.src, src);
    slot.lifecycle.rerender(createElement(opener.component, {
      ...next, experimental_lineRange: { ...next.experimental_lineRange },
    }));
    await waitFor(() => assert.equal(messages.length, 3));
    slot.lifecycle.rerender(createElement(opener.component, { ...props, path: "/outside/repo/file.ts" }));
    await slot.findByText("BB preview");
  } finally {
    slot.lifecycle.unmount();
    dom.window.close();
  }
});
