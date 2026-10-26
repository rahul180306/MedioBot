import React, { useState, useMemo } from 'react';
import { useApp } from '../../state/AppContext';
import {
  Sparkles,
  Search,
  ArrowRight,
  ArrowLeft,
  Bot,
  Zap,
  Wrench,
  Settings,
  Send,
  Check,
  Play,
  Cpu,
  ShieldCheck,
  Code2,
  Terminal,
  Globe,
  FileText,
} from 'lucide-react';
import { MedioBotAgent } from '../../types';
import { getMediobotPresentation } from '../mediobots/presentation';
import SquishSwitch from '../../components/SquishSwitch';

const CircleBlinkingEyeSvg: React.FC<{ className?: string }> = ({ className = 'w-5 h-5' }) => (
  <svg
    viewBox="0 0 24 24"
    className={`${className} shrink-0`}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    data-testid="mediobot-circle-blinking-eye-svg"
  >
    <circle cx="12" cy="12" r="9" />
    <line
      x1="9.25"
      y1="8.5"
      x2="9.25"
      y2="15.5"
      strokeWidth="2.2"
      className="animate-eye-blink block"
      style={{ transformOrigin: '9.25px 12px' }}
    />
    <line
      x1="14.75"
      y1="8.5"
      x2="14.75"
      y2="15.5"
      strokeWidth="2.2"
      className="animate-eye-blink block"
      style={{ transformOrigin: '14.75px 12px' }}
    />
  </svg>
);

const VerifiedBlueTick: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg
    viewBox="0 0 24 24"
    className={`${className} shrink-0 drop-shadow-xs`}
    fill="none"
  >
    <path
      d="M22.5 12.5c0-1.58-.8-2.95-2-3.77.35-1.48.02-3.05-1.02-4.09s-2.61-1.37-4.09-1.02C14.57 2.42 13.2 1.62 11.62 1.62s-2.95.8-3.77 2c-1.48-.35-3.05-.02-4.09 1.02S2.39 7.25 2.74 8.73c-1.2.82-2 2.19-2 3.77s.8 2.95 2 3.77c-.35 1.48-.02 3.05 1.02 4.09s2.61 1.37 4.09 1.02c.82 1.2 2.19 2 3.77 2s2.95-.8 3.77-2c1.48.35 3.05.02 4.09-1.02s1.37-2.61 1.02-4.09c1.2-.82 2-2.19 2-3.77z"
      fill="#2f8af5"
    />
    <path
      d="M7.75 12.5l3.25 3.25 6-6"
      stroke="#ffffff"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface MediobotDetailProps {
  bot: MedioBotAgent;
  onBack: () => void;
  isLight: boolean;
  isActive: boolean;
  onToggleActive: (active: boolean) => void;
  onLaunchInMaestro: () => void;
}

