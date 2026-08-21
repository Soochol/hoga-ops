import { describe, expect, it } from 'vitest';
import {
  TOUCH_WINDOW_MS,
  classifyAskWallEvents,
  classifyBidWallEvents,
  rankPeakCandidates,
  toTouchTicksFromTrades,
} from './peakWallEventClassifier';

/** 분 `m` 안의 오프셋 `ms` 시각. 분 경계가 이 파일의 유일한 판정 축이라 이름으로 드러낸다. */
function atMinute(m: number, ms = 0): number {
  return m * TOUCH_WINDOW_MS + ms;
}

describe('peakWallEventClassifier', () => {
  it('classifies ask walls with >= domination inside the wall minute', () => {
    const classified = classifyAskWallEvents(
      [
        { price: 100, qty: 500, t_ms: atMinute(10, 1_000) },
        { price: 101, qty: 900, t_ms: atMinute(10, 1_000) },
        { price: 102, qty: 700, t_ms: atMinute(10, 1_000) },
        { price: 103, qty: 800, t_ms: atMinute(10, 1_000) },
      ],
      [{ price: 101, t_ms: atMinute(10, 2_000) }],
    );

    expect(classified.touched).toEqual([
      { price: 101, qty: 900, t_ms: atMinute(10, 1_000) },
      { price: 100, qty: 500, t_ms: atMinute(10, 1_000) },
    ]);
    // `all` 은 터치와 무관 — 「보이는 영역 최대벽」이 읽는 계열이라 살아 있어야 한다.
    expect(classified.all).toEqual([
      { price: 101, qty: 900, t_ms: atMinute(10, 1_000) },
      { price: 103, qty: 800, t_ms: atMinute(10, 1_000) },
      { price: 102, qty: 700, t_ms: atMinute(10, 1_000) },
    ]);
  });

  it('classifies bid walls with <= domination', () => {
    const classified = classifyBidWallEvents(
      [
        { price: 100, qty: 500, t_ms: atMinute(10, 1_000) },
        { price: 99, qty: 900, t_ms: atMinute(10, 1_000) },
        { price: 98, qty: 700, t_ms: atMinute(10, 1_000) },
      ],
      [{ price: 99, t_ms: atMinute(10, 2_000) }],
    );

    expect(classified.touched).toEqual([
      { price: 99, qty: 900, t_ms: atMinute(10, 1_000) },
      { price: 100, qty: 500, t_ms: atMinute(10, 1_000) },
    ]);
  });

  it('does not count a touch from a neighbouring minute (ADR-0156)', () => {
    // 1ms 차이로 분이 갈린다. 막는 방향: 창이 분보다 넓어지는 쪽.
    const wall = { price: 100, qty: 500, t_ms: atMinute(10) };
    expect(classifyAskWallEvents([wall], [{ price: 100, t_ms: atMinute(10) - 1 }]).touched).toEqual([]);
    expect(classifyAskWallEvents([wall], [{ price: 100, t_ms: atMinute(11) }]).touched).toEqual([]);
    // 같은 분이면(경계 직전이라도) 터치다.
    expect(
      classifyAskWallEvents([wall], [{ price: 100, t_ms: atMinute(10) + TOUCH_WINDOW_MS - 1 }]).touched,
    ).toEqual([wall]);
  });

  it('counts a touch that precedes the wall inside the same minute', () => {
    // ADR-0084 에서는 미터치였다 — 순서가 판정에서 빠지며 답이 뒤집혔다.
    const classified = classifyAskWallEvents(
      [{ price: 100, qty: 500, t_ms: atMinute(10, 50_000) }],
      [{ price: 100, t_ms: atMinute(10, 1_000) }],
    );
    expect(classified.touched).toEqual([{ price: 100, qty: 500, t_ms: atMinute(10, 50_000) }]);
  });

  it('classifies same-price walls per minute, not per event order', () => {
    const classified = classifyAskWallEvents(
      [
        { price: 100, qty: 500, t_ms: atMinute(10, 1_000) },
        { price: 100, qty: 900, t_ms: atMinute(11, 1_000) },
      ],
      [{ price: 100, t_ms: atMinute(10, 2_000) }],
    );

    expect(classified.touched).toEqual([{ price: 100, qty: 500, t_ms: atMinute(10, 1_000) }]);
    expect(classified.all).toEqual([
      { price: 100, qty: 900, t_ms: atMinute(11, 1_000) },
      { price: 100, qty: 500, t_ms: atMinute(10, 1_000) },
    ]);
  });

  it('uses the minute extreme, not the last touch in that minute', () => {
    const classified = classifyAskWallEvents(
      [{ price: 100, qty: 500, t_ms: atMinute(10, 30_000) }],
      [
        { price: 100, t_ms: atMinute(10, 1_000) },
        { price: 90, t_ms: atMinute(10, 2_000) },
      ],
    );
    expect(classified.touched).toHaveLength(1);
  });

  it('classifies large live buffers without scanning every wall against every touch', () => {
    const base = Date.UTC(2026, 5, 23, 0, 0, 0);
    const events = Array.from({ length: 20_000 }, (_, i) => ({
      price: 40_000 + (i % 20),
      qty: 100 + i,
      t_ms: base + i * 100,
    }));
    // 터치는 매 분 하나씩 — 이벤트 100ms 간격이라 모든 분이 덮인다.
    const touches = Array.from({ length: 2_000 }, (_, i) => ({
      price: 40_010,
      t_ms: base + i * 1_000,
    }));

    const classified = classifyAskWallEvents(events, touches);

    // 2만 이벤트 × 2천 터치에서도 정확한 top 후보를 고른다(전수 대조 아닌 분 극값 맵).
    // 기존 벽시계 `elapsed < 300ms`는 full-suite 워커 경합에 flaky해 제거(issue #434).
    expect(classified.touched[0]).toEqual({ price: 40_010, qty: 20090, t_ms: base + 1_999_000 });
    // 40_019 는 40_010 터치가 지배하지 못한다(ask: touch >= wall) → touched 에 없다.
    expect(classified.touched.every((c) => c.price <= 40_010)).toBe(true);
    expect(classified.all[0]).toEqual({ price: 40_019, qty: 20099, t_ms: base + 1_999_900 });
  });

  it('ignores side=0 trades when building touch classification input', () => {
    expect(toTouchTicksFromTrades([
      {
        t_ms: 2_000,
        trades: [
          { t_ms: 2_000, side: 0, price: 100, qty: 1 },
          { t_ms: 2_000, side: 2, price: 100, qty: 1 },
          { t_ms: 2_000, side: 1, price: 100, qty: 1 },
        ],
      },
    ])).toEqual([
      { price: 100, t_ms: 2_000 },
    ]);
  });

  it('caps ranked candidates to the top three by qty then time then price', () => {
    expect(rankPeakCandidates([
      { price: 104, qty: 100, t_ms: 1_000 },
      { price: 101, qty: 700, t_ms: 3_000 },
      { price: 103, qty: 700, t_ms: 2_000 },
      { price: 102, qty: 500, t_ms: 1_000 },
      { price: 100, qty: 900, t_ms: 4_000 },
    ])).toEqual([
      { price: 100, qty: 900, t_ms: 4_000 },
      { price: 103, qty: 700, t_ms: 2_000 },
      { price: 101, qty: 700, t_ms: 3_000 },
    ]);
  });
});
