import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Run the real component with a fake transport, without VNC or credentials.
const rfb = `export default class RFB extends EventTarget {
  constructor(target) { super(); window.rfbs.push(this); target.innerHTML = '<canvas tabindex="0"></canvas>'; }
  focus() {} disconnect() {} clipboardPasteFrom(text) { window.sent.push(text); }
}`;
const entry = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ComputerScreen } from '/src/components/ComputerViewer.tsx';
import { useStore } from '/src/store.ts';
import '/src/styles/viewer.css';
window.rfbs = []; window.sent = []; window.writes = [];
window.clipboard = { writeText: async text => { window.writes.push(text); }, readText: async () => 'local' };
Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => window.clipboard });
const bot = { id: 'test', name: 'Test', avatarColor: 'blue', avatarShape: 'circle', isPrimary: true };
useStore.setState({ computer: { status: 'running', screens: [], maxScreens: 4 } });
const root = createRoot(document.getElementById('root'));
window.render = (paused = false) => root.render(React.createElement(ComputerScreen, { bot, variant: 'stage', initialMode: 'control', paused }));
window.emit = (type, detail) => window.rfbs.at(-1).dispatchEvent(new CustomEvent(type, { detail }));
window.render();`;
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: { port: 5199, strictPort: true },
  plugins: [{ name: 'clipboard-test', enforce: 'pre',
    resolveId(id) { if (id === '@novnc/novnc') return '\0fake-rfb'; if (id === '/clipboard-test-entry.js') return '\0clipboard-test-entry'; },
    load(id) { if (id === '\0fake-rfb') return rfb; if (id === '\0clipboard-test-entry') return entry; },
    configureServer(s) { s.middlewares.use(async (req, res, next) => {
      if (req.url === '/clipboard-test') {
        res.setHeader('Content-Type', 'text/html');
        res.end(await s.transformIndexHtml(req.url, '<div id="root" style="height:700px"></div><input id="unrelated"><script type="module" src="/clipboard-test-entry.js"></script>'));
      } else next();
    }); },
  }],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('http://localhost:5199/clipboard-test');
  await page.waitForFunction(() => window.rfbs?.length === 1);
  const emit = (type, detail) => page.evaluate(([t, d]) => window.emit(t, d), [type, detail]);
  const count = key => page.evaluate(k => window[k].length, key);
  const copy = page.getByRole('button', { name: 'Copy from screen', exact: true });
  await emit('connect');
  await emit('clipboard', { text: 'remote fixture' });
  assert.equal(await count('writes'), 0, 'remote text must not auto-write');
  await copy.waitFor();
  await copy.click();
  await copy.waitFor({ state: 'detached' });
  assert.equal(await count('writes'), 1);
  assert.deepEqual(await page.evaluate(() => window.writes), ['remote fixture'], 'the clicked copy writes exactly the remote text');
  await page.evaluate(() => { window.clipboard.writeText = () => Promise.reject(new Error('denied')); });
  await emit('clipboard', { text: 'denied fixture' });
  await copy.click();
  await page.getByLabel('Text copied on the screen').waitFor();
  await page.evaluate(() => { window.clipboard.writeText = () => new Promise(resolve => { window.finishWrite = resolve; }); });
  await copy.click();
  await emit('clipboard', { text: 'newer fixture' });
  await page.evaluate(() => window.finishWrite());
  await copy.waitFor();
  await page.evaluate(() => { window.clipboard = undefined; });
  await emit('clipboard', { text: 'selectable\nfixture' });
  await copy.click();
  assert.equal(await page.getByLabel('Text copied on the screen').inputValue(), 'selectable\nfixture', 'the copy fallback keeps line breaks');
  await page.getByRole('button', { name: 'Paste to screen', exact: true }).click();
  await page.getByLabel('Text to send to the screen').fill('local fixture');
  await page.getByLabel('Text to send to the screen').press('Enter');
  assert.equal(await count('sent'), 1);
  assert.deepEqual(await page.evaluate(() => window.sent), ['local fixture'], 'the paste box sends exactly what was typed');
  const paste = selector => page.evaluate(sel => {
    const data = new DataTransfer(); data.setData('text/plain', 'paste fixture');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
    document.querySelector(sel).dispatchEvent(event); return event.defaultPrevented;
  }, selector);
  assert.equal(await paste('#unrelated'), false);
  assert.equal(await count('sent'), 1, 'unrelated inputs stay local');
  assert.equal(await paste('canvas'), true);
  assert.equal(await count('sent'), 2, 'one clipboard update per paste');
  await emit('disconnect', { clean: true });
  await copy.waitFor({ state: 'detached' });
  assert.equal(await paste('canvas'), false);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => window.rfbs.length === 2);
  await emit('connect');
  assert.equal(await copy.count(), 0, 'reconnect clears pending text');
  await page.evaluate(() => { window.clipboard = { readText: () => new Promise(resolve => { window.finishRead = resolve; }) }; });
  await page.getByRole('button', { name: 'Paste to screen', exact: true }).click();
  await emit('clipboard', { text: 'mode fixture' });
  await page.getByRole('button', { name: 'Hand back to Test' }).click();
  await page.waitForFunction(() => window.rfbs.length === 3);
  await emit('connect');
  await page.evaluate(() => window.finishRead('late fixture'));
  await emit('clipboard', { text: 'watch fixture' });
  assert.equal(await copy.count(), 0);
  assert.equal(await paste('canvas'), false);
  assert.equal(await count('sent'), 2, 'watch mode and stale reads cannot send');
  await page.getByRole('button', { name: 'Take control' }).click();
  await page.waitForFunction(() => window.rfbs.length === 4);
  await emit('connect');
  assert.equal(await copy.count(), 0);
  assert.equal(await page.getByLabel('Text to send to the screen').count(), 0);
  assert.equal(await paste('canvas'), true);
  assert.equal(await count('sent'), 3, 'switching modes leaves only one listener');
  // Multiline text pasted into the masked fallback box keeps its newline (a password input would strip it).
  await page.evaluate(() => { window.clipboard = undefined; });
  await page.getByRole('button', { name: 'Paste to screen', exact: true }).click();
  const box =page.getByLabel('Text to send to the screen');
  await box.evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', 'first\nsecond');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await box.press('Enter');
  assert.deepEqual((await page.evaluate(() => window.sent)).at(-1), 'first\nsecond', 'multiline paste fallback is not flattened');
  // Editing after a multiline paste must never send the placeholder dots; Backspace discards the paste instead.
  const sentBefore = await count('sent');
  await page.getByRole('button', { name: 'Paste to screen', exact: true }).click();
  const box2 = page.getByLabel('Text to send to the screen');
  await box2.evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', 'one\ntwo');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await box2.pressSequentially('xyz');
  await box2.press('Enter');
  assert.equal((await page.evaluate(() => window.sent)).at(-1), 'one\ntwo', 'typing after a multiline paste is ignored, not sent as dots');
  assert.equal(await count('sent'), sentBefore + 1);
  // A single-line paste over a locked multiline paste replaces it.
  await page.getByRole('button', { name: 'Paste to screen', exact: true }).click();
  const box4 = page.getByLabel('Text to send to the screen');
  const pasteInto = (loc, text) => loc.evaluate((el, t) => {
    const data = new DataTransfer(); data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await pasteInto(box4, 'old\nmulti');
  await pasteInto(box4, 'replacement');
  await box4.press('Enter');
  assert.equal((await page.evaluate(() => window.sent)).at(-1), 'replacement', 'a paste over a locked multiline paste replaces it');
  await page.getByRole('button', { name: 'Paste to screen', exact: true }).click();
  const box3 =page.getByLabel('Text to send to the screen');
  await box3.evaluate(el => {
    const data = new DataTransfer(); data.setData('text/plain', 'gone\nsoon');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await box3.press('Backspace');
  assert.equal(await box3.inputValue(), '', 'Backspace discards a multiline paste');
  await box3.fill('typed');
  await box3.press('Enter');
  assert.equal((await page.evaluate(() => window.sent)).at(-1), 'typed', 'a discarded paste leaves normal typing working');
  await page.evaluate(() => window.render(true));
  await page.waitForSelector('.is-paused');
  assert.equal(await paste('.screen__canvas'), false);
  console.log('Clipboard browser regression checks passed');
} finally {
  await browser?.close();
  await server.close();
}
