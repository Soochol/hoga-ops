import { apiCall } from './client';
import type { WireDataWarning } from './dataWarnings';

// --- condition params (one per catalog type; type keys MUST match backend) ---
export interface TradeValueParams { min_eok: number }
export interface BreakoutParams { lookback: number; period: number }
export interface PeriodParams { period: number }
export interface TradeValuePeriodParams { lookback: number; min_eok: number }
export type ChangePctOp = 'gte' | 'lte' | 'between';
export interface ChangePctParams { op: ChangePctOp; pct?: number; lo?: number; hi?: number }
export interface PriceRangeParams { min?: number; max?: number }
// 최근 period일 고가 peak 대비 현재 고가 위치. within=고점 −pct% 이내 / outside=이외.
export type HighOffPeakSide = 'within' | 'outside';
export interface HighOffPeakParams { period: number; pct: number; side: HighOffPeakSide }
export type MaRelation = 'above' | 'below';
export type MaSource = 'open' | 'high' | 'low' | 'close';
export interface MaParams { period: number; relation: MaRelation; source?: MaSource }
// 매도/매수 총잔량 분봉 peak 신고: 당일 peak ≥ (threshold_pct/100) × 지난 N일 peak.
export interface DepthPeakParams { lookback: number; threshold_pct: number }
// 기간내 매도/매수 총잔량 peak: 최근 lookback 거래일 중 **어느 하루 d 라도**
// peak(d) ≥ (threshold_pct/100) × max(peak, d 직전 period 거래일).
// ⚠ `lookback` 의 의미가 DepthPeakParams 와 **뒤집혀 있다** — 저쪽은 비교 기준 창,
// 여기서는 BreakoutParams 규약대로 "기간내" 의 그 기간이고 비교 창은 `period` 다.
export interface DepthPeakPeriodParams { lookback: number; period: number; threshold_pct: number }
// 매도/매수 총잔량 기준시각 돌파(당일 전용): start_hhmm 이후 최댓값 ≥ (threshold_pct/100)
// × 개장~start_hhmm 최댓값. start_hhmm 은 HHMM(예: 1200 = 12:00), 0900~1520 KST.
// 100 은 동률 포함("renews or revisits") — 엄밀히 더 큰 것만 원하면 101 이상.
export interface DepthRenewalParams { start_hhmm: number; threshold_pct: number }

export type ConditionLeaf =
  | { id: string; type: 'trade_value'; params: TradeValueParams }
  | { id: string; type: 'trade_value_period'; params: TradeValuePeriodParams }
  | { id: string; type: 'new_high_today'; params: PeriodParams }
  | { id: string; type: 'new_high'; params: BreakoutParams }
  | { id: string; type: 'new_high_vol_today'; params: PeriodParams }
  | { id: string; type: 'new_high_vol'; params: BreakoutParams }
  | { id: string; type: 'high_off_peak'; params: HighOffPeakParams }
  | { id: string; type: 'change_pct'; params: ChangePctParams }
  | { id: string; type: 'price_range'; params: PriceRangeParams }
  | { id: string; type: 'ma'; params: MaParams }
  | { id: string; type: 'ask_depth_new_high'; params: DepthPeakParams }
  | { id: string; type: 'bid_depth_new_high'; params: DepthPeakParams }
  | { id: string; type: 'ask_depth_new_high_period'; params: DepthPeakPeriodParams }
  | { id: string; type: 'bid_depth_new_high_period'; params: DepthPeakPeriodParams }
  | { id: string; type: 'ask_depth_renewal'; params: DepthRenewalParams }
  | { id: string; type: 'bid_depth_renewal'; params: DepthRenewalParams };
export type ConditionType = ConditionLeaf['type'];

export type ScreenerScope = 'watchlist' | 'heatmap';

export interface ScreenerUniverse {
  markets?: ('KOSPI' | 'KOSDAQ')[];
  exclude_etf?: boolean;
  exclude_halted?: boolean;
  // 조회 대상을 캡처 집합으로 좁힌다(빈/미지정 = 전체 시장). 체크된 스코프의 합집합.
  scopes?: ScreenerScope[];
}

export type ScanBasis = 'eod' | 'intraday';

export interface ScanRequest {
  conditions: ConditionLeaf[];
  universe: ScreenerUniverse;
  limit?: number;
  basis?: ScanBasis;
}

export interface ScreenerRow {
  code: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  price: number;
  trade_value_won: number;
  change_pct: number | null;
}

