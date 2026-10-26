import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./process-crash-fixture.ts", import.meta.url));
const waitFor = (child: ReturnType<typeof spawn>, marker: string, timeoutMs: number) => new Promise<string>((resolve, reject) => {
  let output = "";
  const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${marker}. Child output: ${output.slice(-3000)}`)); }, timeoutMs);
  const cleanup = () => { clearTimeout(timeout); child.stdout?.off("data", onData); child.off("exit", onExit); child.off("error", onError); };
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes(marker)) { cleanup(); resolve(output); }
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => { cleanup(); reject(new Error(`Child exited before ${marker}: code=${code}, signal=${signal}. Output: ${output.slice(-3000)}`)); };
  const onError = (error: Error) => { cleanup(); reject(error); };
  child.stdout?.on("data", onData);
  child.on("exit", onExit);
  child.on("error", onError);
});

function runChild(mode: "interrupt" | "resume" | "approval-interrupt" | "approval-resume" | "terminal-interrupt" | "terminal-resume", databasePath: string, workspaceRoot: string,
  taskId?: string, approvalId?: string) {
  const inheritedRuntimeEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!] ]));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fixture, mode], {
    cwd: process.cwd(),
    env: { ...inheritedRuntimeEnv, MEDIOBOT_CRASH_DB: databasePath, MEDIOBOT_CRASH_WORKSPACE: workspaceRoot,
      MEDIOBOT_TESTER_CALLS: path.join(path.dirname(workspaceRoot), "tester-calls.txt"),
      MEDIOBOT_TERMINAL_EFFECTS: path.join(path.dirname(workspaceRoot), "terminal-effects.txt"),
      MEDIOBOT_TERMINAL_PID: path.join(path.dirname(workspaceRoot), "terminal.pid"),
      ...(taskId ? { MEDIOBOT_CRASH_TASK: taskId } : {}), ...(approvalId ? { MEDIOBOT_CRASH_APPROVAL: approvalId } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}

async function stopAndReap(child: ReturnType<typeof spawn> | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
}

test("production /api/turns recovers a completed Cody side effect after abrupt process termination", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-process-crash-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.db");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, "source.txt"), "source evidence\n");
  writeFileSync(path.join(workspaceRoot, "result.txt"), "initial content\n");
  let interrupted: ReturnType<typeof spawn> | undefined;
  let resumed: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    await Promise.all([stopAndReap(resumed), stopAndReap(interrupted)]);
    rmSync(root, { recursive: true, force: true });
  });

  const initial = runChild("interrupt", databasePath, workspaceRoot);
  interrupted = initial.child;
  const ready = waitFor(initial.child, "READY_TO_CRASH", 15_000);
  const idLine = waitFor(initial.child, "TASK_ID:", 15_000);
  const [readyOutput, taskOutput] = await Promise.all([ready, idLine]);
  const taskId = `${readyOutput}\n${taskOutput}`.match(/TASK_ID:([\w-]+)/)?.[1];
  assert.ok(taskId, "the task identity must be reported before termination");
  const resultFile = path.join(workspaceRoot, "result.txt");
  assert.ok(existsSync(resultFile), `the fixture reached its crash checkpoint before the write was observable; stdout=${readyOutput}\n${taskOutput}\nstderr=${initial.stderr()}`);
  assert.equal(readFileSync(resultFile, "utf8"), "recovered from durable context\n");

  const terminated = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    initial.child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(initial.child.kill(), true, "the controlled fixture process should accept termination");
  const exit = await terminated;
  assert.ok(exit.signal || exit.code !== 0, "the first application process must not exit normally");
  await new Promise(resolve => setTimeout(resolve, 30));

  const restarted = runChild("resume", databasePath, workspaceRoot, taskId);
  resumed = restarted.child;
  let output: string;
  try { output = await waitFor(restarted.child, "PROCESS_RESUME_ACCEPTED", 20_000); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nChild stderr: ${restarted.stderr()}`); }
  const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    restarted.child.once("exit", (code, signal) => resolve({ code, signal }));
    restarted.child.once("error", reject);
  });
  assert.equal(completion.code, 0, `restart fixture must exit successfully. stderr=${restarted.stderr()} output=${output.slice(-3000)}`);
});

