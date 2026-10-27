import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host";

for (const agentDisabled of [true, false]) {
  test(`real px0 can be embedded, agentDisabled=${agentDisabled}`, async () => {
    const path = await mkdtemp(join(tmpdir(), "px0-frame-test-"));
    const harness = experimental_createHostEntryHarness(hostEntry);
    try {
      const server = await harness.experimental_call("ensure", {
        path,
        binaryPath: "",
        threadId: "test-thread",
        agentDisabled,
      });
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      assert.equal(response.status, 200);
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.match(csp, /frame-ancestors http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/);
      assert.doesNotMatch(csp, /frame-ancestors 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /connect-src 'self'/);
      assert.equal(response.headers.get("x-frame-options"), null);
      assert.match(await response.text(), /<html/);
      const repeated = await harness.experimental_call("ensure", {
        path, binaryPath: "", threadId: "test-thread", agentDisabled,
      });
      assert.equal(repeated.port, server.port);
      await harness.experimental_call("stop", { path, threadId: "test-thread" });
      await assert.rejects(fetch(`http://127.0.0.1:${server.port}/`));
    } finally {
      await harness.experimental_dispose();
      await rm(path, { recursive: true, force: true });
    }
  });
}

test("configured remote BB origin is explicitly allowed", async () => {
  const path = await mkdtemp(join(tmpdir(), "px0-frame-test-"));
  const harness = experimental_createHostEntryHarness(hostEntry);
  try {
    const server = await harness.experimental_call("ensure", {
      path, binaryPath: "", threadId: "test-thread", agentDisabled: true,
      frameOrigin: "https://bb.example.com/app/",
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors[^;]* https:\/\/bb\.example\.com(?:;|$)/);
    await response.body?.cancel();
  } finally {
    await harness.experimental_dispose();
    await rm(path, { recursive: true, force: true });
  }
});
