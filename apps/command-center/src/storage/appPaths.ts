import os from "node:os";
import path from "node:path";
import { chmodSync, lstatSync, mkdirSync, readlinkSync, realpathSync, statSync } from "node:fs";

function ensurePrivateAppDataDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Windows ACLs inherit from the per-user AppData directory; Node's chmod
  // does not provide equivalent ACL control there.
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

export function getProductionAppDataDirectory(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Mediobot");
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Mediobot");
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "Mediobot");
  }
}

export function getProductionDatabasePath(): string {
  return path.join(getProductionAppDataDirectory(), "mediobot.db");
}

export function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.execArgv.some((arg) => arg.includes("test")) ||
    process.argv.some((arg) => arg.includes(".test.") || arg.includes("/test") || arg.includes("--test")) ||
    Boolean(process.env.TEST_TEMP_DB) ||
    Boolean(process.env.VITEST) ||
    Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function canonicalizePath(input: string, visited = new Set<string>()): string {
  const resolved = path.resolve(input);
  if (visited.has(resolved)) {
    throw new Error("Cannot safely validate a cyclic database path.");
  }
  const nextVisited = new Set(visited);
  nextVisited.add(resolved);

  try {
    const info = lstatSync(resolved);
    if (info.isSymbolicLink()) {
      const link = readlinkSync(resolved);
      const target = path.isAbsolute(link) ? link : path.resolve(path.dirname(resolved), link);
      return canonicalizePath(target, nextVisited);
    }
    return realpathSync.native(resolved);
  } catch (error) {
    // SQLite may create the final database file after this guard. Resolve the
    // deepest existing parent so a dangling symlink still maps to its target.
    if (error instanceof Error && error.message === "Cannot safely validate a cyclic database path.") throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonicalizePath(parent, nextVisited), path.basename(resolved));
  }
}

export function assertNonProductionDatabase(filePath: string): void {
  if (isTestEnvironment() && !process.env.MEDIOBOT_ALLOW_PROD_DB) {
    const resolvedTarget = canonicalizePath(filePath);
    const resolvedProd = canonicalizePath(getProductionDatabasePath());
    let sameFile = resolvedTarget === resolvedProd;
    if (!sameFile) {
      try {
        const targetIdentity = statSync(resolvedTarget, { bigint: true });
        const productionIdentity = statSync(resolvedProd, { bigint: true });
        sameFile = targetIdentity.dev === productionIdentity.dev && targetIdentity.ino === productionIdentity.ino;
      } catch {
        // A not-yet-created target has no file identity; canonical paths above
        // still protect direct and symlink aliases before SQLite creates it.
      }
    }
    if (sameFile) {
      throw new Error("Tests are strictly prohibited from accessing or mutating the production database.");
    }
  }
}

export function getAppDataDirectory(): string {
  if (process.env.MEDIOBOT_DATA_DIR && process.env.MEDIOBOT_DATA_DIR.trim()) {
    const custom = path.resolve(process.env.MEDIOBOT_DATA_DIR.trim());
    return ensurePrivateAppDataDirectory(custom);
  }

  if (isTestEnvironment()) {
    const testDir = path.join(os.tmpdir(), `mediobot-test-isolated-${process.pid}`);
    return ensurePrivateAppDataDirectory(testDir);
  }

  const baseDir = getProductionAppDataDirectory();
  return ensurePrivateAppDataDirectory(baseDir);
}

export function getDatabasePath(): string {
  const target = path.join(getAppDataDirectory(), "mediobot.db");
  assertNonProductionDatabase(target);
  return target;
}

