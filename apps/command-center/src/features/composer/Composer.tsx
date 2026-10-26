import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Folder, Laptop, AlertTriangle } from 'lucide-react';
import {
  Attachment01Icon,
  Globe02Icon,
  File02Icon,
  ChartLineData01Icon,
} from '@hugeicons/core-free-icons';
import { useApp } from '../../state/AppContext';
import { runtimeInstance } from '../../runtime/client';
import type { TurnAttachment } from '../../types';
import PromptBar, {
  PromptBarModel,
  PromptBarSource,
  DEFAULT_COMMANDS,
} from './PromptBar';
import { getMediobotChatBarTheme, getDefaultChatBarTheme } from '../mediobots/presentation';

interface ComposerProps {
  compact?: boolean;
}

interface DynamicComposerModel {
  id: string;
  name: string;
  provider: string;
  providerId: string;
  badge?: string;
  tag?: string;
  context?: string;
  description?: string;
}

export const Composer: React.FC<ComposerProps> = ({ compact = false }) => {
  const {
    activeThreadId,
    activeThread,
    getDraft,
    setDraft,
    model,
    modelSelection,
    setModel,
    providers,
    sendPrompt,
    isGenerating,
    cancelCurrentTurn,
    sidebarTab,
    selectedMediobotId,
    agents,
    agentPreferences,
    setAgentModelPreference,
    setAgentEffortPreference,
    getAgentPreference,
    openProjectDirectory,
    workspaceStatus,
    theme,
    openSettings,
  } = useApp();

  const isLight = theme === 'light';
  const isMaestroSection = sidebarTab === 'maestro' || selectedMediobotId !== null;
  const currentAgent = selectedMediobotId
    ? agents.find((agent) => agent.id === selectedMediobotId) ?? null
    : null;
  const activeBotKey = (currentAgent?.preferenceId ?? selectedMediobotId ?? 'maestro').toLowerCase();
  const botPreference = getAgentPreference(activeBotKey);

  const chatBarTheme = useMemo(() => {
    if (!isMaestroSection) {
      return getDefaultChatBarTheme(isLight);
    }
    const targetBotId = selectedMediobotId ?? 'maestro';
    return getMediobotChatBarTheme(targetBotId, isLight);
  }, [isMaestroSection, selectedMediobotId, isLight]);

  const showOpenRow = !isMaestroSection && workspaceStatus === 'EMPTY';

  const draftKey = activeThreadId ?? selectedMediobotId ?? 'home';
  const prompt = getDraft(draftKey);

  const [attachments, setAttachments] = useState<Array<{ metadata: TurnAttachment; previewUrl?: string }>>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDropActive, setDropActive] = useState(false);

  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  // Cleanup attachments when switching thread context
  useEffect(() => {
    setAttachments((previous) => {
      previous.forEach(({ previewUrl, metadata }) => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        void runtimeInstance.removeAttachment(metadata.id).catch(() => {});
      });
      return [];
    });
    setAttachmentError(null);
  }, [draftKey]);

  // Handle file uploads to runtime
  const addFiles = async (files: File[]): Promise<string[]> => {
    setAttachmentError(null);
    if (attachments.length + files.length > 5) {
      setAttachmentError('A message can include at most 5 files.');
      return [];
    }
    const total =
      attachments.reduce((sum, item) => sum + item.metadata.size, 0) +
      files.reduce((sum, file) => sum + file.size, 0);
    if (total > 10 * 1024 * 1024) {
      setAttachmentError('Attachments for one message cannot exceed 10 MB total.');
      return [];
    }

    const attachedNames: string[] = [];

    for (const file of files) {
      if (!file.size || file.size > 5 * 1024 * 1024) {
        setAttachmentError(`${file.name} exceeds the 5 MB per-file limit.`);
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('Could not read the selected file.'));
          reader.onload = () =>
            typeof reader.result === 'string'
              ? resolve(reader.result)
              : reject(new Error('Could not read the selected file.'));
          reader.readAsDataURL(file);
        });

        const metadata = await runtimeInstance.uploadAttachment({
          name: file.name,
          type: file.type || 'application/octet-stream',
          base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        });

        if (draftKeyRef.current !== draftKey) {
          await runtimeInstance.removeAttachment(metadata.id);
          continue;
        }

        setAttachments((previous) => [
          ...previous,
          {
            metadata,
            ...(metadata.mimeType.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {}),
          },
        ]);
        attachedNames.push(file.name);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : 'This file could not be attached.');
      }
    }

    return attachedNames;
  };

  const handlePickFiles = async (): Promise<string[]> => {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = async () => {
        if (!input.files || input.files.length === 0) {
          resolve([]);
          return;
        }
        const files = Array.from(input.files);
        const uploaded = await addFiles(files);
        resolve(uploaded);
      };
      input.click();
    });
  };

  const handleAttachmentsChange = (remainingFileNames: string[]) => {
    setAttachments((prev) => {
      const kept = prev.filter((item) => remainingFileNames.includes(item.metadata.name));
      prev.forEach((item) => {
        if (!remainingFileNames.includes(item.metadata.name)) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
          void runtimeInstance.removeAttachment(item.metadata.id).catch(() => {});
        }
      });
      return kept;
    });
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    await addFiles(files);
  };

  // Build dynamic models list from active providers
  const dynamicModelsList: DynamicComposerModel[] = useMemo(() => {
    const list: DynamicComposerModel[] = [];
    providers
      .filter((p) => p.connected && p.enabled && p.credentialStatus !== 'missing')
      .forEach((p) => {
        p.models
          .filter((m) => m.enabled)
          .forEach((m) => {
            list.push({
              id: m.id,
              name: m.name,
              provider: p.name,
              providerId: p.id,
              badge: m.tag || p.badge,
              tag: m.tag,
              context: m.context,
              description: m.description,
            });
          });
      });
    return list;
  }, [providers]);

  const promptBarModels: PromptBarModel[] = useMemo(() => {
    return dynamicModelsList.map((m) => ({
      key: `${m.providerId}::${m.id}`,
      id: m.id,
      name: m.name,
      provider: m.provider,
      providerId: m.providerId,
      context: m.context || '128K',
      description: m.description,
    }));
  }, [dynamicModelsList]);

  const [localThreadModelKey, setLocalThreadModelKey] = useState<string>('');

  const selectedModelKey = useMemo(() => {
    // If inside Maestro section or Mediobot mode, ALWAYS use the bot's unique model preference!
    if (isMaestroSection) {
      const targetKey = botPreference.modelKey;
      const matched = promptBarModels.find((m) => m.key === targetKey || (m as any).id === targetKey);
      if (matched) return matched.key;
      // Keep an unavailable configured selection visible as unavailable. Falling
      // back to a different provider/model would violate the specialist's setting.
      return targetKey;
    }

    // If inside an active thread with its own explicit model selection
    if (activeThreadId && activeThread?.modelSelection?.modelId) {
      const sel = activeThread.modelSelection;
      const matched = promptBarModels.find(
        (m) =>
          ((m as any).id === sel.modelId || m.key === sel.modelId || m.key === `${sel.providerConnectionId}::${sel.modelId}`) &&
          (!sel.providerConnectionId || m.providerId === sel.providerConnectionId)
      );
      if (matched) return matched.key;
      return sel.modelId;
    }

    if (modelSelection?.modelId) {
      const matched = promptBarModels.find(
        (m) =>
          ((m as any).id === modelSelection.modelId || m.key === modelSelection.modelId || m.key === `${modelSelection.providerConnectionId}::${modelSelection.modelId}`) &&
          (!modelSelection.providerConnectionId || m.providerId === modelSelection.providerConnectionId)
      );
      if (matched) return matched.key;
      return modelSelection.modelId;
    }

    if (activeThreadId && activeThread?.model && activeThread.model !== 'No configured model') {
      const matched = promptBarModels.find((m) => m.name === activeThread.model || m.key === activeThread.model);
      if (matched) return matched.key;
    }

    if (localThreadModelKey) {
      return localThreadModelKey;
    }

    // New threads never silently inherit a global/default model.
    return '';
  }, [isMaestroSection, activeThreadId, activeThread?.modelSelection, modelSelection, activeThread?.model, localThreadModelKey, botPreference.modelKey, promptBarModels]);

  const selectedEffort = botPreference.effort || 'Medium';

  const handleModelChange = useCallback((modelKey: string) => {
    setLocalThreadModelKey(modelKey);
    setAgentModelPreference(activeBotKey, modelKey);

    const found = promptBarModels.find((m) => m.key === modelKey || (m as any).id === modelKey) || dynamicModelsList.find((m) => m.id === modelKey);
    if (found && !selectedMediobotId && typeof found.providerId === 'string' && found.providerId.length > 0) {
      const providerConnectionId = found.providerId;
      const rawKey = (found as any).key || (found as any).id || '';
      const modelId = (found as any).id || (rawKey.includes('::') ? rawKey.split('::')[1] : rawKey);
      setModel(found.name, {
        providerConnectionId,
        modelId,
      });
    }
  }, [activeBotKey, selectedMediobotId, setAgentModelPreference, promptBarModels, dynamicModelsList, setModel]);

  const handleEffortChange = useCallback((effort: string) => {
    setAgentEffortPreference(activeBotKey, effort);
  }, [activeBotKey, setAgentEffortPreference]);

  // Sources for the @ menu
  const promptBarSources: PromptBarSource[] = useMemo(() => [
    {
      key: 'files',
      name: 'Photos & files',
      description: 'Upload from this device',
      icon: Attachment01Icon,
      attach: true,
    },
    {
      key: 'web',
      name: 'Web search',
      description: 'Live real-time web results',
      icon: Globe02Icon,
    },
    {
      key: 'workspace',
      name: 'Project files',
      description: 'Reference files in opened folder',
      icon: File02Icon,
    },
    {
      key: 'data',
      name: 'Code analysis',
      description: 'Review code structure & tests',
      icon: ChartLineData01Icon,
    },
  ], []);

  // Send Prompt handler
  const handleSend = async (
    text: string,
    options: { attachments: string[]; model: PromptBarModel; effort: string }
  ) => {
    if (isGenerating) {
      await cancelCurrentTurn();
      return;
    }

    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    const keyParts = options.model?.key.split('::') ?? [];
    const selectedModelId = keyParts.length > 1 ? keyParts.slice(1).join('::') : options.model?.key;
    const selectedProviderId = options.model?.providerId ?? (keyParts.length > 1 ? keyParts[0] : undefined);
    const selectedModelSelection = selectedModelId && selectedProviderId
      ? { providerConnectionId: selectedProviderId, modelId: selectedModelId }
      : undefined;
    if (selectedModelSelection && (!selectedMediobotId || selectedMediobotId === 'maestro')) {
      setModel(options.model.name, selectedModelSelection);
    }

    setDraft(draftKey, '');
    const sentAttachments = attachments.map((item) => item.metadata);
    setAttachments([]);
    attachments.forEach(({ previewUrl }) => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    });

    await sendPrompt(trimmed, sentAttachments, selectedModelSelection, options.effort);
  };

  const handleStop = async () => {
    await cancelCurrentTurn();
  };

  const handleComposerContainerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const actionEl = target.closest<HTMLElement>('[data-action]');
      if (!actionEl) return;

      const action = actionEl.getAttribute('data-action');
      if (action === 'open-folder') {
        e.preventDefault();
        openProjectDirectory();
      }
    },
    [openProjectDirectory]
  );

  return (
    <div
      data-testid="composer-container"
      className={`w-full ${selectedMediobotId ? 'max-w-6xl' : 'max-w-3xl'} mx-auto transition-all ${compact ? 'px-4' : 'px-6'}`}
      onClick={handleComposerContainerClick}
    >
      {workspaceStatus === 'UNAVAILABLE' && (
        <div className="flex items-center justify-between px-4 py-2.5 mb-3 bg-[#2a1c1d] border border-[#522527] text-neutral-300 text-[12.5px] rounded-xl shadow-md">
          <div className="flex items-center gap-2 text-rose-300">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>Project folder is unavailable or missing from disk.</span>
          </div>
          <button
            data-action="open-folder"
            onClick={() => openProjectDirectory()}
            className="px-2.5 py-1 text-[11.5px] font-medium bg-[#3d2427] hover:bg-[#4d2d31] text-rose-200 rounded-md transition-colors cursor-pointer"
          >
            Open folder
          </button>
        </div>
      )}

      {attachmentError && (
        <p role="alert" className="px-5 pb-2 text-[11px] text-rose-500 font-medium">
          {attachmentError}
        </p>
      )}

      <div
        className="relative"
        onDragEnter={(event) => {
          if (Array.from(event.dataTransfer.types).includes('Files')) {
            event.preventDefault();
            setDropActive(true);
          }
        }}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false);
        }}
        onDrop={handleDrop}
      >
        {/* Top Contextual Tab Row (📁 Open / 💻 This computer) */}
        {showOpenRow && (
          <div
            className={`flex items-center gap-7 px-5 pt-2 pb-5 ${
              isLight ? 'bg-[#ebebef] text-[#18181b]' : 'bg-[#1b1b20] text-neutral-300'
            } text-[13px] font-normal rounded-t-[20px] select-none mb-[-12px] relative z-0`}
          >
            <button
              data-action="open-folder"
              onClick={() => openProjectDirectory()}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg ${
                isLight ? 'bg-[#09090b] hover:bg-[#27272a] text-white' : 'bg-[#e4e4e7] hover:bg-white text-black'
              } font-semibold text-[12.5px] transition-all shadow-xs cursor-pointer active:scale-95`}
              title="Open folder, project, ZIP file, or workspace in Home sidebar"
            >
              <Folder className={`w-3.5 h-3.5 ${isLight ? 'text-white' : 'text-black'} stroke-[2.2]`} />
              <span>Open</span>
            </button>

            <div
              className={`flex items-center gap-2 ${
                isLight ? 'text-[#475569] hover:text-[#09090b]' : 'hover:text-white'
              } transition-colors cursor-default`}
              title="Execution environment"
            >
              <Laptop className={`w-4 h-4 ${isLight ? 'text-[#64748b]' : 'text-neutral-400'} stroke-[1.75]`} />
              <span>This computer</span>
            </div>
          </div>
        )}

        {/* React Bits PromptBar Integration with full Dark & Light mode styling */}
        <div className={`relative z-10 ${isDropActive ? 'ring-2 ring-blue-500 rounded-[20px]' : ''}`}>
          <PromptBar
            key={`prompt-bar-${isMaestroSection ? activeBotKey : (activeThreadId || 'home')}`}
            placeholder={
              isMaestroSection
                ? currentAgent
                  ? `Ask ${currentAgent.name}...`
                  : 'Ask Anything'
                : 'Do anything, / for commands, @ for sources'
            }
            sources={promptBarSources}
            commands={DEFAULT_COMMANDS}
            models={promptBarModels}
            providers={providers}
            defaultModel={selectedModelKey}
            onModelChange={handleModelChange}
            onManageModels={() => openSettings('configuration')}
            efforts={['Low', 'Medium', 'High', 'Extra', 'Max']}
            defaultEffort={selectedEffort}
            onEffortChange={handleEffortChange}
            busy={isGenerating}
            onSend={handleSend}
            onStop={handleStop}
            onAttach={handlePickFiles}
            onAttachFiles={addFiles}
            value={prompt}
            onChange={(val) => setDraft(draftKey, val)}
            initialAttachments={attachments.map((a) => a.metadata.name)}
            richAttachments={attachments.map((a) => ({
              id: a.metadata.id,
              name: a.metadata.name,
              mimeType: a.metadata.mimeType,
              size: a.metadata.size,
              previewUrl: a.previewUrl,
            }))}
            onAttachmentsChange={handleAttachmentsChange}
            onRemoveAttachment={(index) => {
              const target = attachments[index];
              if (target) {
                if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
                void runtimeInstance.removeAttachment(target.metadata.id).catch(() => {});
                setAttachments((prev) => prev.filter((_, i) => i !== index));
              }
            }}

            isLight={isLight}
            background={chatBarTheme.background}
            color={chatBarTheme.color}
            menuBackground={chatBarTheme.menuBackground}
            borderColor={chatBarTheme.borderColor}
            sparkColor={chatBarTheme.sparkColor}
            hoverColor={chatBarTheme.hoverColor}
            glowColor={chatBarTheme.glowColor}
            mutedColor={chatBarTheme.mutedColor}
            shadow={chatBarTheme.shadow}
            sparkBoost={1}
            width={selectedMediobotId ? 1152 : 768}
            radius={20}
            maxRows={6}
            morphDuration={240}
            squash={0.12}
            tilt={8}
            pressScale={0.96}
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
};
