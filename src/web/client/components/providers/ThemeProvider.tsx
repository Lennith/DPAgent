import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  type Theme,
  type ThemeConfig,
  generateCSSVariables,
  getInitialTheme,
  getTheme,
  keyframes,
  saveTheme,
} from '../../styles/theme/index.js';

interface ThemeContextType {
  theme: Theme;
  themeConfig: ThemeConfig;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    saveTheme(theme);
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
  }, []);

  const themeConfig = useMemo(() => getTheme(theme), [theme]);
  const isDark = theme === 'dark';

  const value = useMemo(
    () => ({
      theme,
      themeConfig,
      toggleTheme,
      setTheme,
      isDark,
    }),
    [isDark, setTheme, theme, themeConfig, toggleTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      <style>{`
        ${keyframes}

        :root {
          ${generateCSSVariables(themeConfig)}
          --app-chrome-header-height: 112px;
          --sidebar-expanded-width: 288px;
          --sidebar-rail-width: 76px;
          --toolbar-width: clamp(320px, 24vw, 420px);
          --chat-readable-max: 1180px;
          --composer-min-touch: 44px;
          --transition-theme: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
        }

        @media (max-width: 1279px), (max-aspect-ratio: 11/10) {
          :root {
            --app-chrome-header-height: 104px;
            --chat-readable-max: 100%;
          }
        }

        @media (max-width: 720px) {
          :root {
            --sidebar-rail-width: 64px;
          }
        }

        * {
          transition: var(--transition-theme);
        }

        html,
        body {
          background: ${themeConfig.colors.bg.primary};
          color: ${themeConfig.colors.text.primary};
        }

        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }

        ::-webkit-scrollbar-track {
          background: ${themeConfig.colors.bg.secondary};
          border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb {
          background: ${themeConfig.colors.border.DEFAULT};
          border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: ${themeConfig.colors.border.hover};
        }
      `}</style>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeConfig(): ThemeConfig {
  return useTheme().themeConfig;
}
