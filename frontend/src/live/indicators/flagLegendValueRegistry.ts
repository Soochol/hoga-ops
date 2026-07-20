import type { LegendFlagId } from '../legendRows';

/** One value cell of a flag legend row: optional dim label + swatch color and
 *  the pre-formatted value string (providers own their formatting — price,
 *  "가격, 수량", "N건" 등 지표별 의미가 달라 레전드는 문자열만 다룬다). */
export type FlagLegendValueCell = {
  key: string;
  label?: string;
  color?: string;
  value: string;
};

/** Resolves a flag indicator's legend cells for the cursor position.
 *  `cursorTimeSec` is the crosshair time in virtual seconds (the chart's Time
 *  domain); null = cursor away → provider falls back to its latest value
 *  (MA row의 latest-fallback 규칙 미러). Empty array = nothing to show. */
export type FlagLegendValueProvider = (cursorTimeSec: number | null) => FlagLegendValueCell[];

/** 등록 스코프 = 워크스페이스 차트 창의 id. null = 전역(멀티창 Provider 밖:
 *  `/study`·단일 차트). 소비자는 `useWindowScopeId()` 로 이 값을 얻는다. */
export type FlagLegendScopeId = string | null;

/** Shared registry of flag legend value providers, keyed by **창 → `LegendFlagId`**.
 *
 *  스코프가 키에 들어간 이유(#706 멀티창): 설정값(enabled/hidden/색)은 `useWindowIndicator`
 *  로 창별 격리돼 있는데 값 경로만 flag-id 단일 키였다. 서로 다른 종목의 차트 창 둘이
 *  같은 지표를 켜면 나중에 마운트된 창의 provider 가 앞선 것을 덮어써, 삼성전자 창의
 *  레전드에 SK하이닉스 가격대 값이 표시됐다(축 범위 밖 값 노출). register/unregister/read
 *  세 경로를 함께 스코프한다 — 하나만 고치면 비대칭이 생긴다.
 *
 *  중첩 Map(합성 문자열 키가 아니라)인 이유: 바깥 키가 `windowId | null` 자체라
 *  구분자도 "전역" 센티넬 문자열도 필요 없다 — 영속 스토어에서 복원된 임의의 창
 *  id 와 충돌할 여지가 없고, 창 정리가 접두 스캔 없이 O(1) 이다.
 *
 *  Deliberately NON-reactive (plain module Map, not zustand): providers are
 *  re-registered whenever their captured data changes — broker late-entry의
 *  경우 SSE 틱마다 갱신되는데, 반응형 스토어면 그 틱마다 PaneLegendOverlay가
 *  재렌더돼 P1(레전드의 SSE 틱 재렌더 차단)이 무너진다. 레전드는 어차피
 *  크로스헤어 이동·dataEpoch(캔들 갱신)·스토어 토글로 재렌더하므로 그 시점에
 *  최신 provider를 lazy 하게 읽으면 충분하다. 첫 마운트 프레임에 값이 비어도
 *  다음 tick(가시범위 구독 rAF)에서 self-heal — pane geometry와 동일 규칙.
 *  (창 스코프도 이 계약 안에서 해결한다 — context/zustand 로 옮기지 말 것.) */
const byScope = new Map<FlagLegendScopeId, Map<LegendFlagId, FlagLegendValueProvider>>();

export function registerFlagLegendValues(
  scope: FlagLegendScopeId,
  id: LegendFlagId,
  provider: FlagLegendValueProvider,
): void {
  let scoped = byScope.get(scope);
  if (!scoped) {
    scoped = new Map();
    byScope.set(scope, scoped);
  }
  scoped.set(id, provider);
}

/** Unregister only when the stored provider is the caller's own (a stale
 *  cleanup from a previous effect must not clobber the fresh registration). */
export function unregisterFlagLegendValues(
  scope: FlagLegendScopeId,
  id: LegendFlagId,
  provider: FlagLegendValueProvider,
): void {
  const scoped = byScope.get(scope);
  if (!scoped || scoped.get(id) !== provider) return;
  scoped.delete(id);
  if (scoped.size === 0) byScope.delete(scope);
}

export function readFlagLegendValues(
  scope: FlagLegendScopeId,
  id: LegendFlagId,
  cursorTimeSec: number | null,
): FlagLegendValueCell[] {
  const provider = byScope.get(scope)?.get(id);
  if (!provider) return [];
  try {
    return provider(cursorTimeSec);
  } catch {
    // A provider crash must not take down the legend render frame.
    return [];
  }
}

/** 창 닫힘 정리 — 그 창의 모든 flag provider 를 버린다. 컴포넌트 오버레이는 자기
 *  effect cleanup 으로 이미 해제하지만, projector 경로(`ratio.ts` 의 broker
 *  late-entry)는 언마운트 훅이 없어 캡처한 마커/축을 붙든 채 남는다. 창 수명에
 *  묶인 단일 정리 지점을 둬 그 누수를 막는다. */
export function clearWindowFlagLegendValues(windowId: string): void {
  byScope.delete(windowId);
}
