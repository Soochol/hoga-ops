import { useState } from 'react';
import { CaptureRowDetail } from './CaptureRowDetail';
import { getPhase } from './phase';
import { useInventoryRecaptureOrigins } from '../inventory/useInventoryRecaptureOrigins';
import type { QueueItem } from '../api/types';
import { FullCaptureCountBadge } from '../ui/FullCaptureCountBadge';
import { StatusBadge } from '../ui/StatusBadge';

export interface CaptureQueueRowProps {
  item: QueueItem;
  symbolName: string;
  /** Full Capture Count for (item.code, item.date), sourced from
   *  `useStockDates()` in the parent. Optional so unit tests focused on
   *  other behavior can omit it (treated as undefined → "—").
   *  - `undefined` → no meta.json on disk (a brand-new capture, no history)
   *  - `null` → legacy meta.json without the counter field (treated as ×1)
   *  - `number` → persisted count (≥1)
   *  Done rows refresh post-increment via SSE inventory_added invalidation. */
  fullCaptureCount?: number | null;
  onCancel: (itemId: string) => void;
  /** Retry the failed item; CaptureQueue routes this through the retryItems mutation (ADR-0031). */
  onRetry: (item: QueueItem) => void;
}

export function CaptureQueueRow({
  item, symbolName, fullCaptureCount, onCancel, onRetry,
}: CaptureQueueRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isFromInventory = useInventoryRecaptureOrigins((s) => s.ids.has(item.item_id));
  const descriptor = getPhase(item.phase);
  const showCancel = !descriptor.terminal;
  const showRetry = item.phase === 'failed';
  // Upstream-health badges (running rows only). Slow-but-no-429 = hogaplay
  // itself is slow (measured 2026-07-09: 30ms/page days vs 500–1600ms/page
  // days with zero 429s) — without this signal the user can't tell why a
  // capture crawls. 300ms cleanly separates the two regimes.
  const httpP50 = item.progress?.recent_http_p50_ms ?? null;
  const throttledPages = item.progress?.throttled_pages ?? 0;
  const showSlowUpstream = !descriptor.terminal && throttledPages === 0
    && httpP50 !== null && httpP50 > 300;
  const showThrottled = !descriptor.terminal && throttledPages > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded((v) => !v);
    }
  };

  return (
    <>
      <div
        data-testid={`queue-row-${item.item_id}`}
        data-expanded={expanded}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`캡처 항목 ${item.code} ${item.date} ${descriptor.label} · Enter 로 상세 ${expanded ? '접기' : '펼치기'}`}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={onKeyDown}
        className="grid grid-cols-[1rem_2.6rem_4.5rem_7rem_4.5rem_2.5rem_2.5rem_minmax(6rem,1fr)_1.2rem] items-center gap-2 h-capture-row px-sm border-b font-medium text-sm font-data tabular-nums text-fg cursor-pointer outline-none"
      >
        {/* 반응형 폭 배분: 종목명 칼럼은 고정 7rem — 행마다 균일해야 뒤 칼럼들이
            행 간 정렬된다(각 행이 독립 grid 라 max-content 로 두면 이름 길이·배지에
            따라 트랙이 들쭉날쭉해져 어긋난다). 셀 안에서 이름은 truncate, 배지는
            flex-none 으로 분리 → 긴 이름만 잘리고 배지는 항상 보인다. 남는 패널
            폭은 진행률 칼럼 minmax(6rem,1fr) 의 1fr 이 흡수해 휑함을 없앤다.
            종목코드 칼럼은 제거(요청). 아주 좁으면 리스트가 가로 스크롤. */}
        <span>{descriptor.icon}</span>
        <span data-testid="queue-row-full-capture-count">
          <FullCaptureCountBadge n={fullCaptureCount} />
        </span>
        <span>{item.date}</span>
        <span className="flex items-center gap-1.5 min-w-0 font-normal text-sm text-fg-dim">
          <span className="truncate min-w-0">{symbolName}</span>
          {item.attempt > 1 && (
            <StatusBadge tone="dim" title={`${item.attempt}회차 시도`} className="flex-none">×{item.attempt}</StatusBadge>
          )}
          {isFromInventory && (
            <StatusBadge tone="dim" title="보관함 재캡처에서 등록됨" className="flex-none">보관함</StatusBadge>
          )}
          {showSlowUpstream && (
            <span data-testid="queue-row-slow-upstream" className="flex-none">
              <StatusBadge
                tone="warn"
                title={`hogaplay 응답 지연 — 최근 페이지 p50 ${Math.round(httpP50!)}ms (429 아님). 서버 쪽 지연이라 한산한 시간대(장 마감 후) 재시도 권장.`}
              >지연</StatusBadge>
            </span>
          )}
          {showThrottled && (
            <span data-testid="queue-row-throttled" className="flex-none">
              <StatusBadge
                tone="warn"
                title={`hogaplay 429 스로틀 ${throttledPages}회 — 자동 백오프로 감속 중.`}
              >429×{throttledPages}</StatusBadge>
            </span>
          )}
        </span>
        {/* 표시는 한국어 라벨, data-phase 에 원값 보존 — e2e·디버깅은 원값을 본다. */}
        <span data-phase={item.phase} style={{ background: descriptor.chipColor }}
          className="py-0.5 px-xs rounded-md text-fg-dim">
          {descriptor.label}
        </span>
        <span>{item.progress?.pages_done ?? '–'}</span>
        <span>{item.progress?.events_seen ?? '–'}</span>
        <span className="flex items-center gap-1.5">
          <span className="flex-1 h-0.5 bg-bg-input rounded-sm relative">
            <span style={{ width: `${item.progress?.estimate_pct ?? 0}%` }}
              className="absolute left-0 top-0 bottom-0 bg-accent rounded-sm" />
          </span>
          <span className="w-7 text-right text-fg-dim">
            {item.progress?.estimate_pct !== undefined ? `${item.progress.estimate_pct}%` : '–'}
          </span>
        </span>
        <span className="flex justify-end">
          {showCancel && (
            <button
              type="button"
              aria-label="취소" title="취소"
              onClick={(e) => { e.stopPropagation(); onCancel(item.item_id); }}
              className="bg-transparent border-none text-fg-dim cursor-pointer text-sm p-1 -m-1"
            >✕</button>
          )}
          {showRetry && (
            <button
              type="button"
              aria-label="재시도" title="재시도"
              onClick={(e) => { e.stopPropagation(); onRetry(item); }}
              className="bg-transparent border-none text-accent cursor-pointer text-sm p-1 -m-1"
            >↻</button>
          )}
        </span>
      </div>
      {expanded && <CaptureRowDetail item={item} />}
    </>
  );
}
