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

/** Shared registry of flag legend value providers, keyed by `LegendFlagId`.
 *
 *  Deliberately NON-reactive (plain module Map, not zustand): providers are
 *  re-registered whenever their captured data changes — broker late-entry의
 *  경우 SSE 틱마다 갱신되는데, 반응형 스토어면 그 틱마다 PaneLegendOverlay가
 *  재렌더돼 P1(레전드의 SSE 틱 재렌더 차단)이 무너진다. 레전드는 어차피
 *  크로스헤어 이동·dataEpoch(캔들 갱신)·스토어 토글로 재렌더하므로 그 시점에
 *  최신 provider를 lazy 하게 읽으면 충분하다. 첫 마운트 프레임에 값이 비어도
 *  다음 tick(가시범위 구독 rAF)에서 self-heal — pane geometry와 동일 규칙. */
const providers = new Map<LegendFlagId, FlagLegendValueProvider>();

export function registerFlagLegendValues(id: LegendFlagId, provider: FlagLegendValueProvider): void {
  providers.set(id, provider);
}

/** Unregister only when the stored provider is the caller's own (a stale
 *  cleanup from a previous effect must not clobber the fresh registration). */
export function unregisterFlagLegendValues(id: LegendFlagId, provider: FlagLegendValueProvider): void {
  if (providers.get(id) === provider) providers.delete(id);
}

export function readFlagLegendValues(
  id: LegendFlagId,
  cursorTimeSec: number | null,
): FlagLegendValueCell[] {
  const provider = providers.get(id);
  if (!provider) return [];
  try {
    return provider(cursorTimeSec);
  } catch {
    // A provider crash must not take down the legend render frame.
    return [];
  }
}
