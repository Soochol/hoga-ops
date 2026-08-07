/** `/market` 시장 종합 API 클라이언트 (#1102).
 *
 * 폴링 주기는 **백엔드 TTL 을 두 번 치지 않는 선**으로 잡는다 — 서버가 이미
 * 코얼레스하므로 프론트가 더 자주 물어도 같은 값이 온다(#1099 의 TTL 표):
 *
 *     sectors 30s · program 60s · streaks/breadth 5m · funds 6h · investor-flow 60s
 *
 * 장중이 아니면 폴링을 **60초 하트비트로 늦춘다**(멈추지는 않는다 — `pollWhileOpen`
 * 의 주석 참조: `false` 는 스스로 되살아나지 못한다). 표시 전용 표면은 결손이
 * 생기지 않으므로 마감 후에도 last-good 이 그대로 서빙되고, 장중 수급은 **서버가
 * 무조건 적재**하므로 프론트 폴링 주기가 데이터에 구멍을 내지 않는다.
 */
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';

/** 09:00–15:30 KST 안인가. 폴링 게이트 — 백엔드의 `market_open` 과 같은 창이다. */
export function isMarketHours(now: Date = new Date()): boolean {
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();
  if (day === 0 || day === 6) return false; // 휴장일까지는 못 본다 — 주말만 값싸게 거른다
  const mins = kst.getHours() * 60 + kst.getMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 30;
}

/** 장외 하트비트. **`false` 를 쓰면 안 된다** — 그러면 장이 열려도 못 깨어난다.
 *
 *  TanStack Query 의 함수형 `refetchInterval` 은 **스스로 재평가되지 않는다**:
 *  `false` 를 반환한 순간 타이머가 안 걸리고 → fetch 가 없고 → fetch 완료 훅
 *  (`onQueryUpdate`)이 안 와서 함수가 다시 불릴 일이 없다. 재평가 트리거는
 *  `onSubscribe` · `setOptions`(= 컴포넌트 리렌더) · fetch 완료 셋뿐인데, 이 앱은
 *  전역 `refetchOnWindowFocus`/`refetchOnReconnect` 가 꺼져 있고(`main.tsx`)
 *  수급·프로그램·연속·순위 카드는 게이트 쿼리가 **단독**이라 리렌더를 줄 사람이 없다.
 *  결과: 09:00 이전에 연 탭(전날부터 켜 둔 탭 포함)은 장이 열려도 영원히 멎는다.
 *  2026-08-07 실측 — 장외 마운트 후 시각을 장중으로 돌려도 150초간 fetch 0회.
 *
 *  그래서 장외에도 타이머를 살려 둔다. 백엔드가 TTL 로 코얼레스하므로 유휴 요청은
 *  캐시 응답이고, 09:00 이 지나면 첫 하트비트에서 정상 주기로 자기 전환한다.
 */
const OFF_HOURS_HEARTBEAT_MS = 60_000;

function pollWhileOpen(ms: number): number {
  return isMarketHours() ? ms : OFF_HOURS_HEARTBEAT_MS;
}

// ── 지수 · 등락종목수 · KRX 업종 ──────────────────────────────────────────

export interface MarketIndexRow {
  code: string;
  name: string;
  value: number | null;
  change_pct: number | null;
  /** 등락종목수는 **종합지수에만** 온다(#1100). 지수 상품은 null 이 아니라 부재다. */
  rising: number | null;
  falling: number | null;
  flat: number | null;
  upper: number | null;
  lower: number | null;
  /** 거래대금 **억원** (ka20003 `trde_prica` 는 백만원 — 이름에 단위를 박는다). */
  trade_value_eok: number | null;
  /** 상장 **종목 수** (주식수 아님 — 코스피 943 · 코스닥 1821). 종합 행에만 의미. */
  listed_count: number | null;
}

export interface MarketSectorRow {
  code: string;
  name: string;
  value: number | null;
  change_pct: number | null;
  /** 거래대금 **억원**. 규모별(대형/중형/소형) 쏠림과 업종 분산도가 이 위에 선다. */
  trade_value_eok: number | null;
}

