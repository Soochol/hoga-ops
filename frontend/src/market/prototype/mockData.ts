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

export interface MockNetTrend {
  market: 'KOSPI' | 'KOSDAQ';
  /** 최근 20거래일 일별 순매수 (억원, 과거→오늘; 마지막 5일은 MOCK_INVESTOR_NET 의 5d 와 일치) */
  foreignDaily: number[];
  institutionDaily: number[];
  /** 같은 20일의 지수 종가 (누적 수급 vs 지수 대조 오버레이용) */
  indexClose: number[];
}

/** MOCK_NET_TREND 와 같은 20거래일 라벨 (과거→오늘, 오늘 = 08/05 잠정) */
export const MOCK_TREND_DATES = [
  '07/09', '07/10', '07/13', '07/14', '07/15', '07/16', '07/17', '07/20', '07/21', '07/22',
  '07/23', '07/24', '07/27', '07/28', '07/29', '07/30', '07/31', '08/03', '08/04', '08/05',
];

/** 개인 일별 = -(외국인+기관) 근사 (3주체 합 ≈ 0) — 표 표시용 파생 */
export function mockIndividualDaily(t: MockNetTrend): number[] {
  return t.foreignDaily.map((f, i) => -(f + t.institutionDaily[i]));
}

/** 20일 일별 순매수 목업 — 앞 15일 합성 + 뒤 5일은 5d 목업과 동일 값. */
function synthDailyNet(seed: number, scale: number, tail: number[]): number[] {
  const head: number[] = [];
  for (let i = 0; i < 15; i++) {
    head.push(Math.round((Math.sin(i * 1.7 + seed) + Math.sin(i * 0.61 + seed * 3.1) * 0.6) * scale));
  }
  return [...head, ...tail];
}

export const MOCK_NET_TREND: MockNetTrend[] = [
  {
    market: 'KOSPI',
    foreignDaily: synthDailyNet(1.1, 2400, MOCK_INVESTOR_NET[0].foreign5d),
    institutionDaily: synthDailyNet(4.2, 900, MOCK_INVESTOR_NET[0].institution5d),
    indexClose: synthSpark(3092, 3187.45, 22, 6.5).filter((_, i) => i % 2 === 0),
  },
  {
    market: 'KOSDAQ',
    foreignDaily: synthDailyNet(2.7, 700, MOCK_INVESTOR_NET[1].foreign5d),
    institutionDaily: synthDailyNet(5.9, 350, MOCK_INVESTOR_NET[1].institution5d),
    indexClose: synthSpark(838, 812.36, 7, 7.8).filter((_, i) => i % 2 === 0),
  },
];

// ── 극대화판 추가 4종 (2026-08-05) ──────────────────────────────────────────
//   프로그램 매매 추이  → ka90005(시간대별)·ka90010(일자별)·ka90003(상위50)
//   기관·외인 연속매매  → ka10131(연속매매현황)·ka10035(외인연속순매매상위)
//   시장 폭(breadth)    → ka10016(신고저가)·ka10017(상하한가)·ka10019(가격급등락)
//   KRX 전업종지수      → ka20003(전업종지수)·ka20002(업종별주가)
// 전부 백엔드 미배선 — 채택 시 유량 예산 안에서 폴링 주기를 정해야 한다.

export interface MockProgramTrend {
  market: 'KOSPI' | 'KOSDAQ';
  /** 30분 슬롯별 순매수 (억원, 09:00→현재) — 차익/비차익 분리 (ka90005) */
  arbDaily: number[];
  nonArbDaily: number[];
  totalEok: number;
}

export const MOCK_PROGRAM_TREND: MockProgramTrend[] = [
  {
    market: 'KOSPI',
    arbDaily: [310, -180, 420, 150, -90, 260, 380, -120, 210, 340, 190],
    nonArbDaily: [820, 640, -310, 910, 530, -240, 760, 1120, 480, -180, 690],
    totalEok: 7070,
  },
  {
    market: 'KOSDAQ',
    arbDaily: [40, -60, 80, -30, 50, -70, 30, 60, -40, 20, 30],
    nonArbDaily: [-210, 180, -340, -120, 240, -410, -180, 90, -260, -150, -80],
    totalEok: -1130,
  },
];

export interface MockStreakRow {
  code: string;
  name: string;
  actor: '외국인' | '기관';
  days: number;
  netEok: number;
  changePct: number;
}

/** 기관·외국인 연속 순매수 현황 (ka10131) — 연속일수 내림차순 */
export const MOCK_STREAKS: MockStreakRow[] = [
  { code: '005930', name: '삼성전자', actor: '외국인', days: 7, netEok: 12410, changePct: 1.61 },
  { code: '042660', name: '한화오션', actor: '기관', days: 6, netEok: 2140, changePct: 12.86 },
  { code: '000660', name: 'SK하이닉스', actor: '외국인', days: 5, netEok: 8320, changePct: 2.72 },
  { code: '034020', name: '두산에너빌리티', actor: '기관', days: 4, netEok: 1530, changePct: 8.44 },
  { code: '005380', name: '현대차', actor: '외국인', days: 4, netEok: 1890, changePct: 0.31 },
  { code: '196170', name: '알테오젠', actor: '기관', days: 3, netEok: 980, changePct: 9.71 },
  { code: '035420', name: 'NAVER', actor: '외국인', days: 3, netEok: 760, changePct: -0.24 },
  { code: '003230', name: '삼양식품', actor: '기관', days: 3, netEok: 410, changePct: 0.88 },
];

