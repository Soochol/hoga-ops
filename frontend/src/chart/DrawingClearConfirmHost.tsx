import { ConfirmModal } from '../ui/ConfirmModal';
import { useDrawingsStore } from '../state/drawings';

/**
 * 확인 팝업 for "모두 지우기" (clearAll). 스토어의 반응형 `clearConfirm` 슬롯을
 * 구독해, 값이 있으면 파괴적 톤의 ConfirmModal 을 띄운다.
 *
 * 호스트로 뽑은 이유는 **진입점이 둘**이기 때문이다 — 그리기 메뉴의 '모두 지우기'
 * 항목과 Alt+C 단축키(`DrawingOverlay` 의 window keydown). 팝업 상태를 메뉴
 * 컴포넌트의 useState 로 두면 메뉴가 닫힌 채 눌린 단축키는 게이트를 통째로
 * 우회한다. 스토어가 트리거를, 호스트가 표현을 갖는 모델은 `DrawingClearToastHost`
 * 와 동형이다(ADR-0107).
 *
 * 확인 뒤에도 실행취소 토스트·Ctrl+Z 는 그대로 남는다 — 확인은 오작동을,
 * 토스트는 오확인을 막는 서로 다른 그물이다.
 */
export default function DrawingClearConfirmHost() {
  const clearConfirm = useDrawingsStore((s) => s.clearConfirm);
  const clearAll = useDrawingsStore((s) => s.clearAll);
  const cancelClearAll = useDrawingsStore((s) => s.cancelClearAll);

  if (clearConfirm == null) return null;

  return (
    <ConfirmModal
      message={
        <>
          이 차트에 그린 그림 <b className="font-data">{clearConfirm.count}</b>개가 모두
          삭제됩니다. 계속할까요?
        </>
      }
      confirmLabel="모두 지우기"
      tone="destructive"
      onConfirm={() => clearAll(clearConfirm.scope)}
      onClose={cancelClearAll}
    />
  );
}
