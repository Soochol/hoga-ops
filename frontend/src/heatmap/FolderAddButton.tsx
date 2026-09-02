import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddToFolder } from './useAddToFolder';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useOptimisticDuplicateGate } from '../util/useOptimisticDuplicateGate';
import { Banner } from '../ui/Banner';

// w-64 = 16rem = 256px @ 16px root(2026-08-07 다이얼 1.0×; 그전 18px 에선 288px).
// 우측 정렬용 **초기 추정폭**이라 다이얼과 함께 안 움직여도 무해하다 —
// useClampedFixedPosition 이 마운트 후 실측으로 덮으므로 과대 추정은 첫 프레임의
// 정렬 오차로만 남는다. 그래서 rem 파생으로 바꾸지 않고 상수로 둔다.
const POP_W = 320;

/** 폴더 헤더의 ＋종목: SymbolSearch 팝오버 → useAddToFolder(code, folderId).
 *  성공 시 닫고 선택 초기화. 무거운 편집(삭제·이동·재정렬)은 관심종목 드로어.
 *  팝오버는 createPortal 로 body 에 fixed 로 띄운다 — 폴더 카드의 overflow-hidden(둥근
 *  모서리·multicol 패킹용)과 CSS multicolumn 단편화가 absolute 팝오버를 잘라먹던 버그를
 *  카드 경계 밖으로 탈출시켜 해소(특히 1~2종목짜리 짧은 폴더에서 아래·왼쪽이 잘렸다).
 *  위치는 useClampedFixedPosition(WatchlistRowMenu 와 공용)으로 뷰포트 안에 보정. */
export function FolderAddButton({ folderId, isDuplicate, onDuplicate, autoOpen, onAutoOpened }: {
  folderId: string;
  /** 이 그룹에 그 코드가 이미 있는가. **그룹 블록이 자기 `entries` 로 판정해 내려 준다** —
   *  이 버튼이 직접 `useHeatmap()` 을 부르면 카드마다 react-query 옵저버가 하나씩 늘고,
   *  판정에 쓸 데이터는 이미 부모가 렌더에 쓰고 있다(하트 버튼의 `isMember` 선례). */
  isDuplicate: (code: string) => boolean;
  /** 이미 있는 종목을 고른 순간 — 그룹 블록이 그 행을 가리킨다. "이미 있습니다" 만으로는
   *  사용자가 확인할 방법이 없다(관심종목에서 실측된 실패). */
  onDuplicate: (code: string) => void;
  /** 새 그룹 직후 페이지가 켠다 — 마운트 시점에만 읽는다(아래 useState 초기값). */
  autoOpen?: boolean;
  /** 자동 열기를 소비했음을 알린다. 페이지가 표식을 태워, 검색 필터로 이 카드가
   *  언마운트→재마운트될 때 팝오버가 되살아나는 것을 막는다. */
  onAutoOpened?: () => void;
}) {
  // autoOpen 은 **초기값으로만** 읽는다. effect 로 열면 리렌더가 한 번 더 돌고, 무엇보다
  // 아래 앵커 측정이 그 커밋에서야 일어나 스크롤/레이아웃과 순서가 엇갈린다.
  const [open, setOpen] = useState(!!autoOpen);
  const [picked, setPicked] = useState<SymbolHit | null>(null);
  const { addToFolder } = useAddToFolder();
  // 중복 판정을 **제출 중에는 얼린다** — `useAddToHeatmapFolder` 는 낙관적이라 요청을
  // 보내는 순간 캐시에 행이 들어가고, 파생 판정은 그걸 보고 **자기 자신을 고발한다**
  // (훅 docstring). 관심종목 추가 폼과 같은 규율을 같은 훅으로 쓴다.
  const { duplicate, submitting, run } =
    useOptimisticDuplicateGate(picked, (hit) => isDuplicate(hit.code));
  const btnRef = useRef<HTMLButtonElement>(null);

  // 버튼 rect → 팝오버 raw 앵커(버튼 우하단). 열릴 때 측정; 클램프가 오버플로를 보정.
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    // 측정 **전에** 스크롤한다. 갓 만든 그룹은 보드 밖에 있을 수 있는데, 스크롤을 페이지가
    // 맡으면 자식 effect(측정)가 부모보다 먼저 돌아 스크롤 전 좌표로 앵커가 굳는다 —
    // 팝오버가 카드에서 멀리 떨어져 뜬다(실측). 한 effect 안에 두면 순서가 코드로 남는다.
    // 자동 열기는 'center' — 새 그룹은 보드 끝에 붙어 'nearest' 로는 뷰포트 맨 아래에
    // 걸치고 팝오버가 그 위를 덮는다. 사용자가 직접 누른 경우엔 버튼이 이미 보이므로
    // 'nearest'(사실상 no-op)로 화면을 흔들지 않는다. jsdom 미구현 → ?.()
    btnRef.current?.scrollIntoView?.({ block: autoOpen ? 'center' : 'nearest' });
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ left: r.right - POP_W, top: r.bottom + 4 });
  }, [open, autoOpen]);
  const { ref: popRef, left, top } = useClampedFixedPosition<HTMLDivElement>(anchor.left, anchor.top);

  const close = useCallback(() => { setOpen(false); setPicked(null); }, []);

  // 자동 열기 1회 소비 통지 — 마운트 때 열렸으면 페이지의 표식을 태운다.
  useEffect(() => { if (autoOpen) onAutoOpened?.(); }, [autoOpen, onAutoOpened]);

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
    if (!picked || duplicate) return;
    // 실패하면 팝오버를 열어 둬 재시도/다른 종목 선택을 가능케 한다
    // (GroupNameModal.submit·EntryPane.doMove 패턴). 실패를 삼키는 것은 이제 `run` 이
    // 하므로 여기서 다시 try 하지 않는다 — 대신 **성공했을 때만** 닫아야 하니 닫기를
    // 콜백 **안** 에 둔다(`run` 은 실패해도 정상 반환한다).
    await run(async () => {
      await addToFolder(picked.code, folderId);
      close();
    });
  };

  return (
    <div className="relative">
      <button ref={btnRef} aria-label="종목 추가" className="text-xs text-fg-dim hover:text-accent"
        onClick={() => setOpen((v) => !v)}>＋종목</button>
      {open && createPortal(
        <div ref={popRef} role="dialog" aria-label="종목 추가"
          style={{ position: 'fixed', left, top, width: POP_W }}
          className="z-30 bg-bg-card border border-border-strong rounded p-2 flex flex-col gap-2 shadow-lg">
          {/* 고른 **그 순간** 알린다 — 파생값을 effect 로 감시하면 폴링 리페치마다
              재발화해 하이라이트 타이머가 계속 되살아난다(관심종목과 같은 계약). */}
          <SymbolSearch value={picked} onChange={(hit) => {
            setPicked(hit);
            if (hit && isDuplicate(hit.code)) onDuplicate(hit.code);
          }} />
          {picked && duplicate && (
            <Banner kind="error">{picked.name}은(는) 이미 이 그룹에 있습니다 — 아래에 표시했습니다</Banner>
          )}
          <div className="flex justify-end gap-2">
            <button className="text-xs px-2 py-1 text-fg-dim" onClick={close}>닫기</button>
            <button className="text-xs px-2 py-1 rounded bg-accent text-accent-fg disabled:opacity-40"
              disabled={!picked || submitting || duplicate} onClick={submit}>추가</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
