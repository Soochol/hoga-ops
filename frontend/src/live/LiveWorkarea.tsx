import { useEffect, useRef } from 'react';
import { useLivePageStore } from '../state/livePage';
import { useEntryDragStore } from '../state/entryDrag';
import { LiveChartRoot } from './LiveChartRoot';
import { LiveEmptyState } from './LiveEmptyState';
import { LiveSidebar } from './LiveSidebar';
import type { AskPeak, RangeBundle } from '../api/types';
import type { LiveSeriesData } from '../api/liveSeries';
import type { LiveDataWarning } from './liveDataWarnings';
import type { TabViewport } from './viewportAnchor';

/** 관심종목 행을 차트로 드래그할 때 워크에어리어 위에 뜨는 드롭 타깃 오버레이.
 *  드래그 고스트는 패널 overflow 경계에서 잘리므로 워크에어리어 자체를 어포던스로 쓴다.
 *  pointer-events:none — 좌표 hit-test는 rect로 하므로 포인터를 가로채면 안 된다.
 *  색·섀도·모션은 DESIGN.md 토큰 준수: 선택 틴트(--tint-selection, accent 12%) +
 *  accent 점선 보더 + 드롭다운 섀도(0 8px 24px) + short 트랜지션(150ms). */
function ChartDropOverlay({ over }: { over: boolean }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 flex items-center justify-center"
      style={{
        zIndex: 5,
        pointerEvents: 'none',
        background: over ? 'var(--tint-selection)' : 'transparent',
        border: '2px dashed var(--accent)',
        opacity: over ? 1 : 0.7,
        transition: 'opacity 150ms ease, background 150ms ease',
      }}
    >
      <span
        className="font-ui text-sm font-semibold rounded-md"
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          transform: over ? 'scale(1)' : 'scale(0.97)',
          transition: 'transform 150ms ease',
        }}
      >
        여기에 놓아 종목 변경
      </span>
    </div>
  );
}

interface Props {
  activeCode: string | null;
  /** The Live Candle Backfill bundle, owned by LivePage. ADR-0040 — single
   * useLiveBundle call site per page. Full bundle (chart + live hoga overlay). */
  bundle: RangeBundle | null;
  /** Chart side only, stable across SSE ticks (2026-06-09 bundle-split). Threaded
   * to LiveChartRoot for the candle path. Optional → LiveChartRoot falls back to
   * `bundle`. */
  chartBundle?: RangeBundle | null;
  clampEngaged: boolean;
  isPastCandlesLoading: boolean;
  /** useLiveBundle.isExtending — 진행 루프 settle-effect 구동용. LiveChartRoot로 전달. */
  isExtending: boolean;
  /** 활성 경로 과거 fetch 경고(rate-limit 등). LiveChartRoot의 빈칸 문구·부분로딩 칩용. */
  pastDataWarnings?: LiveDataWarning[];
  /** 활성 탭의 저장된 viewport(ADR-0069 A안). cold 전환 복귀 시 보던 위치 복원용으로
   * LiveChartRoot에 전달. */
  restoreViewport?: TabViewport | null;
  /** Owned by LivePage's single useLiveSeries call. Threaded to LiveSidebar
   * so the LATEST mode reads the same SSE buffer that feeds useLiveBundle. */
  live: LiveSeriesData;
  /** LivePage의 useDayAskPeaks 결과(거래일별) — LiveChartRoot → LiveAskPeakSegments로 전달. */
  dayAskPeaks?: readonly AskPeak[];
  /** 오늘(KST YYYYMMDD) — 오늘 세그먼트만 라이브 엣지까지 연장. */
  todayKst?: string;
}

/** 안정 빈 배열 — 기본값이 매 렌더 새 []를 만들지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];

export function LiveWorkarea({
  activeCode,
  bundle,
  chartBundle,
  clampEngaged,
  isPastCandlesLoading,
  isExtending,
  pastDataWarnings,
  restoreViewport,
  live,
  dayAskPeaks = EMPTY_ASK_PEAKS,
  todayKst = '',
}: Props) {
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  // 관심종목 행을 차트로 드래그 중일 때만 드롭 오버레이를 띄운다(WatchlistDrawer가 갱신).
  const draggingEntry = useEntryDragStore((s) => s.draggingCode != null);
  const overChart = useEntryDragStore((s) => s.overChart);

  // 차트 드롭-타깃 seam: 워크에어리어가 자신의 히트테스트를 entryDrag에 등록한다(unmount 해제).
  // 패널 드롭 로직은 이 술어로만 "차트 위인가"를 묻고 차트 DOM·rect를 모른다. 등록/해제
  // 라이프사이클이 "워크에어리어 하나" invariant를 포섭한다(마지막 등록이 진실).
  const workareaRef = useRef<HTMLDivElement>(null);
  const registerChartTarget = useEntryDragStore((s) => s.registerChartTarget);
  const clearChartTarget = useEntryDragStore((s) => s.clearChartTarget);
  useEffect(() => {
    const hitTest = (clientX: number, clientY: number): boolean => {
      const el = workareaRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    };
    registerChartTarget(hitTest);
    return () => clearChartTarget(hitTest);
  }, [registerChartTarget, clearChartTarget]);

  // 빈 상태(activeCode 없음 = 빈 탭)와 차트를 하나의 루트로 합친다 — 단일 루트에 ref를 달아
  // 드롭 타깃 히트테스트가 한 element를 가리키게 하고, 빈 탭에도 드롭 가능.
  // position:relative는 absolute 오버레이의 containing block. minHeight:0 + overflow:hidden은
  // 차트 캔버스 intrinsic 크기가 flex 높이를 밀어내는 runaway 루프를 막는다(67c527a).
  return (
    <div
      ref={workareaRef}
      data-testid="live-workarea"
      className="h-full flex"
      style={{
        position: 'relative',
        background: 'var(--bg)',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {!activeCode ? (
        <div style={{ flex: 1, minWidth: 0 }}>
          <LiveEmptyState cause="no_active_code" />
        </div>
      ) : (
        <>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
            <LiveChartRoot
              code={activeCode}
              timeframe={timeframe}
              bundle={bundle}
              chartBundle={chartBundle}
              clampEngaged={clampEngaged}
              isPastCandlesLoading={isPastCandlesLoading}
              isExtending={isExtending}
              pastDataWarnings={pastDataWarnings}
              restoreViewport={restoreViewport}
              dayAskPeaks={dayAskPeaks}
              todayKst={todayKst}
            />
          </div>
          <div
            role="complementary"
            aria-label="Live Sidebar"
            style={{
              width: 'var(--sidebar-w)',
              flexShrink: 0,
              borderLeft: '1px solid var(--border)',
            }}
          >
            <LiveSidebar code={activeCode} live={live} />
          </div>
        </>
      )}
      {draggingEntry && <ChartDropOverlay over={overChart} />}
    </div>
  );
}
