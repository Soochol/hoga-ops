// frontend/src/chart/drawing/translate.ts
//
// Drawing translation — the per-kind dispatcher that maps a (Δrealms,
// Δprice) into the shape-specific store patch. Lives in the drawing
// module so selectTool stays narrow (a tool is an interaction policy,
// not a geometry library) and so future drawing primitives plug in by
// extending one switch rather than threading through selectTool's
// onPointerMove.
//
// Hline carries no realMs of its own (it spans the full canvas width),
// so its translate-by-(Δms, Δprice) collapses to a price-only shift.
// Trendline shifts both endpoints. Pencil shifts every vertex.

import type { Drawing, Hline, Measure, PaneId, Pencil, Rect, Text, Trendline, Vline } from './types';
import { isLocked } from './types';

/**
 * Horizontal shift for a translation: either a flat Δrealms or a mapping
 * function. The function form exists because the drag path shifts in the
 * screen-uniform BAR ORDINAL domain — `toReal(toBar(ms) + dBar)` is not
 * expressible as a constant real-ms delta across session boundaries (a flat
 * Δms lands vertices inside inter-session gaps; see DragBarDomain).
 */
export type TimeShift = number | ((realMs: number) => number);

function toShiftFn(dMs: TimeShift): (realMs: number) => number {
  return typeof dMs === 'function' ? dMs : (ms) => ms + dMs;
}

/**
 * Body-drag translation: shift the whole drawing by (Δrealms, Δprice).
 * Returns the partial patch a caller passes to the store's `update`.
 */
export function translateDrawing(
  drawing: Drawing,
  dMs: TimeShift,
  dPrice: number,
): Partial<Drawing> {
  const shift = toShiftFn(dMs);
  switch (drawing.kind) {
    case 'hline':
      return translateHline(drawing, dPrice);
    case 'vline':
      return translateVline(drawing, shift);
    case 'trendline':
      return translateTrendline(drawing, shift, dPrice);
    case 'rect':
      return translateRect(drawing, shift, dPrice);
    case 'measure':
      return translateMeasure(drawing, shift, dPrice);
    case 'text':
      return translateText(drawing, shift, dPrice);
    case 'pencil':
      return translatePencil(drawing, shift, dPrice);
  }
}

type ShiftFn = (realMs: number) => number;

function translateHline(h: Hline, dPrice: number): Partial<Hline> {
  return { price: h.price + dPrice };
}

function translateVline(v: Vline, shift: ShiftFn): Partial<Vline> {
  // Time-only: vline carries no price, so Δprice is discarded (mirrors how
  // hline discards Δms).
  return { realMs: shift(v.realMs) };
}

function translateTrendline(t: Trendline, shift: ShiftFn, dPrice: number): Partial<Trendline> {
  return {
    a: { realMs: shift(t.a.realMs), price: t.a.price + dPrice },
    b: { realMs: shift(t.b.realMs), price: t.b.price + dPrice },
  };
}

function translateRect(r: Rect, shift: ShiftFn, dPrice: number): Partial<Rect> {
  return {
    a: { realMs: shift(r.a.realMs), price: r.a.price + dPrice },
    b: { realMs: shift(r.b.realMs), price: r.b.price + dPrice },
  };
}

function translateMeasure(m: Measure, shift: ShiftFn, dPrice: number): Partial<Measure> {
  return {
    a: { realMs: shift(m.a.realMs), price: m.a.price + dPrice },
    b: { realMs: shift(m.b.realMs), price: m.b.price + dPrice },
  };
}

function translateText(t: Text, shift: ShiftFn, dPrice: number): Partial<Text> {
  return { at: { realMs: shift(t.at.realMs), price: t.at.price + dPrice } };
}

function translatePencil(p: Pencil, shift: ShiftFn, dPrice: number): Partial<Pencil> {
  return {
    points: p.points.map((pt) => ({
      realMs: shift(pt.realMs),
      price: pt.price + dPrice,
    })),
    // Sub-bar offsets survive a translation unchanged: `shift` moves whole bar
    // ordinals (see TimeShift / DragBarDomain), so every vertex keeps the same
    // position WITHIN its bar. Copied rather than shared because
    // `cloneWithOffset` builds a duplicate from this patch — the clone must not
    // alias the original's array. Absent stays absent (a pre-subX stroke does
    // not grow an all-zero array just by being dragged).
    ...(p.subX ? { subX: [...p.subX] } : {}),
  };
}

