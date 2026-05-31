import { forwardRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Shared outer frame for feature pages (DESIGN.md "Page shell"). Provides the
 * one canonical page padding token (p-md) + full-height sizing. Does NOT impose
 * a card or a page title — pages compose their own card(s) and a title-less
 * control bar inside. The left nav is the page label, so pages never repeat
 * their own name (matches the /live header decision). Full-bleed pages (the
 * /live chart workspace) do NOT use this; they own their grid.
 *
 * forwardRef so a page that needs the frame element (e.g. Capture's splitter
 * drag math) can read it.
 */
export const PageContainer = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string; style?: CSSProperties }
>(function PageContainer({ children, className = '', style }, ref) {
  return (
    <div ref={ref} className={`p-md h-full min-h-0 ${className}`} style={style}>
      {children}
    </div>
  );
});

export default PageContainer;
