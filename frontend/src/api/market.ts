/** `/market` 시장 종합 API 클라이언트 (#1102).
 *
 * 폴링 주기는 **백엔드 TTL 을 두 번 치지 않는 선**으로 잡는다 — 서버가 이미
 * 코얼레스하므로 프론트가 더 자주 물어도 같은 값이 온다(#1099 의 TTL 표):
 *
 *     sectors 30s · program 60s · streaks/breadth 5m · funds 6h · investor-flow 60s
 *
 * 장중이 아니면 폴링을 멈춘다(`refetchInterval: false`) — 표시 전용 표면은 결손이
 * 생기지 않으므로 마감 후에도 last-good 이 그대로 서빙된다. 반대로 장중 수급은
 * **서버가 무조건 적재**하므로 프론트 폴링 정지가 데이터에 구멍을 내지 않는다.
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

function pollWhileOpen(ms: number): number | false {
  return isMarketHours() ? ms : false;
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
}

export interface MarketSectorRow {
  code: string;
  name: string;
  value: number | null;
  change_pct: number | null;
}

export interface MarketSectorsResponse {
  markets: Record<string, { index: MarketIndexRow | null; sectors: MarketSectorRow[] }>;
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
  arb_net: number | null;
  non_arb_net: number | null;
  total_net: number | null;
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
  streak_days: number;
  streak_net_amt: number | null;
  streak_net_qty: number | null;
  period_change_pct: number | null;
}

/** 한 응답이 두 카드를 채운다 — 백엔드가 ka10131 한 콜로 주체를 갈라 준다(#1096). */
export type StreaksResponse = Record<string, StreakRow[]>;

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

export interface BreadthResponse {
  markets: Record<
    string,
    {
      new_high_52w?: BreadthCount;
      new_low_52w?: BreadthCount;
      surge?: BreadthCount;
      plunge?: BreadthCount;
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

export interface InvestorFlowResponse {
  date: string;
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