/** Every price-bearing vertex of a Drawing (in pane Y-domain units). A vline
 *  has none, so it returns [] — clampDPriceForDrawing then leaves Δprice
 *  unclamped, which is correct (vline never moves vertically). */
export function pricesOf(drawing: Drawing): number[] {
  switch (drawing.kind) {
    case 'hline':
      return [drawing.price];
    case 'vline':
      return [];
    case 'trendline':
      return [drawing.a.price, drawing.b.price];
    case 'rect':
      return [drawing.a.price, drawing.b.price];
    case 'measure':
      return [drawing.a.price, drawing.b.price];
    case 'text':
      return [drawing.at.price];
    case 'pencil':
      return drawing.points.map((p) => p.price);
  }
}

/** Every time-bearing vertex of a Drawing (real Unix-ms). An hline has none,
 *  so it returns [] — clampDVirtualForDrawing then leaves Δvirtual unclamped,
 *  which is correct (hline discards the horizontal shift entirely). */
export function timesOf(drawing: Drawing): number[] {
  switch (drawing.kind) {
    case 'hline':
      return [];
    case 'vline':
      return [drawing.realMs];
    case 'trendline':
      return [drawing.a.realMs, drawing.b.realMs];
    case 'rect':
      return [drawing.a.realMs, drawing.b.realMs];
    case 'measure':
      return [drawing.a.realMs, drawing.b.realMs];
    case 'text':
      return [drawing.at.realMs];
    case 'pencil':
      return drawing.points.map((p) => p.realMs);
  }
}

/**
 * Cap a requested body-drag Δbar (leftward) so that EVERY vertex of `drawing`
 * stays at or right of the axis origin — the time-axis sibling of
 * `clampDPriceForDrawing`. Without it a leftward drag past the first session
 * would clamp vertices one by one against the origin (the domain's toReal
 * floors there), permanently compressing the shape. Rightward needs no cap:
 * the future band is open-ended.
 *
 * `toBar` and `originBar` must come from the SAME DragBarDomain the caller
 * shifts with — the cap is a comparison in that domain's units.
 */
export function clampDBarForDrawing(
  drawing: Drawing,
  dBar: number,
  originBar: number,
  toBar: (realMs: number) => number,
): number {
  if (dBar >= 0) return dBar;
  const times = timesOf(drawing);
  if (times.length === 0) return dBar;
  let minBar = Infinity;
  for (const t of times) minBar = Math.min(minBar, toBar(t));
  return Math.max(dBar, originBar - minBar);
}

/**
 * Cap a requested body-drag Δprice so that EVERY vertex of `drawing`
 * stays within the pane's price bounds after translation. The cap is
 * shape-preserving: the same dPrice is applied to all vertices, so the
 * trendline's spread / pencil's curvature survive a boundary hit. A
 * post-translate per-vertex clamp would have collapsed the shape at
 * the edge — see the v1 grill pass and the body-drag-shear note.
 *
 * Bounds may be in either order (top > bottom for KRW, bottom > top
 * on inverted scales); we sort internally.
 */
export function clampDPriceForDrawing(
  drawing: Drawing,
  dPrice: number,
  bounds: { top: number; bottom: number },
): number {
  const lo = Math.min(bounds.top, bounds.bottom);
  const hi = Math.max(bounds.top, bounds.bottom);
  const prices = pricesOf(drawing);
  // Freeze the drag if any vertex is already outside the bounds (e.g. an
  // autoscale shift while a drag is in flight). The alternative — letting
  // the clamp snap the drawing back to the edge — would surprise-yank it
  // out from under the cursor.
  for (const p of prices) {
    if (p < lo || p > hi) return 0;
  }
  let maxUp = Infinity;     // largest positive dPrice keeping every vertex ≤ hi
  let maxDown = -Infinity;  // most negative dPrice keeping every vertex ≥ lo
  for (const p of prices) {
    maxUp = Math.min(maxUp, hi - p);
    maxDown = Math.max(maxDown, lo - p);
  }
  return Math.max(maxDown, Math.min(maxUp, dPrice));
}

// ─── group translation (다중 선택 이동) ─────────────────────────────────────

/** Coordinate access `planGroupTranslate` needs, injected so the plan is a pure
 *  function of numbers (same SR-5 shape as HitCoord). */
export type GroupTranslateCoords = {
  priceToCanvasY(price: number, paneId: PaneId): number | null;
  canvasYToPrice(py: number, paneId: PaneId): number | null;
  priceBoundsForPane(paneId: PaneId): { top: number; bottom: number } | null;
  toBar(realMs: number): number;
  toReal(bar: number): number;
  originBar: number;
};

