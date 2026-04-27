import { warmColors, gradients } from './colors.js';
import { radius } from './radius.js';

export const darkTheme = {
  name: 'dark' as const,
  colors: {
    bg: {
      primary: '#0b0908',
      secondary: 'rgba(28, 25, 23, 0.76)',
      tertiary: 'rgba(41, 37, 36, 0.86)',
      gradient:
        'radial-gradient(circle at 18% 0%, rgba(249,115,22,0.16), transparent 32%), linear-gradient(180deg, #1b1512 0%, #080706 100%)',
    },
    text: {
      primary: warmColors.neutral[50],
      secondary: warmColors.neutral[200],
      muted: warmColors.neutral[400],
      inverse: warmColors.neutral[950],
    },
    border: {
      DEFAULT: 'rgba(214, 211, 209, 0.16)',
      hover: 'rgba(251, 146, 60, 0.34)',
      focus: warmColors.primary[500],
    },
    primary: {
      DEFAULT: warmColors.primary[500],
      hover: warmColors.primary[400],
      active: warmColors.primary[600],
      gradient: gradients.primary,
    },
    thinking: {
      bg: gradients.thinking.dark,
      border: `${warmColors.primary[500]}33`,
      icon: warmColors.primary[400],
      text: warmColors.primary[300],
    },
    toolCall: {
      bg: gradients.tool.dark,
      border: `${warmColors.accent.amber}33`,
      icon: warmColors.accent.amber,
      text: warmColors.accent.yellow,
    },
    toolResult: {
      success: {
        bg: gradients.success.dark,
        border: `${warmColors.success.DEFAULT}33`,
        icon: warmColors.success.light,
        text: warmColors.success.DEFAULT,
      },
      error: {
        bg: gradients.error.dark,
        border: `${warmColors.error.DEFAULT}33`,
        icon: warmColors.error.light,
        text: warmColors.error.DEFAULT,
      },
    },
    userMessage: {
      bg: gradients.primary,
      text: warmColors.neutral[50],
      shadow: '0 10px 28px rgba(249, 115, 22, 0.26)',
    },
    assistantMessage: {
      bg: 'rgba(28, 25, 23, 0.72)',
      border: 'rgba(214, 211, 209, 0.14)',
      text: warmColors.neutral[50],
    },
    input: {
      bg: 'rgba(41, 37, 36, 0.78)',
      border: 'rgba(214, 211, 209, 0.16)',
      focusBorder: warmColors.primary[500],
      focusShadow: '0 0 24px rgba(249, 115, 22, 0.22)',
      placeholder: warmColors.neutral[500],
    },
    sidebar: {
      bg: 'rgba(28, 25, 23, 0.78)',
      itemHover: 'rgba(41, 37, 36, 0.86)',
      itemActive: `${warmColors.primary[500]}20`,
    },
  },
  radius,
  shadows: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
    DEFAULT: '0 10px 28px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
    md: '0 16px 34px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    lg: '0 24px 52px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    xl: '0 34px 70px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.06)',
    glow: '0 0 28px rgba(249, 115, 22, 0.22)',
    glowStrong: '0 0 42px rgba(249, 115, 22, 0.42)',
  },
} as const;

export type DarkTheme = typeof darkTheme;