export interface DepthCoverageCode {
  code: string;
  name: string;
  have_days: number;
  need_days: number;
}
export interface DepthCoverage {
  lookback: number;
  evaluated: number;
  excluded: DepthCoverageCode[];
  partial: DepthCoverageCode[];
}
export interface DepthPeakValue {
  ask_today: number | null;
  ask_past_peak: number | null;
  ask_have_days: number;
  ask_need_days: number;
  bid_today: number | null;
  bid_past_peak: number | null;
  bid_have_days: number;
  bid_need_days: number;
  // 기준시각 돌파 조건 전용. peak 조건의 ask_today/ask_past_peak 과 의미가 달라
  // 필드를 나눴다 — 그쪽 배지 문구는 "지난 N일 peak" 이다. 조건이 없으면 없다
  // (구버전 저장 상태에도 없으므로 옵셔널). 기준시각도 side 별 — 매도 12:00 ·
  // 매수 13:00 처럼 섞어 쓸 수 있어 한 벌만 두면 한쪽 배지가 남의 시각을 단다.
  ask_pre_max?: number | null;
  ask_post_max?: number | null;
  ask_renewal_start_hhmm?: number | null;
  bid_pre_max?: number | null;
  bid_post_max?: number | null;
  bid_renewal_start_hhmm?: number | null;
}

export interface ScreenerResponse {
  status: 'ok' | 'not_seeded' | 'building';
  rows: ScreenerRow[];
  /** 상태 태그의 평평한 목록 — 장중·depth·ETF 가 한 평면이라 접두가 네임스페이스다. */
  warnings: string[];
  /** 장중 오버레이 실패의 **구조화된 사유**(ADR-0143). 접두 없이 `kind` 를 동반한다. */
  intraday_failure?: WireDataWarning | null;
  // 총잔량 신고 조건이 있을 때만 채워진다(없으면 null — 기존 응답과 하위호환).
  depth_coverage?: DepthCoverage | null;
  depth_values?: Record<string, DepthPeakValue> | null;
}

/** 진행 중인 갱신 job — WS 이벤트가 없어도(재진입/재연결) 서버가 복원해 준다. */
export interface ScreenerUpdating {
  done: number;
  total: number;
  started_ms: number;
}

export interface ScreenerStatus {
  status: string;
  last_raw_date?: string;
  universe_size?: number;
  days_behind?: number | null;
  updating?: ScreenerUpdating | null;
}

/** 손 미러 — 정본은 `hoga/api/models.py::ScreenerUpdateSkipReason` 이다.
 *  값이 갈리면 ADR-0004 2층 대조가 실패한다
 *  (`tests/unit/api/test_rest_wire_schema_contract.py`). 값을 늘리면
 *  `SKIP_REASON_MESSAGES` 도 같은 PR 에서 — 그쪽은 Record 라 TS 가 강제한다. */
export type ScreenerUpdateSkipReason =
  | 'no_gap'
  | 'not_seeded'
  | 'creds_missing'
  | 'calendar_source_missing'
  | 'calendar_coverage_behind';

export type ScreenerUpdateResponse =
  | { running: true; done: number; total: number }
  | { running: false; updated: 0; reason: ScreenerUpdateSkipReason };

