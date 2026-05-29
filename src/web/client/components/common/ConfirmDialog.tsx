import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/index.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';

export interface ConfirmDialogRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'danger';
}

interface ConfirmDialogProps extends ConfirmDialogRequest {
  isOpen: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export type RequestConfirm = (request: ConfirmDialogRequest) => Promise<boolean>;

export function ConfirmDialog({
  isOpen,
  loading = false,
  title,
  body,
  confirmLabel,
  cancelLabel,
  variant = 'default',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();

  if (!isOpen) {
    return null;
  }

  const confirmColor = variant === 'danger' ? theme.colors.toolResult.error.text : theme.colors.primary.DEFAULT;
  const confirmBackground =
    variant === 'danger' ? theme.colors.toolResult.error.bg : `${theme.colors.primary.DEFAULT}18`;
  const confirmBorder =
    variant === 'danger' ? theme.colors.toolResult.error.border : theme.colors.primary.DEFAULT;

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 p-4" data-testid="confirm-dialog">
      <div
        className="w-[420px] max-w-full rounded-2xl border p-5 shadow-2xl"
        style={{
          backgroundColor: theme.colors.bg.secondary,
          borderColor: theme.colors.border.DEFAULT,
          color: theme.colors.text.primary,
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h3 id="confirm-dialog-title" className="text-base font-semibold leading-6">
          {title}
        </h3>
        <p className="mt-3 text-sm leading-6" style={{ color: theme.colors.text.secondary }}>
          {body}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl border px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: theme.colors.border.DEFAULT,
              backgroundColor: theme.colors.bg.tertiary,
              color: theme.colors.text.secondary,
            }}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-xl border px-4 py-2 text-sm font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              borderColor: confirmBorder,
              backgroundColor: confirmBackground,
              color: confirmColor,
            }}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function useConfirmDialog(): { requestConfirmation: RequestConfirm; dialog: JSX.Element | null } {
  const [request, setRequest] = useState<ConfirmDialogRequest | null>(null);
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null);

  const close = useCallback((confirmed: boolean) => {
    resolverRef.current?.(confirmed);
    resolverRef.current = null;
    setRequest(null);
  }, []);

  const requestConfirmation = useCallback<RequestConfirm>(
    (nextRequest) => {
      resolverRef.current?.(false);
      setRequest(nextRequest);
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
      });
    },
    []
  );

  const dialog = request ? (
    <ConfirmDialog
      isOpen
      {...request}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { requestConfirmation, dialog };
}
