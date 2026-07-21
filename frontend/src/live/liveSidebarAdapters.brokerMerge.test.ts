/**
 * mergeBrokerSeriesWithLiveTail — latest 모드 거래원 궤적의 "승격 파케이 + WS 꼬리"
 * 이음매 (ADR-0044 amendment 2026-07-21).
 *
 * 핵심 불변식은 이음매가 **전역**(전 브로커 공통 승격 경계)이라는 것. 브로커별
 * 마지막 관측으로 자르면 top-5 밖이라 파케이가 정직하게 비운 구간을 WS 점으로
 * 메워 없는 연속 관측을 날조한다.
 */
import { describe, expect, it } from 'vitest';

import { mergeBrokerSeriesWithLiveTail } from './liveSidebarAdapters';
import type { BrokerSeriesEntry } from '../api/types';

function entry(
  broker: string,
  points: { ts_ms: number; net: number }[],
): BrokerSeriesEntry {
  const final_net = points.length ? points[points.length - 1].net : 0;
  return {
    broker,
    final_net,
    dominant_side: final_net >= 0 ? 'buy' : 'sell',
    points,
  };
}

const tsOf = (e: BrokerSeriesEntry) => e.points.map((p) => p.ts_ms);
const find = (out: BrokerSeriesEntry[], broker: string) =>
  out.find((e) => e.broker === broker)!;

describe('mergeBrokerSeriesWithLiveTail', () => {
  it('파케이가 없으면 WS 시리즈를 그대로 쓴다 (첫 승격 사이클 이전)', () => {
    const live = [entry('KB', [{ ts_ms: 1_000, net: 10 }])];
    expect(mergeBrokerSeriesWithLiveTail(undefined, live)).toEqual(live);
    expect(mergeBrokerSeriesWithLiveTail(null, live)).toEqual(live);
    expect(mergeBrokerSeriesWithLiveTail([], live)).toEqual(live);
  });

  it('이음매 이후의 WS 점만 이어붙인다 (겹치는 구간 이중 렌더 방지)', () => {
    const parquet = [
      entry('KB', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 20 },
      ]),
    ];
    // 버퍼는 파케이보다 촘촘하다(원시 틱 vs 10초 다운샘플) — 겹치는 1_500·2_000 은
    // 이미 파케이가 답한 시간대라 버려야 한다.
    const live = [
      entry('KB', [
        { ts_ms: 1_500, net: 15 },
        { ts_ms: 2_000, net: 20 },
        { ts_ms: 2_500, net: 25 },
        { ts_ms: 3_000, net: 30 },
      ]),
    ];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(tsOf(find(out, 'KB'))).toEqual([1_000, 2_000, 2_500, 3_000]);
  });

  it('이음매는 전역이다 — 일찍 top-5 에서 빠진 브로커의 공백을 메우지 않는다', () => {
    // 전역 승격 경계는 KB 의 2_000. 교보는 1_000 에서 top-5 밖으로 떨어져
    // 파케이에 1_000 까지만 있다. 브로커별 이음매(1_000)로 자르면 교보에
    // 1_500 이 붙어 "계속 관측됐다" 가 되지만, 실제로는 그 구간이 공백이다.
    const parquet = [
      entry('KB', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 20 },
      ]),
      entry('교보', [{ ts_ms: 1_000, net: -5 }]),
    ];
    const live = [
      entry('KB', [{ ts_ms: 3_000, net: 30 }]),
      entry('교보', [
        { ts_ms: 1_500, net: -7 },   // 전역 이음매 이전 → 버려야 한다
        { ts_ms: 3_000, net: -9 },
      ]),
    ];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(tsOf(find(out, '교보'))).toEqual([1_000, 3_000]);
    expect(tsOf(find(out, '교보'))).not.toContain(1_500);
  });

  it('이음매 이후 새로 등장한 브로커를 추가한다', () => {
    const parquet = [entry('KB', [{ ts_ms: 2_000, net: 20 }])];
    const live = [
      entry('KB', [{ ts_ms: 3_000, net: 30 }]),
      entry('신한투자', [{ ts_ms: 3_000, net: -40 }]),
    ];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(out.map((e) => e.broker).sort()).toEqual(['KB', '신한투자']);
    expect(tsOf(find(out, '신한투자'))).toEqual([3_000]);
  });

  it('WS 꼬리에 없는(top-5 에서 빠진) 파케이 브로커를 유지한다', () => {
    const parquet = [
      entry('KB', [{ ts_ms: 2_000, net: 20 }]),
      entry('모건스탠', [{ ts_ms: 2_000, net: 490 }]),
    ];
    const live = [entry('KB', [{ ts_ms: 3_000, net: 30 }])];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(find(out, '모건스탠').points).toHaveLength(1);
    expect(find(out, '모건스탠').final_net).toBe(490);
  });

  it('병합된 마지막 점으로 final_net·dominant_side 를 다시 계산한다', () => {
    // 파케이에서는 매수 우위(+20)였는데 꼬리에서 매도로 뒤집힌 브로커.
    const parquet = [entry('KB', [{ ts_ms: 2_000, net: 20 }])];
    const live = [entry('KB', [{ ts_ms: 3_000, net: -15 }])];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(find(out, 'KB').final_net).toBe(-15);
    expect(find(out, 'KB').dominant_side).toBe('sell');
  });

  it('final_net 내림차순으로 정렬한다', () => {
    const parquet = [
      entry('C', [{ ts_ms: 1_000, net: -100 }]),
      entry('A', [{ ts_ms: 1_000, net: 500 }]),
      entry('B', [{ ts_ms: 1_000, net: 100 }]),
    ];

    const out = mergeBrokerSeriesWithLiveTail(parquet, []);

    expect(out.map((e) => e.broker)).toEqual(['A', 'B', 'C']);
  });

  it('입력 배열을 변형하지 않는다', () => {
    const parquet = [entry('KB', [{ ts_ms: 2_000, net: 20 }])];
    const live = [entry('KB', [{ ts_ms: 3_000, net: 30 }])];

    mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(parquet[0].points).toHaveLength(1);
    expect(live[0].points).toHaveLength(1);
  });
});
