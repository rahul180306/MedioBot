import React, { useState } from 'react';
import { useApp } from '../../state/AppContext';
import {
  Sparkles,
  Search,
  Plus,
  Smile,
  Check,
  Trash2,
  Zap,
  Play,
  RotateCcw,
  Sliders,
  X,
  Bot,
  Activity,
  Heart,
  Eye,
  HelpCircle,
} from 'lucide-react';
import {
  MedioBotExpression,
  ExpressionEyeShape,
  ExpressionAnimation,
  MedioBotAgent,
} from '../../types';
import { MedioBotEyeExpression } from './MedioBotEyeExpression';

interface ExpressionsViewProps {
  onClose?: () => void;
}

const SHAPE_OPTIONS: { id: ExpressionEyeShape; label: string; preview: string }[] = [
  { id: 'bars', label: 'Classic Bars', preview: '||' },
  { id: 'happy', label: 'Joyful Arcs', preview: '^_^' },
  { id: 'focused', label: 'Laser Slits', preview: '==' },
  { id: 'surprise', label: 'Curious OVO', preview: 'O_O' },
  { id: 'wink', label: 'Playful Wink', preview: '^_-' },
  { id: 'sleep', label: 'Sleep Standby', preview: '-_-' },
  { id: 'hearts', label: 'Heart Eyes', preview: '♥_♥' },
  { id: 'stars', label: 'Star Sparkles', preview: '✦_✦' },
  { id: 'shades', label: 'Cool Shades', preview: '[■-■]' },
  { id: 'curious', label: 'Asymmetric', preview: 'o_O' },
  { id: 'glitch', label: 'Cyber Glitch', preview: '|/|' },
];

const ANIMATION_OPTIONS: { id: ExpressionAnimation; label: string; desc: string }[] = [
  { id: 'blink', label: 'Classic Blink', desc: 'Periodic natural blink' },
  { id: 'bounce', label: 'Playful Bounce', desc: 'Vertical upbeat rhythm' },
  { id: 'pulse', label: 'Breathing Pulse', desc: 'Gentle expansion and contraction' },
  { id: 'gaze', label: 'Thinking Gaze', desc: 'Glancing sideways curiously' },
  { id: 'laser-glow', label: 'Laser Glow', desc: 'Pulsing halo radiance' },
  { id: 'rapid-shimmer', label: 'Rapid Shimmer', desc: 'Twinkling excitation' },
  { id: 'sleep-float', label: 'Floating Drift', desc: 'Slow resting hover' },
  { id: 'wink-cycle', label: 'Winking Loop', desc: 'Periodic smart wink' },
];

const COLOR_PRESETS = [
  { label: 'Maestro White', hex: '#f4f4f5' },
  { label: 'Cody Yellow', hex: '#fef08a' },
  { label: 'Vision Sky', hex: '#bae6fd' },
  { label: 'Doc Slate', hex: '#d4d4d8' },
  { label: 'Scraapy Peach', hex: '#fed7aa' },
  { label: 'Sentinel Lilac', hex: '#ddd6fe' },
  { label: 'Deployer Mint', hex: '#a7f3d0' },
  { label: 'Cyber Pink', hex: '#f472b6' },
  { label: 'Ruby Rose', hex: '#fb7185' },
  { label: 'Neon Emerald', hex: '#34d399' },
  { label: 'Electric Blue', hex: '#38bdf8' },
];

const DEFAULT_EXPRESSIONS: MedioBotExpression[] = [
  { id: 'expr-default-blink', name: 'Standard Blink', category: 'focus', eyeShape: 'bars', animation: 'blink', moodColor: '#f4f4f5', description: 'Calm periodic blink cycle' },
  { id: 'expr-joyful-bounce', name: 'Joyful Arc', category: 'mood', eyeShape: 'happy', animation: 'bounce', moodColor: '#fef08a', description: 'Joyful upturned arcs' },
  { id: 'expr-laser-focus', name: 'Laser Slit', category: 'focus', eyeShape: 'focused', animation: 'pulse', moodColor: '#bae6fd', description: 'Sharp horizontal slits' },
  { id: 'expr-surprise-look', name: 'Curious OVO', category: 'reaction', eyeShape: 'surprise', animation: 'gaze', moodColor: '#fed7aa', description: 'Wide open curious circles' },
  { id: 'expr-playful-wink', name: 'Playful Wink', category: 'mood', eyeShape: 'wink', animation: 'wink-cycle', moodColor: '#ddd6fe', description: 'One bar, one joyous arc' },
  { id: 'expr-sleepy-drift', name: 'Sleep Standby', category: 'mood', eyeShape: 'sleep', animation: 'sleep-float', moodColor: '#a7f3d0', description: 'Low flat resting bars' },
  { id: 'expr-heart-radiance', name: 'Heart Eyes', category: 'reaction', eyeShape: 'hearts', animation: 'pulse', moodColor: '#f472b6', description: 'Curved heart shapes' },
];