/** VKOSPI(변동성지수). 업종 배열이 아니라 **최상위**로 온다 — 업종이 아니기 때문이다
 *  (섞여 있으면 업종 온도 리스트에 한 줄로 뜨고 업종 분산 계산까지 오염된다).
 *  소스는 KIS 선물이 아니라 키움 ka20003 의 `603` 행이다 — 그 선물(`A04608`)은
 *  당일 거래량 0·미결제 54계약이라 정산가가 굳어 장중 내내 움직이지 않는다. */
export interface MarketVolatility {
  code: string;
  name: string;
  value: number | null;
  change_pct: number | null;
}

export interface MarketSectorsResponse {
  markets: Record<string, { index: MarketIndexRow | null; sectors: MarketSectorRow[] }>;
  volatility: MarketVolatility | null;
}

export function useMarketSectors() {
  return useQuery({
    queryKey: ['market', 'sectors'],
    queryFn: () => apiCall<MarketSectorsResponse>('/api/market/sectors'),
    refetchInterval: () => pollWhileOpen(30_000),
    staleTime: 20_000,
  });
}

// ── 프로그램 매매 ────────────────────────────────────────────────────────

export type ProgramAxis = 'intraday' | 'daily';

export interface ProgramPoint {
  t: string;
  /** 억원 — 벤더는 백만원으로 주고 백엔드가 정규화한다(단위 오표기 3회차의 재발 방지). */
  arb_net_eok: number | null;
  non_arb_net_eok: number | null;
  total_net_eok: number | null;
  kospi200: number | null;
  basis: number | null;
}

export interface ProgramResponse {
  axis: ProgramAxis;
  markets: Record<string, ProgramPoint[]>;
}

export function useMarketProgram(axis: ProgramAxis) {
  return useQuery({
    queryKey: ['market', 'program', axis],
    queryFn: () => apiCall<ProgramResponse>(`/api/market/program?axis=${axis}`),
    // 일별 축은 하루 한 번 바뀌므로 장중 폴링이 무의미하다.
    refetchInterval: () => (axis === 'intraday' ? pollWhileOpen(60_000) : false),
    staleTime: axis === 'intraday' ? 30_000 : 10 * 60_000,
  });
}

// ── 순매수 상위 (주체별 2카드) ───────────────────────────────────────────

export interface StreakRow {
  code: string;
  name: string;
  actor: string;
  /** 항상 양수 — 음수(연속 순매도)는 백엔드가 거른다. */
  streak_days: number;
  /** 억원 (벤더 백만원 → 정규화) */
  streak_net_eok: number | null;
  streak_net_qty_shares: number | null;
  period_change_pct: number | null;
}

/** 한 응답이 두 카드를 채운다 — 백엔드가 ka10131 한 콜로 주체를 갈라 준다(#1096).
 *  ETF·ETN 은 백엔드가 제외하고, 마스터 미로드면 `warnings` 에 실린다. */
export interface StreaksResponse {
  warnings?: string[];
  [actor: string]: StreakRow[] | string[] | undefined;
}

export function useMarketStreaks() {
  return useQuery({
    queryKey: ['market', 'streaks'],
    queryFn: () => apiCall<StreaksResponse>('/api/market/streaks'),
    refetchInterval: () => pollWhileOpen(5 * 60_000),
    staleTime: 4 * 60_000,
  });
}

// ── 시장 폭 ──────────────────────────────────────────────────────────────

/** `truncated` 가 값과 동급이다 — 상한에 닿았으면 count 는 **하한**이다(#1099). */
export interface BreadthCount {
  count: number;
  truncated: boolean;
}

/** 급등·급락은 응답에서 빠졌다 — 그 둘을 쓰던 시장 폭 카드가 업종 수급으로 교체됐다.
 *  되살릴 때는 백엔드 `_BREADTH_QUERIES` 의 ka10019 두 줄부터다. */
export interface BreadthResponse {
  markets: Record<
    string,
    {
      new_high_52w?: BreadthCount;
      new_low_52w?: BreadthCount;
    }
  >;
}

export function useMarketBreadth() {
  return useQuery({
    queryKey: ['market', 'breadth'],
    queryFn: () => apiCall<BreadthResponse>('/api/market/breadth'),
    refetchInterval: () => pollWhileOpen(5 * 60_000),
    staleTime: 4 * 60_000,
  });
}

// ── 업종별 투자자 순매수 ─────────────────────────────────────────────────

