import { warmColors, gradients } from './colors.js';
import { radius } from './radius.js';

export const lightTheme = {
  name: 'light' as const,
  colors: {
    bg: {
      primary: '#fff8f5',
      secondary: 'rgba(255, 255, 255, 0.88)',
      tertiary: '#fff1eb',
      gradient:
        'radial-gradient(circle at 16% 0%, rgba(239,68,68,0.13), transparent 30%), linear-gradient(180deg, #fffafa 0%, #fff1eb 100%)',
    },
    text: {
      primary: '#24120f',
      secondary: '#5f3932',
      muted: '#9b6a60',
      inverse: '#fffafa',
    },
    border: {
      DEFAULT: 'rgba(185, 68, 55, 0.16)',
      hover: 'rgba(220, 38, 38, 0.34)',
      focus: warmColors.error.DEFAULT,
    },
    primary: {
      DEFAULT: warmColors.error.DEFAULT,
      hover: warmColors.error.dark,
      active: '#b91c1c',
      gradient: 'linear-gradient(135deg, #dc2626 0%, #f97316 100%)',
    },
    thinking: {
      bg: 'linear-gradient(90deg, rgba(239,68,68,0.1) 0%, rgba(249,115,22,0.12) 100%)',
      border: 'rgba(239, 68, 68, 0.32)',
      icon: warmColors.error.DEFAULT,
      text: '#b91c1c',
    },
    toolCall: {
      bg: gradients.tool.light,
      border: `${warmColors.accent.amber}66`,
      icon: warmColors.accent.amber,
      text: warmColors.accent.amber,
    },
    toolResult: {
      success: {
        bg: gradients.success.light,
        border: `${warmColors.success.dark}66`,
        icon: warmColors.success.dark,
        text: warmColors.success.dark,
      },
      error: {
        bg: gradients.error.light,
        border: `${warmColors.error.dark}66`,
        icon: warmColors.error.dark,
        text: warmColors.error.dark,
      },
    },
    userMessage: {
      bg: 'linear-gradient(135deg, #dc2626 0%, #f97316 100%)',
      text: '#fffafa',
      shadow: '0 12px 26px rgba(220, 38, 38, 0.22)',
    },
    assistantMessage: {
      bg: 'rgba(255, 255, 255, 0.92)',
      border: 'rgba(185, 68, 55, 0.14)',
      text: '#24120f',
    },
    input: {
      bg: 'rgba(255, 255, 255, 0.86)',
      border: 'rgba(185, 68, 55, 0.18)',
      focusBorder: warmColors.error.DEFAULT,
      focusShadow: '0 0 0 4px rgba(239, 68, 68, 0.12), 0 16px 38px rgba(185, 68, 55, 0.1)',
      placeholder: '#b58a82',
    },
    sidebar: {
      bg: 'rgba(255, 255, 255, 0.78)',
      itemHover: '#fff1eb',
      itemActive: 'rgba(239, 68, 68, 0.12)',
    },
  },
  radius,
  shadows: {
    sm: '0 2px 6px rgba(185, 68, 55, 0.06)',
    DEFAULT: '0 12px 28px rgba(185, 68, 55, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.74)',
    md: '0 18px 36px rgba(185, 68, 55, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.76)',
    lg: '0 24px 54px rgba(185, 68, 55, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.78)',
    xl: '0 34px 70px rgba(185, 68, 55, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.82)',
    glow: '0 0 24px rgba(239, 68, 68, 0.16)',
    glowStrong: '0 0 34px rgba(239, 68, 68, 0.28)',
  },
} as const;

export type LightTheme = typeof lightTheme;
