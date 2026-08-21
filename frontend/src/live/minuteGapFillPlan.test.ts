import { describe, expect, it } from 'vitest';
import type { RangeMissingDate } from '../api/types';
import {
  KIWOOM_MINUTE_RETENTION_DAYS,
  MAX_DATES_PER_RUN_1MIN,
  MAX_GAP_FILL_DATES,
  planMinuteGapFill,
} from './minuteGapFillPlan';

const TODAY = '20260821';

function missing(...dates: string[]): RangeMissingDate[] {
  return dates.map((date) => ({ date, reason: 'not_captured' as const }));
}

/**
 * **이 파일이 재는 것은 문구가 아니라 비용이다.**
 *
 * 백엔드 walk 는 요청 구간의 최신 미캐시일에서 커서를 시작해 뒤로 민다
 * (`live_candle_backfill._walk_pending`). 그래서 요청 구간의 **폭이 곧 콜 수**이고,
 * 이 계획 함수가 폭을 어떻게 자르느냐가 이 기능의 성능 전부다. 아래 단언들은 각각
 * 그 폭을 잘못 잡는 한 가지 방식을 막는다.
 *
 * **못 보는 것**: 실제 벤더 콜 수. 그건 백엔드 `hoga_perf past_candles_walk` 로그의
 * `pages` 로만 잴 수 있고, 무자격 워크트리에서는 그 경로가 아예 돌지 않는다.
 */
describe('planMinuteGapFill — 요청 폭', () => {
  it('떨어진 구멍은 나눈다 — 사이의 캡처된 날짜를 벤더에 다시 묻지 않으려고', () => {
    // 20260401 과 20260701 사이 석 달은 캡처가 멀쩡하다. 한 구간으로 묶으면 그 석 달이
    // 통째로 벤더 pending 이 되어 디스크에 있는 것을 다시 받는다.
    const plan = planMinuteGapFill({
      missingDates: missing('20260401', '20260701'),
      todayKstYyyymmdd: TODAY,
    });

    expect(plan.runs).toHaveLength(2);
    expect(plan.runs.map((r) => [r.from, r.to])).toEqual([
      ['20260701', '20260701'],
      ['20260401', '20260401'],
    ]);
  });

  it('주말 하나를 사이에 둔 구멍은 묶는다 — 한 콜이 어차피 인접일을 함께 실어 온다', () => {
    // 2026-08-07(금) · 2026-08-10(월). 캘린더 3일 차이라 병합 폭(5일) 안이다.
    const plan = planMinuteGapFill({
      missingDates: missing('20260807', '20260810'),
      todayKstYyyymmdd: TODAY,
    });

    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0]).toMatchObject({ from: '20260807', to: '20260810' });
  });

  it('최신 run 을 먼저 요청한다 — 차트는 우측부터 보인다', () => {
    const plan = planMinuteGapFill({
      missingDates: missing('20260401', '20260601', '20260801'),
      todayKstYyyymmdd: TODAY,
    });

    expect(plan.runs.map((r) => r.to)).toEqual(['20260801', '20260601', '20260401']);
  });
});

/**
 * **막는 방향**: 소득이 0 인 요청을 만드는 것. 키움 분봉 보유 하한은 실측 약 13개월이고
 * (`KIWOOM_MINUTE_RETENTION_DAYS` 의 표), 그 밖은 **200 + 빈 배열 + 경고 0** 이라
 * 조용히 아무 일이 없다. 요청을 만들지 **않는** 것이 유일한 방어라 계획 단계에 있어야 한다.
 */
describe('planMinuteGapFill — 보유 기간 밖', () => {
  it('보유 밖 날짜는 요청하지 않고 unfillable 로 분리한다', () => {
    const plan = planMinuteGapFill({
      missingDates: missing('20240827', '20260801'),
      todayKstYyyymmdd: TODAY,
    });

    expect(plan.runs.map((r) => r.to)).toEqual(['20260801']);
    expect(plan.unfillable).toEqual(['20240827']);
  });

  it('경계 하루 차이로 갈린다 — 상수가 실제로 판정에 쓰이는지', () => {
    // 경계를 값으로 세운다: 하나는 안, 하나는 밖. 둘 다 안/밖이면 상수를 무시하는
    // 구현도 통과한다.
    const inside = planMinuteGapFill({
      missingDates: missing(shiftDays(TODAY, -(KIWOOM_MINUTE_RETENTION_DAYS - 1))),
      todayKstYyyymmdd: TODAY,
    });
    const outside = planMinuteGapFill({
      missingDates: missing(shiftDays(TODAY, -(KIWOOM_MINUTE_RETENTION_DAYS + 1))),
      todayKstYyyymmdd: TODAY,
    });

    expect(inside.runs).toHaveLength(1);
    expect(inside.unfillable).toEqual([]);
    expect(outside.runs).toEqual([]);
    expect(outside.unfillable).toHaveLength(1);
  });
});

