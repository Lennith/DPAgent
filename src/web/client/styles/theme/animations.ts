// 动画配置
export const durations = {
  fast: '0.15s',
  normal: '0.3s',
  slow: '0.5s',
} as const;

export const easings = {
  default: 'ease',
  smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
  bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
} as const;

// CSS 动画关键帧
export const keyframes = `
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes slideInRight {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes thinkingPulse {
  0%, 100% {
    transform: scale(1);
    opacity: 0.7;
  }
  50% {
    transform: scale(1.05);
    opacity: 1;
  }
}

@keyframes shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

@keyframes bounce {
  0%, 100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes glow {
  0%, 100% {
    box-shadow: 0 0 5px rgba(249, 115, 22, 0.3);
  }
  50% {
    box-shadow: 0 0 20px rgba(249, 115, 22, 0.6);
  }
}
`;

// 动画类
export const animations = {
  fadeIn: {
    animation: `fadeIn ${durations.normal} ${easings.smooth}`,
  },
  fadeInUp: {
    animation: `fadeInUp ${durations.normal} ${easings.smooth}`,
  },
  slideInRight: {
    animation: `slideInRight ${durations.normal} ${easings.smooth}`,
  },
  pulse: {
    animation: `pulse 2s ${easings.default} infinite`,
  },
  thinkingPulse: {
    animation: `thinkingPulse 2s ${easings.default} infinite`,
  },
  shimmer: {
    animation: `shimmer 2s linear infinite`,
    background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent)',
    backgroundSize: '200% 100%',
  },
  bounce: {
    animation: `bounce 1s ${easings.default} infinite`,
  },
  spin: {
    animation: `spin 1s linear infinite`,
  },
  glow: {
    animation: `glow 2s ${easings.default} infinite`,
  },
} as const;

// 过渡效果
export const transitions = {
  default: `all ${durations.normal} ${easings.smooth}`,
  fast: `all ${durations.fast} ${easings.smooth}`,
  slow: `all ${durations.slow} ${easings.smooth}`,
  transform: `transform ${durations.normal} ${easings.spring}`,
  opacity: `opacity ${durations.normal} ${easings.smooth}`,
  colors: `background-color ${durations.normal} ${easings.smooth}, color ${durations.normal} ${easings.smooth}, border-color ${durations.normal} ${easings.smooth}`,
} as const;

export type Durations = typeof durations;
export type Easings = typeof easings;
export type Animations = typeof animations;
export type Transitions = typeof transitions;
