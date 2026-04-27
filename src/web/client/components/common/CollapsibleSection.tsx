import React, { useState, useCallback } from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface CollapsibleSectionProps {
  /** Section title */
  title: string;
  /** Optional badge count or status indicator */
  badge?: string | number;
  /** Badge color variant */
  badgeVariant?: 'default' | 'primary' | 'warning' | 'error' | 'success';
  /** Initial collapsed state */
  defaultCollapsed?: boolean;
  /** Whether to show collapse toggle */
  collapsible?: boolean;
  /** Child content */
  children: React.ReactNode;
  /** Optional className for container */
  className?: string;
}

/**
 * REQ-0010: Collapsible section component for visual hierarchy
 * Allows grouping related content and reducing visual density
 */
export function CollapsibleSection({
  title,
  badge,
  badgeVariant = 'default',
  defaultCollapsed = false,
  collapsible = true,
  children,
  className = '',
}: CollapsibleSectionProps) {
  const theme = useThemeConfig();
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const toggleCollapse = useCallback(() => {
    if (collapsible) {
      setIsCollapsed((prev) => !prev);
    }
  }, [collapsible]);

  const badgeColors: Record<string, { bg: string; text: string }> = {
    default: {
      bg: theme.colors.bg.tertiary,
      text: theme.colors.text.muted,
    },
    primary: {
      bg: `${theme.colors.primary.DEFAULT}20`,
      text: theme.colors.primary.DEFAULT,
    },
    warning: {
      bg: 'rgba(234, 179, 8, 0.15)',
      text: '#f59e0b',
    },
    error: {
      bg: 'rgba(239, 68, 68, 0.15)',
      text: '#ef4444',
    },
    success: {
      bg: 'rgba(34, 197, 94, 0.15)',
      text: '#22c55e',
    },
  };

  const currentBadgeColor = badgeColors[badgeVariant] || badgeColors.default;

  return (
    <div
      className={`rounded-xl border overflow-hidden ${className}`}
      style={{
        backgroundColor: theme.colors.bg.secondary,
        borderColor: theme.colors.border.DEFAULT,
      }}
    >
      {/* Section Header */}
      <button
        type="button"
        onClick={toggleCollapse}
        disabled={!collapsible}
        className={`w-full flex items-center justify-between px-4 py-3 transition-colors ${
          collapsible ? 'hover:bg-opacity-80 cursor-pointer' : 'cursor-default'
        }`}
        style={{
          backgroundColor: isCollapsed ? theme.colors.bg.secondary : `${theme.colors.bg.tertiary}`,
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-medium"
            style={{ color: theme.colors.text.primary }}
          >
            {title}
          </span>
          {badge !== undefined && (
            <span
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: currentBadgeColor.bg,
                color: currentBadgeColor.text,
              }}
            >
              {badge}
            </span>
          )}
        </div>
        {collapsible && (
          <span
            className={`text-xs transition-transform duration-200 ${isCollapsed ? 'rotate-0' : 'rotate-180'}`}
            style={{ color: theme.colors.text.muted }}
          >
            ▼
          </span>
        )}
      </button>

      {/* Section Content */}
      <div
        className="transition-all duration-200 ease-in-out"
        style={{
          maxHeight: isCollapsed ? 0 : '10000px',
          opacity: isCollapsed ? 0 : 1,
          overflow: isCollapsed ? 'hidden' : 'auto',
        }}
      >
        <div className="p-4 border-t" style={{ borderColor: theme.colors.border.DEFAULT }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * PriorityBadge: Visual weight hierarchy indicator
 * REQ-0010: Color-coded priority levels
 */
export function PriorityBadge({ priority }: { priority: 'blocker' | 'high' | 'medium' | 'low' }) {
  const priorityConfig: Record<string, { bg: string; text: string; label: string }> = {
    blocker: {
      bg: 'rgba(239, 68, 68, 0.15)',
      text: '#ef4444',
      label: 'BLOCKER',
    },
    high: {
      bg: 'rgba(249, 115, 22, 0.15)',
      text: '#f97316',
      label: 'HIGH',
    },
    medium: {
      bg: 'rgba(234, 179, 8, 0.15)',
      text: '#eab308',
      label: 'MEDIUM',
    },
    low: {
      bg: 'rgba(156, 163, 175, 0.15)',
      text: '#9ca3af',
      label: 'LOW',
    },
  };

  const config = priorityConfig[priority] || priorityConfig.medium;

  return (
    <span
      className="px-2 py-0.5 rounded text-[10px] font-bold tracking-wider"
      style={{
        backgroundColor: config.bg,
        color: config.text,
      }}
    >
      {config.label}
    </span>
  );
}
