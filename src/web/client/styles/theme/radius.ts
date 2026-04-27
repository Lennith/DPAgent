// 圆角配置 - 大圆角风格
export const radius = {
  none: '0',
  xs: '0.25rem',      // 4px
  sm: '0.5rem',       // 8px
  md: '0.75rem',      // 12px
  lg: '1rem',         // 16px
  xl: '1.25rem',      // 20px ⭐ 推荐默认
  '2xl': '1.5rem',    // 24px ⭐ 推荐大圆角
  '3xl': '2rem',      // 32px
  full: '9999px',     // 圆形/药丸
} as const;

// 圆角组合
export const radiusConfig = {
  // 消息气泡
  message: {
    user: radius['2xl'],      // 24px
    assistant: radius.xl,      // 20px
  },
  // 卡片
  card: {
    small: radius.lg,          // 16px
    medium: radius.xl,         // 20px
    large: radius['2xl'],      // 24px
  },
  // 输入框
  input: {
    default: radius.xl,        // 20px
    pill: radius.full,         // 药丸形
  },
  // 按钮
  button: {
    small: radius.lg,          // 16px
    medium: radius.xl,         // 20px
    large: radius['2xl'],      // 24px
    pill: radius.full,
  },
  // 侧边栏
  sidebar: {
    item: radius.lg,           // 16px
    button: radius.xl,         // 20px
  },
} as const;

export type Radius = typeof radius;
export type RadiusConfig = typeof radiusConfig;
