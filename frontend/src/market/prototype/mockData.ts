// ============================================================================
// PROTOTYPE — throwaway. "시장 종합" 페이지 변형 평가용 목업 데이터.
//
// 실데이터 아님. 값은 2026-08 장중을 흉내 낸 그럴듯한 더미다. 변형이 확정되면
// 이 파일은 실제 API 클라이언트로 대체된다 — 매핑 가능한 실표면:
//   지수 시세      → GET /api/live/index-quotes (ka20001, 이미 하단 바가 사용)
//   지수 분봉      → GET /api/live/index-candles (ka20005)
//   순위 4종       → GET /api/live/rankings (ka10027/ka10023/ka10030/ka10032)
//   시장별 순매수  → GET /api/live/index-investor-net (ka10051, KOSPI·KOSDAQ만)
//   섹터(폴더) 온도 → GET /api/live/index-sector-rankings
//   옵션 심리      → GET /api/sentiment/option (ADR-0135)
//   등락종목수     → **백엔드에 TR 없음 — 신규 업스트림 작업 필요** (ka10030 의
//                    updown_incls 플래그만 존재, 전용 집계 TR 미등록)
// ============================================================================

export interface MockIndex {
  id: string;
  label: string;
  value: number;
  change: number;
  changePct: number;
  /** 장중 스파크라인 (시가→현재, 정규화 전 원시값) */
  spark: number[];
  advance: number | null; // 상승 종목수 (null = 산출 불가한 지수)
  decline: number | null;
  flat: number | null;
}

/** 결정적 유사 intraday 곡선 — 스크린샷 간 비교가 흔들리지 않게 난수 대신 합성파. */
function synthSpark(open: number, close: number, wobble: number, seed: number): number[] {
  const n = 40;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const drift = open + (close - open) * t;
    const w =
      Math.sin(t * Math.PI * 2.7 + seed) * wobble * (1 - t * 0.4) +
      Math.sin(t * Math.PI * 9.3 + seed * 2.1) * wobble * 0.35;
    out.push(drift + w);
  }
  out[n - 1] = close;
  return out;
}

export const MOCK_INDICES: MockIndex[] = [
  {
    id: 'KOSPI', label: '코스피', value: 3187.45, change: 25.93, changePct: 0.82,
    spark: synthSpark(3161.5, 3187.45, 9.5, 1.3), advance: 512, decline: 331, flat: 87,
  },
  {
    id: 'KOSDAQ', label: '코스닥', value: 812.36, change: -3.34, changePct: -0.41,
    spark: synthSpark(815.7, 812.36, 3.1, 4.1), advance: 743, decline: 690, flat: 112,
  },
  {
    id: 'KOSPI200', label: '코스피200', value: 428.17, change: 4.03, changePct: 0.95,
    spark: synthSpark(424.1, 428.17, 1.4, 2.2), advance: 141, decline: 48, flat: 11,
  },
  {
    id: 'KOSDAQ150', label: '코스닥150', value: 1421.88, change: -9.12, changePct: -0.64,
    spark: synthSpark(1431.0, 1421.88, 5.2, 5.7), advance: 61, decline: 82, flat: 7,
  },
];

export interface MockRankRow {
  rank: number;
  code: string;
  name: string;
  price: number;
  changePct: number;
  /** 거래대금(억) — value 순위에서만 의미, 나머지는 참고 표기 */
  valueEok: number;
}

export const MOCK_TOP_GAINERS: MockRankRow[] = [
  { rank: 1, code: '277810', name: '레인보우로보틱스', price: 248500, changePct: 24.13, valueEok: 4210 },
  { rank: 2, code: '042660', name: '한화오션', price: 91200, changePct: 12.86, valueEok: 6873 },
  { rank: 3, code: '196170', name: '알테오젠', price: 412000, changePct: 9.71, valueEok: 5320 },
  { rank: 4, code: '034020', name: '두산에너빌리티', price: 44950, changePct: 8.44, valueEok: 7911 },
  { rank: 5, code: '010140', name: '삼성중공업', price: 17840, changePct: 7.92, valueEok: 3187 },
  { rank: 6, code: '272210', name: '한화시스템', price: 38750, changePct: 6.58, valueEok: 2244 },
  { rank: 7, code: '000155', name: '두산', price: 312000, changePct: 5.91, valueEok: 1876 },
  { rank: 8, code: '098460', name: '고영', price: 21300, changePct: 5.44, valueEok: 645 },
];

export const MOCK_TOP_LOSERS: MockRankRow[] = [
  { rank: 1, code: '028300', name: 'HLB', price: 61200, changePct: -11.82, valueEok: 2954 },
  { rank: 2, code: '247540', name: '에코프로비엠', price: 148700, changePct: -7.35, valueEok: 3811 },
  { rank: 3, code: '086520', name: '에코프로', price: 71400, changePct: -6.91, valueEok: 2612 },
  { rank: 4, code: '091990', name: '셀트리온제약', price: 84300, changePct: -5.12, valueEok: 981 },
  { rank: 5, code: '022100', name: '포스코DX', price: 31150, changePct: -4.87, valueEok: 1122 },
  { rank: 6, code: '403870', name: 'HPSP', price: 38900, changePct: -4.41, valueEok: 734 },
  { rank: 7, code: '112040', name: '위메이드', price: 30250, changePct: -3.96, valueEok: 512 },
  { rank: 8, code: '293490', name: '카카오게임즈', price: 18120, changePct: -3.52, valueEok: 388 },
];

