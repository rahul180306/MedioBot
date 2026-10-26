import { ProjectIntelligenceEngineImpl } from "./engine.ts";
import type { ProjectIntelligenceEngine, ProjectIntelligenceOptions } from "./types.ts";

export * from "./types.ts";
export * from "./config.ts";
export * from "./scanner.ts";
export * from "./store.ts";
export * from "./watcher.ts";
export * from "./repomap.ts";
export * from "./adapters/typescript.ts";
export * from "./adapters/registry.ts";
export * from "./engine.ts";
export * from "./retrieval.ts";
export * from "./formatter.ts";
export * from "./provider.ts";

export function createProjectIntelligenceEngine(
  options: ProjectIntelligenceOptions
): ProjectIntelligenceEngine {
  return new ProjectIntelligenceEngineImpl(options);
}
