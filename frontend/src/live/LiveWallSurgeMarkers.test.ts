import { describe, expect, it } from 'vitest';
import type { Candle, WallSurgeEventWire } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { buildWallSurgeMarkers, snapEventMsToCandle } from './LiveWallSurgeMarkers';

/** 가상축은 항등 — 스냅·라벨 규칙만 재고 축 변환은 관심 밖이다. */
const AXIS = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;

const BUCKET = 60_000;
const CANDLES: Candle[] = [0, 1, 2, 3].map((i) => ({
  ts_ms: 1_700_000_000_000 + i * BUCKET,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 0,
})) as unknown as Candle[];

function ev(over: Partial<WallSurgeEventWire> = {}): WallSurgeEventWire {
  return {
    t_ms: CANDLES[1].ts_ms + 15_000,
    side: 'ask',
    price: 49_200,
    qty: 8_271,
    jump: 8_271,
    total: 39_437,
    kind: 'pierce',
    filled_qty: 0,
    ...over,
  };
}

describe('snapEventMsToCandle', () => {
  it('버킷 중간 시각을 그 캔들의 시작으로 내린다', () => {
    expect(snapEventMsToCandle(CANDLES[1].ts_ms + 15_000, CANDLES)).toBe(CANDLES[1].ts_ms);
    expect(snapEventMsToCandle(CANDLES[2].ts_ms, CANDLES)).toBe(CANDLES[2].ts_ms);
  });

  it('첫 캔들보다 앞선 시각은 null — 호출부가 원시 t_ms 로 폴백한다', () => {
    expect(snapEventMsToCandle(CANDLES[0].ts_ms - 1, CANDLES)).toBeNull();
  });
});

describe('buildWallSurgeMarkers', () => {
  it('마커를 캔들 버킷에 스냅한다 (안 하면 1캔들 옆으로 밀린다)', () => {
    const [m] = buildWallSurgeMarkers([ev()], CANDLES, AXIS, 4);
    expect(m.time).toBe(CANDLES[1].ts_ms / 1000);
  });

  it('측·결말·재등장을 그대로 옮긴다', () => {
    const [a] = buildWallSurgeMarkers([ev({ outcome: 'consumed' })], CANDLES, AXIS, 0);
    expect(a).toMatchObject({ side: 'ask', outcome: 'consumed', reappear: false });

    const [b] = buildWallSurgeMarkers(
      [ev({ side: 'bid', kind: 'reappear', blind_ms: 1_800_000 })],
      CANDLES,
      AXIS,
      0,
    );
    expect(b).toMatchObject({ side: 'bid', reappear: true });
  });

  it('outcome 이 없으면 null 로 — 미정과 held 를 섞지 않는다', () => {
    const [m] = buildWallSurgeMarkers([ev()], CANDLES, AXIS, 0);
    expect(m.outcome).toBeNull();

    const [held] = buildWallSurgeMarkers([ev({ outcome: 'held' })], CANDLES, AXIS, 0);
    expect(held.outcome).toBe('held');
  });

  it('라벨은 증가량 상위 N 건만 — 나머지는 호버가 맡는다', () => {
    const events = [
      ev({ jump: 100, price: 1 }),
      ev({ jump: 9_000, price: 2 }),
      ev({ jump: 5_000, price: 3 }),
      ev({ jump: 50, price: 4 }),
    ];
    const out = buildWallSurgeMarkers(events, CANDLES, AXIS, 2);
    const labelledPrices = out.filter((m) => m.label !== undefined).map((m) => m.price);
    expect(labelledPrices.sort()).toEqual([2, 3]);
  });

  it('labelCount 0 이면 라벨이 하나도 없다', () => {
    const out = buildWallSurgeMarkers([ev(), ev({ price: 2 })], CANDLES, AXIS, 0);
    expect(out.every((m) => m.label === undefined)).toBe(true);
  });

  it('원본 순서를 보존한다 — 라벨 선정이 정렬을 흘리지 않는다', () => {
    const events = [ev({ price: 10, jump: 1 }), ev({ price: 20, jump: 9_999 })];
    const out = buildWallSurgeMarkers(events, CANDLES, AXIS, 1);
    expect(out.map((m) => m.price)).toEqual([10, 20]);
  });

  it('빈 입력은 빈 출력', () => {
    expect(buildWallSurgeMarkers([], CANDLES, AXIS, 4)).toEqual([]);
  });
});
