import React, { useState } from 'react';
import { ComputerActionData, PerceptionData } from '../../types';
import { Eye, MousePointer, Monitor, ChevronRight, ChevronDown } from 'lucide-react';

export const PerceptionView: React.FC<{
  computerAction?: ComputerActionData;
  perception?: PerceptionData;
}> = ({ computerAction, perception }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!computerAction && !perception) return null;

  return (
    <div className="my-2 border border-[#2b2b34] rounded-lg overflow-hidden bg-[#16161b] text-xs">
      <div
        onClick={() => setIsOpen((p) => !p)}
        className="flex items-center justify-between px-3 py-2 bg-[#1d1d23] hover:bg-[#222228] cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-neutral-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-neutral-400" />
          )}

          {perception ? (
            <Eye className="w-3.5 h-3.5 text-sky-400" />
          ) : (
            <MousePointer className="w-3.5 h-3.5 text-purple-400" />
          )}

          <span className="text-neutral-200 font-medium">
            {perception ? `Perception Snapshot: ${perception.focusedApp}` : `Computer Action: ${computerAction?.action}`}
          </span>
        </div>

        {perception?.confidenceScore && (
          <span className="text-[10px] text-neutral-400 font-mono">
            {(perception.confidenceScore * 100).toFixed(0)}% confidence
          </span>
        )}
      </div>

      {isOpen && (
        <div className="p-3 bg-[#131317] border-t border-[#26262e] space-y-2 text-[11px] text-neutral-300">
          {perception && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-neutral-400">
                <Monitor className="w-3.5 h-3.5" />
                <span className="font-mono">{perception.windowTitle}</span>
              </div>
              <p className="text-neutral-300">{perception.visualSummary}</p>
              <div className="text-[10px] text-neutral-500 font-mono">
                Detected interactive bounding boxes: {perception.detectedElementsCount}
              </div>
            </div>
          )}

          {computerAction && (
            <div className="font-mono text-neutral-300">
              <span>Action: </span>
              <span className="text-purple-300 font-semibold">{computerAction.action}</span>
              {computerAction.keys && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-[#202028] text-neutral-200">
                  {computerAction.keys}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
