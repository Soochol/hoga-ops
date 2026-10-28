/** Pure candle-window preference schema, shared by rendering and persistence. */
export const CHART_DISPLAY_TOGGLES = [
  {
    key: 'accountExecutionsEnabled',
    label: '매매내역 표시',
    description: '상단에서 선택한 계좌의 매매내역을 일봉·분봉에 B/S로 표시합니다. 토스는 주문 평균가 기준입니다.',
    default: false,
    group: 'candle',
  },
  // ── 차트 › 캔들 · 지표 ─────────────────────────────────────────────
  {
    key: 'volumeOverlayEnabled',
    label: '거래량을 캔들에 겹쳐 표시',
    description: '기본 거래량을 캔들 영역 하단에 표시하고 별도 거래량 패널을 숨깁니다. 추가한 거래량은 기존 패널에 유지합니다.',
    default: false,
    group: 'candle',
  },
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
    description: '가격축을 위아래로 뒤집어 높은 가격을 아래에 표시합니다.',
    default: false,
    group: 'candle',
  },
  {
    key: 'candleInvertColors',
    label: '반전 시 캔들·거래량 색상 교환',
    description: '거꾸로 볼 때 캔들 몸통·꼬리와 거래량 봉의 상승·하락 색상을 서로 바꿉니다. 실제 가격·등락률은 유지합니다.',
    default: true,
    enabledBy: 'candleInvertScale',
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
    description: '이동평균선 등 보조지표 위에 캔들을 그립니다. 잔량 히트맵과의 순서는 아래 설정을 따릅니다.',
    default: false,
    group: 'candle',
  },
  {
    key: 'depthHeatmapAboveCandles',
    label: '잔량 히트맵을 캔들 위에',
    description: '호가 잔량 히트맵을 캔들보다 앞에 표시합니다.',
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
  // ── 차트 › 가격 표시 ───────────────────────────────────────────────
  {
    key: 'highLowLabelsEnabled',
    label: '고저 극값 라벨',
    description: '보이는 구간의 최고·최저가와 마지막 봉 종가의 대비율을 표시합니다. 자세한 값은 마우스를 올려 확인합니다.',
    default: true,
    group: 'price',
  },
  {
    key: 'highLowHighLineEnabled',
    label: '고가 가격선',
    description: '보이는 구간의 최고가에 수평 점선을 표시합니다.',
    default: false,
    enabledBy: 'highLowLabelsEnabled',
  },
  {
    key: 'highLowLowLineEnabled',
    label: '저가 가격선',
    description: '보이는 구간의 최저가에 수평 점선을 표시합니다.',
    default: false,
    enabledBy: 'highLowLabelsEnabled',
  },
  {
    key: 'highLowPriorHighLineEnabled',
    label: '이전일 고가선',
    description: '보이는 구간에서 마지막 거래일을 뺀 이전 날들의 최고가를 표시합니다.',
    default: false,
    enabledBy: 'highLowLabelsEnabled',
  },
  {
    key: 'highLowPriorLowLineEnabled',
    label: '이전일 저가선',
    description: '보이는 구간에서 마지막 거래일을 뺀 이전 날들의 최저가를 표시합니다.',
    default: false,
    enabledBy: 'highLowLabelsEnabled',
  },
] as const;

export const CHART_DISPLAY_LINE_STYLES = [
  {
    key: 'highLowHighLine',
    label: '고가 가격선',
    enabledBy: 'highLowHighLineEnabled',
    direction: 'up',
    defaultWidth: 1,
  },
  {
    key: 'highLowLowLine',
    label: '저가 가격선',
    enabledBy: 'highLowLowLineEnabled',
    direction: 'down',
    defaultWidth: 1,
  },
  {
    key: 'highLowPriorHighLine',
    label: '이전일 고가선',
    enabledBy: 'highLowPriorHighLineEnabled',
    direction: 'up',
    defaultWidth: 1,
  },
  {
    key: 'highLowPriorLowLine',
    label: '이전일 저가선',
    enabledBy: 'highLowPriorLowLineEnabled',
    direction: 'down',
    defaultWidth: 1,
  },
] as const;