export const ExpressionsView: React.FC<ExpressionsViewProps> = () => {
  const { agents } = useApp();
  const [expressions, setExpressions] = useState<MedioBotExpression[]>(DEFAULT_EXPRESSIONS);
  const [botExpressions, setBotExpressionsState] = useState<Record<string, string>>({
    maestro: 'expr-default-blink',
    cody: 'expr-joyful-bounce',
    vision: 'expr-laser-focus',
  });
  const addExpression = (expr: MedioBotExpression) => setExpressions((prev) => [expr, ...prev]);
  const deleteExpression = (id: string) => setExpressions((prev) => prev.filter((e) => e.id !== id));
  const setBotExpression = (botId: string, exprId: string) => setBotExpressionsState((prev) => ({ ...prev, [botId]: exprId }));

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedBotId, setSelectedBotId] = useState<string>('maestro');
  const [activePreviewExprId, setActivePreviewExprId] = useState<string>(
    botExpressions['maestro'] || 'expr-default-blink'
  );
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null);

  // Form State for new Expression
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<'mood' | 'focus' | 'reaction' | 'custom'>('custom');
  const [newEyeShape, setNewEyeShape] = useState<ExpressionEyeShape>('happy');
  const [newAnimation, setNewAnimation] = useState<ExpressionAnimation>('bounce');
  const [newMoodColor, setNewMoodColor] = useState('#fef08a');
  const [newDescription, setNewDescription] = useState('');

  // Combined list of bots starting with Maestro
  const allBots: MedioBotAgent[] = [
    {
      id: 'maestro',
      name: 'Maestro',
      role: 'Master Orchestrator',
      status: 'working',
    },
    ...agents.filter((a) => a.id !== 'maestro'),
  ];

  const currentBot = allBots.find((b) => b.id === selectedBotId) || allBots[0];
  const activeExpression =
    expressions.find((e) => e.id === activePreviewExprId) || expressions[0];

  // Filtered expressions list
  const filteredExpressions = expressions.filter((expr) => {
    const matchesSearch =
      expr.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      expr.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      expr.eyeShape.toLowerCase().includes(searchQuery.toLowerCase());
    if (!matchesSearch) return false;
    if (selectedCategory === 'all') return true;
    return expr.category === selectedCategory;
  });

  const handleApplyExpressionToBot = (exprId: string) => {
    setBotExpression(selectedBotId, exprId);
    setActivePreviewExprId(exprId);
    const targetExpr = expressions.find((e) => e.id === exprId);
    setAppliedNotice(
      `Applied "${targetExpr?.name || 'Expression'}" to ${currentBot.name}!`
    );
    setTimeout(() => {
      setAppliedNotice(null);
    }, 2800);
  };

  const handleCreateExpression = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    const newExpr: MedioBotExpression = {
      id: `expr-custom-${Date.now()}`,
      name: newName.trim(),
      category: newCategory,
      eyeShape: newEyeShape,
      animation: newAnimation,
      moodColor: newMoodColor,
      description: newDescription.trim() || 'Custom user-created MedioBot expression',
      isCustom: true,
      createdAt: Date.now(),
    };

    addExpression(newExpr);
    setActivePreviewExprId(newExpr.id);
    setBotExpression(selectedBotId, newExpr.id);

    // Reset and close
    setNewName('');
    setNewDescription('');
    setIsCreateModalOpen(false);
    setAppliedNotice(`Created & applied "${newExpr.name}" to ${currentBot.name}!`);
    setTimeout(() => setAppliedNotice(null), 2800);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#141415] text-[#e4e4e7] overflow-y-auto overflow-x-hidden select-none p-6 sm:p-8 scrollbar-thin animate-in fade-in duration-200">
      {/* 1. Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-[#232328] shrink-0">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#2a2933] flex items-center justify-center text-amber-300 shadow-sm border border-[#3b3a47]">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-white">
                  MedioBot Expressions
                </h1>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[#28272f] text-neutral-300 border border-[#373640]">
                  {expressions.length} Total
                </span>
              </div>
              <p className="text-xs sm:text-sm text-neutral-400 mt-0.5">
                Design, preview, and add dynamic avatar expressions & eye animations for all MedioBots.
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3">
          {/* Search input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter expressions..."
              className="bg-[#1e1e23] border border-[#2e2d36] rounded-xl pl-8 pr-3 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 w-40 sm:w-52"
            />
          </div>

          {/* + Add Expression Button */}
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-white text-black hover:bg-neutral-200 text-xs font-semibold shadow-sm transition-all cursor-pointer active:scale-95"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Add Expression</span>
          </button>
        </div>
      </div>

      {/* Toast Notification */}
      {appliedNotice && (
        <div className="mt-4 px-4 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200 shadow-md">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{appliedNotice}</span>
        </div>
      )}

      {/* 2. Interactive Live Stage / Playground */}
      <div className="mt-6 p-6 rounded-2xl bg-[#1a1920] border border-[#2c2b36] shadow-xl relative overflow-hidden">
        {/* Subtle background ambient light based on current mood color */}
        <div
          className="absolute -right-16 -top-16 w-64 h-64 rounded-full blur-3xl opacity-20 pointer-events-none transition-all duration-700"
          style={{ backgroundColor: activeExpression.moodColor || '#fef08a' }}
        />

        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 relative z-10">
          {/* Left: Bot Selection & Details */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                Live Avatar Preview
              </span>
              <span className="text-xs text-neutral-600">•</span>
              <span className="text-xs text-neutral-400">
                Selected Bot: <strong className="text-white">{currentBot.name}</strong>
              </span>
            </div>

            {/* Bot selector pills */}
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              {allBots.map((bot) => {
                const isSelected = bot.id === selectedBotId;
                const botActiveExprId = botExpressions[bot.id] || 'expr-default-blink';
                const botExpr = expressions.find((e) => e.id === botActiveExprId);

                return (
                  <button
                    key={bot.id}
                    onClick={() => {
                      setSelectedBotId(bot.id);
                      setActivePreviewExprId(botActiveExprId);
                    }}
                    className={`px-2.5 py-1 rounded-xl text-xs font-medium transition-all cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-[#2f2e3a] text-white border border-[#4a4959] shadow-sm'
                        : 'bg-[#151419] text-neutral-400 hover:text-white hover:bg-[#23222a] border border-transparent'
                    }`}
                  >
                    <span>{bot.name}</span>
                    {botExpr && (
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: botExpr.moodColor || '#f4f4f5' }} />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Active Expression Info Card */}
            <div className="p-3.5 rounded-xl bg-[#141318] border border-[#272632] max-w-lg">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">
                    {activeExpression.name}
                  </h3>
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-[#23222a] text-neutral-300">
                    {activeExpression.category}
                  </span>
                </div>

                <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                  <span className="capitalize">{activeExpression.animation}</span>
                </div>
              </div>

              <p className="text-xs text-neutral-400 mt-1.5">
                {activeExpression.description}
              </p>

              <div className="mt-3 flex items-center gap-2 pt-2 border-t border-[#23222b]">
                <button
                  onClick={() => handleApplyExpressionToBot(activeExpression.id)}
                  className="px-3 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-black text-xs font-semibold transition-all cursor-pointer shadow-xs active:scale-95 flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Set as Default for {currentBot.name}</span>
                </button>

                <span className="text-[11px] text-neutral-500">
                  Shape: <strong className="text-neutral-300 capitalize">{activeExpression.eyeShape}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Right: Big Live Expressive Avatar */}
          <div className="flex flex-col items-center justify-center p-6 rounded-2xl bg-[#141418] border border-[#292834] shadow-inner shrink-0 min-w-[200px]">
            {/* The circular MedioBot Avatar exhibiting the expression */}
            <div
              className="w-24 h-24 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 group hover:scale-105"
              style={{
                backgroundColor: activeExpression.moodColor || '#f4f4f5',
                boxShadow: `0 0 35px ${activeExpression.moodColor || '#ffffff'}33`,
              }}
            >
              <MedioBotEyeExpression
                eyeShape={activeExpression.eyeShape}
                animation={activeExpression.animation}
                size="xl"
                eyeColor="#000000"
              />
            </div>

            <div className="mt-3 text-center">
              <span className="text-xs font-semibold text-white block">
                {currentBot.name}
              </span>
              <span className="text-[11px] text-neutral-400">
                Expression: {activeExpression.name}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Category Filter Tabs */}
      <div className="mt-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 bg-[#1b1a20] p-1 rounded-xl border border-[#2b2a33] text-xs">
          {['all', 'mood', 'focus', 'reaction', 'custom'].map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1 rounded-lg transition-colors cursor-pointer capitalize ${
                selectedCategory === cat
                  ? 'bg-[#2f2e38] text-white font-medium shadow-xs'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              {cat === 'all' ? 'All Expressions' : cat}
            </button>
          ))}
        </div>

        <span className="text-xs text-neutral-500">
          Showing {filteredExpressions.length} expressions
        </span>
      </div>

      {/* 4. Expression Cards Grid */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
        {filteredExpressions.map((expr) => {
          const isCurrentActive = expr.id === activePreviewExprId;
          const isBotDefault = botExpressions[selectedBotId] === expr.id;

          return (
            <div
              key={expr.id}
              onClick={() => setActivePreviewExprId(expr.id)}
              className={`p-4 rounded-2xl bg-[#1b1a21] border transition-all duration-200 cursor-pointer flex flex-col justify-between group hover:-translate-y-0.5 hover:shadow-xl ${
                isCurrentActive
                  ? 'border-neutral-300 ring-1 ring-neutral-300 shadow-md'
                  : 'border-[#292832] hover:border-[#403f4f]'
              }`}
            >
              <div>
                {/* Top: Avatar Miniature + Action Icons */}
                <div className="flex items-start justify-between mb-3">
                  {/* Miniature animated Avatar */}
                  <div
                    className="w-11 h-11 rounded-full flex items-center justify-center shadow-md shrink-0 transition-transform group-hover:scale-105"
                    style={{
                      backgroundColor: expr.moodColor || '#f4f4f5',
                    }}
                  >
                    <MedioBotEyeExpression
                      eyeShape={expr.eyeShape}
                      animation={expr.animation}
                      size="md"
                      eyeColor="#000000"
                    />
                  </div>

                  {/* Badges / Delete for custom */}
                  <div className="flex items-center gap-1.5">
                    {isBotDefault && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                        Default
                      </span>
                    )}

                    {expr.isCustom && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteExpression(expr.id);
                        }}
                        title="Delete custom expression"
                        className="p-1 rounded-lg text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Name & Category */}
                <h4 className="text-sm font-semibold text-white tracking-tight">
                  {expr.name}
                </h4>
                <p className="text-[11.5px] text-neutral-400 mt-1 line-clamp-2">
                  {expr.description}
                </p>

                {/* Tags */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#141318] text-neutral-300 border border-[#272632] capitalize">
                    {expr.eyeShape}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#141318] text-neutral-400 border border-[#272632] capitalize">
                    {expr.animation}
                  </span>
                </div>
              </div>

              {/* Bottom: Quick Apply Button */}
              <div className="mt-4 pt-3 border-t border-[#26252f] flex items-center justify-between">
                <span className="text-[11px] text-neutral-500 capitalize">
                  {expr.category}
                </span>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApplyExpressionToBot(expr.id);
                  }}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    isBotDefault
                      ? 'bg-emerald-500/15 text-emerald-300 cursor-default'
                      : 'bg-[#292832] hover:bg-white hover:text-black text-neutral-200'
                  }`}
                >
                  {isBotDefault ? 'Active' : 'Apply'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 5. Add / Create Expression Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="w-full max-w-lg bg-[#18171e] border border-[#2f2e3b] rounded-2xl shadow-2xl p-6 relative overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-[#292834]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-amber-400/10 border border-amber-400/30 text-amber-300 flex items-center justify-center">
                  <Smile className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-white">
                    Create MedioBot Expression
                  </h3>
                  <p className="text-xs text-neutral-400">
                    Define eye geometry, animation cadence, and mood color.
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-[#282732] transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Live Interactive Preview Box inside Modal */}
            <div className="mt-4 p-4 rounded-xl bg-[#121116] border border-[#262530] flex items-center justify-center gap-5">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-all duration-200"
                style={{
                  backgroundColor: newMoodColor,
                  boxShadow: `0 0 20px ${newMoodColor}40`,
                }}
              >
                <MedioBotEyeExpression
                  eyeShape={newEyeShape}
                  animation={newAnimation}
                  size="lg"
                  eyeColor="#000000"
                />
              </div>

              <div className="min-w-0">
                <span className="text-xs font-semibold text-white block">
                  {newName || 'Untitled Expression'}
                </span>
                <span className="text-[11px] text-neutral-400 block mt-0.5">
                  Shape: <strong className="capitalize text-neutral-300">{newEyeShape}</strong> • Animation: <strong className="capitalize text-neutral-300">{newAnimation}</strong>
                </span>
              </div>
            </div>

            {/* Form */}
            <form onSubmit={handleCreateExpression} className="mt-4 space-y-4">
              {/* Name input */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Expression Name
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Laser Synthesis, Victory Dance, Deep Sleep"
                  className="w-full px-3 py-2 rounded-xl bg-[#1e1d25] border border-[#2e2d3a] text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* Eye Shape Select Grid */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Eye Shape & Style
                </label>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-32 overflow-y-auto scrollbar-thin p-1 bg-[#141318] rounded-xl border border-[#272633]">
                  {SHAPE_OPTIONS.map((shape) => (
                    <button
                      key={shape.id}
                      type="button"
                      onClick={() => setNewEyeShape(shape.id)}
                      className={`px-2 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                        newEyeShape === shape.id
                          ? 'bg-amber-400 text-black font-semibold shadow-xs'
                          : 'bg-[#1b1a21] text-neutral-300 hover:text-white hover:bg-[#25242f]'
                      }`}
                    >
                      <span className="block text-[11px]">{shape.label}</span>
                      <span className="text-[9px] opacity-75">{shape.preview}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Animation Select Grid */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Animation Type
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {ANIMATION_OPTIONS.map((anim) => (
                    <button
                      key={anim.id}
                      type="button"
                      onClick={() => setNewAnimation(anim.id)}
                      className={`px-2 py-1.5 rounded-lg text-xs text-center transition-all cursor-pointer ${
                        newAnimation === anim.id
                          ? 'bg-amber-400 text-black font-semibold shadow-xs'
                          : 'bg-[#1e1d25] text-neutral-300 hover:text-white hover:bg-[#282732]'
                      }`}
                    >
                      <span className="block text-[11px] truncate">{anim.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Mood Color Presets */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Mood & Avatar Glow Color
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {COLOR_PRESETS.map((color) => (
                    <button
                      key={color.hex}
                      type="button"
                      title={color.label}
                      onClick={() => setNewMoodColor(color.hex)}
                      className={`w-6 h-6 rounded-full transition-transform cursor-pointer flex items-center justify-center ${
                        newMoodColor === color.hex ? 'scale-125 ring-2 ring-white ring-offset-2 ring-offset-[#18171e]' : 'hover:scale-110'
                      }`}
                      style={{ backgroundColor: color.hex }}
                    >
                      {newMoodColor === color.hex && (
                        <Check className="w-3 h-3 text-black stroke-[3]" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">
                  Description / Trigger Note
                </label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="When this expression triggers or what mood it conveys..."
                  className="w-full px-3 py-1.5 rounded-xl bg-[#1e1d25] border border-[#2e2d3a] text-xs text-white placeholder:text-neutral-500 focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* Action Buttons */}
              <div className="pt-2 flex items-center justify-end gap-2 border-t border-[#292834]">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-xl bg-[#25242f] hover:bg-[#302f3c] text-neutral-300 text-xs font-medium transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold shadow-md transition-all cursor-pointer active:scale-95 flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Register Expression</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