/** The magnitude-smaller of two same-signed deltas (0 wins over everything). */
function signedMin(a: number, b: number): number {
  return a >= 0 ? Math.min(a, b) : Math.max(a, b);
}

/**
 * Plan a group body-drag: one Δbar and one PIXEL Δy for the whole selection,
 * turned into per-drawing patches.
 *
 * Two things make this more than a loop over `translateDrawing`:
 *
 * **1. The vertical delta travels in PIXELS, not price.** A selection may span
 * panes, and each pane has its own price scale — a candle-pane Δprice of 500원
 * means nothing on an RSI pane. Carrying the cursor's Δy and converting it
 * per member (project the member's own reference price to Y, add Δy, read the
 * price back) is what makes cross-pane group drag land where the cursor went.
 * This is the same trick `duplicateSelectedRef` uses for its 14px offset.
 *
 * **2. The clamps are computed for the SET, then applied to everyone.** Capping
 * each member against its own pane bounds independently would stop the topmost
 * shape while the others kept going — the formation the user selected would
 * deform mid-drag. So each member reports the largest delta IT can take, and
 * the whole group moves by the smallest of those. That is the same
 * shape-preserving argument `clampDPriceForDrawing` makes for the vertices of
 * one drawing, one level up.
 *
 * Every member's allowance is computed against the RAW request (never against a
 * running minimum), so the result does not depend on the order of `members`.
 */
export function planGroupTranslate(
  members: readonly Drawing[],
  dBarRaw: number,
  dyPxRaw: number,
  coords: GroupTranslateCoords,
): { id: string; patch: Partial<Drawing> }[] {
  // ── horizontal: shared bar-ordinal domain, so cap directly in bars ──────
  let dBar = dBarRaw;
  for (const m of members) {
    dBar = signedMin(dBar, clampDBarForDrawing(m, dBarRaw, coords.originBar, coords.toBar));
  }

  // ── vertical: cap in PIXELS so panes with different scales agree ────────
  let dyPx = dyPxRaw;
  for (const m of members) {
    const prices = pricesOf(m);
    if (prices.length === 0) continue; // vline: no vertical component at all
    const bounds = coords.priceBoundsForPane(m.paneId);
    const ref = prices[0];
    const y0 = coords.priceToCanvasY(ref, m.paneId);
    if (bounds == null || y0 == null) continue;
    const want = coords.canvasYToPrice(y0 + dyPxRaw, m.paneId);
    if (want == null) continue;
    const rawDPrice = want - ref;
    const capped = clampDPriceForDrawing(m, rawDPrice, bounds);
    if (capped === rawDPrice) continue;
    // Re-express this member's price cap as a pixel cap so it is comparable
    // with the other panes'.
    const yCap = coords.priceToCanvasY(ref + capped, m.paneId);
    if (yCap != null) dyPx = signedMin(dyPx, yCap - y0);
  }

  const shift = (ms: number) => coords.toReal(coords.toBar(ms) + dBar);
  const out: { id: string; patch: Partial<Drawing> }[] = [];
  for (const m of members) {
    const prices = pricesOf(m);
    let dPrice = 0;
    if (prices.length > 0 && dyPx !== 0) {
      const ref = prices[0];
      const y0 = coords.priceToCanvasY(ref, m.paneId);
      const moved = y0 == null ? null : coords.canvasYToPrice(y0 + dyPx, m.paneId);
      if (moved != null) dPrice = moved - ref;
    }
    // Emit even when both deltas are 0: the shift round-trip is the identity
    // for a healthy vertex and HEALS one stranded in an inter-session gap by an
    // old real-ms drag (same reasoning as the single-drag path).
    out.push({ id: m.id, patch: translateDrawing(m, shift, dPrice) });
  }
  return out;
}

// ─── align / distribute (다중 선택 정렬·분배) ───────────────────────────────
//
// 이 두 연산이 그룹 이동과 다른 점 하나가 설계를 전부 결정한다: **멤버마다 델타가
// 다르다.** 그래서 `planGroupTranslate` 의 "집합 최소 클램프" 규칙이 여기엔 없다 —
// 대형을 지키는 것이 목적인 이동과 달리, 정렬은 대형을 **바꾸는** 것이 목적이라
// 각자 자기 팬 안에 남기만 하면 된다.

/** 정렬 기준 모서리. 화면 y 는 아래로 증가하므로 'top' 이 최소 y 다. */
export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
/** 분배 축. */
export type DistributeAxis = 'horizontal' | 'vertical';

