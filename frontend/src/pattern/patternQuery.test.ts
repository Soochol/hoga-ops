import { describe, expect, it, beforeEach } from 'vitest';
import {
  patternSeedFromRange,
  usePatternQueryStore,
  PATTERN_MAX_BARS,
  PATTERN_MIN_BARS,
} from './patternQuery';

/**
 * 차트 → 패널 시드의 게이트와 1회 소비.
 *
 * 이 게이트가 닫는 방향: **요청을 만들면 안 되는 입력을 만들기 전에 막는다.** 서버는
 * 5봉 미만을 빈 결과로 답하는데, 그 빈 화면은 "이력이 없다" 로 읽혀 원인을 숨긴다.
 *
 * 못 보는 것: 실제 `measure` 드래그가 이 함수를 부르는지는 여기서 안 잰다(ChartWindow
 * 배선의 몫이고, 게이트 자체는 여기서 값으로 잰다).
 */

const YMD = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const DAY = 24 * 3600 * 1000;
const D0 = Date.UTC(2026, 3, 1);
const CANDLES = Array.from({ length: 60 }, (_, i) => D0 + i * DAY);
/** 집계 주봉 — 화면의 봉 하나가 한 주다. 봉 **수**는 5여도 날짜 구간은 29일이다. */
const WEEKLY = Array.from({ length: 20 }, (_, i) => D0 + i * 7 * DAY);

function seed(over: Partial<Parameters<typeof patternSeedFromRange>[0]> = {}) {
  return patternSeedFromRange({
    code: '005930',
    timeframe: 'D',
    candleTsMs: CANDLES,
    aRealMs: D0,
    bRealMs: D0 + 6 * DAY,
    toYyyymmdd: YMD,
    ...over,
  });
}

describe('patternSeedFromRange', () => {
  it('일봉 · 충분한 봉이면 구간을 만든다', () => {
    expect(seed()).toEqual({ code: '005930', label: undefined, from: '20260401', to: '20260407' });
  });

  it('드래그 방향이 반대여도 같은 구간이다', () => {
    expect(seed({ aRealMs: D0 + 6 * DAY, bRealMs: D0 })).toEqual(seed());
  });

  it('분봉에서는 만들지 않는다 — 봉 패턴은 일봉 개념이다', () => {
    expect(seed({ timeframe: '1m' })).toBeNull();
  });

  /**
   * 이 가드가 닫는 방향: **일봉이 아닌 창에서 요청이 나가는 것**.
   *
   * 게이트를 「분봉이 아닌가」로 되돌리면 아래 입력이 통과한다 — 봉 수 검증은 화면의
   * 집계 봉(주 5개)을 세어 5~30 을 만족하지만, 서버로 가는 것은 **날짜뿐**이라
   * `_resolve_window` 가 그 29일 구간을 **일봉 ~20봉**으로 다시 센다. 그러면 화면에는
   * 「그럴듯한 결과」가 뜨고 사용자는 틀린 질문의 답을 옳은 답으로 읽는다(실측:
   * 삼성전자 주봉 5개 → 일봉 20봉 검색, 1위 갤럭시아머니트리 0.738).
   *
   * 못 보는 것: 서버가 그 구간을 어떻게 세는지는 여기서 안 잰다(백엔드의 몫이고,
   * 여기서는 그 입력이 애초에 나가지 않는 것만 잰다).
   */
  it('주봉·월봉에서는 만들지 않는다 — 봉 수는 통과하지만 서버가 일봉으로 다시 센다', () => {
    const overWeekly = { candleTsMs: WEEKLY, aRealMs: WEEKLY[0], bRealMs: WEEKLY[4] };
    // 봉 수 방어는 이 입력을 못 막는다 — 주봉 5개는 «5봉» 이다.
    expect(WEEKLY.filter((ts) => ts >= WEEKLY[0] && ts <= WEEKLY[4])).toHaveLength(5);
    expect(seed({ timeframe: 'W', ...overWeekly })).toBeNull();
    expect(seed({ timeframe: 'M', ...overWeekly })).toBeNull();
  });

  it('종목이 없으면(지수 창) 만들지 않는다', () => {
    expect(seed({ code: null })).toBeNull();
  });

  it(`${PATTERN_MIN_BARS}봉 경계에서 갈린다`, () => {
    // 경계 위: 5봉 → 만든다. 경계 아래: 4봉 → null.
    expect(seed({ bRealMs: D0 + (PATTERN_MIN_BARS - 1) * DAY })).not.toBeNull();
    expect(seed({ bRealMs: D0 + (PATTERN_MIN_BARS - 2) * DAY })).toBeNull();
  });

  it(`${PATTERN_MAX_BARS}봉 상한에서 갈린다 — 드래그 경로는 서버의 lengths 검증을 안 탄다`, () => {
    // ⚠ 이 상한이 없으면 길게 그은 구간이 그대로 돈다(실측: 33봉이 24.7초).
    //   서버의 `lengths` 검증은 요청이 길이를 **말할 때만** 걸린다.
    expect(seed({ bRealMs: D0 + (PATTERN_MAX_BARS - 1) * DAY })).not.toBeNull();
    expect(seed({ bRealMs: D0 + PATTERN_MAX_BARS * DAY })).toBeNull();
  });

  it('봉 수는 달력 간격이 아니라 **실제 캔들**로 센다', () => {
    // 구간은 30일이지만 그 안의 캔들이 3개뿐이면 만들지 않는다(상장 전·정지 구간).
    const sparse = [D0, D0 + 10 * DAY, D0 + 20 * DAY];
    expect(seed({ candleTsMs: sparse, bRealMs: D0 + 30 * DAY })).toBeNull();
  });
});

describe('usePatternQueryStore', () => {
  beforeEach(() => usePatternQueryStore.setState({ pending: null }));

  it('소비하면 비운다 — 리렌더가 구간을 되돌리면 안 된다', () => {
    const s = usePatternQueryStore.getState();
    s.requestPatternSearch({ code: '005930', from: '20260401', to: '20260407' });
    expect(usePatternQueryStore.getState().consumePatternQuery()).toMatchObject({ code: '005930' });
    expect(usePatternQueryStore.getState().pending).toBeNull();
    expect(usePatternQueryStore.getState().consumePatternQuery()).toBeNull();
  });

  it('나중 요청이 앞선 요청을 대체한다', () => {
    const s = usePatternQueryStore.getState();
    s.requestPatternSearch({ code: '005930', from: '20260401', to: '20260407' });
    s.requestPatternSearch({ code: '000660', from: '20260501', to: '20260507' });
    expect(usePatternQueryStore.getState().consumePatternQuery()).toMatchObject({ code: '000660' });
  });
});
