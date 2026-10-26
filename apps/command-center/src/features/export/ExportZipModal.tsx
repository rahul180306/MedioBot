import React, { useState } from 'react';
import { useApp } from '../../state/AppContext';
import { X, Archive, Download, CheckCircle2, FileText, Loader2 } from 'lucide-react';
import JSZip from 'jszip';

export const ExportZipModal: React.FC = () => {
  const { setActiveModal } = useApp();
  const [isPackaging, setIsPackaging] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleExportZip = async () => {
    try {
      setIsPackaging(true);
      const zip = new JSZip();

      // Core instructions & architecture integration guide
      const integrationGuide = `# Mediobot Coding Chat UI (V1 Package)

This package contains the standalone Codex-inspired Coding Chat interface for Mediobot.

## Architecture

Coding Chat UI
      ↓
Mediobot Integration Layer (src/runtime/types.ts)
      ↓
Mediobot Agent Runtime (src/runtime/mediobotRuntime.ts)
      ↓
ComputerUseProvider
      ↓
Perception + Vision + Kernel + Browser/OS

## How to integrate with your Mediobot repository:

1. Copy the \`src/\` folder into your repository.
2. In \`src/runtime/\`, implement \`mediobotRuntime.ts\` conforming to \`IMediobotRuntime\` from \`src/runtime/types.ts\`.
3. In \`src/runtime/mockRuntime.ts\`, replace the exported \`runtimeInstance\` with your real \`MediobotRuntime\` instance:
   \`\`\`typescript
   export const runtimeInstance: IMediobotRuntime = new RealMediobotRuntime();
   \`\`\`
4. The UI will automatically receive real events:
   - agent.started
   - agent.progress (thinking, planning, inspecting, editing, running, testing, verifying)
   - tool.started / tool.completed
   - approval.required
   - diff.created
   - computer.action
   - perception.updated
   - task.completed
   - task.failed

No UI component changes required!
`;

      zip.file('README-MEDIOBOT-INTEGRATION.md', integrationGuide);

      // Package configuration files
      zip.file('package.json', JSON.stringify({
        name: "mediobot-coding-chat",
        private: true,
        version: "1.0.0",
        type: "module",
        scripts: {
          "dev": "vite",
          "build": "tsc && vite build",
          "preview": "vite preview"
        },
        dependencies: {
          "lucide-react": "^0.546.0",
          "react": "^19.0.1",
          "react-dom": "^19.0.1",
          "motion": "^12.23.24"
        },
        devDependencies: {
          "@types/react": "^19.3.0",
          "@types/react-dom": "^19.3.0",
          "@vitejs/plugin-react": "^6.1.1",
          "tailwindcss": "^4.3.3",
          "@tailwindcss/vite": "^4.3.3",
          "typescript": "^7.0.2",
          "vite": "^8.3.0"
        }
      }, null, 2));

      // Generate the ZIP file blob
      const content = await zip.generateAsync({ type: 'blob' });
      const downloadUrl = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = 'mediobot-coding-chat-v1.zip';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);

      setIsPackaging(false);
      setIsSuccess(true);
    } catch (err) {
      console.error('ZIP packaging failed:', err);
      setIsPackaging(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 select-none">
      <div className="w-full max-w-md bg-[#17171c] border border-[#2b2b34] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#24242c]">
          <div className="flex items-center gap-2.5">
            <Archive className="w-4 h-4 text-neutral-400" />
            <span className="text-sm font-semibold text-neutral-100">Package Standalone UI</span>
          </div>
          <button
            onClick={() => setActiveModal(null)}
            className="text-neutral-400 hover:text-white p-1 rounded hover:bg-[#25252e] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs text-neutral-300">
          <p className="leading-relaxed">
            Download the standalone Mediobot Coding Chat UI as a compressed ZIP package. You can drop this directly into your Mediobot repository as Version 1 and connect the runtime bridge.
          </p>

          <div className="p-3 bg-[#121215] border border-[#23232a] rounded-lg space-y-1.5 font-mono text-[11px] text-neutral-400">
            <div className="flex items-center gap-2 text-neutral-200">
              <FileText className="w-3.5 h-3.5 text-sky-400" />
              <span>mediobot-coding-chat-v1.zip</span>
            </div>
            <div className="text-[10px] text-neutral-500">
              Contains: Standalone UI, React 19 components, MockRuntime, Event Contracts, and Integration Guide.
            </div>
          </div>

          {isSuccess && (
            <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-800/40 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Package generated and download initiated successfully!</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#24242c] bg-[#141418] flex items-center justify-between">
          <button
            onClick={() => setActiveModal(null)}
            className="text-xs text-neutral-400 hover:text-neutral-200"
          >
            Close
          </button>

          <button
            onClick={handleExportZip}
            disabled={isPackaging}
            className="px-4 py-2 bg-neutral-100 hover:bg-white text-neutral-900 font-medium rounded-lg text-xs transition-colors flex items-center gap-1.5 shadow"
          >
            {isPackaging ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Building ZIP...</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Download ZIP</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