/** 정렬·분배가 다루는 축. */
export type GeometryAxis = 'x' | 'y';

export type AlignCoords = GroupTranslateCoords & {
  realMsToCanvasX(realMs: number): number | null;
  /** 픽셀 X → realMs. 캔들 오른쪽 빈 구간에서는 null 이라 그 멤버의 수평 이동을
   *  건너뛴다(다른 경로들과 같은 degrade). */
  canvasXToRealMs(px: number): number | null;
};

/**
 * 이 도형이 그 축에 **범위를 갖는가**.
 *
 * 정렬이 "가장 흔한 두 종류에 정의되지 않는다" 는 문제의 답이 여기다. hline 은
 * 캔버스 전폭을 차지해 x 범위가 없고(`timesOf` 가 빈 배열), vline 은 전고를 차지해
 * y 범위가 없다. 축을 통째로 포기할 일이 아니라 **그 축에서 그 종류를 빼면** 된다 —
 * hline 여럿을 가격축으로 정렬·분배하는 것은 여전히 뜻이 통하고, 실제로 유용하다.
 *
 * 팝오버의 비활성 판정과 커널이 **같은 술어를 쓴다**(스타일 일괄의 `kindHasProp` 과
 * 같은 규율) — 갈리면 눌리는데 아무 일도 안 하는 버튼이 생긴다.
 *
 * ⚠ 커널 안에서는 이 술어가 `pixelSpan` 의 null 판정과 **겹친다**(축 값이 없으면
 * 투영할 것도 없다). 그래서 이 함수를 지워도 계획 결과는 변하지 않는다 — 이걸
 * 지키는 것은 커널 테스트가 아니라 **아래 술어 단위 테스트와 팝오버의 비활성
 * 테스트**다. 진짜 소비자는 UI 쪽이다: 거기엔 투영이 없어서 이 술어 말고는 "이
 * 버튼이 할 일이 있는가" 를 물을 방법이 없다.
 */
export function hasAxis(drawing: Drawing, axis: GeometryAxis): boolean {
  return (axis === 'x' ? timesOf(drawing) : pricesOf(drawing)).length > 0;
}

/** 그 축에서 실제로 옮길 수 있는 멤버들 — 축 범위가 있고 잠기지 않은 것. */
export function eligibleFor(members: readonly Drawing[], axis: GeometryAxis): Drawing[] {
  return members.filter((m) => !isLocked(m) && hasAxis(m, axis));
}

type Span = { min: number; max: number; center: number };

/** 멤버의 픽셀 범위. 투영이 하나도 안 되면 null(그 멤버는 이번 연산에서 빠진다). */
function pixelSpan(m: Drawing, axis: GeometryAxis, coords: AlignCoords): Span | null {
  const values = axis === 'x' ? timesOf(m) : pricesOf(m);
  const projected: number[] = [];
  for (const v of values) {
    const px = axis === 'x' ? coords.realMsToCanvasX(v) : coords.priceToCanvasY(v, m.paneId);
    if (px != null) projected.push(px);
  }
  if (projected.length === 0) return null;
  const min = Math.min(...projected);
  const max = Math.max(...projected);
  return { min, max, center: (min + max) / 2 };
}

/** 픽셀 델타 하나를 그 멤버의 도메인 패치로 바꾼다(축 하나만 움직인다). */
function patchFromPixelDelta(
  m: Drawing,
  axis: GeometryAxis,
  deltaPx: number,
  coords: AlignCoords,
): Partial<Drawing> | null {
  if (deltaPx === 0) return null;
  if (axis === 'x') {
    const times = timesOf(m);
    const ref = times[0];
    const x = coords.realMsToCanvasX(ref);
    if (x == null) return null;
    const moved = coords.canvasXToRealMs(x + deltaPx);
    if (moved == null) return null; // 빈 구간 — 이 멤버는 가만히 둔다
    // 봉 서수로 옮긴다. 평평한 Δms 는 정확히 이 파일이 존재하는 이유인 "세션 사이
    // 틈에 정점이 갇히는" 버그를 부른다.
    const rawDBar = coords.toBar(moved) - coords.toBar(ref);
    const dBar = clampDBarForDrawing(m, rawDBar, coords.originBar, coords.toBar);
    if (dBar === 0) return null;
    const shift = (ms: number) => coords.toReal(coords.toBar(ms) + dBar);
    return translateDrawing(m, shift, 0);
  }
  const prices = pricesOf(m);
  const ref = prices[0];
  const y = coords.priceToCanvasY(ref, m.paneId);
  if (y == null) return null;
  const moved = coords.canvasYToPrice(y + deltaPx, m.paneId);
  if (moved == null) return null;
  const bounds = coords.priceBoundsForPane(m.paneId);
  const rawDPrice = moved - ref;
  // 멤버별 클램프 — 집합 최소가 아니다. 정렬은 대형을 바꾸는 연산이라, 한 멤버가
  // 팬 경계에 걸린다고 나머지까지 붙잡아 둘 이유가 없다.
  const dPrice = bounds ? clampDPriceForDrawing(m, rawDPrice, bounds) : rawDPrice;
  if (dPrice === 0) return null;
  return translateDrawing(m, 0, dPrice);
}

