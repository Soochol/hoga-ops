import { useRef } from 'react';

/** frozen=true 동안 value 를 freeze 시점 값으로 고정하고, false 면 최신 value 를 통과시킨다.
 *  행 드래그 중 그룹 순서 동결(G1)용 — 드래그 시작 시 마지막 순서를 잡아두고 drag-end 에
 *  최신으로 갱신한다. frozen 전이는 호출부가 제어(드래그 start/end). */
export function useFrozenWhileDragging<T>(value: T, frozen: boolean): T {
  const ref = useRef(value);
  if (!frozen) ref.current = value; // 비드래그 시에만 최신으로 커밋
  return frozen ? ref.current : value;
}
