import dns from "node:dns/promises";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { TaskId } from "@mediobot-v2/domain";
import type {
  CrawlRequest,
  CrawlResult,
  WebSearchRequest,
  WebSearchResult,
  ProvenanceRecord,
} from "@mediobot-v2/contracts";
import type { ResourceGovernor, SubprocessSupervisor } from "./index.ts";

export interface Crawl4AiRuntimeOptions {
  readonly pythonPath?: string;
  readonly workerScriptPath?: string;
  readonly resourceGovernor?: ResourceGovernor;
  readonly subprocessSupervisor?: SubprocessSupervisor;
  readonly idleTimeoutMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly maxCacheSizeBytes?: number;
  readonly maxCacheEntries?: number;
  readonly maxSingleEntryBytes?: number;
  readonly onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
}

export interface CrawlerMemoryMetrics {
  readonly workerRssBytes: number;
  readonly totalProcessTreeRssBytes: number;
  readonly childProcessCount: number;
  readonly browserActive: boolean;
  readonly cacheSizeBytes: number;
  readonly cacheEntryCount: number;
  readonly peakProcessTreeRssBytes: number;
}

export interface WorkerInfo {
  readonly version: string;
  readonly backend: string;
  readonly interpreter: string;
  readonly pythonPath: string;
}

interface CacheEntry {
  readonly result: CrawlResult;
  readonly cachedAt: number;
  readonly approxBytes: number;
}