const MedioBotDetailPage: React.FC<MediobotDetailProps> = ({
  bot,
  onBack,
  isLight,
  isActive,
  onToggleActive,
  onLaunchInMaestro,
}) => {
  const visuals = getMediobotPresentation(bot.id, bot.name, bot.role);
  const [activeTab, setActiveTab] = useState<'playground' | 'capabilities' | 'config'>('playground');
  const [promptInput, setPromptInput] = useState('');
  const [messages, setMessages] = useState<Array<{ sender: 'user' | 'bot'; text: string; time: string }>>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  const getQuickPrompts = (id: string) => {
    const safeId = id.toLowerCase();
    switch (safeId) {
      case 'cody':
        return [
          'Analyze component structure and optimize render loops',
          'Search for unhandled error cases in state handlers',
          'Generate TypeScript types and schemas for current models',
        ];
      case 'vision':
        return [
          'Inspect layout alignment and element hierarchy',
          'Audit color contrast ratio across light and dark modes',
          'Check responsiveness and mobile viewport constraints',
        ];
      case 'maestro':
        return [
          'Orchestrate task breakdown across specialist bots',
          'Coordinate multi-step file refactoring pipeline',
          'Summarize execution progress and active tasks',
        ];
      case 'doc':
        return [
          'Generate API reference documentation for endpoints',
          'Update architecture guidelines and code comments',
          'Extract technical summary from workspace files',
        ];
      case 'research':
        return [
          'Search latest library specifications and best practices',
          'Compare performance benchmarks for state management',
          'Look up documentation for external web APIs',
        ];
      case 'tester':
        return [
          'Generate unit test coverage plan for core hooks',
          'Verify edge cases and boundary inputs',
          'Validate API response schema contracts',
        ];
      case 'deployer':
        return [
          'Inspect build configuration and bundle sizes',
          'Verify environment variable constraints',
          'Check deployment pipeline readiness',
        ];
      default:
        return [
          'Inspect system requirements and active state',
          'Run preliminary checks and report diagnostic findings',
          'Provide specialized recommendations for this project',
        ];
    }
  };

  const quickPrompts = getQuickPrompts(bot.id);

  const handleSendPrompt = (textToSend?: string) => {
    const query = (textToSend || promptInput).trim();
    if (!query || isProcessing) return;

    const userMsg = {
      sender: 'user' as const,
      text: query,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setPromptInput('');
    setIsProcessing(true);

    setTimeout(() => {
      const botResponse = {
        sender: 'bot' as const,
        text: `[${bot.name} Sandbox Response]: Analyzed request "${query}". Ready to execute specialized task as ${bot.role || 'Specialist'}.`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, botResponse]);
      setIsProcessing(false);
    }, 1200);
  };

  return (
    <div className={`flex-1 flex flex-col h-full overflow-y-auto select-none p-6 sm:p-8 scrollbar-thin animate-in fade-in duration-200 ${
      isLight ? 'bg-white text-[#111827]' : 'bg-[#141415] text-[#e4e4e7]'
    }`}>
      {/* Navigation Header */}
      <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b shrink-0 ${
        isLight ? 'border-[#e2e4e8]' : 'border-[#232328]'
      }`}>
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className={`p-2 rounded-xl transition-all cursor-pointer shadow-xs active:scale-95 flex items-center justify-center gap-2 text-xs font-semibold ${
              isLight
                ? 'bg-[#f1f2f5] hover:bg-[#e4e5e9] text-[#374151] hover:text-[#111827]'
                : 'bg-[#1e1e23] hover:bg-[#2c2b34] text-neutral-300 hover:text-white'
            }`}
            title="Back to MedioBots Library"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Library</span>
          </button>

          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span>Library</span>
            <span>/</span>
            <span>Agents</span>
            <span>/</span>
            <span className={`font-medium ${isLight ? 'text-[#111827]' : 'text-white'}`}>{bot.name}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`text-xs ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
              {isActive ? 'Active' : 'Disabled'}
            </span>
            <SquishSwitch
              checked={isActive}
              onChange={onToggleActive}
              ariaLabel={`Toggle ${bot.name}`}
              trackColor={isLight ? '#dcdce2' : '#2a2933'}
              trackOnColor="#ea580c"
              thumbColor="#ffffff"
              thumbOnColor="#ffffff"
              width={44}
              height={24}
              radius={12}
              speed={55}
              stretch={32}
            />
          </div>

          <button
            onClick={onLaunchInMaestro}
            className="px-3.5 py-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-medium transition-colors shadow-sm flex items-center gap-1.5 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Launch in Maestro</span>
          </button>
        </div>
      </div>

      {/* Hero Identity Banner */}
      <div className={`my-6 p-6 sm:p-8 rounded-2xl border transition-all ${
        isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#1a191f] border-[#2a2933]'
      }`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start sm:items-center gap-5">
            {/* Avatar */}
            <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full ${visuals.avatar} flex items-center justify-center gap-2 shrink-0 shadow-lg relative group`}>
              <span className={`w-[7px] h-[20px] rounded-full ${visuals.eye} animate-eye-blink block`} />
              <span className={`w-[7px] h-[20px] rounded-full ${visuals.eye} animate-eye-blink block`} />
            </div>

            <div>
              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                <h1 className={`text-2xl sm:text-3xl font-bold tracking-tight ${isLight ? visuals.lightText : visuals.darkText}`}>
                  {bot.name}
                </h1>
                <div className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs shadow-xs ${
                  isLight ? 'bg-white border-[#e2e4e8]' : 'bg-[#22212a] border-[#343340]'
                }`}>
                  <VerifiedBlueTick className="w-3.5 h-3.5" />
                  <span className={`font-semibold ${isLight ? 'text-[#1f2937]' : 'text-neutral-200'}`}>Mediobot</span>
                </div>
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium ${isLight ? visuals.lightBadge : visuals.darkBadge}`}>
                  {bot.group === 'orchestrator' ? 'Orchestrator' : 'Specialist'}
                </span>
              </div>

              <p className={`text-sm ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                {bot.role || 'Specialist Mediobot registered in local runtime.'}
              </p>

              <div className="flex items-center gap-3 mt-3 text-xs">
                <div className="flex items-center gap-1.5 text-emerald-500 font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span>Operational & Ready</span>
                </div>
                <span className={isLight ? 'text-[#d1d5db]' : 'text-neutral-600'}>•</span>
                <span className={isLight ? 'text-[#6b7280]' : 'text-neutral-400'}>ID: {bot.id}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Workspace Tabs */}
      <div className={`flex items-center border-b shrink-0 gap-6 mb-6 ${
        isLight ? 'border-[#e2e4e8]' : 'border-[#26252e]'
      }`}>
        <button
          onClick={() => setActiveTab('playground')}
          className={`pb-3 text-xs sm:text-sm font-semibold transition-all relative cursor-pointer flex items-center gap-2 ${
            activeTab === 'playground'
              ? isLight
                ? 'text-[#111827] border-b-2 border-[#111827]'
                : 'text-white border-b-2 border-orange-500'
              : isLight
              ? 'text-[#6b7280] hover:text-[#111827]'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          <Bot className="w-4 h-4" />
          <span>Interactive Sandbox</span>
        </button>

        <button
          onClick={() => setActiveTab('capabilities')}
          className={`pb-3 text-xs sm:text-sm font-semibold transition-all relative cursor-pointer flex items-center gap-2 ${
            activeTab === 'capabilities'
              ? isLight
                ? 'text-[#111827] border-b-2 border-[#111827]'
                : 'text-white border-b-2 border-orange-500'
              : isLight
              ? 'text-[#6b7280] hover:text-[#111827]'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          <Wrench className="w-4 h-4" />
          <span>Capabilities & Tools</span>
        </button>

        <button
          onClick={() => setActiveTab('config')}
          className={`pb-3 text-xs sm:text-sm font-semibold transition-all relative cursor-pointer flex items-center gap-2 ${
            activeTab === 'config'
              ? isLight
                ? 'text-[#111827] border-b-2 border-[#111827]'
                : 'text-white border-b-2 border-orange-500'
              : isLight
              ? 'text-[#6b7280] hover:text-[#111827]'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>System Specification</span>
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'playground' && (
        <div className="flex-1 flex flex-col justify-between space-y-6">
          {/* Quick Prompts / Starter Chips */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              <h3 className={`text-xs font-semibold uppercase tracking-wider ${isLight ? 'text-[#374151]' : 'text-neutral-300'}`}>
                Quick Starter Queries for {bot.name}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {quickPrompts.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendPrompt(prompt)}
                  className={`text-xs px-3 py-2 rounded-xl border text-left transition-all duration-200 active:scale-98 cursor-pointer ${
                    isLight
                      ? 'bg-[#f8f9fa] hover:bg-[#edf0f5] border-[#e2e4e8] text-[#111827]'
                      : 'bg-[#1c1c22] hover:bg-[#25252e] border-[#2d2c37] text-neutral-200'
                  }`}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>

          {/* Sandbox Messages Area */}
          <div className={`flex-1 min-h-[220px] p-5 rounded-2xl border overflow-y-auto space-y-4 ${
            isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#18181d] border-[#25242e]'
          }`}>
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-400 space-y-3">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                  isLight ? 'bg-[#e5e7eb] text-[#374151]' : 'bg-[#25242e] text-neutral-300'
                }`}>
                  <Bot className="w-6 h-6" />
                </div>
                <div>
                  <h4 className={`text-sm font-semibold ${isLight ? 'text-[#111827]' : 'text-white'}`}>
                    {bot.name} Dedicated Sandbox
                  </h4>
                  <p className="text-xs text-neutral-400 mt-1 max-w-sm">
                    This is an isolated testing page for {bot.name}. Send a prompt above or type a message below.
                  </p>
                </div>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                    msg.sender === 'user'
                      ? isLight
                        ? 'bg-[#111827] text-white rounded-tr-xs'
                        : 'bg-orange-600 text-white rounded-tr-xs'
                      : isLight
                      ? 'bg-white border border-[#e2e4e8] text-[#111827] shadow-xs rounded-tl-xs'
                      : 'bg-[#222129] border border-[#2e2d38] text-neutral-200 rounded-tl-xs'
                  }`}>
                    {msg.text}
                  </div>
                  <span className="text-[10px] text-neutral-500 mt-1 px-1">{msg.time}</span>
                </div>
              ))
            )}

            {isProcessing && (
              <div className="flex items-center gap-2 text-xs text-neutral-400 py-2">
                <span className="w-2 h-2 rounded-full bg-orange-500 animate-ping" />
                <span>{bot.name} is processing response...</span>
              </div>
            )}
          </div>

          {/* Interactive Chat Bar */}
          <div className="relative">
            <input
              type="text"
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendPrompt();
                }
              }}
              placeholder={`Send a prompt directly to ${bot.name}...`}
              className={`w-full rounded-2xl pl-4 pr-12 py-3 text-xs sm:text-sm focus:outline-none transition-colors border ${
                isLight
                  ? 'bg-white border-[#dcdce2] text-[#111827] placeholder:text-[#9ca3af] focus:border-[#111827]'
                  : 'bg-[#1c1c22] border-[#2e2d38] text-white placeholder:text-neutral-500 focus:border-orange-500'
              }`}
            />
            <button
              onClick={() => handleSendPrompt()}
              disabled={!promptInput.trim() || isProcessing}
              className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all ${
                promptInput.trim() && !isProcessing
                  ? 'bg-orange-600 hover:bg-orange-500 text-white shadow-xs cursor-pointer'
                  : isLight
                  ? 'bg-[#e5e7eb] text-[#9ca3af] cursor-not-allowed'
                  : 'bg-[#282733] text-neutral-600 cursor-not-allowed'
              }`}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {activeTab === 'capabilities' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className={`p-6 rounded-2xl border ${
            isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#18181d] border-[#25242e]'
          }`}>
            <div className="flex items-center gap-2 mb-4">
              <Wrench className="w-4 h-4 text-orange-500" />
              <h3 className={`text-sm font-semibold ${isLight ? 'text-[#111827]' : 'text-white'}`}>
                Assigned Execution Tools
              </h3>
            </div>

            <div className="space-y-3">
              {[
                { name: 'filesystem.read', desc: 'Read workspace files and parse project AST' },
                { name: 'filesystem.write', desc: 'Safely apply code edits and file updates' },
                { name: 'terminal.execute', desc: 'Run build, test, and shell commands' },
                { name: 'vision.perceive', desc: 'Inspect screen layout and visual element bounds' },
              ].map((tool, i) => (
                <div key={i} className={`p-3 rounded-xl border flex items-center justify-between ${
                  isLight ? 'bg-white border-[#e2e4e8]' : 'bg-[#201f27] border-[#2c2b37]'
                }`}>
                  <div>
                    <span className="text-xs font-mono font-semibold text-orange-500">{tool.name}</span>
                    <p className={`text-[11px] mt-0.5 ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>{tool.desc}</p>
                  </div>
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                </div>
              ))}
            </div>
          </div>

          <div className={`p-6 rounded-2xl border ${
            isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#18181d] border-[#25242e]'
          }`}>
            <div className="flex items-center gap-2 mb-4">
              <Cpu className="w-4 h-4 text-orange-500" />
              <h3 className={`text-sm font-semibold ${isLight ? 'text-[#111827]' : 'text-white'}`}>
                Performance Specs
              </h3>
            </div>

            <div className="space-y-4 text-xs">
              <div className="flex justify-between items-center pb-2 border-b border-neutral-700/20">
                <span className={isLight ? 'text-[#4b5563]' : 'text-neutral-400'}>Model Core</span>
                <span className="font-semibold">Gemini 3.5 Pro / Flash</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-neutral-700/20">
                <span className={isLight ? 'text-[#4b5563]' : 'text-neutral-400'}>Context Window</span>
                <span className="font-semibold">1,000,000 tokens</span>
              </div>
              <div className="flex justify-between items-center pb-2 border-b border-neutral-700/20">
                <span className={isLight ? 'text-[#4b5563]' : 'text-neutral-400'}>Avg Response Latency</span>
                <span className="font-semibold text-emerald-500">~140ms</span>
              </div>
              <div className="flex justify-between items-center">
                <span className={isLight ? 'text-[#4b5563]' : 'text-neutral-400'}>Execution Environment</span>
                <span className="font-semibold">Isolated Node Runtime</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'config' && (
        <div className={`p-6 rounded-2xl border ${
          isLight ? 'bg-[#f8f9fa] border-[#e2e4e8]' : 'bg-[#18181d] border-[#25242e]'
        }`}>
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck className="w-4 h-4 text-orange-500" />
            <h3 className={`text-sm font-semibold ${isLight ? 'text-[#111827]' : 'text-white'}`}>
              System Instructions & Behavioral Rules
            </h3>
          </div>

          <pre className={`p-4 rounded-xl text-xs font-mono overflow-x-auto leading-relaxed ${
            isLight
              ? 'bg-white border border-[#e2e4e8] text-[#374151]'
              : 'bg-[#131217] border border-[#262530] text-neutral-300'
          }`}>
{`[SYSTEM INSTRUCTION FOR ${bot.name.toUpperCase()}]
Role: ${bot.role || 'Specialist Agent'}
Group: ${bot.group}
Capabilities: File read/write, AST analysis, tool execution, structured output.
Behavior: Always maintain clean code standards, follow repository conventions, verify output syntax, and execute with zero slop.`}
          </pre>
        </div>
      )}
    </div>
  );
};

export const LibraryView: React.FC = () => {
  const { agents, selectAgent, setSidebarTab, setSidebarOpen, closeLibrary, theme } = useApp();
  const isLight = theme === 'light';
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<'all' | 'orchestrators' | 'specialists'>('all');
  const [showAllBotsView, setShowAllBotsView] = useState(false);
  const [botActive, setBotActive] = useState<Record<string, boolean>>({});
  const [selectedBotForPage, setSelectedBotForPage] = useState<MedioBotAgent | null>(null);

  const getBotRole = (bot: MedioBotAgent): string => {
    return bot.role || 'Specialist';
  };

  const allBots = useMemo(() => {
    const registry = new Map(agents.map((agent) => [agent.id, agent]));
    if (!registry.has('maestro')) registry.set('maestro', { id: 'maestro', name: 'Maestro', group: 'orchestrator', role: 'Team orchestration', status: 'waiting', currentTask: 'not registered' });
    return Array.from(registry.values());
  }, [agents]);

  const filteredBots = allBots.filter((bot: MedioBotAgent) => {
    const roleText = getBotRole(bot);
    const matchSearch =
      bot.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      roleText.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchSearch) return false;
    if (activeCategory === 'orchestrators') return bot.group === 'orchestrator';
    if (activeCategory === 'specialists') return bot.group === 'specialist';
    return true;
  });

  const handleLaunchBotInMaestro = (botId: string) => {
    selectAgent(botId);
    setSidebarTab('maestro');
    setSidebarOpen(true);
  };

  if (selectedBotForPage) {
    return (
      <MedioBotDetailPage
        bot={selectedBotForPage}
        onBack={() => setSelectedBotForPage(null)}
        isLight={isLight}
        isActive={botActive[selectedBotForPage.id] ?? true}
        onToggleActive={(active) =>
          setBotActive((prev) => ({ ...prev, [selectedBotForPage.id]: active }))
        }
        onLaunchInMaestro={() => handleLaunchBotInMaestro(selectedBotForPage.id)}
      />
    );
  }

  if (showAllBotsView) {
    const verticalFiltered = allBots.filter((bot) => {
      const matchQuery =
        bot.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        bot.role?.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchQuery) return false;
      return true;
    });

    return (
      <div className={`flex-1 flex flex-col h-full overflow-y-auto overflow-x-hidden select-none p-6 sm:p-8 scrollbar-thin animate-in fade-in duration-200 ${
        isLight ? 'bg-white text-[#111827]' : 'bg-[#141415] text-[#e4e4e7]'
      }`}>
        {/* Top Header with Back Navigation */}
        <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b shrink-0 ${
          isLight ? 'border-[#e2e4e8]' : 'border-[#232328]'
        }`}>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowAllBotsView(false)}
              className={`p-2 rounded-xl transition-all cursor-pointer shadow-xs active:scale-95 flex items-center justify-center ${
                isLight ? 'bg-[#f1f2f5] hover:bg-[#e4e5e9] text-[#374151] hover:text-[#111827]' : 'bg-[#1e1e23] hover:bg-[#2c2b34] text-neutral-300 hover:text-white'
              }`}
              title="Back to Library Overview"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className={`text-xl sm:text-2xl font-semibold tracking-tight ${isLight ? 'text-[#111827]' : 'text-white'}`}>
                  Registered Mediobots
                </h1>
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                  isLight ? 'bg-[#f1f2f5] text-[#374151] border-[#dcdce2]' : 'bg-[#28272f] text-neutral-300 border-[#373640]'
                }`}>
                  {verticalFiltered.length} Total
                </span>
              </div>
              <p className={`text-xs sm:text-sm mt-1 ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                Browse Mediobot definitions currently registered in this runtime.
              </p>
            </div>
          </div>

          {/* Search registered definitions */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className={`w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter all bots..."
                className={`rounded-xl pl-8 pr-3 py-1.5 text-xs focus:outline-none transition-colors w-44 sm:w-56 ${
                  isLight
                    ? 'bg-[#f1f2f5] border border-[#dcdce2] text-[#111827] placeholder:text-[#6b7280] focus:border-[#a1a1aa]'
                    : 'bg-[#1e1e23] border border-[#2e2d36] text-neutral-200 placeholder:text-neutral-500 focus:border-neutral-500'
                }`}
              />
            </div>
          </div>
        </div>

        {/* Registered definition cards */}
        <div className="mt-8 flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 pb-10">
            {verticalFiltered.map((bot) => {
              const visuals = getMediobotPresentation(bot.id, bot.name, bot.role);
              const roleDisplay = getBotRole(bot);

              return (
                <div
                  key={bot.id}
                  onClick={() => setSelectedBotForPage(bot)}
                  className={`flex flex-col justify-between p-5 rounded-2xl border transition-all duration-300 relative group cursor-pointer active:scale-[0.98] ${
                    isLight
                      ? 'bg-white border-[#e2e4e8] shadow-xs hover:shadow-md'
                      : `bg-[#1b1b20] border ${visuals.border} shadow-lg hover:shadow-2xl`
                  }`}
                >
                  <div>
                    {/* Identity avatar and product badge */}
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-12 h-12 rounded-full ${visuals.avatar} flex items-center justify-center gap-[5px] shrink-0 shadow-md group-hover:scale-105 transition-transform duration-200`}
                        >
                          <span className={`w-[5px] h-[15px] rounded-full ${visuals.eye} animate-eye-blink block`} />
                          <span className={`w-[5px] h-[15px] rounded-full ${visuals.eye} animate-eye-blink block`} />
                        </div>

                        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border shadow-xs ${
                          isLight ? 'bg-[#f1f2f5] border-[#e2e4e8]' : 'bg-[#1e1e26] border-[#2e2d3a]'
                        }`}>
                          <VerifiedBlueTick className="w-3.5 h-3.5" />
                          <span className={`text-[11.5px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e2e8f0]'}`}>Mediobot</span>
                        </div>
                      </div>
                    </div>

                    <h3 className={`text-lg font-semibold tracking-tight ${isLight ? visuals.lightText : visuals.darkText}`}>
                      {bot.name}
                    </h3>
                    <p className={`text-xs mt-1 font-medium ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                      {roleDisplay}
                    </p>

                    <p className={`inline-flex mt-4 px-2.5 py-0.5 rounded-full text-[10.5px] font-medium ${isLight ? visuals.lightBadge : visuals.darkBadge}`}>{bot.group === 'orchestrator' ? 'Orchestrator' : 'Specialist'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex-1 flex flex-col h-full overflow-y-auto select-none p-6 sm:p-8 ${
      isLight ? 'bg-white text-[#111827]' : 'bg-[#141415] text-[#e4e4e7]'
    }`}>
      {/* Header Bar */}
      <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b ${
        isLight ? 'border-[#e2e4e8]' : 'border-[#232328]'
      }`}>
        <div>
          <div className="flex items-center gap-2.5">
            <CircleBlinkingEyeSvg className={`w-5 h-5 ${isLight ? 'text-[#111827]' : 'text-neutral-200'}`} />
            <h1 className={`text-xl sm:text-2xl font-semibold tracking-tight ${isLight ? 'text-[#111827]' : 'text-white'}`}>MedioBots Library</h1>
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${
              isLight ? 'bg-[#f1f2f5] text-[#374151] border-[#dcdce2]' : 'bg-[#28272f] text-neutral-300 border-[#373640]'
            }`}>
              {allBots.length} Agents
            </span>
          </div>
          <p className={`text-xs sm:text-sm mt-1 ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
            Explore the identities and roles registered by the local Mediobot runtime.
          </p>
        </div>

        {/* Search & Category Filter */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className={`w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search MedioBots..."
              className={`rounded-xl pl-8 pr-3 py-1.5 text-xs focus:outline-none transition-colors w-44 sm:w-56 ${
                isLight
                  ? 'bg-[#f1f2f5] border border-[#dcdce2] text-[#111827] placeholder:text-[#6b7280] focus:border-[#a1a1aa]'
                  : 'bg-[#1e1e23] border border-[#2e2d36] text-neutral-200 placeholder:text-neutral-500 focus:border-neutral-500'
              }`}
            />
          </div>

          <div className={`flex items-center p-1 rounded-xl border text-xs ${
            isLight ? 'bg-[#f1f2f5] border-[#dcdce2]' : 'bg-[#1c1c20] border-[#2b2a33]'
          }`}>
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-3 py-1.5 rounded-lg transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer ${
                activeCategory === 'all'
                  ? isLight
                    ? 'bg-white text-[#111827] font-semibold shadow-xs'
                    : 'bg-[#32313a] text-white font-medium shadow-xs'
                  : isLight
                  ? 'text-[#4b5563] hover:text-[#111827] hover:bg-[#e4e5e9]'
                  : 'text-neutral-400 hover:text-white hover:bg-[#282730]'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setActiveCategory('orchestrators')}
              className={`px-3 py-1.5 rounded-lg transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer ${
                activeCategory === 'orchestrators'
                  ? isLight
                    ? 'bg-white text-[#111827] font-semibold shadow-xs'
                    : 'bg-[#32313a] text-white font-medium shadow-xs'
                  : isLight
                  ? 'text-[#4b5563] hover:text-[#111827] hover:bg-[#e4e5e9]'
                  : 'text-neutral-400 hover:text-white hover:bg-[#282730]'
              }`}
            >
              Orchestrators
            </button>
            <button
              onClick={() => setActiveCategory('specialists')}
              className={`px-3 py-1.5 rounded-lg transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer ${
                activeCategory === 'specialists'
                  ? isLight
                    ? 'bg-white text-[#111827] font-semibold shadow-xs'
                    : 'bg-[#32313a] text-white font-medium shadow-xs'
                  : isLight
                  ? 'text-[#4b5563] hover:text-[#111827] hover:bg-[#e4e5e9]'
                  : 'text-neutral-400 hover:text-white hover:bg-[#282730]'
              }`}
            >
              Specialists
            </button>
          </div>
        </div>
      </div>

      {/* Main Section: Horizontally Aligned MedioBots Cards */}
      <div className="mt-8 flex-1 flex flex-col justify-start">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            <h2 className={`text-sm font-semibold uppercase tracking-wider ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
              Mediobot roster
            </h2>
          </div>
          <span className={`text-xs ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>Click any bot to open its dedicated page</span>
        </div>

        {/* Horizontal definition cards */}
        <div className="w-full overflow-x-auto pb-4 pt-1 scrollbar-thin">
          <div className="flex items-stretch gap-4 min-w-max">
            {filteredBots.map((bot: MedioBotAgent) => {
              const visuals = getMediobotPresentation(bot.id, bot.name, bot.role);
              const roleDisplay = getBotRole(bot);

              return (
                <div
                  key={bot.id}
                  onClick={() => setSelectedBotForPage(bot)}
                  className={`w-[240px] flex flex-col items-start p-5 rounded-2xl border transition-all duration-300 cursor-pointer relative group active:scale-[0.98] shrink-0 ${
                    isLight
                      ? 'bg-white border-[#e2e4e8] shadow-xs hover:shadow-md hover:-translate-y-1'
                      : `bg-[#1b1b20] border ${visuals.border} shadow-lg hover:-translate-y-1 hover:shadow-2xl`
                  }`}
                >
                  {/* Canonical identity avatar and product badge */}
                  <div className="flex items-center gap-2.5 mb-4 w-full">
                    <div
                      className={`w-12 h-12 rounded-full ${visuals.avatar} flex items-center justify-center gap-[5px] shrink-0 shadow-md group-hover:scale-105 transition-transform duration-200`}
                    >
                      <span className={`w-[5px] h-[15px] rounded-full ${visuals.eye} animate-eye-blink block`} />
                      <span className={`w-[5px] h-[15px] rounded-full ${visuals.eye} animate-eye-blink block`} />
                    </div>

                    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border shadow-xs ${
                      isLight ? 'bg-[#f1f2f5] border-[#e2e4e8]' : 'bg-[#1e1e26] border-[#2e2d3a]'
                    }`}>
                      <VerifiedBlueTick className="w-3.5 h-3.5" />
                      <span className={`text-[11px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e2e8f0]'}`}>Mediobot</span>
                    </div>
                  </div>

                  <h3 className={`text-lg font-semibold tracking-tight ${isLight ? visuals.lightText : visuals.darkText}`}>
                    {bot.name}
                  </h3>

                  <p className={`text-xs mt-1 font-medium ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                    {roleDisplay}
                  </p>

                  <p className={`inline-flex mt-3 px-2.5 py-0.5 rounded-full text-[10.5px] font-medium ${isLight ? visuals.lightBadge : visuals.darkBadge}`}>
                    {bot.group === 'orchestrator' ? 'Orchestrator' : 'Specialist'}
                  </p>
                </div>
              );
            })}

            <div
              onClick={() => setShowAllBotsView(true)}
              className={`w-[240px] flex flex-col items-center justify-center p-5 rounded-2xl border border-dashed shadow-md transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl cursor-pointer relative group active:scale-[0.98] text-center shrink-0 ${
                isLight
                  ? 'bg-[#f8f9fa] hover:bg-[#f1f2f5] border-[#dcdce2] hover:border-[#a1a1aa]'
                  : 'bg-[#18181d] hover:bg-[#1e1e24] border-[#34334e] hover:border-neutral-400'
              }`}
            >
              <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 mb-3 shadow-inner ${
                isLight
                  ? 'bg-[#e4e5e9] text-[#111827] group-hover:bg-[#111827] group-hover:text-white'
                  : 'bg-[#26252e] text-neutral-300 group-hover:bg-white group-hover:text-black'
              }`}>
                <ArrowRight className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" />
              </div>
              <h3 className={`text-base font-semibold transition-colors ${isLight ? 'text-[#111827]' : 'text-white'}`}>
                See More
              </h3>
              <p className={`text-[11.5px] mt-1 px-2 font-normal ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                Browse all registered definitions
              </p>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
