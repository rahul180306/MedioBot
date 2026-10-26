import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import type { SharedProjectContext } from "@mediobot-v2/contracts";
import { ProjectIntelligenceEngineImpl } from "./engine.ts";
import { retrieveProjectContext, type ProjectRetrievalOptions } from "./retrieval.ts";
import type { ProjectIntelligenceEngine, ProjectIntelligenceOptions } from "./types.ts";

export class ProjectContextProvider {
  private readonly instances = new Map<string, ProjectIntelligenceEngine>();
  private readonly initPromises = new Map<string, Promise<ProjectIntelligenceEngine>>();

  /**
   * Get or initialize a ProjectIntelligenceEngine instance strictly bound to the canonical root.
   */
  async getEngine(
    workspaceRoot: string,
    options?: Partial<ProjectIntelligenceOptions>
  ): Promise<ProjectIntelligenceEngine> {
    if (!workspaceRoot || typeof workspaceRoot !== "string") {
      throw new Error("Invalid workspace root provided.");
    }

    const canonicalRoot = await realpath(workspaceRoot);
    const rootStat = await lstat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${canonicalRoot}`);
    }

    const existing = this.instances.get(canonicalRoot);
    if (existing) {
      return existing;
    }

    const inFlight = this.initPromises.get(canonicalRoot);
    if (inFlight) {
      return inFlight;
    }

    const initPromise = (async () => {
      try {
        const engine = new ProjectIntelligenceEngineImpl({
          workspaceRoot: canonicalRoot,
          enableWatcher: options?.enableWatcher ?? false,
          debounceMs: options?.debounceMs ?? 150,
          customAdapters: options?.customAdapters,
          dbPath: options?.dbPath,
        });
        await engine.initialize();
        this.instances.set(canonicalRoot, engine);
        return engine;
      } finally {
        this.initPromises.delete(canonicalRoot);
      }
    })();

    this.initPromises.set(canonicalRoot, initPromise);
    return initPromise;
  }

  /**
   * Retrieve bounded, freshness-checked SharedProjectContext for a given workspace.
   */
  async getContext(
    workspaceRoot: string,
    query?: string,
    options?: ProjectRetrievalOptions
  ): Promise<SharedProjectContext> {
    const engine = await this.getEngine(workspaceRoot);
    return retrieveProjectContext(engine, workspaceRoot, query, options);
  }

  /**
   * Disposes of the engine for a specific workspace, freeing SQLite handles and watchers.
   */
  async disposeWorkspace(workspaceRoot: string): Promise<void> {
    try {
      const canonicalRoot = await realpath(workspaceRoot);
      const engine = this.instances.get(canonicalRoot);
      if (engine) {
        this.instances.delete(canonicalRoot);
        await engine.dispose().catch(() => {});
      }
    } catch {
      // ignore
    }
  }

  /**
   * Disposes of all active engines across all workspaces.
   */
  async disposeAll(): Promise<void> {
    const entries = Array.from(this.instances.entries());
    this.instances.clear();
    for (const [, engine] of entries) {
      await engine.dispose().catch(() => {});
    }
  }
}

// Global default provider instance
export const defaultProjectContextProvider = new ProjectContextProvider();
