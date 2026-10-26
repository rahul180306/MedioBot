import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { LocalDatabase } from '../../src/storage/db.ts';
import { WorkspaceRepository } from '../../src/storage/workspaceRepository.ts';
import { ChatRepository } from '../../src/storage/chatRepository.ts';
import { WorkspaceManager } from '../../src/workspaceManager.ts';
import { startCommandCenter } from '../../src/server.ts';
import type { PersistedWorkbenchTab } from '../../src/runtime/types.ts';

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  output = '';
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.output += chunk.toString();
    callback();
  }
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
}

async function request(
  app: Awaited<ReturnType<typeof startCommandCenter>>,
  method: string,
  url: string,
  bodyText?: string
) {
  const req = Object.assign(Readable.from(bodyText ? [bodyText] : []), new EventEmitter(), {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  });
  const res = new FakeResponse();
  const finished = new Promise<void>((resolve) => res.once('finish', resolve));
  await app.handle(req as never, res as never);
  await finished;
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.output,
    json: () => JSON.parse(res.output),
  };
}

test('WORKBENCH CHAT TABS AND MULTI-CHAT PERSISTENCE SUITE', async (suite) => {
  const rootTemp = await mkdtemp(path.join(os.tmpdir(), 'mediobot-tabs-test-'));
  suite.after(() => rm(rootTemp, { recursive: true, force: true }));

  const dbPath = path.join(rootTemp, 'workbench-tabs.db');
  const db = new LocalDatabase(dbPath);
  const repo = new WorkspaceRepository(db.raw);
  const chatRepo = new ChatRepository(db.raw);

  suite.after(() => {
    try {
      db.close();
    } catch {}
  });

  const dirA = path.join(rootTemp, 'project-a');
  const dirB = path.join(rootTemp, 'project-b');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  await writeFile(path.join(dirA, 'index.html'), '<html><body>Hello A</body></html>');
  await writeFile(path.join(dirB, 'app.ts'), 'console.log("Hello B");');

  // Test 1: SQLite schema migration and columns
  await suite.test('TAB-1: Migration 2 automatically adds workbench_tabs_json and active_workbench_tab_id', async () => {
    const columns = db.raw.prepare(`PRAGMA table_info(workspace_ui_state)`).all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    assert.ok(columnNames.includes('workbench_tabs_json'), 'workbench_tabs_json column must exist');
    assert.ok(columnNames.includes('active_workbench_tab_id'), 'active_workbench_tab_id column must exist');
  });

  // Test 2: WorkspaceRepository saves and retrieves mixed tabs (file + chat)
  await suite.test('TAB-2: WorkspaceRepository persists and restores mixed WorkbenchTabs', async () => {
    const ws = {
      id: 'test-ws-id',
      canonicalPath: dirA,
      displayName: 'project-a',
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      availability: 'available' as const,
    };
    repo.upsert(ws);
    const tabs: PersistedWorkbenchTab[] = [
      { id: 'file:index.html', kind: 'file', path: 'index.html', name: 'index.html' },
      { id: 'chat:thread-alpha', kind: 'chat', threadId: 'thread-alpha', title: 'Debugging UI' },
      { id: 'chat:thread-beta', kind: 'chat', threadId: 'thread-beta', title: 'New chat' },
    ];

    repo.saveUIState({
      workspaceId: ws.id,
      activeFile: 'index.html',
      openTabs: [{ path: 'index.html', name: 'index.html' }],
      expandedPaths: ['src'],
      updatedAt: Date.now(),
      workbenchTabs: tabs,
      activeWorkbenchTabId: 'chat:thread-alpha',
    });

    const uiState = repo.getUIState(ws.id);
    assert.ok(uiState, 'uiState must be found');
    assert.equal(uiState.activeFile, 'index.html');
    assert.equal(uiState.activeWorkbenchTabId, 'chat:thread-alpha');
    assert.equal(uiState.workbenchTabs?.length, 3);
    assert.deepEqual(uiState.workbenchTabs, tabs);
  });

  // Test 3: WorkspaceManager manages UI state transitions and tab isolation across switch
  await suite.test('TAB-3: WorkspaceManager isolates tabs on workspace switch', async () => {
    const wm = new WorkspaceManager(repo);
    await wm.openWorkspace(dirA);

    const tabsA: PersistedWorkbenchTab[] = [
      { id: 'file:index.html', kind: 'file', path: 'index.html', name: 'index.html' },
      { id: 'chat:thread-1', kind: 'chat', threadId: 'thread-1', title: 'Task in A' },
    ];
    wm.saveUIState('index.html', [{ path: 'index.html', name: 'index.html' }], [], tabsA, 'chat:thread-1');

    const stateA = wm.getUIState();
    assert.equal(stateA?.workbenchTabs?.length, 2);
    assert.equal(stateA?.activeWorkbenchTabId, 'chat:thread-1');

    // Switch to Workspace B
    await wm.openWorkspace(dirB);
    const stateB = wm.getUIState();
    // B should NOT have A's tabs
    assert.ok(!stateB || (stateB.workbenchTabs?.length ?? 0) === 0);

    // Save tabs for B
    const tabsB: PersistedWorkbenchTab[] = [
      { id: 'file:app.ts', kind: 'file', path: 'app.ts', name: 'app.ts' },
      { id: 'chat:thread-2', kind: 'chat', threadId: 'thread-2', title: 'Task in B' },
    ];
    wm.saveUIState('app.ts', [{ path: 'app.ts', name: 'app.ts' }], [], tabsB, 'file:app.ts');

    // Switch back to Workspace A: A's tabs are restored
    await wm.openWorkspace(dirA);
    const restoredA = wm.getUIState();
    assert.equal(restoredA?.workbenchTabs?.length, 2);
    assert.equal(restoredA?.workbenchTabs?.[1]?.title, 'Task in A');
    assert.equal(restoredA?.activeWorkbenchTabId, 'chat:thread-1');
  });

  // Test 4: ChatRepository multi-chat isolation and durability
  await suite.test('TAB-4: Multi-chat isolation and durable storage in SQLite', async () => {
    const t1 = {
      id: 'thread-101',
      title: 'First Chat',
      projectId: 'project-a',
      model: 'MiniMax M2.7',
      branch: 'main',
      approvalMode: 'Approve for me' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turns: [
        {
          id: 'turn-1',
          threadId: 'thread-101',
          prompt: 'Hello 1',
          status: 'completed' as const,
          createdAt: Date.now(),
          items: [],
        },
      ],
    };

    const t2 = {
      id: 'thread-102',
      title: 'Second Chat',
      projectId: 'project-a',
      model: 'MiniMax M2.7',
      branch: 'main',
      approvalMode: 'Approve for me' as const,
      createdAt: Date.now() + 10,
      updatedAt: Date.now() + 10,
      turns: [
        {
          id: 'turn-2',
          threadId: 'thread-102',
          prompt: 'Hello 2',
          status: 'completed' as const,
          createdAt: Date.now() + 10,
          items: [],
        },
      ],
    };

    chatRepo.save(t1);
    chatRepo.save(t2);

    const loaded = chatRepo.list();
    assert.ok(loaded.some((t) => t.id === 'thread-101'));
    assert.ok(loaded.some((t) => t.id === 'thread-102'));

    // Rename thread
    chatRepo.updateTitle('thread-101', 'Renamed First Chat');
    const renamed = chatRepo.get('thread-101');
    assert.equal(renamed?.title, 'Renamed First Chat');

    // Delete thread
    chatRepo.delete('thread-102');
    assert.equal(chatRepo.get('thread-102'), null);
    assert.ok(chatRepo.get('thread-101') !== null);
  });

  // Test 5: Full REST API verification using in-memory app.handle
  await suite.test('TAB-5: Full REST API persists workbenchTabs and survives reload', async () => {
    const serverDbPath = path.join(rootTemp, 'server-test.db');
    const app = await startCommandCenter({
      databasePath: serverDbPath,
      listen: false,
      vite: false,
    });

    try {
      // 1. Open workspace A via API
      const openRes = await request(app, 'POST', '/api/workspace/open', JSON.stringify({ preferredPath: dirA }));
      assert.equal(openRes.status, 200);
      const openData = openRes.json() as { session: { workspaceId: string } };
      assert.ok(openData.session);

      // 2. Put UI state with open file tab and active chat tab
      const tabs: PersistedWorkbenchTab[] = [
        { id: 'file:index.html', kind: 'file', path: 'index.html', name: 'index.html' },
        { id: 'chat:thread-live', kind: 'chat', threadId: 'thread-live', title: 'Live Chat Tab' },
      ];

      const putRes = await request(
        app,
        'PUT',
        '/api/workspace/ui-state',
        JSON.stringify({
          activeFile: 'index.html',
          openTabs: [{ path: 'index.html', name: 'index.html' }],
          workbenchTabs: tabs,
          activeWorkbenchTabId: 'chat:thread-live',
        })
      );
      assert.equal(putRes.status, 200);

      // 3. GET /api/workspace and verify uiState
      const getRes = await request(app, 'GET', '/api/workspace');
      assert.equal(getRes.status, 200);
      const getData = getRes.json() as { status: string; uiState: any };
      assert.equal(getData.status, 'OPEN');
      assert.equal(getData.uiState.activeWorkbenchTabId, 'chat:thread-live');
      assert.equal(getData.uiState.workbenchTabs.length, 2);
      assert.equal(getData.uiState.workbenchTabs[0].id, 'file:index.html');
      assert.equal(getData.uiState.workbenchTabs[1].id, 'chat:thread-live');
      assert.equal(getData.uiState.workbenchTabs[1].title, 'Live Chat Tab');
    } finally {
      await app.close();
    }

    // 4. Simulate page reload / server restart: Reopen new server instance with same DB file
    const restartedApp = await startCommandCenter({
      databasePath: serverDbPath,
      listen: false,
      vite: false,
    });

    try {
      const reloadRes = await request(restartedApp, 'GET', '/api/workspace');
      assert.equal(reloadRes.status, 200);
      const reloadData = reloadRes.json() as { status: string; uiState: any };
      assert.equal(reloadData.status, 'OPEN');
      assert.equal(reloadData.uiState.activeWorkbenchTabId, 'chat:thread-live');
      assert.equal(reloadData.uiState.workbenchTabs.length, 2);
      assert.equal(reloadData.uiState.workbenchTabs[0].kind, 'file');
      assert.equal(reloadData.uiState.workbenchTabs[1].kind, 'chat');
      assert.equal(reloadData.uiState.workbenchTabs[1].threadId, 'thread-live');
      assert.equal(reloadData.uiState.workbenchTabs[1].title, 'Live Chat Tab');
    } finally {
      await restartedApp.close();
    }
  });
});
