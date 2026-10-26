import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('model identity survives duplicate labels, draft navigation, persistence, reload and submission', async () => {
  const vite = await createServer({
    configFile: path.join(appRoot, 'vite.config.ts'),
    root: appRoot,
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    appType: 'spa',
  });
  await vite.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let threads: any[] = [];
    const submissions: any[] = [];
    await page.route('**/api/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const method = route.request().method();
      let json: unknown = {};
      if (pathname === '/api/workspace') json = { status: 'EMPTY', session: null };
      if (pathname === '/api/providers') json = { providers: ['first', 'second'].map(id => ({
        id, displayName: 'Same provider', connected: true, enabled: true,
        models: [{ id: 'shared-model', name: 'Same label', enabled: true }],
      })) };
      if (pathname === '/api/definitions') json = { definitions: [] };
      if (pathname === '/api/threads' && method === 'GET') json = { threads };
      if (pathname === '/api/threads' && method === 'POST') {
        threads.push({ ...route.request().postDataJSON().thread, turns: [] });
        json = { thread: threads.at(-1) };
      }
      if (pathname.startsWith('/api/threads/') && method === 'PATCH') {
        const patch = route.request().postDataJSON();
        threads = threads.map(t => t.id === pathname.split('/').pop() ? { ...t, ...patch } : t);
      }
      if (pathname === '/api/turns' && method === 'POST') {
        submissions.push(route.request().postDataJSON());
        return route.fulfill({ status: 409, json: { error: { message: 'Fixture stops execution' } } });
      }
      if (pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: '' });
      await route.fulfill({ json });
    });
    await page.route('**/identity-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="padding-top: 500px"></div>' }));
    const mount = async () => {
      await page.goto(`${vite.resolvedUrls!.local[0]}identity-test`);
      await page.evaluate(async () => {
        // Vite transforms the real provider; expose its public API to exercise React state transitions.
        const load = (url: string) => import(url);
        const react = await load('/node_modules/.vite/deps/react.js');
        const React = react.default ?? react;
        const client = await load('/node_modules/.vite/deps/react-dom_client.js');
        const { createRoot } = client.default ?? client;
        const { AppProvider, useApp } = await load('/src/state/AppContext.tsx');
        const { Composer } = await load('/src/features/composer/Composer.tsx');
        function Probe() { (window as any).app = useApp(); return null; }
        createRoot(document.getElementById('root')!).render(React.createElement(AppProvider, null,
          React.createElement(Probe), React.createElement(Composer)));
      });
      await page.waitForFunction(() => (window as any).app?.enabledModels.length === 2);
    };
    await mount();
    const selection = { providerConnectionId: 'second', modelId: 'shared-model' };
    await page.getByTitle('Select model', { exact: true }).click();
    await page.getByRole('button', { name: 'Same provider', exact: true }).nth(1).click();
    await page.getByText('Same label', { exact: true }).click();
    await page.waitForFunction(() => (window as any).app.modelSelection?.providerConnectionId === 'second');
    await page.evaluate(() => (window as any).app.setModel('Same label'));
    assert.deepEqual(await page.evaluate(() => (window as any).app.modelSelection), selection);
    await page.evaluate(() => (window as any).app.sendPrompt('First prompt'));
    assert.deepEqual(submissions[0].modelSelection, selection);
    assert.deepEqual(threads[0].modelSelection, selection);
    await mount();
    await page.evaluate(id => (window as any).app.setActiveThreadId(id), threads[0].id);
    await page.waitForFunction(() => (window as any).app.modelSelection?.providerConnectionId === 'second');
    await page.evaluate(() => (window as any).app.sendPrompt('After reload'));
    assert.deepEqual(submissions[1].modelSelection, selection);
    const changed = { ...selection, providerConnectionId: 'first' };
    await page.evaluate(selection => (window as any).app.setModel('Same label', selection), changed);
    await page.waitForFunction(() => (window as any).app.modelSelection?.providerConnectionId === 'first');
    await page.evaluate(() => (window as any).app.reloadThreads());
    assert.deepEqual(await page.evaluate(() => (window as any).app.modelSelection), changed);
    await page.evaluate(() => (window as any).app.setActiveThreadId(null));
    await page.waitForFunction(() => (window as any).app.activeThreadId === null);
    await page.evaluate(selection => (window as any).app.setModel('Same label', selection), selection);
    await page.waitForFunction(() => (window as any).app.modelSelection?.providerConnectionId === 'second');
    await page.evaluate(id => (window as any).app.setActiveThreadId(id), threads[0].id);
    await page.waitForFunction(() => (window as any).app.modelSelection?.providerConnectionId === 'first');
    await page.evaluate(() => (window as any).app.setActiveThreadId(null));
    await page.waitForFunction(() => (window as any).app.activeThreadId === null);
    assert.deepEqual(await page.evaluate(() => (window as any).app.modelSelection), selection);
  } finally {
    await browser.close();
    await vite.close();
  }
});
