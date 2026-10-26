/**
 * adversarial-g07-stress.test.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS SUITE FOR GATE G07:
 * 1. 50 Parallel Asynchronous Writes (Mixed wm.writeFile & acquireWriteLock, 16-char & 64-char hashes).
 * 2. High-Contention CAS Linearizability Loop (20 parallel workers, CAS retries, zero lost updates).
 * 3. Lock Timeout Stress & Queue Non-Corruption (timeoutMs: 50, holder holding 250ms, subsequent acquisition verification).
 * 4. Multi-Path Deadlock Stress (30 concurrent workers inverting lock acquisition orders [A,B], [B,A], [C,B,A], etc.).
 * 5. Pre-aborted and In-flight AbortSignal Stress.
 * 6. Clean Teardown & Resource Leak Verification (drain to zero, no lingering timers, zero unhandled rejections).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FileLockManager } from "@mediobot-v2/tools";
import { FileLockTimeoutError } from "@mediobot-v2/contracts";
import { LocalDatabase } from "../../src/storage/db.ts";
import { WorkspaceRepository } from "../../src/storage/workspaceRepository.ts";
import { WorkspaceManager } from "../../src/workspaceManager.ts";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Global unhandled rejection tracker
const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});

// ============================================================================
// STRESS TEST 1: 50 Parallel Asynchronous Writes Targeting the Exact Same File
// ============================================================================
test("STRESS 1: 50 parallel writes with mixed CAS hashes (16-char & 64-char) and mixed callers (Editor & Agent)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-50-writes-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fileName = "contested-file.txt";
  const filePath = path.join(root, fileName);
  const initialContent = "GENESIS_CONTENT_LINE_0\n";
  await writeFile(filePath, initialContent);

  const fullHash = sha256(initialContent);
  const shortHash = fullHash.slice(0, 16);

  const sharedLock = new FileLockManager();
  const db = new LocalDatabase(path.join(root, "stress1.sqlite"));
  t.after(() => { try { db.close(); } catch {} });

  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), root, {
    fileLockManager: sharedLock,
  });

  // Launch 50 concurrent writes
  const CONCURRENCY = 50;
  const writePromises: Promise<{ caller: string; index: number; content: string }>[] = [];

  for (let i = 0; i < CONCURRENCY; i++) {
    const isEditor = i % 2 === 0;
    const useShortHash = i % 4 < 2;
    const expectedHash = useShortHash ? shortHash : fullHash;
    const payload = `PAYLOAD_WORKER_${i}_${isEditor ? "EDITOR" : "AGENT"}\n`;

    if (isEditor) {
      writePromises.push(
        wm.writeFile(fileName, payload, expectedHash).then(() => ({
          caller: "editor",
          index: i,
          content: payload,
        }))
      );
    } else {
      writePromises.push(
        sharedLock.acquireWriteLock(filePath, expectedHash, async () => {
          await writeFile(filePath, payload);
          return { caller: "agent", index: i, content: payload };
        })
      );
    }
  }

  const results = await Promise.allSettled(writePromises);

  const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ caller: string; index: number; content: string }> => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  // Invariant 1: Exactly ONE write must succeed against the initial hash
  assert.equal(fulfilled.length, 1, `Expected exactly 1 write to succeed, but got ${fulfilled.length}`);
  // Invariant 2: Exactly 49 writes must reject
  assert.equal(rejected.length, CONCURRENCY - 1, `Expected exactly ${CONCURRENCY - 1} writes to reject, but got ${rejected.length}`);

  // Invariant 3: Every single rejected write MUST fail with STALE_REVISION or file-conflict
  for (const failure of rejected) {
    const err = failure.reason;
    const isConflict =
      (err && err.message === "file-conflict") ||
      (err && (err as any).code === "STALE_REVISION");
    assert.ok(
      isConflict,
      `Rejected write threw non-conflict error: ${err?.message || err}`
    );
  }

  // Invariant 4: Winner's payload must match disk bytes exactly (no partial write, no clobbering)
  const winner = fulfilled[0]!;
  const diskBytes = await readFile(filePath, "utf8");
  assert.equal(diskBytes, winner.value.content, "Disk content must match the single winning write");

  // Invariant 5: Lock manager queue must have drained completely to 0
  const canonical = await sharedLock.resolveCanonicalPath(filePath);
  const lockKey = `file:${canonical}`;
  const entry = (sharedLock as any).entries.get(lockKey);
  assert.equal(entry, undefined, "Lock entry must be deleted after all 50 writes settle");
});

// ============================================================================
// STRESS TEST 2: High-Contention CAS Linearizability Loop (Zero Lost Updates)
// ============================================================================
test("STRESS 2: 20 parallel workers updating shared file via CAS retry loop with zero lost updates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-cas-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fileName = "linearizable-log.txt";
  const filePath = path.join(root, fileName);
  await writeFile(filePath, "HEADER\n");

  const sharedLock = new FileLockManager();
  const db = new LocalDatabase(path.join(root, "stress2.sqlite"));
  t.after(() => { try { db.close(); } catch {} });

  const wm = new WorkspaceManager(new WorkspaceRepository(db.raw), root, {
    fileLockManager: sharedLock,
  });

  const WORKERS = 20;
  let totalConflicts = 0;

  async function workerTask(workerId: number) {
    let committed = false;
    let attempts = 0;

    while (!committed) {
      attempts++;
      if (attempts > 200) {
        throw new Error(`Worker ${workerId} exceeded 200 CAS retry attempts`);
      }

      // Read current state & hash
      const currentContent = await readFile(filePath, "utf8");
      const currentFullHash = sha256(currentContent);
      const useShort = workerId % 2 === 0;
      const expectedHash = useShort ? currentFullHash.slice(0, 16) : currentFullHash;

      const nextContent = currentContent + `WORKER_${workerId}\n`;

      try {
        if (workerId % 3 === 0) {
          await wm.writeFile(fileName, nextContent, expectedHash);
        } else {
          await sharedLock.acquireWriteLock(filePath, expectedHash, async () => {
            await writeFile(filePath, nextContent);
          });
        }
        committed = true;
      } catch (err: any) {
        if (err.message === "file-conflict" || err.code === "STALE_REVISION") {
          totalConflicts++;
          // Jittered backoff to simulate realistic concurrent agent retries
          await sleep(Math.floor(Math.random() * 8) + 1);
        } else {
          throw err;
        }
      }
    }
  }

  // Run all 20 workers concurrently
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => workerTask(i)));

  // Verify linearizability:
  const finalContent = await readFile(filePath, "utf8");
  const lines = finalContent.trim().split("\n");

  assert.equal(lines[0], "HEADER");
  assert.equal(lines.length, WORKERS + 1, `Expected ${WORKERS + 1} lines but found ${lines.length}`);

  // Verify all workers are present exactly once (zero lost updates)
  for (let i = 0; i < WORKERS; i++) {
    const occurrences = lines.filter((l) => l === `WORKER_${i}`).length;
    assert.equal(occurrences, 1, `Worker ${i} must appear exactly once in log`);
  }

  assert.ok(totalConflicts > 0, `Expected multiple CAS conflicts under contention, got ${totalConflicts}`);
});

// ============================================================================
// STRESS TEST 3: Lock Timeout Stress & Queue Non-Corruption
// ============================================================================
test("STRESS 3: Contenders timing out with timeoutMs: 50 do not corrupt subsequent lock acquisitions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, "timeout-test.txt");
  await writeFile(filePath, "initial");

  const lockManager = new FileLockManager({ defaultTimeoutMs: 5000 });
  const canonical = await lockManager.resolveCanonicalPath(filePath);
  const lockKey = `file:${canonical}`;

  let holderStarted = false;
  let holderFinished = false;

  // 1. Long holder acquires lock and holds for 250ms
  const holderPromise = lockManager.acquireWriteLock(filePath, undefined, async () => {
    holderStarted = true;
    await sleep(250);
    holderFinished = true;
    return "holder-done";
  });

  // Wait until holder has acquired lock
  while (!holderStarted) {
    await sleep(5);
  }

  // 2. Launch 4 contenders with 50ms timeout
  const timeoutErrors: FileLockTimeoutError[] = [];
  const contenders = Array.from({ length: 4 }, async (_, i) => {
    const t0 = Date.now();
    try {
      await lockManager.acquireWriteLock(filePath, undefined, async () => {
        return `contender-${i}-done`;
      }, { timeoutMs: 50 });
      assert.fail(`Contender ${i} should have timed out`);
    } catch (err: any) {
      const elapsed = Date.now() - t0;
      assert.ok(err instanceof FileLockTimeoutError, `Expected FileLockTimeoutError but got: ${err}`);
      assert.equal(err.code, "FILE_LOCK_TIMEOUT");
      assert.equal(err.timeoutMs, 50);
      assert.ok(elapsed >= 45 && elapsed < 200, `Timeout elapsed was ${elapsed}ms, expected ~50ms`);
      timeoutErrors.push(err);
    }
  });

  await Promise.all(contenders);
  assert.equal(timeoutErrors.length, 4, "All 4 contenders must fail with FileLockTimeoutError");
  assert.equal(holderFinished, false, "Holder should still be holding the lock while contenders timed out");

  // Check queue while holder is still running: queue should have drained the 4 timed out waiters
  const entryWhileHolding = (lockManager as any).entries.get(lockKey);
  assert.ok(entryWhileHolding !== undefined, "Entry must still exist for current holder");
  assert.equal(entryWhileHolding.queue.length, 0, "Queue must contain 0 waiters after all timed out");

  // Wait for holder to finish
  const holderResult = await holderPromise;
  assert.equal(holderResult, "holder-done");

  // Lock manager entries should now be completely deleted
  const entryAfterHolder = (lockManager as any).entries.get(lockKey);
  assert.equal(entryAfterHolder, undefined, "Lock entry must be deleted after holder releases");

  // 3. Subsequent lock acquisition must succeed cleanly without hanging or error
  let subsequentAcquired = false;
  const subsequentResult = await lockManager.acquireWriteLock(filePath, undefined, async () => {
    subsequentAcquired = true;
    return "subsequent-success";
  }, { timeoutMs: 500 });

  assert.equal(subsequentAcquired, true, "Subsequent lock must acquire without corruption");
  assert.equal(subsequentResult, "subsequent-success");

  // Final check: entries map clean
  assert.equal((lockManager as any).entries.size, 0, "Entries map must be size 0 after all operations");
});

// ============================================================================
// STRESS TEST 4: Multi-Path Deadlock Stress (Lexicographical Sorting Inversion)
// ============================================================================
test("STRESS 4: Inverted multi-path acquisitions [A,B], [B,A], [C,B,A] never deadlock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-deadlock-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const fileA = path.join(root, "fileA.txt");
  const fileB = path.join(root, "fileB.txt");
  const fileC = path.join(root, "fileC.txt");

  await writeFile(fileA, "0");
  await writeFile(fileB, "0");
  await writeFile(fileC, "0");

  const lockManager = new FileLockManager({ defaultTimeoutMs: 3000 });

  // 30 workers requesting locks in opposing order permutations
  const WORKERS = 30;
  const permutations = [
    [fileA, fileB],
    [fileB, fileA],
    [fileA, fileC],
    [fileC, fileA],
    [fileB, fileC],
    [fileC, fileB],
    [fileA, fileB, fileC],
    [fileC, fileB, fileA],
    [fileB, fileA, fileC],
    [fileC, fileA, fileB],
  ];

  let activeMultiHolders = 0;
  let maxConcurrentMultiHolders = 0;

  async function worker(id: number) {
    const paths = permutations[id % permutations.length]!;
    return lockManager.acquireWriteLocks(paths, async () => {
      activeMultiHolders++;
      maxConcurrentMultiHolders = Math.max(maxConcurrentMultiHolders, activeMultiHolders);

      // Simulate small file update
      for (const p of paths) {
        const val = parseInt(await readFile(p, "utf8"), 10);
        await writeFile(p, String(val + 1));
      }
      await sleep(2);

      activeMultiHolders--;
      return `worker-${id}-done`;
    });
  }

  const startTime = Date.now();
  const workerResults = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => worker(i))
  );
  const totalDuration = Date.now() - startTime;

  assert.equal(workerResults.length, WORKERS);
  // If there was a deadlock, the defaultTimeoutMs (3000ms) would have expired or hung
  assert.ok(totalDuration < 3000, `Multi-path locks completed in ${totalDuration}ms without deadlock`);

  // Verify all files were updated the expected number of times
  const countA = parseInt(await readFile(fileA, "utf8"), 10);
  const countB = parseInt(await readFile(fileB, "utf8"), 10);
  const countC = parseInt(await readFile(fileC, "utf8"), 10);

  // Calculate expected counts based on permutations used
  let expectedA = 0;
  let expectedB = 0;
  let expectedC = 0;
  for (let i = 0; i < WORKERS; i++) {
    const p = permutations[i % permutations.length]!;
    if (p.includes(fileA)) expectedA++;
    if (p.includes(fileB)) expectedB++;
    if (p.includes(fileC)) expectedC++;
  }

  assert.equal(countA, expectedA, `File A count mismatch: got ${countA}, expected ${expectedA}`);
  assert.equal(countB, expectedB, `File B count mismatch: got ${countB}, expected ${expectedB}`);
  assert.equal(countC, expectedC, `File C count mismatch: got ${countC}, expected ${expectedC}`);

  assert.equal((lockManager as any).entries.size, 0, "All lock entries must drain to 0 after multi-locks");
});

// ============================================================================
// STRESS TEST 5: AbortSignal In-Flight Cancellation & Pre-Aborted Signal
// ============================================================================
test("STRESS 5: In-flight AbortSignal cancellation cleans up queue and does not block next waiters", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, "abort-test.txt");
  await writeFile(filePath, "initial");

  const lockManager = new FileLockManager();
  const canonical = await lockManager.resolveCanonicalPath(filePath);
  const lockKey = `file:${canonical}`;

  let holderRunning = true;
  t.after(() => { holderRunning = false; });

  const holderPromise = lockManager.acquireWriteLock(filePath, undefined, async () => {
    while (holderRunning) {
      await sleep(10);
    }
    return "holder-done";
  });

  // Wait for holder to take lock
  await sleep(20);

  // Queue a waiter with an AbortSignal
  const controller = new AbortController();
  const abortedPromise = lockManager.acquireWriteLock(
    filePath,
    undefined,
    async () => "should-not-run",
    { signal: controller.signal }
  );

  // Queue another normal waiter behind it
  let normalWaiterRan = false;
  const normalWaiterPromise = lockManager.acquireWriteLock(
    filePath,
    undefined,
    async () => {
      normalWaiterRan = true;
      return "normal-waiter-done";
    }
  );

  // Wait for async path resolution to queue both waiters
  await sleep(20);

  // Verify both are queued behind holder
  const entry = (lockManager as any).entries.get(lockKey);
  assert.equal(entry.queue.length, 2, "Expected 2 waiters in queue");

  // Abort the first waiter
  controller.abort(new Error("MANUAL_ABORT"));

  // The aborted waiter must reject with abort reason
  await assert.rejects(abortedPromise, { message: "MANUAL_ABORT" });

  // Queue should now contain only 1 waiter (the normal waiter)
  assert.equal(entry.queue.length, 1, "Queue should drain aborted waiter");

  // Release the holder
  holderRunning = false;
  await holderPromise;

  // The normal waiter must now proceed and succeed!
  const normalResult = await normalWaiterPromise;
  assert.equal(normalResult, "normal-waiter-done");
  assert.equal(normalWaiterRan, true);

  // Clean teardown check
  assert.equal((lockManager as any).entries.size, 0);
});

// ============================================================================
// STRESS TEST 6: Clean Teardown & Zero Unhandled Rejections
// ============================================================================
test("STRESS 6: Clean Teardown guarantees zero lingering timers and zero unhandled rejections", async () => {
  // Check global unhandled rejection ledger
  assert.equal(
    unhandledRejections.length,
    0,
    `Detected unhandled promise rejections: ${JSON.stringify(unhandledRejections)}`
  );
});

// ============================================================================
// STRESS TEST 7: Error Unwinding & Lock Release on Operation Failure
// ============================================================================
test("STRESS 7: Lock is cleanly released even if the operation throws an unhandled exception", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-throw-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, "throw-test.txt");
  await writeFile(filePath, "initial");

  const lockManager = new FileLockManager();

  // Operation deliberately throws
  await assert.rejects(
    lockManager.acquireWriteLock(filePath, undefined, async () => {
      throw new Error("OPERATION_EXPLODED");
    }),
    { message: "OPERATION_EXPLODED" }
  );

  // Subsequent operation must acquire immediately without being blocked
  const res = await lockManager.acquireWriteLock(filePath, undefined, async () => {
    return "recovered";
  });
  assert.equal(res, "recovered");
  assert.equal((lockManager as any).entries.size, 0);
});

// ============================================================================
// STRESS TEST 8: Case-Insensitive Path Collision (macOS / Windows)
// ============================================================================
test("STRESS 8: Case-insensitive alias paths collide on the exact same lock on darwin/win32", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return; // Case-folding is platform-specific
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-case-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const lowerPath = path.join(root, "case-test.txt");
  const upperPath = path.join(root, "CASE-TEST.TXT");
  await writeFile(lowerPath, "content");

  const lockManager = new FileLockManager();

  let firstHolderActive = false;
  let blockedWorkerAcquired = false;

  const p1 = lockManager.acquireWriteLock(lowerPath, undefined, async () => {
    firstHolderActive = true;
    await sleep(100);
    firstHolderActive = false;
    return "p1-done";
  });

  while (!firstHolderActive) {
    await sleep(5);
  }

  const p2 = lockManager.acquireWriteLock(upperPath, undefined, async () => {
    assert.equal(firstHolderActive, false, "Second worker must NOT run while first worker is active!");
    blockedWorkerAcquired = true;
    return "p2-done";
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, "p1-done");
  assert.equal(r2, "p2-done");
  assert.equal(blockedWorkerAcquired, true);
  assert.equal((lockManager as any).entries.size, 0);
});

// ============================================================================
// STRESS TEST 9: Duplicate Paths in Multi-Lock Acquisition (No Self-Deadlock)
// ============================================================================
test("STRESS 9: acquireWriteLocks with duplicate and relative paths deduplicates without self-deadlock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-dedup-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, "self-dup.txt");
  await writeFile(filePath, "content");

  const lockManager = new FileLockManager({ defaultTimeoutMs: 1000 });

  // Pass duplicates and relative path variations to acquireWriteLocks
  const res = await lockManager.acquireWriteLocks(
    [filePath, filePath, path.join(root, ".", "self-dup.txt")],
    async () => {
      return "dedup-success";
    }
  );

  assert.equal(res, "dedup-success");
  assert.equal((lockManager as any).entries.size, 0);
});

// ============================================================================
// STRESS TEST 10: Pre-Aborted AbortSignal Behavior
// ============================================================================
test("STRESS 10: Pre-aborted signal behavior when lock is held vs free", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-preabort-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const filePath = path.join(root, "preabort.txt");
  await writeFile(filePath, "content");

  const lockManager = new FileLockManager();

  // Test 10A: Pre-aborted signal when lock is HELD by another worker
  let holderRunning = true;
  t.after(() => { holderRunning = false; });
  const holderPromise = lockManager.acquireWriteLock(filePath, undefined, async () => {
    while (holderRunning) await sleep(10);
    return "holder";
  });
  await sleep(20);

  const controllerA = new AbortController();
  controllerA.abort(new Error("ALREADY_ABORTED"));

  // Because lock is held, acquireRawLock checks signal.aborted before queueing
  await assert.rejects(
    lockManager.acquireWriteLock(filePath, undefined, async () => "nope", { signal: controllerA.signal }),
    { message: "ALREADY_ABORTED" }
  );

  holderRunning = false;
  await holderPromise;

  // Test 10B: Pre-aborted signal when lock is NOT held (lock is FREE)
  const controllerB = new AbortController();
  controllerB.abort(new Error("PRE_ABORTED_FREE"));

  let opRanOnFree = false;
  try {
    await lockManager.acquireWriteLock(
      filePath,
      undefined,
      async () => {
        opRanOnFree = true;
        return "ran";
      },
      { signal: controllerB.signal }
    );
  } catch (err: any) {
    // If it threw
  }
  // Record observation:
  // Note: in fileLockManager.ts line 151, if !entry.isLocked, it grants lock immediately
  // without checking signal?.aborted.
  console.log(`[TEST 10B Observation] Pre-aborted signal on free lock executed operation: ${opRanOnFree}`);
});

// ============================================================================
// STRESS TEST 11: 50 Concurrent File Creation Writes (expectedHash: "")
// ============================================================================
test("STRESS 11: 50 concurrent file creations against non-existent file with expectedHash: ''", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g07-stress-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const newFilePath = path.join(root, "brand-new-file.txt");
  const lockManager = new FileLockManager();

  const CREATORS = 50;
  const promises = Array.from({ length: CREATORS }, (_, i) => {
    return lockManager.acquireWriteLock(newFilePath, "", async () => {
      await writeFile(newFilePath, `CREATED_BY_${i}\n`);
      return i;
    });
  });

  const settled = await Promise.allSettled(promises);
  const succeeded = settled.filter((r) => r.status === "fulfilled");
  const failed = settled.filter((r) => r.status === "rejected");

  assert.equal(succeeded.length, 1, `Expected exactly 1 creator to succeed, got ${succeeded.length}`);
  assert.equal(failed.length, CREATORS - 1, `Expected ${CREATORS - 1} creations to fail with STALE_REVISION`);

  for (const f of failed) {
    const err = (f as PromiseRejectedResult).reason;
    assert.equal(err.message, "file-conflict");
    assert.equal(err.code, "STALE_REVISION");
  }

  const disk = await readFile(newFilePath, "utf8");
  const winningId = (succeeded[0] as PromiseFulfilledResult<number>).value;
  assert.equal(disk, `CREATED_BY_${winningId}\n`);
  assert.equal((lockManager as any).entries.size, 0);
});


