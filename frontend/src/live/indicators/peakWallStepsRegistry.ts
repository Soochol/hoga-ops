import { useEffect } from 'react';
import { createWindowScopedRegistry, type RegistryScopeId } from './windowScopedRegistry';
import type { PeakWallStepPoint } from '../../chart/peakWallSteps';

export type PeakWallStepSide = 'ask' | 'bid';
/** 계단으로 그릴 수 있는 벽 계열 — 캔들 pane 의 세 선과 1:1. */
export type PeakWallStepFamily = 'traded' | 'all' | 'unreached';

/** `${side}-${family}` 슬롯 키. 레지스트리 키와 pane 의 레전드 셀이 **이 목록 하나에서**
 *  파생돼야 둘이 갈리지 않는다 — 문자열을 양쪽에 손으로 적으면 한쪽이 조용히 빈 슬롯을
 *  읽는다(write-only 슬롯 부패). */
export type PeakWallStepKey = `${PeakWallStepSide}-${PeakWallStepFamily}`;

/** 셀 라벨까지 함께 들고 있는 단일 진실. pane spec 이 이 배열을 map 해 series 를 만든다. */
export const PEAK_WALL_STEP_SLOTS: ReadonlyArray<{
  key: PeakWallStepKey;
  side: PeakWallStepSide;
  family: PeakWallStepFamily;
  /** pane 레전드 셀 라벨. pane 제목이 「최대벽」이라 방향+계열만 적는다. */
  label: string;
}> = [
  { key: 'ask-traded', side: 'ask', family: 'traded', label: '매도 체결' },
  { key: 'ask-all', side: 'ask', family: 'all', label: '매도 전체' },
  { key: 'ask-unreached', side: 'ask', family: 'unreached', label: '매도 미도달' },
  { key: 'bid-traded', side: 'bid', family: 'traded', label: '매수 체결' },
  { key: 'bid-all', side: 'bid', family: 'all', label: '매수 전체' },
  { key: 'bid-unreached', side: 'bid', family: 'unreached', label: '매수 미도달' },
];

/** 한 (방향, 계열)의 계단 — 이미 축 좌표로 투영된 점 배열. pane 프로젝터는 이 값을
 *  **그대로 돌려주기만** 한다(pass-through). */
export type PeakWallStepSlot = {
  points: readonly PeakWallStepPoint[];
};

/**
 * 최대벽 계단의 (창, 방향·계열) → 계단 점 레지스트리.
 *
 * `LiveChartRoot` 가 `usePeakWallRender` 의 세그먼트에서 계단을 `useMemo` 로 한 번
 * 만들어 등록하고, `peak-wall` pane 의 `useContext` 가 자기 창 스코프를 구독한다.
 * pane spec 은 모듈 상수라 props 로 내려줄 수 없어 이 통로가 필요하다 —
 * `dailyMaSeriesRegistry` 와 같은 모양(차트가 만든 것을 다른 표면이 읽는다).
 *
 * ⚠ 세그먼트가 아니라 **이미 투영된 계단 점**을 넣는다. 세그먼트는 팬·줌마다 재계산될
 * 수 있는데, 그걸 넣으면 팬 한 번이 스토어 쓰기 → 구독자 재렌더 → 프로젝터 재계산으로
 * 이어진다. 계단을 상류에서 접어 넣으면 pane 은 그리기만 한다.
 *
 * 창 스코프가 필요한 이유는 `windowScopedRegistry` 의 주석 그대로다 — 고정 키를
 * 쓰면 창 B 의 마운트가 창 A 의 값을 덮어쓴다.
 *
 * **계열별로 갈라진 이유**(2026-08-25): 종전 키는 `'ask' | 'bid'` 뿐이라 계단이 체결된
 * 벽 하나만 나를 수 있었다. 캔들 pane 은 세 선을 그리는데 강도 pane 만 하나였던
 * 비대칭을 없앤다.
 *
 * **어느 계열이 나오는가는 pane 전용 키가 정한다**(2026-08-26): `{side}Peak{Family}
 * PaneEnabled` 여섯 — **방향별**이고 캔들 선 토글과 독립이다. 종전엔 캔들 선 토글을
 * 따라갔는데, 두 표면이 답하는 질문이 다르므로("그날 어디에 벽이 있었나" vs "그 벽이
 * 언제 얼마나 자랐나") 한쪽만 보고 싶은 조합이 원리적으로 불가능했다. 슬롯은 6개
 * (방향 2 × 계열 3)이고 **pane 은 하나**다 — 방향 공용인 것은 pane 쪽
 * (`peakWallPaneEnabled`)이지 슬롯이 아니다.
 *
 * **실효 조건은 그 둘의 곱이다**: `LiveChartRoot` 가 `needStepSegments:
 * peakWallPaneEnabled` 로 계단 계산 자체를 게이트하고, `usePeakWallRender` 가 그 안에서
 * 다시 슬롯 키를 본다. 마스터가 닫혀 있으면 슬롯이 켜져 있어도 **계단이 계산되지
 * 않는다** — 설정 패널의 슬롯 스위치가 `마스터 && 슬롯` 으로 접혀 보이는 이유가
 * 그것이다(`PeakWallsConfig` 의 `PaneSlotSwitch`). 화면이 이 식을 그대로 그린다.
 */
