/**
 * 멀티창 워크스페이스 스냅 엔진 — 순수 로직 (ADR-0119).
 *
 * 창 이동·리사이즈 시 이웃 가장자리·정렬선·화면 경계에 흡착하는 계산을 전부
 * 여기에 모은다. React·DOM·스토어에 의존하지 않는 순수 함수라 단위 테스트로
 * 전 분기를 고정한다(`snapEngine.test.ts`). `WorkspaceCanvas` 는 포인터 좌표를
 * 이 엔진에 위임하는 얇은 껍데기다.
 *
 * 핵심 규칙(#707·#714):
 *  - 흡착 임계 `SNAP_THRESHOLD`(12px), 후보 우선순위 = 인접 > 정렬 > 화면 경계
 *    (near-tie 에서만 우선순위가 갈린다; 기본은 최근접).
 *  - 순수 변(e/w/n/s) 드래그는 맞닿은 이웃을 함께 조절(스플리터 승격). 이웃이
 *    최소 크기에 닿으면 드래그 변도 함께 멈춘다(follower MIN 클램프, #714 발견).
 *  - 모서리(2변) 드래그는 스플리터 승격 없음.
 *  - `alt=true` 면 흡착 해제(정밀 이동/리사이즈).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RectWin {
  id: string;
  rect: Rect;
}

export interface Canvas {
  w: number;
  h: number;
}

/** 리사이즈 모드 = 잡은 변/모서리. 길이 1 = 순수 변(스플리터 승격 대상). */
export type ResizeMode = 'e' | 'w' | 'n' | 's' | 'ne' | 'nw' | 'se' | 'sw';
export type Edge = 'e' | 'w' | 'n' | 's';

/** 흡착이 걸린 축의 가이드라인 좌표(px). null = 흡착 없음(가이드 숨김). */
export interface Guides {
  v: number | null;
  h: number | null;
}

export const SNAP_THRESHOLD = 12;
export const MIN_W = 160;
export const MIN_H = 120;
/** 두 변이 "맞닿았다"고 볼 허용 오차 — 스플리터 승격 대상 판정. */
export const ADJACENT_EPS = 2;
/**
 * 좌/우 화면 벽 반분할 스냅존의 트리거 폭(px, 벽으로부터).
 * 벽에 커서를 **밀착**시키는 제스처만 반분할로 친다 — 넓게 잡으면 창을 화면 밖으로
 * 밀어내는 제스처(ADR-0127)가 벽 근처에서 전부 반분할에 먹힌다.
 */
export const EDGE_ZONE_PX = 4;

/**
 * 창이 화면 밖으로 나가도 캔버스 안에 남겨두는 헤더(드래그 손잡이) 크기 — ADR-0127.
 * 이만큼은 항상 잡히므로 마우스만으로 창을 언제나 되찾을 수 있고, 그래서 "창 소환"
 * 같은 구제 수단이 필요 없다. 세로 값은 `WindowFrame` 헤더 높이(h-[26px])와 결속 —
 * 헤더보다 작게 잡으면 손잡이가 잘려 보이고, 크게 잡으면 본문까지 붙들려 이탈이 막힌다.
 */
export const GRAB_EXPOSE_W = 48;
export const GRAB_EXPOSE_H = 26;

/**
 * 이동으로 창 좌상단이 갈 수 있는 좌표 범위. 화면 밖 이탈을 허용하되 헤더 손잡이가
 * 캔버스 안에 남게 한다(ADR-0127).
 *
 * 위쪽만 이탈을 막는 이유는 비대칭이 아니라 **손잡이가 헤더 하나뿐**이기 때문이다.
 * 헤더는 창의 맨 위에 있어서, 위로 나가는 순간 가장 먼저 사라지는 게 손잡이 자신이다.
 * 나머지 세 방향은 무엇이 밖으로 나가든 헤더는 마지막까지 남는다.
 *
 * 드래그 중(`computeMove`)과 커밋 시(`rectSpace.toFrac`)가 이 한 함수를 공유한다 —
 * 두 곳이 각자 산술을 들면 "끌 수 있는 곳"과 "저장되는 곳"이 어긋난다.
 */
export function moveBounds(
  rect: Rect,
  canvas: Canvas,
): { minX: number; maxX: number; minY: number; maxY: number } {
  // 창이 노출 기준보다 작으면(이론상 MIN_W/MIN_H 아래) 창 자신이 노출 하한이 된다.
  const keepW = Math.min(GRAB_EXPOSE_W, rect.w);
  const keepH = Math.min(GRAB_EXPOSE_H, rect.h);
  return {
    minX: Math.min(0, keepW - rect.w), // 왼쪽 이탈 — 창의 오른쪽 끝 keepW 만 남는다
    maxX: Math.max(0, canvas.w - keepW), // 오른쪽 이탈 — 창의 왼쪽 끝 keepW 만 남는다
    minY: 0, // 위쪽 이탈 불가 — 헤더가 사라지면 다시 잡을 수단이 없다
    maxY: Math.max(0, canvas.h - keepH), // 아래쪽 이탈 — 헤더 높이만 남는다
  };
}

