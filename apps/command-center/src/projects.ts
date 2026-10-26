import { createHash } from "node:crypto";
import { lstat, mkdir, opendir, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FileNode, ProjectInfo } from "./types/index.ts";
import { PathEscapeForbiddenError } from "@mediobot-v2/contracts";

const MAX_TREE_ENTRIES = 900;
const MAX_READ_BYTES = 1024 * 1024;
const HIDDEN_NAMES = new Set([".git", ".aws", ".ssh", "node_modules", "vendor", "dist", "build"]);
const isSecretName = (name: string) => /^\.env(?:\.|$)/i.test(name)
  || /^(?:secrets?|credentials?)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);

function projectId(root: string): string {
  return `project-${createHash("sha256").update(root).digest("hex").slice(0, 20)}`;
}

function contained(root: string, relative: string): string {
  if (relative.includes("\0") || path.isAbsolute(relative) || path.posix.isAbsolute(relative)
    || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)
    || relative.split(/[\\/]+/).includes("..")) throw new PathEscapeForbiddenError("The requested path is outside this project.");
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new PathEscapeForbiddenError("The requested path is outside this project.");
  }
  return target;
}

export class LocalProjectCatalog {
  private readonly roots = new Map<string, string>();
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(defaultRoot?: string) {
    if (defaultRoot) {
      const canonical = path.resolve(defaultRoot);
      this.roots.set(projectId(canonical), canonical);
    }
  }

  async list(): Promise<ProjectInfo[]> {
    const projects = await Promise.all([...this.roots.entries()].map(async ([id, root]) => {
      let canonical: string;
      try { canonical = await realpath(root); } catch { return undefined; }
      return { id, name: path.basename(canonical), path: canonical, branch: "", branches: [], environment: "Local" as const };
    }));
    return projects.filter((project): project is NonNullable<typeof project> => Boolean(project));
  }

