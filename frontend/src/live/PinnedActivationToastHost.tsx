import { useEffect, useRef, useState } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { useWorkspaceStore } from '../state/workspace';

const AUTO_DISMISS_MS = 6000;

/**
 * "전 창이 고정돼 종목을 바꿀 곳이 없다" 를 알리는 토스트.
 *
 * 창 고정(핀)은 클릭 목적지에서 그 창을 뺀다(`activationTarget`). 창이 **전부** 핀이면
 * 남는 목적지가 없어 관심종목·히트맵·스크리너 클릭이 아무 일도 하지 않는데, 그 상태는
 * 화면상 정상과 구별되지 않는다 — 사용자는 클릭이 씹혔다고 읽는다. 조용한 실패를
 * 만들지 않기 위해 이 호스트가 이유와 **복구 수단**(전체 고정 해제)을 같이 낸다.
 *
 * 도달 경로가 하나가 아니라서 "마지막 창은 고정 못 하게 막기" 로는 못 닫는다 —
 * 핀 걸린 창들만 남기고 나머지를 닫아도 같은 상태가 된다. 그래서 진입을 막는 대신
 * 상태를 설명하는 쪽을 택했다.
 *
 * 토스트는 호스트 소유 모델(`DrawingClearToastHost` 와 동형): 스토어가 트리거 데이터를
 * 소유하고, 이 호스트가 표현 + 자동 해제 타이머를, ToastViewport 가 스택/위치를 갖는다.
 */
export default function PinnedActivationToastHost() {
  const blocked = useWorkspaceStore((s) => s.blockedActivation);
  const dismiss = useWorkspaceStore((s) => s.dismissBlockedActivation);
  const unpinAll = useWorkspaceStore((s) => s.unpinAllWindows);

  // 스토어 슬롯이 null 로 비워진 뒤에도 exit 애니메이션 동안 문구가 남아야 하므로
  // 페이로드를 걸어 둔다(DrawingClearToastHost 와 같은 규율).
  const [shown, setShown] = useState<typeof blocked>(null);
  const paused = useRef(false);

  useEffect(() => {
    if (blocked == null) return undefined;
    setShown(blocked);
    const timer = setTimeout(() => {
      if (!paused.current) dismiss();
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [blocked, dismiss]);

  const visible = blocked != null;

  return (
    <ToastCard
      visible={visible}
      variant="warn"
      role="status"
      progress={visible ? { durationMs: AUTO_DISMISS_MS, paused: false } : null}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onExited={() => setShown(null)}
      action={{ label: '전체 고정 해제', onClick: () => unpinAll() }}
    >
      <div className="text-sm font-medium text-fg">모든 창이 고정돼 있습니다</div>
      {/* 종목명 뒤에 조사를 붙이지 않는다 — 받침 유무로 은/는·을/를 이 갈려 "을(를)" 같은
          폴백 표기가 나온다(도그푸딩에서 확인). 이름을 가운뎃점으로 떼면 조사가 필요 없다. */}
      <div className="text-xs text-fg-dim">
        {shown?.name ?? '선택한 종목'} · 종목을 받을 창이 없습니다. 고정을 풀거나 창에 직접
        끌어다 놓으세요.
      </div>
    </ToastCard>
  );
}
