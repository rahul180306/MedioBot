import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isSensitiveName } from "@mediobot-v2/contracts";
import { WorkspaceScanner } from "./scanner.ts";
import { LanguageAdapterRegistry } from "./adapters/registry.ts";
import { SqliteStore } from "./store.ts";
import { ProjectFileWatcher } from "./watcher.ts";
import { RepoMapGenerator } from "./repomap.ts";
import type {
  ProjectIntelligenceEngine,
  ProjectIntelligenceOptions,
  IndexReport,
  SymbolResult,
  SearchOptions,
  FileDependencyGraph,
  ProjectMetadata,
  RepoMap,
  RepoMapOptions,
  FileRecord,
} from "./types.ts";

export class ProjectIntelligenceEngineImpl implements ProjectIntelligenceEngine {
  readonly workspaceRoot: string;
  private readonly dbPath: string;
  private readonly debounceMs: number;
  private readonly enableWatcher: boolean;

  private scanner: WorkspaceScanner | null = null;
  private registry: LanguageAdapterRegistry;
  private store: SqliteStore | null = null;
  private watcher: ProjectFileWatcher | null = null;
  private repoMapGen: RepoMapGenerator | null = null;
  private isInitialized = false;

  constructor(options: ProjectIntelligenceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.dbPath =
      options.dbPath ??
      path.join(options.workspaceRoot, ".mediobot", "cache", "project-intelligence.db");
    this.debounceMs = options.debounceMs ?? 150;
    this.enableWatcher = options.enableWatcher ?? false;
    this.registry = new LanguageAdapterRegistry(options.customAdapters);
  }

