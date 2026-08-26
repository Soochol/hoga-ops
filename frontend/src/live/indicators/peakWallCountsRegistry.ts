import { useEffect } from 'react';
import { createWindowScopedRegistry } from './windowScopedRegistry';
import type { PeakWallStepKey } from './peakWallStepsRegistry';
import type { PeakWallFamilyId } from '../../state/peakWallFamilyPrefs';

export type PeakWallCounts = {
  /** 지금 캔들 위에 실제로 그려진 세그먼트 수. */
  shown: number;
  /** 후보였다가 MA 필터에 걸려 빠진 수(세그먼트 매핑 손실은 **포함하지 않는다**). */
  hiddenByFilter: number;
};

/**
 * 차트가 센 최대벽 개수를 **설정 패널로 나르는 통로**.
 *
 * ## 왜 레지스트리인가 — 셀렉터 재사용은 원리적으로 막혀 있다
 *
 * `hiddenByFilter` 를 만드는 중간 개수는 `usePeakWallRender` 의 `useMemo` 안에서만
 * 존재하고, 그 memo 는 `peaks`·`segments`·`candles`·`axis` 에 키잉돼 있다. 설정
 * 드로어는 그 넷을 **하나도 갖고 있지 않다**(페치를 돌리지 않는 뷰를 명시적으로
 * 만든다). 패널에서 다시 계산하려면 그 번들을 통째로 끌어와야 하고, 그건 같은 수를
 * 두 곳에서 세는 것이라 언젠가 갈린다.
 *
 * 선례가 정확히 같은 모양이다 — `peakWallStepsRegistry` 가 "차트가 계산한 것을
 * pane spec 으로" 나르고, 여기는 "차트가 계산한 것을 드로어로" 나른다. 스코프도
 * 이미 맞아 있다: 드로어가 `WindowViewContext.Provider` 로 감싸므로 패널이 읽는
 * `useWindowScopeId()` 가 차트가 쓰는 그 값이다.
 *
 * ## `flagLegendValueRegistry` 를 쓰면 안 된다
 *
 * 그쪽은 **의도적 비반응형**(plain module Map)이다. SSE 틱마다 재렌더되는 것을
 * 막는 것이 목적이라, 개수가 바뀌어도 패널이 다시 그려지지 않는다.
 *
 * ## 등록되지 않음 = 데이터 없음 (0 이 아니다)
 *
 * 일·주·월봉에서는 이 지표가 아예 적용되지 않고(`applicable === false`), 차트가
 * 아직 안 그려졌을 수도 있다. 그때 `{shown: 0}` 을 등록하면 "필터가 다 걸렀다" 와
 * 구별되지 않는다 — **엔트리 부재**가 그 신호다. 발행 쪽이 미등록으로 두고, 읽는
 * 쪽은 `undefined` 를 "표시하지 않음" 으로 처리한다.
 */
export const usePeakWallCountsRegistry =
  createWindowScopedRegistry<PeakWallStepKey, PeakWallCounts>();

/** 방향×계열 → 슬롯 키. 문자열을 손으로 조립하지 말 것 — 키 목록은 계단
 *  레지스트리와 **같은 6종**이고, 갈리면 조용히 빈 엔트리를 읽는다. */
export function peakWallCountsKey(side: 'ask' | 'bid', family: PeakWallFamilyId): PeakWallStepKey {
  if (family === 'Traded') return side === 'ask' ? 'ask-traded' : 'bid-traded';
  if (family === 'AllWall') return side === 'ask' ? 'ask-all' : 'bid-all';
  return side === 'ask' ? 'ask-unreached' : 'bid-unreached';
}

/** 발행에 필요한 여섯 칸 — **원시값만** 받는다(아래 훅의 deps 계약). */
export type PeakWallCountsInput = Readonly<Record<PeakWallStepKey, PeakWallCounts>>;

/**
 * 차트 → 레지스트리 발행. `LiveChartRoot` 에서 빼 둔 이유는 **deps 계약을 테스트로
 * 고정하기 위해서**다.
 *
 * `register()` 는 조건 없이 스토어를 쓴다. 그래서 effect 가 팬·줌마다 돌면 그 쓰기가
 * 설정 패널 재렌더로 새어 나간다 — 개수는 그대로인데. 훅은 **열두 숫자를 각각**
 * deps 로 나열해 값이 실제로 바뀔 때만 쓰게 만든다(객체를 넣으면 참조가 매번 새롭다).
 */
export function usePeakWallCountsPublisher(
  scope: string | null,
  applicable: boolean,
  counts: PeakWallCountsInput,
): void {
  const {
    'ask-traded': askTraded,
    'ask-all': askAll,
    'ask-unreached': askUnreached,
    'bid-traded': bidTraded,
    'bid-all': bidAll,
    'bid-unreached': bidUnreached,
  } = counts;

  useEffect(() => {
    const reg = usePeakWallCountsRegistry.getState();
    // 적용되지 않는 봉에서는 **등록하지 않는다** — 부재가 "데이터 없음" 이다.
    if (!applicable) {
      for (const key of PEAK_WALL_COUNT_KEYS) reg.unregister(scope, key);
      return undefined;
    }
    reg.register(scope, 'ask-traded', askTraded);
    reg.register(scope, 'ask-all', askAll);
    reg.register(scope, 'ask-unreached', askUnreached);
    reg.register(scope, 'bid-traded', bidTraded);
    reg.register(scope, 'bid-all', bidAll);
    reg.register(scope, 'bid-unreached', bidUnreached);
    return () => {
      const cleanup = usePeakWallCountsRegistry.getState();
      for (const key of PEAK_WALL_COUNT_KEYS) cleanup.unregister(scope, key);
    };
    // deps 는 **원시값 12개**다. 객체(askTraded 등)를 그대로 넣으면 참조가 매 렌더
    // 새로워져 팬·줌마다 스토어를 다시 쓴다 — 그게 이 훅이 존재하는 이유다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scope, applicable,
    askTraded.shown, askTraded.hiddenByFilter,
    askAll.shown, askAll.hiddenByFilter,
    askUnreached.shown, askUnreached.hiddenByFilter,
    bidTraded.shown, bidTraded.hiddenByFilter,
    bidAll.shown, bidAll.hiddenByFilter,
    bidUnreached.shown, bidUnreached.hiddenByFilter,
  ]);
}

const PEAK_WALL_COUNT_KEYS: readonly PeakWallStepKey[] = [
  'ask-traded', 'ask-all', 'ask-unreached',
  'bid-traded', 'bid-all', 'bid-unreached',
];
