import os from "node:os";
import { execSync } from "node:child_process";
import type { MemoryPressureState, SystemResourceTelemetry } from "@mediobot-v2/contracts";

export interface CpuTimeSnapshot {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

/** Returns system-wide CPU busy percent for the interval between valid snapshots. */
export function calculateSystemCpuPercent(previous: readonly CpuTimeSnapshot[] | undefined,
  current: readonly CpuTimeSnapshot[] | undefined): number | undefined {
  if (!previous || !current || previous.length === 0 || previous.length !== current.length) return undefined;
  let busyDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!;
    const after = current[index]!;
    const beforeTotal = before.user + before.nice + before.sys + before.idle + before.irq;
    const afterTotal = after.user + after.nice + after.sys + after.idle + after.irq;
    const deltaTotal = afterTotal - beforeTotal;
    const deltaIdle = after.idle - before.idle;
    if (!Number.isFinite(deltaTotal) || !Number.isFinite(deltaIdle) || deltaTotal < 0 || deltaIdle < 0 || deltaIdle > deltaTotal) {
      return undefined;
    }
    totalDelta += deltaTotal;
    busyDelta += deltaTotal - deltaIdle;
  }
  if (totalDelta <= 0) return undefined;
  return Math.round(Math.max(0, Math.min(100, (busyDelta / totalDelta) * 100)) * 10) / 10;
}

function captureCpuTimes(): CpuTimeSnapshot[] | undefined {
  const cpus = os.cpus();
  if (cpus.length === 0) return undefined;
  return cpus.map(({ times }) => ({ user: times.user, nice: times.nice, sys: times.sys, idle: times.idle, irq: times.irq }));
}

export interface TelemetryCollectorOptions {
  /** Optional override for testing */
  readonly sampleIntervalMs?: number;
  readonly mockTelemetry?: () => Partial<SystemResourceTelemetry>;
}

export class SystemResourceTelemetryCollector {
  private lastSample?: SystemResourceTelemetry;
  private lastSampledAt = 0;
  private readonly sampleIntervalMs: number;
  private readonly mockTelemetry?: () => Partial<SystemResourceTelemetry>;
  private previousCpuTimes?: readonly CpuTimeSnapshot[];
  private previousCpuSampledAt: number;

  constructor(options: TelemetryCollectorOptions = {}) {
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1000;
    this.mockTelemetry = options.mockTelemetry;
    this.previousCpuSampledAt = Date.now();
    if (!this.mockTelemetry) this.previousCpuTimes = captureCpuTimes();
  }

