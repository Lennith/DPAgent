interface LayoutRect {
  left: number;
  right: number;
  top: number;
  bottom?: number;
  height?: number;
  width: number;
}

export interface SessionLlmPopoverPositionInput {
  triggerRect: LayoutRect;
  anchorRect: LayoutRect;
  viewportWidth: number;
  viewportHeight: number;
  maxWidth?: number;
  margin?: number;
  gap?: number;
}

export interface SessionLlmPopoverPosition {
  left: number;
  bottom: number;
  width: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function resolveSessionLlmPopoverPosition({
  triggerRect,
  anchorRect,
  viewportWidth,
  viewportHeight,
  maxWidth = 720,
  margin = 12,
  gap = 12,
}: SessionLlmPopoverPositionInput): SessionLlmPopoverPosition {
  const viewportUsableWidth = Math.max(0, viewportWidth - margin * 2);
  const anchorLeft = clamp(anchorRect.left, margin, viewportWidth - margin);
  const anchorRight = clamp(anchorRect.right, anchorLeft, viewportWidth - margin);
  const anchorWidth = Math.max(0, anchorRight - anchorLeft);
  const width = Math.max(0, Math.min(maxWidth, viewportUsableWidth, anchorWidth || viewportUsableWidth));
  const preferredViewportLeft = triggerRect.right - width;
  const viewportLeft = clamp(preferredViewportLeft, anchorLeft, Math.max(anchorLeft, anchorRight - width));
  const anchorHeight =
    typeof anchorRect.height === 'number'
      ? anchorRect.height
      : typeof anchorRect.bottom === 'number'
        ? anchorRect.bottom - anchorRect.top
        : viewportHeight - anchorRect.top;

  return {
    left: Math.max(0, viewportLeft - anchorRect.left),
    bottom: Math.max(margin, anchorHeight + gap),
    width,
  };
}
