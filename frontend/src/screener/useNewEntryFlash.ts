import { useEffect, useRef, useState } from 'react';

/** 신규 진입 tint 를 유지하는 시간(ms). box-shadow 애니메이션(2s)보다 살짝 길게 잡아
 *  애니메이션이 끝나기 전 클래스가 제거돼 깜빡이지 않게 한다. */
export const NEW_ENTRY_FLASH_MS = 2200;

/**
 * 재조회로 코드 집합에 **새로 편입된** 종목을 잠시 표시(플래시)하기 위한 집합을
 * 돌려준다. 이전 코드 집합과 비교해 새 코드만 골라 NEW_ENTRY_FLASH_MS 동안 유지하고
 * 그 후 자동으로 뺀다. 실시간 모니터링에서 조건을 새로 통과한 종목을 눈에 띄게 한다.
 *
 * **첫 조회는 플래시하지 않는다**(prev=null): 처음 채워진 결과 전체가 플래시하면
 * 노이즈다 — 이후 멤버십 변화에만 반응한다. 코드 배열은 호출부에서 메모(lastScan
 * 기반)해 넘겨야 가격 폴링 리렌더마다 재계산되지 않는다.
 */
export function useNewEntryFlash(codes: string[], holdMs = NEW_ENTRY_FLASH_MS): Set<string> {
  const prevRef = useRef<Set<string> | null>(null);
  const timersRef = useRef<Map<string, number>>(new Map());
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const current = new Set(codes);
    const prev = prevRef.current;
    prevRef.current = current;
    if (prev === null) return; // 첫 조회 — 전체 플래시 방지
    const entered = codes.filter((c) => !prev.has(c));
    if (entered.length === 0) return;

    setFlashing((f) => {
      const next = new Set(f);
      entered.forEach((c) => next.add(c));
      return next;
    });
    entered.forEach((c) => {
      const existing = timersRef.current.get(c);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        timersRef.current.delete(c);
        setFlashing((f) => {
          if (!f.has(c)) return f;
          const next = new Set(f);
          next.delete(c);
          return next;
        });
      }, holdMs);
      timersRef.current.set(c, timer);
    });
  }, [codes, holdMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach((t) => window.clearTimeout(t)); };
  }, []);

  return flashing;
}
