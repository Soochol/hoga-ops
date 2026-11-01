export type RankingSessionState = 'open' | 'closed' | 'preopen' | 'holiday' | 'calendar_unavailable';
export type RankingBasisSource = 'live' | 'stored' | 'unavailable';
export interface RankingBasis {
  session: RankingSessionState;
  source: RankingBasisSource;
  trading_date: string | null;
  observed_at_ms: number | null;
  message: string | null;
}

export const rankingSessionLabel = (session: RankingSessionState): string | null => ({
  open: null, closed: '장 외', preopen: '장전', holiday: '휴장', calendar_unavailable: '달력 확인 필요',
})[session];

export function rankingBasisText(basis?: RankingBasis | null): string | null {
  if (!basis) return null;
  if (basis.source === 'unavailable') return basis.message ?? '순위 기준을 확인할 수 없습니다';
  const observed = new Date((basis.observed_at_ms ?? NaN) + 9 * 60 * 60 * 1000);
  const time = Number.isFinite(observed.getTime()) ? observed.toISOString().slice(11, 19) : '';
  return `${basis.trading_date ?? '기준일 미확인'} ${time} 관측${basis.source === 'stored' ? ' · 저장된 순위' : ''}`;
}
