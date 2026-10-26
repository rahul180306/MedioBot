import React, { useEffect, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { useApp } from '../state/AppContext';

export interface DeletingRowProps {
  label?: string;
  undoWindow?: number; // 8 seconds default
  onUndo: () => void;
  onFuseEnd: () => void;
  className?: string;
}

export const DeletingRow: React.FC<DeletingRowProps> = ({
  label = 'Deleting...',
  undoWindow = 8000,
  onUndo,
  onFuseEnd,
  className = '',
}) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      onFuseEnd();
    }, undoWindow);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [undoWindow, onFuseEnd]);

  const handleUndo = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (timerRef.current) clearTimeout(timerRef.current);
    onUndo();
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={`relative w-full rounded-2xl p-1 border transition-all select-none overflow-hidden ${
        isLight
          ? 'bg-[#f4f4f7] border-[#e2e4e8] shadow-xs'
          : 'bg-[#232227] border-[#34333e] shadow-md'
      } ${className}`}
    >
      {/* Inner Red Border Box matching exact reference image */}
      <div
        className={`relative w-full rounded-xl px-3 py-1.5 flex items-center justify-between border overflow-hidden ${
          isLight
            ? 'bg-rose-50/90 border-rose-400 text-rose-950'
            : 'bg-[#2f1922] border-rose-500/80 text-white'
        }`}
      >
        {/* Burning Red Fuse Line Animation over 8s */}
        <div
          className="absolute inset-x-0 bottom-0 h-[2px] bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9)] animate-fuse-burn origin-left"
          style={{ animationDuration: `${undoWindow}ms` }}
        />

        {/* Left Deleting label */}
        <span className="text-[13px] font-medium tracking-tight truncate pr-2">
          {label}
        </span>

        {/* Right Bright Red Solid Undo Button with Undo Icon */}
        <button
          type="button"
          onClick={handleUndo}
          className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-xl bg-[#ff3b30] hover:bg-[#e03126] text-white text-[12px] font-semibold shadow-md active:scale-95 transition-all cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5 stroke-[2.5]" />
          <span>Undo</span>
        </button>
      </div>
    </div>
  );
};
