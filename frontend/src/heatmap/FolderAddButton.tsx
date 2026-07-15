import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddToFolder } from './useAddToFolder';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

// w-64 = 16rem = 288px @ 18px root. 우측 정렬용 초기 추정폭 — 클램프가 실측으로 보정한다.
const POP_W = 320;

/** 폴더 헤더의 ＋종목: SymbolSearch 팝오버 → useAddToFolder(code, folderId).
 *  성공 시 닫고 선택 초기화. 무거운 편집(삭제·이동·재정렬)은 관심종목 드로어.
 *  팝오버는 createPortal 로 body 에 fixed 로 띄운다 — 폴더 카드의 overflow-hidden(둥근
 *  모서리·multicol 패킹용)과 CSS multicolumn 단편화가 absolute 팝오버를 잘라먹던 버그를
 *  카드 경계 밖으로 탈출시켜 해소(특히 1~2종목짜리 짧은 폴더에서 아래·왼쪽이 잘렸다).
 *  위치는 useClampedFixedPosition(WatchlistRowMenu 와 공용)으로 뷰포트 안에 보정. */
export function FolderAddButton({ folderId }: { folderId: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const { addToFolder, isPending } = useAddToFolder();
  const btnRef = useRef<HTMLButtonElement>(null);

  // 버튼 rect → 팝오버 raw 앵커(버튼 우하단). 열릴 때 측정; 클램프가 오버플로를 보정.
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.right - POP_W, top: r.bottom + 4 });
  }, [open]);
  const { ref: popRef, left, top } = useClampedFixedPosition<HTMLDivElement>(anchor.left, anchor.top);

  const close = useCallback(() => { setOpen(false); setPicked(null); }, []);

  // 접근성: 열릴 때 검색 입력으로 포커스 이동(GroupNameModal·WatchlistEditModal 의
  // autoFocus 관례). 포털이라 Tab 순서가 시각 순서와 끊기므로 명시적 포커스가 필요하다.
  // ref 는 layout effect 전에 부착되므로 popRef.current(다이얼로그)는 이 시점에 존재.
  useLayoutEffect(() => {
    if (open) popRef.current?.querySelector('input')?.focus();
  }, [open, popRef]);

  // 닫기: 버튼·팝오버 밖 mousedown 또는 Escape. 포털이라 팝오버가 버튼 DOM 서브트리
  // 밖이므로 useDismissablePopover 의 단일 anchor 로는 버튼 클릭이 "바깥"으로 잡혀
  // 닫힘→재열림 토글 레이스가 난다 — 버튼·팝오버 두 ref 를 함께 보는 인라인 effect 로 회피.
  // Escape 는 닫고 포커스를 트리거로 되돌린다(키보드 사용자가 보드로 복귀; 다이얼로그 관례).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btnRef.current?.focus(); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, popRef]);

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
      <button ref={btnRef} aria-label="종목 추가" className="text-xs text-fg-dim hover:text-accent"
        onClick={() => setOpen((v) => !v)}>＋종목</button>
      {open && createPortal(
        <div ref={popRef} role="dialog" aria-label="종목 추가"
          style={{ position: 'fixed', left, top, width: POP_W }}
          className="z-30 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2 shadow-lg">
          <SymbolSearch value={picked} onChange={setPicked} />
          <div className="flex justify-end gap-2">
            <button className="text-xs px-2 py-1 text-fg-dim" onClick={close}>닫기</button>
            <button className="text-xs px-2 py-1 rounded bg-accent text-accent-fg disabled:opacity-40"
              disabled={!picked || isPending} onClick={submit}>추가</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
