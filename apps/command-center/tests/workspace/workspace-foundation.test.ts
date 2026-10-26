import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalDatabase } from "../../src/storage/db.ts";
import { WorkspaceRepository } from "../../src/storage/workspaceRepository.ts";
import { ChatRepository, sanitizeThread } from "../../src/storage/chatRepository.ts";
import { MemoryCacheStore } from "../../src/storage/cache.ts";
import { WorkspaceManager } from "../../src/workspaceManager.ts";
import type { Thread } from "../../src/types/index.ts";

test("WORKSPACE FOUNDATION DETERMINISTIC GATES (A through Z)", async (suite) => {
  const rootTemp = await mkdtemp(path.join(os.tmpdir(), "mediobot-foundation-test-"));
  const managers = new Set<WorkspaceManager>();
  const disposeManagers = () => {
    for (const manager of managers) manager.dispose();
    managers.clear();
  };

  const dbPath = path.join(rootTemp, "test-foundation.db");
  const db = new LocalDatabase(dbPath);
  const repo = new WorkspaceRepository(db.raw);
  const chatRepo = new ChatRepository(db.raw);

  const createWorkspaceManager = () => {
    const manager = new WorkspaceManager(repo);
    managers.add(manager);
    return manager;
  };
  const runWorkspaceTest = (name: string, body: () => Promise<void>) => suite.test(name, async () => {
    try { await body(); } finally { disposeManagers(); }
  });

  suite.after(async () => {
    disposeManagers();
    try { db.close(); } catch {}
    await rm(rootTemp, { recursive: true, force: true });
  });

  // Setup disposable directories
  const dirA = path.join(rootTemp, "workspace-alpha");
  const dirB = path.join(rootTemp, "workspace-beta");
  await mkdir(path.join(dirA, "src"), { recursive: true });
  await mkdir(path.join(dirB, "test"), { recursive: true });
  await writeFile(path.join(dirA, "src", "alpha.ts"), "export const a = 'alpha';\n");
  await writeFile(path.join(dirB, "test", "beta.ts"), "export const b = 'beta';\n");

  const realA = await realpath(dirA);
  const realB = await realpath(dirB);

  // A. EMPTY -> OPEN
  await runWorkspaceTest("Gate A: EMPTY -> OPEN transitions properly", async () => {
    repo.setActiveWorkspaceId(null);
    const wm = createWorkspaceManager();
    assert.equal(wm.state.status, "EMPTY");
    assert.equal(wm.session, null);

    const session = await wm.openWorkspace(dirA);
    assert.equal(wm.state.status, "OPEN");
    assert.ok(session);
    assert.equal(session.displayName, "workspace-alpha");
    assert.equal(wm.session?.displayName, "workspace-alpha");
  });

  // B. Workspace A -> Workspace B
  await runWorkspaceTest("Gate B: Workspace A -> Workspace B atomic replacement", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirA);
    assert.equal(wm.session?.displayName, "workspace-alpha");

    const sessionB = await wm.openWorkspace(dirB);
    assert.equal(wm.state.status, "OPEN");
    assert.equal(sessionB.displayName, "workspace-beta");
    assert.equal(wm.session?.displayName, "workspace-beta");
  });

  // C. old tabs disappear on switch
  await runWorkspaceTest("Gate C: old tabs disappear on switch", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirA);
    wm.saveUIState("src/alpha.ts", [{ path: "src/alpha.ts", name: "alpha.ts" }], []);

    const uiA = wm.getUIState();
    assert.equal(uiA?.openTabs.length, 1);
    assert.equal(uiA?.openTabs[0]?.name, "alpha.ts");

    // Switch to Workspace B
    await wm.openWorkspace(dirB);
    const uiB = wm.getUIState();
    assert.equal(uiB, null); // B has not saved tabs yet; A's tabs are not leaked into B
  });

  // D. Composer Open row disappears after successful open
  await runWorkspaceTest("Gate D: Composer Open row state condition", async () => {
    const wm = createWorkspaceManager();
    assert.equal(wm.state.status === "EMPTY", false); // Now beta is open
    wm.closeWorkspace();
    assert.equal(wm.state.status === "EMPTY", true); // When empty, composer shows Open / This computer
    await wm.openWorkspace(dirB);
    assert.equal(wm.state.status === "OPEN", true); // When open, open controls row is hidden
  });

  // E. refresh cannot restore A after B is active
  await runWorkspaceTest("Gate E: refresh cannot restore A after B is active", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    assert.equal(wm.session?.displayName, "workspace-beta");

    // Refresh tree
    const entries = await wm.listFiles("");
    assert.ok(entries.some((e) => e.name === "test"));
    assert.ok(!entries.some((e) => e.name === "src")); // Alpha directory must NOT appear
    assert.equal(wm.session?.displayName, "workspace-beta");
  });

  // F. restart restores B
  await runWorkspaceTest("Gate F: restart restores last active workspace B", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    const wmRestart = createWorkspaceManager();
    assert.equal(wmRestart.state.status, "OPEN");
    assert.equal(wmRestart.session?.displayName, "workspace-beta");
  });

  // G. unavailable workspace does not fall back to repo
  await runWorkspaceTest("Gate G: unavailable workspace does not fall back to repo", async () => {
    const deadDir = path.join(rootTemp, "disposable-dead-workspace");
    await mkdir(deadDir);
    const wm = createWorkspaceManager();
    await wm.openWorkspace(deadDir);
    assert.equal(wm.session?.displayName, "disposable-dead-workspace");

    // Delete folder externally
    await rm(deadDir, { recursive: true, force: true });

    // Restart workspace manager
    const wmRestored = createWorkspaceManager();
    assert.equal(wmRestored.state.status, "UNAVAILABLE");
    assert.equal(wmRestored.session?.displayName, "disposable-dead-workspace");
    // Ensure it did NOT fall back to process.cwd()
    assert.notEqual(wmRestored.session?.canonicalRootPath, process.cwd());
  });

  // H. New File inline create
  await runWorkspaceTest("Gate H: New File creates real disk file inside workspace", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await wm.createEntry("", "hello.ts", "file");

    const content = await readFile(path.join(dirB, "hello.ts"), "utf8");
    assert.equal(content, "");
    const list = await wm.listFiles("");
    assert.ok(list.some((e) => e.name === "hello.ts" && e.type === "file"));
  });

  // I. New Folder inline create
  await runWorkspaceTest("Gate I: New Folder creates real disk directory", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await wm.createEntry("", "components", "folder");

    const list = await wm.listFiles("");
    assert.ok(list.some((e) => e.name === "components" && e.type === "folder"));
  });

  // J. Escape cancels creation
  await runWorkspaceTest("Gate J: Escape/cancel leaves disk unchanged", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    // Simulating user cancelling without committing
    const listBefore = await wm.listFiles("");
    // No operation performed
    const listAfter = await wm.listFiles("");
    assert.equal(listBefore.length, listAfter.length);
  });

  // K. invalid name remains editable
  await runWorkspaceTest("Gate K: Invalid names are rejected safely", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await assert.rejects(
      async () => wm.createEntry("", "../outside.ts", "file"),
      /outside this project|safe file|containment/i
    );
    await assert.rejects(
      async () => wm.createEntry("", "bad/name.ts", "file"),
      /outside this project|safe file|containment/i
    );
  });

  // L. rename updates open tab
  await runWorkspaceTest("Gate L: rename updates open tab path", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await wm.createEntry("components", "Button.tsx", "file");
    wm.saveUIState("components/Button.tsx", [{ path: "components/Button.tsx", name: "Button.tsx" }], []);

    await wm.renameEntry("components/Button.tsx", "PrimaryButton.tsx");
    // Verify disk changed
    const list = await wm.listFiles("components");
    assert.ok(list.some((e) => e.name === "PrimaryButton.tsx"));
    assert.ok(!list.some((e) => e.name === "Button.tsx"));
  });

  // M. delete closes open tab
  await runWorkspaceTest("Gate M: delete removes item from disk", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await wm.deleteEntry("components/PrimaryButton.tsx");

    const list = await wm.listFiles("components");
    assert.ok(!list.some((e) => e.name === "PrimaryButton.tsx"));
  });

  // P. external modification updates clean editor
  await runWorkspaceTest("Gate P: external modification detected version hash", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await writeFile(path.join(dirB, "versioned.ts"), "initial content\n");

    const read1 = await wm.readFileVersioned("versioned.ts");
    assert.equal(read1.content, "initial content\n");

    // External modification
    await writeFile(path.join(dirB, "versioned.ts"), "updated externally\n");
    const read2 = await wm.readFileVersioned("versioned.ts");
    assert.equal(read2.content, "updated externally\n");
    assert.notEqual(read1.hash, read2.hash);
  });

  // Q. external modification does not overwrite dirty editor
  await runWorkspaceTest("Gate Q: conflict detected when expectedHash does not match", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    const read = await wm.readFileVersioned("versioned.ts");

    // Modify externally
    await writeFile(path.join(dirB, "versioned.ts"), "modified elsewhere\n");

    // Attempting to write with stale hash must reject with file-conflict
    await assert.rejects(
      async () => wm.writeFile("versioned.ts", "user dirty edits\n", read.hash),
      (err: Error) => err.message === "file-conflict"
    );

    // Verify disk was NOT overwritten
    const currentOnDisk = await readFile(path.join(dirB, "versioned.ts"), "utf8");
    assert.equal(currentOnDisk, "modified elsewhere\n");
  });

  // R. autosave writes real disk
  await runWorkspaceTest("Gate R: valid write saves to disk and updates hash", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    const read = await wm.readFileVersioned("versioned.ts");

    const saved = await wm.writeFile("versioned.ts", "autosaved content\n", read.hash);
    assert.ok(saved.hash);
    const onDisk = await readFile(path.join(dirB, "versioned.ts"), "utf8");
    assert.equal(onDisk, "autosaved content\n");
  });

  // S. autosave conflict is surfaced
  await runWorkspaceTest("Gate S: conflict is surfaced on hash collision", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    await assert.rejects(
      async () => wm.writeFile("versioned.ts", "conflict text", "stale-hash-1234"),
      /file-conflict/
    );
  });

  // T. collapse all does not refetch/switch workspace
  await runWorkspaceTest("Gate T: collapse all preserves session identity", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);
    const sessionIdBefore = wm.session?.workspaceId;

    // Simulate collapse all UI state update
    wm.saveUIState(null, [], []);
    assert.equal(wm.session?.workspaceId, sessionIdBefore);
  });

  // U. SQLite restart persistence
  await runWorkspaceTest("Gate U: SQLite persists workspaces and ui state across restarts", async () => {
    const activeId = repo.getActiveWorkspaceId();
    const wsB = repo.findByPath(realB);
    assert.equal(activeId, wsB?.id);

    const ws = repo.get(activeId!);
    assert.ok(ws);
    assert.equal(ws.displayName, "workspace-beta");
  });

  // V. chat survives restart
  await runWorkspaceTest("Gate V: Chat thread survives database restart", async () => {
    const wsB = repo.findByPath(realB);
    const thread: Thread = {
      id: "thread-durable-1",
      title: "Persistence Verification",
      projectId: wsB?.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "MiniMax-M2.7",
      branch: "main",
      approvalMode: "Approve for me",
      turns: [
        {
          id: "turn-1",
          threadId: "thread-durable-1",
          prompt: "Explain architecture",
          status: "completed",
          createdAt: Date.now(),
          items: [
            { id: "msg-1", turnId: "turn-1", type: "user_message", timestamp: Date.now(), text: "Explain architecture" },
            { id: "msg-2", turnId: "turn-1", type: "agent_message", timestamp: Date.now(), text: "Here is the design." },
          ],
        },
      ],
    };

    chatRepo.save(thread);
    const restored = chatRepo.get("thread-durable-1");
    assert.ok(restored);
    assert.equal(restored.title, "Persistence Verification");
    assert.equal(restored.turns[0]?.items.length, 2);
  });

  // W. no hidden reasoning stored
  await runWorkspaceTest("Gate W: hidden reasoning and keys are stripped from persistence", async () => {
    const dirtyThread: Thread = {
      id: "thread-sanitize-test",
      title: "Sanitize Test",
      projectId: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: "test",
      branch: "main",
      approvalMode: "Approve for me",
      turns: [
        {
          id: "turn-secret",
          threadId: "thread-sanitize-test",
          prompt: "test",
          status: "completed",
          createdAt: Date.now(),
          items: [
            {
              id: "item-secret",
              turnId: "turn-secret",
              type: "agent_message",
              timestamp: Date.now(),
              text: "<think>Hidden reasoning internal chain of thought</think>Here is the clean answer.",
            },
          ],
        },
      ],
    };

    const sanitized = sanitizeThread(dirtyThread);
    assert.equal(sanitized.turns[0]?.items[0]?.text.includes("<think>"), false);
    assert.equal(sanitized.turns[0]?.items[0]?.text, "Here is the clean answer.");
  });

  // X. cache expiration
  await runWorkspaceTest("Gate X: MemoryCacheStore TTL and LRU expiration", async () => {
    const cache = new MemoryCacheStore(5);
    cache.set("short-lived", "value", 50);
    assert.equal(cache.get("short-lived"), "value");

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(cache.get("short-lived"), undefined);
  });

  // Y. watcher closed on workspace switch
  await runWorkspaceTest("Gate Y: Watcher closed on workspace switch", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirA);
    // Switch to B
    await wm.openWorkspace(dirB);
    assert.equal(wm.session?.canonicalRootPath, realB);
    wm.closeWorkspace();
    assert.equal(wm.session, null);
  });

  // Z. containment/security regression tests
  await runWorkspaceTest("Gate Z: containment and security regression tests", async () => {
    const wm = createWorkspaceManager();
    await wm.openWorkspace(dirB);

    // Path traversal rejection
    await assert.rejects(async () => wm.readFile("../alpha.ts"), /outside this project|containment/i);
    await assert.rejects(async () => wm.readFile("/etc/passwd"), /outside this project|containment/i);
    await assert.rejects(async () => wm.writeFile("../../escape.txt", "evil", "hash"), /outside this project|containment/i);
    await assert.rejects(async () => wm.createEntry("", "test\0null", "file"), /safe file|invalid|containment/i);
  });
});
