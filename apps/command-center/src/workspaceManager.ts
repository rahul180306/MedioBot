import { createHash, randomUUID } from "node:crypto";
import { realpathSync, lstatSync } from "node:fs";
import { lstat, mkdir, opendir, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileNode } from "./types/index.ts";
import type { WorkspaceRepository, PersistedWorkspace, PersistedWorkspaceUIState, PersistedWorkbenchTab } from "./storage/workspaceRepository.ts";
import { WorkspaceWatcher, globalOwnWriteRegistry, type WorkspaceWatchEvent } from "./watcher/workspaceWatcher.ts";
import { discoverProjectIntelligence, DEFAULT_WORKSPACE_TOOL_METADATA, isSensitiveName as isSensitiveDiscoveryName, readWorkspaceFile } from "@mediobot-v2/maestro";
import type { UnifiedFileLockService } from "@mediobot-v2/contracts";
import { PathEscapeForbiddenError, isOSMetadata } from "@mediobot-v2/contracts";
import { defaultFileLockManager } from "@mediobot-v2/tools";

export type WorkspaceStatus = "EMPTY" | "OPENING" | "OPEN" | "SWITCHING" | "UNAVAILABLE";

export interface WorkspaceSession {
  readonly workspaceId: string;
  readonly canonicalRootPath: string;
  readonly displayName: string;
  readonly openedAt: number;
}

export interface WorkspaceState {
  readonly status: WorkspaceStatus;
  readonly session: WorkspaceSession | null;
}

export interface WorkspaceProjectIntelligence {
  readonly workspaceRoot?: string;
  readonly projectName?: string;
  readonly workspaceState: Record<string, string | number | boolean | null>;
  readonly projectIntelligence: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly toolMetadata: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
}

const MAX_TREE_ENTRIES = 1200;
const MAX_READ_BYTES = 1024 * 1024;
const HIDDEN_NAMES = new Set([".git", ".aws", ".ssh", "node_modules", "vendor", "dist", "build"]);
const isSecretName = (name: string) =>
  /^\.env(?:\.|$)/i.test(name) ||
  /^(?:secrets?|credentials?)$/i.test(name) ||
  /\.(?:pem|key|p12|pfx)$/i.test(name);

function computeWorkspaceId(canonicalRoot: string): string {
  return `ws-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 20)}`;
}

function contained(root: string, relative: string): string {
  let decoded = relative;
  try {
    while (decoded.includes("%")) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    // Ignore decoding errors
  }

  if (
    relative.includes("\0") ||
    decoded.includes("\0") ||
    path.isAbsolute(relative) ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    path.isAbsolute(decoded) ||
    path.posix.isAbsolute(decoded) ||
    path.win32.isAbsolute(decoded) ||
    /^[A-Za-z]:/.test(relative) ||
    /^[A-Za-z]:/.test(decoded) ||
    relative.split(/[\\/]+/).includes("..") ||
    decoded.split(/[\\/]+/).includes("..") ||
    decoded.includes("..")
  ) {
    throw new PathEscapeForbiddenError("The requested path is outside this project.");
  }
  const target = path.resolve(root, relative);
  const fromRoot = path.relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new PathEscapeForbiddenError("The requested path is outside this project.");
  }
  return target;
}

export type WorkspaceEventListener = (event: {
  readonly type: "state" | "fs";
  readonly state?: WorkspaceState;
  readonly fsEvents?: readonly WorkspaceWatchEvent[];
}) => void;

export interface WorkspaceManagerOptions {
  readonly onBeforeSwitch?: (session: WorkspaceSession | null) => Promise<void> | void;
  readonly fileLockManager?: UnifiedFileLockService;
}

export class WorkspaceManager {
  private currentStatus: WorkspaceStatus = "EMPTY";
  private currentSession: WorkspaceSession | null = null;
  private currentWatcher: WorkspaceWatcher | null = null;
  private currentWatcherRoot: string | null = null;
  private readonly repo: WorkspaceRepository;
  private readonly listeners = new Set<WorkspaceEventListener>();
  private readonly fileLockService: UnifiedFileLockService;
  private readonly sessionRoots = new WeakMap<WorkspaceSession, { readonly dev: number; readonly ino: number }>();
  private readonly onBeforeSwitch?: (session: WorkspaceSession | null) => Promise<void> | void;

