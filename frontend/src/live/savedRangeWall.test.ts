import { describe, expect, it } from 'vitest';
import {
  clampLogicalRangeToWall,
  countBarsInRange,
  savedRangeWallBarIndex,
  savedRangeWallLimit,
} from './savedRangeWall';
import { minuteRightOffsetBars } from './minuteViewportPolicy';

const bars = (n: number, startMs = 1_000_000): { ts_ms: number }[] =>
  Array.from({ length: n }, (_, i) => ({ ts_ms: startMs + i * 60_000 }));

describe('savedRangeWallBarIndex', () => {
  it('저장 끝(B)에 봉이 있으면 그 봉의 인덱스', () => {
    const candles = bars(10);
    expect(savedRangeWallBarIndex(candles, candles[6].ts_ms)).toBe(6);
  });

  it('B 시각에 봉이 없으면 **그 이전 마지막 봉** — 마감 후/휴장일 경계가 이 경우다', () => {
    const candles = bars(10);
    // 6번과 7번 사이의 시각: 6번이 벽이어야 한다.
    expect(savedRangeWallBarIndex(candles, candles[6].ts_ms + 30_000)).toBe(6);
  });

  it('B 가 첫 봉보다 과거면 null — 벽을 세울 자리가 없다', () => {
    const candles = bars(10);
    expect(savedRangeWallBarIndex(candles, candles[0].ts_ms - 1)).toBeNull();
  });

  it('B 가 마지막 봉보다 미래면 마지막 봉 (백필이 아직 안 왔거나 저장이 최근)', () => {
    const candles = bars(10);
    expect(savedRangeWallBarIndex(candles, candles[9].ts_ms + 10 * 60_000)).toBe(9);
  });

  it('빈 배열은 null', () => {
    expect(savedRangeWallBarIndex([], 1)).toBeNull();
  });
});

describe('savedRangeWallLimit', () => {
  it('벽 봉에 가격축 거터를 더한다 — 벽 봉이 라벨에 가리면 안 된다', () => {
    const gutter = minuteRightOffsetBars(120, 800);
    expect(savedRangeWallLimit(500, 120, 800)).toBe(500 + gutter);
    // 거터가 실제로 0보다 크지 않으면 이 테스트는 아무것도 증명하지 않는다.
    expect(gutter).toBeGreaterThan(0);
  });
});

describe('clampLogicalRangeToWall', () => {
  it('이미 벽 안이면 null — 호출부가 setVisibleLogicalRange 를 건너뛰어야 루프가 없다', () => {
    expect(clampLogicalRangeToWall({ from: 100, to: 200 }, 300)).toBeNull();
  });

  it('경계에 정확히 닿아도 null (<= 이지 < 가 아니다)', () => {
    expect(clampLogicalRangeToWall({ from: 100, to: 200 }, 200)).toBeNull();
  });

  it('벽을 넘으면 되밀되 **span 을 보존한다** — 팬이 줌으로 새면 안 된다', () => {
    const next = clampLogicalRangeToWall({ from: 250, to: 350 }, 300);
    expect(next).toEqual({ from: 200, to: 300 });
    expect(next!.to - next!.from).toBe(100);
  });

  it('스냅백 결과를 다시 넣으면 null — 재진입해도 즉시 멎는다(루프 방어의 본체)', () => {
    const first = clampLogicalRangeToWall({ from: 250, to: 350 }, 300)!;
    expect(clampLogicalRangeToWall(first, 300)).toBeNull();
  });

  it('NaN/Infinity 범위는 건드리지 않는다 — lwc 가 전환 프레임에 그런 값을 낸다', () => {
    expect(clampLogicalRangeToWall({ from: Number.NaN, to: 350 }, 300)).toBeNull();
    expect(clampLogicalRangeToWall({ from: 250, to: Number.POSITIVE_INFINITY }, 300)).toBeNull();
  });
});

describe('countBarsInRange', () => {
  it('구간 안 봉만 센다 (양끝 포함)', () => {
    const candles = bars(10);
    expect(countBarsInRange(candles, candles[3].ts_ms, candles[6].ts_ms)).toBe(4);
  });

  it('구간에 봉이 없으면 0', () => {
    const candles = bars(10);
    expect(countBarsInRange(candles, 1, 2)).toBe(0);
  });
});
