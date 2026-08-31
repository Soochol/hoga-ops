import { createWindowScopedRegistry } from './windowScopedRegistry';
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
