import { useEffect, useRef } from 'react';
import type { IPriceLine, ISeriesApi, PriceLineOptions, SeriesType } from 'lightweight-charts';
import type { LineStyle } from '../chart/drawing/types';
import { toLwcLineStyle } from '../chart/util/lineStyle';

type Props = {
  /** Pane primary series to hang the price line on. Undefined when the pane
   *  isn't mounted (e.g. D/W/M timeframe) → renders nothing. */
  series: ISeriesApi<SeriesType> | undefined;
  /** Current value on the pane's Y-domain, or null to hide the line. */
  price: number | null;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  lineStyle: LineStyle;
  /** Master visibility. When false the line stays created but hidden — avoids
   *  churning the handle on a toggle flip. */
  enabled: boolean;
  /** 라인 옆 텍스트. 같은 pane 에 성격이 다른 수평선이 여럿일 때(현재값 vs 당일 최고)
   *  구분자 역할 — 신고가를 갱신하는 순간 두 값이 정확히 같아져 선이 포개진다.
   *  미지정이면 '' → 종전 동작 그대로. */
  title?: string;
};

/**
 * One native `IPriceLine` on a pane's primary series that tracks a live value
 * (총잔량 매수/매도, 호가비 등). Mirrors LiveCurrentPriceLine's create-once /
 * update-on-primitive-deps split so an SSE tick (which churns the bundle
 * identity) never re-creates the handle — only the value/style flow through
 * the update effect. The pane's own `priceFormat` drives the y-axis tag, so the
 * label reads in the pane's units (잔량 count / imbalance ratio) automatically.
 */
export default function SeriesLevelLine({ series, price, color, lineWidth, lineStyle, enabled, title = '' }: Props) {
  const lineRef = useRef<IPriceLine | null>(null);

  // Create once per series handle. Starts hidden; the update effect reveals it
  // when enabled + price is available. `as PriceLineOptions`: lightweight-charts
  // marks some fields required though the runtime treats them optional
  // (선례 chart/util/zeroBaseline.ts, LiveCurrentPriceLine.tsx).
  useEffect(() => {
    if (!series) return;
    const line = series.createPriceLine({
      price: 0,
      color,
      lineWidth,
      lineStyle: toLwcLineStyle(lineStyle),
      lineVisible: false,
      axisLabelVisible: false,
      axisLabelColor: color,
      title,
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try { series.removePriceLine(line); } catch { /* chart already torn down */ }
      lineRef.current = null;
    };
    // Only the series handle drives (re)creation — style/price flow via the
    // update effect. Matches LiveCurrentPriceLine's intentional split.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  const show = enabled && price != null;
  // `series` 가 deps 에 있어야 한다 — 라인은 **숨김으로 태어나** 이 effect 의 reveal 에
  // 전적으로 의존하는데, 생성은 series 도착 시점에 일어나고 `lineRef.current` 대입은
  // 재렌더를 일으키지 않는다. series 를 빼면 "라인이 이제 생겼다" 가 관측 불가능한
  // 이벤트가 되어, **값이 series 보다 먼저 안정화된 경로에서 라인이 영구히 숨겨진다**
  // (price 0 · lineVisible false 로 고착 — #1338).
  //
  // `/study` 가 정확히 그 순서다: 번들이 react-query 캐시에서 완성된 채 첫 렌더에
  // 들어오고 pane primary series 는 자식 effect 로 한 커밋 뒤에 온다. `/live` 는 SSE
  // 틱이 price 를 계속 흔들어 이 구멍을 가려 왔다 — 증상이 한쪽 페이지에만 보인
  // 이유이지 `/study` 고유 결함이 아니다.
  //
  // 형제 `LiveCurrentPriceLine` 이 멀쩡한 것은 생성 옵션을 model 로 시드하기
  // 때문이다. 여기서 그 방식을 따르지 않는 이유는 옵션 조립이 두 곳으로 갈리기
  // 때문 — 이 effect 를 값의 유일한 권위로 두고, 생성은 숨김 기본값만 잡는다.
  useEffect(() => {
    const line = lineRef.current;
    if (!series || !line) return;
    if (!show || price == null) {
      line.applyOptions({ lineVisible: false, axisLabelVisible: false });
      return;
    }
    line.applyOptions({
      price,
      color,
      lineWidth,
      lineStyle: toLwcLineStyle(lineStyle),
      axisLabelColor: color,
      lineVisible: true,
      axisLabelVisible: true,
      title,
    });
  }, [series, show, price, color, lineWidth, lineStyle, title]);

  return null;
}
