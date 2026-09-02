import { useEffect, useState } from 'react';
import { SymbolSearch } from '../capture/SymbolSearch';
import type { SymbolHit } from '../api/types';
import { useAddMember, useWatchlist } from './useWatchlist';
import { Banner } from '../ui/Banner';
import { useOptimisticDuplicateGate } from '../util/useOptimisticDuplicateGate';

/** Shared add-form (v3): SymbolSearch + submit → 선택된 폴더의 멤버로 추가(ADR-0070).
 *  onAdded fires after a successful add (caller drives feedback/highlight). */
export function WatchlistAddForm({
  folderId, resolveAt, onAdded, onDuplicate, onMoveHere, layout = 'stacked',
}: {
  folderId: string;
  /** 입력과 버튼의 배치. **호출부가 자기 폭을 알기 때문에 호출부가 정한다.**
   *
   *  `'stacked'`(기본) — 2줄. 좁은 컨테이너의 안전값이다(아래 붕괴 주석 참조).
   *  `'inline'` — 1줄. 검색 입력이 넉넉한 곳(편집 모달 우측 pane)에서만 쓴다.
   *
   *  **컨테이너 쿼리는 쓰지 않는다** — 이 리포에 함정이 둘 있고(인라인 스타일·content-sized
   *  컨테이너), 호출부가 자기 폭을 아는 상황에서는 prop 이 더 정직하다. */
  layout?: 'stacked' | 'inline';
  /** 삽입할 items 인덱스를 **submit 시점에 다시 계산**한다(v5, 행 우클릭 삽입 경로).
   *
   *  숫자가 아니라 함수를 받는 이유: 팝오버가 열려 있는 동안 60초 폴링 리페치가
   *  `order` 를 바꿀 수 있어, 메뉴를 연 시점에 얼린 인덱스는 엉뚱한 자리를 가리킨다.
   *  앵커 행이 그 사이 사라졌으면 `undefined` 를 반환해 맨 아래로 떨어뜨린다.
   *  미전달이면 기존 계약 그대로 맨 아래(그룹 ⋯ 메뉴·히트맵 팝오버). */
  resolveAt?: () => number | undefined;
  onAdded: (hit: { code: string; name: string }) => void;
  /** 이미 이 폴더에 있는 종목을 고른 순간 발화한다 — 호출부가 그 행을 보여 준다.
   *
   *  "이미 있습니다" 만으로는 사용자가 확인할 방법이 없다. 40행짜리 그룹에서 그 종목이
   *  맨 아래에 있으면 화면 밖이라 **"없는데 있다고 한다"** 로 읽힌다(실측: 사용자의
   *  삼성화재가 40/40번째였다).
   *
   *  optional 이라 리스트가 없는 소비처(패널 그룹 ⋯ 팝오버)는 안 넘기면 그만이다. */
  onDuplicate?: (code: string) => void;
  /** 중복일 때의 **대안 행동** — 「그 행을 여기로 이동」.
   *
   *  이미 있는 종목을 이 팝오버에 넣으려는 사용자의 실제 의도는 대개 "그걸 이 자리로
   *  옮기고 싶다" 다. 추가는 멱등 no-op 이라(api/watchlist.ts 의 `addMember` 주석)
   *  아무리 눌러도 자리가 바뀌지 않으므로, 같은 결과를 재정렬로 만들어 준다.
   *
   *  **「여기」가 있는 호출부만 넘긴다.** 자리를 지정해 연 팝오버(행·빈칸 우클릭)에만
   *  앵커가 있고, 그룹 ⋯ 메뉴와 편집 모달 pane 은 맨 아래에 붙이는 경로라 "여기" 가
   *  가리킬 곳이 없다 — 거기선 안내만 하고 끝난다. */
  onMoveHere?: (code: string) => void;
}) {
  const addM = useAddMember();
  const { data } = useWatchlist();
  const [picked, setPicked] = useState<SymbolHit | null>(null);

  // **폴더가 바뀌면 고른 종목을 버린다.** 이 폼은 폴더를 옮겨도 언마운트되지 않아서
  // (`folderId` prop 만 갈린다) 이전 그룹에서 고른 종목이 입력에 그대로 남아 있었다.
  //
  // 그게 실사용에서 이런 모양으로 나타났다: 「A」에서 이미 있는 종목을 골라 "이미 이
  // 그룹에 있습니다" 를 본 뒤 「B」로 옮기면, 같은 종목이 그대로 남고 B 에는 없으니
  // **추가 버튼이 다시 활성화**된다 — 무심코 누르면 **의도하지 않은 그룹에 들어간다**.
  // 사용자가 "중복이라더니 추가됐다" 로 본 것이 이것이다(배너 두 개가 순서대로 뜬다).
  //
  // 편집 pane 이 폴더 전환에 다중 선택(`checked`)을 버리는 것과 같은 계열이다 —
  // 폴더별 뷰의 임시 상태는 폴더를 넘어가지 않는다. `SymbolSearch` 는 `value === null`
  // 이면 입력 텍스트도 비우므로 화면도 함께 초기화된다.
  useEffect(() => { setPicked(null); }, [folderId]);

  // 이미 이 폴더의 멤버면 **아예 보내지 않는다**. 백엔드 add 는 멱등 no-op 이라
  // 보내 봐야 아무 일도 안 일어나고, 사용자에겐 "지정한 자리에 안 생겼다" 로만 보인다
  // (at 도 무시된다). 캐시에 이미 있는 데이터라 추가 요청은 없다.
  const isDuplicate = (hit: SymbolHit | null) =>
    hit !== null && (data?.entries ?? []).some((e) => e.folder_id === folderId && e.code === hit.code);
  // 제출 중 판정 얼리기 + 이중 제출 차단은 **공용 훅**이 소유한다(히트맵의 두 추가
  // 팝오버와 같은 규율 — 훅 docstring 에 이유가 있다). 여기 사정으로 규칙을 다시
  // 적으면 세 곳이 조용히 갈린다.
  const { duplicate, submitting, run } =
    useOptimisticDuplicateGate(picked, (hit) => isDuplicate(hit));

  // **선택 시점에 한 번** 알린다 — derived 값을 effect 로 감시하면 폴링 리페치가 돌 때마다
  // 재발화해 하이라이트 타이머가 계속 되살아난다. 사용자의 행동(고름)이 곧 발화점이다.
  const handlePick = (hit: SymbolHit | null) => {
    setPicked(hit);
    if (hit && isDuplicate(hit)) onDuplicate?.(hit.code);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked || duplicate) return;
    // ⚠ **`setPicked(null)` 은 이 콜백 안에 있어야 한다.** `await run(...)` 뒤로 빼면
    // 훅이 `submitting` 을 먼저 내리고 초기화가 그 뒤에 돌아, 그 틈의 렌더에서 중복
    // 배너가 한 프레임 번쩍인다(훅 docstring 의 (2)).
    await run(async () => {
      await addM.mutateAsync({
        folderId, code: picked.code, name: picked.name, at: resolveAt?.(),
      });
      onAdded({ code: picked.code, name: picked.name });
      setPicked(null);
    });
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
      {/* `inline` 은 위 붕괴가 **일어날 수 없는 폭**에서만 쓴다 — 편집 모달 우측 pane 은
          638px 이라 버튼을 빼고도 검색 입력이 480px 이상 남는다(팝오버 173px 과 비교).
          거기서 2줄은 순수한 세로 낭비다(실측 91px vs 53px, 리스트 가시 영역의 10%).
          `min-w-0` 은 필수 — flex item 의 기본 `min-width:auto` 아래서는 SymbolSearch
          래퍼가 내용보다 좁아지지 않아 버튼을 밀어낸다(입력 자체는 이미 같은 이유로
          `min-w-0` 을 갖고 있다). */}
      <form onSubmit={submit}
        className={layout === 'inline' ? 'flex items-start gap-2' : 'flex flex-col gap-2'}>
        <div className={layout === 'inline' ? 'flex-1 min-w-0' : undefined}>
          <SymbolSearch value={picked} onChange={handlePick} />
        </div>
        {/* 우측 정렬 — GroupNameModal·ConfirmModal 의 폼 액션 관용구와 같다. */}
        <div className={layout === 'inline' ? 'shrink-0' : 'flex justify-end'}>
          {/* 제출 게이트의 진실은 훅의 `submitting` 하나다 — `addM.isPending` 은 이 폼보다
              한 틱 먼저 내려가므로 여기서 섞으면 게이트가 조용히 갈린다. */}
          <button type="submit" disabled={submitting || picked === null || duplicate}
                  className="px-3 py-1.5 rounded bg-accent text-bg text-sm font-medium disabled:opacity-40">
            ＋ 종목 추가
          </button>
        </div>
      </form>
      {/* 「아래에 표시했습니다」는 **호출부가 그 표시를 실제로 하는 경우에만** 붙인다.
          그전까진 무조건 붙어 있었고, `onDuplicate` 를 안 넘기는 소비처(드로어의 두 추가
          팝오버)에서는 아래에 아무것도 표시되지 않았다 — 문구가 없는 것을 가리켰다.
          지금은 두 팝오버도 배선돼 있지만(WatchlistDrawer) prop 은 여전히 optional 이라,
          약속을 지킬 수 있는 호출부에서만 약속한다. */}
      {picked && duplicate && (
        <Banner kind="error">
          {picked.name}은(는) 이미 이 그룹에 있습니다{onDuplicate && ' — 아래에 표시했습니다'}
          {/* 안내 아래 **한 줄을 더 쓰는** 이유: 280px 팝오버에서 문장이 두 줄로 접히므로
              옆에 두면 버튼이 눌리듯 좁아진다. 우측 정렬은 이 폼의 추가 버튼과 같은 관용구.
              색은 배너에서 상속(`border-current`)해 별도 톤을 만들지 않는다 — 이건 이
              안내의 후속 행동이지 독립한 액션이 아니다. */}
          {onMoveHere && (
            <div className="mt-1.5 flex justify-end">
              <button type="button" onClick={() => onMoveHere(picked.code)}
                className="px-2 py-0.5 rounded border border-current text-xs font-medium hover:bg-tint-error">
                그 행을 여기로 이동
              </button>
            </div>
          )}
        </Banner>
      )}
      {addM.error && <Banner kind="error">{(addM.error as Error).message}</Banner>}
    </div>
  );
}
