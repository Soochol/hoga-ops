import type { MASource } from '../chart/projectors/movingAverage';
import { LINE_STYLES, type LineStyle, type PaneId } from '../chart/drawing/types';
import { normalizePaneOrder, normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import {
  normalizePanePrefsByTimeframe,
  type PersistedPanePrefsByTimeframe,
} from '../live/indicators/indicatorPaneProfiles';

/**
 * /live indicator prefs — canonical types, constants, and the persistence
 * validator co-live here.
 *
 * Module placement note: `LiveMAConfig`, `MA_PERIOD_MIN/MAX/SLOT_LIMIT`, and
 * `DEFAULT_LIVE_MAS` are *defined* in this leaf module (not in
 * `state/livePage`) to break a runtime import cycle —
 * `livePage` imports `mergeLiveIndicatorPrefs` here, and the validator
 * needs the constants. `state/livePage` re-exports them, so all public
 * consumers continue to import from `state/livePage` (the spec and plan
 * both name livePage as the public surface). If you find yourself
 * importing constants from this module directly, prefer `state/livePage`
 * — that's the documented public seam.
 */

/** /live의 이동평균선 한 슬롯. 가변 슬롯이므로 array index가 아니라
 *  안정 id로 식별한다 — mid-list 삭제가 다른 슬롯의 series identity를
 *  churn하지 않게 한다. ADR-0046 참조. */
export type LiveMAConfig = {
  id: string;
  enabled: boolean;
  period: number;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  source: MASource;
};

export const MA_PERIOD_MIN = 2;
export const MA_PERIOD_MAX = 400;
export const MA_SLOT_LIMIT = 8;

/** 색상 hex는 tokens.css의 --ma-N과 정확히 일치 (canvas는 CSS var를
 *  직접 받지 못함). --ma-2 (#3B82F6, blue)는 KRX --price-down (#2563EB,
 *  blue)과 색역이 가까워 기본 슬롯에서 의도적으로 스킵. spec §1 참조. */
export const DEFAULT_LIVE_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'ma-1', enabled: true, period: 5,   color: '#EC4899', lineWidth: 1, source: 'close' },
  { id: 'ma-2', enabled: true, period: 20,  color: '#F97316', lineWidth: 1, source: 'close' },
  { id: 'ma-3', enabled: true, period: 60,  color: '#22C55E', lineWidth: 1, source: 'close' },
  { id: 'ma-4', enabled: true, period: 120, color: '#F8FAFC', lineWidth: 1, source: 'close' },
]) as readonly LiveMAConfig[];

/** 일봉 이동평균선 기본 슬롯 — period 20 단일. 색 #EAB308(--ma-7, yellow)은
 *  현재봉 기본 슬롯(EC4899/F97316/22C55E/F8FAFC)과 구분된다(MA_PALETTE와 일치). */
export const DEFAULT_DAILY_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'dma-1', enabled: true, period: 20, color: '#EAB308', lineWidth: 2, source: 'close' },
]) as readonly LiveMAConfig[];

