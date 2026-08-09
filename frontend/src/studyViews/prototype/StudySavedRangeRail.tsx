/**
 * ⚠ PROTOTYPE — throwaway (studyDailyContextPrototype.ts 참조).
 *
 * 변형 C 의 하단 미니맵 레일. 차트 자체는 저장 구간 위주로 확대돼 있고, "이게 큰
 * 그림 어디냐" 는 이 레일이 답한다 — A/B 가 차트 **안**에서 푸는 문제를 차트
 * **밖**에서 푼다는 점이 이 변형의 구조적 차이다.
 *
 * 종가 스파크라인(SVG polyline) + 저장 구간 창 + 현재 뷰포트 창. 클릭하면 그
 * 지점으로 메인 차트를 이동시킨다 — lwc 인스턴스는 dev 전역
 * `window.__liveChart` 로 잡는다(프로토타입이라 prop drilling 을 생략).
 */
import { useEffect, useRef, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Candle } from '../../api/types';
import type { StudySavedRangeMarks } from './studyDailyContextPrototype';

const RAIL_HEIGHT = 44;

declare global {
  interface Window {
    __liveChart?: IChartApi;
  }
}

export function StudySavedRangeRail({
  candles,
  marks,
}: {
  candles: readonly Candle[];
  marks: StudySavedRangeMarks;
}) {
  const [visible, setVisible] = useState<{ from: number; to: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 메인 차트의 보이는 논리 범위를 폴링한다 — 프로토타입이므로 구독 배선 대신
  // rAF 루프로 충분하다(창이 하나뿐이고 수명이 짧다).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const r = window.__liveChart?.timeScale().getVisibleLogicalRange();
      if (r) setVisible((cur) => (cur && cur.from === r.from && cur.to === r.to ? cur : { from: r.from, to: r.to }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (candles.length < 2) return null;
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const points = closes
    .map((v, i) => `${(i / (n - 1)) * 100},${RAIL_HEIGHT - 4 - ((v - lo) / span) * (RAIL_HEIGHT - 8)}`)
    .join(' ');

  const idxOf = (ms: number) => {
    let best = 0;
    for (let i = 0; i < n; i += 1) if (candles[i].ts_ms <= ms) best = i;
    return best;
  };
  const savedLeft = (idxOf(marks.fromMs) / (n - 1)) * 100;
  const savedRight = (idxOf(marks.toMs) / (n - 1)) * 100;
  const viewLeft = visible ? (Math.max(0, visible.from) / (n - 1)) * 100 : null;
  const viewRight = visible ? (Math.min(n - 1, visible.to) / (n - 1)) * 100 : null;

  const jumpTo = (ratio: number) => {
    const chart = window.__liveChart;
    const r = chart?.timeScale().getVisibleLogicalRange();
    if (!chart || !r) return;
    const width = r.to - r.from;
    const center = ratio * (n - 1);
    chart.timeScale().setVisibleLogicalRange({ from: center - width / 2, to: center + width / 2 });
  };

  return (
    <div
      data-testid="study-saved-range-rail"
      className="shrink-0 border-t border-border bg-bg-card px-2 py-1"
    >
      <div className="mb-0.5 flex items-center gap-2 text-[11px] text-fg-dim tabular-nums">
        <span
          className="inline-block h-2 w-2 rounded-[2px]"
          style={{ background: 'var(--accent)' }}
        />
        <span>{marks.label}</span>
        <span className="ml-auto">전체 {n}일 · 클릭하면 이동</span>
      </div>
      <div
        ref={wrapRef}
        className="relative cursor-pointer"
        style={{ height: RAIL_HEIGHT }}
        onClick={(e) => {
          const rect = wrapRef.current?.getBoundingClientRect();
          if (rect) jumpTo(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
        }}
      >
        <svg
          viewBox={`0 0 100 ${RAIL_HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <rect
            x={savedLeft}
            y={0}
            width={Math.max(0.4, savedRight - savedLeft)}
            height={RAIL_HEIGHT}
            fill="var(--accent)"
            opacity={0.18}
          />
          <polyline
            points={points}
            fill="none"
            stroke="var(--fg-dim)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <line x1={savedLeft} x2={savedLeft} y1={0} y2={RAIL_HEIGHT} stroke="var(--accent)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={savedRight} x2={savedRight} y1={0} y2={RAIL_HEIGHT} stroke="var(--accent)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {viewLeft != null && viewRight != null && (
          <div
            className="absolute top-0 bottom-0 border border-border-strong"
            style={{
              left: `${viewLeft}%`,
              width: `${Math.max(0.5, viewRight - viewLeft)}%`,
              background: 'var(--bg)',
              opacity: 0.28,
            }}
          />
        )}
      </div>
    </div>
  );
}

export default StudySavedRangeRail;
