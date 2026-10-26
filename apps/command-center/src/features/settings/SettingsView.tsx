import React, { useState, useEffect } from 'react';
import {
  Search,
  Settings as SettingsIcon,
  Bell,
  Download,
  User,
  Sun,
  Sliders,
  Sparkles,
  Puzzle,
  Laptop,
  Globe,
  ArrowUpRight,
  ChevronDown,
  X,
  Check,
  Flag,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { ManageModelsView } from './ManageModelsView';
import SquishSwitch from '../../components/SquishSwitch';
import './SettingsView.css';

interface SettingsViewProps {
  onClose?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onClose }) => {
  const {
    providers,
    providerCatalog,
    toggleProviderEnabled,
    toggleModelEnabled,
    connectProvider,
    addCustomProvider,
    settingsTab,
    setSettingsTab,
    theme,
    setTheme,
  } = useApp();

  const isLight = theme === 'light';
  const activeTab = settingsTab || 'general';
  const [searchQuery, setSearchQuery] = useState('');

  // Personalization settings
  const [editorFontSize, setEditorFontSize] = useState<'12px' | '13px' | '14px' | '15px'>('13px');
  const [editorFontFamily, setEditorFontFamily] = useState('JetBrains Mono');
  const [isFontFamilyOpen, setIsFontFamilyOpen] = useState(false);

  // General tab states
  const [defaultPermissions, setDefaultPermissions] = useState(true);
  const [fullAccess, setFullAccess] = useState(true);
  const [taskFolder, setTaskFolder] = useState('/Users/rahulk...uments/Codex');
  const [fileDestination, setFileDestination] = useState('VS Code');
  const [language, setLanguage] = useState('Auto detect');
  const [showInMenuBar, setShowInMenuBar] = useState(true);
  const [confirmClosing, setConfirmClosing] = useState('Close shortcut only');

  // Dropdown states
  const [isFileDestOpen, setIsFileDestOpen] = useState(false);
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // Esc key closes settings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const personalItems = [
    { id: 'general', label: 'General', icon: SettingsIcon },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'import', label: 'Import', icon: Download },
    { id: 'profile', label: 'Profile', icon: User, external: true },
    { id: 'configuration', label: 'Configuration', icon: Sliders },
    { id: 'personalization', label: 'Personalization', icon: Sparkles },
    { id: 'report', label: 'Report', icon: Flag },
  ];

  const integrationItems = [
    { id: 'plugins', label: 'Plugins', icon: Puzzle },
    { id: 'computer_use', label: 'Computer use', icon: Laptop },
    { id: 'browser', label: 'Browser', icon: Globe },
  ];

  const filteredPersonal = personalItems.filter((i) =>
    i.label.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredIntegrations = integrationItems.filter((i) =>
    i.label.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div
      className={`settings-view-root flex w-full h-full ${
        isLight ? 'settings-theme-light bg-[#ffffff] text-[#1f2937]' : 'settings-theme-dark bg-[#18181b] text-[#e5e5e7]'
      } select-none overflow-hidden animate-fadeIn`}
      data-theme={theme}
    >
      {/* 1. Settings Left Sidebar Navigation (Matching uploaded screenshot) */}
      <div className={`settings-sidebar w-[260px] h-full flex flex-col border-r ${isLight ? 'border-[#e2e2e8] bg-[#f4f4f7]' : 'border-[#26262a] bg-[#18181b]'} shrink-0`}>
        {/* Title */}
        <div className="px-4 pt-5 pb-3">
          <h2 className={`text-[17px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'} tracking-tight`}>Settings</h2>
        </div>

        {/* Search Input Box */}
        <div className="px-3 pb-3">
          <div className={`flex items-center gap-2 px-2.5 py-1.5 ${isLight ? 'bg-white border-[#d8d8de] text-[#1f2937]' : 'bg-[#242428] border-[#2e2e33] text-neutral-300'} border rounded-lg focus-within:border-neutral-500 transition-colors`}>
            <Search className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search"
              className={`bg-transparent text-xs ${isLight ? 'text-[#1f2937] placeholder-neutral-400' : 'text-[#e5e5e7] placeholder-neutral-400'} focus:outline-none w-full`}
            />
          </div>
        </div>

        {/* Navigation List */}
        <div className="flex-1 overflow-y-auto px-2 space-y-4 pb-6 scrollbar-thin scrollbar-thumb-neutral-700">
          {/* Section: Personal */}
          {filteredPersonal.length > 0 && (
            <div>
              <div className={`px-3 text-[11px] font-medium ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'} mb-1 tracking-wide`}>
                Personal
              </div>
              <div className="space-y-0.5">
                {filteredPersonal.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSettingsTab(item.id)}
                      className={`settings-nav-btn w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer text-left ${
                        isActive
                          ? isLight
                            ? 'active bg-white text-[#1f2937] font-semibold border border-[#dcdce2] shadow-xs'
                            : 'active bg-[#32313a] text-white font-medium border border-white/10 shadow-xs'
                          : isLight
                          ? 'text-[#374151] hover:text-[#1f2937] hover:bg-[#eaebee]'
                          : 'text-[#a1a1aa] hover:text-[#e5e5e7] hover:bg-[#2c2b35]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon className={`w-4 h-4 shrink-0 ${isActive ? (isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]') : (isLight ? 'text-[#4b5563]' : 'text-neutral-400')}`} />
                        <span className="truncate">{item.label}</span>
                      </div>
                      {item.external && (
                        <ArrowUpRight className={`w-3.5 h-3.5 ${isLight ? 'text-neutral-400' : 'text-neutral-500'} shrink-0 ml-1`} />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section: Integrations */}
          {filteredIntegrations.length > 0 && (
            <div>
              <div className={`px-3 text-[11px] font-medium ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'} mb-1 tracking-wide`}>
                Integrations
              </div>
              <div className="space-y-0.5">
                {filteredIntegrations.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSettingsTab(item.id)}
                      className={`settings-nav-btn w-full flex items-center justify-between px-3.5 py-2 rounded-xl text-[13px] font-medium transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer text-left ${
                        isActive
                          ? isLight
                            ? 'active bg-white text-[#1f2937] font-semibold border border-[#dcdce2] shadow-xs'
                            : 'active bg-[#32313a] text-white font-medium border border-white/10 shadow-xs'
                          : isLight
                          ? 'text-[#374151] hover:text-[#1f2937] hover:bg-[#eaebee]'
                          : 'text-[#a1a1aa] hover:text-[#e5e5e7] hover:bg-[#2c2b35]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon className={`w-4 h-4 shrink-0 ${isActive ? (isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]') : (isLight ? 'text-[#4b5563]' : 'text-neutral-400')}`} />
                        <span className="truncate">{item.label}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Settings Content Area (Matching uploaded screenshot for General) */}
      <div className={`settings-content-panel settings-panel flex-1 h-full overflow-y-auto ${isLight ? 'bg-[#ffffff] text-[#1f2937]' : 'bg-[#18181b] text-[#e5e5e7]'} p-8 md:p-12 relative`}>
        {/* Top Right Done/Close Button */}
        {onClose && (
          <button
            onClick={onClose}
            title="Done / Back to Workspace (Esc)"
            className={`absolute top-8 right-8 flex items-center gap-1.5 text-xs ${
              isLight
                ? 'text-[#4b5563] hover:text-[#1f2937] bg-[#f4f4f7] hover:bg-[#eaebee] border-[#dcdce2]'
                : 'text-neutral-400 hover:text-[#e5e5e7] bg-[#26262b] hover:bg-[#323238] border-[#35353d]'
            } border px-3 py-1.5 rounded-lg transition-colors cursor-pointer shadow-sm`}
          >
            <span>Done</span>
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="max-w-[760px] mx-auto">
          {activeTab === 'general' ? (
            <div className="space-y-8 animate-fadeIn">
              {/* Heading */}
              <div>
                <h1 className={`text-[28px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                  General
                </h1>
              </div>

              {/* Section 1: Permissions */}
              <div className="space-y-3">
                <h2 className={`text-[13px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                  Permissions
                </h2>

                <div className={`rounded-xl border p-4 divide-y ${
                  isLight ? 'bg-[#f8f9fa] border-[#e2e4e8] divide-[#ececed]' : 'bg-[#1d1d21] border-[#2b2b32] divide-[#2a2932]'
                }`}>
                  {/* Default permissions */}
                  <div className="flex items-start justify-between gap-6 pb-4">
                    <div className="space-y-1 max-w-[500px]">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        Default permissions
                      </div>
                      <div className={`text-xs leading-relaxed settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                        By default, ChatGPT can read and edit files in its workspace. It can ask for additional access when needed
                      </div>
                    </div>
                    {/* SquishSwitch for Default Permissions */}
                    <SquishSwitch
                      checked={defaultPermissions}
                      onChange={setDefaultPermissions}
                      ariaLabel="Default permissions"
                      trackColor={isLight ? '#e2e4e8' : '#2e2d36'}
                      trackOnColor={isLight ? '#2563eb' : '#3b82f6'}
                      thumbColor="#ffffff"
                      thumbOnColor="#ffffff"
                      width={48}
                      height={26}
                      radius={13}
                      speed={55}
                      stretch={34}
                    />
                  </div>

                  {/* Full access */}
                  <div className="flex items-start justify-between gap-6 pt-4">
                    <div className="space-y-1 max-w-[500px]">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        Full access
                      </div>
                      <div className={`text-xs leading-relaxed settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                        When ChatGPT runs with full access, it can edit any file on your computer and run commands with network, without your approval. This significantly increases the risk of data loss, leaks, or unexpected behavior.{' '}
                        <a
                          href="https://ai.google.dev/gemini-api/docs"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#3b82f6] hover:underline"
                        >
                          Learn more
                        </a>{' '}
                        about elevated risks.
                      </div>
                    </div>
                    {/* SquishSwitch for Full Access */}
                    <SquishSwitch
                      checked={fullAccess}
                      onChange={setFullAccess}
                      ariaLabel="Full access"
                      trackColor={isLight ? '#e2e4e8' : '#2e2d36'}
                      trackOnColor={isLight ? '#2563eb' : '#3b82f6'}
                      thumbColor="#ffffff"
                      thumbOnColor="#ffffff"
                      width={48}
                      height={26}
                      radius={13}
                      speed={55}
                      stretch={34}
                    />
                  </div>
                </div>
              </div>

              {/* Section 2: General */}
              <div className="space-y-3">
                <h2 className={`text-[13px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                  General
                </h2>

                <div className={`rounded-xl border p-4 divide-y ${
                  isLight ? 'bg-[#f8f9fa] border-[#e2e4e8] divide-[#ececed]' : 'bg-[#1d1d21] border-[#2b2b32] divide-[#2a2932]'
                }`}>
                  {/* Projectless task folder */}
                  <div className="flex items-center justify-between gap-4 py-3.5 first:pt-1">
                    <div className="space-y-1 max-w-[420px]">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        Projectless task folder
                      </div>
                      <div className={`text-xs settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                        The location where tasks started outside of projects store their data by default.
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-mono select-all ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        {taskFolder}
                      </span>
                      <button
                        onClick={() => {
                          const newPath = prompt('Enter new task folder path:', taskFolder);
                          if (newPath) setTaskFolder(newPath);
                        }}
                        className={`px-3 py-1.5 border text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                          isLight
                            ? 'bg-white hover:bg-[#f1f3f5] border-[#d8d8de] text-[#1f2937] hover:text-black'
                            : 'bg-[#2a2933] hover:bg-[#343340] border-[#383745] text-[#e5e5e7] hover:text-white'
                        }`}
                      >
                        Change
                      </button>
                    </div>
                  </div>

                  {/* Default file open destination */}
                  <div className="flex items-center justify-between gap-4 py-3.5">
                    <div className="space-y-1">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        Default file open destination
                      </div>
                      <div className={`text-xs settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                        Where files and folders open by default
                      </div>
                    </div>
                    <div className="relative">
                      <button
                        onClick={() => setIsFileDestOpen((v) => !v)}
                        className={`px-3 py-1.5 border rounded-lg flex items-center gap-2 text-xs font-medium transition-colors cursor-pointer ${
                          isLight
                            ? 'bg-white hover:bg-[#f4f4f7] border-[#d8d8de] text-[#1f2937] hover:text-black'
                            : 'bg-[#25242d] hover:bg-[#2e2d38] border border-[#363542] text-[#e5e5e7] hover:text-white'
                        }`}
                      >
                        {/* VS Code icon */}
                        <svg className="w-3.5 h-3.5 text-[#007acc]" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.27a.997.997 0 0 0-.056 1.439l3.52 3.29-3.52 3.29a.997.997 0 0 0 .056 1.44l1.322 1.21a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.94-2.377A1.5 1.5 0 0 0 24 19.896V4.104a1.5 1.5 0 0 0-.85-1.517zM18 17.5l-6.5-5.5L18 6.5v11z"/>
                        </svg>
                        <span>{fileDestination}</span>
                        <ChevronDown className={`w-3 h-3 ml-0.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`} />
                      </button>

                      {isFileDestOpen && (
                        <div className={`absolute right-0 top-full mt-1.5 w-40 border rounded-lg shadow-xl py-1 z-30 ${
                          isLight ? 'bg-white border-[#d8d8de]' : 'bg-[#222129] border-[#363542]'
                        }`}>
                          {['VS Code', 'Cursor', 'Sublime Text', 'System Default'].map((dest) => (
                            <button
                              key={dest}
                              onClick={() => {
                                setFileDestination(dest);
                                setIsFileDestOpen(false);
                              }}
                              className={`w-full px-3 py-1.5 text-xs text-left flex items-center justify-between cursor-pointer ${
                                isLight
                                  ? 'text-[#1f2937] hover:bg-[#f4f4f7]'
                                  : 'text-[#e5e5e7] hover:bg-[#2c2b36] hover:text-white'
                              }`}
                            >
                              <span>{dest}</span>
                              {fileDestination === dest && <Check className="w-3 h-3 text-cyan-500" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Language */}
                  <div className="flex items-center justify-between gap-4 py-3.5">
                    <div className="space-y-1">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>Language</div>
                      <div className={`text-xs settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>Language for the app UI</div>
                    </div>
                    <div className="relative">
                      <button
                        onClick={() => setIsLangOpen((v) => !v)}
                        className={`px-3 py-1.5 border rounded-lg flex items-center gap-2 text-xs font-medium transition-colors cursor-pointer ${
                          isLight
                            ? 'bg-white hover:bg-[#f4f4f7] border-[#d8d8de] text-[#1f2937] hover:text-black'
                            : 'bg-[#25242d] hover:bg-[#2e2d38] border border-[#363542] text-[#e5e5e7] hover:text-white'
                        }`}
                      >
                        <span>{language}</span>
                        <ChevronDown className={`w-3 h-3 ml-0.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`} />
                      </button>

                      {isLangOpen && (
                        <div className={`absolute right-0 top-full mt-1.5 w-40 border rounded-lg shadow-xl py-1 z-30 ${
                          isLight ? 'bg-white border-[#d8d8de]' : 'bg-[#222129] border-[#363542]'
                        }`}>
                          {['Auto detect', 'English (US)', 'Spanish', 'French', 'German', 'Japanese'].map((lang) => (
                            <button
                              key={lang}
                              onClick={() => {
                                setLanguage(lang);
                                setIsLangOpen(false);
                              }}
                              className={`w-full px-3 py-1.5 text-xs text-left flex items-center justify-between cursor-pointer ${
                                isLight
                                  ? 'text-[#1f2937] hover:bg-[#f4f4f7]'
                                  : 'text-[#e5e5e7] hover:bg-[#2c2b36] hover:text-white'
                              }`}
                            >
                              <span>{lang}</span>
                              {language === lang && <Check className="w-3 h-3 text-cyan-500" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Show in menu bar */}
                  <div className="flex items-center justify-between gap-4 py-3.5">
                    <div className="space-y-1">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        Show in menu bar
                      </div>
                      <div className={`text-xs settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                        Keep ChatGPT in the macOS menu bar when the main window is closed
                      </div>
                    </div>
                    {/* SquishSwitch for Menu Bar Toggle */}
                    <SquishSwitch
                      checked={showInMenuBar}
                      onChange={setShowInMenuBar}
                      ariaLabel="Show in menu bar"
                      trackColor={isLight ? '#e2e4e8' : '#2e2d36'}
                      trackOnColor={isLight ? '#2563eb' : '#3b82f6'}
                      thumbColor="#ffffff"
                      thumbOnColor="#ffffff"
                      width={48}
                      height={26}
                      radius={13}
                      speed={55}
                      stretch={34}
                    />
                  </div>

                  {/* Confirm before closing a window */}
                  <div className="flex items-center justify-between gap-4 py-3.5 last:pb-1">
                    <div className="space-y-1">
                      <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                        Confirm before closing a window
                      </div>
                      <div className={`text-xs settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                        Warn when a tab-close shortcut would close the window
                      </div>
                    </div>
                    <div className="relative">
                      <button
                        onClick={() => setIsConfirmOpen((v) => !v)}
                        className={`px-3 py-1.5 border rounded-lg flex items-center gap-2 text-xs font-medium transition-colors cursor-pointer ${
                          isLight
                            ? 'bg-white hover:bg-[#f4f4f7] border-[#d8d8de] text-[#1f2937] hover:text-black'
                            : 'bg-[#25242d] hover:bg-[#2e2d38] border border-[#363542] text-[#e5e5e7] hover:text-white'
                        }`}
                      >
                        <span>{confirmClosing}</span>
                        <ChevronDown className={`w-3 h-3 ml-0.5 ${isLight ? 'text-neutral-500' : 'text-neutral-400'}`} />
                      </button>

                      {isConfirmOpen && (
                        <div className={`absolute right-0 top-full mt-1.5 w-44 border rounded-lg shadow-xl py-1 z-30 ${
                          isLight ? 'bg-white border-[#d8d8de]' : 'bg-[#222129] border-[#363542]'
                        }`}>
                          {['Close shortcut only', 'Always confirm', 'Never confirm'].map((opt) => (
                            <button
                              key={opt}
                              onClick={() => {
                                setConfirmClosing(opt);
                                setIsConfirmOpen(false);
                              }}
                              className={`w-full px-3 py-1.5 text-xs text-left flex items-center justify-between cursor-pointer ${
                                isLight
                                  ? 'text-[#1f2937] hover:bg-[#f4f4f7]'
                                  : 'text-[#e5e5e7] hover:bg-[#2c2b36] hover:text-white'
                              }`}
                            >
                              <span>{opt}</span>
                              {confirmClosing === opt && <Check className="w-3 h-3 text-cyan-500" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : activeTab === 'configuration' ? (
            <ManageModelsView
            providers={providers}
            providerCatalog={providerCatalog}
              onToggleProvider={toggleProviderEnabled}
              onToggleModel={toggleModelEnabled}
              onConnectProvider={connectProvider}
              onAddCustomProvider={addCustomProvider}
            />
          ) : activeTab === 'personalization' ? (
            <div className="space-y-8 animate-fadeIn">
              {/* Heading */}
              <div>
                <h1 className={`text-[28px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                  Personalization
                </h1>
                <p className={`text-xs mt-1 leading-relaxed ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                  Customize your workspace appearance, interface themes, and visual comfort.
                </p>
              </div>

              {/* Theme Mode Selector Cards */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className={`text-[13px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                    Workspace Theme
                  </h2>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                    isLight ? 'bg-emerald-100 text-emerald-800' : 'bg-cyan-950/60 text-cyan-400 border border-cyan-800/60'
                  }`}>
                    Active: {theme === 'light' ? 'Light mode' : 'Dark mode'}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Dark Mode Card */}
                  <div
                    onClick={() => setTheme('dark')}
                    className={`relative p-4 rounded-xl border cursor-pointer transition-all ${
                      theme === 'dark'
                        ? 'border-blue-500 ring-2 ring-blue-500/20 bg-[#1c1c22] shadow-md'
                        : isLight
                        ? 'border-[#e2e4e8] hover:border-[#cbd5e1] bg-[#f8f9fa] hover:bg-[#f1f3f5]'
                        : 'border-[#2b2b32] hover:border-[#383742] bg-[#1d1d21] hover:bg-[#232328]'
                    }`}
                  >
                    {/* Miniature UI Mockup */}
                    <div className="w-full h-28 rounded-lg overflow-hidden bg-[#28272c] border border-[#383740] mb-3 flex flex-col shadow-inner select-none">
                      <div className="h-5 bg-[#212025] border-b border-[#32313a] flex items-center px-2 gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-[#ef4444]/80 inline-block" />
                        <span className="w-2 h-2 rounded-full bg-[#eab308]/80 inline-block" />
                        <span className="w-2 h-2 rounded-full bg-[#22c55e]/80 inline-block" />
                        <div className="ml-2 h-2.5 w-16 bg-[#141415] rounded-xs" />
                      </div>
                      <div className="flex-1 flex">
                        <div className="w-8 bg-[#1e1e22] border-r border-[#2d2c34] p-1 flex flex-col gap-1">
                          <div className="w-full h-2 bg-[#3a3942] rounded-xs" />
                          <div className="w-full h-2 bg-[#2f2e36] rounded-xs" />
                          <div className="w-full h-2 bg-[#2f2e36] rounded-xs" />
                        </div>
                        <div className="flex-1 bg-[#141415] p-2 flex flex-col justify-between">
                          <div className="space-y-1">
                            <div className="w-20 h-2 bg-[#79c0ff]/70 rounded-xs" />
                            <div className="w-28 h-2 bg-[#7ee787]/70 rounded-xs" />
                            <div className="w-16 h-2 bg-[#e3b341]/70 rounded-xs" />
                          </div>
                          <div className="w-full h-4 bg-[#1f1e24] border border-[#2e2d36] rounded flex items-center px-1">
                            <div className="w-12 h-1.5 bg-[#4b4a56] rounded-xs" />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[13.5px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                            Dark mode
                          </span>
                          {theme === 'dark' && (
                            <span className="px-1.5 py-0.5 text-[10px] bg-blue-500/20 text-blue-400 font-medium rounded">
                              Current
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-1 leading-relaxed ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                          Deep charcoal and slate canvas crafted for low-light coding and developer focus.
                        </p>
                      </div>
                      <div
                        className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                          theme === 'dark'
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : isLight
                            ? 'border-[#cbd5e1] bg-white'
                            : 'border-neutral-600 bg-neutral-800'
                        }`}
                      >
                        {theme === 'dark' && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>
                    </div>
                  </div>

                  {/* Light Mode Card */}
                  <div
                    onClick={() => setTheme('light')}
                    className={`relative p-4 rounded-xl border cursor-pointer transition-all ${
                      theme === 'light'
                        ? 'border-blue-600 ring-2 ring-blue-500/20 bg-blue-50/20 shadow-md'
                        : isLight
                        ? 'border-[#e2e4e8] hover:border-[#cbd5e1] bg-[#f8f9fa] hover:bg-[#f1f3f5]'
                        : 'border-[#2b2b32] hover:border-[#383742] bg-[#1d1d21] hover:bg-[#232328]'
                    }`}
                  >
                    {/* Miniature UI Mockup */}
                    <div className="w-full h-28 rounded-lg overflow-hidden bg-[#ebebef] border border-[#dcdce2] mb-3 flex flex-col shadow-inner select-none">
                      <div className="h-5 bg-[#e0e0e6] border-b border-[#d8d8de] flex items-center px-2 gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-[#ef4444] inline-block" />
                        <span className="w-2 h-2 rounded-full bg-[#eab308] inline-block" />
                        <span className="w-2 h-2 rounded-full bg-[#22c55e] inline-block" />
                        <div className="ml-2 h-2.5 w-16 bg-[#ffffff] rounded-xs border border-[#d8d8de]" />
                      </div>
                      <div className="flex-1 flex">
                        <div className="w-8 bg-[#f4f4f7] border-r border-[#dcdce2] p-1 flex flex-col gap-1">
                          <div className="w-full h-2 bg-[#d1d5db] rounded-xs" />
                          <div className="w-full h-2 bg-[#e5e7eb] rounded-xs" />
                          <div className="w-full h-2 bg-[#e5e7eb] rounded-xs" />
                        </div>
                        <div className="flex-1 bg-[#ffffff] p-2 flex flex-col justify-between">
                          <div className="space-y-1">
                            <div className="w-20 h-2 bg-[#0284c7] rounded-xs" />
                            <div className="w-28 h-2 bg-[#059669] rounded-xs" />
                            <div className="w-16 h-2 bg-[#d97706] rounded-xs" />
                          </div>
                          <div className="w-full h-4 bg-[#f8f9fa] border border-[#e2e4e8] rounded flex items-center px-1">
                            <div className="w-12 h-1.5 bg-[#9ca3af] rounded-xs" />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[13.5px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                            Light mode
                          </span>
                          {theme === 'light' && (
                            <span className="px-1.5 py-0.5 text-[10px] bg-blue-100 text-blue-700 font-medium rounded">
                              Current
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-1 leading-relaxed ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                          Clean, paper-white studio workspace with razor-sharp contrast and balanced borders.
                        </p>
                      </div>
                      <div
                        className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                          theme === 'light'
                            ? 'bg-blue-600 border-blue-600 text-white'
                            : isLight
                            ? 'border-[#cbd5e1] bg-white'
                            : 'border-neutral-600 bg-neutral-800'
                        }`}
                      >
                        {theme === 'light' && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Typography & Code Hierarchy Section */}
              <div className="space-y-3">
                <h2 className={`text-[13px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                  Typography & Color Contrast Preview
                </h2>

                <div
                  className={`rounded-xl border p-5 space-y-4 ${
                    isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#1d1d21] border-[#2b2b32]'
                  }`}
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-neutral-400">
                        Font & Tone Hierarchy
                      </div>
                      <div className="space-y-2">
                        <div className={`text-[15px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                          Primary Heading (100% Contrast)
                        </div>
                        <div className={`text-xs leading-relaxed ${isLight ? 'text-[#374151]' : 'text-[#d4d4d8]'}`}>
                          Secondary body copy with balanced weight and optimal reading rhythm across multi-turn conversations.
                        </div>
                        <div className={`text-[11px] ${isLight ? 'text-[#4b5563]' : 'text-[#9b9aa3]'}`}>
                          Tertiary metadata, timestamps, and commit hashes.
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-neutral-400">
                        Code Preview ({theme} mode)
                      </div>
                      <div
                        className={`p-3 rounded-lg border font-mono text-[11px] leading-relaxed ${
                          isLight
                            ? 'bg-white border-[#e2e4e8] text-[#1e293b]'
                            : 'bg-[#141416] border-[#282730] text-[#e1e4ea]'
                        }`}
                      >
                        <div>
                          <span className={isLight ? 'text-[#6d28d9] font-medium' : 'text-[#d2a8ff]'}>function </span>
                          <span className={isLight ? 'text-[#0369a1]' : 'text-[#79c0ff]'}>calculateSum</span>
                          <span>(a: number, b: number) &#123;</span>
                        </div>
                        <div className="pl-3">
                          <span className={isLight ? 'text-[#64748b] italic' : 'text-[#687082] italic'}>// Verification check</span>
                        </div>
                        <div className="pl-3">
                          <span className={isLight ? 'text-[#6d28d9] font-medium' : 'text-[#d2a8ff]'}>return </span>
                          <span className={isLight ? 'text-[#047857]' : 'text-[#7ee787]'}>a + b</span>;
                        </div>
                        <div>&#125;</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Quick Switch Toggle */}
              <div
                className={`rounded-xl border p-4 flex items-center justify-between gap-4 ${
                  isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#1d1d21] border-[#2b2b32]'
                }`}
              >
                <div>
                  <div className={`text-[13.5px] font-medium settings-item-title ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                    Toggle light mode instantly
                  </div>
                  <div className={`text-xs settings-item-desc ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                    Switch current theme between light and dark mode with one click.
                  </div>
                </div>

                <SquishSwitch
                  checked={isLight}
                  onChange={(val) => setTheme(val ? 'light' : 'dark')}
                  ariaLabel="Toggle light mode"
                  trackColor="#2e2d36"
                  trackOnColor={isLight ? '#2563eb' : '#3b82f6'}
                  thumbColor="#ffffff"
                  thumbOnColor="#ffffff"
                  width={48}
                  height={26}
                  radius={13}
                  speed={55}
                  stretch={34}
                />
              </div>
            </div>
          ) : activeTab === 'report' ? (
            <div className="space-y-6 animate-fadeIn">
              <div>
                <h1 className={`text-[28px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                  Report
                </h1>
                <p className={`text-xs mt-1 leading-relaxed ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                  View diagnostic logs and generated performance reports for your workspace.
                </p>
              </div>

              <div className={`p-12 rounded-2xl border text-center flex flex-col items-center justify-center min-h-[320px] ${
                isLight ? 'bg-[#f8f9fa] border-[#e2e4e8] text-[#1f2937]' : 'bg-[#1d1d21] border-[#2b2b32] text-[#e5e5e7]'
              }`}>
                <div className={`w-12 h-12 rounded-full flex items-center justify-center mb-3 ${
                  isLight ? 'bg-[#e4e5e9] text-[#6b7280]' : 'bg-[#28272f] text-neutral-400'
                }`}>
                  <Flag className="w-6 h-6" />
                </div>
                <h3 className={`text-base font-semibold ${isLight ? 'text-[#111827]' : 'text-white'}`}>No reports available</h3>
                <p className={`text-xs mt-1 max-w-sm ${isLight ? 'text-[#6b7280]' : 'text-neutral-400'}`}>
                  Diagnostic reports and system usage logs will appear here when generated.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-6 animate-fadeIn">
              <h1 className={`text-[28px] font-semibold tracking-tight capitalize ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                {activeTab.replace('_', ' ')}
              </h1>
              <div className={`p-6 rounded-xl border text-sm space-y-2 ${
                isLight ? 'bg-[#f8f9fa] border-[#e2e4e8] text-[#1f2937]' : 'bg-[#1d1d21] border-[#2b2b32] text-[#e5e5e7]'
              }`}>
                <p>Configure options and preferences for {activeTab.replace('_', ' ')}.</p>
                <p className={`text-xs ${isLight ? 'text-[#4b5563]' : 'text-neutral-500'}`}>
                  Settings are automatically synced to your local developer profile.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
