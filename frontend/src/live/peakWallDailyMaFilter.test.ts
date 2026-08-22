import { describe, expect, it } from 'vitest';
import type { AskPeak } from '../api/types';
import { filterPeaksAgainstDailyMa, type PeakDailyMaFilter } from './peakWallDailyMaFilter';

function peak(date: string, price: number, over: Partial<AskPeak> = {}): AskPeak {
  return {
    date, price, qty: 1000, t_ms: 1,
    max_price: price, max_qty: 1000, max_t_ms: 1,
    ...over,
  };
}

const MA = new Map([['20260820', 100], ['20260821', 200]]);
const ASK: PeakDailyMaFilter = { side: 'ask', byDate: MA };
const BID: PeakDailyMaFilter = { side: 'bid', byDate: MA };

describe('filterPeaksAgainstDailyMa — 방향', () => {
  it('매도: 그 거래일의 일봉 MA 위 벽만 남긴다', () => {
    const out = filterPeaksAgainstDailyMa(
      [peak('20260820', 101), peak('20260820', 99)], false, ASK,
    );
    expect(out.map((p) => p.price)).toEqual([101]);
  });

  it('매수: 그 거래일의 일봉 MA 아래 벽만 남긴다', () => {
    const out = filterPeaksAgainstDailyMa(
      [peak('20260820', 101), peak('20260820', 99)], false, BID,
    );
    expect(out.map((p) => p.price)).toEqual([99]);
  });

  it('날짜마다 다른 MA 로 판정한다 — 같은 가격이라도 날에 따라 갈린다', () => {
    // 150 은 8/20(MA 100) 기준으론 위, 8/21(MA 200) 기준으론 아래다.
    const out = filterPeaksAgainstDailyMa(
      [peak('20260820', 150), peak('20260821', 150)], false, ASK,
    );
    expect(out.map((p) => p.date)).toEqual(['20260820']);
  });

  it('MA 와 정확히 같은 가격은 위도 아래도 아니다 — 양쪽 다 제외', () => {
    expect(filterPeaksAgainstDailyMa([peak('20260820', 100)], false, ASK)).toEqual([]);
    expect(filterPeaksAgainstDailyMa([peak('20260820', 100)], false, BID)).toEqual([]);
  });
});

describe('filterPeaksAgainstDailyMa — fail-open', () => {
  it('filter=null 이면 손대지 않는다', () => {
    const peaks = [peak('20260820', 1), peak('20260820', 1_000_000)];
    expect(filterPeaksAgainstDailyMa(peaks, false, null)).toEqual(peaks);
  });

  it('일봉 데이터가 아직 없으면(빈 맵) 손대지 않는다 — 로딩 중 깜빡임 방지', () => {
    const peaks = [peak('20260820', 1)];
    expect(filterPeaksAgainstDailyMa(peaks, false, { side: 'ask', byDate: new Map() }))
      .toEqual(peaks);
  });

  it('그 날의 MA 가 없으면(warm-up·공백일) 그 벽은 남는다', () => {
    // 8/19 는 맵에 없다 — 다른 날은 정상 판정되는 옆에서 이 날만 통과해야 한다.
    const out = filterPeaksAgainstDailyMa(
      [peak('20260819', 1), peak('20260820', 1)], false, ASK,
    );
    expect(out.map((p) => p.date)).toEqual(['20260819']);
  });

  it('가격이 유한하지 않은 벽은 남긴다', () => {
    const broken = peak('20260820', 0, { price: null, max_price: null });
    expect(filterPeaksAgainstDailyMa([broken], false, ASK)).toEqual([broken]);
  });
});

describe('filterPeaksAgainstDailyMa — intraMax 축 선택', () => {
  it('intraMax 면 max_price 로 판정한다', () => {
    // close 축은 MA 위(150), max 축은 MA 아래(50) — 켜고 끄면 결과가 뒤집힌다.
    const p = peak('20260820', 150, { max_price: 50 });
    expect(filterPeaksAgainstDailyMa([p], false, ASK)).toHaveLength(1);
    expect(filterPeaksAgainstDailyMa([p], true, ASK)).toHaveLength(0);
  });
});
