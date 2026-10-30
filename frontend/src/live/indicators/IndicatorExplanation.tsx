import { createContext, useContext, type ReactNode } from 'react';

/** Standalone configs retain their help; the editor reveals it with its title button. */
export const IndicatorExplanationContext = createContext(true);

export function IndicatorExplanation({ children, summary, className = '' }: {
  children: ReactNode; summary?: ReactNode; className?: string;
}) {
  const expanded = useContext(IndicatorExplanationContext);
  const content = expanded ? children : summary;
  if (!content) return null;
  return <p className={`indicator-explanation text-xs text-fg-dim ${className}`.trim()}>{content}</p>;
}
