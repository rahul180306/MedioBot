import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { isSensitiveName } from "@mediobot-v2/contracts";
import type {
  FileRecord,
  ExtractedSymbol,
  ExtractedDependency,
  SymbolResult,
  FileDependencyGraph,
  ProjectMetadata,
  SearchOptions,
  SymbolKind,
} from "./types.ts";

export interface SqliteStoreOptions {
  readonly dbPath: string;
}

export class SqliteStore {
  private db: DatabaseSync | null = null;
  readonly dbPath: string;

  constructor(options: SqliteStoreOptions) {
    this.dbPath = options.dbPath;
  }

  init(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Attempt to open and verify database integrity
    try {
      this.openDatabase();
      this.verifyIntegrity();
    } catch (err) {
      console.warn(`[SqliteStore] Database corruption or error detected at ${this.dbPath}. Quarantining and recreating:`, err);
      this.quarantineAndRecreate();
    }

    this.runMigrations();
  }

  private openDatabase(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  private verifyIntegrity(): void {
    if (!this.db) throw new Error("Database not open");
    const stmt = this.db.prepare("PRAGMA integrity_check;");
    const rows = stmt.all() as unknown as ReadonlyArray<Record<string, unknown>>;
    const firstRow = rows[0];
    const checkResult = firstRow ? Object.values(firstRow)[0] : null;
    if (checkResult !== "ok") {
      throw new Error(`SQLite integrity check failed: ${String(checkResult)}`);
    }
  }

  private quarantineAndRecreate(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }

    if (fs.existsSync(this.dbPath)) {
      const corruptPath = `${this.dbPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.dbPath, corruptPath);
        // Also move WAL/SHM if they exist
        if (fs.existsSync(`${this.dbPath}-wal`)) {
          fs.renameSync(`${this.dbPath}-wal`, `${corruptPath}-wal`);
        }
        if (fs.existsSync(`${this.dbPath}-shm`)) {
          fs.renameSync(`${this.dbPath}-shm`, `${corruptPath}-shm`);
        }
      } catch (renameErr) {
        console.error(`[SqliteStore] Failed to quarantine corrupt database:`, renameErr);
      }
    }

    this.openDatabase();
  }

  private runMigrations(): void {
    if (!this.db) throw new Error("Database not initialized");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        language TEXT,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        is_test INTEGER NOT NULL DEFAULT 0,
        is_config INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS symbols (
        symbol_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        character INTEGER NOT NULL DEFAULT 0,
        is_exported INTEGER NOT NULL DEFAULT 0,
        parent_symbol_id INTEGER REFERENCES symbols(symbol_id) ON DELETE CASCADE,
        doc_comment TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name,
        signature,
        doc_comment,
        content=symbols,
        content_rowid=symbol_id,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        dep_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
        target_file INTEGER REFERENCES files(file_id) ON DELETE SET NULL,
        import_path TEXT NOT NULL,
        imported_names TEXT NOT NULL DEFAULT '[]',
        is_type_only INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_deps_source ON dependencies(source_file);
      CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_file);

      CREATE TABLE IF NOT EXISTS project_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS symbols_fts_insert AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name, signature, doc_comment)
        VALUES (new.symbol_id, new.name, new.signature, new.doc_comment);
      END;

      CREATE TRIGGER IF NOT EXISTS symbols_fts_delete AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, doc_comment)
        VALUES ('delete', old.symbol_id, old.name, old.signature, old.doc_comment);
      END;

      CREATE TRIGGER IF NOT EXISTS symbols_fts_update AFTER UPDATE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name, signature, doc_comment)
        VALUES ('delete', old.symbol_id, old.name, old.signature, old.doc_comment);
        INSERT INTO symbols_fts(rowid, name, signature, doc_comment)
        VALUES (new.symbol_id, new.name, new.signature, new.doc_comment);
      END;
    `);

    // Record schema version 1
    const stmt = this.db.prepare("SELECT version FROM schema_version WHERE version = 1;");
    const existing = stmt.get() as unknown as { version: number } | undefined;
    if (!existing) {
      this.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?);").run(Date.now());
    }
  }

  withTransaction<T>(fn: () => T): T {
    if (!this.db) throw new Error("Database not initialized");
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  getFile(relativePath: string): FileRecord | null {
    if (!this.db) throw new Error("Database not initialized");
    if (isSensitiveName(relativePath)) return null;
    const stmt = this.db.prepare(`
      SELECT file_id as fileId, path, language, content_hash as contentHash,
             size_bytes as sizeBytes, line_count as lineCount, indexed_at as indexedAt,
             is_test as isTest, is_config as isConfig
      FROM files WHERE path = ?;
    `);
    interface DbFileRow {
      fileId: number;
      path: string;
      language: string;
      contentHash: string;
      sizeBytes: number;
      lineCount: number;
      indexedAt: number;
      isTest: number;
      isConfig: number;
    }
    const row = stmt.get(relativePath) as unknown as DbFileRow | undefined;
    if (!row) return null;
    return {
      fileId: row.fileId,
      path: row.path,
      language: row.language,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      lineCount: row.lineCount,
      indexedAt: row.indexedAt,
      isTest: Boolean(row.isTest),
      isConfig: Boolean(row.isConfig),
    };
  }

  upsertFile(file: FileRecord): number {
    if (!this.db) throw new Error("Database not initialized");
    if (isSensitiveName(file.path)) return -1;
    const stmt = this.db.prepare(`
      INSERT INTO files (path, language, content_hash, size_bytes, line_count, indexed_at, is_test, is_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        line_count = excluded.line_count,
        indexed_at = excluded.indexed_at,
        is_test = excluded.is_test,
        is_config = excluded.is_config
      RETURNING file_id;
    `);
    const result = stmt.get(
      file.path,
      file.language,
      file.contentHash,
      file.sizeBytes,
      file.lineCount,
      file.indexedAt,
      file.isTest ? 1 : 0,
      file.isConfig ? 1 : 0
    ) as unknown as { file_id: number };
    return result.file_id;
  }

  removeFile(relativePath: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    const stmt = this.db.prepare("DELETE FROM files WHERE path = ?;");
    const res = stmt.run(relativePath);
    return Number(res.changes) > 0;
  }

  clearFileSymbolsAndDeps(fileId: number): void {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare("DELETE FROM symbols WHERE file_id = ?;").run(fileId);
    this.db.prepare("DELETE FROM dependencies WHERE source_file = ?;").run(fileId);
  }

  insertSymbols(fileId: number, symbols: ReadonlyArray<ExtractedSymbol>): void {
    if (!this.db || symbols.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line, character, is_exported, parent_symbol_id, doc_comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const sym of symbols) {
      stmt.run(
        fileId,
        sym.name,
        sym.kind,
        sym.signature ?? null,
        sym.startLine,
        sym.endLine,
        sym.character,
        sym.isExported ? 1 : 0,
        sym.parentSymbolId ?? null,
        sym.docComment ?? null
      );
    }
  }

  insertDependencies(fileId: number, dependencies: ReadonlyArray<ExtractedDependency>): void {
    if (!this.db || dependencies.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO dependencies (source_file, target_file, import_path, imported_names, is_type_only)
      VALUES (?, (SELECT file_id FROM files WHERE path = ?), ?, ?, ?);
    `);
    for (const dep of dependencies) {
      stmt.run(
        fileId,
        dep.resolvedPath ?? null,
        dep.importPath,
        JSON.stringify(dep.importedNames),
        dep.isTypeOnly ? 1 : 0
      );
    }
  }

  listFiles(): ReadonlyArray<string> {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare("SELECT path FROM files ORDER BY path ASC;").all() as unknown as ReadonlyArray<{ path: string }>;
    return rows.map((r) => r.path).filter((p) => !isSensitiveName(p));
  }

  findSymbol(name: string): ReadonlyArray<SymbolResult> {
    if (!this.db) throw new Error("Database not initialized");
    const stmt = this.db.prepare(`
      SELECT s.name, s.kind, f.path as filePath, s.start_line as startLine, s.end_line as endLine,
             s.character, s.signature, s.is_exported as isExported, s.doc_comment as docComment
      FROM symbols s
      JOIN files f ON s.file_id = f.file_id
      WHERE s.name = ?
      ORDER BY s.is_exported DESC, f.path ASC;
    `);
    const rows = stmt.all(name) as unknown as ReadonlyArray<{
      name: string;
      kind: SymbolKind;
      filePath: string;
      startLine: number;
      endLine: number;
      character: number;
      signature: string | null;
      isExported: number;
      docComment: string | null;
    }>;
    return rows
      .filter((r) => !isSensitiveName(r.filePath))
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        character: r.character,
        signature: r.signature ?? undefined,
        isExported: Boolean(r.isExported),
        docComment: r.docComment ?? undefined,
      }));
  }

  searchSymbols(query: string, options?: SearchOptions): ReadonlyArray<SymbolResult> {
    if (!this.db) throw new Error("Database not initialized");
    const limit = options?.maxResults ?? 20;

    // Sanitize query for FTS5 (escape quotes and remove boolean keywords if bare)
    const sanitizedQuery = query.replace(/[^\w\s_-]/g, " ").trim();
    if (!sanitizedQuery) {
      return [];
    }

    // Try FTS5 MATCH first
    try {
      const ftsToken = sanitizedQuery
        .split(/\s+/)
        .map((t) => `"${t}"*`)
        .join(" ");

      const sql = `
        SELECT s.name, s.kind, f.path as filePath, s.start_line as startLine, s.end_line as endLine,
               s.character, s.signature, s.is_exported as isExported, s.doc_comment as docComment
        FROM symbols_fts fts
        JOIN symbols s ON fts.rowid = s.symbol_id
        JOIN files f ON s.file_id = f.file_id
        WHERE symbols_fts MATCH ?
        ${options?.exportedOnly ? "AND s.is_exported = 1" : ""}
        ${options?.kinds && options.kinds.length > 0 ? `AND s.kind IN (${options.kinds.map(() => "?").join(",")})` : ""}
        LIMIT ?;
      `;

      const params: (string | number)[] = [ftsToken];
      if (options?.kinds && options.kinds.length > 0) {
        params.push(...options.kinds);
      }
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as unknown as ReadonlyArray<{
        name: string;
        kind: SymbolKind;
        filePath: string;
        startLine: number;
        endLine: number;
        character: number;
        signature: string | null;
        isExported: number;
        docComment: string | null;
      }>;

      if (rows.length > 0) {
        return rows
          .filter((r) => !isSensitiveName(r.filePath))
          .map((r) => ({
            name: r.name,
            kind: r.kind,
            filePath: r.filePath,
            startLine: r.startLine,
            endLine: r.endLine,
            character: r.character,
            signature: r.signature ?? undefined,
            isExported: Boolean(r.isExported),
            docComment: r.docComment ?? undefined,
          }));
      }
    } catch {
      // Fallback to LIKE query on error
    }

    // Fallback: LIKE query
    const likeSql = `
      SELECT s.name, s.kind, f.path as filePath, s.start_line as startLine, s.end_line as endLine,
             s.character, s.signature, s.is_exported as isExported, s.doc_comment as docComment
      FROM symbols s
      JOIN files f ON s.file_id = f.file_id
      WHERE (s.name LIKE ? OR s.signature LIKE ?)
      ${options?.exportedOnly ? "AND s.is_exported = 1" : ""}
      ${options?.kinds && options.kinds.length > 0 ? `AND s.kind IN (${options.kinds.map(() => "?").join(",")})` : ""}
      ORDER BY s.is_exported DESC
      LIMIT ?;
    `;
    const likePattern = `%${sanitizedQuery}%`;
    const likeParams: (string | number)[] = [likePattern, likePattern];
    if (options?.kinds && options.kinds.length > 0) {
      likeParams.push(...options.kinds);
    }
    likeParams.push(limit);

    const rows = this.db.prepare(likeSql).all(...likeParams) as unknown as ReadonlyArray<{
      name: string;
      kind: SymbolKind;
      filePath: string;
      startLine: number;
      endLine: number;
      character: number;
      signature: string | null;
      isExported: number;
      docComment: string | null;
    }>;

    return rows
      .filter((r) => !isSensitiveName(r.filePath))
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        character: r.character,
        signature: r.signature ?? undefined,
        isExported: Boolean(r.isExported),
        docComment: r.docComment ?? undefined,
      }));
  }

  findExports(symbolOrFile: string): ReadonlyArray<SymbolResult> {
    if (!this.db) throw new Error("Database not initialized");
    if (isSensitiveName(symbolOrFile)) return [];
    // If it looks like a file path
    const isPath = symbolOrFile.includes("/") || symbolOrFile.includes(".");
    const sql = isPath
      ? `
        SELECT s.name, s.kind, f.path as filePath, s.start_line as startLine, s.end_line as endLine,
               s.character, s.signature, s.is_exported as isExported, s.doc_comment as docComment
        FROM symbols s
        JOIN files f ON s.file_id = f.file_id
        WHERE f.path = ? AND s.is_exported = 1
        ORDER BY s.start_line ASC;
      `
      : `
        SELECT s.name, s.kind, f.path as filePath, s.start_line as startLine, s.end_line as endLine,
               s.character, s.signature, s.is_exported as isExported, s.doc_comment as docComment
        FROM symbols s
        JOIN files f ON s.file_id = f.file_id
        WHERE s.name = ? AND s.is_exported = 1
        ORDER BY f.path ASC;
      `;

    const rows = this.db.prepare(sql).all(symbolOrFile) as unknown as ReadonlyArray<{
      name: string;
      kind: SymbolKind;
      filePath: string;
      startLine: number;
      endLine: number;
      character: number;
      signature: string | null;
      isExported: number;
      docComment: string | null;
    }>;

    return rows
      .filter((r) => !isSensitiveName(r.filePath))
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        character: r.character,
        signature: r.signature ?? undefined,
        isExported: Boolean(r.isExported),
        docComment: r.docComment ?? undefined,
      }));
  }

  findImports(moduleSpecifier: string): ReadonlyArray<{
    readonly sourcePath: string;
    readonly specifier: string;
    readonly importedNames: ReadonlyArray<string>;
  }> {
    if (!this.db) throw new Error("Database not initialized");
    if (isSensitiveName(moduleSpecifier)) return [];
    const stmt = this.db.prepare(`
      SELECT f.path as sourcePath, d.import_path as specifier, d.imported_names as importedNamesJson
      FROM dependencies d
      JOIN files f ON d.source_file = f.file_id
      WHERE d.import_path = ? OR d.import_path LIKE ?
      ORDER BY f.path ASC;
    `);
    const likePattern = `%${moduleSpecifier}%`;
    const rows = stmt.all(moduleSpecifier, likePattern) as unknown as ReadonlyArray<{
      sourcePath: string;
      specifier: string;
      importedNamesJson: string;
    }>;

    return rows
      .filter((r) => !isSensitiveName(r.sourcePath) && !isSensitiveName(r.specifier))
      .map((r) => {
        let importedNames: string[] = [];
        try {
          importedNames = JSON.parse(r.importedNamesJson);
        } catch {
          // ignore
        }
        return {
          sourcePath: r.sourcePath,
          specifier: r.specifier,
          importedNames,
        };
      });
  }

  getFileSymbols(filePath: string): ReadonlyArray<SymbolResult> {
    if (!this.db) throw new Error("Database not initialized");
    if (isSensitiveName(filePath)) return [];
    const stmt = this.db.prepare(`
      SELECT s.name, s.kind, f.path as filePath, s.start_line as startLine, s.end_line as endLine,
             s.character, s.signature, s.is_exported as isExported, s.doc_comment as docComment
      FROM symbols s
      JOIN files f ON s.file_id = f.file_id
      WHERE f.path = ?
      ORDER BY s.start_line ASC;
    `);
    const rows = stmt.all(filePath) as unknown as ReadonlyArray<{
      name: string;
      kind: SymbolKind;
      filePath: string;
      startLine: number;
      endLine: number;
      character: number;
      signature: string | null;
      isExported: number;
      docComment: string | null;
    }>;

    return rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      filePath: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      character: r.character,
      signature: r.signature ?? undefined,
      isExported: Boolean(r.isExported),
      docComment: r.docComment ?? undefined,
    }));
  }

  getFileDependencies(filePath: string): FileDependencyGraph {
    if (!this.db) throw new Error("Database not initialized");
    if (isSensitiveName(filePath)) {
      return {
        filePath,
        imports: [],
        importedBy: [],
      };
    }
    // Outgoing imports
    const outgoingStmt = this.db.prepare(`
      SELECT d.import_path as path, d.imported_names as namesJson, d.is_type_only as isTypeOnly
      FROM dependencies d
      JOIN files f ON d.source_file = f.file_id
      WHERE f.path = ?;
    `);
    const outgoingRows = outgoingStmt.all(filePath) as unknown as ReadonlyArray<{
      path: string;
      namesJson: string;
      isTypeOnly: number;
    }>;

    const imports = outgoingRows
      .filter((r) => !isSensitiveName(r.path))
      .map((r) => {
        let names: string[] = [];
        try {
          names = JSON.parse(r.namesJson);
        } catch {
          // ignore
        }
        return {
          path: r.path,
          names,
          isTypeOnly: Boolean(r.isTypeOnly),
        };
      });

    // Incoming imports (importedBy)
    const incomingStmt = this.db.prepare(`
      SELECT f.path as sourcePath, d.imported_names as namesJson, d.is_type_only as isTypeOnly
      FROM dependencies d
      JOIN files f ON d.source_file = f.file_id
      WHERE d.target_file = (SELECT file_id FROM files WHERE path = ?)
         OR d.import_path LIKE ?;
    `);
    const incomingRows = incomingStmt.all(filePath, `%${path.basename(filePath, path.extname(filePath))}%`) as unknown as ReadonlyArray<{
      sourcePath: string;
      namesJson: string;
      isTypeOnly: number;
    }>;

    const importedBy = incomingRows
      .filter((r) => !isSensitiveName(r.sourcePath))
      .map((r) => {
        let names: string[] = [];
        try {
          names = JSON.parse(r.namesJson);
        } catch {
          // ignore
        }
        return {
          path: r.sourcePath,
          names,
          isTypeOnly: Boolean(r.isTypeOnly),
        };
      });

    return {
      filePath,
      imports,
      importedBy,
    };
  }

  getChangedFiles(sinceTimestamp: number): ReadonlyArray<string> {
    if (!this.db) throw new Error("Database not initialized");
    const stmt = this.db.prepare("SELECT path FROM files WHERE indexed_at >= ? ORDER BY path ASC;");
    const rows = stmt.all(sinceTimestamp) as unknown as ReadonlyArray<{ path: string }>;
    return rows.map((r) => r.path).filter((p) => !isSensitiveName(p));
  }

  getLastIndexedAt(): number | null {
    if (!this.db) throw new Error("Database not initialized");
    const row = this.db.prepare("SELECT MAX(indexed_at) as maxIndexedAt FROM files;").get() as unknown as { maxIndexedAt: number | null } | undefined;
    return row?.maxIndexedAt ?? null;
  }

  getProjectMetadata(): ProjectMetadata {
    if (!this.db) throw new Error("Database not initialized");

    const fileCountRow = this.db.prepare("SELECT COUNT(*) as count FROM files;").get() as unknown as { count: number };
    const symCountRow = this.db.prepare("SELECT COUNT(*) as count FROM symbols;").get() as unknown as { count: number };

    const langRows = this.db.prepare(`
      SELECT DISTINCT language FROM files WHERE language IS NOT NULL AND language != 'unknown';
    `).all() as unknown as ReadonlyArray<{ language: string }>;

    const metaRows = this.db.prepare("SELECT key, value FROM project_metadata;").all() as unknown as ReadonlyArray<{
      key: string;
      value: string;
    }>;

    const metaMap = new Map<string, string>();
    for (const r of metaRows) {
      metaMap.set(r.key, r.value);
    }

    let frameworks: string[] = [];
    try {
      if (metaMap.has("frameworks")) {
        frameworks = JSON.parse(metaMap.get("frameworks")!);
      }
    } catch {
      // ignore
    }

    return {
      languages: langRows.map((r) => r.language),
      frameworks,
      packageManager: metaMap.get("package_manager") ?? null,
      testFramework: metaMap.get("test_framework") ?? null,
      totalFiles: fileCountRow.count,
      totalSymbols: symCountRow.count,
    };
  }

  setProjectMetadata(key: string, value: string): void {
    if (!this.db) throw new Error("Database not initialized");
    const stmt = this.db.prepare(`
      INSERT INTO project_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `);
    stmt.run(key, value, Date.now());
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }
  }
}
