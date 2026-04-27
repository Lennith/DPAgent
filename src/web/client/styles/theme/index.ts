import { darkTheme } from './dark.js';
import { lightTheme } from './light.js';
import { warmColors, gradients } from './colors.js';
import { radius, radiusConfig } from './radius.js';
import { animations, transitions, keyframes, durations, easings } from './animations.js';

export type Theme = 'dark' | 'light';

export const themes = {
  dark: darkTheme,
  light: lightTheme,
} as const;

export type ThemeType = typeof themes;
export type ThemeConfig = typeof darkTheme | typeof lightTheme;

// 获取主题配置
export function getTheme(theme: Theme): ThemeConfig {
  return themes[theme];
}

// 检测系统主题偏好
export function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// 本地存储键
export const THEME_STORAGE_KEY = 'minimax-agent-theme';

// 获取初始主题
export function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  
  const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
  if (stored && (stored === 'dark' || stored === 'light')) {
    return stored;
  }
  
  return getSystemTheme();
}

// 保存主题
export function saveTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

export {
  darkTheme,
  lightTheme,
  warmColors,
  gradients,
  radius,
  radiusConfig,
  animations,
  transitions,
  keyframes,
  durations,
  easings,
};

// CSS 变量生成器
export function generateCSSVariables(theme: ThemeConfig): string {
  return `
    --bg-primary: ${theme.colors.bg.primary};
    --bg-secondary: ${theme.colors.bg.secondary};
    --bg-tertiary: ${theme.colors.bg.tertiary};
    
    --text-primary: ${theme.colors.text.primary};
    --text-secondary: ${theme.colors.text.secondary};
    --text-muted: ${theme.colors.text.muted};
    
    --border-default: ${theme.colors.border.DEFAULT};
    --border-hover: ${theme.colors.border.hover};
    --border-focus: ${theme.colors.border.focus};
    
    --primary-default: ${theme.colors.primary.DEFAULT};
    --primary-hover: ${theme.colors.primary.hover};
    
    --radius-sm: ${theme.radius.sm};
    --radius-md: ${theme.radius.md};
    --radius-lg: ${theme.radius.lg};
    --radius-xl: ${theme.radius.xl};
    --radius-2xl: ${theme.radius['2xl']};
  `;
}
