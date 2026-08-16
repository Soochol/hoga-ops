import { describe, it, expect } from 'vitest';
import type { RangeBundle, QuoteRatioPoint } from '../api/types';
import { deriveQuoteTotalsDayMax, deriveQuoteTotalsLevels, deriveRatioLevel } from './deriveQuoteLevelLines';

const pt = (over: Partial<QuoteRatioPoint>): QuoteRatioPoint => ({
  t: 0,
  bid_total: 0,
  ask_total: 0,
  bid_max: 0,
  ask_max: 0,
  imb_max_bid: 0,
  imb_max_ask: 0,
  ...over,
});

// candles=[] keeps withHogaGapSentinels from injecting gap sentinels, so the
// projected points equal the input points for these unit tests.
const bundleOf = (points: QuoteRatioPoint[]): RangeBundle =>
  ({ quote_ratio: { bucket_ms: 60_000, points }, candles: [], bucket_ms: 60_000 } as unknown as RangeBundle);

describe('deriveQuoteTotalsLevels', () => {
  it('returns the last bucket bid/ask totals (intraMax=false)', () => {
    const b = bundleOf([
      pt({ t: 1, bid_total: 100, ask_total: 200 }),
      pt({ t: 2, bid_total: 300, ask_total: 400 }),
    ]);
    expect(deriveQuoteTotalsLevels(b, false)).toEqual({ bid: 300, ask: 400 });
  });

  it('uses bid_max/ask_max when intraMax=true', () => {
    const b = bundleOf([pt({ t: 1, bid_total: 100, ask_total: 200, bid_max: 500, ask_max: 600 })]);
    expect(deriveQuoteTotalsLevels(b, true)).toEqual({ bid: 500, ask: 600 });
  });

  it('skips a synthetic hoga-gap tail point', () => {
    const b = bundleOf([
      pt({ t: 1, bid_total: 100, ask_total: 200 }),
      { ...pt({ t: 2 }), __syntheticHogaGap: true } as unknown as QuoteRatioPoint,
    ]);
    expect(deriveQuoteTotalsLevels(b, false)).toEqual({ bid: 100, ask: 200 });
  });

  it('returns null for an empty bundle', () => {
    expect(deriveQuoteTotalsLevels(bundleOf([]), false)).toBeNull();
  });
});

/** KST(UTC+9) 기준 2026-08-<day> <h>:<m> 의 epoch ms. 거래일 경계(KST 자정)를 실제로 넘는
 *  픽스처를 만들기 위해 필요 — 상대 오프셋으로는 그 축이 테스트에서 지워진다. */
const kst = (day: number, h: number, m = 0): number => Date.UTC(2026, 7, day, h - 9, m);
const noAuction = (): boolean => false;
/** 마감 동시호가 술어 — 실제 축과 같은 모양(시각 → boolean). 15:20 이후를 동시호가로 본다. */
const closingAfter1520 = (t: number): boolean => t >= kst(14, 15, 20);

