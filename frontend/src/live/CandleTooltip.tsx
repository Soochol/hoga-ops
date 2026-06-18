import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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

// OHLC 행: 가격(중립 --fg) + 직전 봉(이전 캔들) 종가 대비 변동률%(상승 빨강/하락 파랑).
// pct 없으면(가장 이른 봉 / prev.close<=0) % 칸은 비워 세로 정렬을 유지한다.
function PriceRow({ k, price, pct }: { k: string; price: number; pct: number | null }) {
  // 색·텍스트 모두 '반올림된' 값 기준 — 표시가 "+0.00%" 인데 색만 빨강/파랑인 불일치 방지
  // (priceDirClass 는 raw 부호, signedPct 는 toFixed(2) 반올림이라 미세값에서 어긋남).
  const r = pct != null && Number.isFinite(pct) ? Number(pct.toFixed(2)) : null;
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{k}</span>
      <span style={{ display: 'inline-flex', gap: 10 }}>
        <span style={{ ...valStyle, minWidth: '7ch', textAlign: 'right' }}>{formatKoreanInt(price)}</span>
        <span
          className={r != null ? priceDirClass(r) : undefined}
          style={{ minWidth: '6ch', textAlign: 'right' }}
        >
          {r != null ? signedPct(r) : ''}
        </span>
      </span>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={keyStyle}>{k}</span>
      {children}
    </div>
  );
}

function CandleTooltip({ chart, bundle, axis, paneSeries, timeframe }: Props) {
  const enabled = useActivePrefs((p) => p.candleTooltipEnabled);
  const tipRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<{ tsMs: number; left: number; top: number } | null>(null);
  // 호버 "키"는 절대 ts_ms 로 저장한다(가상시각 X). 가상시각은 axis 리베이스(과거 거래일
  // 확장)로 시프트되지만 ts_ms 는 불변 — 리베이스 중 정지 커서에서도 같은 봉을 가리킨다.
  // 툴팁 내용 모델은 아래 렌더에서 현재 drawn 으로 파생하므로 SSE 틱마다 in-place 갱신된다.
  const [hover, setHover] = useState<{ tsMs: number; left: number; top: number } | null>(null);
  const clearHover = useCallback(() => {
    if (hoverRef.current === null) return;
    hoverRef.current = null;
    setHover(null);
  }, []);
  const publishHover = useCallback((next: { tsMs: number; left: number; top: number }) => {
    const prev = hoverRef.current;
    hoverRef.current = next;
    if (prev?.tsMs === next.tsMs) {
      const tip = tipRef.current;
      if (tip) {
        tip.style.left = `${next.left}px`;
        tip.style.top = `${next.top}px`;
      }
      return;
    }
    setHover(next);
  }, []);

  // 그려진 캔들 배열(projectCandle 와 동일 필터) + 두 인덱스 맵:
  //  - vsecToIndex: 가상시각(초)→index. 핸들러가 param.time(=projectCandle 의 candle.time,
  //    axis.toVirtual(ts_ms)/1000, 반올림 X)을 봉으로 변환할 때.
  //  - tsMsToIndex: ts_ms→index. 렌더가 저장된 hover.tsMs 를 현재 봉으로 변환(리베이스 안전).
  const { drawn, vsecToIndex, tsMsToIndex } = useMemo(() => {
    const drawnArr = bundle.candles.filter((c) => axis.contains(c.ts_ms));
    const vmap = new Map<number, number>();
    const tmap = new Map<number, number>();
    drawnArr.forEach((c, i) => {
      vmap.set(axis.toVirtual(c.ts_ms) / 1000, i);
      tmap.set(c.ts_ms, i);
    });
    return { drawn: drawnArr, vsecToIndex: vmap, tsMsToIndex: tmap };
  }, [bundle.candles, axis]);

  // 핸들러가 읽는 최신 데이터(drawn·vsecToIndex·paneSeries)는 ref 로 — 구독 effect 가
  // [chart, enabled] 에만 의존하게 해, 데이터 틱·pane 등록 변화로 재구독(→ 툴팁 소멸)되지
  // 않도록(스펙 §거동, ADR-0059). 매 렌더 커밋 후 sync → 다음 크로스헤어 이벤트엔 항상 최신.
  const live = useRef({ drawn, vsecToIndex, paneSeries });
  useEffect(() => { live.current = { drawn, vsecToIndex, paneSeries }; }, [drawn, vsecToIndex, paneSeries]);

  useEffect(() => {
    // 토글 OFF: 구독하지 않는다. 직전 effect 의 cleanup 이 이미 hover 를 비웠고,
    // 렌더 가드(`!enabled || !hover`)가 표시를 막으므로 여기서 setHover 불필요.
    if (!enabled) return;
    let pending: number | null = null;
    const handler = (param: MouseEventParams) => {
      if (param.point == null || typeof param.time !== 'number') {
        if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
        clearHover();
        return;
      }
      const point = param.point;
      const time = param.time as number;
      if (pending !== null) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        pending = null;
        const { drawn: d, vsecToIndex: vmap, paneSeries: ps } = live.current;
        // 캔들 페인 한정.
        if (paneIdAtY(chart, ps, point.y) !== 'candle') { clearHover(); return; }
        const vidx = vmap.get(time);
        if (vidx === undefined) { clearHover(); return; } // 봉 사이 whitespace
        const el = chart.chartElement();
        const tip = tipRef.current;
        const place = placeTooltip(
          point.x, point.y,
          el?.clientWidth ?? 0, el?.clientHeight ?? 0,
          tip?.offsetWidth ?? 160, tip?.offsetHeight ?? 130,
        );
        publishHover({ tsMs: d[vidx].ts_ms, left: place.left, top: place.top });
      });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      if (pending !== null) cancelAnimationFrame(pending);
      clearHover();
    };
  }, [chart, clearHover, enabled, publishHover]);

  // 내용 모델은 렌더에서 현재 데이터로 파생(순수) — SSE 틱/리베이스로 drawn 이 갱신되면
  // 커서를 안 움직여도 자동으로 최신 봉. 호버 봉이 사라지면(idx 부재) 숨김.
  if (!enabled || !hover) return null;
  const renderedHover = hoverRef.current?.tsMs === hover.tsMs ? hoverRef.current : hover;
  const idx = tsMsToIndex.get(renderedHover.tsMs);
  if (idx === undefined) return null;
  const m = buildCandleTooltip(drawn, idx, timeframe);
  if (!m) return null;
  return (
    <div ref={tipRef} data-testid="candle-tooltip" style={{ ...boxStyle, left: renderedHover.left, top: renderedHover.top }}>
      <div style={{ ...rowStyle, color: 'var(--fg-dim)', marginBottom: 4 }}>
        <span>{m.dateLabel}{m.timeLabel ? ` ${m.timeLabel}` : ''}</span>
      </div>
      <PriceRow k="시" price={m.open} pct={m.openPct} />
      <PriceRow k="고" price={m.high} pct={m.highPct} />
      <PriceRow k="저" price={m.low} pct={m.lowPct} />
      <PriceRow k="종" price={m.close} pct={m.closePct} />
      <Row k="직전대비">
        <span className={m.barOverBarWon == null ? undefined : priceDirClass(m.barOverBarWon)}>
          {m.barOverBarWon == null ? '—' : signed(m.barOverBarWon)}
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

// memo: fed the stable chartBundle + axis; the tooltip reads candle data + the
// hover cursor (its own store), neither tied to hoga, so an SSE tick no longer
// re-renders this DOM via the parent (2026-06-09 Phase B).
export default memo(CandleTooltip);