export type ChartDisplayPrefKey = (typeof CHART_DISPLAY_TOGGLES)[number]['key'];
export const DEFAULT_VOLUME_OVERLAY_STYLE = {
  volumeOverlayTransparency: 65,
  volumeOverlayHeight: 25,
  volumeOverlayUpColor: '',
  volumeOverlayDownColor: '',
};
export type VolumeOverlayStyle = typeof DEFAULT_VOLUME_OVERLAY_STYLE;
export type ChartDisplayLineStyleKey = (typeof CHART_DISPLAY_LINE_STYLES)[number]['key'];
export type ChartDisplayLineStyles = { [K in ChartDisplayLineStyleKey as `${K}Color`]: string }
  & { [K in ChartDisplayLineStyleKey as `${K}Width`]: 1 | 2 | 3 | 4 };
export const CHART_DISPLAY_LINE_DEFAULTS = Object.fromEntries(CHART_DISPLAY_LINE_STYLES.flatMap(def => [
  [`${def.key}Color`, ''], [`${def.key}Width`, def.defaultWidth],
])) as ChartDisplayLineStyles;
export type ChartDisplayPrefs = Record<ChartDisplayPrefKey, boolean> & VolumeOverlayStyle & ChartDisplayLineStyles;
/** Only these newly window-owned fields inherit legacy values in old snapshots. */
export const HIGH_LOW_WINDOW_PREF_KEYS = [
  ...CHART_DISPLAY_TOGGLES.filter(def => def.key.startsWith('highLow')).map(def => def.key),
  ...Object.keys(CHART_DISPLAY_LINE_DEFAULTS),
] as readonly (keyof ChartDisplayPrefs)[];
export const CHART_DISPLAY_PREF_KEYS: readonly ChartDisplayPrefKey[] = CHART_DISPLAY_TOGGLES.map(def => def.key);
export const DEFAULT_CHART_DISPLAY_PREFS = {
  ...Object.fromEntries(CHART_DISPLAY_TOGGLES.map(def => [def.key, def.default])),
  ...DEFAULT_VOLUME_OVERLAY_STYLE,
  ...CHART_DISPLAY_LINE_DEFAULTS,
} as ChartDisplayPrefs;

export function isChartDisplayPrefKey(key: string): key is ChartDisplayPrefKey {
  return CHART_DISPLAY_PREF_KEYS.some(candidate => candidate === key);
}

export function normalizeChartDisplayPrefs(raw: unknown): ChartDisplayPrefs {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const integer = (key: 'volumeOverlayTransparency' | 'volumeOverlayHeight', min: number, max: number) => {
    const value = source[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? value : DEFAULT_VOLUME_OVERLAY_STYLE[key];
  };
  const color = (key: 'volumeOverlayUpColor' | 'volumeOverlayDownColor') =>
    typeof source[key] === 'string' && /^#[0-9a-f]{6}$/i.test(source[key]) ? source[key].toUpperCase() : '';
  const lines = Object.fromEntries(CHART_DISPLAY_LINE_STYLES.flatMap(def => {
    const rawColor = source[`${def.key}Color`], rawWidth = source[`${def.key}Width`];
    return [
      [`${def.key}Color`, typeof rawColor === 'string' && /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor.toUpperCase() : ''],
      [`${def.key}Width`, typeof rawWidth === 'number' && [1, 2, 3, 4].includes(rawWidth) ? rawWidth : def.defaultWidth],
    ];
  }));
  return { ...lines, ...Object.fromEntries(CHART_DISPLAY_TOGGLES.map(def => [def.key,
    typeof source[def.key] === 'boolean' ? source[def.key] : def.default,
  ])),
  volumeOverlayTransparency: integer('volumeOverlayTransparency', 0, 100),
  volumeOverlayHeight: integer('volumeOverlayHeight', 10, 40),
  volumeOverlayUpColor: color('volumeOverlayUpColor'),
  volumeOverlayDownColor: color('volumeOverlayDownColor'),
  } as ChartDisplayPrefs;
}
