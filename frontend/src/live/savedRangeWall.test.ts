import { describe, expect, it } from 'vitest';
import {
  clampLogicalRangeToWall,
  countBarsInRange,
  savedRangeWallBarTs,
  savedRangeWallLimit,
} from './savedRangeWall';
import { minuteRightOffsetBars } from './minuteViewportPolicy';

const bars = (n: number, startMs = 1_000_000): { ts_ms: number }[] =>
  Array.from({ length: n }, (_, i) => ({ ts_ms: startMs + i * 60_000 }));

describe('savedRangeWallBarTs', () => {
  it('저장 끝(B)에 봉이 있으면 그 봉의 ts', () => {
    const candles = bars(10);
    expect(savedRangeWallBarTs(candles, candles[6].ts_ms)).toBe(candles[6].ts_ms);
  });

  it('B 시각에 봉이 없으면 **그 이전 마지막 봉** — 마감 후/휴장일 경계가 이 경우다', () => {
    const candles = bars(10);
    expect(savedRangeWallBarTs(candles, candles[6].ts_ms + 30_000)).toBe(candles[6].ts_ms);
  });

  it('B 가 첫 봉보다 과거면 null — 벽을 세울 자리가 없다', () => {
    const candles = bars(10);
    expect(savedRangeWallBarTs(candles, candles[0].ts_ms - 1)).toBeNull();
  });

  it('B 가 마지막 봉보다 미래면 마지막 봉 (백필이 아직 안 왔거나 저장이 최근)', () => {
    const candles = bars(10);
    expect(savedRangeWallBarTs(candles, candles[9].ts_ms + 10 * 60_000)).toBe(candles[9].ts_ms);
  });

  it('빈 배열은 null', () => {
    expect(savedRangeWallBarTs([], 1)).toBeNull();
  });

  // 배열 인덱스를 돌려주던 시절의 회귀 방어. `/live` 차트에는 WhitespaceData 가 섞여
  // lwc 논리 인덱스 ≠ 배열 인덱스라, 인덱스를 그대로 좌표로 쓰면 벽이 엉뚱한 곳에 선다.
  it('인덱스가 아니라 **ts** 를 돌려준다 — 논리 좌표 변환은 호출부가 축으로 한다', () => {
    const candles = bars(10);
    const got = savedRangeWallBarTs(candles, candles[6].ts_ms);
    expect(got).toBeGreaterThan(1_000_000);   // 인덱스(6)였다면 실패한다
    expect(got).toBe(candles[6].ts_ms);
  });
});

describe('savedRangeWallLimit', () => {
  // 저장 구간 끝 오른쪽에는 **실제 캔들**이 있다(라이브 엣지의 whitespace 가 아니다).
  // 그래서 여백은 빈 공간이 아니라 "B 이후" 가 되고, 요구가 그만큼 깨진다.
  // 실측으로 두 번 좁혔다: 폭 비례 거터 → 고정 2봉 → 0.
  it('여백 없이 벽 봉 그 자체 — B 가 오른쪽 끝이다', () => {
    expect(savedRangeWallLimit(500)).toBe(500);
  });

  it('화면 폭에 비례하지 않는다 — 라이브 엣지 거터를 되쓰면 회귀다', () => {
    const wide = minuteRightOffsetBars(1200, 800);
    expect(wide).toBeGreaterThan(10); // 비례 거터가 실제로 크다는 전제
    expect(savedRangeWallLimit(500)).toBeLessThan(500 + wide);
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
