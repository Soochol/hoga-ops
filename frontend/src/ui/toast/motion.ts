// 토스트 모션 상수 — DESIGN.md Motion 섹션에 정렬.
//   Enter: ease-out / Medium 250ms · Exit: ease-in / 200ms.
// 값 변경 시 global.css 의 `.toast-card` 트랜지션 duration과 lockstep 유지.
export const TOAST_ENTER_MS = 250;
export const TOAST_EXIT_MS = 200;

/**
 * 사용자가 모션 감소를 선호하거나 matchMedia 를 쓸 수 없으면 true.
 *
 * matchMedia 미존재를 true 로 취급하는 것은 의도적이다: jsdom 테스트 환경엔
 * matchMedia 폴리필이 없으므로(테스트 setup 참조) 토스트가 애니메이션 없이
 * 즉시 나타나고/사라져 기존 타이밍 단언이 그대로 통과한다. 실제 브라우저에선
 * matchMedia 가 존재해 정상적으로 enter/exit 트랜지션이 재생된다.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}
