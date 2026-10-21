import { useMemo } from 'react';
import { useChartPrefsStore } from '../state/chartPrefs';

export interface TradeHighlightConfig {
  /** 원(₩) 단위. 설정의 만원 값은 구독 훅에서 환산한다. */
  thresholdWon: number;
  /** 6자리 hex. */
  color: string;
}

/** 체결창·10호가·호가주문의 공통 강조 설정. */
export function useTradeHighlight(): TradeHighlightConfig | null {
  const enabled = useChartPrefsStore(s => s.tradeHighlightEnabled);
  const thresholdManwon = useChartPrefsStore(s => s.tradeHighlightThresholdManwon);
  const color = useChartPrefsStore(s => s.tradeHighlightColor);
  return useMemo(() => enabled ? { thresholdWon: thresholdManwon * 10_000, color } : null,
    [enabled, thresholdManwon, color]);
}

/** 약 35% 알파로 매수·매도 글자색을 보존한다. 수량 칸에만 적용한다. */
export function tradeHighlightBackground(trade: { price: number; qty: number }, highlight: TradeHighlightConfig | null) {
  return highlight !== null && trade.price * trade.qty >= highlight.thresholdWon
    ? `${highlight.color}59` : undefined;
}
