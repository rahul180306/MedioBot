#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { ProjectIntelligenceEngineImpl } from "../src/engine.ts";
import { isProjectIntelligenceEnabled } from "../src/config.ts";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const targetPath = args[2] ?? (args[1]?.startsWith("/") || args[1]?.startsWith(".") ? args[1] : process.cwd());
  const workspaceRoot = path.resolve(targetPath);

  console.log(`[PIE CLI] Target Workspace: ${workspaceRoot}`);
  console.log(`[PIE CLI] Feature Flag (USE_PROJECT_INTELLIGENCE): ${isProjectIntelligenceEnabled() ? "ENABLED (true)" : "DISABLED (false - default)"}\n`);

  const engine = new ProjectIntelligenceEngineImpl({ workspaceRoot });
  await engine.initialize();

  try {
    switch (command) {
      case "index": {
        console.log("Starting full index...");
        const report = await engine.fullIndex();
        console.log("Indexing Complete!");
        console.log(`- Files indexed: ${report.filesIndexed}`);
        console.log(`- Files skipped: ${report.filesSkipped}`);
        console.log(`- Symbols extracted: ${report.symbolsExtracted}`);
        console.log(`- Dependencies tracked: ${report.dependenciesTracked}`);
        console.log(`- Duration: ${report.durationMs} ms`);
        if (report.errors.length > 0) {
          console.log(`- Errors (${report.errors.length}):`);
          report.errors.forEach((e) => console.log(`  * ${e.path}: ${e.error}`));
        }
        break;
      }

      case "files": {
        const files = await engine.listFiles();
        console.log(`Indexed Files (${files.length}):`);
        files.forEach((f) => console.log(`  - ${f}`));
        break;
      }

      case "symbol": {
        const name = args[1];
        if (!name) {
          console.error("Usage: pie symbol <symbolName> [workspacePath]");
          process.exit(1);
        }
        const results = await engine.findSymbol(name);
        console.log(`Exact matches for symbol '${name}' (${results.length}):`);
        results.forEach((r) => {
          console.log(`  - [${r.kind}] ${r.name} in ${r.filePath}:${r.startLine}`);
          if (r.signature) console.log(`    Signature: ${r.signature}`);
          if (r.docComment) console.log(`    Doc: ${r.docComment.replace(/\n/g, " ")}`);
        });
        break;
      }

      case "fts": {
        const query = args[1];
        if (!query) {
          console.error("Usage: pie fts <searchQuery> [workspacePath]");
          process.exit(1);
        }
        const results = await engine.searchSymbols(query);
        console.log(`FTS5 Search matches for '${query}' (${results.length}):`);
        results.forEach((r) => {
          console.log(`  - [${r.kind}] ${r.name} in ${r.filePath}:${r.startLine} (exported: ${r.isExported})`);
          if (r.signature) console.log(`    Signature: ${r.signature}`);
        });
        break;
      }

      case "imports": {
        const specifier = args[1];
        if (!specifier) {
          console.error("Usage: pie imports <moduleSpecifier> [workspacePath]");
          process.exit(1);
        }
        const results = await engine.findImports(specifier);
        console.log(`Files importing '${specifier}' (${results.length}):`);
        results.forEach((r) => {
          console.log(`  - ${r.sourcePath} imports [${r.importedNames.join(", ")}]`);
        });
        break;
      }

      case "repomap": {
        const repoMap = await engine.generateRepoMap({ maxTokens: 1500 });
        console.log(`RepoMap (${repoMap.filesIncluded} files, ~${repoMap.estimatedTokens} tokens, ${repoMap.generationMs}ms):`);
        console.log("--------------------------------------------------");
        console.log(repoMap.content);
        break;
      }

      case "meta": {
        const meta = await engine.getProjectMetadata();
        console.log("Project Metadata:");
        console.log(`- Languages: ${meta.languages.join(", ") || "none detected"}`);
        console.log(`- Frameworks: ${meta.frameworks.join(", ") || "none detected"}`);
        console.log(`- Package Manager: ${meta.packageManager ?? "unknown"}`);
        console.log(`- Test Framework: ${meta.testFramework ?? "unknown"}`);
        console.log(`- Total Files: ${meta.totalFiles}`);
        console.log(`- Total Symbols: ${meta.totalSymbols}`);
        break;
      }

      case "help":
      default: {
        console.log("Available commands:");
        console.log("  index   [workspacePath]           - Run full index");
        console.log("  files   [workspacePath]           - List all indexed files");
        console.log("  symbol  <name>    [workspacePath] - Look up symbol by name");
        console.log("  fts     <query>   [workspacePath] - Full-text search across symbols");
        console.log("  imports <module>  [workspacePath] - Find files importing a module");
        console.log("  repomap [workspacePath]           - Generate token-budgeted RepoMap");
        console.log("  meta    [workspacePath]           - Display detected project metadata");
        break;
      }
    }
  } finally {
    await engine.dispose();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