const VALID_LINE_WIDTHS = new Set([1, 2, 3, 4]);
const VALID_SOURCES = new Set(['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const ASK_PEAK_DEFAULT_COLOR = '#1D4ED8';
export const ASK_PEAK_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
export const ASK_PEAK_ALL_PRICE_DEFAULT_COLOR = '#F97316';
export const ASK_PEAK_ALL_PRICE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 1;
export const ASK_PEAK_VISIBLE_MAX_DEFAULT_COLOR = '#EAB308';
export const ASK_PEAK_VISIBLE_MAX_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 3;
export const VI_LIMIT_PRICE_LINE_DEFAULT_COLOR = '#EAB308';
export const VI_LIMIT_PRICE_LINE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 3;
export const BID_PEAK_DEFAULT_COLOR = '#DC2626';
export const BID_PEAK_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
export const BID_PEAK_ALL_PRICE_DEFAULT_COLOR = '#F97316';
export const BID_PEAK_ALL_PRICE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 1;
export const TRADE_VOLUME_POC_DEFAULT_BAND_PCT = 0.005;
export const TRADE_VOLUME_POC_DEFAULT_COLOR = '#A855F7';
export const TRADE_VOLUME_POC_DEFAULT_OPACITY = 0.12;
export const DEPTH_HEATMAP_DEFAULT_BID_COLOR = '#F04452';
export const DEPTH_HEATMAP_DEFAULT_ASK_COLOR = '#3485FA';
export const DEPTH_HEATMAP_DEFAULT_MAX_OPACITY = 0.7;
// 단별 잔량 증감 **차트 오버레이 전용** 색. 히트맵의 빨강·파랑과 다른 색조를 쓰는 이유는
// **레이어 겹침**이다 — 같은 셀 위에 잔량 증감과 호가 히트맵이 동시에 켜질 수 있어 색이
// 충돌하면 판독이 불가능해진다. teal/fuchsia 는 양 테마(#121216 / #FDFCF8) 모두에서 읽히는
// 중간 명도다. 기본 불투명도는 히트맵(0.7)보다 낮게 잡아 두 레이어가 겹칠 때 아래층이 완전히
// 묻히지 않게 한다.
//
// ⚠️ 호가창 증감 뱃지(BookPanel · OrderbookTable)는 2026-07-21부터 이 상수를 쓰지 않는다 —
// 겹치는 레이어가 없어 KRX 컨벤션(증가 빨강 / 감소 파랑, priceDirClass)이 더 직관적이다.
// 두 표면의 색이 다른 것은 의도된 분기다(DESIGN.md 2026-07-21 changelog).
export const DEPTH_DELTA_DEFAULT_IN_COLOR = '#0D9488';
export const DEPTH_DELTA_DEFAULT_OUT_COLOR = '#C026D3';
export const DEPTH_DELTA_DEFAULT_MAX_OPACITY = 0.55;
const VALID_TRADE_VOLUME_POC_BAND_PCTS = new Set([0.0025, 0.005, 0.01]);
export const VOLUME_DISTRIBUTION_DEFAULT_COLOR = '#64748B';
export const VOLUME_DISTRIBUTION_DEFAULT_MAX_COLOR = '#EAB308';
export const VOLUME_DISTRIBUTION_DEFAULT_RANGE_COUNT = 10;
export type BrokerLateEntrySideMode = 'both' | 'buy' | 'sell';
export const BROKER_LATE_ENTRY_DEFAULT_START_HHMM = 930;
export const BROKER_LATE_ENTRY_BUY_DEFAULT_COLOR = '#ef4444';
export const BROKER_LATE_ENTRY_SELL_DEFAULT_COLOR = '#3b82f6';

// 총잔량/호가비 현재값 수평선(price line) — opt-in. 색 기본은 각 pane 라인색과
// 같게 두되 모양을 dashed로 해 실선 데이터 라인과 시각적으로 구분한다(현재가 라인과 동일 컨벤션).
export const QUOTE_TOTALS_BID_LEVEL_DEFAULT_COLOR = '#F04452'; // 매수(빨강)
export const QUOTE_TOTALS_ASK_LEVEL_DEFAULT_COLOR = '#3485FA'; // 매도(파랑)
export const RATIO_LEVEL_DEFAULT_COLOR = '#9A9AA8'; // 중립 회색
export const QUOTE_LEVEL_LINE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 1;
export const QUOTE_LEVEL_LINE_DEFAULT_STYLE: LineStyle = 'dashed';

export type PersistedIndicators = {
  movingAverages: LiveMAConfig[];
  movingAverageEnabled: boolean;
  /** ADR-0055: foreign-investor net-buy bar pane. Opt-in (default false). */
  foreignNetEnabled: boolean;
  /** ADR-0055: institution net-buy bar pane. Opt-in (default false). */
  institutionNetEnabled: boolean;
  /** Pane Legend: volume pane on/off. Default TRUE (kept for legacy stores). */
  volumeEnabled: boolean;
  /** Pane Legend: MA lines temporarily hidden (눈), config preserved. Default FALSE. */
  movingAverageHidden: boolean;
  /** 당일 매도 최대벽 토글. opt-in(기본 false). */
  askPeakEnabled: boolean;
  /** 매도 최대벽 눈(숨김) — 그리기만 끄고 레전드 데이터는 유지. 기본 false. */
  askPeakHidden: boolean;
  /** 매도 최대벽 선 색(hex). 기본 #1D4ED8(파랑). */
  askPeakColor: string;
  /** 매도 최대벽 선 두께. 기본 2. */
  askPeakLineWidth: 1 | 2 | 3 | 4;
  /** 미체결 포함 매도 최대벽 선 색(hex). 기본 #F97316(주황). */
  askPeakAllPriceColor: string;
  /** 미체결 포함 매도 최대벽 선 두께. 기본 1. */
  askPeakAllPriceLineWidth: 1 | 2 | 3 | 4;
  /** 현재 보이는 캔들 영역 안에서 가장 큰 매도 최대벽 강조 색(hex). 기본 #EAB308(노랑). */
  askPeakVisibleMaxColor: string;
  /** 현재 보이는 캔들 영역 안에서 가장 큰 매도 최대벽 강조 두께. 기본 3. */
  askPeakVisibleMaxLineWidth: 1 | 2 | 3 | 4;
  /** VI/상하한가 가격선 색(hex). 기본 #EAB308(보이는 영역 최대벽과 동일). */
  viLimitPriceLineColor: string;
  /** VI/상하한가 가격선 두께. 기본 3(보이는 영역 최대벽과 동일). */
  viLimitPriceLineWidth: 1 | 2 | 3 | 4;
  /** 당일 매수 최대벽 토글. opt-in(기본 false). */
  bidPeakEnabled: boolean;
  /** 매수 최대벽 눈(숨김) — 그리기만 끄고 레전드 데이터는 유지. 기본 false. */
  bidPeakHidden: boolean;
  /** 매수 최대벽 선 색(hex). 기본 #DC2626(빨강). */
  bidPeakColor: string;
  /** 매수 최대벽 선 두께. 기본 2. */
  bidPeakLineWidth: 1 | 2 | 3 | 4;
  /** 미체결 포함 매수 최대벽 선 색(hex). 기본 #F97316(주황). */
  bidPeakAllPriceColor: string;
  /** 미체결 포함 매수 최대벽 선 두께. 기본 1. */
  bidPeakAllPriceLineWidth: 1 | 2 | 3 | 4;
  /** 당일 최대 매물대(체결량 POC) 밴드 on/off. Default TRUE. */
  tradeVolumePocEnabled: boolean;
  /** 최대 매물대 눈(숨김). 기본 false. */
  tradeVolumePocHidden: boolean;
  /** 당일 최대 매물대 자동 밴드 폭. Default +/-0.5%. */
  tradeVolumePocBandPct: number;
  /** 당일 최대 매물대 밴드 색(hex). 기본 #A855F7(보라). */
  tradeVolumePocColor: string;
  /** 당일 최대 매물대 밴드 투명도(0~1). 기본 0.12. */
  tradeVolumePocOpacity: number;
  /** 호가 잔량 히트맵 on/off. Default FALSE. */
  depthHeatmapEnabled: boolean;
  /** 히트맵 눈(숨김). 기본 false. */
  depthHeatmapHidden: boolean;
  /** 호가 잔량 히트맵 매수(bid) 색(hex). 기본 #F04452(빨강). */
  depthHeatmapBidColor: string;
  /** 호가 잔량 히트맵 매도(ask) 색(hex). 기본 #3485FA(파랑). */
  depthHeatmapAskColor: string;
  /** 호가 잔량 히트맵 최대 불투명도(0.2~1). 기본 0.7. */
  depthHeatmapMaxOpacity: number;
  /** 단별 잔량 증감 on/off. Default FALSE. */
  depthDeltaEnabled: boolean;
  /** 증감 눈(숨김). 기본 false. */
  depthDeltaHidden: boolean;
  /** 잔량 유입(증가) 색(hex). 기본 #0D9488(teal). */
  depthDeltaInColor: string;
  /** 잔량 유출(감소) 색(hex). 기본 #C026D3(fuchsia). */
  depthDeltaOutColor: string;
  /** 단별 잔량 증감 최대 불투명도(0.2~1). 기본 0.55. */
  depthDeltaMaxOpacity: number;
  /** 연속체결 매물대 분포 on/off. Default TRUE. */
  volumeDistributionEnabled: boolean;
  /** 연속체결 매물대 분포 hover cutoff mode. Default FALSE. */
  volumeDistributionHoverCutoffEnabled: boolean;
  /** 연속체결 매물대 분포 가격 구간 수(5~30). Default 10. */
  volumeDistributionRangeCount: number;
  /** 연속체결 매물대 분포 기본 막대 색(hex). 기본 #64748B. */
  volumeDistributionColor: string;
  /** 연속체결 매물대 분포 최대 구간 강조 색(hex). 기본 #EAB308. */
  volumeDistributionMaxColor: string;
  /** 총잔량 pane on/off. Default TRUE(기존 자동표시 보존). */
  quoteTotalsEnabled: boolean;
  /** 총잔량 현재값 수평선(매수·매도) 표시. opt-in(기본 false). */
  quoteTotalsLevelLineEnabled: boolean;
  /** 총잔량 매수 현재값 수평선 색(hex). */
  quoteTotalsBidLevelColor: string;
  /** 총잔량 매수 현재값 수평선 두께. */
  quoteTotalsBidLevelWidth: 1 | 2 | 3 | 4;
  /** 총잔량 매수 현재값 수평선 모양(solid/dashed/dotted). */
  quoteTotalsBidLevelStyle: LineStyle;
  /** 총잔량 매도 현재값 수평선 색(hex). */
  quoteTotalsAskLevelColor: string;
  /** 총잔량 매도 현재값 수평선 두께. */
  quoteTotalsAskLevelWidth: 1 | 2 | 3 | 4;
  /** 총잔량 매도 현재값 수평선 모양(solid/dashed/dotted). */
  quoteTotalsAskLevelStyle: LineStyle;
  /** 호가비 pane on/off. Default TRUE. */
  ratioEnabled: boolean;
  /** 호가비 현재값 수평선 표시. opt-in(기본 false). */
  ratioLevelLineEnabled: boolean;
  /** 호가비 현재값 수평선 색(hex). */
  ratioLevelColor: string;
  /** 호가비 현재값 수평선 두께. */
  ratioLevelWidth: 1 | 2 | 3 | 4;
  /** 호가비 현재값 수평선 모양(solid/dashed/dotted). */
  ratioLevelStyle: LineStyle;
  /** 체결강도 pane on/off. Default TRUE. */
  fillStrengthEnabled: boolean;
  /** 프로그램 순매수 pane on/off. Default TRUE. */
  programTradeEnabled: boolean;
  /** 신규 거래원 등장 마커 on/off. opt-in(기본 false). */
  brokerLateEntryEnabled: boolean;
  /** 거래원 등장 마커 눈(숨김). 기본 false. */
  brokerLateEntryHidden: boolean;
  /** 신규 거래원 등장 기준 시각(HHMM). 기본 930. */
  brokerLateEntryStartHHMM: number;
  /** 신규 거래원 등장 표시 방향. 기본 both. */
  brokerLateEntrySideMode: BrokerLateEntrySideMode;
  /** 신규 거래원 등장 매수 마커 색상(hex). 기본 #ef4444. */
  brokerLateEntryBuyColor: string;
  /** 신규 거래원 등장 매도 마커 색상(hex). 기본 #3b82f6. */
  brokerLateEntrySellColor: string;
  /** 일봉 이동평균선 슬롯(현재봉 movingAverages와 별개, ADR-0073). */
  dailyMovingAverages: LiveMAConfig[];
  /** 일봉 MA 마스터 토글. opt-in(기본 false). */
  dailyMovingAverageEnabled: boolean;
  /** 일봉 MA 눈(숨김), config 보존. 기본 false. */
  dailyMovingAverageHidden: boolean;
  /** Shared live/study pane on/off overrides by timeframe profile. Empty = legacy flat fields are fallback. */
  panePrefsByTimeframe: PersistedPanePrefsByTimeframe;
  /** 사용자 소유 차트 pane 순서(안정 PaneId 배열; candle 은 항상 index 0, ADR-0114 §3). */
  paneOrder: PaneId[];
  /** 사용자 소유 Pane 크기 가중치(Pane Stretch) — separator 드래그로 조정한
   *  pane 종류별 상대 높이. 없는 키 = 스펙 기본값. 전역 1세트(타임프레임 공통). */
  paneStretch: PaneStretchMap;
};

function isValidEntry(m: unknown): m is LiveMAConfig {
  if (!m || typeof m !== 'object') return false;
  const e = m as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length > 0
    && typeof e.enabled === 'boolean'
    && typeof e.period === 'number'
    && Number.isFinite(e.period)
    && Number.isInteger(e.period)
    && e.period >= MA_PERIOD_MIN
    && e.period <= MA_PERIOD_MAX
    && typeof e.color === 'string' && HEX_COLOR.test(e.color)
    && typeof e.lineWidth === 'number' && VALID_LINE_WIDTHS.has(e.lineWidth)
    && typeof e.source === 'string' && VALID_SOURCES.has(e.source)
  );
}

function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

function normalizeLineWidth(value: unknown, fallback: 1 | 2 | 3 | 4): 1 | 2 | 3 | 4 {
  return VALID_LINE_WIDTHS.has(value as number) ? (value as 1 | 2 | 3 | 4) : fallback;
}

function normalizeLineStyle(value: unknown, fallback: LineStyle): LineStyle {
  return (LINE_STYLES as readonly string[]).includes(value as string)
    ? (value as LineStyle)
    : fallback;
}

function normalizeVolumeDistributionRangeCount(value: unknown): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return VOLUME_DISTRIBUTION_DEFAULT_RANGE_COUNT;
  return Math.min(30, Math.max(5, n));
}

