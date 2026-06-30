import type { ReactNode } from 'react';
import LiveDrawingRail from './LiveDrawingRail';

export function ChartDrawingShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="chart-drawing-shell"
      className="grid h-full min-h-0 min-w-0 grid-cols-[44px_minmax(0,1fr)] overflow-hidden"
    >
      <LiveDrawingRail />
      <div className="min-h-0 min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
