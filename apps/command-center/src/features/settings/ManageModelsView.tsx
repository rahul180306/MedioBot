import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  ArrowLeft,
  X,
  Trash2,
  Check,
  ExternalLink,
  Sparkles,
} from 'lucide-react';
import { ProviderIcon } from './ProviderIcons';
import { ProviderConfig, ConfiguredModel, CustomHeader, CatalogProviderItem } from '../../types';
import { useApp } from '../../state/AppContext';
import SquishSwitch from '../../components/SquishSwitch';

interface ManageModelsViewProps {
  providers: ProviderConfig[];
  providerCatalog: CatalogProviderItem[];
  onToggleProvider: (providerId: string) => void;
  onToggleModel: (providerId: string, modelId: string) => void;
  onConnectProvider: (provider: Record<string, unknown>) => Promise<void>;
  onAddCustomProvider: (provider: Record<string, unknown>) => Promise<void>;
}

export const ManageModelsView: React.FC<ManageModelsViewProps> = ({
  providers,
  providerCatalog,
  onToggleProvider,
  onToggleModel,
  onConnectProvider,
  onAddCustomProvider,
}) => {
  const { theme } = useApp();
  const isLight = theme === 'light';
  const [viewMode, setViewMode] = useState<'manage' | 'connect' | 'configure' | 'custom_form'>('manage');
  const [selectedProvider, setSelectedProvider] = useState<CatalogProviderItem | null>(null);
  const [providerApiKey, setProviderApiKey] = useState('');
  const [providerModelId, setProviderModelId] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const requiresManualModelId = selectedProvider?.adapterType === 'anthropic-messages' || selectedProvider?.id === 'openrouter';
  const [connecting, setConnecting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [providerSearchQuery, setProviderSearchQuery] = useState('');

  // Custom Provider Form State
  const [customProviderId, setCustomProviderId] = useState('');
  const [customDisplayName, setCustomDisplayName] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customModels, setCustomModels] = useState<Array<{ id: string; modelId: string; displayName: string; capabilities: NonNullable<ConfiguredModel['capabilities']> }>>([
    { id: 'm-1', modelId: '', displayName: '', capabilities: { text: true, reasoning: true, vision: false, tools: false } },
  ]);
  const [customHeaders, setCustomHeaders] = useState<Array<{ id: string; name: string; value: string }>>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  // Show toast notification
  const triggerToast = (msg: string) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(null), 3500);
  };

  // Filter connected providers & their models by search
  const filteredConnectedProviders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return providers.filter((p) => p.connected);

    return providers
      .filter((p) => p.connected)
      .map((p) => {
        const matchesProvider = p.name.toLowerCase().includes(q);
        const matchedModels = p.models.filter(
          (m) => matchesProvider || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
        );
        return {
          ...p,
          models: matchedModels,
        };
      })
      .filter((p) => p.models.length > 0);
  }, [providers, searchQuery]);

  // Catalog filtered items for Connect Provider modal
  const filteredCatalogPopular = useMemo(() => {
    const q = providerSearchQuery.trim().toLowerCase();
    return providerCatalog.filter(
      (c) => c.group === 'Popular' && (!q || c.name.toLowerCase().includes(q) || (c.subtitle && c.subtitle.toLowerCase().includes(q)))
    );
  }, [providerCatalog, providerSearchQuery]);

  const filteredCatalogOther = useMemo(() => {
    const q = providerSearchQuery.trim().toLowerCase();
    return providerCatalog.filter(
      (c) => c.group === 'Other' && (!q || c.name.toLowerCase().includes(q) || (c.subtitle && c.subtitle.toLowerCase().includes(q)))
    );
  }, [providerCatalog, providerSearchQuery]);

  // Handle Custom Provider Submit
  const handleCustomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const slugId = (customProviderId.trim() || customDisplayName.trim())
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');

    if (!slugId) {
      setFormError('Provider ID is required (letters, numbers, hyphens, or underscores).');
      return;
    }

    const dispName = customDisplayName.trim() || slugId;

    // Filter valid models
    const validModels: ConfiguredModel[] = customModels
      .filter((m) => m.modelId.trim() || m.displayName.trim())
      .map((m, idx) => ({
        id: m.modelId.trim() || `model-${idx + 1}`,
        name: m.displayName.trim() || m.modelId.trim() || `Model ${idx + 1}`,
        enabled: true,
        isCustom: true,
        tag: 'Custom',
        capabilities: m.capabilities,
      }));

    if (validModels.length === 0) {
      setFormError('Add at least one model ID before connecting this provider.');
      return;
    }

    const validHeaders: CustomHeader[] = customHeaders
      .filter((h) => h.name.trim())
      .map((h) => ({
        id: h.id,
        name: h.name.trim(),
        value: h.value.trim(),
      }));

    const newCustomProvider = {
      id: slugId,
      providerType: 'custom',
      displayName: dispName,
      badge: 'Custom',
      description: customBaseUrl.trim() || 'Custom OpenAI-compatible endpoint',
      iconType: 'custom',
      enabled: true,
      baseUrl: customBaseUrl.trim() || undefined,
      apiKey: customApiKey.trim() || undefined,
      customHeaders: validHeaders.length > 0 ? validHeaders : undefined,
      models: validModels,
    };

    try {
      setConnecting(true);
      await onAddCustomProvider(newCustomProvider);
      triggerToast(`Connected "${dispName}" after provider validation.`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Provider validation failed.');
      setConnecting(false);
      return;
    }
    setConnecting(false);
    
    // Reset form
    setCustomProviderId('');
    setCustomDisplayName('');
    setCustomBaseUrl('');
    setCustomApiKey('');
    setCustomModels([{ id: 'm-1', modelId: '', displayName: '', capabilities: { text: true, reasoning: true, vision: false, tools: false } }]);
    setCustomHeaders([]);
    setViewMode('manage');
  };

  return (
    <div className="settings-panel w-full max-w-[760px] mx-auto select-none">
      {/* Toast Notification */}
      {successToast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-3.5 py-2 rounded-lg bg-emerald-950/90 border border-emerald-800 text-emerald-200 text-xs shadow-xl animate-fadeIn">
          <Check className="w-4 h-4 text-emerald-400" />
          <span>{successToast}</span>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          VIEW 1: MANAGE MODELS (Matching Screenshot 1 & Screenshot 5)
         ───────────────────────────────────────────────────────────── */}
      {viewMode === 'manage' && (
        <div className="space-y-6 animate-fadeIn">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className={`text-[26px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                Manage models
              </h1>
              <p className={`text-sm mt-1 ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                Customize which models appear in the model selector.
              </p>
            </div>

            {/* Connect Provider Button (Matches Screenshot 1 top right) */}
            <button
              onClick={() => setViewMode('connect')}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer shadow-xs shrink-0 ${
                isLight
                  ? 'bg-white hover:bg-[#f4f4f7] border-[#d8d8de] text-[#1f2937]'
                  : 'bg-[#25242b] hover:bg-[#302f38] border-[#383742] text-white'
              }`}
            >
              <Plus className={`w-3.5 h-3.5 ${isLight ? 'text-[#4b5563]' : 'text-neutral-300'}`} />
              <span>Connect provider</span>
            </button>
          </div>

          {/* Search Models Input Box (Matches Screenshot 1 with subtle border) */}
          <div>
            <div className={`w-full flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${
              isLight
                ? 'bg-white border-[#d8d8de] focus-within:border-neutral-500'
                : 'bg-[#1b1a20] border-[#34333e] focus-within:border-[#e07a38]/80'
            }`}>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models"
                className={`bg-transparent text-sm focus:outline-none w-full ${
                  isLight
                    ? 'text-[#1f2937] placeholder-neutral-400'
                    : 'text-white placeholder-neutral-500'
                }`}
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className={isLight ? 'text-neutral-400 hover:text-black' : 'text-neutral-500 hover:text-white'}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Connected Providers List */}
          <div className="space-y-6 pt-1">
            {filteredConnectedProviders.map((provider) => (
              <div key={provider.id} className="space-y-3">
                {/* Provider Header Row with Icon, Name and Master Toggle */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-2.5">
                    <div className={isLight ? 'text-[#374151]' : 'text-neutral-200'}>
                      <ProviderIcon type={provider.iconType} className="w-4 h-4" />
                    </div>
                    <span className={`text-[14px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                      {provider.name}
                    </span>
                    {provider.badge && provider.badge !== 'Recommended' && (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                        isLight
                          ? 'bg-[#f1f2f5] text-[#374151] border-[#dcdce2]'
                          : 'bg-[#2a2933] text-neutral-300 border-[#383745]'
                      }`}>
                        {provider.badge}
                      </span>
                    )}
                  </div>

                  {/* Provider Master Toggle */}
                  <SquishSwitch
                    checked={provider.enabled}
                    onChange={() => onToggleProvider(provider.id)}
                    ariaLabel={`Toggle ${provider.name}`}
                    trackColor={isLight ? '#e2e4e8' : '#2a2933'}
                    trackOnColor="#ea580c"
                    thumbColor="#ffffff"
                    thumbOnColor="#ffffff"
                    width={48}
                    height={26}
                    radius={13}
                    speed={55}
                    stretch={34}
                  />
                </div>

                {/* Models Card Container (Matches Screenshot 1 & Screenshot 5) */}
                <div
                  className={`rounded-xl border divide-y transition-opacity duration-200 ${
                    isLight
                      ? 'bg-white border-[#e2e4e8] divide-[#f0f0f3] shadow-xs'
                      : 'bg-[#19181d] border-[#2a2933] divide-[#25242e]'
                  } ${
                    provider.enabled ? 'opacity-100' : 'opacity-40 pointer-events-none'
                  }`}
                >
                  {provider.models.map((m) => (
                    <div
                      key={m.id}
                      className={`flex items-center justify-between px-4 py-3.5 transition-colors ${
                        isLight ? 'hover:bg-[#f9fafb]' : 'hover:bg-[#1f1e25]/50'
                      }`}
                    >
                      <div className="space-y-0.5">
                        <div className={`text-[13.5px] font-normal ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                          {m.name}
                        </div>
                        {m.context && (
                          <div className={`text-[11px] font-mono ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>
                            {m.context}
                          </div>
                        )}
                      </div>

                      {/* Model Toggle Switch (Matches Orange accent in Screenshot 1 & 5) */}
                      <SquishSwitch
                        checked={m.enabled}
                        onChange={() => onToggleModel(provider.id, m.id)}
                        ariaLabel={`Toggle ${m.name}`}
                        trackColor={isLight ? '#e2e4e8' : '#2a2933'}
                        trackOnColor="#ea580c"
                        thumbColor="#ffffff"
                        thumbOnColor="#ffffff"
                        width={48}
                        height={26}
                        radius={13}
                        speed={55}
                        stretch={34}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {filteredConnectedProviders.length === 0 && (
              searchQuery ? (
                <div className={`p-8 text-center rounded-xl border space-y-2 ${
                  isLight ? 'bg-white border-[#e2e4e8] text-[#4b5563]' : 'bg-[#19181d] border-[#2a2933] text-neutral-400'
                }`}>
                  <p className="text-sm">No models found matching "{searchQuery}".</p>
                  <button
                    onClick={() => setSearchQuery('')}
                    className="text-xs text-amber-500 hover:underline"
                  >
                    Clear search filter
                  </button>
                </div>
              ) : (
                <div className={`p-8 text-center rounded-xl border space-y-3 ${
                  isLight ? 'bg-white border-[#e2e4e8] text-[#4b5563]' : 'bg-[#19181d] border-[#2a2933] text-neutral-400'
                }`}>
                  <p className={`text-sm ${isLight ? 'text-[#09090b]' : 'text-neutral-300'}`}>No providers connected yet.</p>
                  <p className={`text-xs max-w-sm mx-auto ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>
                    Connect an inference provider to enable models for your threads.
                  </p>
                  <button
                    onClick={() => setViewMode('connect')}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                      isLight
                        ? 'bg-[#f4f4f7] hover:bg-[#ebebef] text-[#09090b] border-[#d8d8de]'
                        : 'bg-[#2a2933] text-neutral-200 hover:bg-[#34333e] hover:text-white border-[#383745]'
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Connect provider</span>
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          VIEW 2: CONNECT PROVIDER (Matching Screenshot 2)
         ───────────────────────────────────────────────────────────── */}
      {viewMode === 'connect' && (
        <div className="space-y-6 animate-fadeIn">
          {/* Header */}
          <div className="flex items-center justify-between pb-1">
            <h1 className={`text-[20px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
              Connect provider
            </h1>
            <button
              onClick={() => setViewMode('manage')}
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                isLight ? 'text-neutral-500 hover:text-black' : 'text-neutral-400 hover:text-white'
              }`}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Search Providers Input */}
          <div className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${
            isLight
              ? 'bg-white border-[#d8d8de] focus-within:border-neutral-500'
              : 'bg-[#1b1a20] border-[#34333e] focus-within:border-neutral-500'
          }`}>
            <Search className="w-4 h-4 text-neutral-400 shrink-0" />
            <input
              type="text"
              value={providerSearchQuery}
              onChange={(e) => setProviderSearchQuery(e.target.value)}
              placeholder="Search providers"
              className={`bg-transparent text-sm focus:outline-none w-full ${
                isLight
                  ? 'text-[#1f2937] placeholder-neutral-400'
                  : 'text-white placeholder-neutral-500'
              }`}
            />
          </div>

          {/* Popular Group */}
          {filteredCatalogPopular.length > 0 && (
            <div className="space-y-2">
              <div className={`text-[12px] font-medium px-1 tracking-wide ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                Popular
              </div>
              <div className="space-y-1">
                {filteredCatalogPopular.map((cat) => {
                  const isConnected = providers.some((p) => p.id === cat.id && p.connected);
                  return (
                    <button
                      key={cat.id}
                      onClick={() => {
                        setSelectedProvider(cat);
                        setProviderApiKey('');
                        setProviderModelId('');
                        setProviderError(null);
                        setViewMode('configure');
                      }}
                      className={`w-full flex items-center justify-between px-3.5 py-3 rounded-xl text-left border transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer group ${
                        isLight
                          ? 'bg-white hover:bg-[#eaebee] border-[#e2e4e8] hover:border-[#cbd5e1]'
                          : 'bg-[#19181d] hover:bg-[#32313a] border-[#272630] hover:border-[#3a3944]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`transition-colors shrink-0 ${
                          isLight ? 'text-[#374151] group-hover:text-black' : 'text-neutral-300 group-hover:text-white'
                        }`}>
                          <ProviderIcon type={cat.iconType} className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex items-center gap-2">
                          <span className={`text-[13.5px] font-medium ${
                            isLight ? 'text-[#1f2937] group-hover:text-black' : 'text-[#e5e5e7] group-hover:text-white'
                          }`}>
                            {cat.name}
                          </span>
                          {cat.subtitle && (
                            <span className={`text-xs truncate ${isLight ? 'text-[#6b7280]' : 'text-neutral-400'}`}>
                              {cat.subtitle}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {cat.badge && cat.badge !== 'Recommended' && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                            isLight
                              ? 'bg-[#f1f2f5] text-[#374151] border-[#dcdce2]'
                              : 'bg-[#2a2933] text-neutral-300 border-[#383745]'
                          }`}>
                            {cat.badge}
                          </span>
                        )}
                        {isConnected && (
                          <span className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
                            isLight
                              ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                              : 'text-emerald-400 bg-emerald-950/60 border-emerald-900/60'
                          }`}>
                            <Check className="w-3 h-3" />
                            Connected
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Other Group (Includes Custom OpenAI-compatible Provider) */}
          {filteredCatalogOther.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className={`text-[12px] font-medium px-1 tracking-wide ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                Other
              </div>
              <div className="space-y-1">
                {filteredCatalogOther.map((cat) => {
                  const isCustom = cat.isCustom;
                  const isConnected = providers.some((p) => p.id === cat.id && p.connected);

                  return (
                    <button
                      key={cat.id}
                      onClick={() => {
                        if (isCustom) {
                          setViewMode('custom_form');
                        } else {
                          setSelectedProvider(cat);
                          setProviderApiKey('');
                          setProviderModelId('');
                          setProviderError(null);
                          setViewMode('configure');
                        }
                      }}
                      className={`w-full flex items-center justify-between px-3.5 py-3 rounded-xl text-left border transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] cursor-pointer group ${
                        isLight
                          ? 'bg-white hover:bg-[#eaebee] border-[#e2e4e8] hover:border-[#cbd5e1]'
                          : 'bg-[#19181d] hover:bg-[#32313a] border-[#272630] hover:border-[#3a3944]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`transition-colors shrink-0 ${
                          isLight ? 'text-[#374151] group-hover:text-black' : 'text-neutral-300 group-hover:text-white'
                        }`}>
                          <ProviderIcon type={cat.iconType} className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex items-center gap-2">
                          <span className={`text-[13.5px] font-medium ${
                            isLight ? 'text-[#1f2937] group-hover:text-black' : 'text-[#e5e5e7] group-hover:text-white'
                          }`}>
                            {cat.name}
                          </span>
                          {cat.subtitle && (
                            <span className={`text-xs truncate ${isLight ? 'text-[#6b7280]' : 'text-neutral-400'}`}>
                              {cat.subtitle}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {cat.badge && (
                          <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                            isLight
                              ? 'bg-[#f1f2f5] text-[#374151] border-[#dcdce2]'
                              : 'bg-[#2a2933] text-neutral-300 border-[#383745]'
                          }`}>
                            {cat.badge}
                          </span>
                        )}
                        {isConnected && !isCustom && (
                          <span className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
                            isLight
                              ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                              : 'text-emerald-400 bg-emerald-950/60 border-emerald-900/60'
                          }`}>
                            <Check className="w-3 h-3" />
                            Connected
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {viewMode === 'configure' && selectedProvider && (
        <form className="space-y-5 animate-fadeIn" onSubmit={async (event) => {
          event.preventDefault();
          setProviderError(null);
          setConnecting(true);
          try {
            await onConnectProvider({
              id: selectedProvider.id,
              providerType: selectedProvider.id,
              displayName: selectedProvider.name,
              baseUrl: selectedProvider.defaultBaseUrl,
              apiKey: providerApiKey,
              enabled: true,
              badge: selectedProvider.badge,
              description: selectedProvider.subtitle,
              iconType: selectedProvider.iconType,
              models: requiresManualModelId
                ? [{ id: providerModelId.trim(), name: providerModelId.trim(), enabled: true,
                    capabilities: selectedProvider.id === 'openrouter'
                      ? { text: true, reasoning: false, vision: false, tools: false }
                      : { text: true, reasoning: true, vision: false, tools: true, maestroCompatible: true } }]
                : selectedProvider.defaultModels.map((model) => ({ ...model, enabled: true })),
              ...(requiresManualModelId ? { modelId: providerModelId.trim() } : {}),
            });
            triggerToast(`Connected ${selectedProvider.name} after validation.`);
            setViewMode('manage');
          } catch (error) {
            setProviderError(error instanceof Error ? error.message : 'Provider validation failed.');
          } finally {
            setConnecting(false);
          }
        }}>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setViewMode('connect')}
              aria-label="Back to providers"
              className={isLight ? 'text-neutral-500 hover:text-black cursor-pointer' : 'text-neutral-400 hover:text-white cursor-pointer'}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            {selectedProvider && <ProviderIcon type={selectedProvider.iconType} className="w-4 h-4" />}
            <h1 className={`text-[20px] font-semibold ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
              Connect {selectedProvider.name}
            </h1>
          </div>
          <p className={`text-sm ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
            Enter provider configuration. Mediobot validates it before saving a connection.
          </p>
          <label className={`block space-y-2 text-sm ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
            <span>API key {selectedProvider.requiresApiKey ? '(required)' : '(optional)'}</span>
            <input
              autoComplete="new-password"
              type="password"
              value={providerApiKey}
              onChange={(event) => setProviderApiKey(event.target.value)}
              placeholder="Paste API key"
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors ${
                isLight
                  ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                  : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
              }`}
            />
          </label>
          {requiresManualModelId && (
            <label className={`block space-y-2 text-sm ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
              <span>{selectedProvider.id === 'openrouter' ? 'OpenRouter model ID' : 'Claude model ID'}</span>
              <input
                required
                value={providerModelId}
                onChange={(event) => setProviderModelId(event.target.value)}
                placeholder={selectedProvider.id === 'openrouter' ? 'For example: openai/model-name' : 'For example: claude-sonnet-4-6'}
                autoComplete="off"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors ${
                  isLight ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]' : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                }`}
              />
              <span className={`block text-xs ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>
                {selectedProvider.id === 'openrouter'
                  ? 'Enter the exact model ID shown in OpenRouter. MedioBot keeps it on the conservative JSON-text protocol unless that exact route has a verified capability profile.'
                  : 'Enter the exact model ID from your Anthropic account. MedioBot will validate and save that ID without selecting a substitute.'}
              </span>
            </label>
          )}
          {selectedProvider.defaultModels.length === 0 && selectedProvider.adapterType === 'openai-compatible' && !requiresManualModelId && (
            <p className={`text-xs ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>This provider needs a model list before it can be connected.</p>
          )}
          {selectedProvider.adapterType === 'not-yet-supported' && (
            <p className={`text-xs ${isLight ? 'text-amber-700' : 'text-amber-200'}`}>This provider can be configured in the catalog, but its runtime adapter is not implemented yet.</p>
          )}
          {providerError && (
            <div role="alert" className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs">
              {providerError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setViewMode('connect')}
              className={`px-4 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                isLight
                  ? 'border-[#d8d8de] text-[#374151] hover:bg-[#f4f4f7]'
                  : 'border-[#383745] text-neutral-300 hover:text-white'
              }`}
            >
              Back
            </button>
            <button
              type="submit"
              disabled={connecting || !providerApiKey.trim() || selectedProvider.adapterType === 'not-yet-supported'
                || (selectedProvider.adapterType === 'openai-compatible' && selectedProvider.defaultModels.length === 0 && !requiresManualModelId)
                || (requiresManualModelId && !providerModelId.trim())}
              className={`px-4 py-2 rounded-lg font-semibold text-xs disabled:opacity-40 cursor-pointer shadow-sm transition-colors ${
                isLight
                  ? 'bg-[#09090b] text-white hover:bg-[#27272a]'
                  : 'bg-white text-black hover:bg-neutral-200'
              }`}
            >
              {connecting ? 'Validating…' : 'Validate and connect'}
            </button>
          </div>
        </form>
      )}

      {/* ─────────────────────────────────────────────────────────────
          VIEW 3: CUSTOM PROVIDER FORM (Matching Screenshot 3 & 4)
         ───────────────────────────────────────────────────────────── */}
      {viewMode === 'custom_form' && (
        <form onSubmit={handleCustomSubmit} className="space-y-6 animate-fadeIn">
          {/* Header */}
          <div className="flex items-center justify-between pb-1">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setViewMode('connect')}
                aria-label="Back to providers"
                className={`p-1 rounded-md transition-colors cursor-pointer ${
                  isLight ? 'text-neutral-500 hover:text-black' : 'text-neutral-400 hover:text-white'
                }`}
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <Sparkles className={`w-4 h-4 ${isLight ? 'text-[#4b5563]' : 'text-neutral-300'}`} />
              <h1 className={`text-[20px] font-semibold tracking-tight ${isLight ? 'text-[#1f2937]' : 'text-[#e5e5e7]'}`}>
                Custom provider
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setViewMode('manage')}
              aria-label="Close"
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                isLight ? 'text-neutral-500 hover:text-black' : 'text-neutral-400 hover:text-white'
              }`}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Subtitle Description */}
          <p className={`text-sm -mt-2 ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
            Configure an OpenAI-compatible provider. See the{' '}
            <a
              href="https://platform.openai.com/docs/api-reference"
              target="_blank"
              rel="noreferrer"
              className={`underline ${isLight ? 'text-[#1f2937] hover:text-black' : 'text-[#e5e5e7] hover:text-white'}`}
            >
              provider config docs
            </a>
            .
          </p>

          {formError && (
            <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs">
              {formError}
            </div>
          )}

          <div className="space-y-5">
            {/* Field 1: Provider ID */}
            <div className="space-y-1.5">
              <label className={`block text-[13px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
                Provider ID
              </label>
              <input
                type="text"
                value={customProviderId}
                onChange={(e) => setCustomProviderId(e.target.value)}
                placeholder="myprovider"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors ${
                  isLight
                    ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                    : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                }`}
              />
              <p className={`text-xs ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>
                Lowercase letters, numbers, hyphens, or underscores
              </p>
            </div>

            {/* Field 2: Display name */}
            <div className="space-y-1.5">
              <label className={`block text-[13px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
                Display name
              </label>
              <input
                type="text"
                value={customDisplayName}
                onChange={(e) => setCustomDisplayName(e.target.value)}
                placeholder="My AI Provider"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors ${
                  isLight
                    ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                    : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                }`}
              />
            </div>

            {/* Field 3: Base URL */}
            <div className="space-y-1.5">
              <label className={`block text-[13px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
                Base URL
              </label>
              <input
                type="text"
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                placeholder="https://api.myprovider.com/v1"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors font-mono text-[13px] ${
                  isLight
                    ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                    : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                }`}
              />
            </div>

            {/* Field 4: API key */}
            <div className="space-y-1.5">
              <label className={`block text-[13px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
                API key
              </label>
              <input
                type="password"
                value={customApiKey}
                onChange={(e) => setCustomApiKey(e.target.value)}
                placeholder="API key"
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none transition-colors ${
                  isLight
                    ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                    : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                }`}
              />
              <p className={`text-xs ${isLight ? 'text-[#6b7280]' : 'text-neutral-500'}`}>
                Optional. Leave empty if you manage auth via headers.
              </p>
            </div>

            {/* Field 5: Models (Dynamic rows matching Screenshot 4) */}
            <div className="space-y-2.5 pt-2">
              <label className={`block text-[13px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
                Models
              </label>

              <div className="space-y-2">
                {customModels.map((item, idx) => (
                  <div key={item.id} className="flex items-center gap-2.5">
                    {/* Model ID */}
                    <input
                      type="text"
                      value={item.modelId}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomModels((prev) =>
                          prev.map((m, i) => (i === idx ? { ...m, modelId: val } : m))
                        );
                      }}
                      placeholder="model-id"
                      className={`flex-1 px-3 py-2 border rounded-lg text-xs font-mono focus:outline-none transition-colors ${
                        isLight
                          ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                          : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                      }`}
                    />

                    {/* Display Name */}
                    <input
                      type="text"
                      value={item.displayName}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomModels((prev) =>
                          prev.map((m, i) => (i === idx ? { ...m, displayName: val } : m))
                        );
                      }}
                      placeholder="Display Name"
                      className={`flex-1 px-3 py-2 border rounded-lg text-xs focus:outline-none transition-colors ${
                        isLight
                          ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                          : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                      }`}
                    />

                    {/* Trash Delete Icon */}
                    {customModels.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setCustomModels((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className={`p-2 transition-colors cursor-pointer ${
                          isLight ? 'text-neutral-400 hover:text-rose-600' : 'text-neutral-500 hover:text-rose-400'
                        }`}
                        title="Delete model"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    <div className={`flex gap-2 text-[10px] ${isLight ? 'text-[#4b5563]' : 'text-neutral-400'}`}>
                      {(['text', 'reasoning', 'vision', 'tools'] as const).map((capability) => (
                        <label key={capability} className="inline-flex items-center gap-1 cursor-pointer">
                          <input type="checkbox" checked={item.capabilities[capability]} onChange={(event) => setCustomModels((prev) => prev.map((m, i) => i === idx
                            ? { ...m, capabilities: { ...m.capabilities, [capability]: event.target.checked } } : m))} />
                          {capability}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Add model button */}
              <button
                type="button"
                onClick={() =>
                  setCustomModels((prev) => [
                    ...prev,
                    { id: `m-${Date.now()}`, modelId: '', displayName: '', capabilities: { text: true, reasoning: true, vision: false, tools: false } },
                  ])
                }
                className={`flex items-center gap-1.5 text-xs pt-1 transition-colors cursor-pointer ${
                  isLight ? 'text-[#4b5563] hover:text-black font-medium' : 'text-neutral-300 hover:text-white'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add model</span>
              </button>
            </div>

            {/* Field 6: Headers (optional) */}
            <div className="space-y-2.5 pt-2">
              <label className={`block text-[13px] font-medium ${isLight ? 'text-[#1f2937]' : 'text-neutral-300'}`}>
                Headers (optional)
              </label>

              {customHeaders.length > 0 && (
                <div className="space-y-2">
                  {customHeaders.map((item, idx) => (
                    <div key={item.id} className="flex items-center gap-2.5">
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          setCustomHeaders((prev) =>
                            prev.map((h, i) => (i === idx ? { ...h, name: val } : h))
                          );
                        }}
                        placeholder="Header-Name"
                        className={`flex-1 px-3 py-2 border rounded-lg text-xs font-mono focus:outline-none transition-colors ${
                          isLight
                            ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                            : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                        }`}
                      />

                      <input
                        type="text"
                        value={item.value}
                        onChange={(e) => {
                          const val = e.target.value;
                          setCustomHeaders((prev) =>
                            prev.map((h, i) => (i === idx ? { ...h, value: val } : h))
                          );
                        }}
                        placeholder="value"
                        className={`flex-1 px-3 py-2 border rounded-lg text-xs font-mono focus:outline-none transition-colors ${
                          isLight
                            ? 'bg-white border-[#d8d8de] text-[#1f2937] placeholder-neutral-400 focus:border-[#e07a38]'
                            : 'bg-[#1b1a20] border-[#34333e] text-white placeholder-neutral-500 focus:border-[#e07a38]'
                        }`}
                      />

                      <button
                        type="button"
                        onClick={() =>
                          setCustomHeaders((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className={`p-2 transition-colors cursor-pointer ${
                          isLight ? 'text-neutral-400 hover:text-rose-600' : 'text-neutral-500 hover:text-rose-400'
                        }`}
                        title="Delete header"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add header button */}
              <button
                type="button"
                onClick={() =>
                  setCustomHeaders((prev) => [
                    ...prev,
                    { id: `h-${Date.now()}`, name: '', value: '' },
                  ])
                }
                className={`flex items-center gap-1.5 text-xs pt-1 transition-colors cursor-pointer ${
                  isLight ? 'text-[#4b5563] hover:text-black font-medium' : 'text-neutral-300 hover:text-white'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add header</span>
              </button>
            </div>

            {/* Field 7: Submit Button (Solid button matching theme) */}
            <div className="pt-4">
              <button
                type="submit"
                disabled={connecting}
                className={`px-5 py-2 rounded-lg font-semibold text-xs transition-colors cursor-pointer shadow-md ${
                  isLight
                    ? 'bg-[#09090b] text-white hover:bg-[#27272a]'
                    : 'bg-white text-black hover:bg-neutral-200'
                }`}
              >
                {connecting ? 'Validating…' : 'Validate and connect'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
};
