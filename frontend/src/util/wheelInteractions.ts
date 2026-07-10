/**
 * Pure helper that computes a new lightweight-charts logical range
 * (`{from, to}`) for one wheel event on the replay chart.
 *
 * Three branches, selected by modifiers:
 *  - `shiftKey` → pan: translate the range, span unchanged.
 *  - `ctrlOrMetaKey` → zoom anchored at the mouse coordinate.
 *  - default → zoom anchored at the latest candle (`lastBarIndex`) when it is
 *    at/inside the right edge, else at `range.to` (the viewport right edge,
 *    when scrolled into history).
 *
 * Right wall: only the shift branch clamps when rightward motion would
 * push `to` past `maxTo` (typically the last candle's logical index).
 * The ctrl and plain branches preserve their anchor's screen position
 * unconditionally and let `to` extend past `maxTo` — clamping `to` while
 * leaving `from` at the formula value would warp the anchor. `maxTo` only
 * bounds shift-pan.
 *
 * No DOM, no chart library — separated so the branching logic is
 * unit-testable without mounting a chart.
 *
 * See: `docs/superpowers/specs/2026-05-24-replay-mouse-interactions-design.md`,
 *      `docs/superpowers/specs/2026-05-24-replay-wheel-right-wall-design.md`
 */

export interface WheelInput {
  range: { from: number; to: number };
  deltaY: number;
  shiftKey: boolean;
  ctrlOrMetaKey: boolean;
  /** Mouse X relative to the chart container's left edge, in CSS px. */
  mouseX: number;
  /** Chart `timeScale.coordinateToLogical(x)` callback (may return null). */
  coordinateToLogical: (x: number) => number | null;
  /**
   * Upper bound for the result's `to` — the latest candle's logical index plus
   * `rightOffset` (the default live-view position). The hook derives the index
   * via `ts.timeToIndex(latestCandleTime)`, NOT `bundle.candles.length - 1`:
   * the shared timeScale indexes the union of all panes' time points, so quote
   * panes add points and `candles.length - 1` understates the true index
   * (observed skew ~273). Pass `Number.POSITIVE_INFINITY` to disable the wall
   * (e.g., before data loads).
   */
  maxTo: number;
  /**
   * Logical index of the latest candle, used as the plain-wheel zoom anchor
   * when it sits at/inside the right edge. Keeps the latest candle pixel-fixed
   * on zoom IN as well as OUT — anchoring on `range.to` (which includes the
   * `rightOffset` padding) let the candle drift left on zoom-in as the
   * padding's pixel share grew. Source: `ts.timeToIndex(latestCandleTime)` in
   * the hook (same union-index reason as `maxTo` — `candles.length - 1` is
   * skewed). When omitted, or when the view is scrolled into history
   * (`range.to < lastBarIndex`), the anchor falls back to `range.to`
   * (right-edge-fixed, per design decision #1).
   */
  lastBarIndex?: number;
  /**
   * Upper bound for the result's span (visible bar count). Typically
   * `timeScale.width() / minBarSpacing` — the library's zoom-out floor.
   * Without this clamp, a zoom request past the floor gets its barSpacing
   * rejected by lightweight-charts while the right edge still applies,
   * degenerating the zoom into a rightward PAN that breaks the ctrl
   * anchor (/diagnose 2026-06-08). Clamping here preserves the anchor
   * ratio at the floor instead. Omit (or pass Infinity) to disable.
   */
  maxSpan?: number;
  /**
   * 줌아웃 좌단 벽(논리 인덱스). 줌 결과의 `from`이 이보다 왼쪽으로 못 간다 —
   * 데이터 좌단(-STEP_CANDLE_TARGET 바)을 넘는 빈공간을 줌이 여는 것을 막아,
   * "빈공간 = 채워야 할 수요"인 백필이 화면용량만큼(수개월치) 폭주하는 것을
   * 원천 차단한다(/investigate 2026-07-11: 30m 줌아웃 1.5초 입력 → 무입력
   * 12초간 fetch 15연발·3개월 확장 재현). 두 줌 분기에만 적용하고 shift-pan은
   * 두지 않는다 — 팬은 입력량에 선형이라 폭주 벡터가 아니고, 드래그 팬
   * (라이브러리 소유)과의 대칭도 지킨다. 현재 `range.from`이 이미 벽보다
   * 왼쪽이면(레거시 복원 등) 그 값이 벽이 된다: 줌이 상태를 더 악화시키지
   * 않되 스냅 점프도 만들지 않는 단조 가드. Omit이면 비활성.
   */
  minFrom?: number;
}