  collect(forceFresh = false): SystemResourceTelemetry {
    const now = Date.now();
    if (!forceFresh && !this.mockTelemetry && this.lastSample && now - this.lastSampledAt < this.sampleIntervalMs) {
      return this.lastSample;
    }

    if (this.mockTelemetry) {
      const mock = this.mockTelemetry();
      const base: SystemResourceTelemetry = {
        platform: mock.platform ?? process.platform,
        cpuCount: mock.cpuCount ?? 8,
        loadAverage1m: mock.loadAverage1m ?? 1.0,
        totalMemoryBytes: mock.totalMemoryBytes ?? 16 * 1024 * 1024 * 1024,
        freeMemoryBytes: mock.freeMemoryBytes ?? 8 * 1024 * 1024 * 1024,
        usedMemoryPercent: mock.usedMemoryPercent ?? 50,
        processRssBytes: mock.processRssBytes ?? 200 * 1024 * 1024,
        processHeapUsedBytes: mock.processHeapUsedBytes ?? 100 * 1024 * 1024,
        ...(mock.systemCpuPercent !== undefined ? { systemCpuPercent: mock.systemCpuPercent } : {}),
        memoryPressureState: mock.memoryPressureState ?? "normal",
        timestamp: now,
        macDetails: mock.macDetails,
      };
      this.lastSample = base;
      this.lastSampledAt = now;
      return base;
    }

    const totalMemory = os.totalmem();
    const rawFree = os.freemem();
    let macDetails: SystemResourceTelemetry["macDetails"] | undefined;
    if (process.platform === "darwin") {
      macDetails = this.sampleMacMemory();
    }

    const availableMemory = (process.platform === "darwin" && macDetails?.inactiveBytes)
      ? rawFree + macDetails.inactiveBytes
      : rawFree;
    const usedMemory = Math.max(0, totalMemory - availableMemory);
    const usedMemoryPercent = totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0;
    const memUsage = process.memoryUsage();
    const cpuTimes = captureCpuTimes();
    const cpuCount = cpuTimes?.length ?? 1;
    // Avoid basing admission on a tiny, noisy startup interval. Only publish a
    // CPU sample after one complete telemetry interval has elapsed.
    const cpuSampleElapsedMs = now - this.previousCpuSampledAt;
    const hasCpuSampleInterval = cpuSampleElapsedMs >= this.sampleIntervalMs;
    const systemCpuPercent = hasCpuSampleInterval
      ? calculateSystemCpuPercent(this.previousCpuTimes, cpuTimes)
      : undefined;
    if (hasCpuSampleInterval) {
      this.previousCpuTimes = cpuTimes;
      this.previousCpuSampledAt = now;
    }
    const loadAvg = os.loadavg();
    const firstLoad = loadAvg[0];
    const load1m = typeof firstLoad === "number" ? firstLoad : 0;

    let pressureState: MemoryPressureState = "normal";
    // Realistic cross-platform & macOS thresholds:
    // Critical: Available memory < 6% OR process RSS > 3GB
    // Elevated: Available memory < 14% OR 1m load > 3.0x CPU count
    if ((availableMemory / totalMemory) < 0.06 || memUsage.rss > 3 * 1024 * 1024 * 1024) {
      pressureState = "critical";
    } else if ((availableMemory / totalMemory) < 0.14 || load1m > cpuCount * 3.0) {
      pressureState = "elevated";
    }

    const telemetry: SystemResourceTelemetry = {
      platform: process.platform,
      cpuCount,
      loadAverage1m: Math.round(load1m * 100) / 100,
      totalMemoryBytes: totalMemory,
      freeMemoryBytes: availableMemory,
      usedMemoryPercent: Math.round(usedMemoryPercent * 10) / 10,
      processRssBytes: memUsage.rss,
      processHeapUsedBytes: memUsage.heapUsed,
      ...(systemCpuPercent !== undefined ? { systemCpuPercent } : {}),
      memoryPressureState: pressureState,
      timestamp: now,
      macDetails,
    };

    this.lastSample = telemetry;
    this.lastSampledAt = now;
    return telemetry;
  }

  private sampleMacMemory(): SystemResourceTelemetry["macDetails"] | undefined {
    try {
      // Fast vm_stat sample
      const output = execSync("vm_stat", { encoding: "utf8", timeout: 200, stdio: ["ignore", "pipe", "ignore"] });
      const pageSizeMatch = output.match(/page size of (\d+) bytes/);
      const pageSizeStr = pageSizeMatch ? pageSizeMatch[1] : undefined;
      const pageSize = pageSizeStr ? Number.parseInt(pageSizeStr, 10) : 4096;

      const parsePages = (prefix: string): number => {
        const match = output.match(new RegExp(`${prefix}:\\s+(\\d+)\\.`));
        const matchedPages = match ? match[1] : undefined;
        return matchedPages ? Number.parseInt(matchedPages, 10) * pageSize : 0;
      };

      const active = parsePages("Pages active");
      const inactive = parsePages("Pages inactive");
      const wired = parsePages("Pages wired down");
      const compressed = parsePages("Pages occupied by compressor");

      return {
        activeBytes: active,
        inactiveBytes: inactive,
        wiredBytes: wired,
        compressedBytes: compressed,
      };
    } catch {
      return undefined;
    }
  }
}
