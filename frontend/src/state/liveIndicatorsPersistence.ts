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
 *  현재봉 기본 슬롯(EC4899/F97316/22C55E/F8FAFC)과 구분된다(MA_PALETTE와 일치).
 *
 *  ⚠ 슬롯이 `enabled: false` 인 것은 오타가 아니라 **opt-in 의 표현**이다. 종전에는
 *  마스터 토글(`dailyMovingAverageEnabled`, 기본 false)이 opt-in 을 담당하고 슬롯은
 *  true 였다. 마스터가 슬롯으로 접히면서(ADR — 레전드 칩 = 인스턴스) 유효 게이트가
 *  `slot.enabled` 하나뿐이므로, 여기를 true 로 두면 공장 상태에서 일봉 MA 가 갑자기
 *  그려진다. 현재봉 MA(`DEFAULT_LIVE_MAS`)가 true 인 것과 갈리는 이유가 이것이다 —
 *  그쪽 마스터는 기본 true 였다. */
export const DEFAULT_DAILY_MAS: readonly LiveMAConfig[] = Object.freeze([
  { id: 'dma-1', enabled: false, period: 20, color: '#EAB308', lineWidth: 2, source: 'close' },
]) as readonly LiveMAConfig[];

const VALID_LINE_WIDTHS = new Set([1, 2, 3, 4]);
const VALID_SOURCES = new Set(['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4']);
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export const ASK_PEAK_DEFAULT_COLOR = '#1D4ED8';
export const ASK_PEAK_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
// 전체 최대벽(터치 무관) 선 — 체결된 벽과 같은 색상군의 연한 단계(MAStylePicker 그리드
// 4행)로 방향 의미(매도=파랑/매수=빨강)를 유지하면서 보조선임을 드러낸다. 두께 1 은
// 체결된 벽(2)보다 얇게 — 겹칠 때 체결된 벽이 이긴다.
export const ASK_PEAK_ALL_WALL_DEFAULT_COLOR = '#93C5FD';
export const BID_PEAK_ALL_WALL_DEFAULT_COLOR = '#FCA5A5';
export const PEAK_ALL_WALL_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 1;
// 미도달 벽(당일 극값이 지배하지 못한 벽) 선 — 같은 색상군의 **가장 진한 단계**
// (MAStylePicker 그리드 1행). 명도 사다리: 연한=전체(터치 무관), 중간=체결된 벽,
// 진한=미도달(아직 안 깨진 벽) — 무게 의미와 맞춘다.
export const ASK_PEAK_UNREACHED_DEFAULT_COLOR = '#1E3A8A';
export const BID_PEAK_UNREACHED_DEFAULT_COLOR = '#7F1D1D';
export const PEAK_UNREACHED_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
export const VI_LIMIT_PRICE_LINE_DEFAULT_COLOR = '#EAB308';
export const VI_LIMIT_PRICE_LINE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 3;
export const BID_PEAK_DEFAULT_COLOR = '#DC2626';
export const BID_PEAK_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 2;
export const TRADE_VOLUME_POC_DEFAULT_BAND_PCT = 0.005;
export const TRADE_VOLUME_POC_DEFAULT_COLOR = '#A855F7';
export const TRADE_VOLUME_POC_DEFAULT_OPACITY = 0.12;
export const DEPTH_HEATMAP_DEFAULT_BID_COLOR = '#F04452';
export const DEPTH_HEATMAP_DEFAULT_ASK_COLOR = '#3485FA';
export const DEPTH_HEATMAP_DEFAULT_MAX_OPACITY = 0.7;
const VALID_TRADE_VOLUME_POC_BAND_PCTS = new Set([0.0025, 0.005, 0.01]);
export const VOLUME_DISTRIBUTION_DEFAULT_COLOR = '#64748B';
export const VOLUME_DISTRIBUTION_DEFAULT_MAX_COLOR = '#EAB308';
export const VOLUME_DISTRIBUTION_DEFAULT_RANGE_COUNT = 10;
export type BrokerLateEntrySideMode = 'both' | 'buy' | 'sell';

