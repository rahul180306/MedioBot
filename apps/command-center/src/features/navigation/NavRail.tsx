import React, { useState, useRef, useEffect } from 'react';
import {
  Clock,
  MoreHorizontal,
  Settings,
  ChevronRight,
  LifeBuoy,
  LogOut,
  Home,
  UserRound,
  LogIn,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { SignInModal } from '../auth/SignInModal';

export const NavRail: React.FC = () => {
  const {
    activeThreadId,
    createNewChat,
    toggleSidebar,
    isSidebarOpen,
    sidebarTab,
    setSidebarTab,
    setSidebarOpen,
    setActiveModal,
    openSettings,
    closeSettings,
    setIsSettingsView,
    setActiveWorkbenchTabId,
    isSettingsView,
    isLibraryView,
    openLibrary,
    closeLibrary,
    selectAgent,
    selectedMediobotId,
    user,
    signOut,
    theme,
  } = useApp();

  const isLight = theme === 'light';

  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isSignInModalOpen, setIsSignInModalOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const profileBtnRef = useRef<HTMLButtonElement>(null);

  const isHomeActive = !isSettingsView && !isLibraryView && isSidebarOpen && sidebarTab === 'home';
  const isHistoryActive = !isSettingsView && !isLibraryView && isSidebarOpen && sidebarTab === 'history';
  const isMaestroActive = !isSettingsView && !isLibraryView && isSidebarOpen && sidebarTab === 'maestro';
  const isLibraryActive = !isSettingsView && isLibraryView;

  const handleHomeClick = () => {
    if (isSettingsView) {
      setIsSettingsView(false);
      setActiveWorkbenchTabId(null);
      selectAgent(null);
      setSidebarTab('home');
      setSidebarOpen(true);
      return;
    }
    if (isLibraryView) {
      closeLibrary();
    }
    selectAgent(null);
    if (!isSidebarOpen || sidebarTab !== 'home') {
      setSidebarTab('home');
      setSidebarOpen(true);
    } else {
      setSidebarOpen(false);
    }
  };

  const handleHistoryClick = () => {
    if (isSettingsView) {
      closeSettings();
      selectAgent(null);
      setSidebarTab('history');
      setSidebarOpen(true);
      return;
    }
    if (isLibraryView) {
      closeLibrary();
    }
    if (!isSidebarOpen || sidebarTab !== 'history') {
      selectAgent(null);
      setSidebarTab('history');
      setSidebarOpen(true);
    } else {
      setSidebarOpen(false);
    }
  };

  const handleMaestroClick = () => {
    selectAgent(null);
    if (isSettingsView) {
      closeSettings();
      setSidebarTab('maestro');
      setSidebarOpen(true);
      return;
    }
    if (isLibraryView) {
      closeLibrary();
      setSidebarTab('maestro');
      setSidebarOpen(true);
      return;
    }
    if (!isSidebarOpen || sidebarTab !== 'maestro') {
      setSidebarTab('maestro');
      setSidebarOpen(true);
    } else {
      setSidebarOpen(false);
    }
  };

  const handleLibraryClick = () => {
    if (isSettingsView) {
      closeSettings();
    }
    if (isLibraryView) {
      closeLibrary();
    } else {
      openLibrary();
    }
  };

  // Click outside listener for the profile menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        profileMenuRef.current &&
        !profileMenuRef.current.contains(e.target as Node) &&
        profileBtnRef.current &&
        !profileBtnRef.current.contains(e.target as Node)
      ) {
        setIsProfileMenuOpen(false);
      }
    };
    if (isProfileMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isProfileMenuOpen]);

  return (
    <>
      <aside
        className={`w-[58px] h-screen flex flex-col items-center justify-between pt-11 pb-3.5 z-30 shrink-0 select-none relative transition-colors ${
          isLight ? 'bg-[#ebebef]' : 'bg-[#28272c]'
        }`}
      >
        {/* Top Nav Group (matches image: Home card, Clock, Library/Books) */}
        <div className="flex flex-col items-center gap-4 w-full pt-1">
          {/* Keep the supplied home-rail interaction while using the shared icon family. */}
          <button
            onClick={handleHomeClick}
            title="Home / New Chat"
            className={`w-[44px] h-[44px] flex items-center justify-center rounded-2xl transition-all group relative cursor-pointer active:scale-95 ${
              isHomeActive
                ? isLight
                  ? 'bg-[#dedee6] text-[#09090b] shadow-xs'
                  : 'bg-[#39383f] text-white shadow-xs'
                : isLight
                ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]'
                : 'text-[#8e8d96] hover:text-white hover:bg-[#323137]'
            }`}
          >
            <Home size={20} strokeWidth={1.8} />
            {/* Subtle tooltip */}
            <span
              className={`pointer-events-none absolute left-[60px] top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] font-medium rounded shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 ${
                isLight ? 'bg-[#ffffff] text-[#111827] border border-[#dcdce2]' : 'bg-[#1e1e22] text-[#e4e4e7] border border-[#2b2b30]'
              }`}
            >
              Home
            </span>
          </button>

          {/* Threads / History Clock Icon */}
          <button
            onClick={handleHistoryClick}
            title="Threads & History"
            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors group relative cursor-pointer active:scale-95 ${
              isHistoryActive
                ? isLight
                  ? 'text-[#09090b] bg-[#dedee6]'
                  : 'text-white bg-[#323137]'
                : isLight
                ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]'
                : 'text-[#8e8d96] hover:text-white hover:bg-[#323137]'
            }`}
          >
            <Clock className="w-5 h-5 stroke-[1.75]" />
            <span
              className={`pointer-events-none absolute left-[60px] top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] font-medium rounded shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 ${
                isLight ? 'bg-[#ffffff] text-[#111827] border border-[#dcdce2]' : 'bg-[#1e1e22] text-[#e4e4e7] border border-[#2b2b30]'
              }`}
            >
              History
            </span>
          </button>

          {/* Maestro Bots Button: circle with two vertical blinking eyes */}
          <button
            onClick={handleMaestroClick}
            title="Maestro Agents"
            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors group relative cursor-pointer active:scale-95 ${
              isMaestroActive
                ? isLight
                  ? 'text-[#09090b] bg-[#dedee6]'
                  : 'text-white bg-[#323137]'
                : isLight
                ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]'
                : 'text-[#8e8d96] hover:text-white hover:bg-[#323137]'
            }`}
          >
            {/* Circle with two vertical blinking eyes matching icons style */}
            <div className={`w-[20px] h-[20px] rounded-full ${isLight ? 'bg-[#dedee6]' : 'bg-[#f4f4f5]'} flex items-center justify-center gap-[2.5px] shrink-0 shadow-xs transition-transform group-hover:scale-105`}>
              <span
                className="w-[2.2px] h-[6.5px] rounded-full bg-black animate-eye-blink block"
                style={{ animationDelay: '0.2s' }}
              />
              <span
                className="w-[2.2px] h-[6.5px] rounded-full bg-black animate-eye-blink block"
                style={{ animationDelay: '0.2s' }}
              />
            </div>
            <span
              className={`pointer-events-none absolute left-[60px] top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] font-medium rounded shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 ${
                isLight ? 'bg-[#ffffff] text-[#111827] border border-[#dcdce2]' : 'bg-[#1e1e22] text-[#e4e4e7] border border-[#2b2b30]'
              }`}
            >
              Maestro
            </span>
          </button>

          {/* Library / Books Icon */}
          <button
            onClick={handleLibraryClick}
            title="Workspace Library"
            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors group relative cursor-pointer active:scale-95 ${
              isLibraryActive
                ? isLight
                  ? 'text-[#09090b] bg-[#dedee6]'
                  : 'text-white bg-[#323137]'
                : isLight
                ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]'
                : 'text-[#8e8d96] hover:text-white hover:bg-[#323137]'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2.5" y="4" width="4.5" height="16" rx="1.8" />
              <rect x="9" y="4" width="4.5" height="16" rx="1.8" />
              <rect x="15.5" y="4" width="4.5" height="16" rx="1.8" transform="rotate(11 17.75 20)" />
            </svg>
            <span
              className={`pointer-events-none absolute left-[60px] top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] font-medium rounded shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 ${
                isLight ? 'bg-[#ffffff] text-[#111827] border border-[#dcdce2]' : 'bg-[#1e1e22] text-[#e4e4e7] border border-[#2b2b30]'
              }`}
            >
              Library
            </span>
          </button>

        </div>

        {/* Bottom Nav Group */}
        <div className="flex flex-col items-center gap-1.5 w-full relative">
          {/* User Account / Profile Button */}
          <button
            ref={profileBtnRef}
            onClick={() => setIsProfileMenuOpen((prev) => !prev)}
            title={user.isSignedIn ? user.name : 'Account / Sign in'}
            aria-label="Account / Profile"
            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all duration-300 group relative cursor-pointer ${
              isProfileMenuOpen
                ? isLight
                  ? 'bg-[#dedee6] text-[#09090b]'
                  : 'bg-[#39383f] text-white'
                : isLight
                ? 'text-[#6b6a75] hover:text-[#09090b] hover:bg-[#dedee5]'
                : 'text-[#8e8d96] hover:text-white hover:bg-[#323137]'
            }`}
          >
            <div className="relative w-5 h-5 flex items-center justify-center">
              {/* Outline icon: visible when closed and not hovered */}
              <UserRound
                size={19}
                className={`transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] absolute inset-0 m-auto ${
                  isProfileMenuOpen
                    ? 'opacity-0 scale-90'
                    : 'group-hover:opacity-0 group-hover:scale-90'
                }`}
              />

              {/* Solid icon: visible when clicked/opened OR when hovered */}
              <UserRound
                size={19}
                strokeWidth={2.4}
                className={`transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] absolute inset-0 m-auto ${
                  isProfileMenuOpen
                    ? 'opacity-100 scale-100'
                    : 'opacity-0 scale-90 group-hover:opacity-100 group-hover:scale-100'
                }`}
              />
            </div>

            {!isProfileMenuOpen && (
              <span
                className={`pointer-events-none absolute left-[60px] top-1/2 -translate-y-1/2 px-2 py-1 text-[11px] font-medium rounded shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 ${
                  isLight ? 'bg-[#ffffff] text-[#111827] border border-[#dcdce2]' : 'bg-[#1e1e22] text-[#e4e4e7] border border-[#2b2b30]'
                }`}
              >
                {user.isSignedIn ? user.name : 'Sign in'}
              </span>
            )}
          </button>

          {/* Profile Popup Menu */}
          <div
            ref={profileMenuRef}
            className={`fixed left-[66px] bottom-3.5 z-[60] w-[230px] rounded-2xl shadow-2xl p-2 origin-bottom-left transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] select-none ${
              isLight ? 'bg-[#ffffff] border border-[#dcdce2] text-[#111827]' : 'bg-[#1e1d23] border border-[#32313a] text-neutral-200'
            } ${
              isProfileMenuOpen
                ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto'
                : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
            }`}
          >
            {/* 1. Header / Sign-in Section */}
            <div className="min-w-0">
              {user.isSignedIn ? (
                <div className="flex items-center gap-2.5 px-2.5 py-2">
                  <div className={`w-8 h-8 rounded-full ${isLight ? 'bg-[#e2e2e8] text-[#111827]' : 'bg-[#52515b] text-neutral-200'} font-semibold text-xs flex items-center justify-center shrink-0`}>
                    {user.avatarText || 'U'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`text-[13px] font-semibold leading-tight truncate ${isLight ? 'text-[#09090b]' : 'text-neutral-100'}`}>
                      {user.name}
                    </div>
                    {user.email && (
                      <div className={`text-[11px] font-normal leading-tight mt-0.5 truncate ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`}>
                        {user.email}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setIsProfileMenuOpen(false);
                    setIsSignInModalOpen(true);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer group shadow-xs text-left ${
                    isLight ? 'bg-[#f4f4f7] hover:bg-[#eaebee] text-[#09090b]' : 'bg-[#2a2933] hover:bg-[#32313a] text-white'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors shrink-0 ${
                      isLight ? 'bg-[#e2e2e8] text-[#09090b]' : 'bg-[#41404e] group-hover:bg-[#4d4b5c] text-neutral-200'
                    }`}>
                      <LogIn size={14} strokeWidth={1.8} />
                    </div>
                    <div className="min-w-0">
                      <div className={`text-[13px] font-semibold leading-tight ${isLight ? 'text-[#09090b]' : 'text-neutral-100'}`}>Sign in</div>
                      <div className={`text-[10px] leading-tight mt-0.5 truncate ${isLight ? 'text-[#64748b]' : 'text-neutral-400'}`}>Sync chats & agents</div>
                    </div>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-neutral-400 group-hover:translate-x-0.5 transition-transform shrink-0" />
                </button>
              )}
            </div>

            {/* 2. Separator line */}
            <div className={`h-[1px] my-1 ${isLight ? 'bg-[#e5e7eb]' : 'bg-[#2b2a33]'}`} />

            {/* 3. Menu Items */}
            <div className="space-y-0.5">
              {/* Settings */}
              <button
                onClick={() => {
                  setIsProfileMenuOpen(false);
                  openSettings();
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer text-left ${
                  isLight ? 'text-[#374151] hover:text-[#09090b] hover:bg-[#eaebee]' : 'text-neutral-300 hover:text-white hover:bg-[#32313a]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Settings className="w-4 h-4 text-neutral-400 shrink-0" strokeWidth={1.75} />
                  <span className="text-[13px] font-medium">Settings</span>
                </div>
              </button>
            </div>

            {/* 4. Separator line */}
            <div className={`h-[1px] my-1 ${isLight ? 'bg-[#e5e7eb]' : 'bg-[#2b2a33]'}`} />

            {/* 5. Help & Auth actions */}
            <div className="space-y-0.5">
              {/* Help */}
              <button
                onClick={() => setIsProfileMenuOpen(false)}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer text-left ${
                  isLight ? 'text-[#374151] hover:text-[#09090b] hover:bg-[#eaebee]' : 'text-neutral-300 hover:text-white hover:bg-[#32313a]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <LifeBuoy className="w-4 h-4 text-neutral-400 shrink-0" strokeWidth={1.75} />
                  <span className="text-[13px] font-medium">Help</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
              </button>

              {/* Log out (only shown when signed in) */}
              {user.isSignedIn && (
                <button
                  onClick={() => {
                    signOut();
                    setIsProfileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer text-left ${
                    isLight ? 'text-rose-600 hover:text-rose-700 hover:bg-rose-50' : 'text-rose-300 hover:text-rose-100 hover:bg-[#331d22]'
                  }`}
                >
                  <LogOut className="w-4 h-4 text-rose-500 shrink-0" strokeWidth={1.75} />
                  <span className="text-[13px] font-medium">Log out</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Real Sign In Modal */}
      <SignInModal
        isOpen={isSignInModalOpen}
        onClose={() => setIsSignInModalOpen(false)}
      />
    </>
  );
};
