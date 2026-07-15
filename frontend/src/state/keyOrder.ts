/**
 * 사용자 소유 순서 레이어의 공용 순수 헬퍼 (ADR-0114).
 *
 * 순서는 array index가 아니라 **안정 키 배열**로 저장한다. 새 카드/pane 을
 * 추가해도 구 저장값이 깨지지 않고, 삭제된 키는 조용히 드롭된다 —
 * `state/liveLayout.ts` 의 `readCollapsedMap` 관대 검증과 같은 철학
 * (all-or-nothing 금지). live 카드 순서·pane 순서·프리셋 적용이 모두 재사용한다.
 */

/**
 * 저장된 순서 배열을 canonical 키 집합에 맞춰 정규화한다.
 *  - 배열이 아니면 canonical 사본 반환.
 *  - 유효 키만 필터(unknown 드롭), 첫 등장만 유지(중복 제거).
 *  - canonical 에 있으나 저장값에 없는 키는 canonical 순서로 뒤에 append.
 *
 * 이 규칙이 전방/후방 호환의 전부다: 구버전이 저장한 순서를 신버전이 읽으면
 * 새 키가 canonical 순서로 붙고, 신버전이 저장한 순서를 구버전이 읽으면
 * 모르는 키가 드롭된다.
 */
export function normalizeKeyOrder<K extends string>(
  raw: unknown,
  canonical: readonly K[],
  isKey: (value: string) => value is K,
): K[] {
  if (!Array.isArray(raw)) return [...canonical];

  const seen = new Set<K>();
  const next: K[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isKey(entry) || seen.has(entry)) continue;
    seen.add(entry);
    next.push(entry);
  }
  for (const key of canonical) {
    if (!seen.has(key)) next.push(key);
  }
  return next;
}

/**
 * 전체 순서 배열에서 "보이는" 부분수열만 재배열한다. 숨김 키는 전체 순서 내
 * 절대 위치를 유지하므로, 다시 표시하면 원래 자리로 돌아온다.
 *
 * `from`/`to` 는 **보이는 목록**(hidden 제외) 기준 인덱스다(dnd-kit 의
 * active/over 가 보이는 항목만 다루므로). 보이는 항목들을 arrayMove 로 치환한
 * 뒤, 전체 배열의 보이는 슬롯 위치에 되박아 넣는다.
 */
export function reorderVisible<K extends string>(
  fullOrder: readonly K[],
  hidden: ReadonlySet<K>,
  from: number,
  to: number,
): K[] {
  const visible = fullOrder.filter((key) => !hidden.has(key));
  if (
    from < 0 || from >= visible.length
    || to < 0 || to >= visible.length
    || from === to
  ) {
    return [...fullOrder];
  }

  const [moved] = visible.splice(from, 1);
  visible.splice(to, 0, moved);

  // 보이는 슬롯 위치에 재배열된 visible 을 순서대로 되박고, 숨김 키는 제자리에.
  let cursor = 0;
  return fullOrder.map((key) => (hidden.has(key) ? key : visible[cursor++]));
}
