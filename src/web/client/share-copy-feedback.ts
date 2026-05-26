interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

interface ToastInput {
  type: 'success' | 'error' | 'warning';
  message: string;
  autoDismiss: boolean;
}

type CopyShareUrlTranslationKey = 'app.share.copySucceeded' | 'app.share.copyFailed';

interface CopyShareUrlInput {
  url: string;
  clipboard?: ClipboardWriter | null;
  addToast: (toast: ToastInput) => unknown;
  t: (key: CopyShareUrlTranslationKey, params?: Record<string, string | number>) => string;
}

export async function copyShareUrlToClipboard(input: CopyShareUrlInput): Promise<boolean> {
  try {
    if (!input.clipboard?.writeText) {
      throw new Error('Clipboard API is not available');
    }
    await input.clipboard.writeText(input.url);
    input.addToast({
      type: 'success',
      message: input.t('app.share.copySucceeded'),
      autoDismiss: true,
    });
    return true;
  } catch (error) {
    input.addToast({
      type: 'error',
      message: input.t('app.share.copyFailed', {
        message: error instanceof Error ? error.message : String(error),
      }),
      autoDismiss: true,
    });
    return false;
  }
}
