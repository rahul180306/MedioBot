import { watch, type FSWatcher } from "node:fs";
import { lstat, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { isSensitiveName } from "@mediobot-v2/contracts";

export interface FileChangeEvent {
  readonly type: "create" | "modify" | "delete";
  readonly relativePath: string;
  readonly timestamp: number;
}

const IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".vite",
  "out",
  ".turbo",
  ".mediobot",
  ".aws",
  ".ssh",
  ".gnupg",
  "coverage",
  ".cache",
]);

export class ProjectFileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly pendingEvents = new Map<string, "create" | "modify" | "delete" | "rename">();
  private debounceTimer: NodeJS.Timeout | null = null;
  private isClosed = false;
  private isProcessing = false;
  private readonly queuedBatches: string[][] = [];

  readonly workspaceRoot: string;
  private canonicalRoot = "";
  private readonly onChange: (changedPaths: ReadonlyArray<string>) => Promise<void> | void;
  private readonly debounceMs: number;

  constructor(
    workspaceRoot: string,
    onChange: (changedPaths: ReadonlyArray<string>) => Promise<void> | void,
    debounceMs = 150
  ) {
    this.workspaceRoot = workspaceRoot;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  async start(): Promise<void> {
    try {
      this.canonicalRoot = await realpath(this.workspaceRoot);
    } catch {
      this.canonicalRoot = path.resolve(this.workspaceRoot);
    }

    try {
      this.watcher = watch(
        this.canonicalRoot,
        { recursive: true },
        (eventType, filename) => {
          if (this.isClosed || !filename) return;

          const relPath = filename.split(path.sep).join("/");
          const parts = relPath.split("/");

          if (parts.some((p) => IGNORED_SEGMENTS.has(p) || p.startsWith(".mediobot-") || p.endsWith(".tmp"))) {
            return;
          }

          if (isSensitiveName(relPath)) {
            return;
          }

          this.queueEvent(relPath, eventType);
        }
      );

      if (this.watcher && typeof this.watcher.unref === "function") {
        this.watcher.unref();
      }

      this.watcher.on("error", (error) => {
        if (!this.isClosed) {
          console.error(`[ProjectFileWatcher error on ${this.canonicalRoot}]:`, error);
        }
      });
    } catch (err) {
      console.error(`[ProjectFileWatcher failed to initialize]:`, err);
    }
  }

  private queueEvent(relPath: string, rawType: string): void {
    if (this.isClosed) return;

    if (!this.pendingEvents.has(relPath)) {
      this.pendingEvents.set(relPath, rawType === "rename" ? "rename" : "modify");
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.flushEvents();
    }, this.debounceMs);
  }

  private async flushEvents(): Promise<void> {
    if (this.isClosed || this.pendingEvents.size === 0) return;

    const entries = [...this.pendingEvents.entries()];
    this.pendingEvents.clear();

    const changedPaths: string[] = [];

    for (const [relPath] of entries) {
      const fullPath = path.join(this.canonicalRoot, relPath);

      // Verify containment
      try {
        const candidateReal = await realpath(fullPath).catch(() => null);
        if (candidateReal) {
          const rel = path.relative(this.canonicalRoot, candidateReal);
          if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
            continue; // Symlink escapes workspace
          }
          const stats = await stat(candidateReal).catch(() => null);
          if (stats && stats.isDirectory()) {
            continue; // Ignore pure directory modifications
          }
        }
      } catch {
        // file might be deleted, which is expected
      }

      changedPaths.push(relPath);
    }

    if (changedPaths.length === 0) return;

    if (this.isProcessing) {
      // Avoid overlapping writes: enqueue for subsequent dispatch
      this.queuedBatches.push(changedPaths);
      return;
    }

    await this.dispatchBatch(changedPaths);
  }

  private async dispatchBatch(paths: string[]): Promise<void> {
    this.isProcessing = true;
    try {
      await this.onChange(paths);
    } catch (err) {
      console.error(`[ProjectFileWatcher change handler error]:`, err);
    } finally {
      this.isProcessing = false;

      // Process next queued batch if one arrived while processing
      if (this.queuedBatches.length > 0 && !this.isClosed) {
        const nextBatch = this.queuedBatches.shift()!;
        void this.dispatchBatch(nextBatch);
      }
    }
  }

  close(): void {
    this.isClosed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
    this.pendingEvents.clear();
    this.queuedBatches.length = 0;
  }
}
