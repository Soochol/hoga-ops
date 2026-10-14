import { useState } from 'react';
import { persistJson, readJsonObject } from '../state/persist';


/**
 * 카드 토글 선택의 저장 — **쓸 때 다시 읽어 병합한다**.
 *
 * 한 저장 키를 여러 필드가 나눠 쓴다(업종 카드의 시장·주체, 주체별 카드의 방향).
 * state 는 지금 화면에 있는 필드만 아는데 통째로 쓰면 다른 카드·이전 버전이 남긴
 * 선택을 지운다. 지수 카드 `useCardModes` 가 같은 이유로 같은 규율을 쓴다.
 *
 * 토글이 여러 파일로 흩어져 있어 여기서만 정의한다 — 규율이 갈리면 조용히 어긋나고,
 * 증상은 "다른 카드를 만졌더니 내 선택이 풀렸다" 라 원인까지 멀다.
 */
export function useCardPref<T extends string>(
  storageKey: string,
  field: string,
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(
    () => (readJsonObject(storageKey)[field] as T) ?? fallback,
  );
  const update = (next: T) => {
    setValue(next);
    persistJson(storageKey, { ...readJsonObject(storageKey), [field]: next });
  };
  return [value, update];
}
