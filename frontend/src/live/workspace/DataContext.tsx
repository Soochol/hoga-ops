import type { ReactNode } from 'react';

function formatDataTime(ts: number): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ts);
}

/** 창마다 데이터 의미를 보존하면서 기준 시점을 같은 위치에 표시한다. */
export function DataContext({ mode, time, detail, children }: { mode: string; time?: number | null; detail?: string; children?: ReactNode }) {
  const label = [mode, time == null ? null : formatDataTime(time), detail].filter(Boolean).join(' · ');
  // 커서 시각·상태가 길어져도 본문 높이를 밀지 않는다. 전체 문구는 title로 남긴다.
  return <div className="flex min-w-0 shrink-0 items-center justify-between gap-1 bg-bg-card px-2 py-1 font-data text-2xs text-fg-dim" data-testid="data-window-context">
    <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
    {children && <div className="flex min-w-0 max-w-[50%] shrink-0 items-center truncate">{children}</div>}
  </div>;
}
