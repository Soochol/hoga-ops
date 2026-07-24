/** 스파크라인 위 마우스 X → 시각(ms) 환산. 프로그램·거래원 스파크라인의
 *  로컬 호버 크로스헤어가 공유하는 순수 기하. onMouseMove 핸들러가 얇게
 *  남도록 좌표 계산을 여기로 뺐다 — jsdom 은 getBoundingClientRect 를 0 으로
 *  주므로 이 로직은 컴포넌트 렌더가 아니라 이 함수의 단위 테스트로 고정한다.
 *
 *  플롯 폭에 대한 커서 비율을 [0,1] 로 클램프해 시간 도메인 [tFirst,tLast]
 *  에 매핑한다(양끝을 넘어가도 끝에 붙는다). 폭이 0 이면 매핑 불가라 null. */
export function hoverMsFromClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  tFirst: number,
  tLast: number,
): number | null {
  if (rectWidth <= 0) return null;
  const ratio = (clientX - rectLeft) / rectWidth;
  const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return tFirst + clamped * (tLast - tFirst);
}
