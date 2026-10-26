import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sanitizeReasoningAndSecrets } from "@mediobot-v2/models";
import { isSensitiveName } from "@mediobot-v2/contracts";
import {
  isProjectIntelligenceEnabled,
  defaultProjectContextProvider,
  formatProjectContextForMaestro,
} from "@mediobot-v2/intelligence";
import type { MaestroContextRecord } from "./context.ts";

export interface ProjectDiscoveryOptions {
  readonly query?: string;
  readonly activeFile?: string;
  readonly openTabs?: ReadonlyArray<string>;
  readonly focusFiles?: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
}

export const DEFAULT_WORKSPACE_TOOL_METADATA: ReadonlyArray<{ readonly name: string; readonly description: string }> = [
  { name: "filesystem.list", description: "List files and directories within the workspace root" },
  { name: "filesystem.read", description: "Read regular file contents within the workspace" },
  { name: "filesystem.write", description: "Write file contents within the workspace with conflict safety" },
  { name: "terminal.execute", description: "Execute terminal commands and verify outcomes in the workspace root" },
];

const HIDDEN_NAMES = new Set([".git", ".aws", ".ssh", ".gnupg", "node_modules", "vendor", "dist", "build", ".next", ".vite", "out", ".turbo"]);
const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".aws", ".ssh", ".gnupg"]);

export { isSensitiveName };

/** Read a workspace file only when the opened file descriptor still resolves inside its canonical root. */
export async function readWorkspaceFile(workspaceRoot: string, relativePath: string, maxBytes: number): Promise<string | null> {
  if (!workspaceRoot || !relativePath || isSensitiveName(relativePath) || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]+/).some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment.toLowerCase()) || isSensitiveName(segment))) return null;
  const root = await realpath(workspaceRoot);
  if (path.resolve(root) !== path.resolve(workspaceRoot)) return null;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) return null;
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const resolved = await realpath(candidate);
    const resolvedRelative = path.relative(root, resolved);
    if (resolvedRelative === ".." || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) return null;
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size > maxBytes) return null;

    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size > maxBytes ||
        openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) return null;

    // Re-resolve after opening, before reading. The descriptor pins the checked inode, so
    // subsequent path swaps cannot redirect the read to a different file.
    const currentResolved = await realpath(candidate);
    const currentRelative = path.relative(root, currentResolved);
    if (currentRelative === ".." || currentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(currentRelative) || currentResolved !== resolved) return null;
    return await handle.readFile({ encoding: "utf8" });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Proven legacy workspace discovery scanning root entries progressively.
 * Preserved verbatim as active fallback when USE_PROJECT_INTELLIGENCE is false or on error.
 */
