import { describe, expect, it } from 'vitest';
import type { Candle } from '../api/types';
import { collapseClosingAuction } from './collapseClosingAuction';

// 2026-08-05(수) 정규장. regularSessionOpenMs 와 같은 식으로 09:00 KST 를 잡는다.
const OPEN_20260805 = Date.UTC(2026, 7, 5, 0, 0, 0);
const OPEN_20260806 = Date.UTC(2026, 7, 6, 0, 0, 0);

/** 그날 09:00 을 기준으로 HH:MM 의 ms. */
function at(open: number, h: number, m: number): number {
  return open + ((h - 9) * 60 + m) * 60_000;
}

function candle(ts: number, o: number, h: number, l: number, c: number, vol = 0): Candle {
  return { ts_ms: ts, open: o, high: h, low: l, close: c, vol_a: vol, vol_b: 0 };
}

describe('collapseClosingAuction', () => {
  it('동시호가 창의 봉들을 마지막 하나로 접고 단일가로 평탄화한다', () => {
    const input = [
      candle(at(OPEN_20260805, 15, 18), 1700000, 1702000, 1699000, 1701000, 5000),
      candle(at(OPEN_20260805, 15, 19), 1701000, 1701000, 1698000, 1699000, 4000),
      // 창 안 — 예상체결가 doji 들
      candle(at(OPEN_20260805, 15, 21), 1690000, 1690000, 1690000, 1690000, 0),
      candle(at(OPEN_20260805, 15, 25), 1675000, 1675000, 1675000, 1675000, 0),
      // 확정 단일가 봉 — 벤더가 예상가(open)에서 확정가(close)로 벌려 보낸다
      candle(at(OPEN_20260805, 15, 30), 1699000, 1699000, 1668000, 1668000, 120000),
    ];

    const out = collapseClosingAuction(input);

    expect(out).toHaveLength(3);
    expect(out[0]).toBe(input[0]); // 창 밖은 그대로 통과(identity 포함)
    expect(out[1]).toBe(input[1]);
    expect(out[2]).toEqual({
      ts_ms: at(OPEN_20260805, 15, 30),
      open: 1668000,
      high: 1668000,
      low: 1668000,
      close: 1668000,
      vol_a: 120000,
      vol_b: 0,
    });
  });

  it('거래량을 합산하지 않는다 — 창 안 봉의 거래량은 실거래량이 아니다', () => {
    const out = collapseClosingAuction([
      candle(at(OPEN_20260805, 15, 22), 1000, 1000, 1000, 1000, 777),
      candle(at(OPEN_20260805, 15, 30), 1000, 1000, 900, 900, 50000),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].vol_a).toBe(50000);
  });

  it('창 안 봉이 하나뿐이어도 평탄화한다', () => {
    const out = collapseClosingAuction([
      candle(at(OPEN_20260805, 15, 30), 1699000, 1699000, 1668000, 1668000, 120000),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(1668000);
    expect(out[0].high).toBe(1668000);
    expect(out[0].low).toBe(1668000);
  });

  it('이미 평탄한 봉은 같은 객체를 돌려준다 — 캔들 캐시의 identity 비교를 흔들지 않는다', () => {
    const flat = candle(at(OPEN_20260805, 15, 30), 1668000, 1668000, 1668000, 1668000, 120000);
    const out = collapseClosingAuction([flat]);

    expect(out[0]).toBe(flat);
  });

  it('날짜마다 따로 접는다', () => {
    const input = [
      candle(at(OPEN_20260805, 15, 21), 1000, 1000, 1000, 1000),
      candle(at(OPEN_20260805, 15, 30), 1000, 1000, 900, 900),
      candle(at(OPEN_20260806, 9, 0), 900, 950, 900, 940),
      candle(at(OPEN_20260806, 15, 25), 940, 940, 940, 940),
      candle(at(OPEN_20260806, 15, 30), 940, 940, 910, 910),
    ];

    const out = collapseClosingAuction(input);

    expect(out.map((c) => c.ts_ms)).toEqual([
      at(OPEN_20260805, 15, 30),
      at(OPEN_20260806, 9, 0),
      at(OPEN_20260806, 15, 30),
    ]);
    expect(out[0].open).toBe(900);
    expect(out[2].open).toBe(910);
  });

  it('창 밖 봉은 절대 건드리지 않는다 — 15:19 는 몸통을 유지한다', () => {
    const bar = candle(at(OPEN_20260805, 15, 19), 1701000, 1702000, 1698000, 1699000, 4000);
    const out = collapseClosingAuction([bar]);

    expect(out[0]).toBe(bar);
  });

  it('반휴장일은 effective_sessions 의 마감 시각에 창을 앵커한다', () => {
    const closeMs = at(OPEN_20260805, 12, 30); // 12:30 마감 → 창 [12:20, 12:30]
    const sessions = new Map([['20260805', { close_ms: closeMs }]]);
    const input = [
      candle(at(OPEN_20260805, 12, 15), 1000, 1010, 990, 1005, 100),
      candle(at(OPEN_20260805, 12, 22), 1005, 1005, 1005, 1005, 0),
      candle(closeMs, 1005, 1005, 980, 980, 9000),
    ];

    const out = collapseClosingAuction(input, sessions);

    expect(out).toHaveLength(2);
    expect(out[0]).toBe(input[0]); // 12:15 는 창 밖
    expect(out[1]).toEqual({
      ts_ms: closeMs, open: 980, high: 980, low: 980, close: 980, vol_a: 9000, vol_b: 0,
    });
  });

  it('effective_sessions 에 없는 날짜는 기본 15:30 마감으로 폴백한다', () => {
    const sessions = new Map([['20260806', { close_ms: at(OPEN_20260806, 12, 30) }]]);
    const out = collapseClosingAuction(
      [
        candle(at(OPEN_20260805, 15, 21), 1000, 1000, 1000, 1000),
        candle(at(OPEN_20260805, 15, 30), 1000, 1000, 900, 900),
      ],
      sessions,
    );

    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(900);
  });

  it('바꿀 게 없으면 입력 배열 자체를 돌려준다 — bundle.candles identity 를 흔들지 않는다', () => {
    const input = [
      candle(at(OPEN_20260805, 9, 0), 1000, 1010, 990, 1005, 100),
      candle(at(OPEN_20260805, 15, 19), 1005, 1007, 1000, 1002, 80),
      // 창 안이지만 이미 평탄 → 접을 것도 평탄화할 것도 없다
      candle(at(OPEN_20260805, 15, 30), 1002, 1002, 1002, 1002, 9000),
    ];

    expect(collapseClosingAuction(input)).toBe(input);
  });

  it('빈 입력은 그대로 돌려준다', () => {
    const empty: Candle[] = [];
    expect(collapseClosingAuction(empty)).toBe(empty);
  });
});
