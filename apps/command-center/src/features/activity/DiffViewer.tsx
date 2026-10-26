import React, { useState } from 'react';
import { FileDiff } from '../../types';
import { ChevronDown, ChevronRight, FileCode, Copy, Check } from 'lucide-react';
import { useApp } from '../../state/AppContext';

export const DiffViewer: React.FC<{ diff: FileDiff }> = ({ diff }) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const [isExpanded, setIsExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = diff.hunks
      ?.map((h) => h.lines.map((l) => (l.type === 'add' ? `+ ${l.content}` : l.type === 'remove' ? `- ${l.content}` : `  ${l.content}`)).join('\n'))
      .join('\n');
    if (content) {
      navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className={`my-2 border ${
      isLight ? 'border-[#e2e4e8] bg-white shadow-xs' : 'border-[#2b2b32] bg-[#18181c]'
    } rounded-lg overflow-hidden text-xs font-mono`}>
      {/* File Diff Header */}
      <div
        onClick={() => setIsExpanded((p) => !p)}
        className={`flex items-center justify-between px-3 py-2 ${
          isLight ? 'bg-[#f8f9fa] hover:bg-[#f1f2f5] border-b border-[#e2e4e8]' : 'bg-[#202025] hover:bg-[#24242a] border-b border-[#2b2b32]'
        } cursor-pointer select-none transition-colors`}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className={`w-3.5 h-3.5 ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`} />
          ) : (
            <ChevronRight className={`w-3.5 h-3.5 ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`} />
          )}
          <FileCode className={`w-3.5 h-3.5 ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`} />
          <span className={`${isLight ? 'text-[#09090b]' : 'text-neutral-200'} font-medium truncate`}>{diff.filePath}</span>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Additions / Deletions */}
          <div className="flex items-center gap-1.5 tabular-nums text-[11px]">
            <span className={isLight ? 'text-emerald-700 font-semibold' : 'text-emerald-400'}>+{diff.additions}</span>
            <span className={isLight ? 'text-rose-700 font-semibold' : 'text-rose-400'}>-{diff.deletions}</span>
          </div>

          <button
            onClick={handleCopy}
            title="Copy diff"
            className={`p-1 rounded ${
              isLight ? 'text-[#64748b] hover:text-[#09090b] hover:bg-[#eaebee]' : 'text-neutral-400 hover:text-white hover:bg-[#2e2e36]'
            } transition-colors`}
          >
            {copied ? <Check className={`w-3 h-3 ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`} /> : <Copy className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Code Hunks */}
      {isExpanded && diff.hunks && (
        <div className="overflow-x-auto text-[11px] leading-5 py-1">
          {diff.truncated && (
            <div className={`px-3 py-1 ${isLight ? 'text-[#64748b]' : 'text-neutral-500'} font-sans`}>
              Large diff excerpt; addition and deletion totals are exact.
            </div>
          )}
          {diff.hunks.map((hunk, hIdx) => (
            <div key={hIdx}>
              <div className={`px-3 py-0.5 ${
                isLight ? 'bg-[#f1f2f5] text-[#64748b]' : 'bg-[#1f1f26] text-neutral-500'
              } font-semibold select-none text-[10px]`}>
                {hunk.header}
              </div>
              {hunk.lines.map((line, lIdx) => {
                const isAdd = line.type === 'add';
                const isRemove = line.type === 'remove';
                return (
                  <div
                    key={lIdx}
                    className={`flex items-start px-2 font-mono ${
                      isAdd
                        ? isLight ? 'bg-emerald-50 text-emerald-800' : 'bg-emerald-950/25 text-emerald-300'
                        : isRemove
                        ? isLight ? 'bg-rose-50 text-rose-800 line-through opacity-90' : 'bg-rose-950/25 text-rose-300 line-through opacity-85'
                        : isLight ? 'text-[#334155] hover:bg-[#f8f9fa]' : 'text-neutral-400 hover:bg-[#1d1d23]'
                    }`}
                  >
                    {/* Line numbers */}
                    <span className={`w-7 shrink-0 text-right pr-2 select-none ${isLight ? 'text-[#94a3b8]' : 'text-neutral-600'} tabular-nums`}>
                      {line.oldLineNo ?? ''}
                    </span>
                    <span className={`w-7 shrink-0 text-right pr-2 select-none ${isLight ? 'text-[#94a3b8]' : 'text-neutral-600'} tabular-nums`}>
                      {line.newLineNo ?? ''}
                    </span>
                    {/* Prefix */}
                    <span className="w-4 shrink-0 text-center select-none font-bold">
                      {isAdd ? '+' : isRemove ? '-' : ' '}
                    </span>
                    {/* Code Content */}
                    <span className="whitespace-pre overflow-x-auto">{line.content}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
