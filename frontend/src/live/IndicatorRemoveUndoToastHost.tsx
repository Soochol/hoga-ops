import { useEffect, useRef, useState } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { useLivePageStore } from '../state/livePage';

const AUTO_DISMISS_MS = 6000;

/**
 * 레전드 칩 ✕(지표 인스턴스 삭제)의 undo 토스트.
 *
 * 칩 ✕ 는 확인 없이 즉시 지운다 — 트레이딩 UI 에서 클릭 흐름을 확인 모달로 끊는
 * 대가가 크기 때문이다. 그 대신 복구를 여기서 준다. 인라인 2단계 확인은 "현재 봉
 * 초기화" 처럼 **대량** 파괴에만 쓴다.
 *
 * 모델은 `DrawingClearToastHost` 를 그대로 복제한다(ADR-0107 host-owned): 스토어가
 * 트리거 데이터를 갖고, 이 호스트가 표현 + 자동 소멸 타이머를, `ToastViewport` 가
 * 쌓임·위치를 갖는다. 복원은 undo 스택 pop 이 아니라 **스냅샷을 되돌리는 평범한
 * 변이**라, 토스트가 떠 있는 동안 종목·봉·창이 바뀌어도 정확하다(payload 가 삭제
 * 시점의 스코프·봉을 싣고 있다).
 */
export default function IndicatorRemoveUndoToastHost() {
  const undoToast = useLivePageStore((s) => s.indicatorUndoToast);
  const restore = useLivePageStore((s) => s.restoreIndicatorUndoToast);
  const dismiss = useLivePageStore((s) => s.dismissIndicatorUndoToast);

  // 스토어 슬롯이 null 로 비워진 뒤에도 퇴장 애니메이션 동안 문구·핸들러를 붙잡는다.
  const [shown, setShown] = useState<typeof undoToast>(null);
  const paused = useRef(false);

  useEffect(() => {
    if (undoToast == null) return;
    setShown(undoToast);
    const timer = setTimeout(() => {
      if (!paused.current) dismiss();
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [undoToast, dismiss]);

  const visible = undoToast != null;

  return (
    <ToastCard
      visible={visible}
      variant="neutral"
      role="status"
      progress={visible ? { durationMs: AUTO_DISMISS_MS, paused: false } : null}
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onExited={() => setShown(null)}
      action={{ label: '실행취소', onClick: restore }}
    >
      <div className="text-sm font-medium text-fg">{shown?.label ?? ''}</div>
    </ToastCard>
  );
}