/** 후보 우선순위(작을수록 우선). near-tie 에서만 갈린다. */
const RANK_ADJACENT = 0;
const RANK_ALIGN = 1;
const RANK_BOUND = 2;

interface Candidate {
  val: number;
  guide: number;
  rank: number;
}

/**
 * raw 값을 후보들 중 임계 내 최근접으로 흡착한다. 거리가 같으면 우선순위(rank)가
 * 낮은 후보를 택한다(인접 > 정렬 > 경계). alt=true 면 흡착하지 않는다.
 */
export function snapAxis(
  raw: number,
  candidates: readonly Candidate[],
  alt: boolean,
): { val: number; guide: number | null } {
  if (alt) return { val: raw, guide: null };
  let best: Candidate | null = null;
  let bestDist = SNAP_THRESHOLD + 1;
  for (const c of candidates) {
    const dist = Math.abs(c.val - raw);
    if (dist > SNAP_THRESHOLD) continue;
    if (dist < bestDist || (dist === bestDist && c.rank < (best?.rank ?? Number.POSITIVE_INFINITY))) {
      best = c;
      bestDist = dist;
    }
  }
  return best ? { val: best.val, guide: best.guide } : { val: raw, guide: null };
}

/** 이동 시 X축 후보: 화면 경계 + 각 이웃의 인접/정렬 위치(창 좌상단 x 기준). */
function moveCandidatesX(w: number, others: readonly RectWin[], canvas: Canvas): Candidate[] {
  const cands: Candidate[] = [
    { val: 0, guide: 0, rank: RANK_BOUND },
    { val: canvas.w - w, guide: canvas.w, rank: RANK_BOUND },
  ];
  for (const { rect: o } of others) {
    cands.push(
      { val: o.x + o.w, guide: o.x + o.w, rank: RANK_ADJACENT }, // 내 왼변 ↔ 이웃 오른변
      { val: o.x - w, guide: o.x, rank: RANK_ADJACENT }, // 내 오른변 ↔ 이웃 왼변
      { val: o.x, guide: o.x, rank: RANK_ALIGN }, // 왼변 정렬
      { val: o.x + o.w - w, guide: o.x + o.w, rank: RANK_ALIGN }, // 오른변 정렬
    );
  }
  return cands;
}

function moveCandidatesY(h: number, others: readonly RectWin[], canvas: Canvas): Candidate[] {
  const cands: Candidate[] = [
    { val: 0, guide: 0, rank: RANK_BOUND },
    { val: canvas.h - h, guide: canvas.h, rank: RANK_BOUND },
  ];
  for (const { rect: o } of others) {
    cands.push(
      { val: o.y + o.h, guide: o.y + o.h, rank: RANK_ADJACENT },
      { val: o.y - h, guide: o.y, rank: RANK_ADJACENT },
      { val: o.y, guide: o.y, rank: RANK_ALIGN },
      { val: o.y + o.h - h, guide: o.y + o.h, rank: RANK_ALIGN },
    );
  }
  return cands;
}

/**
 * 창 이동을 계산한다. origin 에서 (dx,dy) 만큼 옮긴 뒤 `moveBounds` 로 클램프하고,
 * 이웃/경계에 흡착한다. 반환은 새 좌상단 좌표 + 가이드.
 *
 * 클램프는 "화면 안"이 아니라 "손잡이 노출"이다 — 창은 좌/우/아래로 화면을 벗어날 수
 * 있다(ADR-0127). 화면 경계 흡착 후보는 그대로 살아 있어서, 밖으로 밀어내는 길에
 * 가장자리 정렬 위치를 한 번 지나간다(임계 12px, Alt 로 해제).
 */
export function computeMove(args: {
  origin: Rect;
  dx: number;
  dy: number;
  others: readonly RectWin[];
  canvas: Canvas;
  alt: boolean;
}): { x: number; y: number; guides: Guides } {
  const { origin, dx, dy, others, canvas, alt } = args;
  const b = moveBounds(origin, canvas);
  const clampedX = Math.min(Math.max(origin.x + dx, b.minX), b.maxX);
  const clampedY = Math.min(Math.max(origin.y + dy, b.minY), b.maxY);
  const sx = snapAxis(clampedX, moveCandidatesX(origin.w, others, canvas), alt);
  const sy = snapAxis(clampedY, moveCandidatesY(origin.h, others, canvas), alt);
  return { x: sx.val, y: sy.val, guides: { v: sx.guide, h: sy.guide } };
}

