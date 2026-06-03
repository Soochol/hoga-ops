import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { LiveTimeframe } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { paneIdAtY, type PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { priceDirClass } from '../ui/priceDir';
import { formatKoreanInt } from '../util/koreanNumber';
import { buildCandleTooltip, placeTooltip } from './candleTooltipModel';

type Props = {
  chart: IChartApi;
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  timeframe: LiveTimeframe;
};

// 레전드 boxStyle 선례(불투명 표면 + DESIGN 토큰).
const boxStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 6,
  pointerEvents: 'none',
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.5,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
  minWidth: 150,
  boxShadow: 'var(--shadow)',
};
const rowStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 16 };
const keyStyle: CSSProperties = { color: 'var(--fg-dimmer)' };
const valStyle: CSSProperties = { color: 'var(--fg)' };

const signed = (n: number) => (n >= 0 ? '+' : '') + formatKoreanInt(n);
const signedPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{k}</span>
      {children}
    </div>
  );
}

export default function CandleTooltip({ chart, bundle, axis, paneSeries, timeframe }: Props) {
  const enabled = useActivePrefs((p) => p.candleTooltipEnabled);
  const tipRef = useRef<HTMLDivElement>(null);
  // 호버 "키"만 저장한다(가상시각 time + 화면 위치). 툴팁 내용 모델은 아래 렌더에서
  // 현재 drawn/vsecToIndex 로 파생한다 — 이렇게 분리해야 /live 의 SSE 틱이
  // bundle.candles 를 재생성해도 (a) 구독이 끊겨 툴팁이 사라지지 않고,
  // (b) 커서를 안 움직여도 내용이 in-place 로 갱신된다(스펙 §거동, ADR-0059).
  const [hover, setHover] = useState<{ time: number; left: number; top: number } | null>(null);

  // 그려진 캔들 배열(projectCandle 와 동일 필터) + 가상시각(초)→index 맵.
  // 키는 projectCandle 의 candle.time = axis.toVirtual(ts_ms)/1000 과 정확히 동일(반올림 X).
  const { drawn, vsecToIndex } = useMemo(() => {
    const drawnArr = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    const map = new Map<number, number>();
    drawnArr.forEach((c, i) => map.set(axis.toVirtual(c.ts_ms) / 1000, i));
    return { drawn: drawnArr, vsecToIndex: map };
  }, [bundle.candles, axis]);

  // paneIdAtY 에 쓰는 paneSeries 는 ref 로 읽어, 구독 effect 가 [chart, enabled] 에만
  // 의존하게 한다 — 데이터 틱·pane 등록 변화로 재구독(→ 툴팁 소멸)되지 않도록.
  const paneSeriesRef = useRef(paneSeries);
  useEffect(() => { paneSeriesRef.current = paneSeries; }, [paneSeries]);

  useEffect(() => {
    // 토글 OFF: 구독하지 않는다. 직전 effect 의 cleanup 이 이미 hover 를 비웠고,
    // 렌더 가드(`!enabled || !hover`)가 표시를 막으므로 여기서 setHover 불필요.
    if (!enabled) return;
    let pending: number | null = null;
    const handler = (param: MouseEventParams) => {
      if (param.point == null || typeof param.time !== 'number') {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        setHover(null);
        return;
      }
      const point = param.point;
      const time = param.time as number;
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        // 캔들 페인 한정.
        if (paneIdAtY(chart, paneSeriesRef.current, point.y) !== 'candle') { setHover(null); return; }
        const el = chart.chartElement();
        const tip = tipRef.current;
        const place = placeTooltip(
          point.x, point.y,
          el?.clientWidth ?? 0, el?.clientHeight ?? 0,
          tip?.offsetWidth ?? 160, tip?.offsetHeight ?? 130,
        );
        setHover({ time, left: place.left, top: place.top });
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      setHover(null);
    };
  }, [chart, enabled]);

  // 내용 모델은 렌더에서 현재 데이터로 파생(순수) — SSE 틱으로 drawn 이 갱신되면
  // 커서를 안 움직여도 자동으로 최신값. 호버 봉이 사라지면(idx 부재) 숨김.
  if (!enabled || !hover) return null;
  const idx = vsecToIndex.get(hover.time);
  if (idx === undefined) return null;
  const m = buildCandleTooltip(drawn, idx, timeframe);
  if (!m) return null;
  const bobNull = m.barOverBarWon == null || m.barOverBarPct == null;
  return (
    <div ref={tipRef} data-testid="candle-tooltip" style={{ ...boxStyle, left: hover.left, top: hover.top }}>
      <div style={{ ...rowStyle, color: 'var(--fg-dim)', marginBottom: 4 }}>
        <span>{m.dateLabel}{m.timeLabel ? ` ${m.timeLabel}` : ''}</span>
      </div>
      <Row k="시"><span style={valStyle}>{formatKoreanInt(m.open)}</span></Row>
      <Row k="고"><span style={valStyle}>{formatKoreanInt(m.high)}</span></Row>
      <Row k="저"><span style={valStyle}>{formatKoreanInt(m.low)}</span></Row>
      <Row k="종"><span style={valStyle}>{formatKoreanInt(m.close)}</span></Row>
      <Row k="직전대비">
        <span className={bobNull ? undefined : priceDirClass(m.barOverBarWon!)}>
          {bobNull ? '—' : `${signed(m.barOverBarWon!)}  ${signedPct(m.barOverBarPct!)}`}
        </span>
      </Row>
      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
      <Row k="거래량"><span style={valStyle}>{formatKoreanInt(m.volume)}</span></Row>
      <Row k="거래량비">
        <span style={valStyle}>{m.volumeRatioPct == null ? '—' : `${Math.round(m.volumeRatioPct)}%`}</span>
      </Row>
    </div>
  );
}