describe('planMinuteGapFill — 대상 선별', () => {
  it('오늘과 미래는 대상이 아니다 — 오늘분은 실시간 경로가 소유한다', () => {
    const plan = planMinuteGapFill({
      missingDates: missing('20260820', TODAY),
      todayKstYyyymmdd: TODAY,
    });

    expect(plan.runs.flatMap((r) => r.dates)).toEqual(['20260820']);
  });

  it('시장·소스 부재 사유는 보충하지 않는다 — KRX 봉으로 대신할 성질이 아니다', () => {
    const plan = planMinuteGapFill({
      missingDates: [
        { date: '20260810', reason: 'venue_unsupported' },
        { date: '20260811', reason: 'source_missing' },
        { date: '20260812', reason: 'no_upstream_data' },
      ],
      todayKstYyyymmdd: TODAY,
    });

    // 업스트림 결손은 hogaplay 가 그날을 못 줬다는 뜻이지 벤더에 없다는 뜻이 아니다.
    expect(plan.runs.flatMap((r) => r.dates)).toEqual(['20260812']);
  });

  it('구멍이 없으면 아무것도 계획하지 않는다', () => {
    expect(planMinuteGapFill({ missingDates: [], todayKstYyyymmdd: TODAY }).runs).toEqual([]);
    expect(planMinuteGapFill({ missingDates: undefined, todayKstYyyymmdd: TODAY }).runs).toEqual([]);
  });
});

/**
 * **막는 방향**: 넓은 저장뷰 하나가 벤더 예산을 통째로 쓰는 것. 상한에 걸린 쪽은
 * **오래된 쪽**이어야 한다 — 백엔드의 예산 트림도 최신 우선(`pending[-budget:]`)이라
 * 방향이 어긋나면 양쪽이 서로 다른 끝을 잘라 아무 구간도 완결되지 않는다.
 */
describe('planMinuteGapFill — 총량 상한', () => {
  it('상한을 넘으면 최신 쪽을 남기고 오래된 쪽을 유예한다', () => {
    const dates = Array.from({ length: MAX_GAP_FILL_DATES + 5 }, (_, i) => shiftDays('20260401', i));
    const plan = planMinuteGapFill({ missingDates: missing(...dates), todayKstYyyymmdd: TODAY });

    const planned = plan.runs.flatMap((r) => r.dates);
    expect(planned).toHaveLength(MAX_GAP_FILL_DATES);
    expect(plan.deferred).toEqual(dates.slice(0, 5));
    expect(planned).not.toContain(dates[0]);
    expect(planned).toContain(dates[dates.length - 1]);
  });
});

/**
 * **막는 방향**: 넓은 구멍이 절반만 채워지고 나머지가 조용히 유실되는 것.
 *
 * 백엔드는 collect 당 신선-날짜 예산(1분 12일)을 걸고 초과분을 봉 없이
 * `fetch_budget_exhausted` 로 유예한다. 그 회복 계약은 "다음 사이클에 이어서 받는다"
 * 인데, 이 훅의 커서는 run 을 **한 번만** 지나가므로 청크가 유일한 준수 방법이다.
 *
 * 실측(2026-08-21, 005930, 27거래일을 한 요청으로): `fresh_dates` 12 ·
 * `fetch_budget_exhausted` 10건. 청크가 없으면 딱 그만큼이 유실된다.
 *
 * **못 보는 것**: 예산 상수 자체(백엔드 값)가 바뀌는 것. 여기 숫자는 그 값의 **사본**이라
 * 백엔드가 12를 줄이면 이 테스트는 초록인 채로 틀린다.
 */
describe('planMinuteGapFill — 예산 청크', () => {
  it('긴 연속 구간을 예산 크기로 자른다 — 한 요청이 예산 안에서 완결되도록', () => {
    const dates = Array.from({ length: 27 }, (_, i) => shiftDays('20251001', i));
    const plan = planMinuteGapFill({ missingDates: missing(...dates), todayKstYyyymmdd: TODAY });

    expect(plan.runs.length).toBeGreaterThan(1);
    for (const run of plan.runs) {
      expect(run.dates.length).toBeLessThanOrEqual(MAX_DATES_PER_RUN_1MIN);
    }
    // 모든 날짜가 살아 있다 — 자르는 것이지 버리는 것이 아니다.
    expect(plan.runs.flatMap((r) => r.dates).sort()).toEqual(dates);
  });

  it('청크도 최신 우선이고, 최신 청크가 가득 찬다', () => {
    const dates = Array.from({ length: 25 }, (_, i) => shiftDays('20251001', i));
    const plan = planMinuteGapFill({ missingDates: missing(...dates), todayKstYyyymmdd: TODAY });

    // 첫 요청이 사용자가 보고 있는 쪽이다 — 여기가 짧으면 최신 구간이 제일 늦게 완성된다.
    expect(plan.runs[0].to).toBe(dates[dates.length - 1]);
    expect(plan.runs[0].dates).toHaveLength(MAX_DATES_PER_RUN_1MIN);
    // 나머지 조각은 가장 오래된 청크로 밀린다.
    expect(plan.runs[plan.runs.length - 1].from).toBe(dates[0]);
  });

  it('상위 tf 는 청크가 배수만큼 넓어진다 — 백엔드 예산이 tic_scope 에 비례하므로', () => {
    const dates = Array.from({ length: 27 }, (_, i) => shiftDays('20251001', i));
    const oneMin = planMinuteGapFill({ missingDates: missing(...dates), todayKstYyyymmdd: TODAY });
    const tenMin = planMinuteGapFill({
      missingDates: missing(...dates), todayKstYyyymmdd: TODAY, bucketMs: 600_000,
    });

    expect(tenMin.runs.length).toBeLessThan(oneMin.runs.length);
    expect(tenMin.runs).toHaveLength(1);
  });
});

/** 테스트 지역 날짜 산술. 구현과 다른 경로로 계산해야 상수 대조가 성립한다. */
function shiftDays(yyyymmdd: string, days: number): string {
  const d = new Date(Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  ));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
