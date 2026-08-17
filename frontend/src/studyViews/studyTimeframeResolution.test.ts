import { describe, expect, it } from 'vitest';

import { STUDY_DEFAULT_MINUTE_TIMEFRAME } from '../state/studyLastMinuteTimeframe';
import {
  resolveIndicatorPanelTimeframe,
  resolveRememberedMinuteTimeframe,
  resolveSelectedTimeframe,
} from './studyTimeframeResolution';

const VIEW = 'view-1';

describe('resolveSelectedTimeframe — 창이 유일한 소유자다 (#1326)', () => {
  // 우선순위를 **표로** 못 박는다. 종전엔 이 사슬이 StudyPage 본문의 인라인 표현식이라
  // 한 단계를 확인하려면 페이지 전체를 렌더해야 했다.
  // 사슬에 탭 단계가 하나 더 있었다(ADR-0148 이전). 탭의 봉은 포커스 창의 **거울**이라
  // 첫 단계와 같은 값이었고, 탭이 사라지면서 그대로 접혔다 — 남는 축은 창·로컬·저장 셋이다.
  const cases: Array<{
    name: string;
    window: '15m' | null;
    expected: string | null;
  }> = [
    { name: '창이 로컬·저장을 전부 이긴다', window: '15m', expected: '15m' },
    { name: '창이 없으면 뷰별 로컬 기억이 이긴다', window: null, expected: '5m' },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        resolveSelectedTimeframe({
          chartWindowTimeframe: c.window,
          activeViewId: VIEW,
          viewTimeframes: { [VIEW]: '5m' },
          savedTimeframe: 'D',
        }),
      ).toBe(c.expected);
    });
  }

  // 로컬 기억은 **뷰별**이다 — 다른 뷰의 기억이 새어 들어오면 안 된다.
  it('다른 뷰의 로컬 기억은 건너뛰고 저장 봉으로 떨어진다', () => {
    expect(
      resolveSelectedTimeframe({
        chartWindowTimeframe: null,
        activeViewId: VIEW,
        viewTimeframes: { 'other-view': '5m' },
        savedTimeframe: 'D',
      }),
    ).toBe('D');
  });

  it('저장 봉은 사슬의 맨 끝이라 다른 단서가 하나도 없을 때만 이긴다', () => {
    expect(
      resolveSelectedTimeframe({
        chartWindowTimeframe: null,
        activeViewId: VIEW,
        viewTimeframes: {},
        savedTimeframe: 'D',
      }),
    ).toBe('D');
  });

  it('뷰가 없으면 null — 봉을 물을 대상 자체가 없다', () => {
    expect(
      resolveSelectedTimeframe({
        chartWindowTimeframe: '15m',
        activeViewId: null,
        viewTimeframes: {},
        savedTimeframe: 'D',
      }),
    ).toBeNull();
  });
});

describe('resolveRememberedMinuteTimeframe — 헤더 분봉 슬롯', () => {
  it('창 기억이 최우선이다', () => {
    expect(
      resolveRememberedMinuteTimeframe({
        chartWindowLastMinute: '15m',
        activeViewId: VIEW,
        rememberedMinuteTimeframes: { [VIEW]: '5m' },
        savedTimeframe: '1m',
      }),
    ).toBe('15m');
  });

  it('창 기억이 없으면 뷰별 로컬 기억', () => {
    expect(
      resolveRememberedMinuteTimeframe({
        chartWindowLastMinute: null,
        activeViewId: VIEW,
        rememberedMinuteTimeframes: { [VIEW]: '5m' },
        savedTimeframe: '1m',
      }),
    ).toBe('5m');
  });

  it('저장 봉이 분봉이면 그것을 쓴다', () => {
    expect(
      resolveRememberedMinuteTimeframe({
        chartWindowLastMinute: null,
        activeViewId: VIEW,
        rememberedMinuteTimeframes: {},
        savedTimeframe: '1m',
      }),
    ).toBe('1m');
  });
});

// ── 이번 작업의 인수 기준 ──────────────────────────────────────────────────────
//
// 이 결함은 **무증상이었다** — 지표 프로필이 `minute|D|W|M` 네 버킷으로 접혀
// `'1m'`↔`'3m'` 이 지표 스코프에서는 같은 값이 된다. 무증상 결함을 고칠 때 가장 위험한
// 것은 **고쳤는지 아닌지 아무도 모른다**는 점이다: 기존 테스트는 전에도 통과했고 앞으로도
// 통과한다. 그래서 끝값을 **값으로 직접** 잰다.
describe('아무 단서가 없을 때의 끝값은 한 값이다', () => {
  it('분봉 슬롯 — 뷰가 있든 없든 같은 상수로 떨어진다', () => {
    // 종전엔 여기가 갈렸다: 뷰가 있으면 `'1m'`, 없으면 `'3m'`. 같은 질문의 두 답이었다.
    const withView = resolveRememberedMinuteTimeframe({
      chartWindowLastMinute: null,
      activeViewId: VIEW,
      rememberedMinuteTimeframes: {},
      savedTimeframe: 'D', // 분봉이 아니라 사슬 끝까지 간다
    });
    const withoutView = resolveRememberedMinuteTimeframe({
      chartWindowLastMinute: null,
      activeViewId: null,
      rememberedMinuteTimeframes: {},
      savedTimeframe: null,
    });
    expect(withView).toBe(STUDY_DEFAULT_MINUTE_TIMEFRAME);
    expect(withoutView).toBe(STUDY_DEFAULT_MINUTE_TIMEFRAME);
    expect(withView).toBe(withoutView);
  });

  it('지표 패널 봉 — 끝값이 같은 상수다', () => {
    expect(
      resolveIndicatorPanelTimeframe({
        readySavedTimeframe: null,
        selectedTimeframe: null,
      }),
    ).toBe(STUDY_DEFAULT_MINUTE_TIMEFRAME);
  });
});

describe('resolveIndicatorPanelTimeframe — 로딩 구간도 창을 먼저 읽는다 (#1326)', () => {
  it('ready 면 저장 봉을 그대로 쓴다', () => {
    expect(
      resolveIndicatorPanelTimeframe({
        readySavedTimeframe: 'D',
        selectedTimeframe: '15m',
      }),
    ).toBe('D');
  });

  it('로딩 구간엔 selected(=창 우선 사슬)를 쓴다', () => {
    // `selectedTimeframe` 이 이미 창을 사슬 맨 앞에 두므로 그 값이 곧 창의 봉이다.
    expect(
      resolveIndicatorPanelTimeframe({
        readySavedTimeframe: null,
        selectedTimeframe: '15m',
      }),
    ).toBe('15m');
  });
});