const AXIS_OF: Record<AlignEdge, GeometryAxis> = {
  left: 'x', hcenter: 'x', right: 'x',
  top: 'y', vcenter: 'y', bottom: 'y',
};

/**
 * 선택을 한 모서리에 맞춘다.
 *
 * 기준은 **자격 있는 멤버들의 픽셀 외곽**이다(전체 멤버가 아니다) — hline 이 섞인
 * 선택을 좌측 정렬할 때 hline 은 기준에도, 대상에도 들어가지 않는다.
 *
 * 자격자가 하나뿐이면 자기 자신에게 맞추는 셈이라 빈 배열을 돌려준다. 그 판정이 곧
 * 버튼의 비활성 조건이다(`eligibleFor(...).length >= 2`).
 */
export function planAlign(
  members: readonly Drawing[],
  edge: AlignEdge,
  coords: AlignCoords,
): { id: string; patch: Partial<Drawing> }[] {
  const axis = AXIS_OF[edge];
  const targets = eligibleFor(members, axis)
    .map((m) => ({ m, span: pixelSpan(m, axis, coords) }))
    .filter((t): t is { m: Drawing; span: Span } => t.span != null);
  if (targets.length < 2) return [];

  const at =
    edge === 'left' || edge === 'top'
      ? Math.min(...targets.map((t) => t.span.min))
      : edge === 'right' || edge === 'bottom'
        ? Math.max(...targets.map((t) => t.span.max))
        : (Math.min(...targets.map((t) => t.span.min)) +
            Math.max(...targets.map((t) => t.span.max))) /
          2;

  const out: { id: string; patch: Partial<Drawing> }[] = [];
  for (const { m, span } of targets) {
    const from =
      edge === 'left' || edge === 'top'
        ? span.min
        : edge === 'right' || edge === 'bottom'
          ? span.max
          : span.center;
    const patch = patchFromPixelDelta(m, axis, at - from, coords);
    if (patch) out.push({ id: m.id, patch });
  }
  return out;
}

/**
 * 선택을 축 방향으로 **균등 간격**으로 편다.
 *
 * 양 끝은 그대로 두고 사이를 고르게 나눈다(편집기의 표준 동작). 중심 기준이라
 * 크기가 제각각인 도형들도 시각적으로 고르게 놓인다.
 *
 * 셋 미만이면 빈 배열이다 — 둘은 양 끝이라 나눌 사이가 없다.
 */
export function planDistribute(
  members: readonly Drawing[],
  axis: DistributeAxis,
  coords: AlignCoords,
): { id: string; patch: Partial<Drawing> }[] {
  const geo: GeometryAxis = axis === 'horizontal' ? 'x' : 'y';
  const targets = eligibleFor(members, geo)
    .map((m, i) => ({ m, i, span: pixelSpan(m, geo, coords) }))
    .filter((t): t is { m: Drawing; i: number; span: Span } => t.span != null);
  if (targets.length < 3) return [];

  // 중심으로 줄 세운다. 중심이 같은 둘은 **배열 순서**로 갈라 결과가 결정적이게
  // 한다(정렬이 불안정하면 같은 입력이 다른 그림을 낸다).
  const sorted = [...targets].sort((a, b) => a.span.center - b.span.center || a.i - b.i);
  const first = sorted[0].span.center;
  const last = sorted[sorted.length - 1].span.center;
  const total = last - first;
  // 전원이 한 점에 몰려 있으면 나눌 것이 없다 — 0 으로 나누지 않는다.
  if (total === 0) return [];
  const gap = total / (sorted.length - 1);

  const out: { id: string; patch: Partial<Drawing> }[] = [];
  sorted.forEach((t, idx) => {
    const patch = patchFromPixelDelta(t.m, geo, first + idx * gap - t.span.center, coords);
    if (patch) out.push({ id: t.m.id, patch });
  });
  return out;
}
