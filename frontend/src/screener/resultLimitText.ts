/** 구버전 응답/저장은 초과 여부를 모른다. 기본 상한 이상이면 가능성으로만 알린다. */
export function resultLimitText(count: number, hasMore: boolean | undefined): string | null {
  if (hasMore === false || (hasMore === undefined && count < 1000)) return null;
  const n = count.toLocaleString('ko-KR');
  const lead = hasMore
    ? `거래대금 상위 ${n}건만 표시`
    : `${n}건 표시 · 조회 상한에 도달했을 수 있습니다`;
  return `${lead} · 정렬은 표시된 결과 내에서 적용됩니다 · 사전필터로 범위를 좁혀 주세요`;
}