export function runScan(body: ScanRequest): Promise<ScreenerResponse> {
  return apiCall<ScreenerResponse>('/api/screener/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const getScreenerStatus = () => apiCall<ScreenerStatus>('/api/screener/status');
export const triggerScreenerUpdate = () =>
  apiCall<ScreenerUpdateResponse>('/api/screener/update', { method: 'POST' });

// --- 봉 패턴 검색 (ADR-0166) ---------------------------------------------
// 손 미러 — 정본은 `hoga/api/models.py` 의 Pattern* 모델이다. 값·필드가 갈리면
// ADR-0004 1·2층이 실패한다(`tests/unit/api/test_rest_wire_schema_contract.py`).

/** 손 미러 — 정본은 `hoga/api/models.py::PatternSearchMode`. */
export type PatternSearchMode = 'now' | 'history';

/** 손 미러 — 정본은 `hoga/api/models.py::PatternMaPreset`.
 *  이름이 「무엇을 찾는지」를 말한다: `short` 는 단기 배열 속의 캔들(5·20),
 *  `mid` 는 중기 추세 속의 캔들(20·60). 자유 조합은 열지 않는다(ADR-0166 결정 11). */
export type PatternMaPreset = 'off' | 'short' | 'mid';

/** 손 미러 — 정본은 `hoga/api/models.py::PatternTimeframe`.
 *
 *  `'W'` 코퍼스는 일봉에서 **파생**한다(종목 주봉을 주는 벤더 경로가 없다).
 *  ⚠ **부재는 `'D'`** 다 — 저장된 검색에 이 값이 없으면 일봉으로 읽어야 기존 저장이 산다. */
export type PatternTimeframe = 'D' | 'W' | 'M';

/** 손 미러 — 정본은 `hoga/api/models.py::PatternEmptyReason`.
 *
 *  결과가 **왜 비었는가**. `results` 가 빈 응답에만 실린다.
 *
 *  이 값이 없던 시절 화면은 빈 응답 하나를 「그은 구간에 해당하는 일봉이 없다」로
 *  번역했는데, 서버가 그 문장으로 답하는 경로는 **넷**이라 서로 다른 실패가 한 문장에
 *  뭉쳤다(조사 2026-09-04). 넷 중 조건으로 풀리는 것은 `no_candidates` 하나뿐이다.
 *
 *  * `code_missing` — 코퍼스에 그 종목이 없다. **패널의 어떤 조작도 못 고친다.**
 *  * `window` — 그 구간/길이에 코퍼스 봉이 모자라거나 너무 많다.
 *    `coverage_from`/`coverage_to` 가 「그럼 어디를 그으면 되나」에 답한다.
 *  * `flat` — 창이 평탄하거나 이평 워밍업이 안 찼다(서버에서 둘은 구별되지 않는다).
 *  * `no_candidates` — 비교할 후보 창이 안 남았다. **기간을 넓히면 풀린다.** */
export type PatternEmptyReason = 'code_missing' | 'window' | 'flat' | 'no_candidates';

export interface PatternSearchRequest {
  code: string;
  mode: PatternSearchMode;
  /** 비교할 봉수들. `history` 는 첫 값만 쓴다. */
  lengths: number[];
  /** 구간 지정(둘 다 주거나 둘 다 비운다). 비우면 최신 L봉. */
  from?: string;
  to?: string;
  top?: number;
  min_tv_eok?: number;
  exclude_etf?: boolean;
  no_overlap?: boolean;
  forward_days?: number;
  /** `history` 전용 — 한 종목에서 남길 매치 수(1~5). 1 은 다양성, 늘리면 "그 패턴이
   *  나온 자리를 전부" 본다. 두 번째부터는 겹침 배제가 걸린다. */
  per_code?: number;
  /** 길이 유연 검색의 폭(±봉). 0 이면 끈다 — 쿼리를 시간축으로 리샘플해 길이마다
   *  같은 커널을 돌린다(DTW 대체). **균일 신축만** 잡는다. */
  flex_bars?: number;
  /** `history` 전용 — 이 날짜(YYYYMMDD) 이후에 시작하는 창만. **기간만 서버로 온다** —
   *  유사도 하한·결과 수는 프론트가 받아 둔 목록을 자른다. */
  since?: string;
  /** 봉 단위. 코퍼스가 이 값으로 갈린다(주봉은 일봉에서 파생).
   *
   *  ⚠ **길이·기간·수익률 지평은 전부 「봉」을 센다** — 같은 `forward_days: 20` 이
   *  일봉에서 20일, 주봉에서 **20주**다. */
  timeframe?: PatternTimeframe;
  /** 거래량 축의 비중(0~1). 0 이면 가격만. 유사도가
   *  `가격 상관 × (1-w) + 거래량 상관 × w` 가 되고 **w 는 화면의 스위치**다. */
  volume_weight?: number;
  /** 이평선을 매칭 축에 넣을지. 생략하면 `off`. */
  ma_preset?: PatternMaPreset;
  /** 구조 게이트 — 쿼리 창의 «봉별 색·전고·전저 관계» 부호열과 **몇 개까지 달라도**
   *  후보로 남길지. `null`/생략이면 끈다(서명 계산 자체를 안 한다). 게이트이지 점수가
   *  아니다 — 통과한 창의 순서는 상관이고 `dist`·`baseline` 은 통과 **전** 모집단이다
   *  (ADR-0166 결정 12). */
  struct_tolerance?: number | null;
}

/** 후보 점수 분포. **유사도 절대값을 단독으로 그리지 않기 위한 동반 데이터**다 —
 *  0.986 은 "98.6% 닮음" 이 아니라 "비교한 것 중 최고" 라, 화면은 이 분위수 위
 *  어디인지로 읽혀야 한다(ADR-0166 결정 7). */
export interface PatternDistribution {
  p50: number;
  p95: number;
  p99: number;
  /** `history` 에서만 값이 있다(후보창이 수백만이라 이 분위수가 대조군이 된다). */
  p99_99: number | null;
  sample: number;
}

/** 전 후보창의 이후 수익률. **끌 수 있는 표시로 만들지 말 것** — 매치 승률만 보이면
 *  반드시 신호로 오독되는데, 실측상 둘의 차이는 쿼리마다 부호가 뒤집힌다. */
export interface PatternBaseline {
  fwd_median_pct: number;
  fwd_win_rate_pct: number;
  sample: number;
}

export interface PatternMatchRow {
  code: string;
  name: string;
  from_date: string;
  to_date: string;
  corr: number;
  /** `[open, high, low, close]` × length. 썸네일 캔들용 원가격. */
  bars: number[][];
  /** `history` 전용 — 매치 **뒤** `forward_days` 봉의 종가. 계열 끝이면 짧거나 빈다. */
  tail: number[] | null;
  /** `history` 전용 — 계열을 넘으면 null(「이후를 모른다」이지 0 이 아니다). */
  forward_pct: number | null;
  /** 이평 프리셋이 켜졌을 때만 — 기간별 **원가격** 이평값. 바깥 배열이
   *  `PatternLengthResult.ma_periods` 와 같은 순서다. */
  ma: number[][] | null;
  /** 구조 게이트가 켜졌을 때만 — 이 창이 쿼리 부호열과 맞춘 관계 수. 분모는
   *  `PatternLengthResult.struct_total`. 꺼져 있으면 null. */
  struct_match: number | null;
}

export interface PatternQueryWindow {
  length: number;
  from_date: string;
  to_date: string;
  bars: number[][];
  /** 매치 행과 같은 규칙 — `ma_periods` 순서의 원가격 이평값. */
  ma: number[][] | null;
}

export interface PatternLengthResult {
  length: number;
  query: PatternQueryWindow;
  /** 이 결과에 실린 이평 기간들. 비어 있으면 이평을 안 썼다. */
  ma_periods: number[];
  universe: number;
  dist: PatternDistribution;
  matches: PatternMatchRow[];
  /** `now` 에서는 null — 최신 창이라 「이후」가 미래다. */
  baseline: PatternBaseline | null;
  /** 마지막 봉이 **미완성**이면 그 봉이 담은 거래일 수, 아니면 null.
   *
   *  주봉에서 수요일이면 마지막 봉은 3일치다. 화면이 그 봉을 그리므로 검색도 담지만
   *  **모든 매치의 마지막 봉이 같은 방식으로 왜곡**되므로 화면이 그 사실을 말해야 한다
   *  (실측: 포함/제외로 `now` top20 이 10~16/20 만 겹친다). `now` · 주봉에서만 값이 있다. */
  partial_last_bucket_days: number | null;
  /** 구조 게이트가 켜졌을 때만 — 판정에 들어간 관계 수(쿼리에서 부호가 0 인 관계는 뺀
   *  값이라 길이만으로 정해지지 않는다). 꺼져 있으면 null. */
  struct_total: number | null;
  /** 구조 게이트가 켜졌을 때만 — 인덱스 k 에 「k 개 맞춘 후보창 수」. 게이트를 걸기
   *  **전** 모집단이라 팝오버가 「이 단계를 고르면 몇 개 남나」를 재검색 없이 센다.
   *  길이 `struct_total + 1`. */
  struct_hist: number[] | null;
  elapsed_ms: number;
}

export interface PatternSearchResponse {
  code: string;
  name: string;
  mode: PatternSearchMode;
  /** 이 결과의 봉 단위. 요청이 말한 값이지만 응답도 싣는다 — 결과 행을 눌렀을 때
   *  착지할 창의 timeframe 이고, 저장에도 그대로 담긴다. */
  timeframe: PatternTimeframe;
  results: PatternLengthResult[];
  /** `results` 가 비었을 때 **왜** 비었는가. 결과가 있으면 `null`. */
  empty_reason: PatternEmptyReason | null;
  /** 이 종목이 코퍼스에서 **검색 가능한 구간**(YYYYMMDD). 결과 유무와 무관하게 실린다.
   *
   *  ⚠ 차트가 읽는 벤더 일봉과 코퍼스의 **종목별 커버리지가 다르다** — 차트에 캔들이
   *  보인다는 것이 「검색된다」의 근거가 못 된다. `null` 이면 그 종목이 코퍼스에 없다. */
  coverage_from: string | null;
  coverage_to: string | null;
}

export function searchPattern(body: PatternSearchRequest): Promise<PatternSearchResponse> {
  return apiCall<PatternSearchResponse>('/api/screener/pattern-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- 패턴 검색 저장 (ADR-0166) -------------------------------------------

/** 손 미러 — 정본은 `hoga/api/models.py::PatternSaveKind`.
 *  **불러오기의 갈림길**이다: `recent` 는 불러올 때마다 오늘 기준으로 다시 찾고,
 *  `fixed` 는 그 날의 구간으로 간다. */
export type PatternSaveKind = 'recent' | 'fixed';

export interface PatternSaveWindow {
  kind: PatternSaveKind;
  /** `recent` 전용. */
  bars: number | null;
  /** `fixed` 전용. */
  from_date: string | null;
  to_date: string | null;
}

export interface PatternSaveConditions {
  mode: PatternSearchMode;
  since: string | null;
  count: number;
  /** 유사도 하한 — 프론트가 받아 둔 목록을 자르는 값(검색 요청에는 안 실린다). */
  sim_floor: number;
  min_tv_eok: number;
  exclude_etf: boolean;
  no_overlap: boolean;
  per_code: number;
  volume_weight: number;
  /** 이평 프리셋 — 유사도 자체를 바꾸므로 빠지면 다른 검색이 복원된다.
   *
   *  ⚠ `null` 은 **「끄기」가 아니라 「그 축이 없던 시절의 저장」**이다. 화면은 그때
   *  **공장값**을 쓴다 — 부재와 선택은 다른 계약이라(CLAUDE.md), 여기서 `'off'` 로
   *  읽으면 이평 기능 이전의 저장이 전부 이평 꺼진 채로 되살아난다. */
  ma_preset: PatternMaPreset | null;
  /** 길이 유연 폭(±봉). `null` 의 뜻은 위 `ma_preset` 과 같다. */
  flex_bars: number | null;
  /** 봉 단위. `null` 의 뜻은 위 `ma_preset` 과 같다 — **「주봉이 없던 시절의 저장」**
   *  이고 화면은 공장값(일봉)으로 읽는다. */
  timeframe: PatternTimeframe | null;
  /** 구조 게이트 허용 불일치. **`null` 이 「끄기」와 「그 축이 없던 시절의 저장」을
   *  겸한다** — 공장값이 끄기라 오늘은 같은 결과다. ⚠ 공장값을 켜는 쪽으로 바꾸면
   *  `ma_preset` 사고가 재현되니 그때는 부재와 끄기를 분리해야 한다. */
  struct_tolerance: number | null;
}

/** 저장된 검색에서 **빼 둔 한 자리** — 종목이 아니라 「그 종목의 그 기간」이다.
 *
 *  길이는 키에 없다. 유연 검색이면 같은 (종목, 시작일)이 길이별로 여러 행이 되므로
 *  (실측 500행 중 96건), 길이까지 맞춰 빼면 다른 길이가 남아 「지웠는데 또 나온다」가 된다. */
export interface PatternExclusion {
  code: string;
  /** 뺀 자리의 시작일. **`null` 이면 그 종목 전부**다 — 두 뜻을 한 필드에 둬야 복원
   *  목록이 하나로 유지된다(둘로 나누면 「숨김 N」이 무엇의 N 인지 흐려진다). */
  from_date: string | null;
  /** 복원 목록이 이름을 보여주려고 함께 담는다. */
  stock_name: string;
}

export interface PatternSaveWriteRequest {
  name: string;
  code: string;
  /** 목록이 종목별로 묶이고 검색이 이름·종목을 함께 훑으므로 함께 담는다. */
  stock_name: string;
  window: PatternSaveWindow;
  conditions: PatternSaveConditions;
  /** 결과에서 빼 둔 자리들. **`conditions` 밖인 것이 계약이다** — 조건은 「질문」이고
   *  이것은 「답의 편집」이라, 조건 복원이 이걸 조건으로 오해하면 안 된다. */
  excluded: PatternExclusion[];
}

export interface PatternSave extends PatternSaveWriteRequest {
  id: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PatternSavesFile {
  schema_version: number;
  saves: PatternSave[];
}

const PATTERN_SAVES = '/api/screener/pattern-saves';

export const listPatternSaves = () => apiCall<PatternSavesFile>(PATTERN_SAVES);

export const createPatternSave = (body: PatternSaveWriteRequest) =>
  apiCall<PatternSave>(PATTERN_SAVES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const updatePatternSave = (id: string, body: PatternSaveWriteRequest) =>
  apiCall<PatternSave>(`${PATTERN_SAVES}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const deletePatternSave = (id: string) =>
  apiCall<void>(`${PATTERN_SAVES}/${id}`, { method: 'DELETE' });
