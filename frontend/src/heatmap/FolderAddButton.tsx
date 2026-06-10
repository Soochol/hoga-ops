import { useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddToFolder } from './useAddToFolder';

/** 폴더 헤더의 ＋종목: SymbolSearch 팝오버 → useAddToFolder(code, folderId).
 *  성공 시 닫고 선택 초기화. 무거운 편집(삭제·이동·재정렬)은 관심종목 드로어. */
export function FolderAddButton({ folderId }: { folderId: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const { addToFolder, isPending } = useAddToFolder();

  const close = () => { setOpen(false); setPicked(null); };
  const submit = async () => {
    if (!picked) return;
    // fire-and-forget 핸들러라 실패를 삼켜 unhandled rejection 을 막고, 팝오버를 열어
    // 둬 재시도/다른 종목 선택을 가능케 한다(GroupNameModal.submit·EntryPane.doMove 패턴).
    // add 의 비-409 에러(404 unknown_code/네트워크)나 move 실패가 여기로 온다.
    try {
      await addToFolder(picked.code, folderId);
    } catch {
      return;
    }
    close();
  };

  return (
    <div className="relative">
      <button aria-label="종목 추가" className="text-xs text-fg-dimmer hover:text-accent"
        onClick={() => setOpen((v) => !v)}>＋종목</button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2">
          <SymbolSearch value={picked} onChange={setPicked} />
          <div className="flex justify-end gap-2">
            <button className="text-xs px-2 py-1 text-fg-dim" onClick={close}>닫기</button>
            <button className="text-xs px-2 py-1 rounded bg-accent text-accent-fg disabled:opacity-40"
              disabled={!picked || isPending} onClick={submit}>추가</button>
          </div>
        </div>
      )}
    </div>
  );
}