export interface MockBreadth {
  market: 'KOSPI' | 'KOSDAQ';
  newHigh52: number;
  newLow52: number;
  upperLimit: number;
  lowerLimit: number;
  surge: number; // 가격 급등 (ka10019)
  plunge: number;
}

export const MOCK_BREADTH: MockBreadth[] = [
  { market: 'KOSPI', newHigh52: 38, newLow52: 6, upperLimit: 2, lowerLimit: 0, surge: 14, plunge: 5 },
  { market: 'KOSDAQ', newHigh52: 41, newLow52: 23, upperLimit: 7, lowerLimit: 1, surge: 26, plunge: 18 },
];

export interface MockKrxSector {
  name: string;
  value: number;
  changePct: number;
}

/** KRX 전업종지수 (ka20003) — 자체 히트맵 폴더("섹터 온도")와 다른 객관 업종 축 */
export const MOCK_KRX_SECTORS: MockKrxSector[] = [
  { name: '운수장비', value: 2841.12, changePct: 2.14 },
  { name: '전기전자', value: 8412.33, changePct: 1.92 },
  { name: '기계', value: 1954.08, changePct: 1.43 },
  { name: '증권', value: 812.44, changePct: 1.08 },
  { name: '철강금속', value: 5233.91, changePct: 0.81 },
  { name: '금융업', value: 1121.37, changePct: 0.52 },
  { name: '음식료품', value: 4188.02, changePct: 0.21 },
  { name: '유통업', value: 488.13, changePct: -0.12 },
  { name: '건설업', value: 92.44, changePct: -0.28 },
  { name: '서비스업', value: 1544.71, changePct: -0.33 },
  { name: '화학', value: 6120.55, changePct: -0.42 },
  { name: '의약품', value: 21044.87, changePct: -0.71 },
];

/** 장중 30분 슬롯 라벨 (MOCK_PROGRAM_TREND 의 11개 값과 정렬) */
export const MOCK_INTRADAY_SLOTS = [
  '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:21',
];

export interface MockIntradayInvestor {
  market: 'KOSPI' | 'KOSDAQ';
  /** 슬롯별 순매수 (억원, 누적 아님) — 합계 = MOCK_INVESTOR_NET 당일 잠정과 일치 */
  individual: number[];
  foreign: number[];
  institution: number[];
}

/** 장중 투자자별 매매 (ka10064 — 시장 스코프 시각별 시계열) */
export const MOCK_INTRADAY_INVESTOR: MockIntradayInvestor[] = [
  {
    market: 'KOSPI',
    individual: [-180, -420, -310, -560, -240, -90, -380, -510, -290, -240, -83],
    foreign: [240, 380, 190, 520, 310, 60, 290, 430, 250, 160, 60],
    institution: [-60, 40, 120, 40, -70, 30, 90, 80, 40, 80, 23],
  },
  {
    market: 'KOSDAQ',
    individual: [90, 180, 60, 210, 140, -40, 120, 160, 80, 60, 15],
    foreign: [-60, -120, -30, -140, -90, 20, -80, -110, -50, -30, 6],
    institution: [-30, -60, -30, -70, -50, 20, -40, -50, -30, -30, -21],
  },
];

/** 프로그램 매매 일자별 20거래일 (ka90010) — MOCK_TREND_DATES 와 정렬 */
export const MOCK_PROGRAM_DAILY20: Array<{
  market: 'KOSPI' | 'KOSDAQ';
  arbDaily: number[];
  nonArbDaily: number[];
}> = [
  {
    market: 'KOSPI',
    arbDaily: [420, -310, 180, 520, -240, 390, 110, -480, 260, 610, -190, 340, 90, -260, 430, 180, -120, 510, 280, 1870],
    nonArbDaily: [1240, 860, -540, 1620, 910, -380, 1180, 1930, 740, -290, 1080, 620, -410, 890, 1310, 560, -230, 970, 1440, 5220],
  },
  {
    market: 'KOSDAQ',
    arbDaily: [60, -40, 30, 80, -50, 40, 20, -60, 30, 70, -30, 40, 10, -40, 50, 20, -20, 60, 30, 110],
    nonArbDaily: [-280, 210, -410, -160, 290, -520, -230, 120, -340, -180, 240, -390, -150, 180, -420, -260, 90, -310, -190, -1240],
  },
];

export interface MockPeriodNetRow {
  code: string;
  name: string;
  actor: '외국인' | '기관';
  streakDays: number;
  streakNet: number; // 연속 구간 누적 (억원)
  net5: number;
  net10: number;
  net20: number;
  changePct: number;
}