  constructor(
    repo: WorkspaceRepository,
    initialRoot?: string,
    options?: WorkspaceManagerOptions
  ) {
    this.repo = repo;
    this.onBeforeSwitch = options?.onBeforeSwitch;
    this.fileLockService = options?.fileLockManager ?? defaultFileLockManager;
    if (initialRoot) {
      try {
        const canonical = realpathSync(initialRoot);
        const meta = lstatSync(canonical);
        if (meta.isDirectory()) {
          const id = computeWorkspaceId(canonical);
          const name = path.basename(canonical);
          const existing = this.repo.findByPath(canonical);
          if (existing && existing.id !== id) {
            this.repo.rekeyWorkspace(existing.id, { ...existing, id, canonicalPath: canonical, displayName: name });
          }
          this.currentStatus = "OPEN";
          const session: WorkspaceSession = {
            workspaceId: id,
            canonicalRootPath: canonical,
            displayName: name,
            openedAt: Date.now(),
          };
          this.currentSession = session;
          this.sessionRoots.set(session, { dev: meta.dev, ino: meta.ino });
          this.repo.upsert({
            id,
            canonicalPath: canonical,
            displayName: name,
            createdAt: Date.now(),
            lastOpenedAt: Date.now(),
            availability: "available",
          });
          this.repo.setActiveWorkspaceId(id);
        }
      } catch {
        this.currentStatus = "EMPTY";
      }
    } else {
      this.restoreLastWorkspace();
    }
  }

  get state(): WorkspaceState {
    return {
      status: this.currentStatus,
      session: this.currentSession,
    };
  }

  get session(): WorkspaceSession | null {
    return this.currentSession;
  }

  get status(): WorkspaceStatus {
    return this.currentStatus;
  }

  isSessionValid(session: WorkspaceSession | null): session is WorkspaceSession {
    if (!session) return false;
    try {
      const canonical = realpathSync(session.canonicalRootPath);
      const metadata = lstatSync(canonical);
      const expectedRoot = this.sessionRoots.get(session);
      return canonical === session.canonicalRootPath && metadata.isDirectory() && Boolean(expectedRoot)
        && metadata.dev === expectedRoot?.dev && metadata.ino === expectedRoot?.ino
        && computeWorkspaceId(canonical) === session.workspaceId;
    } catch {
      return false;
    }
  }

  subscribe(listener: WorkspaceEventListener): () => void {
    this.listeners.add(listener);
    this.syncWatcher();
    return () => {
      if (this.listeners.delete(listener)) this.syncWatcher();
    };
  }

  private broadcastState(): void {
    const currentState = this.state;
    for (const listener of this.listeners) {
      try {
        listener({ type: "state", state: currentState });
      } catch (err) {
        console.error("Error in workspace listener:", err);
      }
    }
  }

