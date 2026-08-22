/**
 * 분 극값 맵의 **축출 재계산** 가드.
 *
 * 극값은 삽입에 대해서만 닫힌 연산이다 — 어떤 분의 극값 터치가 축출되면 남은 것들로
 * **다시 재야** 하고, 그 재계산을 빼면 값이 조용히 stale 해진다(실제보다 공격적인
 * 극값이 남아 벽이 과다하게 「체결됨」으로 분류된다).
 *
 * 왜 이 파일이 따로 있나: 오라클 파리티 테스트(`incrementalPeakWallEviction.test.ts`)로
 * red-check 을 돌렸더니 **그 결함이 bid 에서만 빨개지고 ask 는 통과했다.** 난수 픽스처의
 * 가격 분포가 ask 쪽에서 우연히 같은 답을 냈기 때문이다. 회귀 감지는 되지만 **한쪽
 * side 가 검증 밖에 남는다** — 여기서 그 축을 명시적으로 세운다: 극값 터치를 창 밖으로
 * 밀어낸 뒤 판정이 실제로 뒤집히는지 ask·bid 각각에서 잰다.
 */
import { describe, it, expect } from 'vitest';
import { IncrementalPeakWallSource } from './incrementalPeakWallSource';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const BASE = Date.UTC(2026, 5, 23, 0, 0, 0);
const OPEN_MS = BASE;

function ob(i: number, price: number): ObSnapshot {
  return {
    t_ms: BASE + i * 1000,
    total_ask_qty: 1000,
    total_bid_qty: 1000,
    asks: Array.from({ length: 10 }, (_u, l) => ({ price: price + l, qty: 500 })),
    bids: Array.from({ length: 10 }, (_u, l) => ({ price: price - l, qty: 500 })),
  };
}

function trade(i: number, price: number): TradeSnapshot {
  return { t_ms: BASE + i * 1000, trades: [{ side: 1, price, qty: 1 }] };
}

/** 한 분 안에서 극값 터치가 창 밖으로 밀려나면, 그 벽은 더 이상 「체결된 벽」이 아니다. */
function runEviction(side: 'ask' | 'bid', wallPrice: number, extremeTouch: number, mildTouch: number) {
  const src = new IncrementalPeakWallSource(side);
  // 같은 분(0~59초) 안에 두 체결: 하나는 벽에 닿는 극값, 하나는 못 닿는 값.
  const obs = [ob(0, wallPrice), ob(1, wallPrice), ob(2, wallPrice)];
  const trades = [trade(0, extremeTouch), trade(1, mildTouch), trade(2, mildTouch)];

  const before = src.update(obs, trades, OPEN_MS, []);
  // 극값 터치가 실린 첫 스냅샷을 창 밖으로 민다(prefix 축출 = 슬라이딩 정상상태).
  const after = src.update(obs.slice(1), trades.slice(1), OPEN_MS, []);
  return {
    touchedBefore: before.touched.length,
    touchedAfter: after.touched.length,
  };
}

describe('분 극값 맵 — 축출 후 재계산', () => {
  it('매도: 벽에 닿았던 최고가 체결이 축출되면 그 벽은 체결된 벽에서 빠진다', () => {
    // ask 벽 40,000. 극값 체결 40,050(>= 벽, 터치) → 축출 후엔 39,900 만 남아 못 닿는다.
    const { touchedBefore, touchedAfter } = runEviction('ask', 40_000, 40_050, 39_900);
    expect(touchedBefore).toBeGreaterThan(0);
    expect(touchedAfter).toBe(0);
  });

  it('매수: 벽에 닿았던 최저가 체결이 축출되면 그 벽은 체결된 벽에서 빠진다', () => {
    // bid 벽 40,000. 극값 체결 39,950(<= 벽, 터치) → 축출 후엔 40,100 만 남아 못 닿는다.
    const { touchedBefore, touchedAfter } = runEviction('bid', 40_000, 39_950, 40_100);
    expect(touchedBefore).toBeGreaterThan(0);
    expect(touchedAfter).toBe(0);
  });

  it('극값이 아닌 터치가 축출되면 판정이 유지된다(반대 방향 — 과잉 무효화 방지)', () => {
    // 극값 터치를 **나중** 스냅샷에 두고 앞의 약한 터치를 민다 → 여전히 체결된 벽이다.
    const src = new IncrementalPeakWallSource('ask');
    const obs = [ob(0, 40_000), ob(1, 40_000), ob(2, 40_000)];
    const trades = [trade(0, 39_900), trade(1, 40_050), trade(2, 39_900)];
    expect(src.update(obs, trades, OPEN_MS, []).touched.length).toBeGreaterThan(0);
    expect(src.update(obs.slice(1), trades.slice(1), OPEN_MS, []).touched.length).toBeGreaterThan(0);
  });
});
