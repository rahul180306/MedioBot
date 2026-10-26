import React, { useEffect, useRef } from "react";
import { FilePlus, FolderPlus, Edit2, Trash2, RotateCw, Copy, Minimize2, FileCode } from "lucide-react";
import { useApp } from "../../state/AppContext";

export type ContextMenuTarget =
  | { type: "root"; path: string; name: string }
  | { type: "folder"; path: string; name: string }
  | { type: "file"; path: string; name: string };

interface ExplorerContextMenuProps {
  target: ContextMenuTarget;
  x: number;
  y: number;
  onClose: () => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onRename?: (path: string, name: string) => void;
  onDelete?: (path: string, name: string, isFolder: boolean) => void;
  onRefresh?: () => void;
  onCollapseAll?: () => void;
  onOpen?: (path: string, name: string) => void;
}

export const ExplorerContextMenu: React.FC<ExplorerContextMenuProps> = ({
  target,
  x,
  y,
  onClose,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onRefresh,
  onCollapseAll,
  onOpen,
}) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const copyPath = () => {
    void navigator.clipboard.writeText(target.path);
    onClose();
  };

  const btnClass = `w-full flex items-center gap-2 px-3 py-2 text-left rounded-xl text-[12.5px] font-medium transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer ${
    isLight ? 'hover:bg-[#eaebee] text-[#18181b] hover:text-[#09090b]' : 'hover:bg-[#32313a] text-neutral-300 hover:text-white'
  }`;
  const sepClass = `h-px ${isLight ? 'bg-[#e2e4e8]' : 'bg-[#2b2a33]'} my-1`;

  return (
    <div
      ref={menuRef}
      style={{ top: `${y}px`, left: `${x}px` }}
      className={`fixed z-50 min-w-[170px] p-1.5 ${
        isLight
          ? 'bg-white border-[#dcdce2] text-[#18181b] shadow-xl'
          : 'bg-[#1e1d23] border-[#32313a] text-neutral-200 shadow-2xl'
      } border rounded-2xl text-[12px] select-none animate-in fade-in zoom-in-95`}
    >
      {target.type === "root" && (
        <>
          <button
            onClick={() => { onNewFile(""); onClose(); }}
            className={btnClass}
          >
            <FilePlus className="w-3.5 h-3.5 text-neutral-400" />
            <span>New File</span>
          </button>
          <button
            onClick={() => { onNewFolder(""); onClose(); }}
            className={btnClass}
          >
            <FolderPlus className="w-3.5 h-3.5 text-neutral-400" />
            <span>New Folder</span>
          </button>
          <div className={sepClass} />
          <button
            onClick={() => { onRefresh?.(); onClose(); }}
            className={btnClass}
          >
            <RotateCw className="w-3.5 h-3.5 text-neutral-400" />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => { onCollapseAll?.(); onClose(); }}
            className={btnClass}
          >
            <Minimize2 className="w-3.5 h-3.5 text-neutral-400" />
            <span>Collapse All</span>
          </button>
          <div className={sepClass} />
          <button
            onClick={copyPath}
            className={btnClass}
          >
            <Copy className="w-3.5 h-3.5 text-neutral-400" />
            <span>Copy Path</span>
          </button>
        </>
      )}

      {target.type === "folder" && (
        <>
          <button
            onClick={() => { onNewFile(target.path); onClose(); }}
            className={btnClass}
          >
            <FilePlus className="w-3.5 h-3.5 text-neutral-400" />
            <span>New File</span>
          </button>
          <button
            onClick={() => { onNewFolder(target.path); onClose(); }}
            className={btnClass}
          >
            <FolderPlus className="w-3.5 h-3.5 text-neutral-400" />
            <span>New Folder</span>
          </button>
          <div className={sepClass} />
          <button
            onClick={() => { onRename?.(target.path, target.name); onClose(); }}
            className={btnClass}
          >
            <Edit2 className="w-3.5 h-3.5 text-neutral-400" />
            <span>Rename</span>
          </button>
          <button
            onClick={() => { onDelete?.(target.path, target.name, true); onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-medium hover:bg-rose-500/20 text-rose-300 text-left transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            <span>Delete</span>
          </button>
          <div className={sepClass} />
          <button
            onClick={() => { onRefresh?.(); onClose(); }}
            className={btnClass}
          >
            <RotateCw className="w-3.5 h-3.5 text-neutral-400" />
            <span>Refresh</span>
          </button>
        </>
      )}

      {target.type === "file" && (
        <>
          <button
            onClick={() => { onOpen?.(target.path, target.name); onClose(); }}
            className={btnClass}
          >
            <FileCode className="w-3.5 h-3.5 text-neutral-400" />
            <span>Open</span>
          </button>
          <button
            onClick={() => { onRename?.(target.path, target.name); onClose(); }}
            className={btnClass}
          >
            <Edit2 className="w-3.5 h-3.5 text-neutral-400" />
            <span>Rename</span>
          </button>
          <button
            onClick={() => { onDelete?.(target.path, target.name, false); onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[12.5px] font-medium hover:bg-rose-500/20 text-rose-300 text-left transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            <span>Delete</span>
          </button>
          <div className={sepClass} />
          <button
            onClick={copyPath}
            className={btnClass}
          >
            <Copy className="w-3.5 h-3.5 text-neutral-400" />
            <span>Copy Relative Path</span>
          </button>
        </>
      )}
    </div>
  );
};