/** 두 구간 [a1,a2), [b1,b2) 이 겹치는가(수직/수평 겹침 판정). */
function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 < b2 && a2 > b1;
}

/**
 * 순수 변(edge) 드래그의 스플리터 승격 대상 = 그 변에 맞닿고(±ADJACENT_EPS)
 * 수직/수평으로 겹치는 이웃들의 id.
 */
export function detectFollowers(dragged: Rect, edge: Edge, others: readonly RectWin[]): string[] {
  const ids: string[] = [];
  for (const { id, rect: o } of others) {
    const hOverlap = overlaps(o.y, o.y + o.h, dragged.y, dragged.y + dragged.h);
    const vOverlap = overlaps(o.x, o.x + o.w, dragged.x, dragged.x + dragged.w);
    const touch =
      edge === 'e'
        ? Math.abs(o.x - (dragged.x + dragged.w)) <= ADJACENT_EPS && hOverlap
        : edge === 'w'
          ? Math.abs(o.x + o.w - dragged.x) <= ADJACENT_EPS && hOverlap
          : edge === 's'
            ? Math.abs(o.y - (dragged.y + dragged.h)) <= ADJACENT_EPS && vOverlap
            : Math.abs(o.y + o.h - dragged.y) <= ADJACENT_EPS && vOverlap; // 'n'
    if (touch) ids.push(id);
  }
  return ids;
}

export interface ResizeResult {
  rect: Rect;
  /** 스플리터 승격으로 함께 조절된 이웃들의 새 rect(순수 변에서만 채워짐). */
  followers: RectWin[];
  guides: Guides;
}

/**
 * 창 리사이즈를 계산한다.
 *  - `others`: 드래그 창을 제외한 전체 창(흡착 후보 수집용, followers 포함).
 *  - `followers`: 스플리터 승격 대상(원본 rect). 순수 변에서만 비어있지 않다.
 * 활성 변마다 목표 좌표를 흡착하고, follower 가 최소 크기에 닿으면 함께 멈춘다.
 */
