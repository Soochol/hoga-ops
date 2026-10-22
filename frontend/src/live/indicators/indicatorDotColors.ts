import { lineVisible } from '../../state/indicatorLineVisibility';
import { resolveMaColor } from '../../util/maColor';
import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import type { CategoryId } from './IndicatorPanelHelpers';

/** 한 행에 찍는 색 점의 최대 개수.
 *
 *  이동평균은 슬롯이 8개까지 늘고 최대벽은 방향×계열로 6개까지 켜진다. 전부 찍으면
 *  240px nav 에서 라벨이 잘리고, 애초에 여섯 개짜리 색 띠는 "무슨 색인지" 를 말하지
 *  못한다. 넷은 기본 이동평균 슬롯 수와 같아서 평시엔 잘림이 없다. */
export const INDICATOR_DOT_LIMIT = 4;

/**
 * nav 행의 색 점 — **차트에 실제로 그려지는 색의 메아리**다.
 *
 * 이 점들이 장식이 아니라 데이터인 것이 요점이다. 같은 색이 패널 행 · 레전드 칩 ·
 * 캔버스 선 세 곳에 나오므로, "이 행이 저 선" 이라는 연결이 이름을 읽지 않아도 선다.
 * 직접 지정은 저장된 색을 쓰고, 자동은 캔버스·범례와 같은 resolver 를 쓴다.
 *
 * ## 색 점이 없는 지표가 있다 (의도)
 *
 * 16종 중 여덟(거래량 · 거래대금 · 총잔량 · 호가비 · 체결강도 · 프로그램 순매수 · 투자자 순매수
 * 둘)은 **사용자가 고르는 색이 없다**. 부호색(적/청)이나 차트 스펙이 정하는 색으로
 * 그려지므로 "그 지표의 색" 이라는 것이 존재하지 않는다. 목업은 거래량·체결강도에
 * 점을 그렸지만 그건 일러스트였고, 실제로 찍으려면 없는 값을 지어내야 한다 —
 * 지어낸 색은 차트와 어긋나는 순간 거짓말이 된다. 점이 없는 것이 정직하다.
 */
export function dotColorsFor(id: CategoryId, ind: IndicatorSettings, theme?: string): string[] {
  const capped = (colors: string[]) => colors.slice(0, INDICATOR_DOT_LIMIT);

  switch (id) {
    case 'supertrend':
      return [ind.supertrendUpColor, ind.supertrendDownColor].filter((_, i) => lineVisible(ind.indicatorLineVisibility, i ? 'supertrendDown' : 'supertrendUp'));
    case 'bollinger':
      return [ind.bollingerUpperColor, ind.bollingerMiddleColor, ind.bollingerLowerColor].filter((_, i) => lineVisible(ind.indicatorLineVisibility, (['bollingerUpper', 'bollingerMiddle', 'bollingerLower'] as const)[i]));
    case 'envelope':
      return [ind.envelopeUpperColor, ind.envelopeMiddleColor, ind.envelopeLowerColor].filter((_, i) => lineVisible(ind.indicatorLineVisibility, (['envelopeUpper', 'envelopeMiddle', 'envelopeLower'] as const)[i]));
    case 'moving-average':
      return capped(ind.movingAverages.filter((m) => m.enabled && !m.hidden).map((m) => resolveMaColor(m, theme)));
    case 'daily-moving-average':
      return capped(ind.dailyMovingAverages.filter((m) => m.enabled && !m.hidden).map((m) => resolveMaColor(m, theme)));

    // 방향 마스터가 꺼져 있으면 그 방향의 계열은 아무것도 안 그려진다 — 켜진 계열의
    // 색만 모은다. 순서는 매도(체결·미도달·전체) → 매수 로 매트릭스 읽는 순서와 같다.
    case 'peak-walls': {
      const colors: string[] = [];
      if (ind.askPeakEnabled) {
        if (ind.askPeakTradedLineEnabled) colors.push(ind.askPeakColor);
        if (ind.askPeakUnreachedLineEnabled) colors.push(ind.askPeakUnreachedColor);
        if (ind.askPeakAllWallLineEnabled) colors.push(ind.askPeakAllWallColor);
      }
      if (ind.bidPeakEnabled) {
        if (ind.bidPeakTradedLineEnabled) colors.push(ind.bidPeakColor);
        if (ind.bidPeakUnreachedLineEnabled) colors.push(ind.bidPeakUnreachedColor);
        if (ind.bidPeakAllWallLineEnabled) colors.push(ind.bidPeakAllWallColor);
      }
      return capped(colors);
    }

    case 'trade-volume-poc':
      return [ind.tradeVolumePocColor];
    case 'depth-heatmap':
      return [ind.depthHeatmapBidColor, ind.depthHeatmapAskColor];
    case 'volume-distribution':
      return [ind.volumeDistributionColor, ind.volumeDistributionMaxColor];

    // 세트마다 매수·매도 색이 따로고, `sideMode` 가 그중 실제로 그려지는 쪽을 정한다.
    case 'broker-late-entry': {
      const colors: string[] = [];
      for (const entry of ind.brokerLateEntries) {
        if (!entry.enabled) continue;
        if (entry.sideMode !== 'sell') colors.push(entry.buyColor);
        if (entry.sideMode !== 'buy') colors.push(entry.sellColor);
      }
      return capped(colors);
    }

    default:
      return [];
  }
}