/**
 * 신규 거래원 등장 **인스턴스 하나**. MA 슬롯(`LiveMAConfig`)과 같은 규약이다 —
 * 배열 index 가 아니라 **안정 id** 로 식별해, 중간 삭제가 다른 인스턴스의 레전드
 * 칩·마커 identity 를 흔들지 않게 한다.
 *
 * 이 지표가 첫 배열 승격 대상인 이유: 기준 시각을 달리한 두 세트(예: 09:30 빨강 +
 * 14:00 보라)가 실사용 시나리오이고, 설정이 전부 이 blob 안에 있어 chartPrefs 와의
 * 2-store 분기가 없다.
 */
export type BrokerLateEntryConfig = {
  id: string;
  /** 인스턴스의 가시성 — MA 슬롯과 같이 **이 하나가 유효 게이트**다. */
  enabled: boolean;
  /** 기준 시각(HHMM). 클라이언트 필터라 바꿔도 재조회가 없다(#1595). */
  startHHMM: number;
  sideMode: BrokerLateEntrySideMode;
  buyColor: string;
  sellColor: string;
};

/** 인스턴스 상한 — MA 와 같은 값을 쓴다(같은 이유: 손상 blob 의 무한 증식 방어이자
 *  레전드 한 줄에 들어가는 현실적 개수). */
export const BROKER_LATE_ENTRY_SLOT_LIMIT = 8;
export const BROKER_LATE_ENTRY_DEFAULT_START_HHMM = 930;
export const BROKER_LATE_ENTRY_BUY_DEFAULT_COLOR = '#ef4444';
export const BROKER_LATE_ENTRY_SELL_DEFAULT_COLOR = '#3b82f6';

/** 공장 인스턴스 — **`enabled: false`**(opt-in). 종전에는 마스터 토글
 *  (`brokerLateEntryEnabled`, 기본 false)이 opt-in 을 담당했는데 그게 슬롯으로
 *  접히면서 유효 게이트가 `enabled` 하나뿐이 됐다(MA 의 `DEFAULT_DAILY_MAS` 와 같은
 *  사연). true 로 두면 공장 상태에서 마커가 갑자기 그려진다. */
export const DEFAULT_BROKER_LATE_ENTRIES: readonly BrokerLateEntryConfig[] = Object.freeze([
  {
    id: 'ble-1',
    enabled: false,
    startHHMM: BROKER_LATE_ENTRY_DEFAULT_START_HHMM,
    sideMode: 'both' as const,
    buyColor: BROKER_LATE_ENTRY_BUY_DEFAULT_COLOR,
    sellColor: BROKER_LATE_ENTRY_SELL_DEFAULT_COLOR,
  },
]) as readonly BrokerLateEntryConfig[];

// 총잔량/호가비 현재값 수평선(price line) — opt-in. 색 기본은 각 pane 라인색과
// 같게 두되 모양을 dashed로 해 실선 데이터 라인과 시각적으로 구분한다(현재가 라인과 동일 컨벤션).
export const QUOTE_TOTALS_BID_LEVEL_DEFAULT_COLOR = '#F04452'; // 매수(빨강)
export const QUOTE_TOTALS_ASK_LEVEL_DEFAULT_COLOR = '#3485FA'; // 매도(파랑)
export const RATIO_LEVEL_DEFAULT_COLOR = '#9A9AA8'; // 중립 회색
export const QUOTE_LEVEL_LINE_DEFAULT_WIDTH: 1 | 2 | 3 | 4 = 1;
export const QUOTE_LEVEL_LINE_DEFAULT_STYLE: LineStyle = 'dashed';
// 총잔량 당일 최고 수평선 — 색·두께는 현재값 수평선과 같은 pane 라인색을 재사용하되 모양만
// dotted 로 갈라 둘을 구분한다(현재값 dashed / 데이터 라인 solid width 3).
export const QUOTE_TOTALS_DAY_MAX_DEFAULT_STYLE: LineStyle = 'dotted';

