import type { ReactNode } from 'react';
import { useThemeConfig } from './providers/ThemeProvider.js';

export const FIELD_CONTROL_CLASS_NAME = 'w-full rounded-xl border px-3 py-2 outline-none focus:ring-2';

export function createFieldControlStyle(theme: ReturnType<typeof useThemeConfig>) {
  return {
    backgroundColor: theme.colors.bg.tertiary,
    borderColor: theme.colors.border.DEFAULT,
    color: theme.colors.text.primary,
  };
}

export function ConfigFieldLabel({ children }: { children: ReactNode }) {
  const theme = useThemeConfig();
  return (
    <label className="mb-1 block text-sm" style={{ color: theme.colors.text.secondary }}>
      {children}
    </label>
  );
}
