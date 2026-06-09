/**
 * 종목별 수집 상태 (순수함수). ADR-0067:
 * - realtime    : code가 live_set(WS 실시간 수집)에 있음
 * - polling      : live_set 밖이지만 현재 보는 종목(REST 화면 표시 중, 준실시간)
 * - waiting_eod  : watchlist엔 있으나 live_set 밖 + 안 보는 중 (관심종목 26 초과 폴백; 정상 운영에선 드묾)
 * - uncollected  : 그 외 (관심종목 밖 + 안 보는 중)
 */
export type CollectionStatus = 'realtime' | 'polling' | 'waiting_eod' | 'uncollected';

export function deriveCollectionStatus(
  code: string | null,
  liveSet: string[],
  watchlistCodes: string[],
  viewedCodes: string[],
): CollectionStatus {
  if (!code) return 'uncollected';
  if (liveSet.includes(code)) return 'realtime';
  if (viewedCodes.includes(code)) return 'polling';
  if (watchlistCodes.includes(code)) return 'waiting_eod';
  return 'uncollected';
}
