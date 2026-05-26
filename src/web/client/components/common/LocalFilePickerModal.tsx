import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n/index.js';
import {
  fetchLocalDirectory,
  fetchLocalFileRoots,
  type LocalFileBrowserEntryView,
  type LocalFileBrowserRootView,
} from '../../local-file-browser-api.js';
import { useThemeConfig } from '../providers/ThemeProvider.js';

export interface LocalFilePickerModalProps {
  isOpen: boolean;
  mode: 'directory' | 'file';
  title: string;
  confirmLabel: string;
  initialPath?: string;
  selectedPaths?: string[];
  onConfirm: (paths: string[]) => void;
  onClose: () => void;
}

const LOCAL_FILE_PICKER_LAYOUT_CLASSES = {
  modal:
    'flex h-[620px] w-[760px] max-h-[88vh] max-w-[94vw] flex-col rounded-2xl border p-4 shadow-2xl max-[520px]:p-3',
  contentGrid:
    'grid min-h-0 flex-1 grid-cols-[180px_minmax(0,1fr)] gap-3 max-[520px]:grid-cols-[92px_minmax(0,1fr)] max-[520px]:gap-2',
  rootsPane: 'min-h-0 overflow-y-auto rounded-xl border p-2 max-[520px]:p-1.5',
  rootButton: 'mb-1 block w-full truncate rounded-lg px-2 py-2 text-left text-xs max-[520px]:px-1.5',
  filesPane: 'min-h-0 min-w-0 overflow-hidden rounded-xl border',
  entryButton:
    'mb-1 grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-2 text-left text-xs max-[520px]:grid-cols-[20px_minmax(0,1fr)] max-[520px]:gap-1.5 max-[520px]:px-1.5',
  entryType: 'text-[10px] max-[520px]:hidden',
} as const;

function pathKey(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) ? value.toLowerCase() : value;
}

export function LocalFilePickerModal({
  isOpen,
  mode,
  title,
  confirmLabel,
  initialPath,
  selectedPaths = [],
  onConfirm,
  onClose,
}: LocalFilePickerModalProps) {
  const theme = useThemeConfig();
  const { t } = useI18n();
  const [roots, setRoots] = useState<LocalFileBrowserRootView[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<LocalFileBrowserEntryView[]>([]);
  const [selected, setSelected] = useState<string[]>(selectedPaths);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedKeys = useMemo(() => new Set(selected.map(pathKey)), [selected]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setSelected(selectedPaths);
    setError(null);
    void fetchLocalFileRoots()
      .then((nextRoots) => {
        setRoots(nextRoots);
        const initial = String(initialPath ?? '').trim() || nextRoots[0]?.path || '';
        if (initial) {
          void openDirectory(initial);
        }
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const openDirectory = async (path: string): Promise<void> => {
    const normalized = String(path ?? '').trim();
    if (!normalized) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchLocalDirectory(normalized);
      setCurrentPath(result.path);
      setParentPath(result.parentPath);
      setEntries(result.entries);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  };

  const toggleFile = (entry: LocalFileBrowserEntryView): void => {
    if (entry.type !== 'file') {
      void openDirectory(entry.path);
      return;
    }
    if (mode !== 'file') {
      return;
    }
    setSelected((prev) => {
      const key = pathKey(entry.path);
      if (prev.some((item) => pathKey(item) === key)) {
        return prev.filter((item) => pathKey(item) !== key);
      }
      return [...prev, entry.path];
    });
  };

  if (!isOpen) {
    return null;
  }

  const canConfirm = mode === 'directory' ? Boolean(currentPath) : selected.length > 0;

  const modal = (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55">
      <div
        className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.modal}
        style={{ backgroundColor: theme.colors.bg.secondary, borderColor: theme.colors.border.DEFAULT }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold" style={{ color: theme.colors.text.primary }}>{title}</h3>
            <p className="mt-1 max-w-[620px] truncate text-xs" style={{ color: theme.colors.text.muted }}>
              {currentPath || t('localFilePicker.chooseRoot')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border px-3 py-1.5 text-sm"
            style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
          >
            {t('common.close')}
          </button>
        </div>

        <div className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.contentGrid}>
          <div className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.rootsPane} style={{ borderColor: theme.colors.border.DEFAULT }}>
            {roots.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => void openDirectory(root.path)}
                className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.rootButton}
                style={{
                  backgroundColor: pathKey(root.path) === pathKey(currentPath) ? `${theme.colors.primary.DEFAULT}22` : 'transparent',
                  color: theme.colors.text.secondary,
                }}
                title={root.path}
              >
                {root.label}
              </button>
            ))}
          </div>

          <div className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.filesPane} style={{ borderColor: theme.colors.border.DEFAULT }}>
            <div className="flex items-center gap-2 border-b p-2" style={{ borderColor: theme.colors.border.DEFAULT }}>
              <button
                type="button"
                disabled={!parentPath}
                onClick={() => parentPath && void openDirectory(parentPath)}
                className="rounded-lg border px-2 py-1 text-xs disabled:opacity-40"
                style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
              >
                {t('localFilePicker.up')}
              </button>
              {loading && <span className="text-xs" style={{ color: theme.colors.text.muted }}>{t('common.loading')}</span>}
              {error && <span className="truncate text-xs text-red-400">{error}</span>}
            </div>
            <div className="h-full overflow-y-auto p-2 pb-14">
              {entries.map((entry) => {
                const isSelected = selectedKeys.has(pathKey(entry.path));
                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => toggleFile(entry)}
                    className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.entryButton}
                    style={{
                      backgroundColor: isSelected ? `${theme.colors.primary.DEFAULT}22` : 'transparent',
                      color: theme.colors.text.secondary,
                    }}
                    title={entry.path}
                  >
                    <span>{entry.type === 'directory' ? 'DIR' : isSelected ? 'OK' : 'FILE'}</span>
                    <span className="truncate">{entry.name}</span>
                    <span className={LOCAL_FILE_PICKER_LAYOUT_CLASSES.entryType} style={{ color: theme.colors.text.muted }}>{entry.type}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {mode === 'file' && selected.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {selected.map((path) => (
              <span
                key={path}
                className="max-w-full truncate rounded-full border px-2 py-0.5 text-[11px]"
                style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
                title={path}
              >
                {path}
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border px-4 py-2 text-sm"
            style={{ borderColor: theme.colors.border.DEFAULT, color: theme.colors.text.secondary }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(mode === 'directory' ? [currentPath] : selected)}
            className="rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: theme.colors.primary.gradient, color: theme.colors.text.inverse }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
