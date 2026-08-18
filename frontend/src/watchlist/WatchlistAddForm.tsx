import { useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddMember, useWatchlist } from './useWatchlist';
import { Banner } from './Banner';

/** Shared add-form (v3): SymbolSearch + submit → 선택된 폴더의 멤버로 추가(ADR-0070).
 *  onAdded fires after a successful add (caller drives feedback/highlight). */
export function WatchlistAddForm({ folderId, resolveAt, onAdded }: {
  folderId: string;
  /** 삽입할 items 인덱스를 **submit 시점에 다시 계산**한다(v5, 행 우클릭 삽입 경로).
   *
   *  숫자가 아니라 함수를 받는 이유: 팝오버가 열려 있는 동안 60초 폴링 리페치가
   *  `order` 를 바꿀 수 있어, 메뉴를 연 시점에 얼린 인덱스는 엉뚱한 자리를 가리킨다.
   *  앵커 행이 그 사이 사라졌으면 `undefined` 를 반환해 맨 아래로 떨어뜨린다.
   *  미전달이면 기존 계약 그대로 맨 아래(그룹 ⋯ 메뉴·히트맵 팝오버). */
  resolveAt?: () => number | undefined;
  onAdded: (hit: { code: string; name: string }) => void;
}) {
  const addM = useAddMember();
  const { data } = useWatchlist();
  const [picked, setPicked] = useState<SymbolHit | null>(null);

  // 이미 이 폴더의 멤버면 **아예 보내지 않는다**. 백엔드 add 는 멱등 no-op 이라
  // 보내 봐야 아무 일도 안 일어나고, 사용자에겐 "지정한 자리에 안 생겼다" 로만 보인다
  // (at 도 무시된다). 캐시에 이미 있는 데이터라 추가 요청은 없다.
  const duplicate = picked !== null
    && (data?.entries ?? []).some((e) => e.folder_id === folderId && e.code === picked.code);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked || duplicate) return;
    try {
      await addM.mutateAsync({
        folderId, code: picked.code, name: picked.name, at: resolveAt?.(),
      });
      onAdded({ code: picked.code, name: picked.name });
      setPicked(null);
    } catch {
      /* surfaces via addM.error */
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* **입력과 버튼을 한 줄에 두지 않는다.** 이 폼이 사는 팝오버는 280px 인데,
          한 줄이면 버튼(≈81px)과 gap 을 뺀 173px 만 검색 입력에 남는다. 검색
          드롭다운은 그 입력 래퍼에 `left-0 right-0` 으로 붙으므로 함께 173px 이 되고,
          옵션 행(`grid-cols-[1fr_auto_auto_auto]`)에서 코드·시장·완결 세 컬럼이
          ≈125px 를 먹은 뒤 종목명 `1fr` 컬럼이 **min-content 까지 붕괴한다**.
          한글은 글자 단위로 줄바꿈되므로 그 min-content 가 **한 글자(11px)** 다 —
          "삼/성/화/재" 가 세로로 쌓이고 행 높이가 35px → 91px 로 부푼다.
          2줄로 두면 드롭다운이 262px 이 되어 종목명 컬럼 92px, 행 높이 35px 로 돌아온다
          (팝오버 폭은 그대로여도 된다 — 실측). 세로쓰기 자체는 SymbolRow 의
          `truncate` 가 폭과 무관하게 다시 한 번 막는다. */}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <SymbolSearch value={picked} onChange={setPicked} />
        {/* 우측 정렬 — GroupNameModal·ConfirmModal 의 폼 액션 관용구와 같다. */}
        <div className="flex justify-end">
          <button type="submit" disabled={addM.isPending || picked === null || duplicate}
                  className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40">
            ＋ 종목 추가
          </button>
        </div>
      </form>
      {duplicate && <Banner kind="error">{picked.name}은(는) 이미 이 그룹에 있습니다</Banner>}
      {addM.error && <Banner kind="error">{(addM.error as Error).message}</Banner>}
    </div>
  );
}
