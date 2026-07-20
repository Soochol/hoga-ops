import { describe, it, expect } from 'vitest';
import { buildTradeTickView } from './tradeTicks';
import type { TradeSnapshot } from './bucketHogaSeries';

/** 키움 0B 경로 재현 — 체결 1건 = 스냅샷 1개(trades 길이 1). */
function tick(
  tMs: number,
  price: number,
  qty: number,
  side: number,
  extra: Record<string, unknown> = {},
): TradeSnapshot {
  return {
    t_ms: tMs,
    trades: [{ t_ms: tMs, price, qty, side, side_source: 'kiwoom_ws' }],
    ...extra,
  } as TradeSnapshot;
}

describe('buildTradeTickView', () => {
  it('최신 체결이 맨 위에 온다', () => {
    const view = buildTradeTickView(
      [tick(1000, 70000, 10, 1), tick(2000, 70100, 20, -1)],
      10,
    );
    expect(view.ticks.map((t) => t.tMs)).toEqual([2000, 1000]);
  });

  // 이 어댑터의 존재 이유. 키움 CNT_TIME 은 초 단위라 같은 t_ms 에 수십 건이
  // 몰리는데, t_ms 정렬을 넣으면 그 안의 체결 순서가 뭉개진다.
  it('같은 t_ms 안에서도 버퍼 push 순서(역순)를 그대로 보존한다', () => {
    const view = buildTradeTickView(
      [
        tick(5000, 70000, 1, 1),
        tick(5000, 70100, 2, 1),
        tick(5000, 70200, 3, 1),
      ],
      10,
    );
    // 전부 t_ms 가 같으므로 정렬로는 구분 불가 — push 역순이어야 한다.
    expect(view.ticks.map((t) => t.qty)).toEqual([3, 2, 1]);
  });

  it('한 스냅샷이 복수 체결을 실어와도 배열 뒤쪽이 최신이다', () => {
    const snap = {
      t_ms: 5000,
      trades: [
        { t_ms: 5000, price: 70000, qty: 1, side: 1 },
        { t_ms: 5000, price: 70100, qty: 2, side: -1 },
      ],
    } as TradeSnapshot;
    const view = buildTradeTickView([snap], 10);
    expect(view.ticks.map((t) => t.qty)).toEqual([2, 1]);
  });

  it('limit 을 넘으면 최신 쪽만 남긴다', () => {
    const snaps = Array.from({ length: 50 }, (_, i) => tick(1000 + i, 70000, i + 1, 1));
    const view = buildTradeTickView(snaps, 3);
    expect(view.ticks.map((t) => t.qty)).toEqual([50, 49, 48]);
  });

  it('가장 최근 스냅샷의 prev_close 를 기준선으로 뽑는다', () => {
    const view = buildTradeTickView(
      [tick(1000, 70000, 10, 1, { prev_close: 69000 }), tick(2000, 70100, 20, -1, { prev_close: 69500 })],
      10,
    );
    expect(view.prevClose).toBe(69500);
  });

  it('prev_close 가 없으면 null (모든 틱이 싣는 필드는 아니다)', () => {
    expect(buildTradeTickView([tick(1000, 70000, 10, 1)], 10).prevClose).toBeNull();
  });

  it('가격·수량이 0 이하이거나 비수치인 레코드는 버린다', () => {
    const snap = {
      t_ms: 5000,
      trades: [
        { t_ms: 5000, price: 0, qty: 5, side: 1 },
        { t_ms: 5000, price: 70000, qty: 0, side: 1 },
        { t_ms: 5000, price: '70000', qty: 5, side: 1 },
        { t_ms: 5000, price: 70000, qty: 7, side: 1 },
      ],
    } as TradeSnapshot;
    expect(buildTradeTickView([snap], 10).ticks).toHaveLength(1);
  });

  it('side==0 (동시호가·장전) 도 버리지 않는다 — 저장 경로만 걸러낸다', () => {
    const view = buildTradeTickView([tick(1000, 70000, 10, 0)], 10);
    expect(view.ticks).toHaveLength(1);
    expect(view.ticks[0].side).toBe(0);
  });

  it('완전히 동일한 체결이 중복돼도 key 는 유일하다', () => {
    const view = buildTradeTickView([tick(5000, 70000, 10, 1), tick(5000, 70000, 10, 1)], 10);
    expect(view.ticks).toHaveLength(2);
    expect(new Set(view.ticks.map((t) => t.key)).size).toBe(2);
  });

  it('key 는 새 체결이 들어와도 기존 행에 대해 안정적이다', () => {
    const before = buildTradeTickView([tick(1000, 70000, 10, 1)], 10);
    const after = buildTradeTickView([tick(1000, 70000, 10, 1), tick(2000, 70100, 20, -1)], 10);
    // 인덱스 기반 key 였다면 앞줄이 밀리며 전부 바뀌어 리스트가 통째로 재마운트된다.
    expect(after.ticks[1].key).toBe(before.ticks[0].key);
  });

  it('maxQty 는 표시 구간의 최댓값이다 (깊이 막대 정규화)', () => {
    const view = buildTradeTickView(
      [tick(1000, 70000, 5, 1), tick(2000, 70100, 40, -1), tick(3000, 70200, 12, 1)],
      10,
    );
    expect(view.maxQty).toBe(40);
  });

  it('limit 밖의 큰 체결은 maxQty 에 반영되지 않는다', () => {
    const view = buildTradeTickView(
      [tick(1000, 70000, 999, 1), tick(2000, 70100, 5, -1)],
      1,
    );
    expect(view.maxQty).toBe(5);
  });

  it('빈 버퍼·limit 0 은 빈 뷰', () => {
    expect(buildTradeTickView([], 10).ticks).toEqual([]);
    expect(buildTradeTickView([tick(1000, 70000, 10, 1)], 0).ticks).toEqual([]);
  });

  it('trades 가 배열이 아닌 스냅샷은 건너뛴다', () => {
    const broken = { t_ms: 1000 } as unknown as TradeSnapshot;
    expect(buildTradeTickView([broken, tick(2000, 70000, 10, 1)], 10).ticks).toHaveLength(1);
  });
});
