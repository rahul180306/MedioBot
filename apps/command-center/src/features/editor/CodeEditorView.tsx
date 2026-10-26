import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Save, X, FileQuestion, AlertCircle, RefreshCw } from 'lucide-react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, foldGutter } from '@codemirror/language';
import { useApp } from '../../state/AppContext';
import { runtimeInstance } from '../../runtime/client';
import { FileIcon } from '../../components/icons/FileIcon';
import { resolveEditorLanguage } from './languageResolver';
import { getMediobotSyntaxTheme } from './editorTheme';

export interface AutoSaveConfig {
  readonly enabled: boolean;
  readonly mode: 'afterDelay';
  readonly delayMs: number;
}

export const DEFAULT_AUTOSAVE_CONFIG: AutoSaveConfig = {
  enabled: true,
  mode: 'afterDelay',
  delayMs: 1000,
};

export type SaveStatus = 'Saved' | 'Editing...' | 'Saving...' | 'Conflict' | 'Error';

export const CodeEditorView: React.FC = () => {
  const { activeTabPath, activeProject, closeFileTab, lastFsEvent, theme } = useApp();
  const isLight = theme === 'light';
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [hash, setHash] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState('');
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('Saved');
  const [copied, setCopied] = useState(false);
  const [lineCount, setLineCount] = useState(1);
  const requestSequence = useRef(0);
  const [loadedKey, setLoadedKey] = useState('');
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const dirty = content !== savedContent;
  const currentKey = `${activeProject.id}\0${activeTabPath ?? ''}`;
  const activeKey = useRef(currentKey);
  activeKey.current = currentKey;
  const saving = savingKey === currentKey;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());

  const resolution = activeTabPath ? resolveEditorLanguage(activeTabPath) : null;

  // File loading logic
  const load = useCallback(async () => {
    if (!activeTabPath || !activeProject.id) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');

    // Binary guard
    if (resolution?.isBinary) {
      setLoading(false);
      setContent('');
      setSavedContent('');
      setHash('');
      setLoadedKey(currentKey);
      setSaveStatus('Saved');
      return;
    }

    try {
      const result = await runtimeInstance.readFileVersioned(activeProject.id, activeTabPath);
      if (sequence !== requestSequence.current) return;
      setContent(result.content);
      setSavedContent(result.content);
      setHash(result.hash);
      setLineCount(result.content.split('\n').length);
      setLoadedKey(`${activeProject.id}\0${activeTabPath}`);
      setSaveStatus('Saved');

      // Initialize or update CodeMirror
      if (editorViewRef.current) {
        const state = editorViewRef.current.state;
        const currentDoc = state.doc.toString();
        if (currentDoc !== result.content) {
          editorViewRef.current.dispatch({
            changes: { from: 0, to: currentDoc.length, insert: result.content },
          });
        }
      }
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      setContent('');
      setSavedContent('');
      setHash('');
      setLoadedKey(`${activeProject.id}\0${activeTabPath}`);
      const msg = cause instanceof Error ? cause.message : 'File could not be read.';
      setError(msg);
      setSaveStatus('Error');
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [activeProject.id, activeTabPath, currentKey, resolution?.isBinary]);

  useEffect(() => {
    void load();
  }, [load]);

  // Saving logic
  const save = useCallback(async () => {
    if (!activeTabPath || !activeProject.id || loadedKey !== currentKey || saving || !hash) return;
    if (content === savedContent) {
      setSaveStatus('Saved');
      return;
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    const saveKey = currentKey;
    setSavingKey(saveKey);
    setSaveStatus('Saving...');
    setError('');

    try {
      const nextHash = await runtimeInstance.saveFile(activeProject.id, activeTabPath, content, hash);
      if (activeKey.current === saveKey) {
        setHash(nextHash);
        setSavedContent(content);
        setSaveStatus('Saved');
      }
    } catch (cause) {
      if (activeKey.current === saveKey) {
        const msg = cause instanceof Error ? cause.message : 'The file could not be saved.';
        const isConflict = msg.toLowerCase().includes('conflict') || msg.toLowerCase().includes('changed outside');
        setError(msg);
        setSaveStatus(isConflict ? 'Conflict' : 'Error');
      }
    } finally {
      setSavingKey((current) => (current === saveKey ? '' : current));
    }
  }, [activeProject.id, activeTabPath, content, currentKey, hash, loadedKey, savedContent, saving]);

  // Handle external filesystem events
  useEffect(() => {
    if (!lastFsEvent || !activeTabPath) return;
    if (lastFsEvent.relativePath === activeTabPath) {
      if (lastFsEvent.type === 'modify') {
        // Suppress watcher echo events if originated from editor or content hash matches current loaded/saved hash
        if (lastFsEvent.origin === 'editor' || (lastFsEvent.contentHash && (lastFsEvent.contentHash === hash || lastFsEvent.contentHash.slice(0, 16) === hash.slice(0, 16)))) {
          return;
        }
        if (!dirty) {
          // Clean editor: silently reload with updated disk content
          void load();
        } else {
          // Dirty editor: NEVER overwrite user changes, surface conflict state
          setError('This file changed outside the editor. Reload it to see external changes, or save to overwrite.');
          setSaveStatus('Conflict');
        }
      }
    }
  }, [lastFsEvent, activeTabPath, dirty, load, hash]);

  // Central Auto Save orchestration
  useEffect(() => {
    if (!DEFAULT_AUTOSAVE_CONFIG.enabled || !dirty || saving || !hash || loading || loadedKey !== currentKey) {
      return;
    }

    setSaveStatus('Editing...');

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void save();
    }, DEFAULT_AUTOSAVE_CONFIG.delayMs);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [content, dirty, saving, hash, loading, loadedKey, currentKey, save]);

  // Setup CodeMirror instance
  useEffect(() => {
    if (!editorContainerRef.current || resolution?.isBinary) return;

    const saveCommand = () => {
      void save();
      return true;
    };

    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      foldGutter(),
      keymap.of([
        { key: 'Mod-s', run: saveCommand },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      languageCompartment.current.of(resolution?.support ?? []),
      themeCompartment.current.of(getMediobotSyntaxTheme(theme)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const doc = update.state.doc.toString();
          setContent(doc);
          setLineCount(update.state.doc.lines);
        }
      }),
    ];

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    return () => {
      view.destroy();
      editorViewRef.current = null;
    };
  // Re-create only when active file tab changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabPath, resolution?.isBinary]);

  // Update language compartment if tab changes within same container
  useEffect(() => {
    if (editorViewRef.current && resolution?.support) {
      editorViewRef.current.dispatch({
        effects: languageCompartment.current.reconfigure(resolution.support),
      });
    }
  }, [resolution?.support]);

  // Dynamically reconfigure theme compartment on light/dark mode switch
  useEffect(() => {
    if (editorViewRef.current) {
      editorViewRef.current.dispatch({
        effects: themeCompartment.current.reconfigure(getMediobotSyntaxTheme(theme)),
      });
    }
  }, [theme]);

  // Global Ctrl/Cmd+S listener
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  // Protect against unsaved tab close
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  if (!activeTabPath) return null;
  const fileName = activeTabPath.split('/').pop() || activeTabPath;

  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`flex-1 flex flex-col h-full ${
      isLight ? 'bg-[#ffffff] text-[#09090b]' : 'bg-[#121215] text-[#e1e1e6]'
    } select-text animate-in fade-in duration-200`}>
      {/* Top Chrome / File Header */}
      <div className={`h-10 px-4 flex items-center justify-between border-b ${
        isLight ? 'border-[#e2e4e8] bg-[#f8f9fa]' : 'border-[#23232a] bg-[#17171c]'
      } shrink-0 select-none`}>
        <div className="flex items-center gap-2 min-w-0">
          <FileIcon filename={fileName} className="w-4 h-4 shrink-0" />
          <span className={`text-[13px] font-medium ${isLight ? 'text-[#09090b]' : 'text-neutral-200'} truncate`}>{activeTabPath}</span>
          {saveStatus === 'Editing...' && (
            <span aria-label="Unsaved changes" title="Unsaved changes (Auto-saving...)" className="w-2 h-2 rounded-full bg-amber-400" />
          )}
          {saveStatus === 'Saving...' && (
            <span aria-label="Saving" title="Saving..." className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          )}
          {saveStatus === 'Conflict' && (
            <span aria-label="Conflict" title="Save conflict" className="w-2 h-2 rounded-full bg-rose-500" />
          )}
          {!loading && !error && !resolution?.isBinary && (
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${isLight ? 'bg-[#eaebee] text-[#4b5563]' : 'bg-[#24232c] text-neutral-400'}`}>
              {lineCount} lines
            </span>
          )}
          {resolution && (
            <span className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded ${
              isLight ? 'bg-[#ffffff] text-[#475569] border border-[#dcdce2]' : 'bg-[#1e1e24] text-neutral-500 border border-[#2b2b35]'
            }`}>
              {resolution.displayName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!loading && !error && !resolution?.isBinary && (
            <>
              <button
                onClick={copy}
                className={`px-2 py-1 rounded text-xs transition-colors cursor-pointer ${
                  isLight
                    ? 'text-[#475569] hover:text-[#09090b] hover:bg-[#eaebee]'
                    : 'text-neutral-300 hover:text-white hover:bg-[#282733]'
                }`}
                title="Copy file"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : 'Copy'}
              </button>
              <button
                onClick={() => void save()}
                disabled={!dirty || saving || loadedKey !== currentKey}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs disabled:opacity-40 transition-colors cursor-pointer ${
                  isLight
                    ? 'bg-[#ffffff] text-[#09090b] hover:bg-[#f1f2f5] border border-[#dcdce2] shadow-xs'
                    : 'text-neutral-200 bg-[#24242e] hover:bg-[#2d2d3a]'
                }`}
                title="Save file (⌘/Ctrl+S)"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <button
            onClick={() => closeFileTab(activeTabPath)}
            className={`p-1 rounded transition-colors cursor-pointer ${
              isLight
                ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#eaebee]'
                : 'text-neutral-400 hover:text-white hover:bg-[#282733]'
            }`}
            title="Close file tab"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Error / Conflict Banner */}
      {error && (
        <div
          role="alert"
          className="px-4 py-2 text-xs text-amber-200 bg-amber-950/30 border-b border-amber-900/40 flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{error}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void load()}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-900/50 hover:bg-amber-900/80 text-amber-100 font-medium transition-colors"
              title="Reload from disk (discards unsaved changes)"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Reload file</span>
            </button>
            {saveStatus === 'Conflict' && (
              <button
                onClick={async () => {
                  // Force save by fetching current hash then saving
                  try {
                    const latest = await runtimeInstance.readFileVersioned(activeProject.id, activeTabPath);
                    await runtimeInstance.saveFile(activeProject.id, activeTabPath, content, latest.hash);
                    setHash(latest.hash);
                    setSavedContent(content);
                    setError('');
                    setSaveStatus('Saved');
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Overwrite failed.');
                  }
                }}
                className="px-2 py-0.5 rounded bg-rose-900/50 hover:bg-rose-900/80 text-rose-100 font-medium transition-colors"
                title="Overwrite external changes with editor content"
              >
                Overwrite
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Editor Body */}
      <div className={`flex-1 min-h-0 relative overflow-hidden ${isLight ? 'bg-[#ffffff]' : 'bg-[#121215]'}`}>
        {loading || loadedKey !== currentKey ? (
          <div className="p-6 text-xs text-neutral-500 font-mono">Reading workspace file…</div>
        ) : resolution?.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-3">
            <FileQuestion className="w-12 h-12 text-neutral-500 stroke-[1.5]" />
            <div className={`text-sm font-medium ${isLight ? 'text-[#09090b]' : 'text-neutral-300'}`}>Binary file cannot be opened as text</div>
            <div className={`text-xs ${isLight ? 'text-[#64748b]' : 'text-neutral-500'} max-w-sm`}>
              The file <span className={`font-mono ${isLight ? 'text-[#09090b]' : 'text-neutral-400'}`}>{fileName}</span> is a binary format ({resolution.displayName}) and cannot be edited in the text editor.
            </div>
          </div>
        ) : null}
        <div ref={editorContainerRef} className={`h-full w-full overflow-hidden ${loading || loadedKey !== currentKey || resolution?.isBinary ? 'hidden' : ''}`} />
      </div>

      {/* Bottom Status Bar */}
      <div className={`h-7 px-4 border-t ${
        isLight ? 'border-[#dcdce2] bg-[#f4f4f7] text-[#6b6a75]' : 'border-[#23232a] bg-[#151519] text-neutral-500'
      } text-[11px] flex items-center justify-between select-none`}>
        <span className="truncate max-w-[50%]">{activeProject.name}</span>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            {saveStatus === 'Saved' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
            {saveStatus === 'Editing...' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
            {saveStatus === 'Saving...' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />}
            {saveStatus === 'Conflict' && <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />}
            {saveStatus === 'Error' && <span className="w-1.5 h-1.5 rounded-full bg-rose-600" />}
            <span className={
              saveStatus === 'Conflict' ? 'text-rose-500 font-medium' :
              saveStatus === 'Error' ? 'text-rose-500' :
              saveStatus === 'Editing...' ? (isLight ? 'text-amber-700' : 'text-amber-300') :
              saveStatus === 'Saving...' ? (isLight ? 'text-blue-600' : 'text-blue-300') :
              isLight ? 'text-[#374151]' : 'text-neutral-400'
            }>
              {saveStatus}
            </span>
          </span>
          <span>·</span>
          <span>{resolution?.displayName || 'Plain Text'}</span>
          <span>·</span>
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  );
};

