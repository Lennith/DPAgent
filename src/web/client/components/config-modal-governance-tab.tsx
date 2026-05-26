import type { ReactNode } from 'react';
import { useThemeConfig } from './providers/ThemeProvider.js';
import { useI18n } from '../i18n/index.js';

export interface ConfigModalGovernanceTabProps {
  governanceSlot?: ReactNode;
}

export function ConfigModalGovernanceTab({ governanceSlot }: ConfigModalGovernanceTabProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      {governanceSlot ?? (
        <div
          className="rounded-2xl border p-4 text-sm"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            backgroundColor: theme.colors.bg.secondary,
            color: theme.colors.text.muted,
          }}
        >
          {t('config.governance.empty')}
        </div>
      )}
    </div>
  );
}
