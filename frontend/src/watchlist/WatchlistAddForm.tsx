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
      <form onSubmit={submit} className="flex gap-2 items-center">
        {/* `min-w-0` 이 없으면 flex item 의 기본 `min-width:auto` 때문에 입력이
            콘텐츠 폭 아래로 줄지 않는다. 종목을 고르면 입력값이 "SK하이닉스 000660"
            처럼 길어져 280px 팝오버를 9px 넘고, **제출 버튼이 뷰포트 밖으로 밀린다**
            (실측: 버튼 right 1281 > 1280, 세로로 짜부라진 채). jsdom 은 레이아웃을
            계산하지 않아 단위 테스트로는 못 본다 — 도그푸딩이 잡았다. */}
        <div className="flex-1 min-w-0"><SymbolSearch value={picked} onChange={setPicked} /></div>
        <button type="submit" disabled={addM.isPending || picked === null || duplicate}
                className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40">
          ＋ 종목 추가
        </button>
      </form>
      {duplicate && <Banner kind="error">{picked.name}은(는) 이미 이 그룹에 있습니다</Banner>}
      {addM.error && <Banner kind="error">{(addM.error as Error).message}</Banner>}
    </div>
  );
}
