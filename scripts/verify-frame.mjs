// Isolated real-browser regression check. Install playwright in a temporary
// directory and pass its module path and the running adapter URL as arguments.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const target = process.argv[3];
const screenshot = process.argv[4];
const browser = await chromium.launch({ headless: true });
const parent = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(`<html><body><iframe style="width:1200px;height:800px" src="${target}"></iframe></body></html>`);
});
await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve));
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${parent.address().port}`);
  const iframe = page.frameLocator('iframe');
  await iframe.locator('body').waitFor({ timeout: 10000 });
  const frameElement = await page.locator('iframe').elementHandle();
  const frame = await frameElement.contentFrame();
  await frame.waitForFunction(() => document.body.innerText.length > 20, { timeout: 10000 });
  const text = await iframe.locator('body').innerText();
  assert.ok(text.length > 20, 'px0 UI rendered');
  assert.ok(!errors.some(error => /frame-ancestors|refused to frame/i.test(error)), errors.join('\n'));
  if (screenshot) await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ target, iframeUrl: page.frames()[1].url(), text: text.slice(0, 1600), errors }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => parent.close(resolve));
}