  private broadcastFsEvents(events: readonly WorkspaceWatchEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener({ type: "fs", fsEvents: events });
      } catch (err) {
        console.error("Error in workspace fs listener:", err);
      }
    }
  }

  restoreLastWorkspace(): void {
    const lastActiveId = this.repo.getActiveWorkspaceId();
    if (!lastActiveId) {
      this.currentStatus = "EMPTY";
      this.currentSession = null;
      this.syncWatcher();
      return;
    }

    const saved = this.repo.get(lastActiveId);
    if (!saved) {
      this.currentStatus = "EMPTY";
      this.currentSession = null;
      this.repo.setActiveWorkspaceId(null);
      this.syncWatcher();
      return;
    }

    try {
      const stats = lstatSync(saved.canonicalPath);
      if (!stats.isDirectory()) {
        throw new Error("Not a directory");
      }

      const canonical = realpathSync(saved.canonicalPath);
      const canonicalStats = lstatSync(canonical);
      const workspaceId = computeWorkspaceId(canonical);
      const canonicalRecord: PersistedWorkspace = {
        ...saved,
        id: workspaceId,
        canonicalPath: canonical,
        displayName: path.basename(canonical),
      };
      if (saved.id !== workspaceId) this.repo.rekeyWorkspace(saved.id, canonicalRecord);
      else this.repo.upsert(canonicalRecord);

      this.currentSession = {
        workspaceId,
        canonicalRootPath: canonical,
        displayName: canonicalRecord.displayName,
        openedAt: saved.lastOpenedAt,
      };
      this.sessionRoots.set(this.currentSession, { dev: canonicalStats.dev, ino: canonicalStats.ino });
      this.currentStatus = "OPEN";
      this.repo.updateLastOpened(workspaceId);
      this.repo.setActiveWorkspaceId(workspaceId);
      this.syncWatcher();
    } catch {
      this.currentSession = {
        workspaceId: saved.id,
        canonicalRootPath: saved.canonicalPath,
        displayName: saved.displayName,
        openedAt: saved.lastOpenedAt,
      };
      this.currentStatus = "UNAVAILABLE";
      this.repo.setAvailability(saved.id, "unavailable");
      this.syncWatcher();
    }
  }

  async openWorkspace(targetPath: string): Promise<WorkspaceSession> {
    if (!targetPath || !targetPath.trim()) {
      throw new Error("Enter a local project folder path.");
    }

    // 1. Validate target path BEFORE modifying state or stopping watcher
    const canonical = await realpath(targetPath.trim());
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || canonical === path.parse(canonical).root) {
      throw new Error("Choose a project directory, not a filesystem root.");
    }

    const prevSession = this.currentSession;
    const prevStatus = this.currentStatus;

    if (this.currentSession) {
      this.currentStatus = "SWITCHING";
      this.broadcastState();
      this.stopWatcher();
      if (this.onBeforeSwitch) {
        try {
          await this.onBeforeSwitch(prevSession);
        } catch (err) {
          console.error("Error in onBeforeSwitch hook:", err);
        }
      }
    } else {
      this.currentStatus = "OPENING";
      this.broadcastState();
    }

    try {
      const id = computeWorkspaceId(canonical);
      const displayName = path.basename(canonical);
      const now = Date.now();

      const existing = this.repo.findByPath(canonical);
      if (existing && existing.id !== id) {
        this.repo.rekeyWorkspace(existing.id, { ...existing, id, canonicalPath: canonical, displayName });
      }

      const session: WorkspaceSession = {
        workspaceId: id,
        canonicalRootPath: canonical,
        displayName,
        openedAt: now,
      };
      this.sessionRoots.set(session, { dev: metadata.dev, ino: metadata.ino });

      // Persist to database
      this.repo.upsert({
        id,
        canonicalPath: canonical,
        displayName,
        createdAt: now,
        lastOpenedAt: now,
        availability: "available",
      });
      this.repo.setActiveWorkspaceId(id);

      this.currentSession = session;
      this.currentStatus = "OPEN";
      this.syncWatcher();
      this.broadcastState();

      return session;
    } catch (error) {
      this.currentSession = prevSession;
      this.currentStatus = prevStatus === "OPEN" && this.currentSession ? "OPEN" : "EMPTY";
      this.syncWatcher();
      this.broadcastState();
      throw error;
    }
  }

  closeWorkspace(): void {
    this.currentSession = null;
    this.currentStatus = "EMPTY";
    this.syncWatcher();
    this.repo.setActiveWorkspaceId(null);
    this.broadcastState();
  }

  dispose(): void {
    this.stopWatcher();
    this.listeners.clear();
  }

  private syncWatcher(): void {
    const session = this.currentStatus === "OPEN" ? this.currentSession : null;
    if (this.listeners.size > 0 && session && this.isSessionValid(session)) {
      this.startWatcher(session.canonicalRootPath);
    } else {
      this.stopWatcher();
    }
  }

  private startWatcher(rootPath: string): void {
    if (this.currentWatcher && this.currentWatcherRoot === rootPath) return;
    this.stopWatcher();
    this.currentWatcher = new WorkspaceWatcher(rootPath, (events) => {
      this.broadcastFsEvents(events);
    });
    this.currentWatcherRoot = rootPath;
  }

  private stopWatcher(): void {
    if (this.currentWatcher) {
      this.currentWatcher.close();
      this.currentWatcher = null;
      this.currentWatcherRoot = null;
    }
  }

  // --- UI State Management ---
  getUIState(): PersistedWorkspaceUIState | null {
    if (!this.currentSession) return null;
    return this.repo.getUIState(this.currentSession.workspaceId);
  }

  saveUIState(
    activeFile: string | null,
    openTabs: readonly { readonly path: string; readonly name: string }[],
    expandedPaths: readonly string[],
    workbenchTabs: readonly PersistedWorkbenchTab[] = [],
    activeWorkbenchTabId: string | null = null
  ): void {
    if (!this.currentSession) return;
    this.repo.saveUIState({
      workspaceId: this.currentSession.workspaceId,
      activeFile,
      openTabs,
      expandedPaths,
      updatedAt: Date.now(),
      workbenchTabs,
      activeWorkbenchTabId,
    });
  }

  async getProjectIntelligenceContext(
    session: WorkspaceSession | null = this.currentStatus === "OPEN" ? this.currentSession : null,
    options?: { readonly skipDeepDiscovery?: boolean },
  ): Promise<WorkspaceProjectIntelligence> {
    let canonicalRoot: string | undefined;
    let displayName: string | undefined;
    let workspaceId: string | null = null;
    let status = session ? "OPEN" as WorkspaceStatus : this.currentStatus;

    if (session) {
      if (this.isSessionValid(session)) {
        canonicalRoot = session.canonicalRootPath;
        displayName = session.displayName;
        workspaceId = session.workspaceId;
      } else {
        status = "UNAVAILABLE";
      }
    }

    if (!canonicalRoot || status !== "OPEN") {
      return {
        workspaceState: {
          workspaceId: null,
          rootPath: null,
          displayName: null,
          status,
          activeFile: null,
          openTabsCount: 0,
        },
        projectIntelligence: [
          { name: "workspace_status", value: `No active project workspace is open (status: ${status}).` },
        ],
        toolMetadata: [],
      };
    }

    const uiState = workspaceId ? this.repo.getUIState(workspaceId) : null;
    const activeFile = uiState?.activeFile ?? null;
    const openTabs = uiState?.openTabs ?? [];

    const workspaceState: Record<string, string | number | boolean | null> = {
      workspaceId,
      rootPath: canonicalRoot,
      displayName,
      status: "OPEN",
      activeFile,
      openTabsCount: openTabs.length,
    };

    let baseIntelligence: ReadonlyArray<{ readonly name: string; readonly value: string }> = [];
    if (!options?.skipDeepDiscovery) {
      try {
        baseIntelligence = await discoverProjectIntelligence(canonicalRoot, {
          activeFile: typeof activeFile === "string" ? activeFile : undefined,
          openTabs: openTabs.map((t) => t.path),
        });
      } catch {
        baseIntelligence = [];
      }
    }
    const projectIntelligence: Array<{ name: string; value: string }> = [...baseIntelligence];

    // Enrich with active editor file and open tabs if genuinely available and safe
    if (activeFile && typeof activeFile === "string" && !isSecretName(activeFile) && !isSensitiveDiscoveryName(activeFile)) {
      const content = await readWorkspaceFile(canonicalRoot, activeFile, MAX_READ_BYTES);
      if (content !== null && !content.includes("\0")) {
        const lines = content.split("\n");
        const head = lines.slice(0, 40).join("\n").slice(0, 1500);
        projectIntelligence.push({
          name: "active_editor_file",
          value: `File: ${activeFile} (${lines.length} lines)\n\n${head}`,
        });
      }
    }

    if (openTabs.length > 0) {
      const safeTabs = openTabs
        .map((tab) => tab.path)
        .filter((tabPath) => !isSecretName(tabPath) && !isSensitiveDiscoveryName(tabPath))
        .slice(0, 10);
      if (safeTabs.length > 0) {
        projectIntelligence.push({
          name: "open_editor_tabs",
          value: safeTabs.join(", "),
        });
      }
    }

    return {
      workspaceRoot: canonicalRoot,
      projectName: displayName,
      workspaceState,
      projectIntelligence,
      toolMetadata: DEFAULT_WORKSPACE_TOOL_METADATA,
    };
  }

  // --- Filesystem Access & Containment ---
  private requireRoot(): string {
    if (!this.currentSession || this.currentStatus !== "OPEN") {
      throw new Error("No active workspace is open.");
    }
    return this.currentSession.canonicalRootPath;
  }

  async listFiles(relativePath = ""): Promise<FileNode[]> {
    const root = this.requireRoot();
    const base = contained(root, relativePath);
    await this.assertNoSymlink(root, base);

    const baseStat = await lstat(base);
    if (!baseStat.isDirectory()) {
      throw new Error("The requested project path is not a directory.");
    }

    let total = 0;
    const visit = async (absolute: string, depth: number): Promise<FileNode[]> => {
      const result: FileNode[] = [];
      const directory = await opendir(absolute);
      for await (const entry of directory) {
        if (total >= MAX_TREE_ENTRIES) break;
        if (
          (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".agents") ||
          HIDDEN_NAMES.has(entry.name) ||
          isSecretName(entry.name) ||
          isOSMetadata(entry.name)
        ) {
          continue;
        }

        const entryPath = path.join(absolute, entry.name);
        const metadata = await lstat(entryPath);
        if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
          continue;
        }

        total += 1;
        const rel = path.relative(root, entryPath).split(path.sep).join("/");
        result.push(
          metadata.isDirectory()
            ? {
                name: entry.name,
                path: rel,
                type: "folder",
                ...(depth < 8 ? { children: await visit(entryPath, depth + 1) } : {}),
              }
            : { name: entry.name, path: rel, type: "file" }
        );
      }
      return result.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.type === "folder" ? -1 : 1
      );
    };

    return visit(base, 0);
  }

  async readFile(relativePath: string): Promise<string> {
    const root = this.requireRoot();
    const target = contained(root, relativePath);
    if (relativePath.split(/[\\/]+/).some(isSecretName)) {
      throw new Error("Credential and secret files are not available in the editor.");
    }
    await this.assertNoSymlink(root, target);

    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.nlink > 1) {
      throw new Error("Only regular project files can be opened.");
    }
    if (metadata.size > MAX_READ_BYTES) {
      throw new Error("The file exceeds the 1 MB preview limit.");
    }

    const content = await readFile(target, "utf8");
    if (content.includes("\0")) {
      throw new Error("Binary files are not supported in the text editor.");
    }
    return content;
  }

  async readFileVersioned(relativePath: string): Promise<{ content: string; hash: string }> {
    const content = await this.readFile(relativePath);
    const hash = createHash("sha256").update(content).digest("hex");
    return { content, hash };
  }

  async writeFile(relativePath: string, content: string, expectedHash: string): Promise<{ hash: string }> {
    const root = this.requireRoot();
    const target = contained(root, relativePath);
    if (!relativePath || relativePath.split(/[\\/]+/).some(isSecretName)) {
      throw new Error("Credential and secret files cannot be edited.");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES || content.includes("\0")) {
      throw new Error("Only text files up to 1 MB can be saved.");
    }
    await this.assertNoSymlink(root, target);

    return this.fileLockService.acquireWriteLock(target, expectedHash, async () => {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.nlink > 1) {
        throw new Error("Only regular project files can be edited.");
      }

      const current = await readFile(target);
      const currentHash = createHash("sha256").update(current).digest("hex");
      if (currentHash !== expectedHash && currentHash.slice(0, 16) !== expectedHash) {
        throw new Error("file-conflict");
      }

      const temporary = path.join(path.dirname(target), `.mediobot-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: metadata.mode & 0o777 });
        await rename(temporary, target);
      } catch (error) {
        const { unlink } = await import("node:fs/promises");
        await unlink(temporary).catch(() => undefined);
        throw error;
      }

      const newHash = createHash("sha256").update(content).digest("hex");
      globalOwnWriteRegistry.recordWrite(target, newHash, "editor");
      return { hash: newHash };
    });
  }

  async createEntry(parentPath: string, name: string, type: "file" | "folder"): Promise<void> {
    const root = this.requireRoot();
    const trimmed = name.trim();
    if (
      !trimmed ||
      trimmed === "." ||
      trimmed === ".." ||
      /[\\/\0]/.test(trimmed) ||
      trimmed.startsWith(".") ||
      isSecretName(trimmed)
    ) {
      throw new Error("Choose a safe file or folder name.");
    }

    const parent = contained(root, parentPath);
    await this.assertNoSymlink(root, parent);
    if (!(await lstat(parent)).isDirectory()) {
      throw new Error("The parent folder is unavailable.");
    }

    const target = contained(root, path.posix.join(parentPath, trimmed));
    await this.fileLockService.acquireWriteLock(target, undefined, async () => {
      await this.assertNoSymlink(root, parent);
      if (type === "folder") {
        await mkdir(target);
      } else {
        await writeFile(target, "", { flag: "wx", mode: 0o644 });
      }
    });
  }

  async renameEntry(relativePath: string, nextName: string): Promise<void> {
    const root = this.requireRoot();
    const parts = relativePath.split(/[\\/]+/);
    if (!relativePath || parts.some((part) => !part || part.startsWith(".") || isSecretName(part))) {
      throw new Error("This project item cannot be renamed.");
    }

    const trimmed = nextName.trim();
    if (
      !trimmed ||
      trimmed === "." ||
      trimmed === ".." ||
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed.includes("\0") ||
      trimmed.startsWith(".") ||
      isSecretName(trimmed)
    ) {
      throw new Error("Choose a safe new name.");
    }

    const source = contained(root, relativePath);
    const target = contained(root, path.relative(root, path.join(path.dirname(source), trimmed)));

    await this.fileLockService.acquireWriteLocks([source, target], async () => {
      await this.assertNoSymlink(root, source);
      await this.assertNoSymlink(root, path.dirname(source));
      const metadata = await lstat(source);
      if ((!metadata.isFile() && !metadata.isDirectory()) || (metadata.isFile() && metadata.nlink > 1)) {
        throw new Error("Only regular project files and folders can be renamed.");
      }
      try {
        await lstat(target);
        throw new Error("An item with that name already exists.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(source, target);
    });
  }

  async deleteEntry(relativePath: string): Promise<void> {
    const root = this.requireRoot();
    const parts = relativePath.split(/[\\/]+/);
    if (!relativePath || parts.some((part) => !part || part.startsWith(".") || isSecretName(part))) {
      throw new Error("This project item cannot be deleted.");
    }

    const target = contained(root, relativePath);
    await this.fileLockService.acquireWriteLock(target, undefined, async () => {
      await this.assertNoSymlink(root, target);
      const metadata = await lstat(target);
      if ((!metadata.isFile() && !metadata.isDirectory()) || (metadata.isFile() && metadata.nlink > 1)) {
        throw new Error("Only regular project files and folders can be deleted.");
      }
      await rm(target, { recursive: metadata.isDirectory(), force: false });
    });
  }

  private async assertNoSymlink(root: string, target: string): Promise<void> {
    let cursor = root;
    const relative = path.relative(root, target);
    for (const segment of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new PathEscapeForbiddenError("Symbolic links are not opened in the project preview.");
      }
    }
    try {
      const realTarget = await realpath(target);
      const canonicalRoot = await realpath(root);
      const rel = path.relative(canonicalRoot, realTarget);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new PathEscapeForbiddenError("The requested path is outside this project.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof PathEscapeForbiddenError) throw error;
    }
  }
}
