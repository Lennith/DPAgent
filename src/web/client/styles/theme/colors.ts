// 暖色调色板
export const warmColors = {
  // 主色调 - 暖橙色系
  primary: {
    50: '#fff7ed',
    100: '#ffedd5',
    200: '#fed7aa',
    300: '#fdba74',
    400: '#fb923c',
    500: '#f97316',
    600: '#ea580c',
    700: '#c2410c',
    800: '#9a3412',
    900: '#7c2d12',
  },
  // 辅助色 - 暖粉色
  secondary: {
    300: '#f9a8d4',
    400: '#f472b6',
    500: '#ec4899',
    600: '#db2777',
  },
  // 强调色 - 暖黄/珊瑚/琥珀
  accent: {
    yellow: '#fbbf24',
    amber: '#f59e0b',
    coral: '#f87171',
    rose: '#fb7185',
    salmon: '#fa8072',
  },
  // 功能色
  success: {
    light: '#4ade80',
    DEFAULT: '#22c55e',
    dark: '#16a34a',
  },
  error: {
    light: '#f87171',
    DEFAULT: '#ef4444',
    dark: '#dc2626',
  },
  warning: {
    light: '#fbbf24',
    DEFAULT: '#f59e0b',
    dark: '#d97706',
  },
  info: {
    light: '#60a5fa',
    DEFAULT: '#3b82f6',
    dark: '#2563eb',
  },
  // 中性色 - 暖调
  neutral: {
    50: '#fff7ed',
    100: '#ffedd5',
    200: '#e7e5e4',
    300: '#d6d3d1',
    400: '#a8a29e',
    500: '#78716c',
    600: '#57534e',
    700: '#44403c',
    800: '#292524',
    900: '#1c1917',
    950: '#0c0a09',
  },
} as const;

// 渐变定义
export const gradients = {
  // 主渐变
  primary: 'linear-gradient(135deg, #ea580c 0%, #f97316 100%)',
  primaryLight: 'linear-gradient(135deg, #f97316 0%, #fb923c 100%)',
  
  // Thinking 渐变
  thinking: {
    dark: 'linear-gradient(90deg, rgba(249,115,22,0.1) 0%, rgba(236,72,153,0.1) 100%)',
    light: 'linear-gradient(90deg, rgba(251,146,60,0.15) 0%, rgba(244,114,182,0.15) 100%)',
  },
  
  // Tool 渐变
  tool: {
    dark: 'linear-gradient(90deg, rgba(245,158,11,0.1) 0%, rgba(251,191,36,0.1) 100%)',
    light: 'linear-gradient(90deg, rgba(245,158,11,0.15) 0%, rgba(251,191,36,0.15) 100%)',
  },
  
  // 成功渐变
  success: {
    dark: 'linear-gradient(90deg, rgba(34,197,94,0.1) 0%, rgba(74,222,128,0.1) 100%)',
    light: 'linear-gradient(90deg, rgba(34,197,94,0.15) 0%, rgba(74,222,128,0.15) 100%)',
  },
  
  // 错误渐变
  error: {
    dark: 'linear-gradient(90deg, rgba(239,68,68,0.1) 0%, rgba(248,113,113,0.1) 100%)',
    light: 'linear-gradient(90deg, rgba(239,68,68,0.15) 0%, rgba(248,113,113,0.15) 100%)',
  },
  
  // 背景渐变
  background: {
    dark: 'linear-gradient(180deg, #1c1917 0%, #0c0a09 100%)',
    light: 'linear-gradient(180deg, #fff7ed 0%, #ffedd5 100%)',
  },
} as const;

export type Colors = typeof warmColors;
export type Gradients = typeof gradients;
