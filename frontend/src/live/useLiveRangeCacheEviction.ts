import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import { codeFromMergedLiveRangeKey } from '../api/range';
import { windowSymbolOf, type GroupSymbol, type WorkspaceWindow } from '../state/workspace';

/**
 * 열린 창이 가리키는 종목 집합을 **문자열**로 만든다.
 *
 * 문자열인 게 요점이다 — zustand 셀렉터가 매번 새 배열을 돌려주면 워크스페이스가
 * 조금만 바뀌어도 구독자가 재렌더된다. 정렬 후 join 하면 Object.is 비교가 값 비교로
 * 떨어져, 종목 구성이 그대로인 변경(창 이동·리사이즈·z순서)에는 아무 일도 안 생긴다.
 *
 * 종목의 SSOT 는 원칙적으로 창이 아니라 **그룹**이다(#711) — 창은 group 만 들고 code 는
 * groupSymbols 에 산다. 그래서 "창이 하나라도 있는 그룹"의 심볼만 모은다. 창이 전부
 * 닫힌 그룹의 종목은 보호 대상에서 빠져 다음 축출에 회수된다.
 *
 * **예외가 창 고정(핀)이다** — 핀 창은 자기 종목을 들고 그룹을 안 본다. 그래서 여기서
 * `groupSymbols[win.group]` 를 직독하면 안 되고 `windowSymbolOf` 를 거쳐야 한다.
 * 직독하면 증상이 **화면이 아니라 데이터**로 나온다: 핀 종목이 이 집합에서 빠져 그
 * 창의 캔들·시세 캐시가 다음 축출에 회수되고(구독 코드 집합도 같은 키를 쓴다), 창은
 * 종목명을 멀쩡히 띄운 채 조용히 빈다.
 */
export function liveOpenCodesKey(
  windows: readonly WorkspaceWindow[],
  groupSymbols: Partial<Record<number, GroupSymbol>>,
): string {
  const codes = new Set<string>();
  for (const win of windows) {
    const code = windowSymbolOf({ groupSymbols }, win)?.code;
    if (code) codes.add(code);
  }
  return [...codes].sort().join(',');
}

/** 축출 대상에서 종목코드를 뽑는다. 판별 불가면 null → 보존. */
function evictableCode(queryKey: QueryKey): string | null {
  if (!Array.isArray(queryKey) || queryKey[0] !== 'live') return null;

  if (queryKey[1] === 'range-merged') return codeFromMergedLiveRangeKey(queryKey);

  if (queryKey[1] === 'past-candles') {
    // 두 모양이 한 prefix 를 공유한다:
    //   실 청크  ['live','past-candles', code, from, to, venue]        → [2]
    //   병합본   ['live','past-candles','merged', code, to, venue]     → [3]
    // 무심코 [2] 만 읽으면 병합본에서 문자열 'merged' 를 코드로 오인한다. 'merged' 는
    // 어떤 종목과도 안 맞으므로 **모든 병합 캔들이 무조건 축출**되고, 웜 캔들 캐시가
    // 통째로 날아가 복귀마다 재-워크백이 돈다. 분기 필수.
    const code = queryKey[2] === 'merged' ? queryKey[3] : queryKey[2];
    return typeof code === 'string' ? code : null;
  }

  if (queryKey[1] === 'series') {
    const code = queryKey[2];
    return typeof code === 'string' ? code : null;
  }

  return null;
}

/**
 * 열린 창 어디에도 없는 종목의 `/live` 소유 캐시를 축출한다.
 *
 * /live 는 종목·타임프레임·지표 조합을 옮겨 다닐 때마다 큰 번들을 새로 발행하는데
 * 지우는 쪽이 없었다. `useStudyRangeCacheEviction` 이 있지만 /study 에서만 돌고,
 * 게다가 canonical 병합본은 그 훅의 `['range']` prefix 를 **의도적으로 피하도록**
 * 설계돼 있어(range.ts 의 mergedLiveRangeKey 주석) /live 만 계속 쓰면 축출이 0회다.
 * 결과가 힙 누적 → major GC 정지 증가 → 크로스헤어가 마우스를 늦게 따라오는 증상이고,
 * 새로고침하면 낫는다(2026-07-29 진단). /study 가 같은 이유로 PR #689 에서 고쳤다.
 *
 * `/live` 가 **단독 소유하는 네임스페이스만** 건드린다(`['live', …]`). 청크 키
 * `['range', …]` 는 /study 와 공유하므로 여기서 손대면 서로의 웜 캐시를 깎는다 —
 * 그쪽 증식(좌측 팬 스텝 사본)은 range.ts 의 removeDominatedLiveRangeCopies 가
 * identity 범위에서 따로 회수한다.
 *
 * `type: 'inactive'` 가드 필수: 옵저버가 남은 쿼리를 지우면 RQ 가 즉시 재생성·재요청해
 * 요청 폭주가 된다. 옵저버를 단 채 열린 창에서 빠진 종목은 다음 축출에서 자연히
 * 회수된다(자가 치유).
 */
export function useLiveRangeCacheEviction(openCodesKey: string): void {
  const queryClient = useQueryClient();
  const keep = useMemo(
    () => new Set(openCodesKey.split(',').filter(Boolean)),
    [openCodesKey],
  );

  useEffect(() => {
    // 창이 하나도 없으면 축출하지 않는다. 워크스페이스는 영속 스토어라 라우트 진입
    // 직후 한 프레임 동안 windows 가 비어 보일 수 있는데, 그 순간 축출하면 복원되려던
    // 웜 캐시를 스스로 지운다. 창이 0개면 누적도 안 일어나므로 잃는 것도 없다.
    if (keep.size === 0) return;
    queryClient.removeQueries({
      queryKey: ['live'],
      type: 'inactive',
      predicate: (query) => {
        const code = evictableCode(query.queryKey);
        return code !== null && !keep.has(code);
      },
    });
  }, [keep, queryClient]);
}
