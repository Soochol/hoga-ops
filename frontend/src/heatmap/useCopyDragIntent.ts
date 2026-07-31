import { useCallback, useEffect, useRef, useState } from 'react';

/** 이벤트가 "복제" 수정자(Ctrl)를 들고 있는가. dnd-kit 의 activatorEvent 는 `Event` 로
 *  타이핑돼 있어(PointerEvent 보장 없음) 구조적으로 좁힌다. */
function hasCopyModifier(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { ctrlKey?: boolean }).ctrlKey === true;
}

export interface CopyDragIntent {
  /** 렌더용(드롭존 하이라이트 색) — 상태라 키를 누르/떼는 즉시 화면이 따라온다. */
  copyIntent: boolean;
  /** 커밋 시점용. onDragEnd 는 이벤트 핸들러 안에서 최신 값을 동기적으로 읽어야 하므로
   *  상태가 아니라 ref 를 본다(마지막 keyup 이 리렌더 전이어도 정확). */
  isCopy: () => boolean;
  /** onDragStart 에서 activatorEvent 로 초기값을 심는다 — "Ctrl 을 먼저 누르고 끌기"가
   *  가장 흔한 조작인데, 그 keydown 은 드래그 시작 **전에** 일어나 아래 리스너가 못 본다. */
  seed: (activatorEvent: unknown) => void;
}

/**
 * Ctrl 을 누른 채로 그룹 간 행 드래그 = 이동이 아니라 **복제**(원본 그룹 등록 유지).
 * 히트맵 보드와 우측 레일 드로어가 같은 규칙을 쓰도록 한 곳에 둔다.
 *
 * `dragging` 동안에만 window 키 리스너를 건다 — 드래그 도중에 Ctrl 을 누르거나 떼는 것도
 * 반영돼야 드롭존 색(복제=success, 이동=accent)이 실제 커밋될 동작과 일치한다. 평소에도
 * 전역 키 리스너를 켜 두면 앱 전체 키 입력마다 이 훅이 리렌더를 유발한다.
 */
export function useCopyDragIntent(dragging: boolean): CopyDragIntent {
  const [copyIntent, setCopyIntent] = useState(false);
  const ref = useRef(false);
  const apply = useCallback((v: boolean) => {
    ref.current = v;
    setCopyIntent((prev) => (prev === v ? prev : v));
  }, []);
  const seed = useCallback((activatorEvent: unknown) => {
    apply(hasCopyModifier(activatorEvent));
  }, [apply]);
  useEffect(() => {
    if (!dragging) {
      apply(false);   // 드래그가 끝나면 다음 드래그가 seed 로 다시 시작한다.
      return;
    }
    // keydown/keyup 모두 같은 핸들러 — 이벤트 종류가 아니라 `ctrlKey` 현재 상태를 읽는다.
    const onKey = (e: KeyboardEvent) => apply(e.ctrlKey);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [dragging, apply]);
  return { copyIntent, isCopy: useCallback(() => ref.current, []), seed };
}
