import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceWatcher } from "../../src/watcher/workspaceWatcher.ts";

function waitForEvent(received: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    received,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for watcher ${label} event`)), 1500);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function verifyWatcherEvents(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mediobot-watcher-probe-"));
  try {
    const watchRoot = path.join(root, "project");
    await mkdir(watchRoot);
    let resolveCreate!: () => void;
    const created = new Promise<void>((resolve) => { resolveCreate = resolve; });
    const createWatcher = new WorkspaceWatcher(watchRoot, (events) => {
      if (events.some((event) => event.type === "create" && event.relativePath === "external.txt")) resolveCreate();
    }, 25);
    try {
      await writeFile(path.join(watchRoot, "external.txt"), "created");
      await waitForEvent(created, "create");
    } finally {
      createWatcher.close();
    }

    let resolveDelete!: () => void;
    const deleted = new Promise<void>((resolve) => { resolveDelete = resolve; });
    const deleteWatcher = new WorkspaceWatcher(watchRoot, (events) => {
      if (events.some((event) => event.type === "delete" && event.relativePath === "external.txt")) resolveDelete();
    }, 25);
    try {
      await rm(path.join(watchRoot, "external.txt"));
      await waitForEvent(deleted, "delete");
    } finally {
      deleteWatcher.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const started = performance.now();
verifyWatcherEvents().then(() => {
  process.stdout.write(`PASS workspace watcher create/delete events (${Math.round(performance.now() - started)} ms)\n`);
}).catch((error: unknown) => {
  process.stderr.write(`FAIL workspace watcher create/delete events: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
