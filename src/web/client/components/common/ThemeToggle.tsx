import React from 'react';
import { useTheme } from '../providers/ThemeProvider.js';

export function ThemeToggle() {
  const { theme, toggleTheme, isDark } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className={`
        relative flex items-center gap-2 px-3 py-2 rounded-xl
        transition-all duration-300 ease-out
        hover:scale-105 active:scale-95
        ${isDark 
          ? 'bg-gradient-to-r from-orange-500/20 to-amber-500/20 border border-orange-500/30 hover:border-orange-500/50' 
          : 'bg-gradient-to-r from-orange-100 to-amber-100 border border-orange-300 hover:border-orange-400'
        }
      `}
      title={isDark ? '切换到浅色模式' : '切换到深色模式'}
    >
      {/* 图标容器 */}
      <div className="relative w-5 h-5">
        {/* 太阳图标 - 浅色模式显示 */}
        <svg
          className={`
            absolute inset-0 w-5 h-5 transition-all duration-300
            ${isDark ? 'opacity-0 rotate-90 scale-0' : 'opacity-100 rotate-0 scale-100'}
            text-orange-600
          `}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="12" cy="12" r="5" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
        
        {/* 月亮图标 - 深色模式显示 */}
        <svg
          className={`
            absolute inset-0 w-5 h-5 transition-all duration-300
            ${isDark ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-0'}
            text-orange-400
          `}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </div>
      
      {/* 文字标签 */}
      <span className={`text-sm font-medium ${isDark ? 'text-orange-300' : 'text-orange-700'}`}>
        {isDark ? '深色' : '浅色'}
      </span>
    </button>
  );
}

// 简化版 - 只有图标
export function ThemeToggleIcon() {
  const { toggleTheme, isDark } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className={`
        p-2 rounded-full transition-all duration-300
        hover:scale-110 active:scale-95
        ${isDark 
          ? 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30' 
          : 'bg-orange-100 text-orange-600 hover:bg-orange-200'
        }
      `}
      title={isDark ? '切换到浅色模式' : '切换到深色模式'}
    >
      {isDark ? (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="5" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      )}
    </button>
  );
}
