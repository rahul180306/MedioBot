import type { LanguageAdapter, ParsedFile } from "../types.ts";
import { TypeScriptAdapter } from "./typescript.ts";

export class LanguageAdapterRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  constructor(customAdapters?: ReadonlyArray<LanguageAdapter>) {
    // Default TypeScript/JavaScript adapter
    this.register(new TypeScriptAdapter());

    if (customAdapters) {
      for (const adapter of customAdapters) {
        this.register(adapter);
      }
    }
  }

  register(adapter: LanguageAdapter): void {
    // Prepend custom or newer adapters so they take precedence
    this.adapters.unshift(adapter);
  }

  getAdapter(filePath: string): LanguageAdapter | null {
    for (const adapter of this.adapters) {
      if (adapter.canParse(filePath)) {
        return adapter;
      }
    }
    return null;
  }

  async parseFile(filePath: string, content: string): Promise<ParsedFile> {
    const adapter = this.getAdapter(filePath);
    if (!adapter) {
      // Unsupported language: return graceful empty parsed file
      const ext = filePath.includes(".") ? filePath.split(".").pop()?.toLowerCase() ?? "unknown" : "unknown";
      return {
        filePath,
        language: ext,
        lineCount: countLines(content),
        symbols: [],
        dependencies: [],
        errors: [],
      };
    }

    try {
      return await adapter.parse(filePath, content);
    } catch (err) {
      return {
        filePath,
        language: adapter.name,
        lineCount: countLines(content),
        symbols: [],
        dependencies: [],
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }
}

function countLines(content: string): number {
  if (!content) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count++;
  }
  return count;
}
