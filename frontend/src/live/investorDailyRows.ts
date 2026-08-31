/**
 * 일별 투자자 표의 순수 파생 — 포인트 배열 → 표시 행 + 누적 합계.
 *
 * 렌더에서 떼어 낸 이유는 테스트가 아니라 **정확성**이다. 이 표의 값은 두 항등식
 * 위에 서 있고(`기관 세부 8종 합 == 기관계`, `상위 5주체 합 == 0`), 그 성질은
 * DOM 이 아니라 숫자에서만 검사할 수 있다.
 *
 * ## 왜 `null` 이 있나
 *
 * `breakdown` 은 **종목 경로만** 채운다. 그리고 프론트가 이 필드를 실어 보내기
 * 전의 백엔드를 타면 키가 아예 없다 — 이 리포의 문서화된 개발 구성이 정확히 그
 * 모양이다(워크트리 프론트가 사용자 dev 서버(:8000)를 프록시로 탄다). 그 구간을
 * 0 으로 그리면 "그날 개인은 순매수 0" 이라는 **거짓말**이 되므로 `null` 로
 * 구분하고, 화면은 그 칸을 값이 아니라 공백으로 그린다.
 */
import type { InvestorNetPoint } from '../api/types';
import { realMsToYyyymmdd } from './liveDateTime';

/** 표시 주체. `foreign`·`institution` 만 포인트 최상위에서 오고 나머지는 분해에서 온다. */
export type InvestorColumnKey =
  | 'individual' | 'foreign' | 'institution' | 'other_corp'
  | 'fin_invest' | 'insurance' | 'trust' | 'other_fin'
  | 'bank' | 'pension' | 'private_fund' | 'nation';

export type InvestorColumnGroup = 'top' | 'orgn';

export type InvestorColumn = {
  key: InvestorColumnKey;
  label: string;
  group: InvestorColumnGroup;
};

/**
 * 컬럼 순서 SSOT — 헤더·본문·합계행이 같은 배열을 돈다.
 *
 * `top` 4종의 합은 **0 이다**(`개인 + 외국인 + 기관계 + 기타법인 + 내외국인 = 0`,
 * 내외국인은 `foreign` 에 이미 포함). `orgn` 8종의 합은 `institution` 과 같다.
 * 그래서 "잔차/기타" 컬럼이 없다 — 없는 게 아니라 필요가 없다.
 */
export const INVESTOR_COLUMNS: readonly InvestorColumn[] = [
  { key: 'individual', label: '개인', group: 'top' },
  { key: 'foreign', label: '외국인', group: 'top' },
  { key: 'institution', label: '기관계', group: 'top' },
  { key: 'other_corp', label: '기타법인', group: 'top' },
  { key: 'fin_invest', label: '금융투자', group: 'orgn' },
  { key: 'insurance', label: '보험', group: 'orgn' },
  { key: 'trust', label: '투신', group: 'orgn' },
  { key: 'other_fin', label: '기타금융', group: 'orgn' },
  { key: 'bank', label: '은행', group: 'orgn' },
  { key: 'pension', label: '연기금등', group: 'orgn' },
  { key: 'private_fund', label: '사모펀드', group: 'orgn' },
  { key: 'nation', label: '국가', group: 'orgn' },
];

/** 표시 기간 칩. 벤더 페이지가 100행(≈5개월)이라 **셋 다 콜 1회**로 덮인다. */
export const INVESTOR_DAILY_SPANS = [5, 20, 60] as const;
export type InvestorDailySpan = (typeof INVESTOR_DAILY_SPANS)[number];

export type InvestorCellValues = Record<InvestorColumnKey, number | null>;

export type InvestorDailyRow = {
  t_ms: number;
  /** `YYYYMMDD` — 커서 하이라이트가 이 형식으로 대조한다. */
  date: string;
  values: InvestorCellValues;
};

export type InvestorDailyTable = {
  /** 최신 → 과거. 표는 최근 날짜를 위에 둔다. */
  rows: InvestorDailyRow[];
  /** 표시 구간 누적. 값이 있는 날만 더한다(아래 `missingBreakdown` 참조). */
  totals: InvestorCellValues;
  /**
   * 분해가 없는 행 수. 0 이 아니면 `totals` 의 분해 컬럼이 **그만큼 덜 더해진**
   * 값이므로 화면이 그 사실을 말해야 한다 — 조용히 작은 합계를 보여 주는 것이
   * 이 리포가 반복해서 다룬 실패 유형이다.
   */
  missingBreakdown: number;
};

function emptyCells(): InvestorCellValues {
  return {
    individual: null, foreign: null, institution: null, other_corp: null,
    fin_invest: null, insurance: null, trust: null, other_fin: null,
    bank: null, pension: null, private_fund: null, nation: null,
  };
}

function cellsOf(point: InvestorNetPoint): InvestorCellValues {
  const b = point.breakdown ?? null;
  return {
    // 이 둘은 분해와 무관하게 늘 있다 — 분해가 비어도 표의 뼈대는 남는다.
    foreign: point.foreign_net,
    institution: point.institution_net,
    individual: b ? b.individual : null,
    other_corp: b ? b.other_corp : null,
    fin_invest: b ? b.fin_invest : null,
    insurance: b ? b.insurance : null,
    trust: b ? b.trust : null,
    other_fin: b ? b.other_fin : null,
    bank: b ? b.bank : null,
    pension: b ? b.pension : null,
    private_fund: b ? b.private_fund : null,
    nation: b ? b.nation : null,
  };
}

/**
 * 최근 `span` 거래일을 잘라 표 모델을 만든다.
 *
 * **거래일 수로 자른다 — 달력일이 아니다.** 포인트는 거래일에만 존재하므로 배열
 * 끝에서 세는 것이 곧 거래일 세기다. 호출자가 달력 구간을 넉넉히 요청하고 여기서
 * 자르는 구조라, 기간 칩을 바꿔도 **재요청이 없다**.
 */
export function buildInvestorDailyTable(
  points: readonly InvestorNetPoint[],
  span: number,
): InvestorDailyTable {
  const ascending = [...points].sort((a, b) => a.t_ms - b.t_ms);
  const sliced = span > 0 ? ascending.slice(-span) : ascending;

  const totals = emptyCells();
  let missingBreakdown = 0;
  for (const point of sliced) {
    if (!point.breakdown) missingBreakdown += 1;
    const cells = cellsOf(point);
    for (const { key } of INVESTOR_COLUMNS) {
      const v = cells[key];
      if (v === null) continue;
      totals[key] = (totals[key] ?? 0) + v;
    }
  }

  const rows = sliced
    .map((point) => ({
      t_ms: point.t_ms,
      date: realMsToYyyymmdd(point.t_ms),
      values: cellsOf(point),
    }))
    .reverse();

  return { rows, totals, missingBreakdown };
}
