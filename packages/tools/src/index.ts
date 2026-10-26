import { spawn } from "node:child_process";
import { lstat, mkdir, open, opendir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResourceId, TaskId, WorkerId, WorldId } from "@mediobot-v2/domain";
import { InMemoryWorld } from "@mediobot-v2/domain";

const workspaceBindingsByWorld = new WeakMap<InMemoryWorld, Map<ResourceId, string>>();

interface InvocationBase {
  readonly worldId: WorldId;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly signal?: AbortSignal;
}

export type ToolInvocation = InvocationBase & (
  | { readonly name: "filesystem.list"; readonly input: { readonly path?: string } }
  | { readonly name: "filesystem.read"; readonly input: { readonly path: string } }
  | { readonly name: "filesystem.write"; readonly input: { readonly path: string; readonly content: string } }
  | { readonly name: "terminal.execute"; readonly input: {
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly cwd?: string;
  } }
);

export type ToolOutput =
  | { readonly entries: ReadonlyArray<string> }
  | { readonly content: string }
  | { readonly bytesWritten: number }
  | {
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
    readonly exitCode: number | null;
    readonly termination: "exited" | "cancelled";
  };

const MAX_CAPTURED_STREAM_BYTES = 1024 * 1024;
const MAX_FILE_READ_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;

export interface ToolResult {
  readonly invocationId: string;
  readonly worldId: WorldId;
  readonly workerId: WorkerId;
  readonly taskId: TaskId;
  readonly resourceId: ResourceId;
  readonly toolName: ToolInvocation["name"];
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly output?: ToolOutput;
  readonly error?: string;
}

export class ToolRuntime {
  private readonly workspaces: Map<ResourceId, string>;
  private readonly world: InMemoryWorld;

  constructor(world: InMemoryWorld) {
    this.world = world;
    let bindings = workspaceBindingsByWorld.get(world);
    if (!bindings) {
      bindings = new Map();
      workspaceBindingsByWorld.set(world, bindings);
    }
    this.workspaces = bindings;
  }