export const MOCK_TOP_VALUE: MockRankRow[] = [
  { rank: 1, code: '005930', name: '삼성전자', price: 88400, changePct: 1.61, valueEok: 18432 },
  { rank: 2, code: '000660', name: 'SK하이닉스', price: 264500, changePct: 2.72, valueEok: 15211 },
  { rank: 3, code: '034020', name: '두산에너빌리티', price: 44950, changePct: 8.44, valueEok: 7911 },
  { rank: 4, code: '042660', name: '한화오션', price: 91200, changePct: 12.86, valueEok: 6873 },
  { rank: 5, code: '196170', name: '알테오젠', price: 412000, changePct: 9.71, valueEok: 5320 },
  { rank: 6, code: '277810', name: '레인보우로보틱스', price: 248500, changePct: 24.13, valueEok: 4210 },
  { rank: 7, code: '247540', name: '에코프로비엠', price: 148700, changePct: -7.35, valueEok: 3811 },
  { rank: 8, code: '373220', name: 'LG에너지솔루션', price: 342000, changePct: 0.29, valueEok: 3644 },
];

export const MOCK_VOLUME_SURGE: MockRankRow[] = [
  { rank: 1, code: '010140', name: '삼성중공업', price: 17840, changePct: 7.92, valueEok: 3187 },
  { rank: 2, code: '098460', name: '고영', price: 21300, changePct: 5.44, valueEok: 645 },
  { rank: 3, code: '272210', name: '한화시스템', price: 38750, changePct: 6.58, valueEok: 2244 },
  { rank: 4, code: '112040', name: '위메이드', price: 30250, changePct: -3.96, valueEok: 512 },
  { rank: 5, code: '022100', name: '포스코DX', price: 31150, changePct: -4.87, valueEok: 1122 },
  { rank: 6, code: '000155', name: '두산', price: 312000, changePct: 5.91, valueEok: 1876 },
  { rank: 7, code: '091990', name: '셀트리온제약', price: 84300, changePct: -5.12, valueEok: 981 },
  { rank: 8, code: '403870', name: 'HPSP', price: 38900, changePct: -4.41, valueEok: 734 },
];

export interface MockInvestorNet {
  market: 'KOSPI' | 'KOSDAQ';
  /** 당일 잠정 순매수 (억원) */
  individual: number;
  foreign: number;
  institution: number;
  /** 최근 5거래일 외국인 순매수 (억원, 과거→오늘) */
  foreign5d: number[];
  institution5d: number[];
  individual5d: number[];
}

export const MOCK_INVESTOR_NET: MockInvestorNet[] = [
  {
    market: 'KOSPI', individual: -3241, foreign: 2890, institution: 412,
    foreign5d: [1240, -890, 2110, 3480, 2890],
    institution5d: [-420, 610, -180, 950, 412],
    individual5d: [-810, 240, -1930, -4390, -3241],
  },
  {
    market: 'KOSDAQ', individual: 1120, foreign: -684, institution: -391,
    foreign5d: [310, -520, -1080, -240, -684],
    institution5d: [120, -310, -420, 90, -391],
    individual5d: [-430, 830, 1490, 160, 1120],
  },
];

export interface MockSector {
  name: string;
  changePct: number;
  /** 그룹 평균 흐름 스파크 (당일) */
  spark: number[];
  leaders: string[]; // 주도 종목명
}

export const MOCK_SECTORS: MockSector[] = [
  { name: '로봇', changePct: 3.12, spark: synthSpark(0, 3.12, 0.6, 3.3), leaders: ['레인보우로보틱스', '고영'] },
  { name: '조선', changePct: 2.41, spark: synthSpark(0, 2.41, 0.5, 1.1), leaders: ['한화오션', '삼성중공업'] },
  { name: '반도체', changePct: 1.84, spark: synthSpark(0, 1.84, 0.4, 2.9), leaders: ['SK하이닉스', '삼성전자'] },
  { name: '원전·전력', changePct: 1.52, spark: synthSpark(0, 1.52, 0.5, 4.4), leaders: ['두산에너빌리티'] },
  { name: '방산', changePct: 0.94, spark: synthSpark(0, 0.94, 0.4, 5.2), leaders: ['한화시스템'] },
  { name: '자동차', changePct: 0.31, spark: synthSpark(0, 0.31, 0.3, 6.1), leaders: ['현대차'] },
  { name: '인터넷', changePct: -0.24, spark: synthSpark(0, -0.24, 0.3, 7.3), leaders: ['네이버'] },
  { name: '바이오', changePct: -0.61, spark: synthSpark(0, -0.61, 0.5, 8.8), leaders: ['알테오젠', 'HLB'] },
  { name: '이차전지', changePct: -1.23, spark: synthSpark(0, -1.23, 0.5, 9.6), leaders: ['에코프로비엠', 'LG에너지솔루션'] },
  { name: '게임', changePct: -1.87, spark: synthSpark(0, -1.87, 0.4, 10.2), leaders: ['위메이드', '카카오게임즈'] },
];

export const MOCK_OPTION_SENTIMENT = {
  pcVolumeRatio: 0.87,
  pcOiRatio: 1.12,
  maxPain: 425.0,
  atmIv: 14.2,
};

export const MOCK_AS_OF = '14:21:32';