export const usePeakWallStepsRegistry =
  createWindowScopedRegistry<PeakWallStepKey, PeakWallStepSlot>();

/** 여섯 칸의 계단 점 — 발행자가 한 번에 만들어 넘긴다. */
export type PeakWallStepPointsInput = Readonly<Record<PeakWallStepKey, readonly PeakWallStepPoint[]>>;

/**
 * 차트 → 레지스트리 발행. `usePeakWallCountsPublisher` 와 같은 자리에 둔 이유도 같다 —
 * **쓰기 조건을 테스트로 고정하기 위해서**다.
 *
 * ## 왜 조건이 필요한가 (2026-09-01 실측)
 *
 * `register()` 는 값을 묻지 않고 쓴다. 종전 발행은 `{ points }` **래퍼를 매번 새로**
 * 만들었으므로 점 배열이 그대로여도 스토어가 바뀌었고, `useSyncExternalStore` 알림은
 * **SyncLane** 이라(react-dom `forceStoreRerender`) 그 커밋마다 React 의 nested-update
 * 계수가 올랐다. 50 연속이면 `checkForNestedUpdates` 가 던진다 — 그게 좌팬 중
 * "Maximum update depth exceeded" 로 차트가 죽던 경로다. 갱신 루프 덫이 잡은 실측:
 *
 *     [update-loop] store=registry:peakWallSteps writes-in-one-frame=20
 *     frame: registry:peakWallSteps×20 · liveCursor×1 · groupChartLink×1 ·
 *            windowWarnings×1 · workspace×1
 *
 * 다른 스토어가 전부 1회일 때 이것만 20회다(= 이 이펙트가 한 프레임에 3~4번 돌며
 * 여섯 칸을 매번 새로 썼다).
 *
 * ## 처방 — 점 배열이 그대로면 쓰지 않는다
 *
 * 비교 대상은 래퍼가 아니라 **`points` 배열의 참조**다. 최대벽 pane 이 꺼져 있으면
 * 여섯 칸이 전부 같은 빈 배열 상수라 쓰기가 **0** 이 된다 — 그 상태가 폭주의 연료였다
 * (내용이 없는데도 커밋마다 6회씩 썼다). 켜져 있을 때는 계단이 실제로 다시 만들어진
 * 커밋에서만 쓴다.
 *
 * **`points` 객체 자체의 identity 로 판정하지 않는 이유**: 그건 상류 `useMemo` 의
 * deps(축·캔들·벽)가 움직일 때마다 새로 나온다. 그 신호로는 "값이 바뀌었나" 를 답할 수
 * 없고, 정확히 그 오해가 이 버그였다.
 */
export function usePeakWallStepsPublisher(
  scope: RegistryScopeId,
  points: PeakWallStepPointsInput,
): void {
  useEffect(() => {
    for (const slot of PEAK_WALL_STEP_SLOTS) {
      const next = points[slot.key];
      // 매 칸마다 최신 스냅샷을 다시 읽는다 — 앞 칸의 `register` 가 이미 맵을 갈았다.
      const reg = usePeakWallStepsRegistry.getState();
      if (reg.byScope.get(scope)?.get(slot.key)?.points === next) continue;
      reg.register(scope, slot.key, { points: next });
    }
  }, [scope, points]);

  // 회수는 **창이 바뀌거나 언마운트될 때만**. 같은 이펙트의 cleanup 으로 두면 값이
  // 바뀔 때마다 여섯 칸을 걷었다가 다시 심어 ① 쓰기가 두 배가 되고(실측 12회 —
  // unregister 6 + register 6, 위 멱등 조건이 통째로 무력해진다) ② 그 사이 구독자가
  // **빈 상태를 한 프레임 본다**. 두 번째가 특히 나쁘다: pane 이 매 갱신마다 잠깐
  // 비워졌다 다시 그려진다.
  useEffect(() => () => {
    const cleanup = usePeakWallStepsRegistry.getState();
    for (const slot of PEAK_WALL_STEP_SLOTS) cleanup.unregister(scope, slot.key);
  }, [scope]);
}