  async add(rootPath: string): Promise<ProjectInfo> {
    if (!rootPath.trim()) throw new Error("Enter a local project folder path.");
    const canonical = await realpath(rootPath.trim());
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || canonical === path.parse(canonical).root) throw new Error("Choose a project directory, not a filesystem root.");
    for (const existing of this.roots.values()) {
      const realExisting = await realpath(existing);
      if (realExisting === canonical || realExisting.startsWith(`${canonical}${path.sep}`) || canonical.startsWith(`${realExisting}${path.sep}`)) {
        if (realExisting === canonical) return { id: projectId(canonical), name: path.basename(canonical), path: canonical,
          branch: "", branches: [], environment: "Local" };
        throw new Error("Project folders may not overlap.");
      }
    }
    const id = projectId(canonical);
    this.roots.set(id, canonical);
    return { id, name: path.basename(canonical), path: canonical, branch: "", branches: [], environment: "Local" };
  }

  async listFiles(id: string, relativePath = ""): Promise<FileNode[]> {
    const root = this.requireRoot(id);
    const base = contained(root, relativePath);
    await this.assertNoSymlink(root, base);
    if (!(await lstat(base)).isDirectory()) throw new Error("The requested project path is not a directory.");
    let total = 0;
    const visit = async (absolute: string, depth: number): Promise<FileNode[]> => {
      const result: FileNode[] = [];
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        if (total >= MAX_TREE_ENTRIES) break;
        if (entry.name.startsWith(".") && entry.name !== ".github" || HIDDEN_NAMES.has(entry.name) || isSecretName(entry.name)) continue;
        const entryPath = path.join(absolute, entry.name);
        const metadata = await lstat(entryPath);
        if (metadata.isSymbolicLink() || !metadata.isFile() && !metadata.isDirectory()) continue;
        total += 1;
        const rel = path.relative(root, entryPath).split(path.sep).join("/");
        result.push(metadata.isDirectory()
          ? { name: entry.name, path: rel, type: "folder", ...(depth < 8 ? { children: await visit(entryPath, depth + 1) } : {}) }
          : { name: entry.name, path: rel, type: "file" });
      }
      return result.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1);
    };
    return visit(base, 0);
  }

  async readFile(id: string, relativePath: string): Promise<string> {
    const root = this.requireRoot(id);
    const target = contained(root, relativePath);
    if (relativePath.split(/[\\/]+/).some(isSecretName)) throw new Error("Credential and secret files are not available in the editor.");
    await this.assertNoSymlink(root, target);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.nlink > 1) throw new Error("Only regular project files can be opened.");
    if (metadata.size > MAX_READ_BYTES) throw new Error("The file exceeds the 1 MB preview limit.");
    const content = await readFile(target, "utf8");
    if (content.includes("\0")) throw new Error("Binary files are not supported in the text editor.");
    return content;
  }

  async writeFile(id: string, relativePath: string, content: string, expectedHash: string): Promise<{ hash: string }> {
    const root = this.requireRoot(id);
    const target = contained(root, relativePath);
    if (!relativePath || relativePath.split(/[\\/]+/).some(isSecretName)) throw new Error("Credential and secret files cannot be edited.");
    if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES || content.includes("\0")) throw new Error("Only text files up to 1 MB can be saved.");
    return this.withWriteLock(target, async () => {
      await this.assertNoSymlink(root, target);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.nlink > 1) throw new Error("Only regular project files can be edited.");
      const current = await readFile(target);
      const currentHash = createHash("sha256").update(current).digest("hex");
      if (currentHash !== expectedHash) throw new Error("file-conflict");
      const temporary = path.join(path.dirname(target), `.mediobot-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: metadata.mode & 0o777 });
        await rename(temporary, target);
      } catch (error) {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return { hash: createHash("sha256").update(content).digest("hex") };
    });
  }

  async createEntry(id: string, parentPath: string, name: string, type: "file" | "folder"): Promise<void> {
    const root = this.requireRoot(id);
    if (!name.trim() || name === "." || name === ".." || /[\\/\\0]/.test(name) || name.startsWith(".") || isSecretName(name)) {
      throw new Error("Choose a safe file or folder name.");
    }
    const parent = contained(root, parentPath);
    await this.assertNoSymlink(root, parent);
    if (!(await lstat(parent)).isDirectory()) throw new Error("The parent folder is unavailable.");
    const target = contained(root, path.posix.join(parentPath, name));
    await this.withWriteLock(target, async () => {
      await this.assertNoSymlink(root, parent);
      if (type === "folder") await mkdir(target);
      else await writeFile(target, "", { flag: "wx", mode: 0o644 });
    });
  }

  async renameEntry(id: string, relativePath: string, nextName: string): Promise<void> {
    const root = this.requireRoot(id);
    const parts = relativePath.split(/[\\/]+/);
    if (!relativePath || parts.some((part) => !part || part.startsWith(".") || isSecretName(part))) {
      throw new Error("This project item cannot be renamed.");
    }
    if (!nextName.trim() || nextName === "." || nextName === ".." || nextName.includes("/") || nextName.includes("\\") || nextName.includes("\0")
      || nextName.startsWith(".") || isSecretName(nextName)) throw new Error("Choose a safe new name.");
    const source = contained(root, relativePath);
    const target = contained(root, path.relative(root, path.join(path.dirname(source), nextName.trim())));
    await this.withWriteLocks([source, target], async () => {
      await this.assertNoSymlink(root, source);
      await this.assertNoSymlink(root, path.dirname(source));
      const metadata = await lstat(source);
      if (!metadata.isFile() && !metadata.isDirectory() || metadata.isFile() && metadata.nlink > 1) {
        throw new Error("Only regular project files and folders can be renamed.");
      }
      try { await lstat(target); throw new Error("An item with that name already exists."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(source, target);
    });
  }

  async deleteEntry(id: string, relativePath: string): Promise<void> {
    const root = this.requireRoot(id);
    const parts = relativePath.split(/[\\/]+/);
    if (!relativePath || parts.some((part) => !part || part.startsWith(".") || isSecretName(part))) {
      throw new Error("This project item cannot be deleted.");
    }
    const target = contained(root, relativePath);
    await this.withWriteLock(target, async () => {
      await this.assertNoSymlink(root, target);
      const metadata = await lstat(target);
      if (!metadata.isFile() && !metadata.isDirectory() || metadata.isFile() && metadata.nlink > 1) {
        throw new Error("Only regular project files and folders can be deleted.");
      }
      await rm(target, { recursive: metadata.isDirectory(), force: false });
    });
  }

  rootFor(id: string): string { return this.requireRoot(id); }

  private requireRoot(id: string): string {
    const root = this.roots.get(id);
    if (!root) throw new Error("Project not found.");
    return root;
  }

  private async withWriteLock<T>(target: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(target) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.writeLocks.set(target, current);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.writeLocks.get(target) === current) this.writeLocks.delete(target);
    }
  }

  private withWriteLocks<T>(targets: readonly string[], action: () => Promise<T>): Promise<T> {
    const orderedTargets = [...new Set(targets)].sort();
    const acquire = (index: number): Promise<T> => index === orderedTargets.length
      ? action()
      : this.withWriteLock(orderedTargets[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  private async assertNoSymlink(root: string, target: string): Promise<void> {
    let cursor = root;
    const relative = path.relative(root, target);
    for (const segment of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are not opened in the project preview.");
    }
  }
}
