import { describe, it, expect } from 'vitest';

import { mergeRangeBundles } from './range';
import type { RangeBundle, WallSurgeEventWire } from './types';

// range.depthHeatmap.test.ts 의 fakeBundle 과 같은 최소 픽스처.
const fakeBundle: RangeBundle = {
  code: '028050', from_date: '20260814', to_date: '20260814', bucket_ms: 60_000,
  segments: [], candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

function ev(over: Partial<WallSurgeEventWire> & { t_ms: number }): WallSurgeEventWire {
  return {
    side: 'ask', price: 49_200, qty: 14_935, jump: 10_000, total: 30_882,
    kind: 'grow', outcome: 'held', filled_qty: 0,
    ...over,
  };
}

describe('wall_surge merge', () => {
  // 회귀: `wall_surge` 는 최상위 `...next` 스프레드에만 얹혀 있어서, 청크를 이어 붙일
  // 때마다 앞 구간이 통째로 사라졌다. /live 는 실제로 두 청크를 연달아 부르고
  // (20260810~20260816 다음 20260809 단일일) 뒤 청크가 비어 있어 마커가 전멸했다.
  // 막는 방향은 "previous 가 살아남는가" 다.
  it('앞 청크의 이벤트를 뒤 청크가 덮지 않는다', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      from_date: '20260810', to_date: '20260816',
      wall_surge: [ev({ t_ms: 1_000 }), ev({ t_ms: 3_000 })],
    };
    // 좌측 팬이 부르는 과거 단일일 청크 — 그 날엔 사건이 없다.
    const next: RangeBundle = { ...fakeBundle, from_date: '20260809', to_date: '20260809' };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.wall_surge!.map((e) => e.t_ms)).toEqual([1_000, 3_000]);
  });

  it('양쪽을 합쳐 t_ms 오름차순으로 정렬한다', () => {
    const previous: RangeBundle = { ...fakeBundle, wall_surge: [ev({ t_ms: 3_000 })] };
    const next: RangeBundle = { ...fakeBundle, wall_surge: [ev({ t_ms: 1_000 })] };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.wall_surge!.map((e) => e.t_ms)).toEqual([1_000, 3_000]);
  });

  // dedup 키가 t_ms 하나면 여기서 이벤트가 사라진다 — depth_heatmap 은 버킷당
  // 1점이라 t_ms 로 충분하지만 호가벽은 한 스냅샷에 여러 건이 설 수 있다.
  it('같은 시각의 매도·매수 벽과 다른 가격대를 모두 남긴다', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      wall_surge: [
        ev({ t_ms: 1_000, side: 'ask', price: 49_200 }),
        ev({ t_ms: 1_000, side: 'bid', price: 49_000 }),
        ev({ t_ms: 1_000, side: 'ask', price: 49_400 }),
      ],
    };
    const next: RangeBundle = { ...fakeBundle };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.wall_surge).toHaveLength(3);
  });

  it('겹치는 이벤트는 뒤 청크 값이 이긴다', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      wall_surge: [ev({ t_ms: 1_000, outcome: null })],
    };
    // 같은 사건인데 추적 창이 차서 결말이 정해진 재조회분.
    const next: RangeBundle = {
      ...fakeBundle,
      wall_surge: [ev({ t_ms: 1_000, outcome: 'consumed' })],
    };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.wall_surge).toHaveLength(1);
    expect(merged.wall_surge![0].outcome).toBe('consumed');
  });

  // next 가 **세그먼트를 실제로 내려준** 경우에도 previous 를 거르지 않는다는 계약.
  //
  // `broker_late_entries`·`program_trade` 는 여기서 `outsideCoveredSegment` 로 previous
  // 를 버린다 — 재계산에서 항목이 사라질 수 있기 때문이다. 호가벽은 그렇지 않으므로
  // (`query_wall_surge` 의 임계가 prefix 집계라 과거 판정이 불변) 같은 필터를 걸면
  // **막는 사건이 없는 코드**가 되고, 다음 독자에게 "여기선 사라짐이 일어난다" 는 거짓
  // 신호를 준다. 이 테스트가 그 필터를 넣는 순간 빨개진다.
  it('뒤 청크가 세그먼트를 내려줘도 그 구간의 previous 를 버리지 않는다', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      segments: [{ date: '20260813', session_open_ms: 10, session_close_ms: 90, source: 'hogaplay' }],
      wall_surge: [ev({ t_ms: 50 }), ev({ t_ms: 400 })],
    };
    const next: RangeBundle = {
      ...fakeBundle,
      segments: [{ date: '20260814', session_open_ms: 100, session_close_ms: 900, source: 'hogaplay' }],
      wall_surge: [ev({ t_ms: 500 })],
    };

    const merged = mergeRangeBundles(previous, next);

    // 400 은 next 의 세션(100~900) **안**이지만 살아남는다 — 세그먼트 밖의 50 과 함께
    // 경계 양쪽을 값으로 세워, 필터가 들어오면 400 만 빠지며 실패 메시지가 어느 규칙이
    // 잘못 적용됐는지 말하게 한다.
    expect(merged.wall_surge!.map((e) => e.t_ms)).toEqual([50, 400, 500]);
  });
});