describe('deriveQuoteTotalsDayMax', () => {
  it('마지막 거래일의 최댓값만 잡는다 — 그 전날이 더 커도 무시', () => {
    const b = bundleOf([
      pt({ t: kst(13, 10), bid_total: 9_999, ask_total: 8_888 }), // 전날 — 넘어오면 안 됨
      pt({ t: kst(14, 9), bid_total: 100, ask_total: 200 }),
      pt({ t: kst(14, 10), bid_total: 500, ask_total: 300 }),
      pt({ t: kst(14, 11), bid_total: 200, ask_total: 700 }),
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toEqual({ bid: 500, ask: 700, t: kst(14, 11) });
  });

  // 규칙 3의 핵심: 「엄격히 오늘」이었다면 여기서 null 이었다. 데이터가 8/14 에서 끝나면
  // 그날이 기준일이고, 지금이 주말이든 /study 든 기준선은 남는다(호출부가 날짜를 라벨에 붙인다).
  it('데이터가 어제에서 끝나도 그날 최댓값을 낸다 — 주말·장 마감 후·/study 가 이 경로다', () => {
    const b = bundleOf([
      pt({ t: kst(13, 10), bid_total: 500, ask_total: 400 }),
      pt({ t: kst(13, 14), bid_total: 300, ask_total: 900 }),
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toEqual({ bid: 500, ask: 900, t: kst(13, 14) });
  });

  it('배열 끝이 gap 센티넬이어도 앵커는 마지막 실제 점 — 기준일이 흔들리지 않는다', () => {
    const b = bundleOf([
      pt({ t: kst(14, 10), bid_total: 500, ask_total: 400 }),
      { ...pt({ t: kst(14, 11) }), __syntheticHogaGap: true } as unknown as QuoteRatioPoint,
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toEqual({ bid: 500, ask: 400, t: kst(14, 10) });
  });

  it('매수·매도가 서로 다른 시각에 최고여도 각각 잡는다', () => {
    const b = bundleOf([
      pt({ t: kst(14, 9), bid_total: 900, ask_total: 10 }),
      pt({ t: kst(14, 10), bid_total: 10, ask_total: 800 }),
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toEqual({ bid: 900, ask: 800, t: kst(14, 10) });
  });

  it('마감 동시호가 구간은 최댓값에서 제외한다', () => {
    const b = bundleOf([
      pt({ t: kst(14, 10), bid_total: 500, ask_total: 400 }),
      pt({ t: kst(14, 15, 25), bid_total: 90_000, ask_total: 80_000 }), // 동시호가 폭증
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, closingAfter1520)).toMatchObject({ bid: 500, ask: 400 });
    // 대조군: 배제하지 않으면 그 폭증이 그대로 최댓값이 된다 — 위 단언이 실제로 배제를 재는지 확인.
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toMatchObject({ bid: 90_000, ask: 80_000 });
  });

  it('intraMax=true 면 분봉 내 최댓값(bid_max/ask_max)을 쓴다', () => {
    const b = bundleOf([
      pt({ t: kst(14, 10), bid_total: 100, ask_total: 200, bid_max: 700, ask_max: 600 }),
      pt({ t: kst(14, 11), bid_total: 300, ask_total: 400, bid_max: 350, ask_max: 450 }),
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toMatchObject({ bid: 300, ask: 400 });
    expect(deriveQuoteTotalsDayMax(b, true, noAuction)).toMatchObject({ bid: 700, ask: 600 });
  });

  it('hoga-gap 센티넬과 NaN 은 최댓값을 오염시키지 않는다', () => {
    const b = bundleOf([
      pt({ t: kst(14, 10), bid_total: 500, ask_total: 400 }),
      { ...pt({ t: kst(14, 11), bid_total: 99_999, ask_total: 99_999 }), __syntheticHogaGap: true } as unknown as QuoteRatioPoint,
      pt({ t: kst(14, 12), bid_total: Number.NaN, ask_total: Number.NaN }),
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toMatchObject({ bid: 500, ask: 400 });
  });

  it('빈 번들은 null', () => {
    expect(deriveQuoteTotalsDayMax(bundleOf([]), false, noAuction)).toBeNull();
  });

  it('그날 점이 전부 (0,0) 센티넬이면 null — pane 바닥에 붙은 선을 그리지 않는다', () => {
    const b = bundleOf([
      pt({ t: kst(14, 10), bid_total: 0, ask_total: 0 }),
      pt({ t: kst(14, 11), bid_total: 0, ask_total: 0 }),
    ]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toBeNull();
  });

  it('한쪽만 유효하면 null — 현재값 수평선과 동일한 all-or-nothing 계약', () => {
    const b = bundleOf([pt({ t: kst(14, 10), bid_total: 500, ask_total: 0 })]);
    expect(deriveQuoteTotalsDayMax(b, false, noAuction)).toBeNull();
  });
});

describe('deriveRatioLevel', () => {
  it('is positive when ask dominates (sell heavy)', () => {
    const v = deriveRatioLevel(bundleOf([pt({ t: 1, bid_total: 100, ask_total: 200 })]), false);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(0);
  });

  it('is negative when bid dominates (buy heavy)', () => {
    const v = deriveRatioLevel(bundleOf([pt({ t: 1, bid_total: 300, ask_total: 100 })]), false);
    expect(v as number).toBeLessThan(0);
  });

  it('uses imb_max fields when intraMax=true', () => {
    const v = deriveRatioLevel(bundleOf([pt({ t: 1, imb_max_bid: 100, imb_max_ask: 200 })]), true);
    expect(v as number).toBeGreaterThan(0);
  });

  it('returns null for an empty bundle', () => {
    expect(deriveRatioLevel(bundleOf([]), false)).toBeNull();
  });
});
