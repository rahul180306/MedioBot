import { createHash } from "node:crypto";
import { watch, realpathSync, type FSWatcher } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isOSMetadata, type WorkspaceWatchEvent } from "@mediobot-v2/contracts";

export type { WorkspaceWatchEvent };

function canonicalPathKey(filePath: string): string {
  try {
    const real = realpathSync(filePath);
    return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
  } catch {
    let current = path.resolve(filePath);
    const missing: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        const fallback = path.resolve(filePath);
        return process.platform === "win32" || process.platform === "darwin" ? fallback.toLowerCase() : fallback;
      }
      missing.unshift(path.basename(current));
      try {
        const parentReal = realpathSync(parent);
        const resolved = path.join(parentReal, ...missing);
        return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          current = parent;
          continue;
        }
        const fallback = path.resolve(filePath);
        return process.platform === "win32" || process.platform === "darwin" ? fallback.toLowerCase() : fallback;
      }
    }
  }
}

export class OwnWriteRegistry {
  private readonly entries = new Map<string, { hash: string; origin: "editor" | "agent"; expiresAt: number }>();

  recordWrite(absolutePath: string, hash: string, origin: "editor" | "agent", ttlMs = 3000): void {
    const key = canonicalPathKey(absolutePath);
    this.entries.set(key, { hash, origin, expiresAt: Date.now() + ttlMs });
  }

  consume(absolutePath: string, currentHash?: string): "editor" | "agent" | "external" {
    const key = canonicalPathKey(absolutePath);
    const record = this.entries.get(key);
    if (!record) return "external";
    if (Date.now() > record.expiresAt) {
      this.entries.delete(key);
      return "external";
    }
    if (!currentHash || record.hash === currentHash || record.hash.slice(0, 16) === currentHash || currentHash.slice(0, 16) === record.hash) {
      return record.origin;
    }
    return "external";
  }

  clear(): void {
    this.entries.clear();
  }
}

export const globalOwnWriteRegistry = new OwnWriteRegistry();

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".mediobot",
]);

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private readonly pendingEvents = new Map<string, "create" | "modify" | "delete" | "rename">();
  private debounceTimer: NodeJS.Timeout | null = null;
  private isClosed = false;
  private readonly rootPath: string;
  private readonly onEvents: (events: readonly WorkspaceWatchEvent[]) => void;
  private readonly debounceMs: number;

  constructor(
    rootPath: string,
    onEvents: (events: readonly WorkspaceWatchEvent[]) => void,
    debounceMs = 150
  ) {
    try {
      this.rootPath = realpathSync(rootPath);
    } catch {
      this.rootPath = path.resolve(rootPath);
    }
    this.onEvents = onEvents;
    this.debounceMs = debounceMs;
    this.start();
  }

  private start(): void {
    try {
      this.watcher = watch(
        this.rootPath,
        { recursive: true },
        (eventType, filename) => {
          if (this.isClosed || !filename) return;

          // Normalize path
          const relPath = filename.split(path.sep).join("/");
          const parts = relPath.split("/");

          // Ignore self/root notifications from FSEvents or hidden/heavy directories or temporary files or OS metadata
          if (
            !relPath ||
            relPath === "." ||
            relPath === path.basename(this.rootPath) ||
            parts.some(
              (p) =>
                IGNORED_NAMES.has(p) ||
                p.startsWith(".mediobot-") ||
                p.startsWith(".tmp.") ||
                p.endsWith(".tmp") ||
                isOSMetadata(p)
            )
          ) {
            return;
          }

          this.queueEvent(relPath, eventType);
        }
      );
      if (this.watcher && typeof this.watcher.unref === "function") {
        this.watcher.unref();
      }

      this.watcher.on("error", (error) => {
        // Handle watcher errors gracefully without crashing process
        if (!this.isClosed) {
          console.error(`[WorkspaceWatcher error on ${this.rootPath}]:`, error);
        }
      });
    } catch (err) {
      console.error(`[Failed to initialize WorkspaceWatcher on ${this.rootPath}]:`, err);
    }
  }

  private queueEvent(relPath: string, rawType: string): void {
    // Stage event
    const current = this.pendingEvents.get(relPath);
    if (!current) {
      this.pendingEvents.set(relPath, rawType === "rename" ? "rename" : "modify");
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    this.debounceTimer = setTimeout(() => {
      void this.flushEvents();
    }, this.debounceMs);
  }

  private async flushEvents(): Promise<void> {
    if (this.isClosed || this.pendingEvents.size === 0) return;

    const entries = [...this.pendingEvents.entries()];
    this.pendingEvents.clear();

    const resolvedEvents: WorkspaceWatchEvent[] = [];
    const now = Date.now();

    for (const [relPath, stagedType] of entries) {
      const fullPath = path.join(this.rootPath, relPath);
      try {
        const stat = await lstat(fullPath);
        // Exists on disk
        const eventType = stagedType === "rename" ? "create" : "modify";
        let contentHash: string | undefined;
        if (stat.isFile() && stat.size <= 1024 * 1024) {
          try {
            const bytes = await readFile(fullPath);
            contentHash = createHash("sha256").update(bytes).digest("hex");
          } catch {}
        }
        const origin = globalOwnWriteRegistry.consume(fullPath, contentHash);
        resolvedEvents.push({
          type: eventType,
          relativePath: relPath,
          timestamp: now,
          ...(contentHash ? { contentHash } : {}),
          origin,
        });
      } catch {
        // Does not exist -> deleted
        resolvedEvents.push({
          type: "delete",
          relativePath: relPath,
          timestamp: now,
          origin: "external",
        });
      }
    }

    if (resolvedEvents.length > 0 && !this.isClosed) {
      this.onEvents(resolvedEvents);
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
  }
}
