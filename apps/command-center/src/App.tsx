/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy } from 'react';
import { AppProvider, useApp } from './state/AppContext';
import { NavRail } from './features/navigation/NavRail';
import { ThreadsDrawer } from './features/navigation/ThreadsDrawer';
import { TopChrome } from './features/navigation/TopChrome';
import { EmptyState } from './features/empty/EmptyState';
import { ThreadView } from './features/threads/ThreadView';
import { SettingsView } from './features/settings/SettingsView';
import { ProjectModal } from './features/projects/ProjectModal';
import { LibraryView } from './features/library/LibraryView';

// Keep CodeMirror and its language modes out of the initial Main Chat bundle.
// The editor loads when the user opens a file tab.
const CodeEditorView = lazy(() => import('./features/editor/CodeEditorView').then(module => ({
  default: module.CodeEditorView,
})));

const MainWorkspace: React.FC = () => {
  const {
    isSidebarOpen,
    activeWorkbenchTab,
    activeModal,
    isSettingsView,
    isLibraryView,
    selectedMediobotId,
    closeSettings,
    theme,
  } = useApp();

  const isLight = theme === 'light';

  return (
    <div
      className={`flex h-screen w-screen overflow-hidden ${
        isLight ? 'bg-[#ebebef] text-[#111827]' : 'bg-[#28272c] text-[#e5e5e7]'
      } antialiased select-none transition-colors duration-150`}
    >
      {/* 1. Left Narrow Navigation Rail */}
      <NavRail />

      {/* 2. Collapsible Threads Drawer: Completely removed in the Library section alone */}
      {!isLibraryView && <ThreadsDrawer />}

      {/* 3. Main Workspace Area */}
      <main
        className={`flex-1 flex flex-col h-full min-w-0 relative border-none ${
          isLight ? 'bg-[#ebebef]' : 'bg-[#28272c]'
        } pt-11 transition-colors duration-150`}
      >
        {/* Desktop Top Chrome (< > [|] and [+]) */}
        <TopChrome />

        {/* Viewport: Code Editor View, Empty State, Active Thread, Settings View, or Library View */}
        <div
          className={`flex-1 overflow-hidden flex flex-col ${
            isLight
              ? isSidebarOpen && !isSettingsView && !isLibraryView
                ? 'bg-[#ffffff]'
                : 'bg-[#ffffff] rounded-tl-[24px] shadow-sm'
              : isSidebarOpen && !isSettingsView && !isLibraryView
                ? 'bg-[#141415]'
                : 'bg-[#141415] rounded-tl-[24px]'
          } transition-[background-color,border-radius] duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)]`}
        >
          {isSettingsView ? (
            <SettingsView onClose={closeSettings} />
          ) : isLibraryView ? (
            <LibraryView />
          ) : selectedMediobotId && activeWorkbenchTab?.kind !== 'chat' ? (
            <EmptyState />
          ) : !activeWorkbenchTab ? (
            <EmptyState />
          ) : activeWorkbenchTab.kind === 'file' ? (
            <Suspense fallback={<div className="flex-1" aria-busy="true" />}>
              <CodeEditorView />
            </Suspense>
          ) : (
            <ThreadView />
          )}
        </div>
      </main>

      {/* Modals & Dialogs */}
      {activeModal === 'projects' && <ProjectModal />}
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <MainWorkspace />
    </AppProvider>
  );
}