export async function discoverLegacyProjectIntelligence(workspaceRoot: string): Promise<ReadonlyArray<MaestroContextRecord>> {
  if (!workspaceRoot || typeof workspaceRoot !== "string") return [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
  } catch {
    return [];
  }
  if (path.resolve(canonicalRoot) !== path.resolve(workspaceRoot)) return [];
  const records: MaestroContextRecord[] = [];

  let rootStat;
  try {
    rootStat = await lstat(canonicalRoot);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  // 1. Progressive, bounded project structure discovery
  try {
    const lines: string[] = [];
    const dir = await opendir(canonicalRoot);
    const subdirsToSample: string[] = [];
    const candidateSubdirs = new Set(["src", "app", "apps", "packages", "lib", "test", "tests", "components", "pages"]);

    for await (const entry of dir) {
      if (lines.length >= 35) break;
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".agents") continue;
      if (HIDDEN_NAMES.has(entry.name) || isSensitiveName(entry.name) || /\.(?:sqlite|sqlite3|db)(?:-(?:shm|wal))?$/i.test(entry.name)) continue;

      const entryPath = path.join(canonicalRoot, entry.name);
      const meta = await lstat(entryPath).catch(() => null);
      if (!meta || meta.isSymbolicLink()) continue;

      if (meta.isDirectory()) {
        lines.push(`${entry.name}/`);
        if (candidateSubdirs.has(entry.name.toLowerCase())) {
          subdirsToSample.push(entry.name);
        }
      } else if (meta.isFile()) {
        lines.push(entry.name);
      }
    }
    lines.sort();

    // Sample shallow subdirectories if room permits
    for (const sub of subdirsToSample) {
      if (lines.length >= 35) break;
      try {
        const subDir = await opendir(path.join(canonicalRoot, sub));
        let count = 0;
        for await (const child of subDir) {
          if (count >= 5 || lines.length >= 35) break;
          if (child.name.startsWith(".") || HIDDEN_NAMES.has(child.name) || isSensitiveName(child.name) || /\.(?:sqlite|sqlite3|db)(?:-(?:shm|wal))?$/i.test(child.name)) continue;
          const childPath = path.join(canonicalRoot, sub, child.name);
          const childMeta = await lstat(childPath).catch(() => null);
          if (!childMeta || childMeta.isSymbolicLink()) continue;
          lines.push(`  ${sub}/${child.name}${childMeta.isDirectory() ? "/" : ""}`);
          count++;
        }
      } catch {
        // ignore
      }
    }

    if (lines.length > 0) {
      records.push({
        name: "project_structure",
        value: lines.join("\n").slice(0, 1500),
      });
    }
  } catch {
    // ignore
  }

  // 2. Applicable project instructions
  const instructionCandidates = ["AGENTS.md", "CLAUDE.md", ".agents/instructions.md", "README.md", "CONTRIBUTING.md"];
  for (const candidate of instructionCandidates) {
    try {
      const raw = await readWorkspaceFile(canonicalRoot, candidate, 1024 * 1024);
      if (raw !== null) {
        if (!raw.includes("\0")) {
          const sanitized = sanitizeReasoningAndSecrets(raw).trim();
          if (sanitized) {
            records.push({
              name: "project_instructions",
              value: `[${candidate}]\n${sanitized.slice(0, 2000)}`,
            });
            break;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Project Manifest / Package Metadata
  try {
    const raw = await readWorkspaceFile(canonicalRoot, "package.json", 512 * 1024);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const summary: Record<string, unknown> = {};
        if (typeof parsed.name === "string") summary.name = parsed.name;
        if (typeof parsed.type === "string") summary.type = parsed.type;
        if (parsed.scripts && typeof parsed.scripts === "object") {
          summary.scripts = Object.keys(parsed.scripts).slice(0, 15);
        }
        if (parsed.dependencies && typeof parsed.dependencies === "object") {
          summary.dependencies = Object.keys(parsed.dependencies).slice(0, 20);
        }
        if (parsed.devDependencies && typeof parsed.devDependencies === "object") {
          summary.devDependencies = Object.keys(parsed.devDependencies).slice(0, 20);
        }
        records.push({
          name: "project_manifest",
          value: JSON.stringify(summary),
        });
      }
    }
  } catch {
    // ignore
  }

  return records;
}

/**
 * Maestro project intelligence entrypoint.
 * Behind USE_PROJECT_INTELLIGENCE=false: returns discoverLegacyProjectIntelligence verbatim.
 * Behind USE_PROJECT_INTELLIGENCE=true: uses Project Intelligence Engine with safe fallback to legacy.
 */
export async function discoverProjectIntelligence(
  workspaceRoot: string,
  options?: ProjectDiscoveryOptions
): Promise<ReadonlyArray<MaestroContextRecord>> {
  if (!isProjectIntelligenceEnabled()) {
    return discoverLegacyProjectIntelligence(workspaceRoot);
  }

  if (!workspaceRoot || typeof workspaceRoot !== "string") return [];
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
  } catch {
    return [];
  }
  if (path.resolve(canonicalRoot) !== path.resolve(workspaceRoot)) return [];

  try {
    const rootStat = await lstat(canonicalRoot);
    if (!rootStat.isDirectory()) return [];

    const focusFiles: string[] = [];
    if (options?.activeFile) focusFiles.push(options.activeFile);
    if (options?.openTabs) focusFiles.push(...options.openTabs);
    if (options?.focusFiles) focusFiles.push(...options.focusFiles);

    const context = await defaultProjectContextProvider.getContext(
      canonicalRoot,
      options?.query,
      {
        focusFiles,
        signal: options?.signal,
      }
    );

    const records = [...formatProjectContextForMaestro(context)];

    // Enrich with project instructions (e.g. AGENTS.md, CLAUDE.md, README.md)
    const instructionCandidates = ["AGENTS.md", "CLAUDE.md", ".agents/instructions.md", "README.md", "CONTRIBUTING.md"];
    for (const candidate of instructionCandidates) {
      try {
        const raw = await readWorkspaceFile(canonicalRoot, candidate, 1024 * 1024);
        if (raw !== null && !raw.includes("\0")) {
          const sanitized = sanitizeReasoningAndSecrets(raw).trim();
          if (sanitized) {
            records.push({
              name: "project_instructions",
              value: `[${candidate}]\n${sanitized.slice(0, 2000)}`,
            });
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Enrich project_manifest with package.json metadata if present (preserving legacy discovery compatibility)
    try {
      const rawPkg = await readWorkspaceFile(canonicalRoot, "package.json", 512 * 1024);
      if (rawPkg !== null) {
        const parsed = JSON.parse(rawPkg);
        if (parsed && typeof parsed === "object") {
          const manifestIdx = records.findIndex((r) => r.name === "project_manifest");
          let existingManifest: Record<string, unknown> = {};
          if (manifestIdx >= 0 && records[manifestIdx]) {
            try {
              existingManifest = JSON.parse(records[manifestIdx]!.value);
            } catch {
              // ignore
            }
          }
          const merged: Record<string, unknown> = {
            ...existingManifest,
            ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
            ...(typeof parsed.type === "string" ? { type: parsed.type } : {}),
            ...(parsed.scripts && typeof parsed.scripts === "object" ? { scripts: Object.keys(parsed.scripts).slice(0, 15) } : {}),
            ...(parsed.dependencies && typeof parsed.dependencies === "object" ? { dependencies: Object.keys(parsed.dependencies).slice(0, 20) } : {}),
            ...(parsed.devDependencies && typeof parsed.devDependencies === "object" ? { devDependencies: Object.keys(parsed.devDependencies).slice(0, 20) } : {}),
          };
          if (manifestIdx >= 0) {
            records[manifestIdx] = {
              name: "project_manifest",
              value: JSON.stringify(merged),
            };
          } else {
            records.push({
              name: "project_manifest",
              value: JSON.stringify(merged),
            });
          }
        }
      }
    } catch {
      // ignore
    }

    return records;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[ProjectIntelligence] PIE retrieval failed, falling back to legacy discovery: ${errorMsg}`);
    return discoverLegacyProjectIntelligence(workspaceRoot);
  }
}

