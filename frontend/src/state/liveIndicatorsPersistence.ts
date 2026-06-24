import type { MASource } from '../chart/projectors/movingAverage';

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
const VALID_TRADE_VOLUME_POC_BAND_PCTS = new Set([0.005, 0.01]);

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
  /** 매수 최대벽 선 색(hex). 기본 #DC2626(빨강). */
  bidPeakColor: string;
  /** 매수 최대벽 선 두께. 기본 2. */
  bidPeakLineWidth: 1 | 2 | 3 | 4;
  /** 미체결 포함 매수 최대벽 선 색(hex). 기본 #F97316(주황). */
  bidPeakAllPriceColor: string;
  /** 미체결 포함 매수 최대벽 선 두께. 기본 1. */
  bidPeakAllPriceLineWidth: 1 | 2 | 3 | 4;
  /** 당일 최다거래대(체결량 POC) 밴드 on/off. Default TRUE. */
  tradeVolumePocEnabled: boolean;
  /** 당일 최다거래대 자동 밴드 폭. Default +/-0.5%. */
  tradeVolumePocBandPct: number;
  /** 총잔량 pane on/off. Default TRUE(기존 자동표시 보존). */
  quoteTotalsEnabled: boolean;
  /** 호가비 pane on/off. Default TRUE. */
  ratioEnabled: boolean;
  /** 체결강도 pane on/off. Default TRUE. */
  fillStrengthEnabled: boolean;
  /** 일봉 이동평균선 슬롯(현재봉 movingAverages와 별개, ADR-0073). */
  dailyMovingAverages: LiveMAConfig[];
  /** 일봉 MA 마스터 토글. opt-in(기본 false). */
  dailyMovingAverageEnabled: boolean;
  /** 일봉 MA 눈(숨김), config 보존. 기본 false. */
  dailyMovingAverageHidden: boolean;
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
  // daily MA — opt-in(기본 false), 슬롯 검증·cap·기본값 전략 movingAverages와 동일.
  const dEnabled = obj?.dailyMovingAverageEnabled === true;
  const dHidden = obj?.dailyMovingAverageHidden === true;
  const dRaw = obj?.dailyMovingAverages;
  const dKept = Array.isArray(dRaw)
    ? (dRaw.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[])
    : [];
  const dMas = dKept.length > 0 ? dKept : DEFAULT_DAILY_MAS.map((m) => ({ ...m }));
  const build = (
    mas: LiveMAConfig[], enabled: boolean, fNet: boolean, iNet: boolean,
    vol: boolean, hidden: boolean,
    qt: boolean, ratio: boolean, fill: boolean, tradeVolumePoc: boolean,
  ): PersistedIndicators => ({
    movingAverages: mas,
    movingAverageEnabled: enabled,
    foreignNetEnabled: fNet,
    institutionNetEnabled: iNet,
    volumeEnabled: vol,
    movingAverageHidden: hidden,
    askPeakEnabled: apEnabled,
    askPeakColor: apColor,
    askPeakLineWidth: apWidth,
    askPeakAllPriceColor: apAllColor,
    askPeakAllPriceLineWidth: apAllWidth,
    askPeakVisibleMaxColor: apVisibleMaxColor,
    askPeakVisibleMaxLineWidth: apVisibleMaxWidth,
    viLimitPriceLineColor,
    viLimitPriceLineWidth,
    bidPeakEnabled: bpEnabled,
    bidPeakColor: bpColor,
    bidPeakLineWidth: bpWidth,
    bidPeakAllPriceColor: bpAllColor,
    bidPeakAllPriceLineWidth: bpAllWidth,
    tradeVolumePocEnabled: tradeVolumePoc,
    tradeVolumePocBandPct: tvpBandPct,
    quoteTotalsEnabled: qt,
    ratioEnabled: ratio,
    fillStrengthEnabled: fill,
    dailyMovingAverages: dMas,
    dailyMovingAverageEnabled: dEnabled,
    dailyMovingAverageHidden: dHidden,
  });
  if (!raw || typeof raw !== 'object') return build(defaults, true, false, false, true, false, true, true, true, true);
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
  const tradeVolumePoc = o.tradeVolumePocEnabled === false ? false : true;
  const arr = o.movingAverages;
  if (!Array.isArray(arr)) return build(defaults, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, tradeVolumePoc);
  const kept = arr.filter(isValidEntry).slice(0, MA_SLOT_LIMIT) as LiveMAConfig[];
  if (kept.length === 0) return build(defaults, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, tradeVolumePoc);
  return build(kept, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, tradeVolumePoc);
}
