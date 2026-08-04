import { useMemo, useRef, useState } from 'react';
import { useMutationState } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ADD_ITEMS_MUTATION_KEY, useCaptureQueue } from './useCaptureQueue';
import { useSymbols } from './useSymbols';
import { CaptureQueueRow } from './CaptureQueueRow';
import { GROUP_ORDER, getPhase } from './phase';
import { useStockDates } from '../api/stock-dates';
import type { EnqueueResponse, QueueItem } from '../api/types';
import { EmptyState, InlineState } from '../ui/DataSurface';
import { computeHeaderSummary, summarizeDedupeReasons } from './queueSummary';

const VIRTUALIZE_THRESHOLD = 200;

export function CaptureQueue() {
  const {
    queue, isError, refetchQueue, cancelItem, cancelAll, dismissDone, resumeQueue, retryItems,
  } = useCaptureQueue();
  const { data: symbolsResp } = useSymbols();
  const { data: stockDates } = useStockDates();
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    (symbolsResp?.symbols ?? []).forEach((s) => m.set(s.code, s.name));
    return m;
  }, [symbolsResp]);
  // Lookup Full Capture Count by (code, date) for each queue row.
  // Returns `null` when no prior meta.json exists (a brand-new capture);
  // returns the persisted counter (incl. legacy null) when meta.json
  // is present on disk. SSE inventory_added invalidates the underlying
  // query, so done rows refresh to the post-increment value within ~ms.
  const fullCaptureCountByKey = useMemo(() => {
    const m = new Map<string, number | null>();
    (stockDates ?? []).forEach((sd) => m.set(`${sd.code}|${sd.date}`, sd.full_capture_count));
    return m;
  }, [stockDates]);

  const [cancelAllArmed, setCancelAllArmed] = useState(false);
  const cancelAllTimerRef = useRef<number | null>(null);

  // Dedupe banner: subscribe to the latest CaptureForm-issued addItems response via the
  // shared mutationKey. We can't read `addItems.data` directly because CaptureForm holds
  // its own useMutation instance (sibling component, separate React Query state).
  const addItemsSubmissions = useMutationState<{
    data: EnqueueResponse | undefined;
    submittedAt: number;
  }>({
    filters: { mutationKey: ADD_ITEMS_MUTATION_KEY },
    select: (m) => ({
      data: m.state.data as EnqueueResponse | undefined,
      submittedAt: m.state.submittedAt,
    }),
  });
  const lastAddItems = addItemsSubmissions[addItemsSubmissions.length - 1];
  const lastDedupedRows = lastAddItems?.data?.deduped ?? [];
  const [dismissedSubmittedAt, setDismissedSubmittedAt] = useState<number>(0);
  const showDedupedBanner =
    lastDedupedRows.length > 0
    && lastAddItems !== undefined
    && lastAddItems.submittedAt !== dismissedSubmittedAt;

  // Hook called unconditionally — when queue is undefined, treat as empty.
  const allRows: QueueItem[] = useMemo(() => {
    if (queue === undefined) return [];
    const merged = [...queue.active, ...queue.queued, ...queue.done];
    merged.sort((a, b) => {
      const p = GROUP_ORDER[getPhase(a.phase).group] - GROUP_ORDER[getPhase(b.phase).group];
      if (p !== 0) return p;
      return a.enqueued_at_ms - b.enqueued_at_ms;
    });
    return merged;
  }, [queue]);

  const handleCancelAll = () => {
    if (cancelAllArmed) {
      if (cancelAllTimerRef.current !== null) window.clearTimeout(cancelAllTimerRef.current);
      cancelAllTimerRef.current = null;
      setCancelAllArmed(false);
      cancelAll.mutate();
      return;
    }
    setCancelAllArmed(true);
    cancelAllTimerRef.current = window.setTimeout(() => setCancelAllArmed(false), 4_000);
  };

  if (queue === undefined) {
    // 로딩과 에러를 구분한다 — 실패가 "영구 불러오는 중"으로 위장되면 사용자는
    // 큐가 비어 가는 중이라고 오독한다.
    if (isError) {
      return (
        <InlineState tone="error" role="alert" className="flex items-center gap-3 text-sm">
          <span className="flex-1">대기열을 불러오지 못했습니다 · 백엔드 연결을 확인하세요</span>
          <button type="button" onClick={() => refetchQueue()} style={ghostButton()}>다시 시도</button>
        </InlineState>
      );
    }
    return <InlineState className="border-0 bg-transparent p-3">불러오는 중…</InlineState>;
  }

  // ADR-0094: a read-only (non-owner) instance can't mutate the queue. Surface
  // it prominently — this instance's empty queue is NOT the source of truth.
  const notOwned = queue.queue_owned === false;
  const notOwnedBanner = notOwned ? (
    <InlineState role="alert" tone="warn" data-testid="queue-not-owned-banner"
      className="py-sm flex items-center gap-3 font-medium font-data">
      <span aria-hidden>⚠</span>
      <span className="flex-1">
        다른 서버 인스턴스가 캡처 큐를 소유 중입니다 · 이 인스턴스에서는 캡처를 시작·취소할 수 없습니다
      </span>
    </InlineState>
  ) : null;

  const totalRows = queue.active.length + queue.queued.length + queue.done.length;
  if (totalRows === 0 && !queue.paused) {
    return (
      <div className="flex min-h-0 h-full flex-col gap-2">
        {notOwnedBanner}
        <EmptyState testId="queue-empty" title="큐가 비어 있습니다">
          왼쪽에서 종목과 날짜 범위를 선택하고 캡처 시작을 누르면 캡처가 시작됩니다
        </EmptyState>
      </div>
    );
  }

  const summary = computeHeaderSummary(queue);

  const onRetry = (item: QueueItem) => {
    retryItems.mutate({ item_ids: [item.item_id] });
  };

  const shouldVirtualize = allRows.length > VIRTUALIZE_THRESHOLD;

  return (
    <div className="flex min-h-0 h-full flex-col gap-2">
      {notOwnedBanner}
      <div className="flex items-center gap-3 px-sm">
        {/* role=status: 완료/실패 수가 실시간으로 바뀌는 줄 — 스크린리더에도 공지. */}
        <div role="status" className="flex-1 font-medium text-sm font-data text-fg-dim tabular-nums">
          완료 {summary.done}/{summary.total} · 실패 {summary.failed} · 수집 중 {summary.capturing}
        </div>
        {/* 전체 취소 2단계 확인의 무장 상태는 라벨 교체만으로는 스크린리더에 안
            들리므로 별도 라이브 리전으로 공지한다(4초 뒤 자동 해제). */}
        <span role="status" className="sr-only">
          {cancelAllArmed ? '전체 취소 대기 중 — 버튼을 다시 누르면 실행됩니다' : ''}
        </span>
        <button
          type="button"
          onClick={handleCancelAll}
          style={cancelAllArmed
            ? ghostButton('var(--error)', 'var(--error)')
            : ghostButton()
          }
        >{cancelAllArmed ? '한 번 더 누르면 전체 취소' : '전체 취소'}</button>
        <button
          type="button"
          disabled={summary.failed === 0}
          onClick={() => {
            const ids = queue.done
              .filter((i) => i.phase === 'failed')
              .map((i) => i.item_id);
            if (ids.length > 0) retryItems.mutate({ item_ids: ids });
          }}
          style={summary.failed === 0 ? ghostButtonDisabled() : ghostButton()}
        >실패 재시도</button>
        <button
          type="button"
          onClick={() => dismissDone.mutate()}
          style={ghostButton()}
        >완료 지우기</button>
      </div>

      <div className="h-1 bg-bg-input rounded-sm relative">
        <div style={{ width: `${summary.total > 0 ? (summary.done / summary.total) * 100 : 0}%` }}
          className="absolute left-0 top-0 bottom-0 bg-accent rounded-sm" />
      </div>

      {showDedupedBanner && lastAddItems !== undefined && (
        <InlineState
          data-testid="deduped-banner"
          role="status"
          tone="accent"
          className="py-sm flex items-center gap-3 font-medium font-data"
        >
          <span aria-hidden>ⓘ</span>
          <span className="flex-1">{summarizeDedupeReasons(lastDedupedRows)}</span>
          <button
            type="button"
            aria-label="중복 안내 닫기"
            onClick={() => setDismissedSubmittedAt(lastAddItems.submittedAt)}
            style={ghostButton()}
          >닫기</button>
        </InlineState>
      )}

      {queue.paused && (
        <InlineState role="alert" tone="warn" className="py-sm flex items-center gap-3 font-medium font-data">
          <span className="flex-1">쿠키 만료 · 디스크의 .cookie 파일을 갱신한 뒤 재개하세요</span>
          <button type="button" onClick={() => resumeQueue.mutate()} style={ghostButton()}>새로고침 후 재개</button>
          <button type="button" onClick={() => cancelAll.mutate()} style={ghostButton()}>전체 취소</button>
        </InlineState>
      )}

      <div
        data-testid="queue-list"
        data-virtualized={shouldVirtualize}
        className="min-h-0 flex-1 overflow-y-auto rounded-md"
      >
        {shouldVirtualize
          ? <VirtualList
              rows={allRows}
              nameByCode={nameByCode}
              fullCaptureCountByKey={fullCaptureCountByKey}
              onCancel={cancelItem.mutate}
              onRetry={onRetry}
            />
          : allRows.map((row) => (
              <CaptureQueueRow
                key={row.item_id}
                item={row}
                symbolName={nameByCode.get(row.code) ?? '—'}
                fullCaptureCount={fullCaptureCountByKey.get(`${row.code}|${row.date}`)}
                onCancel={cancelItem.mutate}
                onRetry={onRetry}
              />
            ))}
      </div>
    </div>
  );
}

