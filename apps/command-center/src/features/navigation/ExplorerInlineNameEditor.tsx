import React, { useState, useRef, useEffect } from "react";
import { Folder, FileText } from "lucide-react";
import { useApp } from "../../state/AppContext";

export type InlineEditorMode = "CREATE_FILE" | "CREATE_FOLDER" | "RENAME";

interface ExplorerInlineNameEditorProps {
  mode: InlineEditorMode;
  initialValue?: string;
  depth?: number;
  onCommit: (name: string) => Promise<void>;
  onCancel: () => void;
}

const INVALID_CHARS = /[\\/\0]/;

export const ExplorerInlineNameEditor: React.FC<ExplorerInlineNameEditorProps> = ({
  mode,
  initialValue = "",
  depth = 0,
  onCommit,
  onCancel,
}) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasCommittedRef = useRef(false);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      if (mode === "RENAME") {
        // Select filename without extension if possible
        const dotIdx = initialValue.lastIndexOf(".");
        if (dotIdx > 0) {
          inputRef.current.setSelectionRange(0, dotIdx);
        } else {
          inputRef.current.select();
        }
      } else {
        inputRef.current.select();
      }
    }
  }, [mode, initialValue]);

  // Click-outside listener: when clicking elsewhere, cancel and disappear if unsaved
  useEffect(() => {
    const handleOutsidePointerDown = (e: PointerEvent) => {
      if (hasCommittedRef.current) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", handleOutsidePointerDown);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
    };
  }, [onCancel]);

  const validate = (name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return "Name cannot be empty.";
    if (INVALID_CHARS.test(trimmed)) return "Name cannot contain / or \\";
    if (trimmed === "." || trimmed === "..") return "Invalid name.";
    if (trimmed.startsWith(".")) return "Name cannot start with a period.";
    return null;
  };

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const trimmed = value.trim();
      if (!trimmed) {
        onCancel();
        return;
      }

      const validationErr = validate(trimmed);
      if (validationErr) {
        setError(validationErr);
        return;
      }

      setError(null);
      setSubmitting(true);
      hasCommittedRef.current = true;
      try {
        await onCommit(trimmed);
      } catch (err) {
        hasCommittedRef.current = false;
        setError(err instanceof Error ? err.message : "Creation failed");
        setSubmitting(false);
      }
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (hasCommittedRef.current || submitting) return;
    if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
      onCancel();
    }
  };

  const isFolder = mode === "CREATE_FOLDER";

  return (
    <div ref={containerRef} className="flex flex-col select-none" style={{ paddingLeft: `${depth * 14 + 10}px` }}>
      <div className={`flex items-center gap-1.5 py-1 px-1 rounded ${isLight ? 'bg-white border-[#0078d4] shadow-xs' : 'bg-[#282730] border-[#0078d4]'}`}>
        {isFolder ? (
          <Folder className="w-3.5 h-3.5 text-[#e5a93c] shrink-0" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-[#519aba] shrink-0" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          disabled={submitting}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={`w-full bg-transparent text-[12px] ${isLight ? 'text-[#09090b]' : 'text-white'} outline-none px-0.5 py-0`}
          placeholder={isFolder ? "Folder name..." : "File name..."}
        />
      </div>
      {error && (
        <span className="text-[10.5px] text-rose-400 pl-5 pt-0.5 animate-in fade-in">
          {error}
        </span>
      )}
    </div>
  );
};
