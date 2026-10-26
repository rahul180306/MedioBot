import React, { isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Search, SlidersHorizontal } from 'lucide-react';
import {
  ArrowDown01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Attachment01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartLineData01Icon,
  File02Icon,
  Globe02Icon,
  HelpCircleIcon,
  Mail01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import SlingButton from './SlingButton';
import './PromptBar.css';

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT = [0.77, 0, 0.175, 1];
const LINE = 22;
const EDGE = 11;

export interface PromptBarSource {
  key: string;
  name: string;
  description?: string;
  icon?: any;
  attach?: boolean;
}

export interface PromptBarCommand {
  key: string;
  name: string;
  description?: string;
}

export interface PromptBarModel {
  key: string;
  name: string;
  tag?: string;
  badge?: string;
  provider?: string;
  providerId?: string;
  context?: string;
  description?: string;
}

export const DEFAULT_SOURCES: PromptBarSource[] = [
  {
    key: 'files',
    name: 'Photos & files',
    description: 'Upload from this device',
    icon: Attachment01Icon,
    attach: true,
  },
  { key: 'web', name: 'Web search', description: 'Live results', icon: Globe02Icon },
  { key: 'sales', name: 'Sales data', description: 'Revenue and churn', icon: ChartLineData01Icon },
  { key: 'docs', name: 'Documents', description: 'Specs, notes, briefs', icon: File02Icon },
  { key: 'mail', name: 'Mail', description: 'Read and draft mail', icon: Mail01Icon },
  { key: 'calendar', name: 'Calendar', description: 'Events and availability', icon: Calendar03Icon },
];

export const DEFAULT_COMMANDS: PromptBarCommand[] = [
  { key: 'summarize', name: '/summarize', description: 'Digest the thread so far' },
  { key: 'compare', name: '/compare', description: 'Two options side by side' },
  { key: 'draft', name: '/draft', description: 'Write a first version' },
  { key: 'explain', name: '/explain', description: 'A plain-language walkthrough' },
  { key: 'tasks', name: '/tasks', description: 'Turn this into a to-do list' },
];

export const DEFAULT_MODELS: PromptBarModel[] = [
  { key: 'nova-3', name: 'Nova 3', tag: 'Flagship' },
  { key: 'nova-mini', name: 'Nova Mini', tag: 'Fast' },
  { key: 'nova-2', name: 'Nova 2', tag: 'Legacy' },
];

export const DEFAULT_EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max'];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

const parseToken = (draft: string) => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!m) return null;
  return { kind: m[2] === '@' ? 'at' : 'slash', query: m[3].toLowerCase(), start: m.index + m[1].length };
};

const renderIcon = (icon: any, size: number) =>
  isValidElement(icon) ? icon : <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} />;

