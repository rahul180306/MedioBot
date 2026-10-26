import { realpath, lstat, stat } from "node:fs/promises";
import path from "node:path";
import {
  isSensitiveName,
  type SharedProjectContext,
  type ProjectFileContext,
  type ProjectSymbolContext,
  type ProjectDependencyContext,
  type ProjectContextBudget,
  type ProjectContextFreshness,
  type ProjectContextDiagnostics,
} from "@mediobot-v2/contracts";
import type {
  ProjectIntelligenceEngine,
  SymbolResult,
  FileDependencyGraph,
} from "./types.ts";

export interface ProjectRetrievalBudget {
  readonly maxTokens?: number;
  readonly repoMapTokens?: number;
  readonly maxSymbols?: number;
  readonly maxFiles?: number;
  readonly maxDependencies?: number;
}

export interface ProjectRetrievalOptions {
  readonly workspaceId?: string | null;
  readonly focusFiles?: ReadonlyArray<string>;
  readonly budget?: ProjectRetrievalBudget;
  readonly signal?: AbortSignal;
  readonly bypassFreshnessCheck?: boolean;
}

export function isSensitiveFileName(filePath: string): boolean {
  return isSensitiveName(filePath);
}

/** Extract query search tokens for exact and lexical symbol discovery. */
export function extractQueryTokens(query?: string): ReadonlyArray<string> {
  if (!query || typeof query !== "string") return [];
  const rawWords = query
    .split(/[\s,.;:!?()[\]{}"'`<>=+\-*/\\|]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w));

  const stopWords = new Set([
    "the", "and", "for", "with", "from", "that", "this", "what", "where",
    "how", "can", "should", "does", "have", "been", "file", "code", "find",
    "check", "show", "read", "write", "test", "todo", "make", "create", "update",
  ]);

  const unique = new Set<string>();
  for (const word of rawWords) {
    if (!stopWords.has(word.toLowerCase())) {
      unique.add(word);
    }
  }
  return Array.from(unique);
}

/**
 * Retrieve bounded, relevance-ranked, freshness-checked project context from PIE.
 */
export async function retrieveProjectContext(
  engine: ProjectIntelligenceEngine,
  workspaceRoot: string,
  query?: string,
  options?: ProjectRetrievalOptions
): Promise<SharedProjectContext> {
  const startMs = Date.now();
  const errors: string[] = [];

  // 1. Workspace authorization verification
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw new Error("Invalid workspace root provided for project context retrieval.");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
  } catch (err) {
    throw new Error(`Workspace root does not exist or cannot be resolved: ${workspaceRoot}`);
  }

  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${canonicalRoot}`);
  }

  // Budget defaults
  const maxTokens = options?.budget?.maxTokens ?? 3000;
  const repoMapTokens = options?.budget?.repoMapTokens ?? 1200;
  const maxSymbolsLimit = options?.budget?.maxSymbols ?? 25;
  const maxFilesLimit = options?.budget?.maxFiles ?? 20;
  const maxDepsLimit = options?.budget?.maxDependencies ?? 20;

  // 2. Index readiness check
  let lastIndexedAt = await engine.getLastIndexedAt();
  if (lastIndexedAt === null) {
    // Cold index: perform initial full index
    try {
      await engine.fullIndex(options?.signal);
      lastIndexedAt = await engine.getLastIndexedAt();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Cold indexing failure: ${msg}`);
    }
  }

  // 3. Freshness check
  const staleFiles: string[] = [];
  const focusFiles = (options?.focusFiles ?? [])
    .filter((f) => Boolean(f) && !isSensitiveFileName(f));

  let freshness: ProjectContextFreshness;
  if (!options?.bypassFreshnessCheck) {
    for (const relPath of focusFiles) {
      if (options?.signal?.aborted) break;
      const fullPath = path.join(canonicalRoot, relPath);
      try {
        const fileStat = await stat(fullPath);
        const indexedFile = await engine.getFile(relPath);
        if (!indexedFile || fileStat.mtimeMs > indexedFile.indexedAt) {
          staleFiles.push(relPath);
        }
      } catch {
        // File on disk no longer exists -> stale
        const indexedFile = await engine.getFile(relPath);
        if (indexedFile) {
          staleFiles.push(relPath);
        }
      }
    }

    let refreshed = false;
    if (staleFiles.length > 0) {
      try {
        const report = await engine.incrementalUpdate(staleFiles);
        if (report.errors.length === 0) {
          refreshed = true;
        } else {
          for (const err of report.errors) {
            errors.push(`Freshness update error on ${err.path}: ${err.error}`);
          }
        }
        lastIndexedAt = (await engine.getLastIndexedAt()) ?? Date.now();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Freshness update failure: ${msg}`);
      }
    }

    freshness = {
      isFresh: staleFiles.length === 0 || refreshed,
      lastIndexedAt: lastIndexedAt ?? Date.now(),
      checkedAt: Date.now(),
      staleFiles: refreshed ? [] : staleFiles,
    };
  } else {
    freshness = {
      isFresh: true,
      lastIndexedAt: lastIndexedAt ?? Date.now(),
      checkedAt: Date.now(),
      staleFiles: [],
    };
  }

  // 4. Deterministic and relevance-based retrieval
  const queryTokens = extractQueryTokens(query);
  const scoredSymbols = new Map<string, { symbol: SymbolResult; score: number }>();
  const relevantFiles = new Set<string>();
  const relevantDependencies: ProjectDependencyContext[] = [];

  let usedExact = false;
  let usedFts5 = false;

  // A. Exact Symbol Lookup
  for (const token of queryTokens) {
    if (options?.signal?.aborted) break;
    try {
      const exactResults = await engine.findSymbol(token);
      if (exactResults.length > 0) {
        usedExact = true;
        for (const sym of exactResults) {
          if (isSensitiveFileName(sym.filePath)) continue;
          const key = `${sym.filePath}:${sym.name}:${sym.startLine}`;
          const current = scoredSymbols.get(key);
          const score = (current?.score ?? 0) + (sym.isExported ? 12 : 10);
          scoredSymbols.set(key, { symbol: sym, score });
          relevantFiles.add(sym.filePath);
        }
      }
    } catch (err) {
      errors.push(`Exact symbol lookup error for "${token}": ${String(err)}`);
    }
  }

  // B. Filename matches
  let allFiles: ReadonlyArray<string> = [];
  try {
    allFiles = await engine.listFiles();
  } catch (err) {
    errors.push(`File list error: ${String(err)}`);
  }

  for (const token of queryTokens) {
    const tokenLower = token.toLowerCase();
    for (const file of allFiles) {
      if (isSensitiveFileName(file)) continue;
      if (file.toLowerCase().includes(tokenLower)) {
        relevantFiles.add(file);
        // Include exports of matched file
        try {
          const exports = await engine.findExports(file);
          for (const sym of exports) {
            const key = `${sym.filePath}:${sym.name}:${sym.startLine}`;
            const current = scoredSymbols.get(key);
            const score = (current?.score ?? 0) + 7;
            scoredSymbols.set(key, { symbol: sym, score });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // C. Focus file symbols
  for (const focusFile of focusFiles) {
    if (isSensitiveFileName(focusFile)) continue;
    relevantFiles.add(focusFile);
    try {
      const focusSymbols = await engine.getFileSymbols(focusFile);
      for (const sym of focusSymbols) {
        const key = `${sym.filePath}:${sym.name}:${sym.startLine}`;
        const current = scoredSymbols.get(key);
        const score = (current?.score ?? 0) + (sym.isExported ? 8 : 6);
        scoredSymbols.set(key, { symbol: sym, score });
      }
    } catch {
      // ignore
    }
  }

  // D. Dependency relationships for relevant files
  const checkedDepFiles = new Set<string>();
  for (const file of Array.from(relevantFiles).slice(0, 10)) {
    if (checkedDepFiles.has(file)) continue;
    checkedDepFiles.add(file);
    try {
      const depGraph = await engine.getFileDependencies(file);
      for (const imp of depGraph.imports) {
        if (relevantDependencies.length >= maxDepsLimit) break;
        relevantDependencies.push({
          sourcePath: file,
          importPath: imp.path,
          importedNames: imp.names,
          isTypeOnly: imp.isTypeOnly,
        });
      }
      for (const impBy of depGraph.importedBy) {
        if (relevantDependencies.length >= maxDepsLimit) break;
        relevantDependencies.push({
          sourcePath: impBy.path,
          importPath: file,
          importedNames: impBy.names,
          isTypeOnly: impBy.isTypeOnly,
        });
        relevantFiles.add(impBy.path);
      }
    } catch {
      // ignore
    }
  }

  // E. FTS5 Lexical Search if broader search is needed (no exact match found)
  if (query && query.trim().length > 0 && !usedExact && scoredSymbols.size < maxSymbolsLimit) {
    try {
      const ftsResults = await engine.searchSymbols(query, { maxResults: 15 });
      if (ftsResults.length > 0) {
        usedFts5 = true;
        for (const sym of ftsResults) {
          if (isSensitiveFileName(sym.filePath)) continue;
          const key = `${sym.filePath}:${sym.name}:${sym.startLine}`;
          if (!scoredSymbols.has(key)) {
            scoredSymbols.set(key, { symbol: sym, score: sym.isExported ? 4 : 3 });
            relevantFiles.add(sym.filePath);
          }
        }
      }
    } catch (err) {
      errors.push(`FTS5 search error: ${String(err)}`);
    }
  }

  // 5. Ranking and Budget Enforcement
  const sortedSymbols = Array.from(scoredSymbols.values())
    .sort((a, b) => b.score - a.score)
    .map((item) => item.symbol);

  let truncated = false;
  const finalSymbols: ProjectSymbolContext[] = [];
  let symbolCharCount = 0;
  // Conservative estimate: ~50 chars per formatted symbol record (~12-15 tokens)
  for (const sym of sortedSymbols) {
    if (finalSymbols.length >= maxSymbolsLimit) {
      truncated = true;
      break;
    }
    finalSymbols.push({
      name: sym.name,
      kind: sym.kind,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      character: sym.character,
      signature: sym.signature,
      isExported: sym.isExported,
      docComment: sym.docComment,
    });
    symbolCharCount += (sym.name.length + (sym.signature?.length ?? 0) + sym.filePath.length + 30);
  }

  const finalFiles: ProjectFileContext[] = [];
  for (const relPath of relevantFiles) {
    if (finalFiles.length >= maxFilesLimit) {
      truncated = true;
      break;
    }
    const record = await engine.getFile(relPath).catch(() => null);
    finalFiles.push({
      path: relPath,
      language: record?.language,
      lineCount: record?.lineCount,
      contentHash: record?.contentHash,
      isTest: record?.isTest,
      isConfig: record?.isConfig,
    });
  }

  // 6. RepoMap Generation
  let repoMapRecord: SharedProjectContext["repoMap"];
  try {
    const map = await engine.generateRepoMap({
      maxTokens: repoMapTokens,
      focusPaths: Array.from(relevantFiles),
      focusSymbols: queryTokens,
      includeSignatures: true,
    });
    repoMapRecord = {
      content: map.content,
      estimatedTokens: map.estimatedTokens,
      filesIncluded: map.filesIncluded,
    };
  } catch (err) {
    errors.push(`RepoMap error: ${String(err)}`);
  }

  // 7. Metadata
  let metadata = {
    languages: [] as ReadonlyArray<string>,
    frameworks: [] as ReadonlyArray<string>,
    packageManager: null as string | null,
    testFramework: null as string | null,
    totalFiles: 0,
    totalSymbols: 0,
  };
  try {
    const meta = await engine.getProjectMetadata();
    metadata = {
      languages: meta.languages,
      frameworks: meta.frameworks,
      packageManager: meta.packageManager,
      testFramework: meta.testFramework,
      totalFiles: meta.totalFiles,
      totalSymbols: meta.totalSymbols,
    };
  } catch (err) {
    errors.push(`Metadata error: ${String(err)}`);
  }

  // 8. Token budget calculation
  const repoMapTokensEst = repoMapRecord?.estimatedTokens ?? 0;
  const symbolTokensEst = Math.ceil(symbolCharCount / 4);
  const depTokensEst = Math.ceil((relevantDependencies.length * 40) / 4);
  const fileTokensEst = Math.ceil((finalFiles.length * 30) / 4);
  const manifestTokensEst = 50;
  const totalEstimatedTokens = repoMapTokensEst + symbolTokensEst + depTokensEst + fileTokensEst + manifestTokensEst;

  if (totalEstimatedTokens > maxTokens) {
    truncated = true;
  }

  const budget: ProjectContextBudget = {
    maxTokens,
    estimatedTokens: totalEstimatedTokens,
    truncated,
  };

  let retrievalMethod: ProjectContextDiagnostics["retrievalMethod"] = "repomap";
  if (usedExact && usedFts5) {
    retrievalMethod = "hybrid";
  } else if (usedExact) {
    retrievalMethod = "exact";
  } else if (usedFts5) {
    retrievalMethod = "fts5";
  }

  const diagnostics: ProjectContextDiagnostics = {
    durationMs: Date.now() - startMs,
    retrievalMethod,
    errors,
  };

  return {
    workspaceId: options?.workspaceId ?? null,
    projectRoot: canonicalRoot,
    query,
    metadata,
    repoMap: repoMapRecord,
    files: finalFiles,
    symbols: finalSymbols,
    dependencies: relevantDependencies,
    budget,
    freshness,
    diagnostics,
  };
}
