import { ConfirmModal } from '../ui/ConfirmModal';

/** 폴더 삭제 확인(ADR-0070 P6). 서버 `delete_folder` docstring 이 "UI 는 고아가 생기는
 *  삭제 전 사용자에게 확인한다" 를 계약으로 적어 두었고, 그 계약의 클라이언트 절반이다.
 *
 *  **패널(그룹 ⋯ 메뉴)과 편집 모달(휴지통)이 같은 컴포넌트를 쓴다.** 파괴적 동작 하나가
 *  두 화면에서 서로 다른 안전 계약을 갖던 것이 이 파일이 생긴 이유다 — 편집 모달은 확인
 *  없이 곧바로 삭제했고, 그래서 종목 N개가 든 그룹이 클릭 한 번에 사라졌다. 문구와 고아
 *  수 계산([[countOrphansIfFolderDeleted]])을 함께 공유해야 다음에 또 갈리지 않는다.
 *
 *  `orphanCount` 는 **호출자가 확인을 띄우는 시점에 얼린 값**이다(60초 폴링이 모달이 떠
 *  있는 동안 entries 를 갱신하면 다시 센 값은 사용자가 읽은 숫자와 어긋난다). */
export function FolderDeleteConfirm({ orphanCount, onConfirm, onClose }: {
  orphanCount: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      message={<>
        이 폴더에만 있는 <b className="font-data">{orphanCount}</b>종목이
        관심종목에서 빠집니다(데이터 수집 중단)
      </>}
      confirmLabel="삭제"
      tone="destructive"
      onConfirm={onConfirm}
      onClose={onClose} />
  );
}