export interface SectorFlowRow {
  code: string;
  name: string;
  /** 업종 지수 레벨. `ka10051` 은 ka20003 과 **스케일이 달라**(소수점 제거) 백엔드가
   *  ÷100 해서 준다 — 화면은 그 사실을 몰라도 된다. */
  value: number | null;
  change_pct: number | null;
  /** 억원. `null` 은 "0" 이 아니라 **벤더가 말하지 않았다**는 뜻이다. */
  individual: number | null;
  foreign: number | null;
  institution: number | null;
}

export interface SectorFlowResponse {
  date: string;
  /** `amt_eok` — 단위를 이름이 아니라 필드로 말한다(#1117). */
  unit: string;
  /** 표본 시각. 수집기가 죽으면 카드는 마지막 표본을 계속 그리므로, **언제 것인지**를
   *  화면이 말할 수 있어야 멎은 걸 알아챈다. 표본이 없으면 null. */
  sampled_at_ms: number | null;
  /** 시장 → 업종 행. **종합 행이 맨 앞**이다(화면의 기준선). */
  markets: Record<string, SectorFlowRow[]>;
}

export function useMarketSectorFlow() {
  return useQuery({
    queryKey: ['market', 'sector-flow'],
    queryFn: () => apiCall<SectorFlowResponse>('/api/market/sector-flow'),
    // 수집기가 60초로 찍으므로 그보다 자주 물어도 새 표본이 없다 — investor-flow 와
    // 같은 축이다(같은 TR 의 같은 표본을 읽는다).
    refetchInterval: () => pollWhileOpen(60_000),
    staleTime: 30_000,
  });
}

// ── 증시 주변 자금 (KOFIA) ───────────────────────────────────────────────

export interface FundsRow {
  date: string;
  /** 원(raw). 조 단위 환산은 표시 계층의 몫이다. */
  deposit_won: number | null;
  credit_won: number | null;
  cma_won: number | null;
}

export interface FundsResponse {
  /** `credentials_missing` 이면 이 카드만 빈다 — 나머지 표면은 정상이다. */
  unavailable: string | null;
  /** 기준일은 **응답에서** 온다 — 화면이 "T+2" 를 고정 문구로 박으면 안 된다(#1098). */
  as_of: string | null;
  series: FundsRow[];
}

export function useMarketFunds() {
  return useQuery({
    queryKey: ['market', 'funds'],
    queryFn: () => apiCall<FundsResponse>('/api/market/funds'),
    // 일 1회 공시(T+2)라 폴링하지 않는다. 탭을 다시 열면 staleTime 이 갱신을 부른다.
    refetchInterval: false,
    staleTime: 60 * 60_000,
  });
}

// ── 장중 수급 (적재된 표본) ──────────────────────────────────────────────

export interface InvestorFlowPoint {
  t_ms: number;
  individual: number | null;
  foreign: number | null;
  institution: number | null;
}

export interface InvestorFlowCoverage {
  first_sample_ms: number | null;
  last_sample_ms: number | null;
  sample_count: number;
  expected_count: number | null;
  gap_ranges: { start_ms: number; end_ms: number }[];
}

export interface InvestorFlowDailyRow {
  date: string;
  markets: Record<string, { individual: number | null; foreign: number | null; institution: number | null }>;
}

export interface InvestorFlowResponse {
  date: string;
  /** 확정본이 있는 날만. **비어 있는 것이 정상 시작 상태**다 — 장중 표본과 달리
   *  확정본은 뒤늦게도 채워진다(`base_dt` 랜덤 액세스). */
  daily: InvestorFlowDailyRow[];
  /** `amt_eok` — 단위가 이름에 박혀 있다(#1117 의 단위 뒤바뀜 재발 방지). */
  unit: string;
  /** 확정 파일 존재로 파생된다 — 저장된 플래그가 아니다(#1115). */
  confirmed: boolean;
  coverage: InvestorFlowCoverage;
  markets: Record<string, InvestorFlowPoint[]>;
}

export function useMarketInvestorFlow() {
  return useQuery({
    queryKey: ['market', 'investor-flow'],
    queryFn: () => apiCall<InvestorFlowResponse>('/api/market/investor-flow'),
    // 수집기가 60초로 찍으므로 그보다 자주 물어도 새 표본이 없다.
    refetchInterval: () => pollWhileOpen(60_000),
    staleTime: 30_000,
  });
}