export type WheelOutcome = { from: number; to: number } | null;

export function computeWheelOutcome(i: WheelInput): WheelOutcome {
  const { from, to } = i.range;
  const span = to - from;
  if (span <= 0) return null;

  if (i.shiftKey) {
    const dir = Math.sign(i.deltaY);
    if (dir === 0) return null;
    const step = span * 0.1 * dir;
    const newFrom = from + step;
    const newTo = to + step;
    // Right wall: panning right past the last candle stops translating —
    // pin `to` at maxTo, preserve span.
    if (step > 0 && newTo > i.maxTo) {
      return { from: i.maxTo - span, to: i.maxTo };
    }
    return { from: newFrom, to: newTo };
  }

  // deltaY > 0 (wheel down) → factor > 1 → zoom OUT.
  // deltaY < 0 (wheel up) → factor < 1 → zoom IN.
  const factor = Math.exp(i.deltaY * 0.001);

  if (i.ctrlOrMetaKey) {
    const anchor = i.coordinateToLogical(i.mouseX) ?? to;
    const newFrom = anchor - (anchor - from) * factor;
    const newTo = anchor + (to - anchor) * factor;
    // No right-wall clamp here: clamping `to` while leaving `from` at the
    // formula value breaks the anchor-ratio invariant, causing the candle
    // under the mouse to drift on screen. The library renders empty space
    // past the last candle by design, so letting `to` exceed `maxTo` on
    // ctrl-zoom-out is acceptable. `maxTo` still constrains shift-pan.
    return clampZoomResult(newFrom, newTo, anchor, i);
  }

  // Default: anchor at the latest candle when it's at/inside the right edge
  // (live-edge zoom keeps the last candle pixel-fixed on zoom in AND out),
  // else at `to` (scrolled into history → pin the viewport right edge, per
  // decision #1). `Math.min(to, lastBarIndex)` selects between the two; with
  // lastBarIndex omitted it degrades to the old `anchor = to` behavior.
  const anchor = Math.min(to, i.lastBarIndex ?? to);
  const newFrom = anchor - (anchor - from) * factor;
  const newTo = anchor + (to - anchor) * factor;
  return clampZoomResult(newFrom, newTo, anchor, i);
}

/** 두 줌 분기 공통 클램프: span 상한(`maxSpan`, 라이브러리 플로어) 뒤에
 * 좌단 벽(`minFrom`)을 적용한다. 둘 다 앵커 비율 보존 방식 — 벽에 닿으면
 * from을 벽에 고정하고 to를 같은 비율로 재축소해, 커서 아래 바가 화면에서
 * 밀리지 않는다. `minFrom` 주석의 단조 가드(현재 from이 이미 벽 왼쪽이면
 * 그 값을 벽으로)도 여기서 처리한다. */
function clampZoomResult(
  from: number,
  to: number,
  anchor: number,
  i: WheelInput,
): { from: number; to: number } {
  const r = clampSpanAroundAnchor(from, to, anchor, i.maxSpan);
  if (i.minFrom == null) return r;
  const wall = Math.min(i.minFrom, i.range.from);
  // 벽 미접촉(줌인 포함) / 앵커가 벽 밖(레거시 심층 빈공간 뷰) → 클램프 불가.
  if (r.from >= wall || anchor <= wall) return r;
  const scale = (anchor - wall) / (anchor - r.from);
  return { from: wall, to: anchor + (r.to - anchor) * scale };
}

/**
 * Clamp a zoom result's span to `maxSpan` while keeping the anchor's
 * RATIO inside the range unchanged — so the bar under the cursor stays at
 * the same pixel even when the library's barSpacing floor is in play.
 * Shift-pan never calls this: its span is unchanged by construction.
 */
function clampSpanAroundAnchor(
  from: number,
  to: number,
  anchor: number,
  maxSpan: number | undefined,
): { from: number; to: number } {
  const span = to - from;
  const max = maxSpan ?? Number.POSITIVE_INFINITY;
  // !(max > 0): 0/NaN 가드 — 폭 미측정(width()=0) 등에서는 클램프 비활성.
  if (!(max > 0) || span <= max) return { from, to };
  const ratio = (anchor - from) / span;
  const clampedFrom = anchor - ratio * max;
  return { from: clampedFrom, to: clampedFrom + max };
}
