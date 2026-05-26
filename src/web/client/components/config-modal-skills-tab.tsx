import { useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n } from '../i18n/index.js';
import {
  ConfigFieldLabel,
  FIELD_CONTROL_CLASS_NAME,
  createFieldControlStyle,
} from './config-modal-field-primitives.js';

export interface ConfigModalSkillsTabProps {
  skillsDir: string;
  setSkillsDir: (value: string) => void;
  globalAgentsDir: string;
  setGlobalAgentsDir: (value: string) => void;
  settingsControlsDisabled: boolean;
}

export function ConfigModalSkillsTab({
  skillsDir,
  setSkillsDir,
  globalAgentsDir,
  setGlobalAgentsDir,
  settingsControlsDisabled,
}: ConfigModalSkillsTabProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const fieldControlStyle = createFieldControlStyle(theme);

  return (
    <div className="space-y-4">
      <div>
        <ConfigFieldLabel>{t('config.skillsDir')}</ConfigFieldLabel>
        <input
          type="text"
          value={skillsDir}
          onChange={(event) => setSkillsDir(event.target.value)}
          placeholder={t('config.skillsDir.placeholder')}
          disabled={settingsControlsDisabled}
          className={FIELD_CONTROL_CLASS_NAME}
          style={fieldControlStyle}
        />
        <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
          {t('config.skillsDir.hint')}
        </p>
      </div>

      <div>
        <ConfigFieldLabel>{t('config.globalAgentsDir')}</ConfigFieldLabel>
        <input
          type="text"
          value={globalAgentsDir}
          onChange={(event) => setGlobalAgentsDir(event.target.value)}
          placeholder={t('config.globalAgentsDir.placeholder')}
          disabled={settingsControlsDisabled}
          className={FIELD_CONTROL_CLASS_NAME}
          style={fieldControlStyle}
        />
        <p className="mt-1 text-xs" style={{ color: theme.colors.text.muted }}>
          {t('config.globalAgentsDir.hint')}
        </p>
      </div>

      <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: theme.colors.bg.tertiary }}>
        <p style={{ color: theme.colors.text.secondary }}>{t('config.tips.title')}</p>
        <ul className="mt-1 space-y-1" style={{ color: theme.colors.text.muted }}>
          <li className="list-inside list-disc">{t('config.tips.item1')}</li>
          <li className="list-inside list-disc">{t('config.tips.item2')}</li>
          <li className="list-inside list-disc">{t('config.tips.item3')}</li>
          <li className="list-inside list-disc">{t('config.tips.item4')}</li>
        </ul>
      </div>
    </div>
  );
}