export type PersistedIndicators = {
  movingAverages: LiveMAConfig[];
  /**
   * @deprecated **레거시 입력 전용** — v2 설정(`IndicatorSettings`)에는 없다.
   *
   * 마스터 토글 4형제(`movingAverage{Enabled,Hidden}` ·
   * `dailyMovingAverage{Enabled,Hidden}`)는 슬롯의 `enabled` 로 접혔다. 레전드 칩이
   * 인스턴스 단위 조작 표면이 되면서 "타입 마스터 × 타입 눈 × 슬롯 enabled" 삼중
   * 상태가 하나로 줄었기 때문이다(`collapseMaMasterFlags`).
   *
   * 이 필드들이 타입에 남아 있는 이유는 **읽어야 하기 때문**이다: v1 blob 파싱과
   * v2 버킷 collapse 의 입력. 새 코드가 이 값을 화면 게이트로 쓰면 안 된다 —
   * 유효 게이트는 `slot.enabled` 하나뿐이다.
   */
  movingAverageEnabled: boolean;
  /** ADR-0055: foreign-investor net-buy bar pane. Opt-in (default false). */
  foreignNetEnabled: boolean;
  /** ADR-0055: institution net-buy bar pane. Opt-in (default false). */
  institutionNetEnabled: boolean;
  /** Pane Legend: volume pane on/off. Default TRUE (kept for legacy stores). */
  volumeEnabled: boolean;
  /** @deprecated 레거시 입력 전용 — `movingAverageEnabled` 주석 참조. */
  movingAverageHidden: boolean;
  /** 최대벽 강도 pane(당일 최대벽의 시간축 계단). opt-in(기본 false). */
  peakWallPaneEnabled: boolean;
  /** 강도 pane 에 「체결된 벽」 계단을 낼 것인가. **기본 true** — 공장 상태에서
   *  pane 을 켜면 종전과 똑같이 체결된 벽만 나온다.
   *
   *  ⚠ 이 셋은 **방향 공용**이다(pane 자체가 매도·매수 공용이므로). 그리고 캔들
   *  오버레이의 계열 선 토글(`{side}Peak{Family}LineEnabled`)과 **독립**이다 —
   *  종전엔 pane 이 그 토글을 따라갔지만, 캔들에서 지운 계열을 pane 에서는 계속
   *  보고 싶은(또는 그 반대의) 조합이 원리적으로 불가능했다. */
  peakWallPaneTradedEnabled: boolean;
  /** 강도 pane 에 「미도달 벽」 계단을. opt-in(기본 false) — 공장 계열 선 토글과 같은 값. */
  peakWallPaneUnreachedEnabled: boolean;
  /** 강도 pane 에 「전체 최대벽」 계단을. opt-in(기본 false) — 공장 계열 선 토글과 같은 값. */
  peakWallPaneAllWallEnabled: boolean;
  /** 당일 매도 최대벽 토글. opt-in(기본 false). */
  askPeakEnabled: boolean;
  /** 매도 최대벽 눈(숨김) — 그리기만 끄고 레전드 데이터는 유지. 기본 false. */
  askPeakHidden: boolean;
  /** 매도 최대벽 선 색(hex). 기본 #1D4ED8(파랑). */
  askPeakColor: string;
  /** 매도 최대벽 선 두께. 기본 2. */
  askPeakLineWidth: 1 | 2 | 3 | 4;
  /** 매도 「체결된 벽」 선 — 세 계열 중 하나로서의 토글. **기본 true** 라
   *  기존 스토어·공장값의 동작이 그대로다(종전엔 마스터가 곧 이 선이었다).
   *  끄면 전체·미도달만 남는다. */
  askPeakTradedLineEnabled: boolean;
  /** 매도 「전체 최대벽(터치 무관)」 선 — 최대벽의 하위 토글. opt-in(기본 false).
   *  ⚠ `askPeakAllPriceRankLimit`(체결된 벽 표시 개수, chartPrefs)와 무관하다. */
  askPeakAllWallLineEnabled: boolean;
  /** 매도 전체 최대벽 선 색(hex). 기본 #93C5FD(연파랑). */
  askPeakAllWallColor: string;
  /** 매도 전체 최대벽 선 두께. 기본 1. */
  askPeakAllWallLineWidth: 1 | 2 | 3 | 4;
  /** 매도 「미도달 벽(당일 고가 위)」 선 — 최대벽의 하위 토글. opt-in(기본 false). */
  askPeakUnreachedLineEnabled: boolean;
  /** 매도 미도달 벽 선 색(hex). 기본 #1E3A8A(진남). */
  askPeakUnreachedColor: string;
  /** 매도 미도달 벽 선 두께. 기본 2. */
  askPeakUnreachedLineWidth: 1 | 2 | 3 | 4;
  /** VI/상하한가 가격선 색(hex). 기본 #EAB308(노랑). */
  viLimitPriceLineColor: string;
  /** VI/상하한가 가격선 두께. 기본 3. */
  viLimitPriceLineWidth: 1 | 2 | 3 | 4;
  /** 당일 매수 최대벽 토글. opt-in(기본 false). */
  bidPeakEnabled: boolean;
  /** 매수 최대벽 눈(숨김) — 그리기만 끄고 레전드 데이터는 유지. 기본 false. */
  bidPeakHidden: boolean;
  /** 매수 최대벽 선 색(hex). 기본 #DC2626(빨강). */
  bidPeakColor: string;
  /** 매수 최대벽 선 두께. 기본 2. */
  bidPeakLineWidth: 1 | 2 | 3 | 4;
  /** 매수 「체결된 벽」 선 — 세 계열 중 하나로서의 토글. **기본 true** 라
   *  기존 스토어·공장값의 동작이 그대로다(종전엔 마스터가 곧 이 선이었다).
   *  끄면 전체·미도달만 남는다. */
  bidPeakTradedLineEnabled: boolean;
  /** 매수 「전체 최대벽(터치 무관)」 선 — ask 쪽 미러. opt-in(기본 false). */
  bidPeakAllWallLineEnabled: boolean;
  /** 매수 전체 최대벽 선 색(hex). 기본 #FCA5A5(연빨강). */
  bidPeakAllWallColor: string;
  /** 매수 전체 최대벽 선 두께. 기본 1. */
  bidPeakAllWallLineWidth: 1 | 2 | 3 | 4;
  /** 매수 「미도달 벽(당일 저가 아래)」 선 — ask 쪽 미러. opt-in(기본 false). */
  bidPeakUnreachedLineEnabled: boolean;
  /** 매수 미도달 벽 선 색(hex). 기본 #7F1D1D(진적). */
  bidPeakUnreachedColor: string;
  /** 매수 미도달 벽 선 두께. 기본 2. */
  bidPeakUnreachedLineWidth: 1 | 2 | 3 | 4;
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
  /** 총잔량 **당일 최고**값 수평선(매수·매도) 표시. opt-in(기본 false). 현재값 수평선과
   *  독립 토글 — 둘 다 켜면 신고가 순간에만 겹친다. */
  quoteTotalsDayMaxLineEnabled: boolean;
  /** 총잔량 매수 당일 최고 수평선 색(hex). */
  quoteTotalsDayMaxBidColor: string;
  /** 총잔량 매수 당일 최고 수평선 두께. */
  quoteTotalsDayMaxBidWidth: 1 | 2 | 3 | 4;
  /** 총잔량 매수 당일 최고 수평선 모양(solid/dashed/dotted). */
  quoteTotalsDayMaxBidStyle: LineStyle;
  /** 총잔량 매도 당일 최고 수평선 색(hex). */
  quoteTotalsDayMaxAskColor: string;
  /** 총잔량 매도 당일 최고 수평선 두께. */
  quoteTotalsDayMaxAskWidth: 1 | 2 | 3 | 4;
  /** 총잔량 매도 당일 최고 수평선 모양(solid/dashed/dotted). */
  quoteTotalsDayMaxAskStyle: LineStyle;
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
  /**
   * 신규 거래원 등장 **인스턴스 배열**. 같은 지표를 기준 시각만 달리해 여러 개
   * 띄울 수 있다(Phase 3 의 첫 대상 — 타입 도크스트링 참조).
   *
   * MA 와 같은 sparse 규약: 빈 배열은 "전부 지웠다" 는 **유효 상태**이고, 손상만
   * 공장값으로 복구한다(`normalizeSlotArray`).
   */
  brokerLateEntries: BrokerLateEntryConfig[];
  /**
   * @deprecated **레거시 입력 전용** — v2 설정에는 없다(`collapseBrokerLateEntry`).
   *
   * flat 6필드가 인스턴스 배열로 접혔다. MA 마스터 4형제와 같은 사연이고, 같은
   * 이유로 타입에는 남는다: v1 blob 파싱과 v2 버킷 collapse 의 **입력**이기 때문.
   * 새 코드가 이 값을 화면 게이트로 쓰면 안 된다.
   */
  brokerLateEntryEnabled: boolean;
  /** @deprecated 레거시 입력 전용 — `brokerLateEntryEnabled` 주석 참조. */
  brokerLateEntryHidden: boolean;
  /** @deprecated 레거시 입력 전용 — `brokerLateEntryEnabled` 주석 참조. */
  brokerLateEntryStartHHMM: number;
  /** @deprecated 레거시 입력 전용 — `brokerLateEntryEnabled` 주석 참조. */
  brokerLateEntrySideMode: BrokerLateEntrySideMode;
  /** @deprecated 레거시 입력 전용 — `brokerLateEntryEnabled` 주석 참조. */
  brokerLateEntryBuyColor: string;
  /** @deprecated 레거시 입력 전용 — `brokerLateEntryEnabled` 주석 참조. */
  brokerLateEntrySellColor: string;
  /** 일봉 이동평균선 슬롯(현재봉 movingAverages와 별개, ADR-0073). */
  dailyMovingAverages: LiveMAConfig[];
  /** @deprecated 레거시 입력 전용 — `movingAverageEnabled` 주석 참조. */
  dailyMovingAverageEnabled: boolean;
  /** @deprecated 레거시 입력 전용 — `movingAverageEnabled` 주석 참조. */
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

/**
 * 저장된 MA 슬롯 배열의 정규화 — **빈 배열과 손상을 다르게 대우한다**.
 *
 * `[]` 는 "사용자가 슬롯을 전부 지웠다" 는 **유효 상태**다. 레전드 칩 ✕ 로 하나씩
 * 지우면 도달하므로, 여기서 공장값을 되살리면 삭제가 다음 로드마다 취소되고 증상은
 * "지웠는데 새로고침하면 돌아온다" 로 한참 뒤에 나타난다.
 *
 * 반대로 **원소는 있는데 전부 무효**이거나 애초에 배열이 아니면 손상된 blob 이므로
 * 공장값으로 복구한다. 두 경우를 구별하지 않으면 손상이 조용히 "지표 실종" 으로
 * 위장한다 — 그래서 판별식은 `kept.length` 가 아니라 **`raw.length`** 다.
 */
function normalizeSlotArray<T>(
  raw: unknown,
  factory: readonly T[],
  isValid: (v: unknown) => v is T,
  limit: number,
): T[] {
  if (!Array.isArray(raw)) return factory.map((m) => ({ ...m }));
  if (raw.length === 0) return [];
  const kept = raw.filter(isValid).slice(0, limit);
  return kept.length > 0 ? kept : factory.map((m) => ({ ...m }));
}

function normalizeMaSlots(raw: unknown, factory: readonly LiveMAConfig[]): LiveMAConfig[] {
  return normalizeSlotArray(raw, factory, isValidEntry, MA_SLOT_LIMIT);
}

/** 거래원 등장 인스턴스 하나의 검증기 — MA 의 `isValidEntry` 와 같은 역할. */
function isValidBrokerLateEntry(v: unknown): v is BrokerLateEntryConfig {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' && e.id.length > 0
    && typeof e.enabled === 'boolean'
    // 기준 시각은 정규장 창 안이어야 한다 — 밖이면 마커가 통째로 비거나 전부 뜬다.
    && typeof e.startHHMM === 'number' && normalizeHHMM(e.startHHMM) === e.startHHMM
    && (e.sideMode === 'both' || e.sideMode === 'buy' || e.sideMode === 'sell')
    && typeof e.buyColor === 'string' && HEX_COLOR.test(e.buyColor)
    && typeof e.sellColor === 'string' && HEX_COLOR.test(e.sellColor)
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
 *  unrecoverable (missing/non-object) return defaults.
 *
 *  MA 슬롯 배열의 정책은 `normalizeMaSlots` 가 소유한다 — **빈 배열은 유효 상태(0개)**
 *  이고 "전부 무효" 만 공장값으로 복구한다. 이 파일의 종전 정책("if none are valid,
 *  fall back to defaults")은 그 둘을 합쳐 놨었고, 그래서 사용자가 지운 슬롯이 로드마다
 *  되살아났다. Cap to MA_SLOT_LIMIT to prevent unbounded growth from a corrupted store.
 *
 *  `movingAverageEnabled` defaults to true unless the persisted value is the literal
 *  boolean false (any other shape — missing, null, "true" string — falls back to true so
 *  legacy stores written before this field existed keep showing MAs). 이 마스터 4필드는
 *  **읽기 전용 레거시**다(타입 주석 참조) — v1 blob 파싱과 v2 collapse 의 입력으로만 산다. */
export function mergeLiveIndicatorPrefs(
  raw: PersistedIndicators | undefined | null | unknown,
): PersistedIndicators {
  const defaults = DEFAULT_LIVE_MAS.map((m) => ({ ...m }));
  // Resolve obj once so askPeak fields can be computed before build() for all branches.
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : undefined;
  // askPeak fields — opt-in (default false/ASK_PEAK_DEFAULT_COLOR/ASK_PEAK_DEFAULT_WIDTH).
  // 최대벽 강도 pane — opt-in (default false). 오버레이(askPeak/bidPeak)와 별개 토글:
  // pane 은 오버레이의 표현이지만 화면 부동산을 차지하므로 켜는 결정은 따로 받는다.
  const pwPaneEnabled = obj?.peakWallPaneEnabled === true;
  // pane 계열 셋 — 체결된 벽만 기본 true 라, 공장 상태에서 pane 을 켜면 종전과 같은
  // 화면이 나온다(종전 규칙은 "캔들 선 토글을 따라간다" 였고 그 공장값이 T/F/F 였다).
  const pwPaneTraded = obj?.peakWallPaneTradedEnabled !== false;
  const pwPaneUnreached = obj?.peakWallPaneUnreachedEnabled === true;
  const pwPaneAllWall = obj?.peakWallPaneAllWallEnabled === true;
  const apEnabled = obj?.askPeakEnabled === true;
  const apHidden = obj?.askPeakHidden === true;
  const apColor = typeof obj?.askPeakColor === 'string' && HEX_COLOR.test(obj.askPeakColor as string)
    ? (obj.askPeakColor as string) : ASK_PEAK_DEFAULT_COLOR;
  const apWidth = VALID_LINE_WIDTHS.has(obj?.askPeakLineWidth as number)
    ? (obj!.askPeakLineWidth as 1 | 2 | 3 | 4) : ASK_PEAK_DEFAULT_WIDTH;
  // 전체 최대벽(터치 무관) 하위 선 — opt-in, 색·두께는 검증 후 기본값 폴백.
  const apAllWallEnabled = obj?.askPeakAllWallLineEnabled === true;
  const apAllWallColor = normalizeHexColor(obj?.askPeakAllWallColor, ASK_PEAK_ALL_WALL_DEFAULT_COLOR);
  const apAllWallWidth = normalizeLineWidth(obj?.askPeakAllWallLineWidth, PEAK_ALL_WALL_DEFAULT_WIDTH);
  const bpAllWallEnabled = obj?.bidPeakAllWallLineEnabled === true;
  const bpAllWallColor = normalizeHexColor(obj?.bidPeakAllWallColor, BID_PEAK_ALL_WALL_DEFAULT_COLOR);
  const bpAllWallWidth = normalizeLineWidth(obj?.bidPeakAllWallLineWidth, PEAK_ALL_WALL_DEFAULT_WIDTH);
  // 체결된 벽 선 — **opt-out** 이다(`volumeEnabled` 규약: false 리터럴만 OFF).
  // opt-in 으로 두면 기존 스토어에 키가 없어 로드마다 체결된 벽이 사라진다.
  const apTradedLine = obj?.askPeakTradedLineEnabled !== false;
  const bpTradedLine = obj?.bidPeakTradedLineEnabled !== false;
  // 미도달 벽 하위 선 — 전체 최대벽과 같은 규약(opt-in + 검증 폴백).
  const apUnreachedEnabled = obj?.askPeakUnreachedLineEnabled === true;
  const apUnreachedColor = normalizeHexColor(obj?.askPeakUnreachedColor, ASK_PEAK_UNREACHED_DEFAULT_COLOR);
  const apUnreachedWidth = normalizeLineWidth(obj?.askPeakUnreachedLineWidth, PEAK_UNREACHED_DEFAULT_WIDTH);
  const bpUnreachedEnabled = obj?.bidPeakUnreachedLineEnabled === true;
  const bpUnreachedColor = normalizeHexColor(obj?.bidPeakUnreachedColor, BID_PEAK_UNREACHED_DEFAULT_COLOR);
  const bpUnreachedWidth = normalizeLineWidth(obj?.bidPeakUnreachedLineWidth, PEAK_UNREACHED_DEFAULT_WIDTH);
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
  const brokerLateEntries = normalizeSlotArray(
    obj?.brokerLateEntries,
    DEFAULT_BROKER_LATE_ENTRIES,
    isValidBrokerLateEntry,
    BROKER_LATE_ENTRY_SLOT_LIMIT,
  );
  const brokerLateEntrySellColor = normalizeHexColor(
    obj?.brokerLateEntrySellColor,
    BROKER_LATE_ENTRY_SELL_DEFAULT_COLOR,
  );
  // daily MA — opt-in(기본 false), 슬롯 검증·cap·기본값 전략 movingAverages와 동일.
  const dEnabled = obj?.dailyMovingAverageEnabled === true;
  const dHidden = obj?.dailyMovingAverageHidden === true;
  const dMas = normalizeMaSlots(obj?.dailyMovingAverages, DEFAULT_DAILY_MAS);
  // 총잔량/호가비 현재값 수평선 — opt-in. 색/두께/모양은 저장값 검증 후 기본값 폴백.
  const quoteTotalsLevelLineEnabled = obj?.quoteTotalsLevelLineEnabled === true;
  const qtBidLevelColor = normalizeHexColor(obj?.quoteTotalsBidLevelColor, QUOTE_TOTALS_BID_LEVEL_DEFAULT_COLOR);
  const qtBidLevelWidth = normalizeLineWidth(obj?.quoteTotalsBidLevelWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const qtBidLevelStyle = normalizeLineStyle(obj?.quoteTotalsBidLevelStyle, QUOTE_LEVEL_LINE_DEFAULT_STYLE);
  const qtAskLevelColor = normalizeHexColor(obj?.quoteTotalsAskLevelColor, QUOTE_TOTALS_ASK_LEVEL_DEFAULT_COLOR);
  const qtAskLevelWidth = normalizeLineWidth(obj?.quoteTotalsAskLevelWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const qtAskLevelStyle = normalizeLineStyle(obj?.quoteTotalsAskLevelStyle, QUOTE_LEVEL_LINE_DEFAULT_STYLE);
  // 총잔량 당일 최고 수평선 — 현재값 수평선과 같은 검증·폴백, 모양 기본만 dotted.
  const quoteTotalsDayMaxLineEnabled = obj?.quoteTotalsDayMaxLineEnabled === true;
  const qtDayMaxBidColor = normalizeHexColor(obj?.quoteTotalsDayMaxBidColor, QUOTE_TOTALS_BID_LEVEL_DEFAULT_COLOR);
  const qtDayMaxBidWidth = normalizeLineWidth(obj?.quoteTotalsDayMaxBidWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const qtDayMaxBidStyle = normalizeLineStyle(obj?.quoteTotalsDayMaxBidStyle, QUOTE_TOTALS_DAY_MAX_DEFAULT_STYLE);
  const qtDayMaxAskColor = normalizeHexColor(obj?.quoteTotalsDayMaxAskColor, QUOTE_TOTALS_ASK_LEVEL_DEFAULT_COLOR);
  const qtDayMaxAskWidth = normalizeLineWidth(obj?.quoteTotalsDayMaxAskWidth, QUOTE_LEVEL_LINE_DEFAULT_WIDTH);
  const qtDayMaxAskStyle = normalizeLineStyle(obj?.quoteTotalsDayMaxAskStyle, QUOTE_TOTALS_DAY_MAX_DEFAULT_STYLE);
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
    peakWallPaneEnabled: pwPaneEnabled,
    peakWallPaneTradedEnabled: pwPaneTraded,
    peakWallPaneUnreachedEnabled: pwPaneUnreached,
    peakWallPaneAllWallEnabled: pwPaneAllWall,
    askPeakEnabled: apEnabled,
    askPeakHidden: apHidden,
    askPeakColor: apColor,
    askPeakLineWidth: apWidth,
    askPeakTradedLineEnabled: apTradedLine,
    askPeakAllWallLineEnabled: apAllWallEnabled,
    askPeakAllWallColor: apAllWallColor,
    askPeakAllWallLineWidth: apAllWallWidth,
    askPeakUnreachedLineEnabled: apUnreachedEnabled,
    askPeakUnreachedColor: apUnreachedColor,
    askPeakUnreachedLineWidth: apUnreachedWidth,
    viLimitPriceLineColor,
    viLimitPriceLineWidth,
    bidPeakEnabled: bpEnabled,
    bidPeakHidden: bpHidden,
    bidPeakColor: bpColor,
    bidPeakLineWidth: bpWidth,
    bidPeakTradedLineEnabled: bpTradedLine,
    bidPeakAllWallLineEnabled: bpAllWallEnabled,
    bidPeakAllWallColor: bpAllWallColor,
    bidPeakAllWallLineWidth: bpAllWallWidth,
    bidPeakUnreachedLineEnabled: bpUnreachedEnabled,
    bidPeakUnreachedColor: bpUnreachedColor,
    bidPeakUnreachedLineWidth: bpUnreachedWidth,
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
    quoteTotalsDayMaxLineEnabled,
    quoteTotalsDayMaxBidColor: qtDayMaxBidColor,
    quoteTotalsDayMaxBidWidth: qtDayMaxBidWidth,
    quoteTotalsDayMaxBidStyle: qtDayMaxBidStyle,
    quoteTotalsDayMaxAskColor: qtDayMaxAskColor,
    quoteTotalsDayMaxAskWidth: qtDayMaxAskWidth,
    quoteTotalsDayMaxAskStyle: qtDayMaxAskStyle,
    ratioEnabled: ratio,
    ratioLevelLineEnabled,
    ratioLevelColor,
    ratioLevelWidth,
    ratioLevelStyle,
    fillStrengthEnabled: fill,
    programTradeEnabled: programTrade,
    brokerLateEntries,
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
  const mas = normalizeMaSlots(o.movingAverages, DEFAULT_LIVE_MAS);
  return build(mas, enabled, fNet, iNet, vol, hidden, qt, ratio, fill, programTrade, tradeVolumePoc);
}
