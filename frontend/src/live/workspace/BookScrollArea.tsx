import type { ReactNode } from 'react';

/** Keep the complete fixed-row ladder reachable when a saved window is smaller than its contents. */
export function BookScrollArea({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div tabIndex={0} role="region" aria-label="10호가 사다리와 요약" className="min-h-0 flex-1 overflow-auto">
        <div>{children}</div>
      </div>
    </div>
  );
}
