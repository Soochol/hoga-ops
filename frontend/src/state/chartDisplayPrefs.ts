/** Pure candle-window preference schema, shared by rendering and persistence. */
export const CHART_DISPLAY_TOGGLES = [
  // ── 차트 › 캔들 · 지표 ─────────────────────────────────────────────
  {
    key: 'candleLogScale',
    label: '로그 스케일',
    description: '같은 가격 변화율을 같은 세로 간격으로 표시합니다. 캔들과 가격 지표에 적용합니다.',
    default: false,
    group: 'candle',
  },
  {
    key: 'candleInvertScale',
    label: '차트 거꾸로 보기',
    description: '가격축을 위아래로 뒤집어 높은 가격을 아래에 표시합니다. 상승·하락 색상은 유지합니다.',
    default: false,
    group: 'candle',
  },
  {
    key: 'candlePaneCandleOnlyScale',
    label: '캔들 기준 Y축',
    description: '캔들 고가·저가에 맞춰 가격축을 조절합니다. 보조지표는 제외합니다.',
    default: false,
    group: 'candle',
  },
  {
    key: 'candleAlwaysOnTop',
    label: '캔들이 항상 위',
    description: '이동평균선 등 보조지표 위에 캔들을 그립니다.',
    default: false,
    group: 'candle',
  },
  {
    key: 'auctionWindowMask',
    label: '동시호가 구간 지표 숨김',
    description: '마감 동시호가 구간의 호가비·총잔량·체결강도를 숨깁니다. 캔들·거래량은 유지합니다.',
    default: true,
    group: 'candle',
  },
  {
    key: 'candleTooltipEnabled',
    label: '캔들 정보 툴팁',
    description: '캔들에 마우스를 올리면 가격·등락·거래량 정보를 표시합니다.',
    default: false,
    group: 'candle',
  },
  // ── 차트 › 격자 · 구분선 ───────────────────────────────────────────
  {
    key: 'horizontalGridLinesEnabled',
    label: '가로 구분선',
    description: '가격을 따라 가로 격자선을 표시합니다.',
    default: true,
    group: 'grid',
  },
  {
    key: 'verticalGridLinesEnabled',
    label: '세로 구분선',
    description: '시간을 따라 세로 격자선을 표시합니다.',
    default: true,
    group: 'grid',
  },
] as const;

export type ChartDisplayPrefKey = (typeof CHART_DISPLAY_TOGGLES)[number]['key'];
export type ChartDisplayPrefs = Record<ChartDisplayPrefKey, boolean>;
export const CHART_DISPLAY_PREF_KEYS: readonly ChartDisplayPrefKey[] = CHART_DISPLAY_TOGGLES.map(def => def.key);
export const DEFAULT_CHART_DISPLAY_PREFS = Object.fromEntries(CHART_DISPLAY_TOGGLES.map(def => [def.key, def.default])) as ChartDisplayPrefs;

export function isChartDisplayPrefKey(key: string): key is ChartDisplayPrefKey {
  return CHART_DISPLAY_PREF_KEYS.some(candidate => candidate === key);
}

export function normalizeChartDisplayPrefs(raw: unknown): ChartDisplayPrefs {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(CHART_DISPLAY_TOGGLES.map(def => [def.key,
    typeof source[def.key] === 'boolean' ? source[def.key] : def.default,
  ])) as ChartDisplayPrefs;
}
