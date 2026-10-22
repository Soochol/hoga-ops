import type { AftermarketExclusionReason, AftermarketExclusionResponse } from '../api/aftermarketExclusion';
import { isKrxAftermarketWindow } from '../util/stockSessions';
import { unixMsToKSTDate } from '../util/time';
import type { LiveVenueOption } from '../state/liveVenue';
import type { OrderbookAvailability } from './orderbookAvailability';

const LABELS: Record<AftermarketExclusionReason, string> = {
  etf: 'ETF', etn: 'ETN', investment_warning: '투자경고종목', investment_risk: '투자위험종목',
  administrative: '관리종목', liquidation: '정리매매종목', short_term_overheat: '단기과열종목',
  investment_caution_issue: '투자주의환기종목', low_liquidity: '초저유동종목',
  abnormal_surge: '이상급등종목', investment_caution: '투자유의종목',
};

export function aftermarketExclusionState(exclusion: AftermarketExclusionResponse | undefined,
  code: string, venue: LiveVenueOption, nowMs: number, bookMs?: number): OrderbookAvailability | null {
  if (!exclusion || exclusion.status !== 'checked' || exclusion.code !== code
    || exclusion.date !== unixMsToKSTDate(nowMs) || venue !== 'KRX' || !isKrxAftermarketWindow(nowMs)
    || exclusion.checked_at_ms == null || nowMs - exclusion.checked_at_ms < -5_000
    || nowMs - exclusion.checked_at_ms >= 120_000 || !exclusion.reasons.length) return null;
  return {
    kind: 'aftermarket_excluded',
    message: `KRX 장후 거래 제외 · ${exclusion.reasons.map(reason => LABELS[reason]).join(' · ')}`,
    detail: '16:00~20:00 KRX 애프터마켓 거래 대상이 아닙니다.',
    ...(bookMs === undefined ? {} : { lastBookMs: bookMs }),
  };
}
