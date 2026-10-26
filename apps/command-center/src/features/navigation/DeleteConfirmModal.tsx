import React from "react";
import FuseButton from "../../components/FuseButton";
import { useApp } from "../../state/AppContext";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  name: string;
  isFolder: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  name,
  isFolder,
  onConfirm,
  onCancel,
}) => {
  const { theme } = useApp();
  const isLight = theme === 'light';

  if (!isOpen) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in fade-in slide-in-from-bottom-4 duration-200">
      <div
        className={`flex items-center gap-3 px-4 py-2.5 rounded-2xl border shadow-2xl ${
          isLight
            ? 'bg-white border-[#e2e4e8] text-[#09090b]'
            : 'bg-[#1e1d24] border-[#34333e] text-white'
        }`}
      >
        <span className="text-xs font-medium truncate max-w-[220px]">
          Deleting {isFolder ? 'folder' : 'file'} <span className="font-semibold text-rose-500">"{name}"</span>
        </span>

        <FuseButton
          autoArm
          label="Delete"
          undoLabel="Undo"
          doneLabel="Deleted"
          background={isLight ? '#ef4444' : '#dc2626'}
          color="#ffffff"
          fuseColor={isLight ? '#fca5a5' : '#f87171'}
          size="sm"
          radius={14}
          undoWindow={4000}
          onFuseEnd={onConfirm}
          onUndo={onCancel}
        />
      </div>
    </div>
  );
};
