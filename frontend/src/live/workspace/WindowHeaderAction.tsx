import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A frame-scoped action slot keeps content-owned controls and their safety state together. */
export const WindowHeaderActionsContext = createContext<HTMLElement | null>(null);

export function WindowHeaderAction({ children }: { children: ReactNode }) {
  const target = useContext(WindowHeaderActionsContext);
  // Standalone content previews have no frame. A mounted frame always supplies its own slot.
  return target ? createPortal(children, target) : children;
}
