import { opendir, realpath, lstat, stat } from "node:fs/promises";
import path from "node:path";
import { isSensitiveName, SYSTEM_IGNORED_DIR_NAMES } from "@mediobot-v2/contracts";

export interface DiscoveredFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly isTest: boolean;
  readonly isConfig: boolean;
}

export class WorkspaceScanner {
  private readonly workspaceRoot: string;
  private canonicalRoot = "";

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async init(): Promise<string> {
    try {
      this.canonicalRoot = await realpath(this.workspaceRoot);
    } catch (err) {
      throw new Error(`Workspace root does not exist or cannot be resolved: ${this.workspaceRoot}`);
    }
    const meta = await lstat(this.canonicalRoot);
    if (!meta.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${this.canonicalRoot}`);
    }
    return this.canonicalRoot;
  }

  getCanonicalRoot(): string {
    return this.canonicalRoot;
  }

  async scan(): Promise<DiscoveredFile[]> {
    if (!this.canonicalRoot) {
      await this.init();
    }

    const results: DiscoveredFile[] = [];
    const visitedRealPaths = new Set<string>();

    await this.walkDirectory(this.canonicalRoot, "", results, visitedRealPaths, 0);

    return results;
  }

  private async walkDirectory(
    dirAbsolutePath: string,
    dirRelativePath: string,
    results: DiscoveredFile[],
    visitedRealPaths: Set<string>,
    depth: number
  ): Promise<void> {
    if (depth > 20) return; // Guard against deep recursion

    let dirHandle;
    try {
      dirHandle = await opendir(dirAbsolutePath);
    } catch {
      return; // Unreadable directory
    }

    try {
      for await (const entry of dirHandle) {
        const entryName = entry.name;
        if (entryName === "." || entryName === "..") continue;

        const relPath = dirRelativePath ? `${dirRelativePath}/${entryName}` : entryName;
        const absPath = path.join(dirAbsolutePath, entryName);

        // Filter directories and hidden system directories
        if (entry.isDirectory()) {
          if (
            SYSTEM_IGNORED_DIR_NAMES.has(entryName) ||
            entryName.startsWith(".mediobot-") ||
            isSensitiveName(entryName) ||
            isSensitiveName(relPath)
          ) {
            continue;
          }

          // Check symlink directory safety
          let targetReal: string;
          try {
            targetReal = await realpath(absPath);
          } catch {
            continue;
          }

          if (isSensitiveName(targetReal)) {
            continue;
          }

          // Verify target stays inside canonical workspace root
          const relToRoot = path.relative(this.canonicalRoot, targetReal);
          if (relToRoot === ".." || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot)) {
            continue; // Symlink escapes workspace
          }

          if (visitedRealPaths.has(targetReal)) {
            continue; // Cycle detection
          }
          visitedRealPaths.add(targetReal);

          await this.walkDirectory(absPath, relPath, results, visitedRealPaths, depth + 1);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          // Check file ignores
          if (isSensitiveName(entryName) || isSensitiveName(relPath)) {
            continue;
          }

          // Symlink containment check
          let targetReal: string;
          let fileStats;
          try {
            targetReal = await realpath(absPath);
            fileStats = await stat(targetReal);
          } catch {
            continue;
          }

          if (!fileStats.isFile()) continue;

          // Check if resolved path escapes workspace
          const relToRoot = path.relative(this.canonicalRoot, targetReal);
          if (relToRoot === ".." || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot)) {
            continue; // Escapes workspace root
          }

          const isTest = this.checkIsTest(relPath);
          const isConfig = this.checkIsConfig(relPath);

          results.push({
            relativePath: relPath,
            absolutePath: absPath,
            sizeBytes: fileStats.size,
            mtimeMs: fileStats.mtimeMs,
            isTest,
            isConfig,
          });
        }
      }
    } finally {
      // dirHandle closed automatically when async iteration completes
    }
  }

  private checkIsTest(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
      lower.includes(".test.") ||
      lower.includes(".spec.") ||
      lower.includes("__tests__") ||
      lower.startsWith("test/") ||
      lower.startsWith("tests/")
    );
  }

  private checkIsConfig(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    return (
      base.includes("config.") ||
      base.startsWith("tsconfig") ||
      base === "package.json" ||
      base.startsWith(".eslintrc") ||
      base.startsWith(".prettierrc") ||
      base === "vite.config.ts" ||
      base === "next.config.js"
    );
  }
}
