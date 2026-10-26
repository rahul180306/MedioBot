import React, { useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Folder, Pencil, Trash2 } from 'lucide-react';
import { FileNode } from '../../types';
import { FileIcon, FolderIcon } from '../../components/icons/FileIcon';
import { ExplorerInlineNameEditor } from './ExplorerInlineNameEditor';
import type { ContextMenuTarget } from './ExplorerContextMenu';
import './BranchedExplorerTree.css';

const MARK = 18;

interface BranchedExplorerTreeProps {
  nodes: FileNode[];
  activeProjectName: string;
  selectedPath: string | null;
  activeTabPath: string | null;
  expandedFolders: Record<string, boolean>;
  isRootExpanded: boolean;
  toggleFolder: (path: string) => void;
  onSelectPath: (path: string) => void;
  onOpenFile: (path: string, name: string) => void;
  onContextMenu: (e: React.MouseEvent, target: ContextMenuTarget) => void;
  renamingNode: { path: string; name: string; isFolder: boolean } | null;
  inlineCreating: { type: 'file' | 'folder'; parentPath: string } | null;
  handleCommitInlineCreate: (name: string) => Promise<void>;
  handleCommitRename: (newName: string) => Promise<void>;
  setRenamingNode: (val: { path: string; name: string; isFolder: boolean } | null) => void;
  setDeletingNode: (val: { path: string; name: string; isFolder: boolean } | null) => void;
  setInlineCreating: (val: { type: 'file' | 'folder'; parentPath: string } | null) => void;
  setIsRootExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  isLight: boolean;
}

