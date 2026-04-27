import React from 'react';
import { useThemeConfig } from '../providers/ThemeProvider.js';

interface LoadingSkeletonProps {
  /** Optional label to show beneath the skeleton */
  label?: string;
  /** Size variant */
  size?: 'small' | 'medium' | 'large';
  /** Whether to show pulsing animation */
  animate?: boolean;
}

export function LoadingSkeleton({ label, size = 'medium', animate = true }: LoadingSkeletonProps) {
  const theme = useThemeConfig();

  const sizeClasses = {
    small: 'h-3 w-3',
    medium: 'h-4 w-4',
    large: 'h-6 w-6',
  };

  const dotSize = sizeClasses[size];

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`
              ${dotSize} rounded-full
              ${animate ? 'animate-bounce' : ''}
            `}
            style={{
              backgroundColor: theme.colors.primary.DEFAULT,
              opacity: animate ? undefined : 0.5,
              animationDelay: `${i * 150}ms`,
            }}
          />
        ))}
      </div>
      {label && (
        <span
          className="text-xs"
          style={{ color: theme.colors.text.muted }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

/**
 * Full processing skeleton shown when agent is running but no content yet
 * REQ-0015/REQ-0018: Enhanced with phase labels and multi-stage progress
 */
export function ProcessingSkeleton({ 
  step, 
  maxSteps,
  phaseLabel,
  stages,
}: { 
  step?: number; 
  maxSteps?: number;
  /** Optional phase label like "Thinking", "Executing", "Summarizing" */
  phaseLabel?: string;
  /** Optional array of stage names for multi-phase progress */
  stages?: string[];
}) {
  const theme = useThemeConfig();

  // REQ-0018: Default phase labels based on step if not provided
  const defaultPhases = ['Thinking', 'Planning', 'Executing', 'Processing', 'Finalizing'];
  const displayPhase = phaseLabel || (typeof step === 'number' && step > 0 ? defaultPhases[Math.min(step - 1, defaultPhases.length - 1)] : 'Processing');

  // REQ-0018: Render multi-stage progress indicator
  const renderMultiStageProgress = () => {
    if (!stages || stages.length === 0) return null;

    return (
      <div className="flex flex-col items-center gap-2 mt-2">
        <div className="flex items-center gap-1">
          {stages.map((stage, index) => {
            const isActive = typeof step === 'number' && index === step - 1;
            const isCompleted = typeof step === 'number' && index < step - 1;
            
            return (
              <React.Fragment key={stage}>
                <div
                  className={`
                    w-2 h-2 rounded-full transition-all duration-300
                    ${isActive ? 'scale-125' : ''}
                  `}
                  style={{
                    backgroundColor: isCompleted 
                      ? theme.colors.primary.DEFAULT 
                      : isActive 
                        ? theme.colors.primary.DEFAULT 
                        : theme.colors.bg.tertiary,
                    opacity: isActive ? 1 : isCompleted ? 0.7 : 0.4,
                  }}
                  title={stage}
                />
                {index < stages.length - 1 && (
                  <div
                    className="w-4 h-0.5"
                    style={{
                      backgroundColor: isCompleted 
                        ? theme.colors.primary.DEFAULT 
                        : theme.colors.bg.tertiary,
                      opacity: isCompleted ? 0.7 : 0.3,
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
        <span className="text-xs" style={{ color: theme.colors.text.muted }}>
          {displayPhase}
        </span>
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center justify-center py-8 gap-4">
      <LoadingSkeleton label={displayPhase} />
      {typeof step === 'number' && typeof maxSteps === 'number' && maxSteps > 0 && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: theme.colors.text.muted }}>
              Step {step} of {maxSteps}
            </span>
            <div
              className="w-24 h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: theme.colors.bg.tertiary }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.min((step / maxSteps) * 100, 100)}%`,
                  backgroundColor: theme.colors.primary.DEFAULT,
                }}
              />
            </div>
          </div>
          {/* REQ-0018: Multi-stage progress dots */}
          {renderMultiStageProgress()}
        </div>
      )}
    </div>
  );
}
