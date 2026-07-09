import { useEffect, useRef, useState } from 'react';
import { TOAST_EXIT_MS, prefersReducedMotion } from './motion';

export type ToastPhase = 'entering' | 'entered' | 'exiting';

/**
 * 마운트/언마운트 사이에 enter/exit 트랜지션을 끼워 넣는 presence 훅.
 *
 * `visible` 이 false 로 바뀌어도 즉시 언마운트하지 않고 `exiting` 페이즈로
 * {@link TOAST_EXIT_MS} 동안 유지한 뒤 `rendered=false` 로 내리고 `onExited` 를
 * 호출한다 — 호출 측(리스트 소유자)은 이때 실제로 항목을 제거하면 된다.
 *
 * 모션 감소 환경(및 jsdom 테스트)에선 지연 없이 즉시 전환한다.
 *
 * @returns rendered — DOM 에 남겨야 하는가 · phase — data-phase 로 노출할 현재 단계
 */
export function useToastPresence(visible: boolean, onExited?: () => void) {
  const [rendered, setRendered] = useState(visible);
  const [phase, setPhase] = useState<ToastPhase>(visible ? 'entering' : 'exiting');
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;

  useEffect(() => {
    if (visible) {
      setRendered(true);
      if (prefersReducedMotion()) {
        setPhase('entered');
        return;
      }
      // 초기 프레임은 'entering'(off-screen)로 그린 뒤 다음 프레임에 'entered'로
      // 플립해 트랜지션을 유발한다.
      setPhase('entering');
      const raf = requestAnimationFrame(() => setPhase('entered'));
      return () => cancelAnimationFrame(raf);
    }

    // 아직 보인 적 없으면(초기 visible=false) 스퓨리어스 onExited 를 막는다.
    if (!renderedRef.current) return;

    if (prefersReducedMotion()) {
      setRendered(false);
      onExitedRef.current?.();
      return;
    }
    setPhase('exiting');
    const timer = window.setTimeout(() => {
      setRendered(false);
      onExitedRef.current?.();
    }, TOAST_EXIT_MS);
    return () => window.clearTimeout(timer);
    // rendered 는 ref 로 읽어 재실행을 피한다 — visible 변화에만 반응한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return { rendered, phase };
}
