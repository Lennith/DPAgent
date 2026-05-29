import { useI18n } from '../../i18n/index.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';
import { TodoPanel, type TodoPanelItem } from '../chat/TodoPanel.js';
import { SubAgentPanel } from '../subagent/SubAgentPanel.js';

interface RightToolbarProps {
  sessionId: string | null;
  todoItems: TodoPanelItem[];
  onHide: () => void;
  onResumeTodo?: (id: string) => void;
  onDismissTodo?: (id: string) => void;
  todoCleanupAvailable?: boolean;
  todoCleanupLoading?: boolean;
  onCleanupTodos?: () => void;
}

export function RightToolbar({
  sessionId,
  todoItems,
  onHide,
  onResumeTodo,
  onDismissTodo,
  todoCleanupAvailable = false,
  todoCleanupLoading = false,
  onCleanupTodos,
}: RightToolbarProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const openTodoItems = todoItems.filter((item) => item.status !== 'completed' && item.status !== 'dismissed');
  const hasTodoItems = openTodoItems.length > 0;
  const toolbarBackground = theme.colors.bg.gradient;
  const todoBackground =
    theme.name === 'light'
      ? `linear-gradient(180deg, ${theme.colors.bg.secondary}, ${theme.colors.bg.tertiary})`
      : theme.colors.bg.secondary;

  return (
    <div
      className="right-toolbar-content flex h-full min-h-0 flex-col overflow-hidden"
      style={{ background: toolbarBackground }}
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <SubAgentPanel sessionId={sessionId} onHide={onHide} title={t('toolbar.title')} />
      </div>
      {hasTodoItems && (
        <div
          className="right-toolbar-todo max-h-[42%] min-h-[132px] flex-none overflow-y-auto border-t p-3"
          data-testid="right-toolbar-todo"
          style={{
            borderColor: theme.colors.border.DEFAULT,
            background: todoBackground,
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: theme.colors.text.muted }}>
              {t('toolbar.todoSection')}
            </span>
            <div className="flex items-center gap-2">
              {todoCleanupAvailable && onCleanupTodos && (
                <button
                  type="button"
                  onClick={onCleanupTodos}
                  disabled={todoCleanupLoading}
                  className="rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
                  style={{
                    borderColor: theme.colors.toolResult.error.border,
                    color: theme.colors.toolResult.error.text,
                    backgroundColor: theme.colors.toolResult.error.bg,
                  }}
                  data-testid="todo-cleanup-button"
                >
                  {todoCleanupLoading ? t('todo.action.cleanupRunning') : t('todo.action.cleanup')}
                </button>
              )}
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: theme.colors.primary.DEFAULT, backgroundColor: `${theme.colors.primary.DEFAULT}14` }}>
                {t('todo.openCount', { count: openTodoItems.length })}
              </span>
            </div>
          </div>
          <TodoPanel
            items={openTodoItems}
            compact
            onResumeTodo={onResumeTodo}
            onDismissTodo={onDismissTodo}
          />
        </div>
      )}
    </div>
  );
}
