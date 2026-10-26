import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ArrowLeft, ArrowRight, Plus, X, MessageSquare, ChevronLeft, ChevronRight } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { FileIcon } from '../../components/icons/FileIcon';
import { ResourceStatusIndicator } from '../../components/ResourceStatusIndicator';

export const TopChrome: React.FC = () => {
  const {
    isSidebarOpen,
    toggleSidebar,
    setSidebarOpen,
    setSidebarTab,
    openProjectDirectory,
    closeLibrary,
    closeSettings,
    createNewChat,
    isSettingsView,
    isLibraryView,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    workbenchTabs,
    activeWorkbenchTabId,
    setActiveWorkbenchTabId,
    closeWorkbenchTab,
    reorderWorkbenchTabs,
    theme,
  } = useApp();

  const isLight = theme === 'light';

  // Side-scrolling ref and controls
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const handleOpenFolderFromComputer = async () => {
    if (isSettingsView) {
      closeSettings();
    }
    if (isLibraryView) {
      closeLibrary();
    }
    try {
      await openProjectDirectory();
      setSidebarTab('home');
      setSidebarOpen(true);
    } catch (err) {
      console.error('Failed to open project directory:', err);
    }
  };

  // Tab elements ref for measuring tab widths
  const tabRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Butter-smooth sliding drag state
  const [activeDrag, setActiveDrag] = useState<{
    index: number;
    tabId: string;
    deltaX: number;
    targetIndex: number;
    isDragging: boolean;
    draggedWidth: number;
  } | null>(null);

  // Suppress transform transitions on drop commit to prevent moved tab jerk
  const [suppressTransitions, setSuppressTransitions] = useState(false);

  // Active Tab Underline Sliding Indicator state
  const [indicatorStyle, setIndicatorStyle] = useState<{
    left: number;
    width: number;
    opacity: number;
  }>({ left: 0, width: 0, opacity: 0 });

  const dragRef = useRef<{
    index: number;
    tabId: string;
    startX: number;
    isDragging: boolean;
    targetIndex: number;
    tabWidths: number[];
    draggedWidth: number;
  } | null>(null);

  const updateIndicator = useCallback(() => {
    if (!activeWorkbenchTabId || isSettingsView || !workbenchTabs || workbenchTabs.length === 0) {
      setIndicatorStyle((prev) => (prev.opacity === 0 ? prev : { ...prev, opacity: 0 }));
      return;
    }

    const activeIndex = workbenchTabs.findIndex((t) => t.id === activeWorkbenchTabId);
    if (activeIndex === -1) {
      setIndicatorStyle((prev) => (prev.opacity === 0 ? prev : { ...prev, opacity: 0 }));
      return;
    }

    const el = tabRefs.current[activeIndex];
    if (!el) return;

    let currentOffset = el.offsetLeft;
    const currentWidth = el.offsetWidth;

    // Account for active drag translation if the active tab or its neighbors are shifted
    if (activeDrag && activeDrag.isDragging) {
      const { index: dragIdx, targetIndex, deltaX, draggedWidth } = activeDrag;
      const gap = 6;
      const shift = draggedWidth + gap;

      if (activeIndex === dragIdx) {
        currentOffset += deltaX;
      } else if (dragIdx < targetIndex && activeIndex > dragIdx && activeIndex <= targetIndex) {
        currentOffset -= shift;
      } else if (dragIdx > targetIndex && activeIndex >= targetIndex && activeIndex < dragIdx) {
        currentOffset += shift;
      }
    }

    const inset = 8;
    const indicatorWidth = Math.max(16, currentWidth - inset * 2);
    const indicatorLeft = currentOffset + inset;

    setIndicatorStyle({
      left: indicatorLeft,
      width: indicatorWidth,
      opacity: 1,
    });
  }, [activeWorkbenchTabId, isSettingsView, workbenchTabs, activeDrag]);

  useEffect(() => {
    updateIndicator();
    const rafId = requestAnimationFrame(updateIndicator);
    window.addEventListener('resize', updateIndicator);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateIndicator);
    };
  }, [updateIndicator]);

  // Update scroll indicators
  const checkScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    checkScroll();
    const el = scrollContainerRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [checkScroll, workbenchTabs]);

  // Handle horizontal mouse wheel scrolling smoothly
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
      el.scrollBy({ left: e.deltaY * 1.5, behavior: 'auto' });
      checkScroll();
    }
  };

  const scrollLeftBy = () => {
    scrollContainerRef.current?.scrollBy({ left: -180, behavior: 'smooth' });
  };

  const scrollRightBy = () => {
    scrollContainerRef.current?.scrollBy({ left: 180, behavior: 'smooth' });
  };

  const endDrag = useCallback(() => {
    const current = dragRef.current;
    if (current) {
      if (current.isDragging && current.targetIndex !== current.index) {
        // Suppress transition during DOM reorder so moved tab already in place does not jerk
        setSuppressTransitions(true);
        reorderWorkbenchTabs(current.index, current.targetIndex);
        setActiveWorkbenchTabId(current.tabId);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setSuppressTransitions(false);
          });
        });
      } else if (!current.isDragging) {
        // Simple click without drag -> activate tab
        setActiveWorkbenchTabId(current.tabId);
      }
    }
    dragRef.current = null;
    setActiveDrag(null);
  }, [reorderWorkbenchTabs, setActiveWorkbenchTabId]);

  // Window pointer listeners during active drag
  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;

      const deltaX = e.clientX - d.startX;

      if (!d.isDragging) {
        if (Math.abs(deltaX) > 3) {
          d.isDragging = true;
        } else {
          return;
        }
      }

      const gap = 6;
      const widths = d.tabWidths;
      const n = widths.length;
      if (n <= 1) return;

      // Centers of each tab
      const centers: number[] = [];
      let accum = 0;
      for (let i = 0; i < n; i++) {
        centers.push(accum + widths[i] / 2);
        accum += widths[i] + gap;
      }

      const draggedWidth = d.draggedWidth;
      const initialCenter = centers[d.index];

      // Clamp deltaX so the dragged tab cannot leave the header tab bar
      const minDelta = -centers[d.index] + draggedWidth / 2;
      const maxDelta = accum - gap - centers[d.index] - draggedWidth / 2;
      const clampedDelta = Math.max(minDelta, Math.min(maxDelta, deltaX));

      const currentCenter = initialCenter + clampedDelta;

      // Determine target slot across all tabs: user can drag anywhere left or right across any number of tabs
      let targetIndex = d.targetIndex ?? d.index;
      const hysteresis = 12;

      // Expand rightward past as many tabs as the cursor reaches
      while (
        targetIndex < n - 1 &&
        currentCenter >= (centers[targetIndex] + centers[targetIndex + 1]) / 2 + (targetIndex >= d.index ? hysteresis : -hysteresis)
      ) {
        targetIndex++;
      }

      // Expand leftward past as many tabs as the cursor reaches
      while (
        targetIndex > 0 &&
        currentCenter <= (centers[targetIndex - 1] + centers[targetIndex]) / 2 - (targetIndex <= d.index ? hysteresis : -hysteresis)
      ) {
        targetIndex--;
      }

      d.targetIndex = targetIndex;

      // Auto-scroll when near horizontal edges
      const container = scrollContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (e.clientX < rect.left + 50) {
          container.scrollLeft -= 6;
        } else if (e.clientX > rect.right - 50) {
          container.scrollLeft += 6;
        }
      }

      setActiveDrag({
        index: d.index,
        tabId: d.tabId,
        deltaX: clampedDelta,
        targetIndex,
        isDragging: true,
        draggedWidth,
      });
    };

    const handleWindowPointerUp = () => {
      endDrag();
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, [endDrag]);

  const handleTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, index: number, tabId: string) => {
    if (e.button !== 0) return; // Only left-click

    const widths = (workbenchTabs || []).map((_, i) => tabRefs.current[i]?.offsetWidth || 120);
    const draggedWidth = widths[index] || 120;

    dragRef.current = {
      index,
      tabId,
      startX: e.clientX,
      isDragging: false,
      targetIndex: index,
      tabWidths: widths,
      draggedWidth,
    };
  };

  return (
    <header
      style={{ '--tabbar-bg': isLight ? '#ebebef' : '#28272c' } as React.CSSProperties}
      className={`fixed top-0 left-[58px] right-0 h-11 flex items-center justify-between pl-24 sm:pl-28 pr-3 select-none z-40 border-b-0 transition-colors ${
        isLight ? 'bg-[#ebebef] text-[#5c5b66]' : 'bg-[#28272c] text-neutral-400'
      }`}
    >
      {/* Left controls: ← → [|] fixed at top-left across all views */}
      <div className="fixed left-3.5 top-0 h-11 flex items-center gap-5 sm:gap-6 min-w-0 z-50">
        {/* Arrow Left (Back Navigation across all pages & tabs) */}
        <button
          onClick={goBack}
          disabled={!canGoBack}
          aria-label="Back"
          title={canGoBack ? 'Back' : 'Back (Disabled)'}
          className={`p-0.5 rounded shrink-0 transition-colors ${
            !canGoBack
              ? isLight
                ? 'text-[#b8b8c2] cursor-not-allowed opacity-50'
                : 'text-[#52515b] cursor-not-allowed opacity-40'
              : isLight
              ? 'text-[#5c5b66] hover:text-[#09090b] cursor-pointer active:scale-90'
              : 'text-[#8e8d96] hover:text-white cursor-pointer active:scale-90'
          }`}
        >
          <ArrowLeft className="w-[18px] h-[18px] stroke-[1.75]" />
        </button>

        {/* Arrow Right (Forward Navigation across all pages & tabs) */}
        <button
          onClick={goForward}
          disabled={!canGoForward}
          aria-label="Forward"
          title={canGoForward ? 'Forward' : 'Forward (Disabled)'}
          className={`p-0.5 rounded shrink-0 transition-colors ${
            !canGoForward
              ? isLight
                ? 'text-[#b8b8c2] cursor-not-allowed opacity-50'
                : 'text-[#52515b] cursor-not-allowed opacity-40'
              : isLight
              ? 'text-[#5c5b66] hover:text-[#09090b] cursor-pointer active:scale-90'
              : 'text-[#8e8d96] hover:text-white cursor-pointer active:scale-90'
          }`}
        >
          <ArrowRight className="w-[18px] h-[18px] stroke-[1.75]" />
        </button>

        {/* Sidebar panel toggle icon [|] */}
        <button
          onClick={toggleSidebar}
          aria-label={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          title={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className={`p-0.5 rounded transition-all duration-200 active:scale-90 shrink-0 cursor-pointer ${
            isSettingsView || isLibraryView ? 'hidden' : ''
          } ${
            isSidebarOpen
              ? isLight
                ? 'text-[#09090b]'
                : 'text-white'
              : isLight
              ? 'text-[#5c5b66] hover:text-[#09090b]'
              : 'text-[#8e8d96] hover:text-white'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="w-[19px] h-[19px] transition-all duration-200"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3.5" width="18" height="17" rx="4.5" />
            <line x1="8.5" y1="3.5" x2="8.5" y2="20.5" />
          </svg>
        </button>

        {/* Smooth Computer SVG Button: Open Folder from Computer / Finder */}
        <button
          onClick={handleOpenFolderFromComputer}
          aria-label="Open folder from computer"
          title="Open folder from computer / Finder"
          className={`p-0.5 rounded transition-all duration-200 active:scale-90 shrink-0 cursor-pointer -ml-2.5 sm:-ml-3 ${
            isSettingsView || isLibraryView ? 'hidden' : ''
          } ${
            isLight
              ? 'text-[#5c5b66] hover:text-[#09090b]'
              : 'text-[#8e8d96] hover:text-white'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="w-[19px] h-[19px] transition-all duration-200"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2.5" y="3.5" width="19" height="13" rx="3" />
            <line x1="8" y1="20.5" x2="16" y2="20.5" />
            <line x1="12" y1="16.5" x2="12" y2="20.5" />
          </svg>
        </button>
      </div>

      {/* Center: Open Workbench Tabs in Header (hidden when in settings view) */}
      <div className="flex-1 flex items-center min-w-0 h-full relative group/tabbar overflow-hidden">
        {/* Scrollable Tabs Track - Strictly div:nth-of-type(1) */}
        <div
          ref={scrollContainerRef}
          onWheel={handleWheel}
          className="flex-1 flex items-center gap-1.5 overflow-x-auto scrollbar-none h-full py-1.5 px-1 scroll-smooth select-none relative"
        >
          {!isSettingsView &&
            workbenchTabs?.map((tab, index) => {
              const isActive = activeWorkbenchTabId === tab.id;
              const title = tab.kind === 'file' ? tab.name : tab.title;

              let translateX = 0;
              let isBeingDragged = false;
              let zIndex = 1;

              if (activeDrag && activeDrag.isDragging) {
                const { index: dragIdx, targetIndex, deltaX, draggedWidth } = activeDrag;
                const gap = 6;
                const shift = draggedWidth + gap;

                if (index === dragIdx) {
                  isBeingDragged = true;
                  translateX = deltaX;
                  zIndex = 40;
                } else if (dragIdx < targetIndex) {
                  // Dragging right: tabs between dragIdx + 1 and targetIndex slide left
                  if (index > dragIdx && index <= targetIndex) {
                    translateX = -shift;
                  }
                } else if (dragIdx > targetIndex) {
                  // Dragging left: tabs between targetIndex and dragIdx - 1 slide right
                  if (index >= targetIndex && index < dragIdx) {
                    translateX = shift;
                  }
                }
              }

              const transformStyle = translateX !== 0
                ? `translate3d(${translateX}px, 0, 0)`
                : 'translate3d(0, 0, 0)';

              const transitionStyle = isBeingDragged || suppressTransitions
                ? 'none'
                : 'transform 280ms cubic-bezier(0.25, 1, 0.5, 1), background-color 150ms ease, color 150ms ease';

              return (
                <div
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  onPointerDown={(e) => handleTabPointerDown(e, index, tab.id)}
                  onClick={() => {
                    if (!activeDrag || !activeDrag.isDragging) {
                      setActiveWorkbenchTabId(tab.id);
                    }
                  }}
                  style={{
                    transform: transformStyle,
                    transition: transitionStyle,
                    zIndex,
                  }}
                  className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12.5px] font-medium shrink-0 select-none will-change-transform touch-none ${
                    isBeingDragged
                      ? isLight
                        ? 'cursor-grabbing shadow-[0_8px_20px_rgba(0,0,0,0.12)] scale-[1.02] bg-white ring-1 ring-blue-500/30'
                        : 'cursor-grabbing shadow-[0_8px_24px_rgba(0,0,0,0.5)] scale-[1.02] bg-[#1e1d22] ring-1 ring-blue-400/30'
                      : activeDrag
                      ? 'cursor-grab'
                      : 'cursor-grab hover:translate-y-[-0.5px]'
                  } ${
                    isActive
                      ? isLight
                        ? 'bg-[#ffffff] text-[#09090b] shadow-xs font-semibold ring-1 ring-[#000000]/5'
                        : 'bg-[#18181c] text-white shadow-xs font-medium ring-1 ring-[#ffffff]/10'
                      : isLight
                      ? 'text-[#5c5b66] hover:text-[#09090b] hover:bg-[#e4e4ea] bg-transparent'
                      : 'text-neutral-400 hover:text-white hover:bg-[#32313a] bg-transparent'
                  }`}
                >
                  {/* Tab Icon: File or Chat */}
                  <div className="shrink-0 transition-transform duration-200 group-hover:scale-105 pointer-events-none">
                    {tab.kind === 'file' ? (
                      <FileIcon filename={tab.name} className="w-3.5 h-3.5" />
                    ) : (
                      <MessageSquare className={`w-3.5 h-3.5 ${isLight ? 'text-[#6b6a75]' : 'text-[#a5a4af]'}`} />
                    )}
                  </div>

                  <span className="truncate max-w-[140px] tracking-tight pointer-events-none">{title}</span>

                  {/* Close Tab "X" Button */}
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeWorkbenchTab(tab.id);
                    }}
                    title="Close tab"
                    className={`w-4 h-4 flex items-center justify-center rounded transition-all duration-150 ml-0.5 opacity-50 group-hover:opacity-100 hover:scale-110 active:scale-95 cursor-pointer ${
                      isLight
                        ? 'hover:bg-[#d8d8de] text-[#8e8e99] hover:text-[#09090b]'
                        : 'hover:bg-neutral-700/60 text-neutral-400 hover:text-white'
                    }`}
                  >
                    <X className="w-3.5 h-3.5 stroke-[2]" />
                  </button>
                </div>
              );
            })}

          {/* Active Tab Sliding Underline Indicator */}
          {!isSettingsView && indicatorStyle.opacity > 0 && (
            <div
              className={`absolute bottom-[3px] h-[2.5px] rounded-full pointer-events-none z-30 transition-[transform,width,opacity] will-change-transform ${
                activeDrag?.isDragging || suppressTransitions
                  ? 'duration-0'
                  : 'duration-[280ms] ease-[cubic-bezier(0.25,1,0.5,1)]'
              } ${
                isLight
                  ? 'bg-blue-600 shadow-[0_1px_4px_rgba(37,99,235,0.35)]'
                  : 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.55)]'
              }`}
              style={{
                transform: `translate3d(${indicatorStyle.left}px, 0, 0)`,
                width: `${indicatorStyle.width}px`,
                opacity: indicatorStyle.opacity,
              }}
            />
          )}
        </div>

        {/* Left Scroll Button / Gradient Fade */}
        {canScrollLeft && !isSettingsView && (
          <div
            className={`absolute left-0 top-0 bottom-0 z-20 flex items-center pr-3 pointer-events-none ${
              isLight
                ? 'bg-gradient-to-r from-[#ebebef] via-[#ebebef] to-transparent'
                : 'bg-gradient-to-r from-[#28272c] via-[#28272c] to-transparent'
            }`}
          >
            <button
              type="button"
              onClick={scrollLeftBy}
              className={`w-5 h-7 flex items-center justify-center rounded-md pointer-events-auto shadow-xs transition-all duration-200 active:scale-95 ${
                isLight
                  ? 'bg-white/90 text-[#3f3e46] hover:text-[#09090b] hover:bg-white border border-[#dcdce2]'
                  : 'bg-[#202024]/90 text-neutral-300 hover:text-white hover:bg-[#202024] border border-[#34333e]'
              }`}
              title="Scroll tabs left"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Right Scroll Button / Gradient Fade */}
        {canScrollRight && !isSettingsView && (
          <div
            className={`absolute right-0 top-0 bottom-0 z-20 flex items-center pl-3 pointer-events-none ${
              isLight
                ? 'bg-gradient-to-l from-[#ebebef] via-[#ebebef] to-transparent'
                : 'bg-gradient-to-l from-[#28272c] via-[#28272c] to-transparent'
            }`}
          >
            <button
              type="button"
              onClick={scrollRightBy}
              className={`w-5 h-7 flex items-center justify-center rounded-md pointer-events-auto shadow-xs transition-all duration-200 active:scale-95 ${
                isLight
                  ? 'bg-white/90 text-[#3f3e46] hover:text-[#09090b] hover:bg-white border border-[#dcdce2]'
                  : 'bg-[#202024]/90 text-neutral-300 hover:text-white hover:bg-[#202024] border border-[#34333e]'
              }`}
              title="Scroll tabs right"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Right controls: Resource Status indicator & [+] new thread button */}
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        <ResourceStatusIndicator isLight={isLight} />
        <button
          onClick={() => {
            createNewChat();
          }}
          title="New thread (+)"
          aria-label="New thread"
          className={`w-7 h-7 flex items-center justify-center rounded border transition-colors cursor-pointer ${
            isLight
              ? 'border-[#dcdce2] text-[#5c5b66] hover:text-[#09090b] hover:border-[#cbd5e1] hover:bg-[#dedee5]'
              : 'border-[#2b2b30] text-neutral-400 hover:text-white hover:border-[#3f3f46] hover:bg-[#202024]'
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