test("production resume blocks an ambiguous terminal side effect instead of executing it twice", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-terminal-crash-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.db");
  const effectPath = path.join(root, "terminal-effects.txt");
  const pidPath = path.join(root, "terminal.pid");
  mkdirSync(workspaceRoot, { recursive: true });
  let interrupted: ReturnType<typeof spawn> | undefined;
  let resumed: ReturnType<typeof spawn> | undefined;
  const stopCommand = () => {
    try {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch { /* the child may already have exited */ }
  };
  t.after(async () => {
    stopCommand();
    await Promise.all([stopAndReap(resumed), stopAndReap(interrupted)]);
    rmSync(root, { recursive: true, force: true });
  });

  const initial = runChild("terminal-interrupt", databasePath, workspaceRoot);
  interrupted = initial.child;
  let taskId: string | undefined;
  try {
    const output = await waitFor(initial.child, "TERMINAL_READY", 15_000);
    taskId = output.match(/TASK_ID:([\w-]+)/)?.[1];
    assert.ok(taskId, `the task identity must be available for restart. stderr=${initial.stderr()}`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nChild stderr: ${initial.stderr()}`);
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(effectPath)) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(existsSync(effectPath), `the command must perform its external effect before the crash. stderr=${initial.stderr()}`);
  assert.equal(readFileSync(effectPath, "utf8").trim().split("\n").length, 1);
  const terminated = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    initial.child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(initial.child.kill(), true, "the production process should accept abrupt termination during the active command");
  stopCommand();
  const exit = await terminated;
  assert.ok(exit.signal || exit.code !== 0);

  const restarted = runChild("terminal-resume", databasePath, workspaceRoot, taskId);
  resumed = restarted.child;
  let resumeOutput: string;
  try { resumeOutput = await waitFor(restarted.child, "AMBIGUOUS_REPLAY_BLOCKED", 20_000); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nChild stderr: ${restarted.stderr()}`); }
  const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    restarted.child.once("exit", (code, signal) => resolve({ code, signal }));
    restarted.child.once("error", reject);
  });
  assert.equal(completion.code, 0, `ambiguous recovery fixture must exit cleanly. stderr=${restarted.stderr()} output=${resumeOutput.slice(-2500)}`);
  assert.equal(readFileSync(effectPath, "utf8").trim().split("\n").length, 1,
    "restart must not repeat an external side effect whose outcome is ambiguous");
});

test("production approval survives process termination and resumes the exact Cody action once", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mediobot-process-approval-"));
  const workspaceRoot = path.join(root, "workspace");
  const databasePath = path.join(root, "mediobot.db");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(path.join(workspaceRoot, "source.txt"), "approved source content\n");
  writeFileSync(path.join(workspaceRoot, "result.txt"), "baseline\n");
  let interrupted: ReturnType<typeof spawn> | undefined;
  let resumed: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    await Promise.all([stopAndReap(resumed), stopAndReap(interrupted)]);
    rmSync(root, { recursive: true, force: true });
  });

  const initial = runChild("approval-interrupt", databasePath, workspaceRoot);
  interrupted = initial.child;
  const output = await waitFor(initial.child, "APPROVAL_READY", 15_000);
  const taskId = output.match(/TASK_ID:([\w-]+)/)?.[1];
  const approvalId = output.match(/APPROVAL_ID:([\w-]+)/)?.[1];
  const interruptId = output.match(/APPROVAL_INTERRUPT:([\w-]+)/)?.[1];
  assert.ok(taskId && approvalId && interruptId, `fixture must persist task/approval/interrupt identity. output=${output}`);
  assert.equal(readFileSync(path.join(workspaceRoot, "result.txt"), "utf8"), "baseline\n",
    "Cody's write must remain unapplied until the approval is explicitly resolved");

  const terminated = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    initial.child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(initial.child.kill(), true, "the process holding the pending LangGraph approval should accept termination");
  const exit = await terminated;
  assert.ok(exit.signal || exit.code !== 0, "the approval-owning application process must not exit normally");

  const restarted = runChild("approval-resume", databasePath, workspaceRoot, taskId, approvalId);
  resumed = restarted.child;
  let resumedOutput: string;
  try { resumedOutput = await waitFor(restarted.child, "APPROVAL_RESUME_ACCEPTED", 20_000); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nChild stderr: ${restarted.stderr()}`); }
  const completion = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    restarted.child.once("exit", (code, signal) => resolve({ code, signal }));
    restarted.child.once("error", reject);
  });
  assert.equal(completion.code, 0, `approval restart fixture must exit successfully. stderr=${restarted.stderr()} output=${resumedOutput.slice(-3000)}`);
});
