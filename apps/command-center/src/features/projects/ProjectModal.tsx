import React, { useState } from 'react';
import { useApp } from '../../state/AppContext';
import { X, Folder, Check, GitBranch, Plus } from 'lucide-react';

export const ProjectModal: React.FC = () => {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    addProject,
    setActiveModal,
  } = useApp();

  const [newProjectPath, setNewProjectPath] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState('');

  const handleSelect = (id: string) => {
    setActiveProjectId(id);
    setActiveModal(null);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectPath.trim()) return;
    setError('');
    try {
      await addProject(newProjectPath.trim());
      setActiveModal(null);
      setIsAdding(false);
      setNewProjectPath('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That project could not be opened.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 select-none">
      <div className="w-full max-w-md bg-[#18181d] border border-[#2b2b34] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#24242c]">
          <div className="flex items-center gap-2">
            <Folder className="w-4 h-4 text-neutral-400" />
            <span className="text-sm font-semibold text-neutral-100">Select Project</span>
          </div>
          <button
            onClick={() => setActiveModal(null)}
            className="text-neutral-400 hover:text-white p-1 rounded hover:bg-[#25252e] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Project List */}
        <div className="p-3 space-y-1 max-h-[300px] overflow-y-auto">
          {projects.map((proj) => {
            const isSelected = proj.id === activeProjectId;
            return (
              <button
                key={proj.id}
                onClick={() => handleSelect(proj.id)}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] text-left cursor-pointer ${
                  isSelected
                    ? 'bg-[#32313a] text-white font-medium border border-white/10 shadow-xs'
                    : 'text-neutral-300 hover:bg-[#2c2b35] hover:text-white border border-transparent'
                }`}
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{proj.name}</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      {proj.environment}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                    <span className="font-mono truncate">{proj.path}</span>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3 text-neutral-500" />
                      {proj.branch}
                    </span>
                  </div>
                </div>

                {isSelected && <Check className="w-4 h-4 text-neutral-200 shrink-0" />}
              </button>
            );
          })}
        </div>

        {/* Add Project Form */}
        <div className="p-3 border-t border-[#24242c] bg-[#141418]">
          {isAdding ? (
            <form onSubmit={handleCreate} className="space-y-2">
              <input
                type="text"
                value={newProjectPath}
                onChange={(e) => setNewProjectPath(e.target.value)}
                aria-label="Local project folder path"
                placeholder="Local folder path (for example /Users/me/project)"
                autoFocus
                className="w-full bg-[#1b1b22] text-xs text-white placeholder-neutral-500 rounded px-2.5 py-1.5 outline-none border border-[#30303c] focus:border-neutral-400"
              />
              {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-2.5 py-1 rounded text-xs text-neutral-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 bg-neutral-200 hover:bg-white text-neutral-900 font-medium rounded text-xs transition-colors"
                >
                  Add Project
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setIsAdding(true)}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Link new repository</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
