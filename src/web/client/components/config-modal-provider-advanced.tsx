import { useI18n } from '../i18n/index.js';
import { optionalPositiveIntegerOrUndefined } from './config-modal-settings-draft.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type EditableProfile,
} from './config-modal-profile-draft.js';
import {
  ConfigFieldLabel,
  FIELD_CONTROL_CLASS_NAME,
  createFieldControlStyle,
} from './config-modal-field-primitives.js';
import { useThemeConfig } from './providers/ThemeProvider.js';

interface ConfigModalProviderAdvancedProps {
  profile: EditableProfile;
  open: boolean;
  settingsControlsDisabled: boolean;
  ctxWindowTokens: number;
  onOpenChange: (open: boolean) => void;
  onProfileChange: (patch: Partial<EditableProfile>) => void;
}

export function ConfigModalProviderAdvanced({
  profile,
  open,
  settingsControlsDisabled,
  ctxWindowTokens,
  onOpenChange,
  onProfileChange,
}: ConfigModalProviderAdvancedProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const fieldControlStyle = createFieldControlStyle(theme);

  return (
    <details
      data-testid="config-provider-advanced"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      className="rounded-2xl border p-3"
      style={{
        borderColor: theme.colors.border.DEFAULT,
        backgroundColor: theme.colors.bg.secondary,
      }}
    >
      <summary
        className="cursor-pointer text-sm font-medium"
        style={{ color: theme.colors.text.secondary }}
      >
        {t('config.providerCenter.advancedParameters')}
      </summary>
      <div className="mt-3 max-w-md space-y-4">
        <ConfigFieldLabel>{t('config.providerCenter.outputLimit')}</ConfigFieldLabel>
        <input
          type="number"
          min={1}
          value={profile.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS}
          onChange={(event) =>
            onProfileChange({
              maxOutputTokens:
                Number.parseInt(event.target.value, 10) || DEFAULT_MAX_OUTPUT_TOKENS,
            })
          }
          disabled={settingsControlsDisabled}
          className={FIELD_CONTROL_CLASS_NAME}
          style={fieldControlStyle}
        />
        <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
          {t('config.providerCenter.outputLimitHint')}
        </p>
        <div>
          <ConfigFieldLabel>{t('config.providerCenter.contextWindowTokens')}</ConfigFieldLabel>
          <input
            type="number"
            min={1}
            value={profile.contextWindowTokens ?? ''}
            onChange={(event) =>
              onProfileChange({
                contextWindowTokens: optionalPositiveIntegerOrUndefined(
                  event.target.value.trim().length > 0
                    ? Number.parseInt(event.target.value, 10)
                    : undefined
                ),
              })
            }
            disabled={settingsControlsDisabled}
            placeholder={String(ctxWindowTokens)}
            className={FIELD_CONTROL_CLASS_NAME}
            style={fieldControlStyle}
          />
          <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
            {t('config.providerCenter.contextWindowTokensHint', {
              defaultValue: ctxWindowTokens,
            })}
          </p>
        </div>
      </div>
    </details>
  );
}