export const BranchedExplorerTree: React.FC<BranchedExplorerTreeProps> = ({
  nodes,
  activeProjectName,
  selectedPath,
  activeTabPath,
  expandedFolders,
  isRootExpanded,
  toggleFolder,
  onSelectPath,
  onOpenFile,
  onContextMenu,
  renamingNode,
  inlineCreating,
  handleCommitInlineCreate,
  handleCommitRename,
  setRenamingNode,
  setDeletingNode,
  setInlineCreating,
  setIsRootExpanded,
  isLight,
}) => {
  const markerRef = useRef<HTMLSpanElement>(null);
  const activeHeadRef = useRef<HTMLDivElement | null>(null);

  const activePath = selectedPath ?? activeTabPath ?? '';

  // Slide vertical active marker line to selected item
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const activeEl = activeHeadRef.current;
    if (!marker) return;

    if (activeEl) {
      marker.style.top = `${activeEl.offsetTop + (activeEl.offsetHeight - MARK) / 2}px`;
      marker.setAttribute('data-on', 'true');
    } else {
      marker.removeAttribute('data-on');
    }
  }, [activePath, isRootExpanded, expandedFolders, nodes]);

  // Render children tree recursively
  const renderChildrenList = (children: FileNode[], depth = 1) => {
    if (!children || children.length === 0) return null;

    return (
      <div className="branched-explorer__children flex flex-col w-full relative">
        {children.map((node, index) => {
          const isLast = index === children.length - 1;
          const isFolder = node.type === 'folder';
          const isExpanded = Boolean(expandedFolders[node.path]);
          const isSelected = selectedPath === node.path || (!isFolder && activeTabPath === node.path);
          const isRenaming = renamingNode?.path === node.path;

          if (isRenaming) {
            return (
              <div key={node.path} className="my-1 pl-[28px]">
                <ExplorerInlineNameEditor
                  mode="RENAME"
                  initialValue={node.name}
                  depth={depth}
                  onCommit={handleCommitRename}
                  onCancel={() => setRenamingNode(null)}
                />
              </div>
            );
          }

          return (
            <div key={node.path} className="branched-explorer__node relative flex flex-col w-full select-none">
              {/* Single Item Row Container */}
              <div className="relative flex items-center w-full min-h-[34px] my-[1px]">
                {/* Connector SVG Segment for this row */}
                <div className="absolute top-0 bottom-0 left-0 w-[28px] pointer-events-none z-0">
                  <svg className="w-full h-full overflow-visible" aria-hidden="true">
                    {isFolder ? (
                      /* Folders: NO curved arc, NO horizontal line, NO blue reach line.
                         Only draw straight vertical trunk segment so lower siblings connect. */
                      <path
                        className="branched-explorer__base"
                        d={!isLast ? 'M 12 0 V 100%' : 'M 12 0 V 17'}
                      />
                    ) : (
                      /* Files: Gray base path with curved branch into file.
                         If not last, trunk continues down past file. */
                      <>
                        <path
                          className="branched-explorer__base"
                          d={`M 12 0 V 9 A 8 8 0 0 0 20 17 H 26${!isLast ? ' M 12 17 V 100%' : ''}`}
                        />
                        {/* Active Reach Stroke: ONLY curved path into THIS file, NEVER continuing down! */}
                        <path
                          className="branched-explorer__reach"
                          d="M 12 0 V 9 A 8 8 0 0 0 20 17 H 26"
                          style={{
                            opacity: isSelected ? 1 : 0,
                            transition: 'opacity 200ms ease',
                          }}
                        />
                      </>
                    )}
                  </svg>
                </div>

                {/* Item Row */}
                <div
                  ref={(el) => {
                    if (isSelected) activeHeadRef.current = el;
                  }}
                  onClick={() => {
                    onSelectPath(node.path);
                    if (isFolder) {
                      toggleFolder(node.path);
                    } else {
                      onOpenFile(node.path, node.name);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectPath(node.path);
                    onContextMenu(e, {
                      type: isFolder ? 'folder' : 'file',
                      path: node.path,
                      name: node.name,
                    });
                  }}
                  className={`branched-explorer__item group relative z-10 w-full flex items-center gap-2 pr-2 py-1.5 rounded-xl cursor-pointer ${
                    isFolder ? 'pl-[20px]' : 'pl-[28px]'
                  }`}
                  data-active={isSelected ? 'true' : 'false'}
                >
                  {isFolder ? (
                    <>
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                      )}
                      <FolderIcon name={node.name} isOpen={isExpanded} className="w-3.5 h-3.5 shrink-0" />
                    </>
                  ) : (
                    <FileIcon filename={node.name} className="w-3.5 h-3.5 shrink-0" />
                  )}

                  <span className="truncate flex-1 font-medium">{node.name}</span>

                  <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
                    <button
                      type="button"
                      aria-label={`Rename ${node.name}`}
                      title={`Rename ${node.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingNode({ path: node.path, name: node.name, isFolder });
                      }}
                      className="p-1 rounded text-neutral-400 hover:text-white hover:bg-[#35343d]"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${node.name}`}
                      title={`Delete ${node.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingNode({ path: node.path, name: node.name, isFolder });
                      }}
                      className="p-1 rounded text-neutral-400 hover:text-rose-200 hover:bg-rose-950/60"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              </div>

              {/* Subfolder Body (Expanded) */}
              {isFolder && isExpanded && (
                <div className="relative pl-[16px] flex flex-col w-full">
                  {/* Inline creation editor inside subfolder */}
                  {inlineCreating && inlineCreating.parentPath === node.path && (
                    <div className="my-1 pl-[28px]">
                      <ExplorerInlineNameEditor
                        mode={inlineCreating.type === 'file' ? 'CREATE_FILE' : 'CREATE_FOLDER'}
                        depth={depth + 1}
                        onCommit={handleCommitInlineCreate}
                        onCancel={() => setInlineCreating(null)}
                      />
                    </div>
                  )}

                  {renderChildrenList(node.children || [], depth + 1)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const isRootSelected = selectedPath === '';

  return (
    <nav className="branched-explorer relative w-full flex flex-col">
      {/* Sliding Active Line Marker */}
      <span ref={markerRef} className="branched-explorer__marker" aria-hidden="true" />

      {/* Root Project Folder Section */}
      <div className="branched-explorer__section w-full flex flex-col" data-open={isRootExpanded ? 'true' : 'false'}>
        <div
          ref={(el) => {
            if (isRootSelected) activeHeadRef.current = el;
          }}
          onClick={() => {
            setIsRootExpanded((prev) => !prev);
            onSelectPath('');
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(e, { type: 'root', path: '', name: activeProjectName });
          }}
          className="branched-explorer__head group relative z-10"
          data-active={isRootSelected ? 'true' : undefined}
        >
          {isRootExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
          )}
          <Folder className="w-3.5 h-3.5 text-[#e5a93c] shrink-0" />
          <span className="truncate flex-1 font-semibold text-[13px] tracking-tight">{activeProjectName}</span>
        </div>

        {/* Root Children Body */}
        {isRootExpanded && (
          <div className="relative pl-1 flex flex-col w-full mt-0.5">
            {inlineCreating && inlineCreating.parentPath === '' && (
              <div className="my-1 pl-[28px]">
                <ExplorerInlineNameEditor
                  mode={inlineCreating.type === 'file' ? 'CREATE_FILE' : 'CREATE_FOLDER'}
                  depth={1}
                  onCommit={handleCommitInlineCreate}
                  onCancel={() => setInlineCreating(null)}
                />
              </div>
            )}
            {renderChildrenList(nodes, 1)}
          </div>
        )}
      </div>
    </nav>
  );
};