function buildCrawlCacheKey(request: CrawlRequest): string {
  try {
    const parsed = new URL(request.url.trim());
    const normalizedUrl = `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
    const opts = JSON.stringify({
      extract: request.extractOptions ?? null,
      renderJs: request.renderJs ?? false,
      preferHttp: request.preferHttp ?? false,
      waitForSelector: request.waitForSelector ?? null,
      workspaceId: request.workspaceId ?? null,
      allowedDestinations: request.allowedDestinations ? [...request.allowedDestinations].sort() : null,
    });
    return `${normalizedUrl}::${opts}`;
  } catch {
    return `${request.url.trim()}::${JSON.stringify({
      extract: request.extractOptions ?? null,
      renderJs: request.renderJs ?? false,
      waitForSelector: request.waitForSelector ?? null,
      workspaceId: request.workspaceId ?? null,
      allowedDestinations: request.allowedDestinations ? [...request.allowedDestinations].sort() : null,
    })}`;
  }
}


function isIpAddressForbidden(ip: string): { forbidden: boolean; reason?: string } {
  const lowerIp = ip.toLowerCase();
  let ipv4Candidate = lowerIp;
  if (lowerIp.startsWith("::ffff:")) {
    const rest = lowerIp.slice(7);
    if (net.isIPv4(rest)) {
      ipv4Candidate = rest;
    }
  }

  if (net.isIPv4(ipv4Candidate)) {
    const parts = ipv4Candidate.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return { forbidden: true, reason: "Malformed IPv4 address" };
    }
    const [a, b, c, d] = parts as [number, number, number, number];
    if (a === 0) return { forbidden: true, reason: "Current network (0.0.0.0/8) is forbidden" };
    if (a === 127) return { forbidden: true, reason: "Loopback address (127.0.0.0/8) is forbidden" };
    if (a === 10) return { forbidden: true, reason: "Private address space (10.0.0.0/8) is forbidden" };
    if (a === 172 && b >= 16 && b <= 31) return { forbidden: true, reason: "Private address space (172.16.0.0/12) is forbidden" };
    if (a === 192 && b === 168) return { forbidden: true, reason: "Private address space (192.168.0.0/16) is forbidden" };
    if (a === 169 && b === 254) return { forbidden: true, reason: "Link-local / cloud metadata (169.254.0.0/16) is strictly forbidden" };
    if (a === 100 && b >= 64 && b <= 127) return { forbidden: true, reason: "Shared address space / CGNAT (100.64.0.0/10) is forbidden" };
    if (a === 192 && b === 0 && c === 0) return { forbidden: true, reason: "IETF protocol assignments (192.0.0.0/24) is forbidden" };
    if (a === 192 && b === 0 && c === 2) return { forbidden: true, reason: "Documentation / TEST-NET-1 is forbidden" };
    if (a === 198 && (b === 18 || b === 19)) return { forbidden: true, reason: "Benchmark test network (198.18.0.0/15) is forbidden" };
    if (a === 198 && b === 51 && c === 100) return { forbidden: true, reason: "Documentation / TEST-NET-2 is forbidden" };
    if (a === 203 && b === 0 && c === 113) return { forbidden: true, reason: "Documentation / TEST-NET-3 is forbidden" };
    if (a >= 224 && a <= 239) return { forbidden: true, reason: "Multicast address space (224.0.0.0/4) is forbidden" };
    if (a >= 240) return { forbidden: true, reason: "Reserved / broadcast address space (240.0.0.0/4) is forbidden" };
    return { forbidden: false };
  }

  if (net.isIPv6(lowerIp)) {
    if (lowerIp === "::1" || lowerIp === "0:0:0:0:0:0:0:1") return { forbidden: true, reason: "IPv6 loopback (::1) is forbidden" };
    if (lowerIp === "::" || lowerIp === "0:0:0:0:0:0:0:0") return { forbidden: true, reason: "IPv6 unspecified (::) is forbidden" };
    if (/^f[cd][0-9a-f]{2}:/i.test(lowerIp) || lowerIp.startsWith("fc") || lowerIp.startsWith("fd")) {
      return { forbidden: true, reason: "IPv6 unique local address (fc00::/7) is forbidden" };
    }
    if (/^fe[89ab][0-9a-f]:/i.test(lowerIp) || lowerIp.startsWith("fe8") || lowerIp.startsWith("fe9") || lowerIp.startsWith("fea") || lowerIp.startsWith("feb")) {
      return { forbidden: true, reason: "IPv6 link-local address (fe80::/10) is forbidden" };
    }
    if (lowerIp.startsWith("ff")) return { forbidden: true, reason: "IPv6 multicast address (ff00::/8) is forbidden" };
    if (lowerIp.startsWith("2001:db8:") || lowerIp.startsWith("2001:0db8:")) return { forbidden: true, reason: "IPv6 documentation network is forbidden" };
    if (lowerIp.startsWith("100::")) return { forbidden: true, reason: "IPv6 discard prefix is forbidden" };
    return { forbidden: false };
  }

  return { forbidden: false };
}

export async function assertSafeWebDestination(rawUrl: string, allowedDestinations?: ReadonlyArray<string>): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid web URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Forbidden protocol "${parsed.protocol}"; only HTTP and HTTPS destinations are permitted`);
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) throw new Error("Invalid web URL: missing host");

  if (
    host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.includes("169.254.169.254") ||
    host.includes("a9fe:a9fe") ||
    host === "instance-data"
  ) {
    throw new Error(`Access to private metadata service "${host}" is strictly forbidden`);
  }

  if (allowedDestinations) {
    const origin = `${parsed.protocol}//${parsed.host}`;
    const full = parsed.href;
    for (const allowed of allowedDestinations) {
      if (!allowed) continue;
      const trimmed = allowed.trim();
      if (trimmed === full || trimmed === origin || trimmed === parsed.host || full.startsWith(trimmed.endsWith("/") ? trimmed : `${trimmed}/`)) {
        return parsed;
      }
    }
  }

  const staticCheck = isIpAddressForbidden(host);
  if (staticCheck.forbidden) {
    throw new Error(`Access to private or local destination "${host}" is forbidden: ${staticCheck.reason}`);
  }

  if (host === "localhost") {
    throw new Error(`Access to private or local destination "${host}" is forbidden`);
  }

  if (net.isIP(host) === 0) {
    if (host.endsWith(".test") || host.endsWith(".example") || host.endsWith(".invalid")) {
      return parsed;
    }
    try {
      const addresses = await dns.lookup(host, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new Error(`DNS resolution returned no addresses for "${host}"`);
      }
      for (const addr of addresses) {
        const check = isIpAddressForbidden(addr.address);
        if (check.forbidden) {
          throw new Error(`Access to destination "${host}" is forbidden: resolves to private/loopback IP ${addr.address} (${check.reason})`);
        }
      }
    } catch (err: any) {
      if (err.message && (err.message.includes("forbidden") || err.message.includes("no addresses"))) {
        throw err;
      }
      throw new Error(`DNS resolution failed for "${host}": ${err.message || String(err)}`);
    }
  }

  return parsed;
}

