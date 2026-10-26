import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type TimelineNavigatorAnchor } from './timeline';
import { useApp } from '../../state/AppContext';

export const TimelineNavigator: React.FC<{
  anchors: ReadonlyArray<TimelineNavigatorAnchor>;
  scrollRoot: HTMLElement | null;
  targets: React.MutableRefObject<Map<string, HTMLElement>>;
}> = ({ anchors, scrollRoot, targets }) => {
  const { theme } = useApp();
  const isLight = theme === 'light';

  // Filter ONLY user inputs
  const userAnchors = useMemo(() => {
    return anchors.filter((anchor) => anchor.kind === 'user');
  }, [anchors]);

  const [activeTarget, setActiveTarget] = useState<string | undefined>(userAnchors[0]?.targetId);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const observerRef = useRef<IntersectionObserver | null>(null);

  // IntersectionObserver for tracking which user input is in view
  useEffect(() => {
    if (!userAnchors.length) return;
    setActiveTarget((prev) => prev ?? userAnchors[0]?.targetId);

    if (!scrollRoot || typeof IntersectionObserver === 'undefined') return;

    const visible = new Map<string, HTMLElement>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          if (entry.isIntersecting) visible.set(target.id, target);
          else visible.delete(target.id);
        }
        const rootTop = scrollRoot.getBoundingClientRect().top + 40;
        const sorted = [...visible.entries()].sort((a, b) => {
          const aTop = a[1].getBoundingClientRect().top;
          const bTop = b[1].getBoundingClientRect().top;
          return Math.abs(aTop - rootTop) - Math.abs(bTop - rootTop);
        });
        if (sorted[0]) {
          setActiveTarget(sorted[0][0]);
        }
      },
      { root: scrollRoot, threshold: [0, 0.1, 0.5, 1] }
    );

    observerRef.current = observer;
    for (const anchor of userAnchors) {
      const target = targets.current.get(anchor.targetId);
      if (target) observer.observe(target);
    }

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [userAnchors, scrollRoot, targets]);

  if (userAnchors.length === 0) return null;

  const hoverAnchor = hoverIndex !== null ? userAnchors[hoverIndex] : null;

  return (
    <nav
      aria-label="User input timeline navigator"
      data-testid="timeline-navigator"
      onMouseLeave={() => setHoverIndex(null)}
      className="absolute left-2.5 md:left-4 top-1/2 z-30 -translate-y-1/2 flex flex-col items-start select-none group"
    >
      <div className="flex max-h-[min(75vh,620px)] flex-col items-start gap-1 overflow-y-auto pr-3 py-1 no-scrollbar">
        {userAnchors.map((anchor, index) => {
          const isActive = activeTarget === anchor.targetId;
          const distance = hoverIndex !== null ? Math.abs(index - hoverIndex) : null;

          let widthClass = 'w-2 h-[2px]';
          if (distance !== null) {
            if (distance === 0) widthClass = 'w-6.5 h-[2.5px]';
            else if (distance === 1) widthClass = 'w-4.5 h-[2px]';
            else if (distance === 2) widthClass = 'w-3 h-[2px]';
            else widthClass = 'w-2 h-[2px]';
          } else if (isActive) {
            widthClass = 'w-4.5 h-[2.5px]';
          }

          let bgClass = '';
          if (hoverIndex !== null) {
            if (distance === 0) {
              bgClass = isLight
                ? 'bg-neutral-900 shadow-sm'
                : 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]';
            } else if (distance === 1) {
              bgClass = isLight ? 'bg-neutral-700' : 'bg-neutral-300';
            } else if (distance === 2) {
              bgClass = isLight ? 'bg-neutral-500' : 'bg-neutral-400/80';
            } else {
              bgClass = isLight ? 'bg-neutral-400/70' : 'bg-neutral-600/70';
            }
          } else {
            if (isActive) {
              bgClass = isLight
                ? 'bg-neutral-950 shadow-xs'
                : 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]';
            } else {
              bgClass = isLight
                ? 'bg-neutral-400/80 hover:bg-neutral-800'
                : 'bg-neutral-600/80 hover:bg-neutral-200';
            }
          }

          return (
            <button
              key={anchor.id}
              type="button"
              data-testid="timeline-anchor"
              data-target-id={anchor.targetId}
              aria-label={`User Input ${index + 1}: ${anchor.preview}`}
              aria-current={isActive ? 'location' : undefined}
              onMouseEnter={() => setHoverIndex(index)}
              onFocus={() => setHoverIndex(index)}
              onClick={() => {
                const target = targets.current.get(anchor.targetId);
                if (!target) return;
                const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
              }}
              className="py-1 px-0.5 cursor-pointer focus-visible:outline-none flex items-center transition-all duration-150"
            >
              <span
                className={`block rounded-full transition-all duration-150 ease-out ${widthClass} ${bgClass}`}
              />
            </button>
          );
        })}
      </div>

      {/* Floating preview tooltip next to hovered hyphen */}
      {hoverAnchor && hoverIndex !== null && (
        <div
          role="tooltip"
          data-testid="timeline-preview"
          className={`pointer-events-none absolute left-10 md:left-12 top-1/2 -translate-y-1/2 w-80 max-w-xs rounded-2xl p-3.5 shadow-2xl transition-all duration-150 z-40 ${
            isLight
              ? 'bg-white/95 border border-[#e2e4e8] text-[#09090b] backdrop-blur-xl'
              : 'bg-[#1c1c1e]/95 border border-white/10 text-neutral-100 backdrop-blur-xl'
          }`}
        >
          <div className={`text-xs font-medium leading-relaxed line-clamp-3 ${isLight ? 'text-neutral-800' : 'text-neutral-200'}`}>
            <span className="font-semibold text-sky-400 mr-1.5">{hoverIndex + 1}.</span>
            {hoverAnchor.preview || 'User prompt input'}
          </div>
        </div>
      )}
    </nav>
  );
};
