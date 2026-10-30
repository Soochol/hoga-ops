import { forwardRef, type HTMLAttributes } from 'react';

/** Preserve the content and layout; opening requires a double-click or keyboard activation. */
export const TradeWindowTrigger = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { onOpen?: () => void }>(function TradeWindowTrigger({ onOpen, ...props }, ref) {
  return <div {...props} ref={ref} role={onOpen ? 'button' : undefined} tabIndex={0}
    aria-label={onOpen ? '체결창 열기' : undefined}
    onDoubleClick={onOpen ? event => {
      event.preventDefault();
      event.stopPropagation();
      onOpen();
    } : undefined}
    onKeyDown={onOpen ? event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) onOpen();
    } : undefined} />;
});
