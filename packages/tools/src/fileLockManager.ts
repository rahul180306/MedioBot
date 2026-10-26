import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FileLockOptions, UnifiedFileLockService } from "@mediobot-v2/contracts";
import { FileLockTimeoutError } from "@mediobot-v2/contracts";

interface LockWaiter {
  readonly id: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  cleanupSignal?: () => void;
}

interface LockEntry {
  isLocked: boolean;
  queue: LockWaiter[];
}

export function normalizePathCase(filePath: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? filePath.toLowerCase()
    : filePath;
}

export async function resolveCanonicalPath(filePath: string, baseDir?: string): Promise<string> {
  const resolved = baseDir ? path.resolve(baseDir, filePath) : path.resolve(filePath);
  try {
    const real = await realpath(resolved);
    return normalizePathCase(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  // File does not exist yet: walk up to find the closest existing parent directory
  let current = resolved;
  const missingSegments: string[] = [];
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return normalizePathCase(resolved);
    }
    missingSegments.unshift(path.basename(current));
    try {
      const parentReal = await realpath(parent);
      const combined = path.join(parentReal, ...missingSegments);
      return normalizePathCase(combined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        current = parent;
        continue;
      }
      return normalizePathCase(resolved);
    }
  }
}

export class FileLockManager implements UnifiedFileLockService {
  private readonly entries = new Map<string, LockEntry>();
  private readonly defaultTimeoutMs: number;

  constructor(options?: { readonly defaultTimeoutMs?: number }) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  }

  async resolveCanonicalPath(filePath: string, baseDir?: string): Promise<string> {
    return resolveCanonicalPath(filePath, baseDir);
  }

  async acquireWriteLock<T>(
    filePath: string,
    expectedHash: string | undefined,
    operation: () => Promise<T>,
    options?: FileLockOptions
  ): Promise<T> {
    const canonical = await this.resolveCanonicalPath(filePath);
    const key = `file:${canonical}`;
    await this.acquireRawLock(key, canonical, options);

    try {
      if (expectedHash !== undefined) {
        let currentContent: string | null = null;
        try {
          currentContent = await readFile(canonical, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        if (currentContent === null) {
          if (expectedHash !== "" && expectedHash !== null) {
            const err = new Error("file-conflict");
            (err as any).code = "STALE_REVISION";
            throw err;
          }
        } else {
          const fullHash = createHash("sha256").update(currentContent).digest("hex");
          const shortHash = fullHash.slice(0, 16);
          if (expectedHash !== fullHash && expectedHash !== shortHash) {
            const err = new Error("file-conflict");
            (err as any).code = "STALE_REVISION";
            throw err;
          }
        }
      }

      return await operation();
    } finally {
      this.releaseRawLock(key);
    }
  }

  async acquireWriteLocks<T>(
    filePaths: readonly string[],
    operation: () => Promise<T>,
    options?: FileLockOptions
  ): Promise<T> {
    const canonicalPaths = await Promise.all(filePaths.map((p) => this.resolveCanonicalPath(p)));
    const uniqueOrdered = [...new Set(canonicalPaths)].sort();

    const acquireNext = async (index: number): Promise<T> => {
      if (index === uniqueOrdered.length) {
        return await operation();
      }
      return await this.acquireWriteLock(
        uniqueOrdered[index]!,
        undefined,
        () => acquireNext(index + 1),
        options
      );
    };

    return acquireNext(0);
  }

  /**
   * Backward-compatible lock acquisition method for ToolRuntime.
   */
  async acquire<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    return this.acquireWriteLock(filePath, undefined, fn);
  }

  private acquireRawLock(key: string, canonicalPath: string, options?: FileLockOptions): Promise<void> {
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("Operation aborted"));
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { isLocked: false, queue: [] };
      this.entries.set(key, entry);
    }

    if (!entry.isLocked) {
      entry.isLocked = true;
      return Promise.resolve();
    }

    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const signal = options?.signal;

    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Operation aborted"));
    }

    return new Promise<void>((resolve, reject) => {
      const waiterId = Math.random().toString(36).slice(2);
      const waiter: LockWaiter = {
        id: waiterId,
        resolve,
        reject,
      };

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(key, waiterId);
          reject(new FileLockTimeoutError(canonicalPath, timeoutMs));
        }, timeoutMs);
      }

      if (signal) {
        const onAbort = () => {
          this.removeWaiter(key, waiterId);
          reject(signal.reason ?? new Error("Operation aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanupSignal = () => signal.removeEventListener("abort", onAbort);
      }

      entry!.queue.push(waiter);
    });
  }

  private releaseRawLock(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    while (entry.queue.length > 0) {
      const next = entry.queue.shift()!;
      if (next.timer) clearTimeout(next.timer);
      if (next.cleanupSignal) next.cleanupSignal();

      next.resolve();
      return;
    }

    entry.isLocked = false;
    this.entries.delete(key);
  }

  private removeWaiter(key: string, waiterId: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const index = entry.queue.findIndex((w) => w.id === waiterId);
    if (index !== -1) {
      const [waiter] = entry.queue.splice(index, 1);
      if (waiter?.timer) clearTimeout(waiter.timer);
      if (waiter?.cleanupSignal) waiter.cleanupSignal();
    }
    if (!entry.isLocked && entry.queue.length === 0) {
      this.entries.delete(key);
    }
  }
}

export const defaultFileLockManager = new FileLockManager();
