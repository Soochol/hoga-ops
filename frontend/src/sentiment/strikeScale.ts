/**
 * 행사가 축 스케일 SSOT (ADR-0135 후속 — 차트 판독성 1차 묶음).
 *
 * OI 분포·GEX·IV 스마일은 모두 행사가가 x축이다. 세 차트가 각자 자기 데이터의
 * min/max 로 스케일을 만들면 축이 어긋나 "Max Pain 아래에 GEX 벽이 있다" 같은
 * 교차 판독이 불가능해진다 — 그래서 도메인 계산·눈금·픽셀 변환을 여기 한 곳에
 * 모으고 페이지가 세 차트에 같은 도메인을 내려보낸다.
 *
 * 기본 뷰는 ATM ±15% 다. 실측(2026-08-03)상 행사가는 625~1597.5 인데 미결제·거래가
 * 있는 구조는 ATM ±10% 안에 몰려 있고, 극외가 로또 물량(+58.5% OTM 등)은 전 구간을
 * 선형으로 펴면 중앙부를 좁은 띠로 압축해 버린다. 극외가 자체는 기여 표가 커버한다.
 */

export interface StrikeDomain {
  lo: number;
  hi: number;
}

/** 차트 SVG 공통 좌표계. 세 차트가 같은 값을 써야 축이 세로로 정렬된다. */
export const CHART_W = 720;
export const PAD_L = 8;
export const PAD_R = 8;
/** x축 눈금 라벨 밴드 높이 — 각 차트 viewBox 하단에 이만큼 더한다. */
export const AXIS_H = 18;

/** ATM 기본 줌 폭(기초자산 대비 비율). */
export const ATM_ZOOM_PCT = 0.15;

export function fullDomain(strikes: number[]): StrikeDomain | null {
  if (strikes.length === 0) return null;
  return { lo: Math.min(...strikes), hi: Math.max(...strikes) };
}

/**
 * ATM 중심 도메인. 기초자산이 없으면(콜드 스타트 등) 전체로 폴백한다 —
 * 중심을 지어내서 엉뚱한 창을 보여주는 것보다 낫다.
 */
export function atmDomain(
  strikes: number[],
  underlying: number | null,
  pct: number = ATM_ZOOM_PCT,
): StrikeDomain | null {
  const full = fullDomain(strikes);
  if (full === null) return null;
  if (underlying === null || underlying <= 0) return full;
  return {
    lo: Math.max(full.lo, underlying * (1 - pct)),
    hi: Math.min(full.hi, underlying * (1 + pct)),
  };
}

/** 행사가 → SVG x 픽셀. 도메인이 점(=폭 0)이면 중앙에 고정한다. */
export function xOf(domain: StrikeDomain, strike: number): number {
  const span = domain.hi - domain.lo;
  if (span <= 0) return CHART_W / 2;
  return PAD_L + ((strike - domain.lo) / span) * (CHART_W - PAD_L - PAD_R);
}

/** SVG x 픽셀 → 행사가 (호버 역변환). */
export function strikeAt(domain: StrikeDomain, px: number): number {
  const span = domain.hi - domain.lo;
  if (span <= 0) return domain.lo;
  return domain.lo + ((px - PAD_L) / (CHART_W - PAD_L - PAD_R)) * span;
}

/** KOSPI200 옵션 행사가 간격(2.5p)과 정합하는 눈금 후보. */
const TICK_STEPS = [2.5, 5, 10, 25, 50, 100, 250] as const;

/**
 * 도메인 안의 라운드 눈금. ``maxTicks`` 를 넘지 않는 가장 촘촘한 스텝을 고른다 —
 * ATM 줌(~300p)이면 50 간격, 전체(~1000p)이면 250 간격이 나온다.
 */
export function ticksFor(domain: StrikeDomain, maxTicks: number = 9): number[] {
  const span = domain.hi - domain.lo;
  if (span <= 0) return [domain.lo];
  const step = TICK_STEPS.find((s) => span / s <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const first = Math.ceil(domain.lo / step) * step;
  const out: number[] = [];
  for (let t = first; t <= domain.hi + 1e-9; t += step) out.push(Number(t.toFixed(1)));
  return out;
}

/** 정렬된 행사가 배열에서 값에 가장 가까운 행사가 (호버 스냅). 빈 배열이면 null. */
export function nearestStrike(sorted: number[], value: number): number | null {
  if (sorted.length === 0) return null;
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo] - value) <= Math.abs(sorted[hi] - value) ? sorted[lo] : sorted[hi];
}
