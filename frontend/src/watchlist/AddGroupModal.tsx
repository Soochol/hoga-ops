import { useState } from 'react';
import { ModalShell } from '../ui/ModalShell';
import { useCreateFolder } from './useWatchlist';

/**
 * "새 그룹 만들기" 소형 다이얼로그 — 이름 하나 입력받아 폴더를 만들고 닫는다.
 * 생성 성공 시 WATCHLIST_KEY invalidate → 패널에 빈 그룹이 바로 나타난다
 * (groupByFolder는 빈 폴더도 렌더; 빈 미분류만 숨김). UI 카피는 전부 "그룹"으로
 * 통일 — 도메인/API 계층(folder_id, createFolder 등)만 "folder"를 유지한다.
 */
export function AddGroupModal({ onClose }: { onClose: () => void }) {
  const createM = useCreateFolder();
  const [name, setName] = useState('');

  // WatchlistEditModal.submitFolder와 같은 패턴 (실패 시 mutation의 onError가 처리).
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createM.isPending) return;
    await createM.mutateAsync(trimmed);
    onClose();
  };

  return (
    <ModalShell ariaLabel="그룹 추가하기" title="그룹 추가하기" width="w-[320px]" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="px-4 py-4">
          <input autoFocus value={name} maxLength={40} placeholder="그룹 이름 입력"
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-input text-sm border border-border placeholder:text-fg-dimmer" />
        </div>
        {/* footer — 다른 모달과 같은 border-t + 우측 버튼; 추가는 primary CTA(teal) */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm bg-bg-input hover:bg-bg-input-hover text-fg rounded">
            닫기
          </button>
          <button type="submit" disabled={!name.trim() || createM.isPending}
            className="px-3 py-1.5 text-sm bg-accent text-accent-fg rounded hover:brightness-110 disabled:opacity-40">
            추가
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
