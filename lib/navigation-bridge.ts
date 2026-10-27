/** Inject into px0's bundled scope, where its own openFile function is available. */
export function addNavigationBridge(body: Buffer, frameOrigin?: string): Buffer {
  const script = body.toString();
  const anchor = "const initialPath = params.get('path');";
  if (!script.includes(anchor)) return body;
  const origin = frameOrigin ? new URL(frameOrigin).origin : null;
  const bridge = `
  window.addEventListener('message', async (event) => {
    if (event.source !== window.parent || window.parent === window) return;
    let allowed = event.origin === ${JSON.stringify(origin)};
    try {
      const parentUrl = new URL(event.origin);
      allowed ||= parentUrl.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(parentUrl.hostname);
    } catch {}
    if (!allowed || event.data?.type !== 'bb-px0-open-file') return;
    const { path, line } = event.data;
    if (typeof path !== 'string' || !path || path.startsWith('/') ||
        path.includes('\\\\') || path.split('/').includes('..')) return;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return;
    try {
      await openFile(path, { line, view: 'source' });
      if (line && doc_()?.isEditing) centerEditLine(line);
    }
    catch (error) { console.error('BB px0 navigation failed', error); }
  });
  `;
  return Buffer.from(script.replace(anchor, bridge + anchor).replace(
    "startTipsAsync();",
    `startTipsAsync();
    // A file link should give the editor the available side-panel width.
    // Apply once on startup, so later links respect panes the user opens.
    if (initialPath && window.parent !== window) {
      hideRightInspector();
      if (window.innerWidth < 900) document.body.classList.add('side-hidden');
      layout();
      render();
    }
    window.parent.postMessage({ type: 'bb-px0-ready' }, '*');`,
  ));
}
