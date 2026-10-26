import type { SymbolKind, SymbolDefinition, IndexReport } from "@mediobot-v2/contracts";

export type { SymbolKind, SymbolDefinition, IndexReport };

export interface ExtractedSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly character: number;
  readonly signature?: string;
  readonly isExported: boolean;
  readonly parentSymbolId?: number;
  readonly docComment?: string;
}

export interface ExtractedDependency {
  readonly importPath: string;
  readonly importedNames: ReadonlyArray<string>;
  readonly isTypeOnly: boolean;
  readonly resolvedPath?: string;
}

export interface ParsedFile {
  readonly filePath: string;
  readonly language: string;
  readonly lineCount: number;
  readonly symbols: ReadonlyArray<ExtractedSymbol>;
  readonly dependencies: ReadonlyArray<ExtractedDependency>;
  readonly errors: ReadonlyArray<string>;
}

export interface LanguageAdapter {
  readonly name: string;
  readonly fileExtensions: ReadonlyArray<string>;
  canParse(filePath: string): boolean;
  parse(filePath: string, content: string): Promise<ParsedFile> | ParsedFile;
}

export interface FileRecord {
  readonly fileId?: number;
  readonly path: string;
  readonly language: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly indexedAt: number;
  readonly isTest: boolean;
  readonly isConfig: boolean;
}

export interface SymbolResult {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly character: number;
  readonly signature?: string;
  readonly isExported: boolean;
  readonly docComment?: string;
}

export interface FileDependencyGraph {
  readonly filePath: string;
  readonly imports: ReadonlyArray<{
    readonly path: string;
    readonly names: ReadonlyArray<string>;
    readonly isTypeOnly: boolean;
  }>;
  readonly importedBy: ReadonlyArray<{
    readonly path: string;
    readonly names: ReadonlyArray<string>;
    readonly isTypeOnly: boolean;
  }>;
}

export interface ProjectMetadata {
  readonly languages: ReadonlyArray<string>;
  readonly frameworks: ReadonlyArray<string>;
  readonly packageManager: string | null;
  readonly testFramework: string | null;
  readonly totalFiles: number;
  readonly totalSymbols: number;
}

export interface SearchOptions {
  readonly maxResults?: number;
  readonly kinds?: ReadonlyArray<SymbolKind>;
  readonly exportedOnly?: boolean;
}

export interface RepoMapOptions {
  readonly maxTokens?: number;
  readonly focusPaths?: ReadonlyArray<string>;
  readonly focusSymbols?: ReadonlyArray<string>;
  readonly includeSignatures?: boolean;
}

export interface RepoMap {
  readonly content: string;
  readonly estimatedTokens: number;
  readonly filesIncluded: number;
  readonly generationMs: number;
}

export interface ProjectIntelligenceOptions {
  readonly workspaceRoot: string;
  readonly dbPath?: string;
  readonly debounceMs?: number;
  readonly enableWatcher?: boolean;
  readonly customAdapters?: ReadonlyArray<LanguageAdapter>;
}

export interface ProjectIntelligenceEngine {
  readonly workspaceRoot: string;
  initialize(workspaceRoot?: string): Promise<void>;
  fullIndex(signal?: AbortSignal): Promise<IndexReport>;
  incrementalUpdate(changedPaths: ReadonlyArray<string>): Promise<IndexReport>;
  listFiles(): Promise<ReadonlyArray<string>>;
  searchSymbols(query: string, options?: SearchOptions): Promise<ReadonlyArray<SymbolResult>>;
  findSymbol(name: string): Promise<ReadonlyArray<SymbolResult>>;
  findExports(symbolOrFile: string): Promise<ReadonlyArray<SymbolResult>>;
  findImports(moduleSpecifier: string): Promise<ReadonlyArray<{
    readonly sourcePath: string;
    readonly specifier: string;
    readonly importedNames: ReadonlyArray<string>;
  }>>;
  getFileSymbols(filePath: string): Promise<ReadonlyArray<SymbolResult>>;
  getFileDependencies(filePath: string): Promise<FileDependencyGraph>;
  getProjectMetadata(): Promise<ProjectMetadata>;
  getChangedFiles(sinceTimestamp: number): Promise<ReadonlyArray<string>>;
  getLastIndexedAt(): Promise<number | null>;
  getFile(filePath: string): Promise<FileRecord | null>;
  generateRepoMap(options?: RepoMapOptions): Promise<RepoMap>;
  dispose(): Promise<void>;
}