  async bindWorkspace(resourceId: ResourceId, location: string): Promise<void> {
    const resource = this.world.inspect().resources.find((item) => item.id === resourceId);
    if (!resource || resource.kind !== "workspace" || resource.owner.type === "world") {
      throw new Error("Workspace resource must be owned by a worker or task");
    }
    if (this.workspaces.has(resourceId)) throw new Error("Workspace resource is already bound");
    const canonical = await realpath(location);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory()) throw new Error("Workspace root must be a directory");
    if (this.workspaces.has(resourceId)) throw new Error("Workspace resource is already bound");
    if ([...this.workspaces.values()].some((bound) => this.pathsOverlap(bound, canonical))) {
      throw new Error("Workspace locations must not overlap");
    }
    this.workspaces.set(resourceId, canonical);
  }

  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    const invocationId = globalThis.crypto.randomUUID();
    const base = {
      invocationId,
      worldId: invocation.worldId,
      workerId: invocation.workerId,
      taskId: invocation.taskId,
      resourceId: invocation.resourceId,
      toolName: invocation.name,
    };
    try {
      const root = await this.validate(invocation);
      if (invocation.name !== "terminal.execute") this.event(invocation, "tool.started");
      if (invocation.signal?.aborted) {
        if (invocation.name === "terminal.execute") this.event(invocation, "tool.started");
        this.event(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", error: "Tool invocation was cancelled" };
      }
      const output = invocation.name === "terminal.execute"
        ? await this.runTerminal(invocation, root, () => this.event(invocation, "tool.started"))
        : await this.runFilesystem(invocation as Extract<ToolInvocation, { name: "filesystem.list" | "filesystem.read" | "filesystem.write" }>, root);
      if (invocation.signal?.aborted && invocation.name !== "terminal.execute") {
        this.event(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", error: "Tool invocation was cancelled" };
      }
      if (invocation.name === "terminal.execute" && "exitCode" in output && output.termination === "cancelled") {
        this.event(invocation, "tool.cancelled");
        return { ...base, status: "cancelled", output };
      }
      if (invocation.name === "terminal.execute" && "exitCode" in output && output.exitCode !== 0) {
        this.event(invocation, "tool.failed");
        return { ...base, status: "failed", output, error: `Process exited with code ${output.exitCode}` };
      }
      this.event(invocation, "tool.succeeded");
      return { ...base, status: "succeeded", output };
    } catch (error) {
      const status = invocation.signal?.aborted ? "cancelled" : "failed";
      try {
        if (this.canAttribute(invocation)) this.event(invocation, status === "cancelled" ? "tool.cancelled" : "tool.failed");
      } catch {
        // Invalid ownership cannot safely be recorded against the claimed resource.
      }
      return {
        ...base,
        status,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async validate(invocation: ToolInvocation): Promise<string> {
    if (invocation.worldId !== this.world.id) throw new Error("Invocation belongs to another world");
    const snapshot = this.world.inspect();
    const worker = snapshot.workers.find((item) => item.id === invocation.workerId);
    const task = snapshot.tasks.find((item) => item.id === invocation.taskId);
    const resource = snapshot.resources.find((item) => item.id === invocation.resourceId);
    if (!worker || worker.state !== "busy") throw new Error("Worker is not active");
    if (!task || task.state !== "running" || task.assignedWorkerId !== worker.id) {
      throw new Error("Task is not running for this worker");
    }
    if (!resource || resource.kind !== "workspace" || resource.state !== "in-use") {
      throw new Error("Resource is not an active workspace");
    }
    const owned = (resource.owner.type === "worker" && resource.owner.workerId === worker.id)
      || (resource.owner.type === "task" && resource.owner.taskId === task.id);
    if (!owned) throw new Error("Workspace is not owned by this worker or task");
    const root = this.workspaces.get(resource.id);
    if (!root) throw new Error("Workspace resource has no local binding");
    await this.assertCanonicalRoot(root);
    return root;
  }

  private async assertCanonicalRoot(root: string): Promise<void> {
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(root) !== root) {
      throw new Error("Workspace root changed after it was bound");
    }
  }

  private canAttribute(invocation: ToolInvocation): boolean {
    const snapshot = this.world.inspect();
    const task = snapshot.tasks.find((item) => item.id === invocation.taskId);
    const resource = snapshot.resources.find((item) => item.id === invocation.resourceId);
    return invocation.worldId === this.world.id
      && task?.assignedWorkerId === invocation.workerId
      && (resource?.owner.type === "worker" && resource.owner.workerId === invocation.workerId
        || resource?.owner.type === "task" && resource.owner.taskId === invocation.taskId);
  }

  private event(invocation: ToolInvocation, type: string): void {
    this.world.appendEvent({
      type,
      workerId: invocation.workerId,
      taskId: invocation.taskId,
      resourceId: invocation.resourceId,
      toolName: invocation.name,
    });
  }

  private async runFilesystem(
    invocation: Extract<ToolInvocation, { name: `filesystem.${string}` }>,
    root: string,
  ): Promise<ToolOutput> {
    const relativePath = "path" in invocation.input ? invocation.input.path ?? "." : ".";
    const target = this.resolveContained(root, relativePath);
    if (invocation.name === "filesystem.list") {
      await this.assertNoSymlink(root, target, false);
      const directory = await opendir(target);
      const entries: string[] = [];
      for await (const entry of directory) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES) {
          throw new Error(`Directory exceeds the ${MAX_DIRECTORY_ENTRIES} entry limit`);
        }
        entries.push(entry.name);
      }
      return { entries: entries.sort() };
    }
    if (invocation.name === "filesystem.read") {
      await this.assertNoSymlink(root, target, false);
      const metadata = await lstat(target);
      if (!metadata.isFile()) throw new Error("Only regular files can be read");
      if (metadata.nlink > 1) throw new Error("Hard-linked files cannot be read from a workspace");
      if (metadata.size > MAX_FILE_READ_BYTES) {
        throw new Error(`File exceeds the ${MAX_FILE_READ_BYTES} byte read limit`);
      }
      const file = await open(target, "r");
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= MAX_FILE_READ_BYTES) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_READ_BYTES + 1 - total));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          chunks.push(buffer.subarray(0, bytesRead));
          total += bytesRead;
        }
        if (total > MAX_FILE_READ_BYTES) {
          throw new Error(`File exceeds the ${MAX_FILE_READ_BYTES} byte read limit`);
        }
        return { content: Buffer.concat(chunks).toString("utf8") };
      } finally {
        await file.close();
      }
    }
    await this.ensureSafeParents(root, target);
    try {
      if ((await lstat(target)).nlink > 1) throw new Error("Hard-linked files cannot be written in a workspace");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(target, invocation.input.content, "utf8");
    return { bytesWritten: Buffer.byteLength(invocation.input.content, "utf8") };
  }

  private async runTerminal(
    invocation: Extract<ToolInvocation, { name: "terminal.execute" }>,
    root: string,
    onStarted: () => void,
  ): Promise<ToolOutput> {
    const cwd = this.resolveContained(root, invocation.input.cwd ?? ".");
    await this.assertNoSymlink(root, cwd, false);
    const cwdStat = await lstat(cwd);
    if (!cwdStat.isDirectory()) throw new Error("Terminal working directory must be a directory");
    return new Promise<ToolOutput>((resolve) => {
      const child = spawn(invocation.input.command, [...(invocation.input.args ?? [])], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let cancelled = invocation.signal?.aborted ?? false;
      const cancel = () => {
        cancelled = true;
        child.kill();
      };
      child.once("spawn", onStarted);
      if (cancelled) child.kill();
      else invocation.signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        const remaining = MAX_CAPTURED_STREAM_BYTES - stdoutBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          stdout.push(retained);
          stdoutBytes += retained.length;
        }
        if (chunk.length > remaining) stdoutTruncated = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = MAX_CAPTURED_STREAM_BYTES - stderrBytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          stderr.push(retained);
          stderrBytes += retained.length;
        }
        if (chunk.length > remaining) stderrTruncated = true;
      });
      child.once("error", (error) => {
        invocation.signal?.removeEventListener("abort", cancel);
        resolve({ stdout: Buffer.concat(stdout).toString(), stderr: `${Buffer.concat(stderr).toString()}${error.message}`,
          stdoutTruncated, stderrTruncated, exitCode: null, termination: cancelled ? "cancelled" : "exited" });
      });
      child.once("close", (code) => {
        invocation.signal?.removeEventListener("abort", cancel);
        resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
          stdoutTruncated, stderrTruncated, exitCode: code, termination: cancelled ? "cancelled" : "exited" });
      });
    });
  }

  private resolveContained(root: string, candidate: string): string {
    if (candidate.includes("\0")) throw new Error("Path contains a NUL byte");
    if (path.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      || /^[A-Za-z]:/.test(candidate)) throw new Error("Absolute paths are not allowed");
    const components = candidate.split(/[\\/]+/);
    if (components.includes("..")) throw new Error("Path traversal is not allowed");
    const target = path.resolve(root, candidate);
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Path escapes the owned workspace");
    }
    return target;
  }

  private pathsOverlap(left: string, right: string): boolean {
    const inside = (parent: string, child: string): boolean => {
      const relative = path.relative(parent, child);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    return inside(left, right) || inside(right, left);
  }

  private async assertNoSymlink(root: string, target: string, allowMissing: boolean): Promise<void> {
    const relative = path.relative(root, target);
    let current = root;
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace paths");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
        throw error;
      }
    }
  }

  private async ensureSafeParents(root: string, target: string): Promise<void> {
    const parent = path.dirname(target);
    const relativeParent = path.relative(root, parent);
    let current = root;
    for (const part of relativeParent ? relativeParent.split(path.sep) : []) {
      current = path.join(current, part);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Workspace parent is not a safe directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current);
      }
    }
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace paths");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