export class Crawl4AiRuntime {
  private workerProcess?: ChildProcess;
  private workerReady = false;
  private initPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  // Bounded LRU Cache
  private readonly cache = new Map<string, CacheEntry>();
  private currentCacheSizeBytes = 0;
  private retainedLeaseIds: Set<string> = new Set();
  private requestToLeaseMap: Map<string, string> = new Map();
  private readonly maxCacheSizeBytes: number;
  private readonly maxCacheEntries: number;
  private readonly maxSingleEntryBytes: number;

  private readonly pythonPath: string;
  private readonly workerScriptPath: string;
  private readonly resourceGovernor?: ResourceGovernor;
  private readonly subprocessSupervisor?: SubprocessSupervisor;
  private readonly idleTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly onDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  private isShutdown = false;

  private workerVersion = "0.9.4";
  private workerBackend = "crawl4ai.AsyncWebCrawler";
  private workerInterpreter = "";
  private peakProcessTreeRssBytes = 0;

  constructor(options: Crawl4AiRuntimeOptions = {}) {
    this.resourceGovernor = options.resourceGovernor;
    this.subprocessSupervisor = options.subprocessSupervisor ?? options.resourceGovernor?.subprocessSupervisor;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 3_600_000; // 1 hour
    this.maxCacheSizeBytes = options.maxCacheSizeBytes ?? 15 * 1024 * 1024; // 15 MB
    this.maxCacheEntries = options.maxCacheEntries ?? 50;
    this.maxSingleEntryBytes = options.maxSingleEntryBytes ?? 500 * 1024; // 500 KB limit per cached item
    this.onDiagnostic = options.onDiagnostic;

    // Detect Python executable
    this.pythonPath = options.pythonPath ?? this.detectPythonBinary();

    // Default worker script path
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    this.workerScriptPath = options.workerScriptPath ?? path.resolve(currentDir, "crawl4ai_worker.py");
  }

  private detectPythonBinary(): string {
    // 1. Check explicit environment variable
    if (process.env.CRAWL4AI_PYTHON && fs.existsSync(process.env.CRAWL4AI_PYTHON)) {
      return process.env.CRAWL4AI_PYTHON;
    }

    // 2. Look for .venv across current and ancestor directories
    const isWindows = process.platform === "win32";
    const venvPythonRel = isWindows ? ".venv/Scripts/python.exe" : ".venv/bin/python";
    const cwd = process.cwd();
    const candidateDirs = [
      cwd,
      path.resolve(cwd, ".."),
      path.resolve(cwd, "../.."),
      path.dirname(fileURLToPath(import.meta.url)),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
    ];

    for (const dir of candidateDirs) {
      const venvPython = path.resolve(dir, venvPythonRel);
      if (fs.existsSync(venvPython)) {
        return venvPython;
      }
    }

    // 3. Fallback to system python
    return isWindows ? "python.exe" : "python3";
  }

  get isRunning(): boolean {
    return Boolean(this.workerProcess && this.workerReady && !this.workerProcess.killed);
  }