function SendGlyph({
  busy,
  morphDuration,
  squash,
  tilt,
}: {
  busy: boolean;
  morphDuration: number;
  squash: number;
  tilt: number;
}) {
  const reduce = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const dir = useRef(busy ? 1 : -1);
  const t = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    dir.current = busy ? 1 : -1;
    if (t.get() === target) return undefined;
    const controls = animate(
      t.get(),
      target,
      {
        ...(reduce ? { duration: 0 } : { duration: morphDuration / 1000, ease: EASE_IN_OUT as any }),
        onUpdate: (latest: number) => t.set(latest),
      }
    );
    return () => controls.stop();
  }, [busy, morphDuration, reduce, t]);

  useMotionValueEvent(t, 'change', (v) => {
    pathRef.current?.setAttribute('d', pathAt(ARROW_UP, SQUARE, v));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - squash * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})` : '';
    }
  });

  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, t.get())} />
    </svg>
  );
}

export interface PromptBarProps {
  placeholder?: string;
  sources?: PromptBarSource[];
  commands?: PromptBarCommand[];
  models?: PromptBarModel[];
  providers?: Array<{ id: string; name: string; connected?: boolean; enabled?: boolean; badge?: string }>;
  onManageModels?: () => void;
  defaultModel?: string;
  onModelChange?: (modelKey: string) => void;
  efforts?: string[];
  defaultEffort?: string;
  onEffortChange?: (effort: string) => void;
  busy?: boolean;
  onSend?: (text: string, options: { attachments: string[]; model: PromptBarModel; effort: string }) => void;
  onStop?: () => void;
  onAttach?: () => string | string[] | Promise<string | string[]>;
  onAttachFiles?: (files: File[]) => Promise<string[]> | void;
  onDictate?: () => string | Promise<string>;
  background?: string;
  color?: string;
  menuBackground?: string;
  borderColor?: string;
  sparkColor?: string;
  sparkBoost?: number;
  width?: number | string;
  radius?: number;
  maxRows?: number;
  morphDuration?: number;
  squash?: number;
  tilt?: number;
  pressScale?: number;
  className?: string;
  isLight?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  initialAttachments?: string[];
  richAttachments?: Array<{
    id?: string;
    name: string;
    mimeType?: string;
    size?: number;
    previewUrl?: string;
  }>;
  onAttachmentsChange?: (attachments: string[]) => void;
  onRemoveAttachment?: (index: number) => void;
  hoverColor?: string;
  glowColor?: string;
  mutedColor?: string;
  shadow?: string;
}


export default function PromptBar({
  placeholder = 'Ask anything',
  sources = DEFAULT_SOURCES,
  commands = DEFAULT_COMMANDS,
  models = DEFAULT_MODELS,
  providers = [],
  onManageModels,
  defaultModel = '',
  onModelChange,
  efforts = DEFAULT_EFFORTS,
  defaultEffort = '',
  onEffortChange,
  busy = false,
  onSend,
  onStop,
  onAttach,
  onAttachFiles,
  onDictate,
  background = '#27272a',
  color = '#f5f5f5',
  menuBackground = '#323236',
  borderColor = 'rgba(255, 255, 255, 0.08)',
  sparkColor = '#b39dff',
  sparkBoost = 1,
  width = 400,
  radius = 16,
  maxRows = 5,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = 0.96,
  className = '',
  isLight = false,
  value,
  onChange,
  initialAttachments = [],
  richAttachments = [],
  onAttachmentsChange,
  onRemoveAttachment,
  hoverColor,
  glowColor,
  mutedColor,
  shadow,
}: PromptBarProps) {
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typing = useRef({ energy: 0, strokes: 0 });
  const boost = useRef(sparkBoost);
  boost.current = sparkBoost;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastOpen = useRef<string | null>(null);
  const dictation = useRef(0);
  const latest = useRef<any>({});
  latest.current = { onSend, onStop, onAttach, onAttachFiles, onDictate, onEffortChange, onModelChange, onAttachmentsChange, onManageModels };

  const [internalDraft, setInternalDraft] = useState('');
  const draft = value !== undefined ? value : internalDraft;
  const setDraft = useCallback((next: string | ((prev: string) => string)) => {
    if (typeof next === 'function') {
      const computed = next(draft);
      if (onChange) onChange(computed);
      else setInternalDraft(computed);
    } else {
      if (onChange) onChange(next);
      else setInternalDraft(next);
    }
  }, [draft, onChange]);

  const [attachments, setAttachments] = useState<string[]>(initialAttachments);
  useEffect(() => {
    setAttachments(initialAttachments || []);
  }, [initialAttachments]);

  const updateAttachments = useCallback((updater: (prev: string[]) => string[]) => {
    setAttachments((prev) => {
      const next = updater(prev);
      setTimeout(() => {
        latest.current.onAttachmentsChange?.(next);
      }, 0);
      return next;
    });
  }, []);

  const [modelKey, setModelKey] = useState(defaultModel || '');
  useEffect(() => {
    setModelKey(defaultModel ?? '');
  }, [defaultModel]);

  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [selectedProviderFilter, setSelectedProviderFilter] = useState<string | null>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);
  const modelGlowRef = useRef<HTMLSpanElement>(null);
  const modelRowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [modelActive, setModelActive] = useState<number>(0);
  const lastModelIndex = useRef<number | null>(null);

  const [effortIndex, setEffortIndex] = useState(() => {
    const i = efforts.indexOf(defaultEffort);
    return i >= 0 ? i : Math.max(0, Math.floor((efforts.length - 1) / 2));
  });
  useEffect(() => {
    if (defaultEffort) {
      const i = efforts.indexOf(defaultEffort);
      if (i >= 0) setEffortIndex(i);
    }
  }, [defaultEffort, efforts]);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [listening, setListening] = useState(false);
  const [pressed, setPressed] = useState(false);

  const availableProviderPills = useMemo(() => {
    const list: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();

    models.forEach((m) => {
      if (m.provider) {
        const key = (m.providerId || m.provider).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ id: m.providerId || key, name: m.provider });
        }
      }
    });

    return list;
  }, [models]);

  const filteredModels = useMemo(() => {
    let res = models;
    if (selectedProviderFilter) {
      const pFilter = selectedProviderFilter.toLowerCase();
      res = res.filter(
        (m) =>
          (m.provider && m.provider.toLowerCase() === pFilter) ||
          (m.providerId && m.providerId.toLowerCase() === pFilter)
      );
    }
    if (modelSearchQuery.trim()) {
      const q = modelSearchQuery.trim().toLowerCase();
      res = res.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.tag?.toLowerCase().includes(q) ||
          m.provider?.toLowerCase().includes(q) ||
          m.description?.toLowerCase().includes(q)
      );
    }
    return res;
  }, [models, selectedProviderFilter, modelSearchQuery]);

  const model = useMemo(() => {
    if (!modelKey) return null;
    return models.find((m) => m.key === modelKey) ?? null;
  }, [models, modelKey]);
  const token = dismissed ? null : parseToken(draft);
  const open = plusOpen ? 'at' : (token?.kind ?? (modelOpen ? 'model' : effortOpen ? 'effort' : null));
  const query = plusOpen ? '' : (token?.query ?? '');
  const list = useMemo(() => {
    if (open === 'at') return sources.filter((s) => s.name.toLowerCase().includes(query));
    if (open === 'slash') return commands.filter((c) => c.name.replace(/^\//, '').toLowerCase().startsWith(query));
    if (open === 'model') return filteredModels;
    return [];
  }, [open, query, sources, commands, filteredModels]);
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const armed = busy || canSend;
  const level = efforts[effortIndex] ?? '';
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1;

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const closeMenus = useCallback(() => {
    setPlusOpen(false);
    setModelOpen(false);
    setEffortOpen(false);
  }, []);

  useEffect(() => {
    if (modelOpen) {
      const selectedIdx = filteredModels.findIndex((m) => m.key === (modelKey || defaultModel));
      const initialIdx = selectedIdx >= 0 ? selectedIdx : 0;
      setModelActive(initialIdx);
      lastModelIndex.current = null;
      const timer = setTimeout(() => {
        modelSearchInputRef.current?.focus();
        if (modelRowRefs.current[initialIdx]) {
          modelRowRefs.current[initialIdx]?.scrollIntoView({ block: 'nearest' });
        }
      }, 50);
      return () => clearTimeout(timer);
    } else {
      setModelSearchQuery('');
      setSelectedProviderFilter(null);
      lastModelIndex.current = null;
    }
  }, [modelOpen]);

  useEffect(() => {
    if (open === 'model') {
      const selectedIdx = filteredModels.findIndex((m) => m.key === model?.key);
      if (selectedIdx >= 0) {
        setModelActive(selectedIdx);
      } else if (filteredModels.length > 0) {
        setModelActive(0);
      } else {
        setModelActive(-1);
      }
    } else {
      lastModelIndex.current = null;
    }
  }, [filteredModels, open, model?.key]);

  useLayoutEffect(() => {
    const glow = glowRef.current;
    if (!glow || !open) return;
    const row = rowRefs.current[cursor];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }
    const fresh = lastOpen.current !== open;
    lastOpen.current = open;
    if (fresh) glow.style.transition = 'none';
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';
    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = '';
    }
  }, [open, cursor, list]);

  useLayoutEffect(() => {
    const glow = modelGlowRef.current;
    if (!glow || open !== 'model') return;

    if (modelActive < 0 || modelActive >= filteredModels.length) {
      glow.style.opacity = '0';
      return;
    }

    const row = modelRowRefs.current[modelActive];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }

    const fresh = lastModelIndex.current === null;
    lastModelIndex.current = modelActive;

    if (fresh) glow.style.transition = 'none';
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';

    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = '';
    }
  }, [open, modelActive, filteredModels]);

  useEffect(() => {
    if (!open) lastOpen.current = null;
  }, [open]);

  useEffect(() => {
    if (!plusOpen && !modelOpen && !effortOpen) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenus();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [plusOpen, modelOpen, effortOpen, closeMenus]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const max = LINE * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft, maxRows]);

  useEffect(
    () => () => {
      dictation.current += 1;
    },
    []
  );

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!maxed || reduce || !canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    typing.current.strokes = 0;
    let raf = 0;
    let last = performance.now();
    let w = 0;
    let h = 0;
    let due = 0;
    let speed = 1;
    let pulse = 0;
    const parts: Array<{
      x: number;
      y: number;
      r: number;
      vy: number;
      sway: number;
      phase: number;
      life: number;
      span: number;
    }> = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawn = (burst: boolean) => {
      parts.push({
        x: Math.random() * w,
        y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
        r: 0.9 + Math.random() * 1.1,
        vy: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4,
      });
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const typed = typing.current;
      const gain = boost.current;
      typed.energy *= Math.exp(-dt / 0.8);
      pulse *= Math.exp(-dt / 0.16);
      if (typed.strokes > 0) {
        typed.strokes = 0;
        if (gain > 0) pulse = 1;
      }
      const energy = typed.energy * gain;
      speed += (1 + energy * 6 - speed) * (1 - Math.exp(-dt / 0.15));
      due += dt;
      while (due > 0.14) {
        due -= 0.14;
        if (parts.length < 30) spawn(false);
      }
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = sparkColor;
      ctx.shadowColor = sparkColor;
      ctx.shadowBlur = 6 + energy * 10 + pulse * 6;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        p.life += dt;
        if (p.life > p.span) {
          parts.splice(i, 1);
          continue;
        }
        const k = p.life / p.span;
        const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + p.phase);
        p.y += p.vy * dt * speed;
        if (p.y < -4) {
          p.y = h + 3;
          p.x = Math.random() * w;
        }
        const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14));
        ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge;
        ctx.beginPath();
        ctx.arc(
          p.x + Math.sin((now / 900) * (1 + energy * 0.8) + p.phase) * p.sway,
          p.y,
          p.r * twinkle * (1 + energy * 0.35),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    for (let i = 0; i < 26; i += 1) spawn(true);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctx.clearRect(0, 0, w, h);
    };
  }, [maxed, reduce, sparkColor]);

  const setEffort = (i: number) => {
    const next = Math.max(0, Math.min(efforts.length - 1, i));
    if (next === effortIndex) return;
    setEffortIndex(next);
    latest.current.onEffortChange?.(efforts[next]);
  };

  const effortFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE);
    setEffort(Math.round(k * (efforts.length - 1)));
  };

  const onEffortKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (step) {
      e.preventDefault();
      setEffort(effortIndex + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setEffort(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setEffort(efforts.length - 1);
    } else if (e.key === 'Escape') {
      setEffortOpen(false);
      focusInput();
    }
  };

  const stepAt = (i: number) => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, efforts.length - 1)})`;
  const fillAt = (i: number) => (i === efforts.length - 1 ? '100%' : `calc(${stepAt(i)} + 7px)`);

  const pick = (row: any) => {
    if (open === 'model') {
      setModelKey(row.key);
      latest.current.onModelChange?.(row.key);
      setModelOpen(false);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if (row.attach) {
      setDraft(head);
      Promise.resolve(latest.current.onAttach?.()).then((files: any) => {
        if (!files) return;
        updateAttachments((a) => [...a, ...(Array.isArray(files) ? files : [files])]);
      });
    } else if (open === 'at') {
      setDraft(`${head}@${row.name} `);
    } else {
      setDraft(`${head}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    focusInput();
  };

  const send = () => {
    if (!canSend || busy) return;
    latest.current.onSend?.(draft.trim(), { attachments, model, effort: level });
    setDraft('');
    updateAttachments(() => []);
    setDismissed(false);
    closeMenus();
    focusInput();
  };

  const toggleListen = () => {
    if (listening) {
      dictation.current += 1;
      setListening(false);
      return;
    }
    const seq = ++dictation.current;
    setListening(true);
    Promise.resolve(latest.current.onDictate?.()).then(
      (text: any) => {
        if (seq !== dictation.current) return;
        setListening(false);
        if (text) setDraft((d: string) => (d.trim() ? `${d.trimEnd()} ${text}` : text));
        focusInput();
      },
      () => {
        if (seq === dictation.current) setListening(false);
      }
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((cursor + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(list[cursor]);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setDismissed(true);
        closeMenus();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !armed) return;
    setPressed(true);
  };
  const up = () => setPressed(false);

  return (
    <div
      ref={rootRef}
      className={`prompt-bar${className ? ` ${className}` : ''}`}
      data-busy={busy ? '' : undefined}
      data-max={maxed ? '' : undefined}
      data-light={isLight ? '' : undefined}
      style={{
        '--pb-bg': background,
        '--pb-ink': color,
        '--pb-menu': menuBackground,
        '--pb-border': borderColor,
        '--pb-hover': hoverColor || (isLight ? '#f4f4f7' : '#32313a'),
        '--pb-row-text': isLight ? '#3f3f46' : '#d1d1d8',
        '--pb-row-hover-text': isLight ? '#09090b' : '#ffffff',
        '--pb-glow': glowColor || (isLight ? '#e4e4e7' : '#32313a'),
        '--pb-muted': mutedColor || (isLight ? '#71717a' : 'color-mix(in srgb, var(--pb-ink) 55%, transparent)'),
        '--pb-shadow': shadow || (isLight ? '0 10px 30px -4px rgba(0, 0, 0, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.04)' : '0 12px 36px rgba(0, 0, 0, 0.35)'),
        '--pb-w': typeof width === 'number' ? `${width}px` : width,
        '--pb-radius': `${radius}px`,
        '--pb-spark': sparkColor,
        '--pb-press': pressScale,
      } as React.CSSProperties}
    >
      <div
        className="prompt-bar__field"
        role="presentation"
        data-max={maxed ? '' : undefined}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) focusInput();
        }}
      >
        <canvas ref={sparkRef} className="prompt-bar__sparks" aria-hidden="true" />
        {richAttachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {richAttachments.map((item, i) => {
              const isImage = item.mimeType?.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(item.name) || Boolean(item.previewUrl);
              if (isImage) {
                return (
                  <div
                    key={`${item.name}-${i}`}
                    className={`relative group/chip flex items-center gap-2 rounded-xl border ${
                      isLight ? 'border-black/10 bg-black/5' : 'border-white/10 bg-[#1e1e24]'
                    } pl-1.5 pr-2.5 py-1 shadow-2xs transition-colors`}
                  >
                    <div className="relative h-9 w-9 rounded-lg overflow-hidden bg-black/40 flex items-center justify-center shrink-0 border border-white/10">
                      {item.previewUrl || item.id ? (
                        <img
                          src={item.previewUrl || `/api/attachments/${item.id}`}
                          alt={item.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <HugeiconsIcon icon={File02Icon} size={14} strokeWidth={2} />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 max-w-[120px]">
                      <span className="truncate text-[11px] font-medium leading-tight">{item.name}</span>
                      {item.size ? (
                        <span className="text-[9px] text-neutral-400 leading-tight">
                          {item.size < 1024 * 1024
                            ? `${(item.size / 1024).toFixed(0)} KB`
                            : `${(item.size / (1024 * 1024)).toFixed(1)} MB`}
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="prompt-bar__chip-x ml-0.5"
                      aria-label={`Remove ${item.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onRemoveAttachment) onRemoveAttachment(i);
                        updateAttachments((a) => a.filter((_, j) => j !== i));
                      }}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                    </button>
                  </div>
                );
              }
              return (
                <span
                  key={`${item.name}-${i}`}
                  className={`prompt-bar__chip flex items-center gap-1.5 rounded-lg border ${
                    isLight ? 'border-black/10 bg-black/5' : 'border-white/10 bg-[#1e1e24]'
                  } px-2.5 py-1 text-[11px]`}
                >
                  <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                  <span className="prompt-bar__chip-name truncate max-w-[140px] font-medium">{item.name}</span>
                  {item.size ? (
                    <span className="text-[9px] text-neutral-400">
                      {item.size < 1024 * 1024
                        ? `${(item.size / 1024).toFixed(0)} KB`
                        : `${(item.size / (1024 * 1024)).toFixed(1)} MB`}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="prompt-bar__chip-x"
                    aria-label={`Remove ${item.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onRemoveAttachment) onRemoveAttachment(i);
                      updateAttachments((a) => a.filter((_, j) => j !== i));
                    }}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((file, i) => (
              <span key={`${file}-${i}`} className="prompt-bar__chip">
                <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                <span className="prompt-bar__chip-name">{file}</span>
                <button
                  type="button"
                  className="prompt-bar__chip-x"
                  aria-label={`Remove ${file}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onRemoveAttachment) onRemoveAttachment(i);
                    updateAttachments((a) => a.filter((_, j) => j !== i));
                  }}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="prompt-bar__input"
          rows={1}
          value={draft}
          placeholder={listening ? 'Listening…' : placeholder}
          aria-label="Prompt"
          onChange={(e) => {
            setDraft(e.target.value);
            typing.current.energy = Math.min(1.6, typing.current.energy + 0.22);
            typing.current.strokes = Math.min(4, typing.current.strokes + 1);
            setDismissed(false);
            closeMenus();
            setActive(0);
          }}
          onFocus={closeMenus}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (items && items.length > 0) {
              const fileList: File[] = [];
              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind === 'file') {
                  const file = item.getAsFile();
                  if (file) fileList.push(file);
                }
              }
              if (fileList.length > 0) {
                e.preventDefault();
                if (latest.current.onAttachFiles) {
                  void latest.current.onAttachFiles(fileList);
                }
              }
            }
          }}
        />

        <div className="prompt-bar__bar">
          <button
            type="button"
            className="prompt-bar__tool"
            aria-label="Attach files"
            title="Attach files"
            aria-expanded={plusOpen}
            data-on={plusOpen ? '' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-label="Choose attachments"
            onChange={async (e) => {
              if (e.target.files && e.target.files.length > 0) {
                const files = Array.from(e.target.files);
                if (latest.current.onAttachFiles) {
                  await latest.current.onAttachFiles(files);
                }
                e.target.value = '';
              }
            }}
          />

          {models.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="Select model"
              title="Select model"
              aria-expanded={modelOpen}
              data-on={modelOpen ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                setPlusOpen(false);
                setEffortOpen(false);
                setActive(Math.max(0, model ? models.indexOf(model) : 0));
                setModelOpen((v) => !v);
              }}
            >
              <span>{model?.name ?? 'No configured model'}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2.4} />
            </button>
          ) : null}

          {efforts.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="Choose effort"
              aria-expanded={effortOpen}
              data-on={effortOpen ? '' : undefined}
              data-max={maxed ? '' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                setPlusOpen(false);
                setModelOpen(false);
                setEffortOpen((v) => !v);
              }}
            >
              <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
              <span>{level}</span>
            </button>
          ) : null}

          <span className="prompt-bar__spacer" />

          <SlingButton
            onSend={() => {
              if (busy) latest.current.onStop?.();
              else send();
            }}
            disabled={!armed}
            padColor="#2563eb"
            iconColor="#ffffff"
            accentColor="#60a5fa"
            wellColor={isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.07)'}
            bandColor="#3b82f6"
            size={32}
            strokeWidth={2.2}
            armAt={24}
            maxPull={75}
            launchSpeed={2400}
            recoil={0.2}
            flight={80}
            particles={14}
            spread={60}
            axis="any"
            tapSends
            ariaLabel={busy ? 'Stop' : 'Send'}
          >
            {busy ? (
              <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2.5" />
              </svg>
            ) : draft.trim().length > 0 || attachments.length > 0 ? (
              <HugeiconsIcon icon={ArrowRight02Icon} size={15} strokeWidth={2.5} />
            ) : (
              <span className="prompt-bar__blinking-eyes" aria-hidden="true">
                <span className="prompt-bar__eye" />
                <span className="prompt-bar__eye" />
              </span>
            )}
          </SlingButton>
        </div>
      </div>

      {open ? (
        <div
          className="prompt-bar__menu"
          role={open === 'effort' ? 'dialog' : 'listbox'}
          aria-label={
            open === 'at' ? 'Sources' : open === 'slash' ? 'Commands' : open === 'model' ? 'Models' : 'Effort'
          }
          data-kind={open}
        >
          {open === 'model' ? (
            <div className="prompt-bar__model-menu">
              {/* Search models */}
              <div className="prompt-bar__model-search">
                <Search className="w-4 h-4 text-neutral-400 shrink-0" />
                <input
                  ref={modelSearchInputRef}
                  type="text"
                  value={modelSearchQuery}
                  onChange={(e) => setModelSearchQuery(e.target.value)}
                  placeholder="Search models"
                  className="prompt-bar__model-search-input"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      closeMenus();
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setModelActive((prev) => {
                        if (filteredModels.length === 0) return -1;
                        const next = prev < 0 ? 0 : (prev + 1) % filteredModels.length;
                        modelRowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
                        return next;
                      });
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setModelActive((prev) => {
                        if (filteredModels.length === 0) return -1;
                        const next = prev <= 0 ? filteredModels.length - 1 : prev - 1;
                        modelRowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
                        return next;
                      });
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      if (modelActive >= 0 && modelActive < filteredModels.length) {
                        pick(filteredModels[modelActive]);
                      }
                    }
                  }}
                />
              </div>

              {/* Providers filter pills with status dots */}
              {availableProviderPills.length > 0 && (
                <div className="prompt-bar__model-providers">
                  {availableProviderPills.map((p) => {
                    const isSelected = selectedProviderFilter === p.id || selectedProviderFilter?.toLowerCase() === p.name.toLowerCase();
                    return (
                      <button
                        key={p.id || p.name}
                        type="button"
                        onClick={() => {
                          setSelectedProviderFilter(isSelected ? null : p.id);
                        }}
                        className={`prompt-bar__model-provider-pill ${isSelected ? 'active' : ''}`}
                      >
                        <span className="prompt-bar__model-provider-dot" />
                        <span>{p.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Models List */}
              <div
                className="prompt-bar__model-list"
                onPointerLeave={() => {
                  const selectedIdx = filteredModels.findIndex((m) => m.key === model?.key);
                  if (selectedIdx >= 0) {
                    setModelActive(selectedIdx);
                  } else {
                    setModelActive(-1);
                  }
                }}
              >
                <span ref={modelGlowRef} className="prompt-bar__model-glow" aria-hidden="true" />
                {filteredModels.map((row, i) => {
                  const isSelected = row.key === model?.key || (Boolean(model?.providerId && row.providerId) && row.providerId === model?.providerId && (row as any).id === (model as any)?.id);
                  const isActive = i === modelActive;
                  return (
                    <button
                      key={row.key}
                      ref={(el) => {
                        modelRowRefs.current[i] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-active={isActive ? 'true' : undefined}
                      className={`prompt-bar__model-card ${isSelected ? 'selected bg-[#25242c]' : ''} ${isActive ? 'active' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onPointerEnter={() => setModelActive(i)}
                      onClick={() => pick(row)}
                    >
                      <div className="flex-1 min-w-0 pr-2">
                        <div className="prompt-bar__model-title-wrap">
                          <span className="prompt-bar__model-name truncate">{row.name}</span>
                        </div>
                        {(row.provider || row.context) && (
                          <div className="prompt-bar__model-sub truncate">
                            {row.provider && row.context
                              ? `${row.provider} • ${row.context}`
                              : row.provider || row.context}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <span className="prompt-bar__model-check">
                          <HugeiconsIcon icon={Tick02Icon} size={15} strokeWidth={2.5} />
                        </span>
                      )}
                    </button>
                  );
                })}
                {filteredModels.length === 0 && (
                  <div className="prompt-bar__empty">No models match your search</div>
                )}
              </div>

              {/* Footer: Manage models & Configuration */}
              <div className="prompt-bar__model-footer">
                <button
                  type="button"
                  className="prompt-bar__model-manage-btn"
                  onClick={() => {
                    closeMenus();
                    latest.current.onManageModels?.();
                  }}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Manage models</span>
                </button>

                <button
                  type="button"
                  className="prompt-bar__model-config-link"
                  onClick={() => {
                    closeMenus();
                    latest.current.onManageModels?.();
                  }}
                >
                  <span>Configuration</span>
                  <span>→</span>
                </button>
              </div>
            </div>
          ) : open === 'effort' ? (
            <>
              <div className="prompt-bar__effort-head">
                <span className="prompt-bar__effort-title">Reasoning Effort</span>
                <span className="prompt-bar__effort-level">{level}</span>
                <span className="prompt-bar__effort-help" title="Higher effort allows models to reason deeper before answering">
                  <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                </span>
              </div>
              <div className="prompt-bar__effort-ends">
                <span>Faster</span>
                <span>Smarter</span>
              </div>
              <div
                className="prompt-bar__effort-track"
                role="slider"
                tabIndex={0}
                aria-label="Effort"
                aria-valuemin={0}
                aria-valuemax={efforts.length - 1}
                aria-valuenow={effortIndex}
                aria-valuetext={level}
                style={{
                  '--pb-effort-x': stepAt(effortIndex),
                  '--pb-effort-fill': fillAt(effortIndex),
                } as React.CSSProperties}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  e.currentTarget.focus({ preventScroll: true });
                  effortFromPointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons & 1) effortFromPointer(e);
                }}
                onKeyDown={onEffortKey}
              >
                <span className="prompt-bar__effort-fill" />
                {efforts.map((label, i) => (
                  <i key={label} className="prompt-bar__effort-dot" style={{ left: stepAt(i) }} />
                ))}
                <span className="prompt-bar__effort-thumb" />
              </div>
            </>
          ) : (
            <>
              <span ref={glowRef} className="prompt-bar__glow" aria-hidden="true" />
              {list.map((row: any, i: number) => (
                <button
                  key={row.key}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className="prompt-bar__row"
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(row)}
                >
                  {open === 'at' ? <span className="prompt-bar__row-icon">{renderIcon(row.icon, 15)}</span> : null}
                  <span className="prompt-bar__row-name">{row.name}</span>
                  {row.description ? <span className="prompt-bar__row-desc">{row.description}</span> : null}
                  {open === 'model' ? (
                    <span className="prompt-bar__row-check" data-on={row.key === model?.key ? '' : undefined}>
                      <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                    </span>
                  ) : null}
                </button>
              ))}
              {list.length === 0 ? <div className="prompt-bar__empty">No matches for “{query}”</div> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
