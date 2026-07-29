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

/**
 * 틱당 비용 회귀 가드.
 *
 * 호출부 memo deps 가 `[todaySeries, liveTail]` 인데 liveTail 은 브로커 WS 푸시마다
 * 새 참조라 이 함수는 **틱마다** 돈다. 파케이는 60초 리페치로만 바뀐다. 종전엔 매 틱
 * 전 브로커의 전 포인트를 복사 + 브로커마다 재정렬했고, 그 비용이 당일 궤적 길이에
 * 비례해 장이 갈수록 무거워졌다.
 */
describe('mergeBrokerSeriesWithLiveTail — 틱당 비용', () => {
  it('꼬리가 없는 브로커의 포인트 배열은 틱마다 새로 만들지 않는다', () => {
    const parquet = [
      entry('A', [{ ts_ms: 1_000, net: 10 }, { ts_ms: 2_000, net: 20 }]),
      entry('B', [{ ts_ms: 1_000, net: 5 }, { ts_ms: 2_000, net: 7 }]),
    ];
    // A 에만 새 점이 붙는 틱.
    const live = [entry('A', [{ ts_ms: 3_000, net: 30 }])];

    const first = mergeBrokerSeriesWithLiveTail(parquet, live);
    const second = mergeBrokerSeriesWithLiveTail(parquet, live);

    // 손대지 않은 브로커는 같은 배열을 그대로 재사용한다 = 틱당 할당 0.
    expect(find(second, 'B').points).toBe(find(first, 'B').points);
    // 값 자체는 물론 동일해야 한다.
    expect(tsOf(find(second, 'B'))).toEqual([1_000, 2_000]);
  });

  it('반복 호출이 파케이 본체를 오염시키지 않는다 (concat 은 비변형)', () => {
    const parquet = [entry('A', [{ ts_ms: 1_000, net: 10 }])];
    const live = [entry('A', [{ ts_ms: 2_000, net: 20 }])];

    const first = mergeBrokerSeriesWithLiveTail(parquet, live);
    const second = mergeBrokerSeriesWithLiveTail(parquet, live);

    // 캐시된 본체에 꼬리가 누적되면 두 번째가 [1000, 2000, 2000] 이 된다.
    expect(tsOf(find(first, 'A'))).toEqual([1_000, 2_000]);
    expect(tsOf(find(second, 'A'))).toEqual([1_000, 2_000]);
    expect(parquet[0].points).toHaveLength(1);
  });

  it('이어붙인 결과는 정렬 없이도 ts_ms 오름차순이다', () => {
    // 파케이 전역 최대 ts = 5_000. B 는 그보다 이르게 끝나지만(top-5 이탈) 꼬리는
    // 전역 이음매 초과라, 어느 브로커에서든 파케이 뒤에 온다.
    const parquet = [
      entry('A', [{ ts_ms: 1_000, net: 1 }, { ts_ms: 5_000, net: 5 }]),
      entry('B', [{ ts_ms: 1_000, net: 2 }, { ts_ms: 2_000, net: 3 }]),
    ];
    const live = [
      entry('A', [{ ts_ms: 6_000, net: 6 }]),
      entry('B', [{ ts_ms: 7_000, net: 7 }]),
    ];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    for (const e of out) {
      const ts = tsOf(e);
      expect(ts).toEqual([...ts].sort((x, y) => x - y));
    }
    expect(tsOf(find(out, 'B'))).toEqual([1_000, 2_000, 7_000]);
  });

  it('꼬리가 없고 파케이에도 없는 브로커는 빈 엔트리로 남는다 (종전 동작 보존)', () => {
    const parquet = [entry('A', [{ ts_ms: 5_000, net: 5 }])];
    // 모든 점이 이음매 이하 = 꼬리 없음. 그리고 파케이에 없는 브로커.
    const live = [entry('Z', [{ ts_ms: 1_000, net: 9 }])];

    const out = mergeBrokerSeriesWithLiveTail(parquet, live);

    expect(find(out, 'Z').points).toEqual([]);
    expect(find(out, 'Z').final_net).toBe(0);
  });
});