function normalizeHHMM(value: unknown): number {
  const n = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return BROKER_LATE_ENTRY_DEFAULT_START_HHMM;
  const hh = Math.floor(n / 100);
  const mm = n % 100;
  if (hh < 9 || hh > 15 || mm < 0 || mm > 59 || (hh === 15 && mm > 20)) {
    return BROKER_LATE_ENTRY_DEFAULT_START_HHMM;
  }
  return n;
}

function normalizeBrokerLateEntrySideMode(value: unknown): BrokerLateEntrySideMode {
  return value === 'buy' || value === 'sell' || value === 'both' ? value : 'both';
}

/** Merge persisted state with defaults. If the input is structurally
 *  unrecoverable (missing/non-object/non-array MAs) return defaults.
 *  If a subset of entries is valid, keep those; if none are valid,
 *  fall back to defaults. Cap to MA_SLOT_LIMIT to prevent unbounded
 *  growth from a corrupted store. `movingAverageEnabled` defaults to
 *  true unless the persisted value is the literal boolean false (any
 *  other shape — missing, null, "true" string — falls back to true so
 *  legacy stores written before this field existed keep showing MAs). */
export function mergeLiveIndicatorPrefs(
  raw: PersistedIndicators | undefined | null | unknown,
): PersistedIndicators {
  const defaults = DEFAULT_LIVE_MAS.map((m) => ({ ...m }));
  // Resolve obj once so askPeak fields can be computed before build() for all branches.
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : undefined;
  // askPeak fields — opt-in (default false/ASK_PEAK_DEFAULT_COLOR/ASK_PEAK_DEFAULT_WIDTH).
  const apEnabled = obj?.askPeakEnabled === true;
  const apHidden = obj?.askPeakHidden === true;
  const apColor = typeof obj?.askPeakColor === 'string' && HEX_COLOR.test(obj.askPeakColor as string)
    ? (obj.askPeakColor as string) : ASK_PEAK_DEFAULT_COLOR;
  const apWidth = VALID_LINE_WIDTHS.has(obj?.askPeakLineWidth as number)
    ? (obj!.askPeakLineWidth as 1 | 2 | 3 | 4) : ASK_PEAK_DEFAULT_WIDTH;
  const apAllColor = typeof obj?.askPeakAllPriceColor === 'string' && HEX_COLOR.test(obj.askPeakAllPriceColor as string)
    ? (obj.askPeakAllPriceColor as string) : ASK_PEAK_ALL_PRICE_DEFAULT_COLOR;
  const apAllWidth = VALID_LINE_WIDTHS.has(obj?.askPeakAllPriceLineWidth as number)
    ? (obj!.askPeakAllPriceLineWidth as 1 | 2 | 3 | 4) : ASK_PEAK_ALL_PRICE_DEFAULT_WIDTH;
  const apVisibleMaxColor = typeof obj?.askPeakVisibleMaxColor === 'string'
    && HEX_COLOR.test(obj.askPeakVisibleMaxColor as string)
    ? (obj.askPeakVisibleMaxColor as string) : ASK_PEAK_VISIBLE_MAX_DEFAULT_COLOR;
  const apVisibleMaxWidth = VALID_LINE_WIDTHS.has(obj?.askPeakVisibleMaxLineWidth as number)
    ? (obj!.askPeakVisibleMaxLineWidth as 1 | 2 | 3 | 4) : ASK_PEAK_VISIBLE_MAX_DEFAULT_WIDTH;
  const viLimitPriceLineColor = typeof obj?.viLimitPriceLineColor === 'string'
    && HEX_COLOR.test(obj.viLimitPriceLineColor as string)
    ? (obj.viLimitPriceLineColor as string) : VI_LIMIT_PRICE_LINE_DEFAULT_COLOR;
  const viLimitPriceLineWidth = VALID_LINE_WIDTHS.has(obj?.viLimitPriceLineWidth as number)
    ? (obj!.viLimitPriceLineWidth as 1 | 2 | 3 | 4) : VI_LIMIT_PRICE_LINE_DEFAULT_WIDTH;
  // bidPeak fields — opt-in (default false/BID_PEAK_DEFAULT_COLOR/BID_PEAK_DEFAULT_WIDTH).
  const bpEnabled = obj?.bidPeakEnabled === true;
  const bpHidden = obj?.bidPeakHidden === true;
  const bpColor = typeof obj?.bidPeakColor === 'string' && HEX_COLOR.test(obj.bidPeakColor as string)
    ? (obj.bidPeakColor as string) : BID_PEAK_DEFAULT_COLOR;
  const bpWidth = VALID_LINE_WIDTHS.has(obj?.bidPeakLineWidth as number)
    ? (obj!.bidPeakLineWidth as 1 | 2 | 3 | 4) : BID_PEAK_DEFAULT_WIDTH;
  const bpAllColor = typeof obj?.bidPeakAllPriceColor === 'string' && HEX_COLOR.test(obj.bidPeakAllPriceColor as string)
    ? (obj.bidPeakAllPriceColor as string) : BID_PEAK_ALL_PRICE_DEFAULT_COLOR;
  const bpAllWidth = VALID_LINE_WIDTHS.has(obj?.bidPeakAllPriceLineWidth as number)
    ? (obj!.bidPeakAllPriceLineWidth as 1 | 2 | 3 | 4) : BID_PEAK_ALL_PRICE_DEFAULT_WIDTH;
  const tvpBandPct = VALID_TRADE_VOLUME_POC_BAND_PCTS.has(obj?.tradeVolumePocBandPct as number)
    ? (obj!.tradeVolumePocBandPct as number)
    : TRADE_VOLUME_POC_DEFAULT_BAND_PCT;
  const tvpColor = typeof obj?.tradeVolumePocColor === 'string'
    && HEX_COLOR.test(obj.tradeVolumePocColor as string)
    ? (obj.tradeVolumePocColor as string)
    : TRADE_VOLUME_POC_DEFAULT_COLOR;
  const tvpOpacityRaw = obj?.tradeVolumePocOpacity;
  const tvpOpacity = typeof tvpOpacityRaw === 'number'
    && Number.isFinite(tvpOpacityRaw)
    && tvpOpacityRaw >= 0
    && tvpOpacityRaw <= 1
    ? tvpOpacityRaw
    : TRADE_VOLUME_POC_DEFAULT_OPACITY;
  const tvpHidden = obj?.tradeVolumePocHidden === true;
  const depthHeatmapEnabled = obj?.depthHeatmapEnabled === true;
  const depthHeatmapHidden = obj?.depthHeatmapHidden === true;
  const dhBidColor = typeof obj?.depthHeatmapBidColor === 'string'
    && HEX_COLOR.test(obj.depthHeatmapBidColor as string)
    ? (obj.depthHeatmapBidColor as string)
    : DEPTH_HEATMAP_DEFAULT_BID_COLOR;
  const dhAskColor = typeof obj?.depthHeatmapAskColor === 'string'
    && HEX_COLOR.test(obj.depthHeatmapAskColor as string)
    ? (obj.depthHeatmapAskColor as string)
    : DEPTH_HEATMAP_DEFAULT_ASK_COLOR;
  const dhOpacityRaw = obj?.depthHeatmapMaxOpacity;
  const dhMaxOpacity = typeof dhOpacityRaw === 'number'
    && Number.isFinite(dhOpacityRaw)
    && dhOpacityRaw >= 0.2
    && dhOpacityRaw <= 1
    ? dhOpacityRaw
    : DEPTH_HEATMAP_DEFAULT_MAX_OPACITY;
  const depthDeltaEnabled = obj?.depthDeltaEnabled === true;
  const depthDeltaHidden = obj?.depthDeltaHidden === true;
  const ddInColor = normalizeHexColor(obj?.depthDeltaInColor, DEPTH_DELTA_DEFAULT_IN_COLOR);
  const ddOutColor = normalizeHexColor(obj?.depthDeltaOutColor, DEPTH_DELTA_DEFAULT_OUT_COLOR);
  const ddOpacityRaw = obj?.depthDeltaMaxOpacity;
  const ddMaxOpacity = typeof ddOpacityRaw === 'number'
    && Number.isFinite(ddOpacityRaw)
    && ddOpacityRaw >= 0.2
    && ddOpacityRaw <= 1
    ? ddOpacityRaw
    : DEPTH_DELTA_DEFAULT_MAX_OPACITY;
  const volumeDistributionEnabled = obj?.volumeDistributionEnabled !== false;
  const volumeDistributionHoverCutoffEnabled = obj?.volumeDistributionHoverCutoffEnabled === true;
  const volumeDistributionRangeCount = normalizeVolumeDistributionRangeCount(obj?.volumeDistributionRangeCount);
  const volumeDistributionColor = normalizeHexColor(obj?.volumeDistributionColor, VOLUME_DISTRIBUTION_DEFAULT_COLOR);
  const volumeDistributionMaxColor = normalizeHexColor(
    obj?.volumeDistributionMaxColor,
    VOLUME_DISTRIBUTION_DEFAULT_MAX_COLOR,
  );
  const brokerLateEntryEnabled = obj?.brokerLateEntryEnabled === true;
  const brokerLateEntryHidden = obj?.brokerLateEntryHidden === true;
  const brokerLateEntryStartHHMM = normalizeHHMM(obj?.brokerLateEntryStartHHMM);
  const brokerLateEntrySideMode = normalizeBrokerLateEntrySideMode(obj?.brokerLateEntrySideMode);
  const brokerLateEntryBuyColor = normalizeHexColor(
    obj?.brokerLateEntryBuyColor,
    BROKER_LATE_ENTRY_BUY_DEFAULT_COLOR,
  );
  const brokerLateEntrySellColor = normalizeHexColor(
    obj?.brokerLateEntrySellColor,
    BROKER_LATE_ENTRY_SELL_DEFAULT_COLOR,
  );
  // daily MA — opt-in(기본 false), 슬롯 검증·cap·기본값 전략 movingAverages와 동일.
  const dEnabled = obj?.dailyMovingAverageEnabled === true;
  const dHidden = obj?.dailyMovingAverageHidden === true;
  const dRaw = obj?.dailyMovingAverages;
  const dKept = Array.isArray(dRaw)
    ? (dRaw.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[])
    : [];
  const dMas = dKept.length > 0 ? dKept : DEFAULT_DAILY_MAS.map((m) => ({ ...m }));
  // 총잔량/호가비 현재값 수평선 — opt-in. 색/두께/모양은 저장값 검증 후 기본값 폴백.
  const quoteTotalsLevelLineEnabled = obj?.quoteTotalsLevelLineEnabled === true;
  const qtBidLevelColor = normalizeHexColor(obj?.quoteTotalsBidLevelColor, QUOTE_TOTALS_BID_LEVEL_DEFAULT_COLOR);
  const qtBidLevelWidth = normalizeLineWidth(obj?.quoteTotalsBidLevelWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const qtBidLevelStyle = normalizeLineStyle(obj?.quoteTotalsBidLevelStyle, QUOTE_LEVEL_LINE_DEFAULT_STYLE);
  const qtAskLevelColor = normalizeHexColor(obj?.quoteTotalsAskLevelColor, QUOTE_TOTALS_ASK_LEVEL_DEFAULT_COLOR);
  const qtAskLevelWidth = normalizeLineWidth(obj?.quoteTotalsAskLevelWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const qtAskLevelStyle = normalizeLineStyle(obj?.quoteTotalsAskLevelStyle, QUOTE_LEVEL_LINE_DEFAULT_STYLE);
  const ratioLevelLineEnabled = obj?.ratioLevelLineEnabled === true;
  const ratioLevelColor = normalizeHexColor(obj?.ratioLevelColor, RATIO_LEVEL_DEFAULT_COLOR);
  const ratioLevelWidth = normalizeLineWidth(obj?.ratioLevelWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const ratioLevelStyle = normalizeLineStyle(obj?.ratioLevelStyle, QUOTE_LEVEL_LINE_DEFAULT_STYLE);
  const panePrefsByTimeframe = normalizePanePrefsByTimeframe(obj?.panePrefsByTimeframe);
  const paneOrder = normalizePaneOrder(obj?.paneOrder);
  const paneStretch = normalizePaneStretch(obj?.paneStretch);
  const build = (
    mas: LiveMAConfig[], enabled: boolean, fNet: boolean, iNet: boolean,
    vol: boolean, hidden: boolean,
    qt: boolean, ratio: boolean, fill: boolean, programTrade: boolean, tradeVolumePoc: boolean,
  ): PersistedIndicators => ({
    movingAverages: mas,
    movingAverageEnabled: enabled,
    foreignNetEnabled: fNet,
    institutionNetEnabled: iNet,
    volumeEnabled: vol,
    movingAverageHidden: hidden,
    askPeakEnabled: apEnabled,
    askPeakHidden: apHidden,
    askPeakColor: apColor,
    askPeakLineWidth: apWidth,
    askPeakAllPriceColor: apAllColor,
    askPeakAllPriceLineWidth: apAllWidth,
    askPeakVisibleMaxColor: apVisibleMaxColor,
    askPeakVisibleMaxLineWidth: apVisibleMaxWidth,
    viLimitPriceLineColor,
    viLimitPriceLineWidth,
    bidPeakEnabled: bpEnabled,
    bidPeakHidden: bpHidden,
    bidPeakColor: bpColor,
    bidPeakLineWidth: bpWidth,
    bidPeakAllPriceColor: bpAllColor,
    bidPeakAllPriceLineWidth: bpAllWidth,
    tradeVolumePocEnabled: tradeVolumePoc,
    tradeVolumePocHidden: tvpHidden,
    tradeVolumePocBandPct: tvpBandPct,
    tradeVolumePocColor: tvpColor,
    tradeVolumePocOpacity: tvpOpacity,
    depthHeatmapEnabled,
    depthHeatmapHidden,
    depthHeatmapBidColor: dhBidColor,
    depthHeatmapAskColor: dhAskColor,
    depthHeatmapMaxOpacity: dhMaxOpacity,
    depthDeltaEnabled,
    depthDeltaHidden,
    depthDeltaInColor: ddInColor,
    depthDeltaOutColor: ddOutColor,
    depthDeltaMaxOpacity: ddMaxOpacity,
    volumeDistributionEnabled,
    volumeDistributionHoverCutoffEnabled,
    volumeDistributionRangeCount,
    volumeDistributionColor,
    volumeDistributionMaxColor,
    quoteTotalsEnabled: qt,
    quoteTotalsLevelLineEnabled,
    quoteTotalsBidLevelColor: qtBidLevelColor,
    quoteTotalsBidLevelWidth: qtBidLevelWidth,
    quoteTotalsBidLevelStyle: qtBidLevelStyle,
    quoteTotalsAskLevelColor: qtAskLevelColor,
    quoteTotalsAskLevelWidth: qtAskLevelWidth,
    quoteTotalsAskLevelStyle: qtAskLevelStyle,
    ratioEnabled: ratio,
    ratioLevelLineEnabled,
    ratioLevelColor,
    ratioLevelWidth,
    ratioLevelStyle,
    fillStrengthEnabled: fill,
    programTradeEnabled: programTrade,
    brokerLateEntryEnabled,
    brokerLateEntryHidden,
    brokerLateEntryStartHHMM,
    brokerLateEntrySideMode,
    brokerLateEntryBuyColor,
    brokerLateEntrySellColor,
    dailyMovingAverages: dMas,
    dailyMovingAverageEnabled: dEnabled,
    dailyMovingAverageHidden: dHidden,
    panePrefsByTimeframe,
    paneOrder,
    paneStretch,
  });
  if (!raw || typeof raw !== 'object') return build(defaults, true, false, false, true, false, true, true, true, true, true);
  // obj is guaranteed non-null here (same condition checked above)
  const o = obj!;
  const enabled = o.movingAverageEnabled === false ? false : true;
  // New indicators are opt-in: default false unless explicitly persisted true,
  // so legacy stores (written before these fields existed) stay hidden.
  const fNet = o.foreignNetEnabled === true;
  const iNet = o.institutionNetEnabled === true;
  // volumeEnabled defaults TRUE (mirror movingAverageEnabled); movingAverageHidden
  // defaults FALSE (mirror foreignNetEnabled).
  const vol = o.volumeEnabled === false ? false : true;
  const hidden = o.movingAverageHidden === true;
  // 호가 pane 토글: volumeEnabled와 동일 규약 — false 리터럴만 OFF, 나머지(누락 포함) ON.
  const qt = o.quoteTotalsEnabled === false ? false : true;
  const ratio = o.ratioEnabled === false ? false : true;
  const fill = o.fillStrengthEnabled === false ? false : true;
  const programTrade = o.programTradeEnabled === false ? false : true;
  const tradeVolumePoc = o.tradeVolumePocEnabled === false ? false : true;
  const arr = o.movingAverages;
  if (!Array.isArray(arr)) return build(defaults, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, programTrade, tradeVolumePoc);
  const kept = arr.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[];
  if (kept.length === 0) return build(defaults, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, programTrade, tradeVolumePoc);
  return build(kept, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, programTrade, tradeVolumePoc);
}
