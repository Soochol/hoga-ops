import type { Fund } from './report';

export const FUND_COLUMNS = [
  { key: 'name', label: 'ETF' },
  { key: 'score', label: '원점수' },
  { key: 'd5', label: '5일 변화' },
  { key: 'd20', label: '20일 변화' },
  { key: 'streak', label: '연속 개선' },
  { key: 'up5', label: '최근 5일 개선' },
] as const;
export type FundSortKey = typeof FUND_COLUMNS[number]['key'];
export type FundSort = { key: FundSortKey; direction: 'ascending' | 'descending' } | null;

export function nextFundSort(current: FundSort, key: FundSortKey): FundSort {
  if (current?.key !== key) return { key, direction: 'ascending' };
  return current.direction === 'ascending' ? { key, direction: 'descending' } : null;
}

/** Default: longest current recovery streak; missing values always come last. */
export function sortFunds(funds: Fund[], sort: FundSort): Fund[] {
  const { key, direction } = sort ?? { key: 'streak', direction: 'descending' };
  const value = (fund: Fund) => key === 'streak' || key === 'up5' ? fund.persistence[key] : fund[key];
  return [...funds].sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av == null || bv == null) return av == null && bv == null ? a.code.localeCompare(b.code) : av == null ? 1 : -1;
    const comparison = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv, 'ko') : Number(av) - Number(bv);
    return comparison * (direction === 'ascending' ? 1 : -1) || a.code.localeCompare(b.code);
  });
}
