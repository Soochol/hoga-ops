/**
 * 「시장 폭」 4모드가 쓰는 계산 — 렌더와 분리해 테스트 가능하게 둔다.
 *
 * 네 모드는 **같은 데이터의 다른 축**이다(#1102 후속, 지표 시안 7종 중 4종 채택 —
 * `prototype/market-breadth-indicators-2026-08-05` 브랜치 보존):
 *   개수  — 몇 종목이 올랐나
 *   분산  — 업종별로 얼마나 갈렸나 (지수장 ↔ 종목장)
 *   쏠림  — 돈이 어디로 갔나
 *   지수  — 0~100 정규화, 어제와 비교되는 값
 *
 * 여기 있는 함수는 전부 **`null` 을 0 으로 채우지 않는다** — 이 페이지의 대원칙이다
 * (`MarketPage` 헤더 주석 ①). 값이 없으면 `null` 을 돌려 화면이 `—` 를 그리게 한다.
 */
import type { MarketIndexRow, MarketSectorRow } from '../api/market';

/** ka20003 이 업종과 같은 배열에 실어 주는 **규모별 지수** — 업종 통계에서 제외한다. */
export const SIZE_ROW_NAMES = ['대형주', '중형주', '소형주'] as const;
const SIZE_ROW_SET = new Set<string>(SIZE_ROW_NAMES);

/** 상승 비율 %. 분모는 상승+하락+보합 — 미거래 종목은 애초에 세지 않는다. */
export function advancePct(idx: MarketIndexRow | null | undefined): number | null {
  if (!idx || idx.rising == null || idx.falling == null) return null;
  const total = idx.rising + idx.falling + (idx.flat ?? 0);
  return total > 0 ? (idx.rising / total) * 100 : null;
}

/** 등락비율(ADR) = 상승/하락. 하락이 0이면 분모가 죽으므로 `null`. */
export function advanceDeclineRatio(idx: MarketIndexRow | null | undefined): number | null {
  if (!idx || idx.rising == null || !idx.falling) return null;
  return idx.rising / idx.falling;
}

/**
 * ADR(배수)을 0~100 게이지로 옮긴다 — **2배를 50 에 놓는 로그 매핑**.
 * 선형으로 두면 1배(중립)와 10배가 눈금 양끝에 붙어 중간이 안 읽힌다. 4배에서 100,
 * 1/4배에서 0 으로 포화한다(그 밖은 어차피 "극단"이라 눈금이 더 필요 없다).
 */
export function adrToGauge(adr: number | null): number | null {
  if (adr == null || adr <= 0) return null;
  return Math.max(0, Math.min(100, 50 + (Math.log2(adr) / 2) * 50));
}

/** 52주 신고-신저 지수 = 신고/(신고+신저) × 100. 둘 다 0이면 분모가 없어 `null`. */
export function highLowIndex(high: number | null | undefined, low: number | null | undefined): number | null {
  if (high == null || low == null) return null;
  const total = high + low;
  return total > 0 ? (high / total) * 100 : null;
}

export interface SectorSpread {
  pcts: number[];
  min: number;
  max: number;
  /** max − min. "오늘 업종 선택이 수익을 얼마나 갈랐나". */
  range: number;
  /** 모표준편차 — 이상치 하나로 벌어진 스프레드와 균등한 퍼짐을 구분한다. */
  sd: number;
}

/** 업종 등락률의 퍼짐. 규모별 행은 업종이 아니므로 뺀다 — 넣으면 이중 계산이다. */
export function sectorSpread(sectors: readonly MarketSectorRow[]): SectorSpread | null {
  const pcts = sectors
    .filter((s) => !SIZE_ROW_SET.has(s.name) && s.change_pct != null)
    .map((s) => s.change_pct as number);
  if (pcts.length < 2) return null;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const sd = Math.sqrt(pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pcts.length);
  const min = Math.min(...pcts);
  const max = Math.max(...pcts);
  return { pcts, min, max, range: max - min, sd };
}

/** 상승 업종 수 / 등락률이 있는 업종 수. 규모별 행 제외는 위와 같은 이유. */
export function risingSectorCount(sectors: readonly MarketSectorRow[]): [number, number] {
  const withPct = sectors.filter((s) => !SIZE_ROW_SET.has(s.name) && s.change_pct != null);
  return [withPct.filter((s) => (s.change_pct as number) > 0).length, withPct.length];
}

export interface SizeShare {
  name: string;
  eok: number;
  share: number;
}

/**
 * 규모별 거래대금 비중. **코스닥엔 규모별 지수가 없어 빈 배열이 정상**이다(부재의
 * 종류를 구분하는 이 페이지의 규칙 ② — 화면이 "데이터 없음" 이 아니라 이유를 적는다).
 *
 * 분모는 종합 행의 거래대금이라 세 비중의 합이 100%에 못 미친다(실측 코스피 98%) —
 * 규모별 지수에 안 들어가는 종목이 있기 때문이고, 남는 몫은 막대에 빈칸으로 남긴다.
 */
export function sizeShares(
  sectors: readonly MarketSectorRow[],
  totalEok: number | null | undefined,
): SizeShare[] {
  if (!totalEok) return [];
  const out: SizeShare[] = [];
  for (const name of SIZE_ROW_NAMES) {
    const row = sectors.find((s) => s.name === name);
    if (row?.trade_value_eok == null) continue;
    out.push({ name, eok: row.trade_value_eok, share: (row.trade_value_eok / totalEok) * 100 });
  }
  return out;
}

/** 억원 → 조원. 거래대금은 조 단위로 읽는 것이 관례다. */
export function eokToJo(eok: number | null | undefined): number | null {
  return eok == null ? null : eok / 10_000;
}
