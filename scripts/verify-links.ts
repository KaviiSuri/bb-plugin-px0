// Real px0 browser regression: bun scripts/verify-links.ts /path/to/playwright/index.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host";

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const root = await mkdtemp(join(tmpdir(), "px0-links-"));
const harness = experimental_createHostEntryHarness(hostEntry);
const browser = await chromium.launch({ headless: true });
let parent: ReturnType<typeof createServer> | undefined;
try {
  await writeFile(join(root, "linked file.ts"), Array.from({ length: 160 }, (_, i) => `// line ${i + 1}`).join("\n"));
  await writeFile(join(root, "other.md"), "# Another file\n");
  const server = await harness.experimental_call("ensure", {
    path: root, binaryPath: "", threadId: "link-test", agentDisabled: true,
  });
  const target = `http://127.0.0.1:${server.port}`;
  parent = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<iframe style="width:720px;height:850px" src="${target}/?path=linked%20file.ts&line=40"></iframe>
      <script>window.ready = false; addEventListener('message', e => {
        if(e.data?.type === 'bb-px0-ready') window.ready = true;
      });</script>`);
  });
  await new Promise<void>(resolve => parent!.listen(0, "127.0.0.1", resolve));
  const port = (parent.address() as { port: number }).port;
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForFunction(() => (window as any).ready);
  console.log("px0 navigation bridge ready");
  const frame = page.frames()[1];
  assert.equal(await frame.locator("body").evaluate((body: HTMLElement) => body.classList.contains("right-hidden")), true);
  assert.equal(await frame.locator("body").evaluate((body: HTMLElement) => body.classList.contains("side-hidden")), true);
  const editorWidth = await frame.locator("#viewport").evaluate((element: HTMLElement) => element.getBoundingClientRect().width);
  assert.ok(editorWidth > 600, `linked editor should fill the narrow panel, got ${editorWidth}px`);
  await frame.locator("#btn-open-right").click();
  assert.equal(await frame.locator("body").evaluate((body: HTMLElement) => body.classList.contains("right-hidden")), false);
  await frame.locator("#btn-close-right").click();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  const send = async (path: string, line: number) => page.evaluate(
    ({ path, line, target }: { path: string; line: number; target: string }) => {
      document.querySelector("iframe")!.contentWindow!.postMessage(
        { type: "bb-px0-open-file", path, line }, target,
      );
    }, { path, line, target },
  );
  await send("linked file.ts", 80);
  await frame.waitForFunction(() => document.querySelector('.row.cur')?.getAttribute('data-l') === '80');
  console.log("source line 80 reached");
  await frame.locator("#btn-edit-mode").click();
  await frame.locator("#editview-textarea").fill("// unsaved changes\n".repeat(160));
  await send("linked file.ts", 100);
  await frame.waitForFunction(() => {
    const editor = document.querySelector<HTMLTextAreaElement>("#editview-textarea")!;
    return editor.value.slice(0, editor.selectionStart).split("\n").length === 100;
  });
  assert.match(await frame.locator("#editview-textarea").inputValue(), /unsaved changes/);
  await send("other.md", 1);
  await frame.waitForFunction(() => document.querySelector(".tab.active")?.textContent?.includes("other.md"));
  await send("linked file.ts", 120);
  await frame.waitForFunction(() => {
    const editor = document.querySelector<HTMLTextAreaElement>("#editview-textarea")!;
    return editor.value.slice(0, editor.selectionStart).split("\n").length === 120;
  });
  assert.match(await frame.locator("#editview-textarea").inputValue(), /unsaved changes/);
  assert.equal(navigations, 0, "line links must not reload the iframe");
  assert.deepEqual(errors, []);
  console.log("PASS: narrow panel focuses editor, inspector can reopen, linked lines, unsaved edits preserved, no iframe reloads");
} finally {
  await browser.close();
  if (parent) await new Promise<void>(resolve => parent!.close(() => resolve()));
  await harness.experimental_dispose();
  await rm(root, { recursive: true, force: true });
}
