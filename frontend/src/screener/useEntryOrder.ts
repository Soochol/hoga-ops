import { useEffect, useRef, useState } from 'react';

/**
 * 각 종목이 결과 집합에 **처음 편입된 순번(rank)**을 code→rank 로 돌려준다. rank 는
 * 단조 증가하며 나중에 편입될수록 큰 값을 받는다 — stackByEntryOrder 가 이를 내림차순
 * 정렬하면 신규 편입이 리스트 상단에 쌓이고(상단 스택), 기존 종목의 상대 위치는 고정된다
 * (서버가 매 조회 순서를 바꿔 내려도 요동치지 않는다).
 *
 * 한 tick 에 여러 종목이 동시에 편입되면 그 tick 안의 **서버 순서를 유지**하도록 역순으로
 * rank 를 부여한다(먼저 온 종목이 더 큰 rank → 내림차순에서 위). 첫 배치도 같은 규칙이라
 * 처음 스캔의 서버 순서가 그대로 굳는다.
 *
 * 이탈 종목은 맵에서 빼므로 재편입 시 새(더 큰) rank 를 받아 다시 상단으로 온다.
 * resetKey(선택 조건 id) 가 바뀌면 진입 이력이 무의미하므로 전부 초기화한다.
 *
 * codes 는 호출부에서 메모(lastScan 기반)해 넘겨야 가격 폴링 리렌더마다 effect 가 재실행
 * 되지 않는다 — useNewEntryFlash 와 동일 입력 계약. 멤버십이 그대로면 새 Map 을 만들지
 * 않아(참조 안정) 하위 useMemo 재계산도 막는다.
 */
export function useEntryOrder(codes: string[], resetKey: string | null): ReadonlyMap<string, number> {
  const rankRef = useRef<Map<string, number>>(new Map());
  const counterRef = useRef(0);
  const keyRef = useRef<string | null>(resetKey);
  const [orderMap, setOrderMap] = useState<ReadonlyMap<string, number>>(() => new Map());

  useEffect(() => {
    let changed = false;

    // resetKey 변경 → 진입 이력 폐기(다른 조건의 편입 순번은 무의미).
    if (keyRef.current !== resetKey) {
      keyRef.current = resetKey;
      rankRef.current = new Map();
      counterRef.current = 0;
      changed = true;
    }

    const map = rankRef.current;
    const current = new Set(codes);

    // 이탈 종목 제거(재편입 시 새 rank 를 받도록).
    for (const code of [...map.keys()]) {
      if (!current.has(code)) {
        map.delete(code);
        changed = true;
      }
    }

    // 신규 편입: 서버 순서 보존을 위해 역순으로 rank 부여(먼저 온 종목이 더 큰 rank).
    const entered = codes.filter((c) => !map.has(c));
    for (let i = entered.length - 1; i >= 0; i -= 1) {
      counterRef.current += 1;
      map.set(entered[i], counterRef.current);
      changed = true;
    }

    if (changed) setOrderMap(new Map(map));
  }, [codes, resetKey]);

  return orderMap;
}
