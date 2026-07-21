/**
 * Compact display labels for the 거래원 sidebar's narrow broker column.
 *
 * The "증권" suffix carries no information (every Korean member firm has
 * it) so we drop it and keep results ≤4 chars for clean rendering. New
 * canonical names added to backend `hoga.broker_names._CANONICAL`
 * usually need no entry here — the automatic "strip 증권, cap at 4
 * chars" rule covers the common case. Add an explicit override only
 * when the rule produces an awkward label (extra abbreviation needed,
 * or no `증권` suffix to strip from a >4-char name).
 */

const DISPLAY_OVERRIDES: Record<string, string> = {
  '모건스탠리증권': '모건스탠',
  '코리아에셋': '코리아',
};

/** Return the compact ≤4-char label for *canonicalName*. */
export function brokerDisplayShort(canonicalName: string): string {
  const override = DISPLAY_OVERRIDES[canonicalName];
  if (override !== undefined) return override;
  const stripped = canonicalName.endsWith('증권')
    ? canonicalName.slice(0, -2)
    : canonicalName;
  return stripped.length > 4 ? stripped.slice(0, 4) : stripped;
}

/**
 * 외국계 창구 힌트 — 부분일치 매칭인 이유: 백엔드 canonical() 은 미등록 원형을
 * 그대로 통과시키므로 (유비에스·노무라 등 _CANONICAL 밖 이름이 실데이터에
 * 나타난다) 정확 일치 집합은 새 표기가 올 때마다 조용히 샌다. 힌트 부분일치는
 * 표기 변형(증권 접미, 서울 지점 접미)에 강건하다. 국내사와 겹치는 힌트가
 * 생기면 여기서 다듬는다. 판별 불확실한 이름(예: "H S")은 넣지 않는다 —
 * 미검증 추론 금지는 백엔드 _CANONICAL 의 골드만/씨티그룹 교훈과 같은 규칙.
 */
const FOREIGN_HINTS = [
  'JP모간', '모건스탠리', '골드만', '씨티', '맥쿼리', '유비에스', 'UBS',
  '노무라', '다이와', '메릴린치', 'CLSA', 'HSBC', 'BNP', '도이치', '크레디트스위스',
];

/** 외국계 창구 여부 — 거래원 창의 「외」 뱃지·외국계 합계 푸터용. */
export function isForeignBroker(canonicalName: string): boolean {
  const upper = canonicalName.toUpperCase();
  return FOREIGN_HINTS.some((hint) => upper.includes(hint.toUpperCase()));
}
