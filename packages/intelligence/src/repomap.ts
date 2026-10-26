import { isSensitiveName } from "@mediobot-v2/contracts";
import type { SqliteStore } from "./store.ts";
import type { RepoMap, RepoMapOptions, SymbolResult } from "./types.ts";

export class RepoMapGenerator {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  async generate(options?: RepoMapOptions): Promise<RepoMap> {
    const startMs = Date.now();
    const maxTokens = options?.maxTokens ?? 1500;
    const focusPaths = new Set(options?.focusPaths ?? []);
    const focusSymbols = new Set(options?.focusSymbols ?? []);
    const includeSignatures = options?.includeSignatures ?? true;

    // 1. Get all files, strictly excluding any sensitive or credential files
    const allFiles = this.store.listFiles().filter((f) => !isSensitiveName(f));
    if (allFiles.length === 0) {
      return {
        content: "No indexed files found.",
        estimatedTokens: 5,
        filesIncluded: 0,
        generationMs: Date.now() - startMs,
      };
    }

    // 2. Score files based on import in-degree + focus boosts
    const fileScores = new Map<string, number>();
    for (const file of allFiles) {
      fileScores.set(file, 1.0); // Base score
    }

    // Boost focus paths
    for (const fp of focusPaths) {
      if (fileScores.has(fp)) {
        fileScores.set(fp, fileScores.get(fp)! + 10.0);
      }
    }

    // Accumulate incoming dependency counts
    for (const file of allFiles) {
      const deps = this.store.getFileDependencies(file);
      for (const imp of deps.imports) {
        // Resolve target file match if possible
        const targetPath = imp.path.replace(/^\.\//, "").replace(/\.[^/.]+$/, "");
        for (const candidate of allFiles) {
          if (candidate.startsWith(targetPath) || candidate.includes(imp.path)) {
            fileScores.set(candidate, (fileScores.get(candidate) ?? 1.0) + 1.5);
          }
        }
      }
    }

    // Boost if file exports a focus symbol
    for (const sym of focusSymbols) {
      const results = this.store.findSymbol(sym);
      for (const res of results) {
        if (fileScores.has(res.filePath)) {
          fileScores.set(res.filePath, fileScores.get(res.filePath)! + 5.0);
        }
      }
    }

    // 3. Sort files descending by score
    const sortedFiles = [...allFiles].sort((a, b) => {
      const scoreB = fileScores.get(b) ?? 0;
      const scoreA = fileScores.get(a) ?? 0;
      return scoreB - scoreA;
    });

    // 4. Build output string within token budget (~4 characters per token estimate)
    const charBudget = maxTokens * 4;
    const lines: string[] = ["# Project Structure & Key Exports\n"];
    let currentChars = lines[0]!.length;
    let filesIncluded = 0;

    for (const file of sortedFiles) {
      const fileHeader = `\n## ${file}\n`;
      if (currentChars + fileHeader.length > charBudget) {
        break;
      }

      const fileSymbols = this.store.findExports(file);
      const symbolLines: string[] = [];

      for (const sym of fileSymbols) {
        const sig = includeSignatures && sym.signature ? ` — ${sym.signature}` : "";
        const symLine = `  - [${sym.kind}] ${sym.name}${sig}`;
        symbolLines.push(symLine);
      }

      const fileBlock = fileHeader + (symbolLines.length > 0 ? symbolLines.join("\n") + "\n" : "  (no exports)\n");
      if (currentChars + fileBlock.length > charBudget && filesIncluded > 0) {
        break;
      }

      lines.push(fileBlock);
      currentChars += fileBlock.length;
      filesIncluded++;
    }

    const content = lines.join("");
    const estimatedTokens = Math.ceil(content.length / 4);

    return {
      content,
      estimatedTokens,
      filesIncluded,
      generationMs: Date.now() - startMs,
    };
  }
}