  get retainedLeasesCount(): number {
    return this.retainedLeaseIds.size;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  get cacheSizeBytes(): number {
    return this.currentCacheSizeBytes;
  }

  get peakRssBytes(): number {
    return this.peakProcessTreeRssBytes;
  }

  getWorkerInfo(): WorkerInfo {
    return {
      version: this.workerVersion,
      backend: this.workerBackend,
      interpreter: this.workerInterpreter || this.pythonPath,
      pythonPath: this.pythonPath,
    };
  }

  getCacheMetrics(): { entries: number; sizeBytes: number; maxSizeBytes: number; maxEntries: number } {
    return {
      entries: this.cache.size,
      sizeBytes: this.currentCacheSizeBytes,
      maxSizeBytes: this.maxCacheSizeBytes,
      maxEntries: this.maxCacheEntries,
    };
  }

  clearCache(): void {
    this.cache.clear();
    this.currentCacheSizeBytes = 0;
    this.diagnostic({ event: "crawl4ai.cache_cleared" });
  }

  evictCache(fraction = 0.5): number {
    const toRemove = Math.max(1, Math.floor(this.cache.size * fraction));
    let removed = 0;
    while (removed < toRemove && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const entry = this.cache.get(oldestKey);
      if (entry) {
        this.currentCacheSizeBytes = Math.max(0, this.currentCacheSizeBytes - entry.approxBytes);
      }
      this.cache.delete(oldestKey);
      removed++;
    }
    this.diagnostic({ event: "crawl4ai.cache_evicted", removedCount: removed, remainingSize: this.currentCacheSizeBytes });
    return removed;
  }

  async crawl(request: CrawlRequest, signal?: AbortSignal): Promise<CrawlResult> {
    if (this.isShutdown) throw new Error("Crawl4AI runtime is shut down");
    if (signal?.aborted) throw new Error("Request aborted before start");

    // Pre-flight SSRF check before acquiring browser lease or sending to worker
    if (!request.url.startsWith("raw:")) {
      await assertSafeWebDestination(request.url, request.allowedDestinations);
    }

    // 1. Check cache (LRU update on hit)
    const cacheKey = buildCrawlCacheKey(request);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (request.cacheMode !== "bypass" && cached && now - cached.cachedAt < this.cacheTtlMs) {
      if (signal?.aborted) throw new Error("Request aborted before cache hit returned");
      // Re-insert to mark most recently used in Map
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      this.diagnostic({ event: "crawl4ai.cache_hit", url: request.url });
      return { ...cached.result, cached: true };
    }

    // 2. Resource Governor lease acquisition for browser session if needed
    let leaseId: string | undefined;
    let cancelSettled: boolean | undefined = undefined;
    let reqId: string | undefined;
    const requestedBrowser = request.renderJs === true || Boolean(request.waitForSelector);
    let browserAdmitted = false;

    if (this.resourceGovernor && requestedBrowser) {
      try {
        const lease = this.resourceGovernor.acquireBrowserSession(
          request.taskId,
          request.workspaceId ?? null
        );
        leaseId = lease.id;
        browserAdmitted = true;
      } catch {
        // If browser session capacity is full, do not escalate to Chromium
        request = { ...request, preferHttp: true, renderJs: false };
        browserAdmitted = false;
      }
    } else if (!this.resourceGovernor && requestedBrowser) {
      browserAdmitted = true;
    }

    try {
      await this.ensureWorker();

      reqId = globalThis.crypto.randomUUID();
      const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;

      const rawResult = await this.sendRequest<CrawlResult>(
        {
          id: reqId,
          action: "crawl",
          params: {
            url: request.url,
            allowedDestinations: request.allowedDestinations,
            cacheMode: request.cacheMode,
            renderJs: browserAdmitted ? request.renderJs : false,
            preferHttp: request.preferHttp,
            allowBrowser: browserAdmitted,
            timeoutMs: request.timeoutMs,
            waitForSelector: browserAdmitted ? request.waitForSelector : undefined,
            extractOptions: request.extractOptions,
          },
        },
        timeoutMs,
        signal
      );

      const result: CrawlResult = {
        ...rawResult,
        cached: false,
      };

      // Store in bounded LRU memory cache if successful
      if (result.success && request.cacheMode !== "bypass") {
        const approxBytes = (result.markdown?.length ?? 0) * 2 + 1024;
        // Skip caching massive documents that exceed individual entry threshold
        if (approxBytes <= this.maxSingleEntryBytes) {
          while (
            (this.currentCacheSizeBytes + approxBytes > this.maxCacheSizeBytes ||
              this.cache.size >= this.maxCacheEntries) &&
            this.cache.size > 0
          ) {
            const oldestKey = this.cache.keys().next().value;
            if (!oldestKey) break;
            const oldest = this.cache.get(oldestKey);
            if (oldest) {
              this.currentCacheSizeBytes = Math.max(0, this.currentCacheSizeBytes - oldest.approxBytes);
            }
            this.cache.delete(oldestKey);
          }
          this.cache.set(cacheKey, { result, cachedAt: Date.now(), approxBytes });
          this.currentCacheSizeBytes += approxBytes;
        }
      }

      this.diagnostic({
        event: "crawl4ai.crawl_success",
        url: request.url,
        durationMs: result.durationMs,
        sanitized: result.sanitized,
      });

      return result;
    } catch (err: any) {
      if (err?.cancelSettled !== undefined) {
        cancelSettled = err.cancelSettled;
      }
      throw err;
    } finally {
      if (leaseId && this.resourceGovernor) {
        if (cancelSettled === false) {
          this.retainedLeaseIds.add(leaseId);
          if (reqId) {
            this.requestToLeaseMap.set(reqId, leaseId);
          }
          this.diagnostic({
            event: "crawl4ai.lease_retained_unsettled_cancel",
            leaseId,
            message: "Retaining resource lease because cancellation has not settled",
          });
        } else {
          this.resourceGovernor.releaseLease(leaseId);
        }
      }
    }
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (this.isShutdown) throw new Error("Crawl4AI runtime is shut down");
    await this.ensureWorker();

    const reqId = globalThis.crypto.randomUUID();
    const timeoutMs = this.defaultTimeoutMs;

    const result = await this.sendRequest<WebSearchResult>(
      {
        id: reqId,
        action: "discover",
        params: {
          query: request.query,
          maxResults: request.maxResults,
          allowedDomains: request.allowedDomains,
          filterType: request.filterType,
        },
      },
      timeoutMs,
      signal
    );

    this.diagnostic({
      event: "crawl4ai.discover_success",
      query: request.query,
      matches: result.totalMatches,
    });

    return result;
  }

  async ping(timeoutMs = 5000): Promise<boolean> {
    if (this.isShutdown) return false;
    try {
      await this.ensureWorker();
      const res = await this.sendRequest<{ status: string }>({ id: "ping", action: "ping" }, timeoutMs);
      return res.status === "pong";
    } catch {
      return false;
    }
  }

  async getMemoryMetrics(): Promise<CrawlerMemoryMetrics> {
    if (!this.workerProcess || !this.workerReady) {
      return {
        workerRssBytes: 0,
        totalProcessTreeRssBytes: 0,
        childProcessCount: 0,
        browserActive: false,
        cacheSizeBytes: this.currentCacheSizeBytes,
        cacheEntryCount: this.cache.size,
        peakProcessTreeRssBytes: this.peakProcessTreeRssBytes,
      };
    }

    try {
      const res = await this.sendRequest<{
        workerRssBytes: number;
        totalProcessTreeRssBytes: number;
        childProcessCount: number;
        browserActive: boolean;
      }>({ id: globalThis.crypto.randomUUID(), action: "memory_metrics" }, 5000);

      this.peakProcessTreeRssBytes = Math.max(this.peakProcessTreeRssBytes, res.totalProcessTreeRssBytes);

      return {
        ...res,
        cacheSizeBytes: this.currentCacheSizeBytes,
        cacheEntryCount: this.cache.size,
        peakProcessTreeRssBytes: this.peakProcessTreeRssBytes,
      };
    } catch {
      return {
        workerRssBytes: 0,
        totalProcessTreeRssBytes: 0,
        childProcessCount: 0,
        browserActive: false,
        cacheSizeBytes: this.currentCacheSizeBytes,
        cacheEntryCount: this.cache.size,
        peakProcessTreeRssBytes: this.peakProcessTreeRssBytes,
      };
    }
  }

  async releaseBrowser(): Promise<CrawlerMemoryMetrics> {
    if (!this.workerProcess || !this.workerReady) {
      return this.getMemoryMetrics();
    }

    try {
      const res = await this.sendRequest<{
        workerRssBytes: number;
        totalProcessTreeRssBytes: number;
        childProcessCount: number;
        browserActive: boolean;
      }>({ id: globalThis.crypto.randomUUID(), action: "release_browser" }, 8000);

      this.diagnostic({ event: "crawl4ai.browser_released", totalRssBytes: res.totalProcessTreeRssBytes });

      return {
        ...res,
        cacheSizeBytes: this.currentCacheSizeBytes,
        cacheEntryCount: this.cache.size,
        peakProcessTreeRssBytes: this.peakProcessTreeRssBytes,
      };
    } catch {
      return this.getMemoryMetrics();
    }
  }

  private async ensureWorker(): Promise<void> {
    this.resetIdleTimer();
    if (this.workerProcess && this.workerReady && !this.workerProcess.killed) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        this.diagnostic({ event: "crawl4ai.worker_spawning", pythonPath: this.pythonPath });
        const child = spawn(this.pythonPath, [this.workerScriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
          },
        });

        this.workerProcess = child;
        const subId = globalThis.crypto.randomUUID();

        if (this.subprocessSupervisor && child.pid) {
          try {
            this.subprocessSupervisor.register({
              id: subId,
              pid: child.pid,
              command: `${this.pythonPath} ${this.workerScriptPath}`,
              taskId: "crawl4ai-shared-runtime" as TaskId,
              workspaceId: null,
              startedAt: Date.now(),
            });
          } catch {
            // best-effort supervisor tracking
          }
        }

        const rl = readline.createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
          this.handleWorkerMessage(line, resolve, reject);
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) {
            this.diagnostic({ event: "crawl4ai.worker_stderr", message: text });
          }
        });

        child.once("close", (code) => {
          this.diagnostic({ event: "crawl4ai.worker_closed", code });
          if (this.subprocessSupervisor) {
            this.subprocessSupervisor.unregister(subId);
          }
          if (this.resourceGovernor && this.retainedLeaseIds.size > 0) {
            for (const leaseId of this.retainedLeaseIds) {
              try {
                this.resourceGovernor.releaseLease(leaseId);
              } catch {}
            }
            this.retainedLeaseIds.clear();
          }
          this.workerProcess = undefined;
          this.workerReady = false;
          this.initPromise = undefined;

          // Reject any pending requests
          for (const [id, req] of this.pendingRequests.entries()) {
            clearTimeout(req.timer);
            req.reject(new Error(`Crawl4AI worker exited with code ${code}`));
            this.pendingRequests.delete(id);
          }
        });

        child.once("error", (err) => {
          this.diagnostic({ event: "crawl4ai.worker_error", error: err.message });
          this.workerProcess = undefined;
          this.workerReady = false;
          this.initPromise = undefined;
          reject(err);
        });
      } catch (err) {
        this.initPromise = undefined;
        reject(err);
      }
    });

    return this.initPromise;
  }

  private handleWorkerMessage(
    line: string,
    onReady?: () => void,
    onFail?: (err: Error) => void
  ): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed);

      // Startup ready event
      if (msg.event === "ready") {
        this.workerReady = true;
        this.initPromise = undefined;
        this.workerVersion = msg.version ?? "0.9.4";
        this.workerBackend = msg.backend ?? "crawl4ai.AsyncWebCrawler";
        this.workerInterpreter = msg.interpreter ?? this.pythonPath;
        this.diagnostic({ event: "crawl4ai.worker_ready", version: this.workerVersion, backend: this.workerBackend });
        onReady?.();
        return;
      }

      // Deferred settlement notification from worker
      if (msg.event === "deferred_settlement" && msg.targetRequestId) {
        const leaseId = this.requestToLeaseMap.get(msg.targetRequestId);
        if (leaseId && this.retainedLeaseIds.has(leaseId)) {
          this.retainedLeaseIds.delete(leaseId);
          this.requestToLeaseMap.delete(msg.targetRequestId);
          if (this.resourceGovernor) this.resourceGovernor.releaseLease(leaseId);
          this.diagnostic({ event: "crawl4ai.lease_released_deferred", leaseId, targetRequestId: msg.targetRequestId });
        }
        return;
      }

      // Response to a request
      if (msg.id) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);
          if (msg.success) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error || "Unknown Crawl4AI error"));
          }
        }
      }
    } catch {
      // Non-JSON message from stdout
    }
  }

  private sendCancelAndAwaitSettlement(targetRequestId: string): Promise<{ settled: boolean; state: string }> {
    if (!this.workerProcess?.stdin?.writable) {
      return Promise.resolve({ settled: false, state: "worker_stdin_not_writable" });
    }
    return new Promise<{ settled: boolean; state: string }>((resolve) => {
      const cancelId = globalThis.crypto.randomUUID();
      const cancelTimeout = setTimeout(() => {
        this.pendingRequests.delete(cancelId);
        resolve({ settled: false, state: "cancellation_timeout" });
      }, 5000);
      this.pendingRequests.set(cancelId, {
        resolve: (data: any) => {
          clearTimeout(cancelTimeout);
          const isTargetMatch = data?.targetRequestId === targetRequestId;
          const isSettled = isTargetMatch && data?.settled === true;
          resolve({
            settled: isSettled,
            state: data?.state ?? (isSettled ? "settled" : "pending_cleanup"),
          });
        },
        reject: (err: any) => {
          clearTimeout(cancelTimeout);
          resolve({ settled: false, state: `cancellation_error: ${err?.message ?? String(err)}` });
        },
        timer: cancelTimeout,
      });
      try {
        const cancelPayload = JSON.stringify({
          id: cancelId,
          action: "cancel",
          params: { targetRequestId },
        }) + "\n";
        const stdin = this.workerProcess?.stdin;
        if (!stdin) {
          clearTimeout(cancelTimeout);
          this.pendingRequests.delete(cancelId);
          resolve({ settled: false, state: "worker_stdin_missing" });
          return;
        }
        stdin.write(cancelPayload, "utf-8", (err) => {
          if (err) {
            clearTimeout(cancelTimeout);
            this.pendingRequests.delete(cancelId);
            resolve({ settled: false, state: `write_error: ${err.message}` });
          }
        });
      } catch (err: any) {
        clearTimeout(cancelTimeout);
        this.pendingRequests.delete(cancelId);
        resolve({ settled: false, state: `write_exception: ${err?.message ?? String(err)}` });
      }
    });
  }

  private async sendRequest<T>(
    message: { id: string; action: string; params?: Record<string, unknown> },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.workerProcess?.stdin?.writable) {
      throw new Error("Crawl4AI worker stdin is not writable");
    }

    if (signal?.aborted) {
      throw new Error("Request aborted before sending");
    }

    return new Promise<T>((resolve, reject) => {
      let aborting = false;

      const timer = setTimeout(async () => {
        if (aborting) return;
        aborting = true;
        if (signal) signal.removeEventListener("abort", abortHandler);
        let settlement = { settled: false, state: "timeout" };
        try {
          settlement = await this.sendCancelAndAwaitSettlement(message.id);
        } finally {
          this.pendingRequests.delete(message.id);
          const err = new Error(`Crawl4AI request "${message.action}" timed out after ${timeoutMs}ms`) as any;
          err.cancelSettled = settlement.settled;
          err.cancelState = settlement.state;
          reject(err);
        }
      }, timeoutMs);

      const abortHandler = async () => {
        if (aborting) return;
        aborting = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abortHandler);
        let settlement = { settled: false, state: "aborted" };
        try {
          settlement = await this.sendCancelAndAwaitSettlement(message.id);
        } finally {
          this.pendingRequests.delete(message.id);
          const err = new Error("Request aborted by caller") as any;
          err.cancelSettled = settlement.settled;
          err.cancelState = settlement.state;
          reject(err);
        }
      };

      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.pendingRequests.set(message.id, {
        resolve: (data) => {
          if (signal) signal.removeEventListener("abort", abortHandler);
          resolve(data);
        },
        reject: (err) => {
          if (signal) signal.removeEventListener("abort", abortHandler);
          reject(err);
        },
        timer,
      });

      const payload = JSON.stringify(message) + "\n";
      this.workerProcess!.stdin!.write(payload, "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", abortHandler);
          this.pendingRequests.delete(message.id);
          reject(err);
        }
      });
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    if (this.idleTimeoutMs > 0 && !this.isShutdown) {
      this.idleTimer = setTimeout(() => {
        this.handleIdleShutdown();
      }, this.idleTimeoutMs);
    }
  }

  private async handleIdleShutdown(): Promise<void> {
    if (!this.workerProcess || this.isShutdown) return;
    if (this.pendingRequests.size > 0) {
      // Requests still in flight, extend timer
      this.resetIdleTimer();
      return;
    }

    this.diagnostic({ event: "crawl4ai.worker_idle_shutdown" });
    try {
      await this.sendRequest({ id: "idle-shutdown", action: "shutdown" }, 3000);
    } catch {
      // If graceful shutdown fails, force kill
      this.workerProcess?.kill("SIGTERM");
    }
  }

  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    if (this.workerProcess && !this.workerProcess.killed) {
      const child = this.workerProcess;
      const exitPromise = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });

      try {
        await this.sendRequest({ id: "shutdown", action: "shutdown" }, 3000);
      } catch {
        child.kill("SIGTERM");
      }

      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))]);
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      this.workerProcess = undefined;
      this.workerReady = false;
    }

    if (this.resourceGovernor && this.retainedLeaseIds.size > 0) {
      for (const leaseId of this.retainedLeaseIds) {
        try {
          this.resourceGovernor.releaseLease(leaseId);
        } catch {}
      }
      this.retainedLeaseIds.clear();
    }
    this.requestToLeaseMap.clear();
    this.cache.clear();
    this.currentCacheSizeBytes = 0;
  }

  private diagnostic(data: Record<string, unknown>): void {
    this.onDiagnostic?.({
      timestamp: Date.now(),
      component: "crawl4ai-runtime",
      ...data,
    });
  }
}
