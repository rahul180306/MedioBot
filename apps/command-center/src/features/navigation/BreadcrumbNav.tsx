import React, { useState, useRef, useEffect } from 'react';
import { useApp } from '../../state/AppContext';
import { GitBranch, Folder, ChevronDown, Check, MessageSquare, Sparkles, Pencil } from 'lucide-react';

export const BreadcrumbNav: React.FC = () => {
  const {
    activeProject,
    activeBranch,
    setActiveBranch,
    projects,
    setActiveProjectId,
    activeThread,
    renameThread,
    regenerateThreadTitle,
  } = useApp();

  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [isProjectMenuOpen, setIsProjectMenuOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');

  const branchMenuRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeThread) {
      setTitleInput(activeThread.title);
      setIsEditingTitle(false);
    }
  }, [activeThread?.id, activeThread?.title]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setIsBranchMenuOpen(false);
      }
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setIsProjectMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSaveTitle = () => {
    if (activeThread && titleInput.trim()) {
      renameThread(activeThread.id, titleInput.trim());
    }
    setIsEditingTitle(false);
  };

  return (
    <nav
      aria-label="Breadcrumb navigation"
      className="flex items-center gap-1 text-xs text-neutral-400 ml-2 select-none min-w-0"
    >
      {/* 1. Project Segment */}
      <div className="relative" ref={projectMenuRef}>
        <button
          onClick={() => setIsProjectMenuOpen((p) => !p)}
          className="flex items-center gap-1.5 px-1.5 py-1 rounded text-neutral-300 hover:text-white hover:bg-[#1f1f24] transition-colors focus-visible:ring-1 focus-visible:ring-neutral-500 outline-none"
          title={`Project: ${activeProject.name}`}
        >
          <Folder className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
          <span className="font-medium tracking-tight truncate max-w-[130px]">
            {activeProject.name}
          </span>
          <ChevronDown className="w-3 h-3 text-neutral-500 opacity-60 hover:opacity-100 shrink-0" />
        </button>

        {isProjectMenuOpen && (
          <div className="absolute left-0 top-full mt-1 w-48 bg-[#1a1a1f] border border-[#2b2b34] rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2.5 py-1 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
              Switch Project
            </div>
            {projects.map((proj) => (
              <button
                key={proj.id}
                onClick={() => {
                  setActiveProjectId(proj.id);
                  setIsProjectMenuOpen(false);
                }}
                className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-[#25252e] transition-colors text-left"
              >
                <div className="truncate pr-2">
                  <div className="font-medium text-neutral-200 truncate">{proj.name}</div>
                  <div className="text-[10px] text-neutral-500 font-mono truncate">{proj.environment}</div>
                </div>
                {proj.id === activeProject.id && (
                  <Check className="w-3.5 h-3.5 text-neutral-200 shrink-0" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Separator */}
      <span className="text-neutral-600 font-mono text-[11px] select-none" aria-hidden="true">
        /
      </span>

      {/* 2. Branch Segment */}
      <div className="relative" ref={branchMenuRef}>
        <button
          onClick={() => setIsBranchMenuOpen((p) => !p)}
          className="flex items-center gap-1 px-1.5 py-1 rounded text-neutral-400 hover:text-neutral-200 hover:bg-[#1f1f24] transition-colors focus-visible:ring-1 focus-visible:ring-neutral-500 outline-none"
          title={`Branch: ${activeBranch}`}
        >
          <GitBranch className="w-3 h-3 text-neutral-500 shrink-0" />
          <span className="font-mono text-[11px] text-neutral-300 truncate max-w-[120px]">
            {activeBranch}
          </span>
          <ChevronDown className="w-3 h-3 text-neutral-500 opacity-60 hover:opacity-100 shrink-0" />
        </button>

        {isBranchMenuOpen && (
          <div className="absolute left-0 top-full mt-1 w-44 bg-[#1a1a1f] border border-[#2b2b34] rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2.5 py-1 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
              Branches
            </div>
            {activeProject.branches.map((b) => (
              <button
                key={b}
                onClick={() => {
                  setActiveBranch(b);
                  setIsBranchMenuOpen(false);
                }}
                className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-[#25252e] transition-colors text-left font-mono text-[11px]"
              >
                <span className="truncate">{b}</span>
                {b === activeBranch && (
                  <Check className="w-3.5 h-3.5 text-neutral-200 shrink-0" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 3. Thread Segment (concise generated title) */}
      {activeThread && (
        <>
          <span className="text-neutral-600 font-mono text-[11px] select-none" aria-hidden="true">
            /
          </span>
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded group hover:bg-[#1f1f24] transition-colors min-w-0">
            {isEditingTitle ? (
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTitle();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                onBlur={handleSaveTitle}
                autoFocus
                className="bg-[#17171c] text-white text-xs px-2 py-0.5 rounded border border-neutral-600 outline-none w-48 font-medium"
              />
            ) : (
              <>
                <MessageSquare className="w-3 h-3 text-neutral-500 shrink-0 hidden sm:block" />
                <span
                  onClick={() => setIsEditingTitle(true)}
                  className="text-neutral-200 font-medium truncate max-w-[140px] sm:max-w-[240px] md:max-w-[340px] cursor-pointer"
                  title={`${activeThread.title} (Click to edit)`}
                >
                  {activeThread.title}
                </span>

                {/* Micro Action: Regenerate Title or Edit */}
                <div className="items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity hidden sm:flex shrink-0">
                  <button
                    onClick={() => regenerateThreadTitle(activeThread.id)}
                    title="Auto-regenerate concise title from prompt"
                    className="p-1 rounded text-neutral-500 hover:text-amber-300 hover:bg-[#282832] transition-colors"
                  >
                    <Sparkles className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setIsEditingTitle(true)}
                    title="Edit title"
                    className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-[#282832] transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </nav>
  );
};