function VirtualList({
  rows, nameByCode, fullCaptureCountByKey, onCancel, onRetry,
}: {
  rows: QueueItem[];
  nameByCode: Map<string, string>;
  fullCaptureCountByKey: Map<string, number | null>;
  onCancel: (itemId: string) => void;
  onRetry: (item: QueueItem) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    // Initial guess only — a collapsed row is ~36px. Real heights are read back
    // via measureElement (below), so an expanded row's detail panel grows the
    // slot and pushes following rows down instead of overlapping them.
    estimateSize: () => 36,
    overscan: 8,
  });
  return (
    // testid: 가상화가 켜지면 **실제 스크롤 컨테이너가 여기**다 — 바깥
    // `queue-list` 는 껍데기가 되어 scrollHeight 가 안 늘어난다(실측 701=701, 안쪽은
    // 9500). e2e 가 "긴 목록이 카드 안에서 스크롤된다" 를 검증하려면 이 요소를 봐야 한다.
    <div ref={parentRef} data-testid="queue-virtual-scroller"
      style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vr) => {
          const row = rows[vr.index];
          return (
            <div
              key={row.item_id}
              // Dynamic measurement: the virtualizer observes this element's real
              // height (collapsed row OR row + expanded CaptureRowDetail) and
              // repositions subsequent rows. Without data-index + measureElement
              // every slot stays the 36px estimate and expanded details overlap
              // the next rows.
              data-index={vr.index}
              ref={v.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vr.start}px)` }}
            >
              <CaptureQueueRow
                item={row}
                symbolName={nameByCode.get(row.code) ?? '—'}
                fullCaptureCount={fullCaptureCountByKey.get(`${row.code}|${row.date}`)}
                onCancel={onCancel}
                onRetry={onRetry}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ghostButtonDisabled(): React.CSSProperties {
  return { ...ghostButton(), opacity: 0.5, cursor: 'not-allowed' };
}

function ghostButton(borderColor = 'var(--border-strong)', fgColor = 'var(--fg-dim)'): React.CSSProperties {
  // Use longhand border properties (borderWidth / borderStyle / borderColor)
  // so callers can override borderColor without React's "shorthand and
  // non-shorthand on the same value" warning (BUG-002 from /qa).
  return {
    background: 'transparent',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor,
    color: fgColor,
    borderRadius: 4,
    padding: '4px 10px',
    // Longhand, not the `font` shorthand: the shorthand hardcoded a family
    // ("Geist Sans" — dead since 2026-07-08) and resets every font-* longhand
    // it omits, which is how it escaped both font migrations. Family goes
    // through the token like everywhere else.
    fontWeight: 500,
    fontSize: 'var(--text-xs)',
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
  };
}
