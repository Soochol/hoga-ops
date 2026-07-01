import { memo, useEffect, useRef } from 'react';
import type { IPriceLine, PriceLineOptions } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { useQuoteByCode } from '../api/liveQuotes';
import { useLiveVenueStore } from '../state/liveVenue';
import { resolveTokens } from '../util/tokens';
import { deriveCurrentPriceLine } from './deriveCurrentPriceLine';

// DESIGN.md 토큰 → 색 문자열(canvas 가 var(--…) 를 못 받음). candle.ts 와 동일 토큰.
const TOKENS = resolveTokens({
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
  neutral: ['--fg-dim', '#94A3B8'],
});

type Props = {
  paneSeries: PaneSeriesMap;
  bundle: RangeBundle;
  code: string | null;
};

/**
 * /live 캔들 차트의 현재가 라인 오버레이. 캔들 primary series 에 native price
 * line 하나를 걸어 (1) 마지막 캔들 종가 수평 점선 + (2) y축 가격 태그를 그린다.
 * 색은 전일 대비 등락 방향(Status Bar 와 동일, change_won ?? change_pct).
 * 캔들 시리즈 옵션은 건드리지 않아 전역 priceLineVisible/lastValueVisible=false
 * 컨벤션을 보존한다. 형제 패턴: DrawingOverlay / indicators/MovingAverageOverlay.
 * 설계 근거: docs/superpowers/specs/2026-06-03-live-current-price-line-design.md.
 */
function LiveCurrentPriceLine({ paneSeries, bundle, code }: Props) {
  const series = paneSeries.get('candle' as PaneId);
  const venue = useLiveVenueStore((s) => s.venue);
  const quote = useQuoteByCode(code ? [code] : [], venue).get(code ?? '');
  const model = deriveCurrentPriceLine(bundle, quote, TOKENS);
  const lineRef = useRef<IPriceLine | null>(null);

  // 생성: 시리즈 핸들당 1회. candle 시리즈는 RangeSeriesPane 의 생성 effect deps
  // 가 [chart, paneIndex, spec] 라 타임프레임·종목 전환에도 핸들이 유지된다 →
  // 라인은 재생성되지 않고 persist 하며, 가격/색은 아래 update effect 로 흐른다
  // (스위치마다 teardown flicker 없음). [series] cleanup 은 실제 핸들이 바뀌는
  // 경우(chart 재생성/pane 제거) 의 안전망이다 — 이전 라인을 제거한다.
  useEffect(() => {
    if (!series) return;
    // `as PriceLineOptions`: lightweight-charts 가 lineVisible 등을 required 로
    // 선언하나 런타임은 optional 취급 — 선례 chart/util/zeroBaseline.ts:29.
    const line = series.createPriceLine({
      price: model?.price ?? 0,
      color: model?.color ?? TOKENS.neutral,
      lineWidth: 1,
      lineStyle: 2, // dashed (= LineStyle.Dashed; zeroBaseline.ts 와 동일 숫자 표기)
      lineVisible: model != null,
      axisLabelVisible: model != null,
      axisLabelColor: model?.color ?? TOKENS.neutral,
      title: '',
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try { series.removePriceLine(line); } catch { /* chart already torn down */ }
      lineRef.current = null;
    };
    // model 은 생성 시점값만 사용(이후 update effect 가 보정). series 핸들 churn
    // 방지를 위해 deps 는 [series] 만 — RangeSeriesPane 의 동일 의도적 분리.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  // 갱신: 가격/색 변경 시에만. price/color 를 원시값으로 추출해 deps 로 쓰면
  // bundle.candles 가 SSE 틱마다 새 식별자를 받아도(메모리: live_bundle_identity_churn)
  // 이 effect 는 재실행 안 되고, exhaustive-deps 도 suppression 없이 만족한다.
  const price = model?.price;
  const color = model?.color;
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    if (price == null || color == null) {
      line.applyOptions({ lineVisible: false, axisLabelVisible: false });
      return;
    }
    line.applyOptions({
      price,
      color,
      axisLabelColor: color,
      lineVisible: true,
      axisLabelVisible: true,
    });
  }, [price, color]);

  return null;
}

// memo: fed the stable chartBundle (price derives from candles, not hoga), so an
// SSE tick no longer re-renders it via the parent (2026-06-09 Phase B).
export default memo(LiveCurrentPriceLine);
