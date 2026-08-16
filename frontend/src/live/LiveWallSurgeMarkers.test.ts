import { describe, expect, it } from 'vitest';
import type { Candle, WallSurgeEventWire } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { buildWallSurgeMarkers, snapEventMsToCandle } from './LiveWallSurgeMarkers';
import {
  pickLabelledIndices,
  type WallSurgeMarkerPoint,
} from '../chart/WallSurgeMarkersPrimitive';

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
    const [m] = buildWallSurgeMarkers([ev()], CANDLES, AXIS);
    expect(m.time).toBe(CANDLES[1].ts_ms / 1000);
  });

  it('측·결말·재등장을 그대로 옮긴다', () => {
    const [a] = buildWallSurgeMarkers([ev({ outcome: 'consumed' })], CANDLES, AXIS);
    expect(a).toMatchObject({ side: 'ask', outcome: 'consumed', reappear: false });

    const [b] = buildWallSurgeMarkers(
      [ev({ side: 'bid', kind: 'reappear', blind_ms: 1_800_000 })],
      CANDLES,
      AXIS,
    );
    expect(b).toMatchObject({ side: 'bid', reappear: true });
  });

  it('outcome 이 없으면 null 로 — 미정과 held 를 섞지 않는다', () => {
    const [m] = buildWallSurgeMarkers([ev()], CANDLES, AXIS);
    expect(m.outcome).toBeNull();

    const [held] = buildWallSurgeMarkers([ev({ outcome: 'held' })], CANDLES, AXIS);
    expect(held.outcome).toBe('held');
  });

  // 선정은 렌더러(`pickLabelledIndices`)로 옮겼다 — build 는 **전건에** 채워 보낸다.
  // 여기서 골라 버리면 렌더러가 화면 기준으로 다시 고를 재료를 잃는다.
  it('라벨 문구와 증가량을 전건에 채운다', () => {
    const out = buildWallSurgeMarkers([ev({ qty: 12_593 }), ev({ qty: 8_271 })], CANDLES, AXIS);
    expect(out.map((m) => m.label)).toEqual(['12.6k', '8.3k']);
    expect(out.every((m) => typeof m.jump === 'number')).toBe(true);
  });

  it('원본 순서를 보존한다 — 렌더러가 인덱스로 되찾는다', () => {
    const events = [ev({ price: 10, jump: 1 }), ev({ price: 20, jump: 9_999 })];
    const out = buildWallSurgeMarkers(events, CANDLES, AXIS);
    expect(out.map((m) => m.price)).toEqual([10, 20]);
  });

  it('빈 입력은 빈 출력', () => {
    expect(buildWallSurgeMarkers([], CANDLES, AXIS)).toEqual([]);
  });
});

/** 화면 기준 선정 — canvas 는 jsdom 이 못 재므로 이 순수 함수가 유일한 검증 이음매다. */
describe('pickLabelledIndices', () => {
  const M = (jump: number, time: number) =>
    ({ jump, time, price: 0, side: 'ask', outcome: null, reappear: false, label: '' }) as
      unknown as WallSurgeMarkerPoint;

  // 회귀: 로드된 전 기간에서 고르면 5거래일 로드 + 하루 보기에서 상위 N 이 다른 날에
  // 몰려 화면에 한 개도 안 뜬다. 막는 방향은 "화면 밖은 후보가 아니다".
  it('화면 밖 마커는 더 크더라도 라벨을 못 가져간다', () => {
    const markers = [M(9_999, 1), M(500, 2), M(300, 3)];
    // 0번은 화면 밖(visible 에 없다).
    expect(pickLabelledIndices(markers, [1, 2], 1)).toEqual(new Set([1]));
  });

  it('화면 안에서 증가량 상위 N 을 고른다', () => {
    const markers = [M(100, 1), M(9_000, 2), M(5_000, 3), M(50, 4)];
    expect(pickLabelledIndices(markers, [0, 1, 2, 3], 2)).toEqual(new Set([1, 2]));
  });

  it('개수 0 이면 아무것도 안 고른다', () => {
    expect(pickLabelledIndices([M(1, 1), M(2, 2)], [0, 1], 0)).toEqual(new Set());
  });

  it('화면 안 개수가 설정보다 적으면 전부 고른다', () => {
    expect(pickLabelledIndices([M(1, 1), M(2, 2)], [0, 1], 4)).toEqual(new Set([0, 1]));
  });

  // 동점을 시각으로 안 가르면 정렬이 불안정해져 팬 중 라벨이 깜빡인다.
  it('동점은 시각 오름차순으로 갈라 선정이 흔들리지 않는다', () => {
    const markers = [M(500, 30), M(500, 10), M(500, 20)];
    expect(pickLabelledIndices(markers, [0, 1, 2], 2)).toEqual(new Set([1, 2]));
  });
});
