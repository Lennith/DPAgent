import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'default' | 'secondary' | 'tertiary' | 'gradient';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  radius?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  shadow?: boolean;
  hover?: boolean;
}

export function Card({
  children,
  className = '',
  variant = 'default',
  padding = 'md',
  radius = 'xl',
  shadow = true,
  hover = false,
}: CardProps) {
  const theme = useThemeConfig();

  const variantClasses = {
    default: '',
    secondary: '',
    tertiary: 'border',
    gradient: '',
  };

  const variantStyleMap: Record<NonNullable<CardProps['variant']>, React.CSSProperties> = {
    default: {
      backgroundColor: theme.colors.bg.secondary,
    },
    secondary: {
      backgroundColor: theme.colors.bg.tertiary,
    },
    tertiary: {
      backgroundColor: theme.colors.bg.primary,
      borderColor: theme.colors.border.DEFAULT,
    },
    gradient: {
      backgroundImage: `linear-gradient(135deg, ${theme.colors.bg.secondary}, ${theme.colors.bg.tertiary})`,
    },
  };

  const paddingStyles = {
    none: 'p-0',
    sm: 'p-3',
    md: 'p-4',
    lg: 'p-6',
  };

  const radiusStyles = {
    sm: 'rounded-lg',
    md: 'rounded-xl',
    lg: 'rounded-2xl',
    xl: 'rounded-3xl',
    '2xl': 'rounded-[2rem]',
  };

  return (
    <div
      className={`
        ${variantClasses[variant]}
        ${paddingStyles[padding]}
        ${radiusStyles[radius]}
        ${shadow ? `shadow-lg` : ''}
        ${hover ? 'transition-all duration-300 hover:-translate-y-1 hover:shadow-xl cursor-pointer' : ''}
        ${className}
      `}
      style={variantStyleMap[variant]}
    >
      {children}
    </div>
  );
}

// 功能块卡片 - 用于 Thinking/Tool
interface FeatureCardProps {
  children: React.ReactNode;
  icon: string;
  title: string;
  color: 'orange' | 'amber' | 'green' | 'red' | 'blue';
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export function FeatureCard({
  children,
  icon,
  title,
  color,
  collapsible = false,
  defaultOpen = true,
}: FeatureCardProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);
  const theme = useThemeConfig();

  const colorStyles = {
    orange: {
      bg: 'bg-gradient-to-r from-orange-500/10 to-pink-500/10',
      border: 'border-orange-500/30',
      icon: 'text-orange-500',
    },
    amber: {
      bg: 'bg-gradient-to-r from-amber-500/10 to-yellow-500/10',
      border: 'border-amber-500/30',
      icon: 'text-amber-500',
    },
    green: {
      bg: 'bg-gradient-to-r from-green-500/10 to-emerald-500/10',
      border: 'border-green-500/30',
      icon: 'text-green-500',
    },
    red: {
      bg: 'bg-gradient-to-r from-red-500/10 to-rose-500/10',
      border: 'border-red-500/30',
      icon: 'text-red-500',
    },
    blue: {
      bg: 'bg-gradient-to-r from-blue-500/10 to-cyan-500/10',
      border: 'border-blue-500/30',
      icon: 'text-blue-500',
    },
  };

  const styles = colorStyles[color];

  return (
    <div
      className={`
        ${styles.bg} ${styles.border}
        rounded-2xl border overflow-hidden
        transition-all duration-300
      `}
    >
      {/* 标题栏 */}
      <div
        className={`
          flex items-center gap-2 px-4 py-3
          ${collapsible ? 'cursor-pointer hover:bg-black/5' : ''}
        `}
        onClick={collapsible ? () => setIsOpen(!isOpen) : undefined}
      >
        <span className={`text-lg ${styles.icon}`}>{icon}</span>
        <span className={`font-medium ${styles.icon}`}>{title}</span>
        {collapsible && (
          <svg
            className={`
              ml-auto w-4 h-4 transition-transform duration-300
              ${isOpen ? 'rotate-180' : ''}
              ${styles.icon}
            `}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </div>
      
      {/* 内容 */}
      <div
        className={`
          overflow-hidden transition-all duration-300
          ${isOpen ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'}
        `}
      >
        <div className="px-4 pb-4">
          {children}
        </div>
      </div>
    </div>
  );
}
