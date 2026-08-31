/**
 * 최대벽 화살표의 **도형 한 벌** — 축(shaft) + 머리(head).
 *
 * 두 표면이 이 모양을 공유한다:
 *  - **순위 화살표**(`PeakWallRankArrowsPrimitive`) — 캔들 극값에 붙어 "어느 봉이었나" 를 말한다.
 *  - **벽 발생 시점 마커**(`PeakWallSegmentsPrimitive`) — 벽 가격 선 위, peak 이 걸린 x 에 붙는다.
 *    2026-08-26 까지는 반지름 3.5px 의 점이었다.
 *
 * **왜 제3의 모듈인가**: `PeakWallRankArrowsPrimitive` 는 이미
 * `PeakWallSegmentsPrimitive` 에서 `xCoordinateOrNearest`·`PeakWallLabelSide` 를 가져온다.
 * 반대 방향으로 상수를 가져오면 순환 import 가 되고, 상수 초기화 순서에 의존하는 조용한
 * 버그를 부른다. 여기로 빼면 두 primitive 가 같은 잎(leaf)을 본다.
 *
 * 복제하지 말 것 — 두 표면이 같은 모양이라는 것이 사용자에게 보이는 계약이다(한쪽만
 * 다듬으면 같은 벽을 가리키는 두 마커가 서로 다른 화살표가 된다).
 */

/** 화살표 전체 길이(끝 → 꼬리). */
export const ARROW_HEIGHT_PX = 11;
/** 머리(삼각형) 높이. 나머지가 축이다. */
export const ARROW_HEAD_HEIGHT_PX = 5;
/** 머리 밑변의 반폭. */
export const ARROW_HALF_WIDTH_PX = 3.5;
/** 축 선 두께. 한때 같은 pane 에 있던 「호가벽 급증」의 속 찬 삼각형과 형태를 가르던
 *  부분이다 — 그 지표는 2026-08-26 에 제거됐지만(ADR-0162), 축이 있어야 화살표로
 *  읽히므로 형태는 그대로 둔다. */
export const ARROW_SHAFT_WIDTH_PX = 1.5;

export type PeakWallArrowInput = {
  /** 화살표 중심 x(비트맵 좌표). */
  cx: number;
  /** 화살표 **끝**의 y(비트맵 좌표) — 가리키는 지점. */
  tipY: number;
  /** 뻗는 방향. 매도 `-1`(끝이 아래 = 위에서 아래를 가리킴) · 매수 `+1`. */
  dir: 1 | -1;
  color: string;
  horizontalPixelRatio: number;
  verticalPixelRatio: number;
};

/**
 * 화살표를 그리고 **꼬리 y** 를 돌려준다(호출부가 순위 숫자 같은 것을 그 너머에 붙인다).
 *
 * `ctx` 의 `fillStyle`/`strokeStyle`/`lineWidth` 를 덮어쓴다 — 호출부가 그 뒤에 다른 것을
 * 그린다면 스스로 다시 세팅해야 한다(순위 화살표는 `ctx.save()`/`restore()` 안에서 부른다).
 */
export function drawPeakWallArrow(
  ctx: CanvasRenderingContext2D,
  { cx, tipY, dir, color, horizontalPixelRatio, verticalPixelRatio }: PeakWallArrowInput,
): number {
  const height = ARROW_HEIGHT_PX * verticalPixelRatio;
  const headHeight = ARROW_HEAD_HEIGHT_PX * verticalPixelRatio;
  const halfW = ARROW_HALF_WIDTH_PX * horizontalPixelRatio;
  const shaftW = Math.max(1, ARROW_SHAFT_WIDTH_PX * horizontalPixelRatio);
  const tailY = tipY + dir * height;
  const headBaseY = tipY + dir * headHeight;

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  // 축(shaft).
  ctx.lineWidth = shaftW;
  ctx.beginPath();
  ctx.moveTo(cx, tailY);
  ctx.lineTo(cx, headBaseY);
  ctx.stroke();
  // 머리(head).
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx - halfW, headBaseY);
  ctx.lineTo(cx + halfW, headBaseY);
  ctx.closePath();
  ctx.fill();
  return tailY;
}
