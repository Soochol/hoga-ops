import type { ReactNode } from 'react';

/**
 * 모든 토스트가 쌓이는 단일 고정 컨테이너.
 *
 * 위치(화면 하단 중앙, 아래→위로 떠오름)·z-index·스택 간격·`aria-live` 를 한
 * 곳에서 소유한다. 이전엔 시그널/KIS 토스트가 각자 같은 위치 문자열과 서로 다른
 * z-index(90/91)를 하드코딩해 같은 좌표에서 겹쳤다 — 이제 세로로 쌓인다
 * (flex-col-reverse: 새 토스트가 맨 아래에서 떠오르고 이전 것들은 위로 밀린다).
 * 컨테이너는 클릭을 통과시키고(pointer-events-none), 각 카드가 스스로
 * pointer-events-auto 를 켠다. 카드 enter/exit 의 세로 슬라이드는 global.css
 * `.toast-card[data-phase]` 참조.
 */
export function ToastViewport({ children }: { children: ReactNode }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-[16px] left-1/2 z-[90] flex w-[20rem] -translate-x-1/2 flex-col-reverse gap-2"
    >
      {children}
    </div>
  );
}
