import type { ReactNode } from 'react';

function formatDataTime(ts: number): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ts);
}

/** 창마다 데이터 의미를 보존하면서 기준 시점을 같은 위치에 표시한다. */
export function DataContext({ mode, time, detail, children }: { mode: string; time?: number | null; detail?: string; children?: ReactNode }) {
  const label = [mode, time == null ? null : formatDataTime(time), detail].filter(Boolean).join(' · ');
  return <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 bg-bg-card px-2 py-1 font-data text-2xs text-fg-dim" data-testid="data-window-context">
    <span title={label}>{label}</span>{children}
  </div>;
}
