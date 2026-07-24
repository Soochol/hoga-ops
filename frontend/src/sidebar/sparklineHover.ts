/** 스파크라인 위 마우스 X → 시각(ms) 환산. 프로그램·거래원 스파크라인의
 *  로컬 호버 크로스헤어가 공유하는 순수 기하. onMouseMove 핸들러가 얇게
 *  남도록 좌표 계산을 여기로 뺐다 — jsdom 은 getBoundingClientRect 를 0 으로
 *  주므로 이 로직은 컴포넌트 렌더가 아니라 이 함수의 단위 테스트로 고정한다.
 *
 *  플롯 폭 밖(비율 <0 또는 >1)이면 null — 커서를 그리지 않는다. 예전엔 [0,1]
 *  로 클램프해 끝값에 붙였는데, 거래원 스파크라인처럼 좁은 grid 가운데 열에서는
 *  인접 열(순매수/거래원명)이나 divider 경계에 마우스가 걸치면 x 가 플롯 밖이라
 *  커서가 tsLast(우측 끝)로 튀는 버그를 낳았다. 폭 0 도 매핑 불가라 null. */
export function hoverMsFromClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  tFirst: number,
  tLast: number,
): number | null {
  if (rectWidth <= 0) return null;
  const ratio = (clientX - rectLeft) / rectWidth;
  if (ratio < 0 || ratio > 1) return null;
  return tFirst + ratio * (tLast - tFirst);
}

/** 플롯 높이 대비 커서 Y 비율(0=위,1=아래) → 그 높이의 값. 스파크라인의
 *  toY(v)=H-((v-vMin)/vSpan)·H 를 뒤집은 것 — 데이터 곡선에 스냅하지 않고
 *  마우스가 가리키는 실제 높이를 읽는다(캔들차트 Normal crosshair). r=0 은
 *  플롯 상단(vMax), r=1 은 하단(vMin). */
export function valueFromYRatio(ratio: number, vMin: number, vMax: number): number {
  return vMax - ratio * (vMax - vMin);
}