export function computeResize(args: {
  origin: Rect;
  mode: ResizeMode;
  dx: number;
  dy: number;
  others: readonly RectWin[];
  followers: readonly RectWin[];
  canvas: Canvas;
  alt: boolean;
}): ResizeResult {
  const { origin, mode, dx, dy, others, followers, canvas, alt } = args;
  const hasE = mode.includes('e');
  const hasW = mode.includes('w');
  const hasN = mode.includes('n');
  const hasS = mode.includes('s');
  const pure = mode.length === 1;
  const activeFollowers = pure ? followers : [];

  const xCands: Candidate[] = [
    { val: 0, guide: 0, rank: RANK_BOUND },
    { val: canvas.w, guide: canvas.w, rank: RANK_BOUND },
  ];
  const yCands: Candidate[] = [
    { val: 0, guide: 0, rank: RANK_BOUND },
    { val: canvas.h, guide: canvas.h, rank: RANK_BOUND },
  ];
  for (const { rect: o } of others) {
    xCands.push(
      { val: o.x, guide: o.x, rank: RANK_ADJACENT },
      { val: o.x + o.w, guide: o.x + o.w, rank: RANK_ADJACENT },
    );
    yCands.push(
      { val: o.y, guide: o.y, rank: RANK_ADJACENT },
      { val: o.y + o.h, guide: o.y + o.h, rank: RANK_ADJACENT },
    );
  }

  let { x, y, w, h } = origin;
  let gv: number | null = null;
  let gh: number | null = null;
  let edgeV = 0; // 새 세로 변(x) 좌표 — follower 적용에 사용
  let edgeH = 0; // 새 가로 변(y) 좌표

  // follower 들이 허용하는 극값 — 이웃이 MIN 에 닿으면 드래그 변도 여기서 멈춘다.
  const reduce = (sel: (f: Rect) => number, pick: 'min' | 'max'): number | null =>
    activeFollowers.length === 0
      ? null
      : activeFollowers
          .map((f) => sel(f.rect))
          .reduce((a, b) => (pick === 'min' ? Math.min(a, b) : Math.max(a, b)));

  /** 흡착 후 밴드[lo,hi]로 재클램프 — snapAxis 가 MIN 경계를 최대 12px 넘어 이웃으로
   *  당겨 드래그 창/follower 를 MIN 이하로 만드는 것을 막는다(hard MIN 보장). 넘어서
   *  잘렸으면 실제 흡착 목표에 도달하지 못했으므로 가이드를 숨긴다. */
  const snapClamped = (
    raw: number,
    cands: readonly Candidate[],
    lo: number,
    hi: number,
  ): { val: number; guide: number | null } => {
    const s = snapAxis(raw, cands, alt);
    const val = Math.min(Math.max(s.val, lo), hi);
    return { val, guide: val === s.val ? s.guide : null };
  };

  // 리사이즈는 캔버스 경계를 상한으로 쓴다 — 이동과 달리 변을 **새로** 화면 밖으로
  // 늘리지는 못한다(ADR-0127 은 이동만 다룬다). 다만 이동으로 이미 밖에 걸친 변까지
  // 안으로 되당기면 리사이즈를 잡는 순간 창이 튄다. 그래서 경계는 캔버스와 현재 변
  // 중 바깥쪽 — 이미 밖인 변은 제자리를 지키고, 안쪽으로 줄이는 건 그대로 열려 있다.
  const outerE = Math.max(canvas.w, origin.x + origin.w);
  const outerS = Math.max(canvas.h, origin.y + origin.h);
  const outerW = Math.min(0, origin.x);
  const outerN = Math.min(0, origin.y);

  // 밴드[lo,hi]가 역전되면(sub-MIN follower 가 드래그 변을 드래그 창 자신의 MIN
  // 아래로 밀려는 경우) 드래그 창 MIN 을 우선한다 — follower 는 이미 MIN 위반 상태라
  // 더 짜부되더라도 드래그 창은 hard MIN 을 지킨다.
  if (hasE) {
    let hi = outerE;
    const cap = reduce((f) => f.x + f.w - MIN_W, 'min');
    if (cap !== null) hi = Math.min(hi, cap);
    const lo = origin.x + MIN_W;
    hi = Math.max(hi, lo);
    const s = snapClamped(Math.max(lo, Math.min(origin.x + origin.w + dx, hi)), xCands, lo, hi);
    w = s.val - x;
    gv = s.guide;
    edgeV = s.val;
  }
  if (hasW) {
    let lo = outerW;
    const cap = reduce((f) => f.x + MIN_W, 'max');
    if (cap !== null) lo = Math.max(lo, cap);
    const hi = origin.x + origin.w - MIN_W;
    lo = Math.min(lo, hi);
    const s = snapClamped(Math.min(hi, Math.max(origin.x + dx, lo)), xCands, lo, hi);
    w = origin.x + origin.w - s.val;
    x = s.val;
    gv = s.guide;
    edgeV = s.val;
  }
  if (hasS) {
    let hi = outerS;
    const cap = reduce((f) => f.y + f.h - MIN_H, 'min');
    if (cap !== null) hi = Math.min(hi, cap);
    const lo = origin.y + MIN_H;
    hi = Math.max(hi, lo);
    const s = snapClamped(Math.max(lo, Math.min(origin.y + origin.h + dy, hi)), yCands, lo, hi);
    h = s.val - y;
    gh = s.guide;
    edgeH = s.val;
  }
  if (hasN) {
    let lo = outerN;
    const cap = reduce((f) => f.y + MIN_H, 'max');
    if (cap !== null) lo = Math.max(lo, cap);
    const hi = origin.y + origin.h - MIN_H;
    lo = Math.min(lo, hi);
    const s = snapClamped(Math.min(hi, Math.max(origin.y + dy, lo)), yCands, lo, hi);
    h = origin.y + origin.h - s.val;
    y = s.val;
    gh = s.guide;
    edgeH = s.val;
  }

  const followerRects: RectWin[] = activeFollowers.map(({ id, rect: f }) => {
    if (mode === 'e') return { id, rect: { ...f, x: edgeV, w: f.x + f.w - edgeV } };
    if (mode === 'w') return { id, rect: { ...f, w: edgeV - f.x } };
    if (mode === 's') return { id, rect: { ...f, y: edgeH, h: f.y + f.h - edgeH } };
    // 'n'
    return { id, rect: { ...f, h: edgeH - f.y } };
  });

  return { rect: { x, y, w, h }, followers: followerRects, guides: { v: gv, h: gh } };
}

export type SnapZone = 'left' | 'right' | null;

/**
 * 이동 중 포인터가 화면 좌/우 벽에 닿았는지 판정(반분할 스냅존). alt=해제.
 * `pointerX` 는 워크스페이스 좌측 기준 좌표.
 */
export function snapZone(pointerX: number, canvas: Canvas, alt: boolean): SnapZone {
  if (alt) return null;
  if (pointerX < EDGE_ZONE_PX) return 'left';
  if (pointerX > canvas.w - EDGE_ZONE_PX) return 'right';
  return null;
}

/** 반분할 스냅존이 만드는 최종 rect(좌/우 절반, 전체 높이). */
export function zoneRect(zone: 'left' | 'right', canvas: Canvas): Rect {
  const half = Math.round(canvas.w / 2);
  return { x: zone === 'left' ? 0 : half, y: 0, w: half, h: canvas.h };
}
