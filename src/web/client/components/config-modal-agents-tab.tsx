import type { Dispatch, SetStateAction } from 'react';
import { useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n } from '../i18n/index.js';
import type { AgentListItemView } from '../app-shell-types.js';
import type { AgentConfigDraft } from './config-modal-agent-draft.js';
import type { EditableProfile, ModelOption } from './config-modal-profile-draft.js';
import {
  ConfigFieldLabel,
  FIELD_CONTROL_CLASS_NAME,
  createFieldControlStyle,
} from './config-modal-field-primitives.js';

interface AgentConfigToggleCardProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}

function AgentConfigToggleCard({ checked, onChange, label, hint }: AgentConfigToggleCardProps) {
  const theme = useThemeConfig();
  return (
    <label
      className="flex items-start gap-3 rounded-xl border px-3 py-2 md:col-span-2"
      style={{
        backgroundColor: theme.colors.bg.tertiary,
        borderColor: theme.colors.border.DEFAULT,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <span>
        <span className="block text-sm" style={{ color: theme.colors.text.secondary }}>
          {label}
        </span>
        <span className="mt-1 block text-xs" style={{ color: theme.colors.text.muted }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

export interface ConfigModalAgentsTabProps {
  agentConfigLoading: boolean;
  agentItems: AgentListItemView[];
  selectedAgentItem: AgentListItemView | null;
  agentConfigDraft: AgentConfigDraft;
  agentConfigSaving: boolean;
  agentConfigError: string | null;
  profiles: EditableProfile[];
  agentModelOptions: ModelOption[];
  agentModelPlaceholder: string;
  agentModelOptionsOpen: boolean;
  setAgentModelOptionsOpen: Dispatch<SetStateAction<boolean>>;
  onSelectAgentName: (name: string) => void;
  onSaveAgentConfig: () => void | Promise<void>;
  onAgentDraftChange: (patch: Partial<AgentConfigDraft>) => void;
}

export function ConfigModalAgentsTab({
  agentConfigLoading,
  agentItems,
  selectedAgentItem,
  agentConfigDraft,
  agentConfigSaving,
  agentConfigError,
  profiles,
  agentModelOptions,
  agentModelPlaceholder,
  agentModelOptionsOpen,
  setAgentModelOptionsOpen,
  onSelectAgentName,
  onSaveAgentConfig,
  onAgentDraftChange,
}: ConfigModalAgentsTabProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const fieldControlStyle = createFieldControlStyle(theme);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div
        className="rounded-2xl border p-3"
        style={{
          borderColor: theme.colors.border.DEFAULT,
          backgroundColor: theme.colors.bg.primary,
        }}
      >
        <div className="mb-3 text-sm font-medium" style={{ color: theme.colors.text.primary }}>
          {t('config.agentConfig.listTitle')}
        </div>
        {agentConfigLoading ? (
          <div className="text-sm" style={{ color: theme.colors.text.muted }}>
            {t('config.agentConfig.loading')}
          </div>
        ) : agentItems.length === 0 ? (
          <div className="text-sm" style={{ color: theme.colors.text.muted }}>
            {t('config.agentConfig.empty')}
          </div>
        ) : (
          <div className="space-y-2">
            {agentItems.map((agent) => {
              const active = selectedAgentItem?.name === agent.name;
              const hasWarnings = (agent.config?.warnings ?? []).length > 0;
              return (
                <button
                  key={agent.name}
                  type="button"
                  onClick={() => onSelectAgentName(agent.name)}
                  className="w-full rounded-xl border px-3 py-2 text-left transition-colors"
                  style={{
                    borderColor: active ? theme.colors.primary.DEFAULT : theme.colors.border.DEFAULT,
                    backgroundColor: active ? theme.colors.bg.secondary : theme.colors.bg.tertiary,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium" style={{ color: theme.colors.text.primary }}>
                      {agent.name}
                    </span>
                    {hasWarnings && (
                      <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] text-white" style={{ backgroundColor: '#f59e0b' }}>
                        {t('config.agentConfig.warningBadge')}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs" style={{ color: theme.colors.text.muted }}>
                    {agent.description}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="rounded-2xl border p-3"
        style={{
          borderColor: theme.colors.border.DEFAULT,
          backgroundColor: theme.colors.bg.primary,
        }}
      >
        {selectedAgentItem ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="text-lg font-semibold" style={{ color: theme.colors.text.primary }}>
                  {selectedAgentItem.name}
                </div>
                <div className="mt-1 truncate text-xs" style={{ color: theme.colors.text.muted }} title={selectedAgentItem.path}>
                  {selectedAgentItem.path}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void onSaveAgentConfig()}
                disabled={agentConfigSaving || agentConfigLoading}
                className="h-10 shrink-0 whitespace-nowrap rounded-lg border px-3 text-sm transition-colors disabled:opacity-60"
                style={{
                  borderColor: theme.colors.primary.DEFAULT,
                  backgroundColor: theme.colors.primary.DEFAULT,
                  color: theme.colors.text.inverse,
                }}
              >
                {agentConfigSaving ? t('common.saving') : t('config.agentConfig.save')}
              </button>
            </div>

            {(selectedAgentItem.config?.warnings ?? []).length > 0 && (
              <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: '#f59e0b', color: '#f59e0b' }}>
                {(selectedAgentItem.config?.warnings ?? []).join('; ')}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <ConfigFieldLabel>{t('config.agentConfig.description')}</ConfigFieldLabel>
                <input
                  value={agentConfigDraft.description}
                  onChange={(event) => onAgentDraftChange({ description: event.target.value })}
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                />
              </div>
              <div>
                <ConfigFieldLabel>{t('config.agentConfig.llmProfile')}</ConfigFieldLabel>
                <select
                  value={agentConfigDraft.llmProfileId}
                  onChange={(event) =>
                    onAgentDraftChange({ llmProfileId: event.target.value, llmModel: '' })
                  }
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                >
                  <option value="">{t('config.agentConfig.inherit')}</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <ConfigFieldLabel>{t('config.agentConfig.model')}</ConfigFieldLabel>
                <div
                  className="relative"
                  onBlur={(event) => {
                    const nextTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
                    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                      setAgentModelOptionsOpen(false);
                    }
                  }}
                >
                  <input
                    value={agentConfigDraft.llmModel}
                    readOnly
                    onFocus={() => setAgentModelOptionsOpen(agentModelOptions.length > 0)}
                    placeholder={agentModelPlaceholder}
                    className="w-full rounded-xl border py-2 pl-3 pr-10 outline-none focus:ring-2"
                    style={fieldControlStyle}
                  />
                  <button
                    type="button"
                    data-testid="config-agent-model-toggle"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() =>
                      setAgentModelOptionsOpen((open) =>
                        agentModelOptions.length > 0 ? !open : false
                      )
                    }
                    disabled={agentModelOptions.length === 0}
                    className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-sm disabled:opacity-40"
                    style={{ color: theme.colors.text.secondary }}
                    aria-label={t('config.agentConfig.model')}
                  >
                    ▾
                  </button>
                  {agentModelOptionsOpen && agentModelOptions.length > 0 && (
                    <div
                      data-testid="config-agent-model-options"
                      className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border py-1 shadow-lg"
                      style={{
                        backgroundColor: theme.colors.bg.secondary,
                        borderColor: theme.colors.border.DEFAULT,
                      }}
                    >
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          onAgentDraftChange({ llmModel: '' });
                          setAgentModelOptionsOpen(false);
                        }}
                        className="w-full px-3 py-2 text-left text-sm"
                        style={{
                          backgroundColor:
                            agentConfigDraft.llmModel.trim().length === 0
                              ? theme.colors.bg.tertiary
                              : 'transparent',
                          color: theme.colors.text.primary,
                        }}
                      >
                        <span className="block truncate font-medium">{agentModelPlaceholder}</span>
                      </button>
                      {agentModelOptions.map((option) => {
                        const active = option.id === agentConfigDraft.llmModel;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              onAgentDraftChange({ llmModel: option.id });
                              setAgentModelOptionsOpen(false);
                            }}
                            className="w-full px-3 py-2 text-left text-sm"
                            style={{
                              backgroundColor: active ? theme.colors.bg.tertiary : 'transparent',
                              color: theme.colors.text.primary,
                            }}
                          >
                            <span className="block truncate font-medium">{option.id}</span>
                            {option.label !== option.id && (
                              <span className="block truncate text-xs" style={{ color: theme.colors.text.muted }}>
                                {option.label}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <ConfigFieldLabel>{t('config.agentConfig.reasoning')}</ConfigFieldLabel>
                <select
                  value={agentConfigDraft.reasoningPreset}
                  onChange={(event) =>
                    onAgentDraftChange({
                      reasoningPreset: event.target.value as AgentConfigDraft['reasoningPreset'],
                    })
                  }
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                >
                  <option value="">{t('config.agentConfig.inherit')}</option>
                  <option value="off">off</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
              </div>
              <AgentConfigToggleCard
                checked={agentConfigDraft.loadGlobalSkills}
                onChange={(value) => onAgentDraftChange({ loadGlobalSkills: value })}
                label={t('config.agentConfig.loadGlobalSkills')}
                hint={t('config.agentConfig.loadGlobalSkills.hint')}
              />
              <AgentConfigToggleCard
                checked={agentConfigDraft.exposeAsSubagent}
                onChange={(value) => onAgentDraftChange({ exposeAsSubagent: value })}
                label={t('config.agentConfig.exposeAsSubagent')}
                hint={t('config.agentConfig.exposeAsSubagent.hint')}
              />
              <div className="md:col-span-2">
                <ConfigFieldLabel>{t('config.agentConfig.promptAppend')}</ConfigFieldLabel>
                <textarea
                  value={agentConfigDraft.promptAppend}
                  onChange={(event) => onAgentDraftChange({ promptAppend: event.target.value })}
                  rows={5}
                  className={FIELD_CONTROL_CLASS_NAME}
                  style={fieldControlStyle}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm" style={{ color: theme.colors.text.muted }}>
            {t('config.agentConfig.empty')}
          </div>
        )}
        {agentConfigError && (
          <div className="mt-3 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: '#ef4444', color: '#ef4444' }}>
            {agentConfigError}
          </div>
        )}
      </div>
    </div>
  );
}
