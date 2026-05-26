import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildDroppedPathInsertion } from './dragPathUtils.js';
import { hasFileLikeDragData } from './composer-drop-detection.js';
import { uploadDroppedSessionFile } from '../../session-rest-api.js';

type DropFeedbackState =
  | {
      level: 'success' | 'warning';
      message: string;
    }
  | null;

interface FileWithOptionalPath extends File {
  path?: string;
}

export function useComposerDropPath(options: {
  sessionId?: string | null;
  disabled: boolean;
  onFileReferencesResolved: (references: string[]) => void;
  setMentionError: (message: string | null) => void;
  t: (
    key:
      | 'chatInput.drop.noPath'
      | 'chatInput.drop.imported'
      | 'chatInput.drop.partial'
      | 'chatInput.drop.uploadFailed'
  ) => string;
}) {
  const { sessionId, disabled, onFileReferencesResolved, setMentionError, t } = options;
  const dragDepthRef = useRef(0);
  const dropFeedbackTimerRef = useRef<number | null>(null);
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);
  const [dropFeedback, setDropFeedback] = useState<DropFeedbackState>(null);

  const isWindowsClient = useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    const platform = String(navigator.platform ?? '');
    const userAgent = String(navigator.userAgent ?? '');
    return /win/i.test(platform) || /windows/i.test(userAgent);
  }, []);

  const setDropFeedbackMessage = useCallback((feedback: DropFeedbackState): void => {
    if (dropFeedbackTimerRef.current !== null) {
      window.clearTimeout(dropFeedbackTimerRef.current);
      dropFeedbackTimerRef.current = null;
    }
    setDropFeedback(feedback);
    if (!feedback) {
      return;
    }
    dropFeedbackTimerRef.current = window.setTimeout(() => {
      setDropFeedback(null);
      dropFeedbackTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => {
    if (!disabled) {
      return;
    }
    dragDepthRef.current = 0;
    setIsDropTargetActive(false);
  }, [disabled]);

  useEffect(() => {
    return () => {
      if (dropFeedbackTimerRef.current !== null) {
        window.clearTimeout(dropFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (disabled) {
      return;
    }
    dragDepthRef.current += 1;
    setIsDropTargetActive(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (disabled) {
      return;
    }
    event.dataTransfer.dropEffect = 'copy';
    if (!isDropTargetActive) {
      setIsDropTargetActive(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (disabled) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDropTargetActive(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFileLikeDragData(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (disabled) {
      return;
    }
    dragDepthRef.current = 0;
    setIsDropTargetActive(false);

    const files = Array.from(event.dataTransfer.files) as FileWithOptionalPath[];
    const dropResult = buildDroppedPathInsertion({
      uriList: event.dataTransfer.getData('text/uri-list'),
      plainText: event.dataTransfer.getData('text/plain'),
      filePaths: files.map((file) => file.path).filter((path): path is string => String(path ?? '').trim().length > 0),
      fileNames: files.map((file) => file.name),
      isWindows: isWindowsClient,
    });

    if (dropResult.references.length > 0) {
      onFileReferencesResolved(dropResult.references);
      setMentionError(null);
      setDropFeedbackMessage({
        level: dropResult.resolved ? 'success' : 'warning',
        message: t(dropResult.resolved ? 'chatInput.drop.imported' : 'chatInput.drop.partial'),
      });
      return;
    }

    if (!sessionId || files.length === 0) {
      setDropFeedbackMessage({
        level: 'warning',
        message: t('chatInput.drop.noPath'),
      });
      return;
    }

    void (async () => {
      const uploaded = await Promise.allSettled(files.map((file) => uploadDroppedSessionFile(sessionId, file)));
      const references: string[] = [];
      let failedCount = 0;
      for (const result of uploaded) {
        if (result.status === 'fulfilled' && result.value.path.trim().length > 0) {
          references.push(result.value.path);
        } else {
          failedCount += 1;
        }
      }
      if (references.length > 0) {
        onFileReferencesResolved(references);
        setMentionError(null);
        setDropFeedbackMessage({
          level: failedCount > 0 ? 'warning' : 'success',
          message: t(failedCount > 0 ? 'chatInput.drop.partial' : 'chatInput.drop.imported'),
        });
        return;
      }
      setDropFeedbackMessage({
        level: 'warning',
        message: `${t('chatInput.drop.uploadFailed')} (${failedCount}/${files.length})`,
      });
    })();
  };

  return {
    isDropTargetActive,
    dropFeedback,
    setDropFeedbackMessage,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
