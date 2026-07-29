/**
 * 창 rect 좌표계 변환 — 비율(저장) ↔ px(계산·렌더). ADR-0122.
 *
 * 스토어는 캔버스 대비 **비율**(0~1)을 들고, `snapEngine` 은 여전히 **px**
 * 를 받는 순수 함수다. 그 사이를 잇는 유일한 지점이 이 모듈이고, 캔버스가 렌더
 * 직전 `toPx`, 커밋 직전 `toFrac` 을 부른다. 좌표계 전환의 표면적을 여기로 가둔다.
 *
 * 불변식(ADR-0127 개정): 창은 좌/우/아래로 캔버스를 **벗어날 수 있다**. 대신 헤더
 * 손잡이가 언제나 캔버스 안에 남는다 — 원래 불변식(`x+w ≤ 1`)이 지키려던 건 "창이
 * 캔버스 안"이 아니라 "창을 다시 잡을 수 있음"이었고, 후자만 남긴 게 지금 규칙이다.
 * 클램프는 toFrac 한 곳에서만 하고, 그 경계는 `moveBounds` 가 드래그와 공유한다 —
 * 여러 곳에서 각자 재면 "끌 수 있는 곳"과 "저장되는 곳"이 어긋난다.
 */
import { moveBounds, type Canvas, type Rect } from './snapEngine';

/** 캔버스 대비 비율 rect. 필드 이름은 px Rect 와 같지만 **단위가 다르다**(0~1). */
export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 0 나눗셈 방지 — 캔버스가 아직 실측되지 않은 프레임에서만 발생한다. */
function safe(n: number): number {
  return n > 0 ? n : 1;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function toPx(frac: FracRect, canvas: Canvas): Rect {
  return {
    x: frac.x * canvas.w,
    y: frac.y * canvas.h,
    w: frac.w * canvas.w,
    h: frac.h * canvas.h,
  };
}

/**
 * px → 비율. 크기는 캔버스를 넘을 때만 깎고(넘지 않으면 그대로), 위치는 `moveBounds`
 * 로 클램프한다 — 즉 화면 밖으로 걸친 배치는 걸친 채로 저장된다(ADR-0127). 크기를
 * 먼저 살리는 이유는 그대로다: 크기를 깎으면 경계로 드래그할 때마다 창이 야금야금
 * 작아진다.
 */
export function toFrac(rect: Rect, canvas: Canvas): FracRect {
  const w = clamp01(rect.w / safe(canvas.w));
  const h = clamp01(rect.h / safe(canvas.h));
  // 노출 보장은 **깎인 뒤** 크기로 재야 한다 — 캔버스보다 큰 창을 원래 크기로 재면
  // 왼쪽 이탈 한계가 실제보다 넉넉하게 나와 손잡이가 밖으로 새어나간다.
  const b = moveBounds({ ...rect, w: w * safe(canvas.w), h: h * safe(canvas.h) }, canvas);
  return {
    x: Math.min(Math.max(rect.x, b.minX), b.maxX) / safe(canvas.w),
    y: Math.min(Math.max(rect.y, b.minY), b.maxY) / safe(canvas.h),
    w,
    h,
  };
}

/**
 * 비율 rect 로 인정할 수 있는 값인가 — 저장값 검증용(레거시 px 는 여기서 걸린다).
 *
 * ADR-0127 이후 위치는 [0,1] 을 벗어날 수 있으므로, 레거시 px 판별은 **크기 축**이
 * 짊어진다(px 크기는 항상 1 을 한참 넘는다 — 위치보다 오히려 더 견고한 판별자다).
 * 위치에 남은 건 "되찾을 수 있는가"뿐: 완전히 좌/우로 사라졌거나 위로 올라간 창은
 * 손잡이가 없어 거부한다. 정상 커밋 경로(`toFrac`)는 이보다 좁게 클램프하므로,
 * 여기 걸리는 값은 손으로 고쳤거나 깨진 저장값뿐이다.
 */
export function isFracRect(r: { x: number; y: number; w: number; h: number }): boolean {
  return (
    r.w > 0 &&
    r.h > 0 &&
    r.w <= 1.0001 &&
    r.h <= 1.0001 &&
    r.y >= 0 &&
    r.y < 1 &&
    r.x + r.w > 0 &&
    r.x < 1
  );
}