  async initialize(overrideWorkspaceRoot?: string): Promise<void> {
    if (this.isInitialized) return;

    const root = overrideWorkspaceRoot ?? this.workspaceRoot;
    this.scanner = new WorkspaceScanner(root);
    await this.scanner.init();

    this.store = new SqliteStore({ dbPath: this.dbPath });
    this.store.init();

    this.repoMapGen = new RepoMapGenerator(this.store);

    if (this.enableWatcher) {
      this.watcher = new ProjectFileWatcher(
        root,
        async (changedPaths) => {
          await this.incrementalUpdate(changedPaths);
        },
        this.debounceMs
      );
      await this.watcher.start();
    }

    this.isInitialized = true;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.store || !this.scanner) {
      throw new Error("ProjectIntelligenceEngine not initialized. Call initialize() first.");
    }
  }

  async fullIndex(signal?: AbortSignal): Promise<IndexReport> {
    this.ensureInitialized();
    const startMs = Date.now();
    const errors: Array<{ path: string; error: string }> = [];

    const discovered = await this.scanner!.scan();
    let filesIndexed = 0;
    let filesSkipped = 0;
    let symbolsExtracted = 0;
    let dependenciesTracked = 0;

    // Purge any sensitive files that may have been previously indexed in the store
    const existingIndexed = this.store!.listFiles();
    for (const f of existingIndexed) {
      if (isSensitiveName(f)) {
        this.store!.withTransaction(() => {
          this.store!.removeFile(f);
        });
      }
    }

    for (const file of discovered) {
      if (signal?.aborted) {
        break;
      }
      if (isSensitiveName(file.relativePath)) {
        continue;
      }

      try {
        const content = await readFile(file.absolutePath, "utf-8");
        const hash = createHash("sha256").update(content).digest("hex");

        const existing = this.store!.getFile(file.relativePath);
        if (existing && existing.contentHash === hash) {
          filesSkipped++;
          continue;
        }

        const parsed = await this.registry.parseFile(file.relativePath, content);

        if (parsed.errors.length > 0) {
          for (const err of parsed.errors) {
            errors.push({ path: file.relativePath, error: err });
          }
        }

        this.store!.withTransaction(() => {
          const fileId = this.store!.upsertFile({
            path: file.relativePath,
            language: parsed.language,
            contentHash: hash,
            sizeBytes: file.sizeBytes,
            lineCount: parsed.lineCount,
            indexedAt: Date.now(),
            isTest: file.isTest,
            isConfig: file.isConfig,
          });

          this.store!.clearFileSymbolsAndDeps(fileId);
          this.store!.insertSymbols(fileId, parsed.symbols);
          this.store!.insertDependencies(fileId, parsed.dependencies);
        });

        filesIndexed++;
        symbolsExtracted += parsed.symbols.length;
        dependenciesTracked += parsed.dependencies.length;
      } catch (err) {
        errors.push({
          path: file.relativePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Auto-discover and store manifest metadata
    await this.updateMetadataFromManifest();

    return {
      filesIndexed,
      filesSkipped,
      symbolsExtracted,
      dependenciesTracked,
      durationMs: Date.now() - startMs,
      errors,
    };
  }

  async incrementalUpdate(changedPaths: ReadonlyArray<string>): Promise<IndexReport> {
    this.ensureInitialized();
    const startMs = Date.now();
    const errors: Array<{ path: string; error: string }> = [];

    let filesIndexed = 0;
    let filesSkipped = 0;
    let symbolsExtracted = 0;
    let dependenciesTracked = 0;

    const canonicalRoot = this.scanner!.getCanonicalRoot();

    for (const relPath of changedPaths) {
      if (isSensitiveName(relPath)) {
        this.store!.withTransaction(() => {
          this.store!.removeFile(relPath);
        });
        filesIndexed++;
        continue;
      }

      const fullPath = path.join(canonicalRoot, relPath);

      let fileStat;
      try {
        fileStat = await stat(fullPath);
      } catch {
        // File does not exist anymore -> handle deletion
        this.store!.withTransaction(() => {
          this.store!.removeFile(relPath);
        });
        filesIndexed++;
        continue;
      }

      if (fileStat.isDirectory()) {
        continue;
      }

      try {
        const content = await readFile(fullPath, "utf-8");
        const hash = createHash("sha256").update(content).digest("hex");

        const existing = this.store!.getFile(relPath);
        if (existing && existing.contentHash === hash) {
          filesSkipped++;
          continue;
        }

        const isTest =
          relPath.includes(".test.") ||
          relPath.includes(".spec.") ||
          relPath.includes("__tests__");
        const isConfig =
          relPath.includes("config.") ||
          relPath.startsWith("tsconfig") ||
          relPath === "package.json";

        const parsed = await this.registry.parseFile(relPath, content);

        if (parsed.errors.length > 0) {
          for (const err of parsed.errors) {
            errors.push({ path: relPath, error: err });
          }
        }

        this.store!.withTransaction(() => {
          const fileId = this.store!.upsertFile({
            path: relPath,
            language: parsed.language,
            contentHash: hash,
            sizeBytes: fileStat.size,
            lineCount: parsed.lineCount,
            indexedAt: Date.now(),
            isTest,
            isConfig,
          });

          this.store!.clearFileSymbolsAndDeps(fileId);
          this.store!.insertSymbols(fileId, parsed.symbols);
          this.store!.insertDependencies(fileId, parsed.dependencies);
        });

        filesIndexed++;
        symbolsExtracted += parsed.symbols.length;
        dependenciesTracked += parsed.dependencies.length;
      } catch (err) {
        errors.push({
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      filesIndexed,
      filesSkipped,
      symbolsExtracted,
      dependenciesTracked,
      durationMs: Date.now() - startMs,
      errors,
    };
  }

  private async updateMetadataFromManifest(): Promise<void> {
    try {
      const pkgPath = path.join(this.scanner!.getCanonicalRoot(), "package.json");
      const pkgContent = await readFile(pkgPath, "utf-8").catch(() => null);
      if (pkgContent) {
        const parsed = JSON.parse(pkgContent);
        if (parsed.devDependencies || parsed.dependencies) {
          const deps = { ...parsed.dependencies, ...parsed.devDependencies };
          const frameworks: string[] = [];
          if (deps.react) frameworks.push("react");
          if (deps.vue) frameworks.push("vue");
          if (deps.next) frameworks.push("next");
          if (deps.vite) frameworks.push("vite");
          if (deps.express) frameworks.push("express");

          this.store!.setProjectMetadata("frameworks", JSON.stringify(frameworks));

          if (deps.vitest) this.store!.setProjectMetadata("test_framework", "vitest");
          else if (deps.jest) this.store!.setProjectMetadata("test_framework", "jest");
          else if (deps.mocha) this.store!.setProjectMetadata("test_framework", "mocha");
          else this.store!.setProjectMetadata("test_framework", "node:test");
        }

        if (parsed.packageManager) {
          this.store!.setProjectMetadata("package_manager", String(parsed.packageManager));
        } else {
          this.store!.setProjectMetadata("package_manager", "pnpm");
        }
      }
    } catch {
      // ignore
    }
  }

  async listFiles(): Promise<ReadonlyArray<string>> {
    this.ensureInitialized();
    return this.store!.listFiles();
  }

  async searchSymbols(query: string, options?: SearchOptions): Promise<ReadonlyArray<SymbolResult>> {
    this.ensureInitialized();
    return this.store!.searchSymbols(query, options);
  }

  async findSymbol(name: string): Promise<ReadonlyArray<SymbolResult>> {
    this.ensureInitialized();
    return this.store!.findSymbol(name);
  }

  async findExports(symbolOrFile: string): Promise<ReadonlyArray<SymbolResult>> {
    this.ensureInitialized();
    return this.store!.findExports(symbolOrFile);
  }

  async findImports(moduleSpecifier: string): Promise<ReadonlyArray<{
    readonly sourcePath: string;
    readonly specifier: string;
    readonly importedNames: ReadonlyArray<string>;
  }>> {
    this.ensureInitialized();
    return this.store!.findImports(moduleSpecifier);
  }

  async getFileSymbols(filePath: string): Promise<ReadonlyArray<SymbolResult>> {
    this.ensureInitialized();
    return this.store!.getFileSymbols(filePath);
  }

  async getFileDependencies(filePath: string): Promise<FileDependencyGraph> {
    this.ensureInitialized();
    return this.store!.getFileDependencies(filePath);
  }

  async getProjectMetadata(): Promise<ProjectMetadata> {
    this.ensureInitialized();
    return this.store!.getProjectMetadata();
  }

  async getChangedFiles(sinceTimestamp: number): Promise<ReadonlyArray<string>> {
    this.ensureInitialized();
    return this.store!.getChangedFiles(sinceTimestamp);
  }

  async getLastIndexedAt(): Promise<number | null> {
    this.ensureInitialized();
    return this.store!.getLastIndexedAt();
  }

  async getFile(filePath: string): Promise<FileRecord | null> {
    this.ensureInitialized();
    return this.store!.getFile(filePath);
  }

  async generateRepoMap(options?: RepoMapOptions): Promise<RepoMap> {
    this.ensureInitialized();
    return this.repoMapGen!.generate(options);
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.store) {
      this.store.close();
      this.store = null;
    }
    this.isInitialized = false;
  }
}

export async function discoverProjectIntelligenceSafe(
  workspaceRoot: string,
  legacyFallback: (root: string) => Promise<ReadonlyArray<{ name: string; value: string }>>,
  options?: { engine?: ProjectIntelligenceEngine }
): Promise<{
  readonly records: ReadonlyArray<{ name: string; value: string }>;
  readonly usedEngine: boolean;
  readonly error?: string;
}> {
  const { isProjectIntelligenceEnabled } = await import("./config.ts");
  if (!isProjectIntelligenceEnabled()) {
    const legacyRecords = await legacyFallback(workspaceRoot);
    return { records: legacyRecords, usedEngine: false };
  }

  let engine = options?.engine;
  let shouldDispose = false;

  try {
    if (!engine) {
      engine = new ProjectIntelligenceEngineImpl({ workspaceRoot });
      await engine.initialize();
      shouldDispose = true;
    }

    await engine.fullIndex();
    const repoMap = await engine.generateRepoMap({ maxTokens: 1500 });
    const meta = await engine.getProjectMetadata();

    const records: Array<{ name: string; value: string }> = [
      {
        name: "project_structure",
        value: repoMap.content.slice(0, 2000),
      },
      {
        name: "project_manifest",
        value: JSON.stringify({
          languages: meta.languages,
          frameworks: meta.frameworks,
          packageManager: meta.packageManager,
          totalFiles: meta.totalFiles,
          totalSymbols: meta.totalSymbols,
        }),
      },
    ];

    return { records, usedEngine: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[ProjectIntelligence] Engine failed, falling back to legacy discovery: ${errorMsg}`);
    const legacyRecords = await legacyFallback(workspaceRoot);
    return { records: legacyRecords, usedEngine: false, error: errorMsg };
  } finally {
    if (shouldDispose && engine) {
      await engine.dispose().catch(() => {});
    }
  }
}

