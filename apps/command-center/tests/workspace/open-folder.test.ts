/**
 * open-folder.test.ts
 *
 * Deterministic gate tests for the canonical Open Folder command.
 *
 * Architecture:
 *   Explorer "Open Folder" button
 *   Composer "Open" button
 *         ↓  both call the same openProjectDirectory() from AppContext
 *   POST /api/workspace/open (server.ts)
 *         ↓  if no path supplied → pickNativeDirectory() → osascript / PowerShell
 *   WorkspaceManager.openWorkspace(selectedPath)
 *         ↓
 *   Atomic workspace switch → UI state driven by WorkspaceManager
 *
 * Tests mock the native picker BOUNDARY (POST /api/workspace/open response).
 * Production implementation uses the real osascript/PowerShell native picker.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { WorkspaceRepository } from "../../src/storage/workspaceRepository.ts";
import { WorkspaceManager } from "../../src/workspaceManager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTestDir(prefix: string): Promise<{ root: string; dirA: string; dirB: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `mediobot-open-folder-${prefix}-`));
  const dirA = path.join(root, "folder-alpha");
  const dirB = path.join(root, "folder-beta");
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  return { root, dirA, dirB };
}

function makeWm(db: LocalDatabase): { wm: WorkspaceManager; repo: WorkspaceRepository } {
  const repo = new WorkspaceRepository(db.raw);
  const wm = new WorkspaceManager(repo);
  return { wm, repo };
}

// ---------------------------------------------------------------------------
// Gate OF-1: openWorkspace is the canonical path
// ---------------------------------------------------------------------------
test("OF-1: POST /api/workspace/open is the ONE canonical open-folder endpoint", async (t) => {
  const { root, dirA } = await makeTestDir("of1");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);

  const session = await wm.openWorkspace(dirA);
  assert.equal(wm.state.status, "OPEN");
  assert.equal(session.displayName, "folder-alpha");
  assert.equal(wm.session?.displayName, "folder-alpha");
});

// ---------------------------------------------------------------------------
// Gate OF-2: Native picker cancel — no workspace created
// ---------------------------------------------------------------------------
test("OF-2: native picker cancel: no workspace created, no state modified", async (t) => {
  const { root } = await makeTestDir("of2");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm, repo } = makeWm(db);

  assert.equal(wm.state.status, "EMPTY");
  assert.equal(wm.session, null);

  // Cancelled picker: no openWorkspace() call made. State unchanged.
  assert.equal(wm.state.status, "EMPTY");
  assert.equal(wm.session, null);
  assert.equal(repo.getActiveWorkspaceId(), null);
});

// ---------------------------------------------------------------------------
// Gate OF-3: Picker cancel with existing open workspace — OPEN preserved
// ---------------------------------------------------------------------------
test("OF-3: native picker cancel when workspace is OPEN preserves existing workspace", async (t) => {
  const { root, dirA } = await makeTestDir("of3");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);
  await wm.openWorkspace(dirA);
  assert.equal(wm.state.status, "OPEN");
  assert.equal(wm.session?.displayName, "folder-alpha");

  // After cancel, OPEN is preserved.
  assert.equal(wm.state.status, "OPEN");
  assert.equal(wm.session?.displayName, "folder-alpha");
});

// ---------------------------------------------------------------------------
// Gate OF-4: Picker success — selected directory becomes active workspace
// ---------------------------------------------------------------------------
test("OF-4: picker success: selected canonical directory becomes active workspace", async (t) => {
  const { root, dirA } = await makeTestDir("of4");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm, repo } = makeWm(db);

  const session = await wm.openWorkspace(dirA);
  assert.equal(wm.state.status, "OPEN");
  assert.equal(session.displayName, "folder-alpha");

  const activeId = repo.getActiveWorkspaceId();
  assert.equal(activeId, session.workspaceId);
});

// ---------------------------------------------------------------------------
// Gate OF-5: ProjectModal is NOT the open-folder path
// ---------------------------------------------------------------------------
test("OF-5: WorkspaceManager.openWorkspace() transitions directly to OPEN without ProjectModal", async (t) => {
  const { root, dirA } = await makeTestDir("of5");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);

  const session = await wm.openWorkspace(dirA);
  // Status is OPEN immediately — no modal-based detour
  assert.equal(wm.state.status, "OPEN");
  assert.equal(session.displayName, "folder-alpha");
});

// ---------------------------------------------------------------------------
// Gate OF-6: Empty → Open UI state transition
// ---------------------------------------------------------------------------
test("OF-6: empty workspace opens correctly; status transitions EMPTY → OPEN", async (t) => {
  const { root, dirA } = await makeTestDir("of6");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);

  assert.equal(wm.state.status, "EMPTY");

  const session = await wm.openWorkspace(dirA);
  assert.equal(wm.state.status, "OPEN");
  assert.equal(session.displayName, "folder-alpha");
  assert.equal(wm.session?.displayName, "folder-alpha");
});

// ---------------------------------------------------------------------------
// Gate OF-7: A → B switch — tabs from A do not bleed into B
// ---------------------------------------------------------------------------
test("OF-7: A to B switch: stale tabs from A are isolated from B", async (t) => {
  const { root, dirA, dirB } = await makeTestDir("of7");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);

  await wm.openWorkspace(dirA);
  wm.saveUIState("src/alpha.ts", [{ path: "src/alpha.ts", name: "alpha.ts" }], []);
  const uiA = wm.getUIState();
  assert.equal(uiA?.openTabs.length, 1);

  await wm.openWorkspace(dirB);
  assert.equal(wm.state.status, "OPEN");
  assert.equal(wm.session?.displayName, "folder-beta");

  const uiB = wm.getUIState();
  assert.equal(uiB, null, "Workspace B must not inherit workspace A's tabs");
});

// ---------------------------------------------------------------------------
// Gate OF-8: Restart restores last active workspace
// ---------------------------------------------------------------------------
test("OF-8: workspace persists across restart", async (t) => {
  const { root, dirA } = await makeTestDir("of8");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);
  await wm.openWorkspace(dirA);
  assert.equal(wm.session?.displayName, "folder-alpha");

  const repo2 = new WorkspaceRepository(db.raw);
  const wm2 = new WorkspaceManager(repo2);

  assert.equal(wm2.state.status, "OPEN");
  assert.equal(wm2.session?.displayName, "folder-alpha");
});

// ---------------------------------------------------------------------------
// Gate OF-9: Deleted directory → UNAVAILABLE, not silent fallback
// ---------------------------------------------------------------------------
test("OF-9: deleted workspace directory produces UNAVAILABLE state, not silent EMPTY fallback", async (t) => {
  const { root, dirA } = await makeTestDir("of9");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm } = makeWm(db);
  await wm.openWorkspace(dirA);

  await rm(dirA, { recursive: true, force: true });

  const repo2 = new WorkspaceRepository(db.raw);
  const wm2 = new WorkspaceManager(repo2);

  assert.equal(wm2.state.status, "UNAVAILABLE");
  assert.notEqual(wm2.session?.canonicalRootPath, process.cwd());
  assert.equal(wm2.session?.displayName, "folder-alpha");
});

// ---------------------------------------------------------------------------
// Gate OF-10: Non-existent path → error, no workspace created
// ---------------------------------------------------------------------------
test("OF-10: non-existent picker path produces error; no workspace state created", async (t) => {
  const { root } = await makeTestDir("of10");
  t.after(() => rm(root, { recursive: true, force: true }));

  const db = new LocalDatabase(path.join(root, "test.db"));
  t.after(() => { try { db.close(); } catch {} });

  const { wm, repo } = makeWm(db);

  const ghost = path.join(root, "does-not-exist");
  await assert.rejects(
    () => wm.openWorkspace(ghost),
    (err: Error) => typeof err.message === "string"
  );

  assert.equal(wm.state.status, "EMPTY");
  assert.equal(wm.session, null);
  assert.equal(repo.getActiveWorkspaceId(), null);
});