/** 기간 순매수 상위 — 연속(ka10131) · 기간별(ka10034 외인 / ka90009 외인·기관).
 *  주체별 카드 2장으로 나눠 쓰므로 각 주체 8행씩 채운다. */
export const MOCK_PERIOD_NET: MockPeriodNetRow[] = [
  // 외국인
  { code: '005930', name: '삼성전자', actor: '외국인', streakDays: 7, streakNet: 12410, net5: 9840, net10: 14210, net20: 18630, changePct: 1.61 },
  { code: '000660', name: 'SK하이닉스', actor: '외국인', streakDays: 5, streakNet: 8320, net5: 8320, net10: 11840, net20: 21470, changePct: 2.72 },
  { code: '005380', name: '현대차', actor: '외국인', streakDays: 4, streakNet: 1890, net5: 2110, net10: 1540, net20: -890, changePct: 0.31 },
  { code: '035420', name: 'NAVER', actor: '외국인', streakDays: 3, streakNet: 760, net5: 890, net10: -420, net20: 1130, changePct: -0.24 },
  { code: '373220', name: 'LG에너지솔루션', actor: '외국인', streakDays: 2, streakNet: 640, net5: 1480, net10: 3210, net20: 2890, changePct: 0.29 },
  { code: '105560', name: 'KB금융', actor: '외국인', streakDays: 6, streakNet: 3120, net5: 2740, net10: 4410, net20: 6820, changePct: 1.12 },
  { code: '051910', name: 'LG화학', actor: '외국인', streakDays: 2, streakNet: 540, net5: 720, net10: -1340, net20: -2210, changePct: -0.42 },
  { code: '009540', name: 'HD한국조선해양', actor: '외국인', streakDays: 4, streakNet: 1420, net5: 1680, net10: 2960, net20: 4530, changePct: 3.18 },
  // 기관
  { code: '042660', name: '한화오션', actor: '기관', streakDays: 6, streakNet: 2140, net5: 1980, net10: 2890, net20: 3120, changePct: 12.86 },
  { code: '034020', name: '두산에너빌리티', actor: '기관', streakDays: 4, streakNet: 1530, net5: 1710, net10: 2440, net20: 4180, changePct: 8.44 },
  { code: '196170', name: '알테오젠', actor: '기관', streakDays: 3, streakNet: 980, net5: 1240, net10: 2010, net20: 2670, changePct: 9.71 },
  { code: '003230', name: '삼양식품', actor: '기관', streakDays: 3, streakNet: 410, net5: 520, net10: 780, net20: 1340, changePct: 0.88 },
  { code: '012450', name: '한화에어로스페이스', actor: '기관', streakDays: 2, streakNet: 380, net5: 940, net10: 1870, net20: 3560, changePct: 1.94 },
  { code: '010140', name: '삼성중공업', actor: '기관', streakDays: 5, streakNet: 1180, net5: 1340, net10: 2210, net20: 2980, changePct: 7.92 },
  { code: '000270', name: '기아', actor: '기관', streakDays: 2, streakNet: 620, net5: 810, net10: 1520, net20: -430, changePct: 0.64 },
  { code: '207940', name: '삼성바이오로직스', actor: '기관', streakDays: 3, streakNet: 890, net5: 1120, net10: 640, net20: 1780, changePct: -0.38 },
];

/** 증시 주변 자금 (조원) — 키움 TR 없음. 원천 = 금융투자협회(KOFIA), 공공데이터포털
 *  "금융위원회_금융투자협회종합통계정보" 오픈 API (일 단위, T+2 지연 공시).
 *  20일 시계열, 마지막 값 = 08/03 기준 (오늘 08/05 의 T+2). */
export interface MockFundSeries {
  label: string;
  values: number[]; // 조원
}

/** 잔고 레벨 합성 — 120거래일, 드리프트 + 파동, 끝값 고정 (결정적) */
function synthLevel(start: number, end: number, wobble: number, seed: number): number[] {
  const n = 120;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const drift = start + (end - start) * t;
    const w =
      Math.sin(t * Math.PI * 5.3 + seed) * wobble +
      Math.sin(t * Math.PI * 17.1 + seed * 2.3) * wobble * 0.4;
    out.push(Number((drift + w).toFixed(1)));
  }
  out[n - 1] = end;
  return out;
}

export const MOCK_MARKET_FUNDS: { asOf: string; series: MockFundSeries[] } = {
  asOf: '08/03',
  series: [
    { label: '고객예탁금', values: synthLevel(47.2, 54.8, 0.9, 1.7) },
    { label: '신용융자', values: synthLevel(18.4, 20.3, 0.25, 4.9) },
    { label: 'CMA', values: synthLevel(84.6, 88.1, 0.5, 8.2) },
  ],
};

export const MOCK_OPTION_SENTIMENT = {
  pcVolumeRatio: 0.87,
  pcOiRatio: 1.12,
  maxPain: 425.0,
  atmIv: 14.2,
};

export const MOCK_AS_OF = '14:21:32';
