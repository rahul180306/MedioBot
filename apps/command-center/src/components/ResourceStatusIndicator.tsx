import React, { useEffect, useState } from 'react';
import { Cpu, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { ResourceGovernorStatus } from '@mediobot-v2/contracts';

export const ResourceStatusIndicator: React.FC<{ isLight?: boolean }> = ({ isLight = false }) => {
  const [status, setStatus] = useState<ResourceGovernorStatus | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/system/resources');
        if (res.ok) {
          const data = (await res.json()) as ResourceGovernorStatus;
          if (mounted) setStatus(data);
        }
      } catch {
        // silent fail if server is reloading
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  if (!status) return null;

  const pressure = status.memoryPressureState;
  const isCritical = pressure === 'critical';
  const isElevated = pressure === 'elevated';

  const dotColor = isCritical
    ? 'bg-rose-500'
    : isElevated
    ? 'bg-amber-400'
    : 'bg-emerald-400/80';

  const usedMemGb = Math.round(
    (status.telemetry.totalMemoryBytes - status.telemetry.freeMemoryBytes) / (1024 * 1024 * 1024)
  );
  const totalMemGb = Math.round(status.telemetry.totalMemoryBytes / (1024 * 1024 * 1024));

  return (
    <div
      className="relative flex items-center"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div
        className={`flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono select-none transition-colors border cursor-default ${
          isLight
            ? 'border-[#dcdce2] bg-[#f4f4f7] text-[#4b4a54]'
            : 'border-[#2b2b30] bg-[#1c1b20] text-neutral-300'
        }`}
        title="MedioBot Resource Governor"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
        <span className="text-[10px] tracking-tight">
          {status.activeLeases.executionSlots}/{status.effectiveConcurrencyLimit}
        </span>
      </div>

      {showTooltip && (
        <div
          className={`absolute right-0 top-full mt-1.5 z-50 w-52 p-2.5 rounded-lg border text-xs shadow-xl backdrop-blur-md transition-all ${
            isLight
              ? 'bg-white/95 border-[#dcdce2] text-[#1c1b20]'
              : 'bg-[#18181b]/95 border-[#2e2e34] text-neutral-200'
          }`}
        >
          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/10 font-sans font-medium text-[11px]">
            <span className="flex items-center gap-1 text-neutral-400">
              <Cpu className="w-3 h-3" /> Resource Governor
            </span>
            <span
              className={`text-[10px] font-semibold uppercase px-1 py-0.5 rounded ${
                isCritical
                  ? 'bg-rose-500/20 text-rose-400'
                  : isElevated
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-emerald-500/20 text-emerald-400'
              }`}
            >
              {pressure}
            </span>
          </div>

          <div className="space-y-1 font-mono text-[10.5px]">
            <div className="flex justify-between">
              <span className="text-neutral-400">Concurrency:</span>
              <span>
                {status.activeLeases.executionSlots} / {status.effectiveConcurrencyLimit} active
              </span>
            </div>
            {status.queuedTasksCount > 0 && (
              <div className="flex justify-between text-amber-400">
                <span>Queued Tasks:</span>
                <span>{status.queuedTasksCount}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-neutral-400">Subprocesses:</span>
              <span>{status.activeLeases.subprocesses}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Browser Sessions:</span>
              <span>{status.activeLeases.browserSessions}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">System RAM:</span>
              <span>
                {usedMemGb}G / {totalMemGb}G ({status.telemetry.usedMemoryPercent}%)
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Backend process RSS:</span>
              <span>
                {Math.round(status.telemetry.processRssBytes / (1024 * 1024))} MB
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">System CPU:</span>
              <span>{status.telemetry.systemCpuPercent === undefined ? 'Sampling' : `${status.telemetry.systemCpuPercent}%`}</span>
            </div>
            {status.telemetry.platform !== 'win32' && (
            <div className="flex justify-between">
              <span className="text-neutral-400">Load Avg (1m):</span>
              <span>{status.telemetry.loadAverage1m}</span>
            </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
