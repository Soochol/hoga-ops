/**
 * 창 rect 좌표계 변환 — 비율(저장) ↔ px(계산·렌더). ADR-0122.
 *
 * 스토어는 캔버스 대비 **비율**(0~1)을 들고, `snapEngine`·`tidy` 는 여전히 **px**
 * 를 받는 순수 함수다. 그 사이를 잇는 유일한 지점이 이 모듈이고, 캔버스가 렌더
 * 직전 `toPx`, 커밋 직전 `toFrac` 을 부른다. 좌표계 전환의 표면적을 여기로 가둔다.
 *
 * 불변식: 비율 rect 는 항상 [0,1] 안에 있고 `x+w ≤ 1`, `y+h ≤ 1` 이다. 이게 지켜지면
 * 창이 캔버스 밖으로 나가는 상태가 **표현 불가능**해진다(= ADR-0122 가 없애려는 것).
 * 클램프는 toFrac 한 곳에서만 한다 — 여러 곳에서 하면 어디가 진실인지 흐려진다.
 */
import type { Canvas, Rect } from './snapEngine';

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
 * px → 비율. 캔버스를 넘는 rect 는 **크기를 먼저 살리고 위치를 밀어넣어** 클램프한다
 * (크기를 깎으면 드래그 중 창이 야금야금 작아진다). 크기 자체가 캔버스보다 크면
 * 그때만 크기를 캔버스에 맞춘다.
 */
export function toFrac(rect: Rect, canvas: Canvas): FracRect {
  const w = clamp01(rect.w / safe(canvas.w));
  const h = clamp01(rect.h / safe(canvas.h));
  const x = clamp01(rect.x / safe(canvas.w));
  const y = clamp01(rect.y / safe(canvas.h));
  return {
    x: Math.min(x, 1 - w),
    y: Math.min(y, 1 - h),
    w,
    h,
  };
}

/** 비율 rect 로 인정할 수 있는 값인가 — 저장값 검증용(레거시 px 는 여기서 걸린다). */
export function isFracRect(r: { x: number; y: number; w: number; h: number }): boolean {
  return (
    r.w > 0 &&
    r.h > 0 &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.x + r.w <= 1.0001 &&
    r.y + r.h <= 1.0001
  );
}
