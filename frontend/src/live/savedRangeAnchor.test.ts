import { describe, expect, it } from 'vitest';
import { countBarsInRange, savedRangeAnchorTs } from './savedRangeAnchor';

const bars = (n: number, startMs = 1_000_000): { ts_ms: number }[] =>
  Array.from({ length: n }, (_, i) => ({ ts_ms: startMs + i * 60_000 }));

describe('savedRangeAnchorTs', () => {
  it('저장 끝(B)에 봉이 있으면 그 봉의 ts', () => {
    const candles = bars(10);
    expect(savedRangeAnchorTs(candles, candles[6].ts_ms)).toBe(candles[6].ts_ms);
  });

  it('B 시각에 봉이 없으면 **그 이전 마지막 봉** — 마감 후/휴장일 경계가 이 경우다', () => {
    const candles = bars(10);
    expect(savedRangeAnchorTs(candles, candles[6].ts_ms + 30_000)).toBe(candles[6].ts_ms);
  });

  it('B 가 첫 봉보다 과거면 null — 아직 백필이 안 왔다는 뜻이다', () => {
    const candles = bars(10);
    expect(savedRangeAnchorTs(candles, candles[0].ts_ms - 1)).toBeNull();
  });

  it('B 가 마지막 봉보다 미래면 마지막 봉 (저장이 최근이거나 오늘 장중)', () => {
    const candles = bars(10);
    expect(savedRangeAnchorTs(candles, candles[9].ts_ms + 10 * 60_000)).toBe(candles[9].ts_ms);
  });

  it('빈 배열은 null', () => {
    expect(savedRangeAnchorTs([], 1)).toBeNull();
  });

  // 배열 인덱스를 돌려주던 시절의 회귀 방어. `/live` 차트에는 WhitespaceData 가 섞여
  // lwc 논리 인덱스 ≠ 배열 인덱스라, 인덱스를 그대로 좌표로 쓰면 앵커가 엉뚱한 곳에 선다
  // (2026-08-21 실측: 저장 끝이 06-26 인데 06-29 에 섰다).
  it('인덱스가 아니라 **ts** 를 돌려준다 — 논리 좌표 변환은 호출부가 축으로 한다', () => {
    const candles = bars(10);
    const got = savedRangeAnchorTs(candles, candles[6].ts_ms);
    expect(got).toBeGreaterThan(1_000_000); // 인덱스(6)였다면 실패한다
    expect(got).toBe(candles[6].ts_ms);
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
