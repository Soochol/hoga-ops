


/** 구간의 봉 수를 아는 호스트가 준 값 — 없으면(구형 호출부) 막지 않는다. */
export type PatternSpan = { bars: number; min: number; max: number };


/**
 * 「패턴 찾기」 버튼의 상태. **누르기 전에 되는지 말하기 위한** 순수 함수다 —
 * 없으면 범위 밖 구간이 "눌렀는데 아무 일도 안 나는 버튼" 이 된다(시드가 조용히
 * null 이 되고 화면은 그대로다).
 */
export function patternButtonState(span: PatternSpan | undefined): {
  disabled: boolean;
  title: string;
  suffix: string;
} {
  const out = span != null && (span.bars < span.min || span.bars > span.max);
  return {
    disabled: out,
    title: out
      ? `${span!.bars}봉 — 패턴 검색은 ${span!.min}~${span!.max}봉이다`
      : '이 봉들과 닮은 캔들 패턴을 가진 종목을 찾는다',
    suffix: out ? ` · ${span!.bars}봉` : '',
  };
}
