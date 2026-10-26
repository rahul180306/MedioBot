import type { TaskId } from "@mediobot-v2/domain";
import type { SubprocessRecord } from "@mediobot-v2/contracts";
import { execFile } from "node:child_process";

export class SubprocessQuotaExceededError extends Error {
  readonly currentCount: number;
  readonly maxAllowed: number;
  readonly scope: "global" | "workspace";

  constructor(scope: "global" | "workspace", currentCount: number, maxAllowed: number) {
    super(`Subprocess quota exceeded (${scope}): ${currentCount} active, max allowed ${maxAllowed}`);
    this.name = "SubprocessQuotaExceededError";
    this.scope = scope;
    this.currentCount = currentCount;
    this.maxAllowed = maxAllowed;
  }
}

export interface SubprocessSupervisorOptions {
  readonly maxConcurrentGlobal?: number;
  readonly maxConcurrentPerWorkspace?: number;
  readonly killGracePeriodMs?: number;
}

export class SubprocessSupervisor {
  private readonly records = new Map<string, SubprocessRecord>();
  private readonly terminations = new Map<string, Promise<void>>();
  private readonly maxGlobal: number;
  private readonly maxPerWorkspace: number;
  private readonly gracePeriodMs: number;

  constructor(options: SubprocessSupervisorOptions = {}) {
    this.maxGlobal = options.maxConcurrentGlobal ?? 8;
    this.maxPerWorkspace = options.maxConcurrentPerWorkspace ?? 4;
    this.gracePeriodMs = options.killGracePeriodMs ?? 500;
  }

  get activeCount(): number {
    return this.records.size;
  }

  activeCountForWorkspace(workspaceId: string | null): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.workspaceId === workspaceId) count++;
    }
    return count;
  }

  canSpawn(workspaceId: string | null): boolean {
    if (this.records.size >= this.maxGlobal) return false;
    if (workspaceId && this.activeCountForWorkspace(workspaceId) >= this.maxPerWorkspace) return false;
    return true;
  }

  register(record: SubprocessRecord): void {
    if (this.records.size >= this.maxGlobal) {
      throw new SubprocessQuotaExceededError("global", this.records.size, this.maxGlobal);
    }
    if (record.workspaceId) {
      const workspaceCount = this.activeCountForWorkspace(record.workspaceId);
      if (workspaceCount >= this.maxPerWorkspace) {
        throw new SubprocessQuotaExceededError("workspace", workspaceCount, this.maxPerWorkspace);
      }
    }
    this.records.set(record.id, record);
  }

  unregister(id: string): void {
    if (!this.terminations.has(id)) this.records.delete(id);
  }

  getActiveSubprocesses(workspaceId?: string | null): SubprocessRecord[] {
    const list: SubprocessRecord[] = [];
    for (const record of this.records.values()) {
      if (workspaceId === undefined || record.workspaceId === workspaceId) {
        list.push(record);
      }
    }
    return list;
  }

  async terminateTaskSubprocesses(taskId: TaskId, signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    const targets: SubprocessRecord[] = [];
    for (const record of this.records.values()) {
      if (record.taskId === taskId) {
        targets.push(record);
      }
    }

    if (targets.length === 0) return 0;

    await Promise.all(targets.map(record => this.terminateRecord(record, signal)));
    return targets.length;
  }

  async terminateAll(): Promise<void> {
    const all = [...this.records.values()];
    await Promise.all(all.map(record => this.terminateRecord(record, "SIGTERM")));
  }

  private terminateRecord(record: SubprocessRecord, signal: NodeJS.Signals): Promise<void> {
    const existing = this.terminations.get(record.id);
    if (existing) return existing;
    const termination = (async () => {
      try {
        await this.killProcessTree(record, signal);
        if (signal !== "SIGKILL" && this.gracePeriodMs > 0) {
          await new Promise(resolve => setTimeout(resolve, this.gracePeriodMs));
          if (process.platform === "win32" || record.pgid !== undefined || this.isProcessRunning(record.pid)) {
            await this.killProcessTree(record, "SIGKILL");
          }
        }
      } finally {
        if (this.records.get(record.id) === record) this.records.delete(record.id);
        this.terminations.delete(record.id);
      }
    })();
    this.terminations.set(record.id, termination);
    return termination;
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killProcessTree(record: SubprocessRecord, signal: NodeJS.Signals): Promise<void> {
    const { pid } = record;
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.windir;
      const taskkill = systemRoot ? `${systemRoot}\\System32\\taskkill.exe` : "taskkill.exe";
      const args = ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
      return new Promise(resolve => execFile(taskkill, args, { windowsHide: true, timeout: 2_000, maxBuffer: 2_048 }, error => {
        if (error) {
          // taskkill can be unavailable or blocked by policy. Still make a
          // best-effort attempt to stop the owned root process; do not claim
          // that descendants were terminated when tree termination failed.
          try { process.kill(pid, signal); } catch { /* Already exited or inaccessible. */ }
        }
        resolve();
      }));
    }
    try {
      // Only terminal children registered with an explicit pgid own a process
      // group. Escalate that group even if its leader has exited; descendants
      // may still be running. Other managed subprocesses are killed by PID.
      if (record.pgid !== undefined) {
        try { process.kill(-record.pgid, signal); } catch { /* Group already exited or inaccessible. */ }
        return Promise.resolve();
      }
      process.kill(pid, signal);
    } catch (err: any) {
      // ESRCH means process already terminated, which is fine
      if (err.code !== "ESRCH") {
        // ignore other transient process kill errors
      }
    }
    return Promise.resolve();
  }
}
