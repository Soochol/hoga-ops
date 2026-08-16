/** **RangeBundle Slice** 등록 — 슬라이스 하나가 통과해야 하는 축들을 한 자리에 모은다.
 *
 * `/api/range` 응답(`RangeBundle`)에 슬라이스를 하나 추가하려면 서로를 모르는 명시 열거
 * 목록을 **전부** 지나가야 한다 — 요청 술어 · 캐시 키 · 델타 병합 · 번들 조립 · 백엔드
 * 게이트 · 과거일 캐시. 어느 하나가 빠져도 타입은 통과하고, 증상은 한참 뒤에 온다.
 * 호가벽 급증(`wall_surge`)이 그래서 PR 세 건(#1321 → #1325 → #1333)에 걸쳐 들어왔다.
 *
 * 이 파일은 그 축들을 **손으로 선언**한다. ADR-0004 가 기각한 codegen 이 아니다 —
 * 손 미러를 유지한 채 "몇 군데인지" 만 한 곳에서 세게 한다. 실제 강제는
 * `tests/unit/api/test_range_slice_registry_contract.py` 가 양방향으로 한다:
 * 등록에 있는 것이 각 축에 등장하는지, 그리고 `RangeBundle` 에 있는 것이 등록에 있는지.
 *
 * ## 이 등록을 편집할 때
 *
 * **배열 안에 주석을 쓰지 말 것.** 파이썬 가드가 이 파일을 문자열로 스캔하므로 엔트리는
 * 중첩 없는 **평평한 리터럴**이어야 한다(스프레드·계산값·템플릿 문자열도 금지). 스캐너가
 * 못 읽는 엔트리는 에러가 아니라 조용히 "미등록" 이 되는데, 그건 파서 결함이 드리프트로
 * 위장하는 실패다. 사유는 주석이 아니라 `note` 에 적는다.
 *
 * **`note` 가 비어 있지 않은 슬라이스의 목록이 곧 이 코드베이스의 미해결 비대칭 목록이다.**
 *
 * ## 지금은 아무도 이 모듈을 import 하지 않는다
 *
 * 의도된 상태다. 먼저 선언과 가드를 세우고, 접히는 축부터 소비처가 이 선언에서 파생하도록
 * 옮긴다. 그때까지 이 선언이 썩지 않게 붙잡는 것이 위 가드의 역할이다.
 */

/** 델타 병합 규칙 (`api/range.ts` 의 `mergeRangeBundles`).
 *
 * - `spread` — 최상위 `...next` 로 낙착. previous 가 통째로 사라진다.
 * - `segment-filtered` — `outsideCoveredSegment` 로 previous 를 거른다. **재계산에서 항목이
 *   사라질 수 있을 때** 필요한 방어다(사라진 항목은 대응할 키가 없어 dedup 이 못 잡는다).
 * - `date-filtered` — `outsideCoveredDates` 로 거른다. 거래일 단위 산출물이 그 대상이다.
 * - `unfiltered` — 거르지 않고 `uniqueBy` 로만 합친다. **백엔드가 prefix 집계라 과거 시각의
 *   판정이 불변일 때** 쓴다. `previous` 를 거르는가의 판별식이 그것이다.
 */
export type RangeSliceMergeRule = 'spread' | 'segment-filtered' | 'date-filtered' | 'unfiltered';

export type RangeSliceSpec = {
  /** `RangeBundle` 의 wire 필드명. */
  readonly field: string;
  /** `/api/range` 의 HTTP `Query` 파라미터. `null` = 이 슬라이스는 HTTP 토글이 없다. */
  readonly httpFlag: string | null;
  /** `RangeRequestOptions` 의 필드명. `null` = 프론트가 요청으로 끌 수 없다. */
  readonly requestOption: string | null;
  /** `RangeQueryKey` 안의 위치. `null` = 캐시를 가르지 않는다. */
  readonly queryKeyIndex: number | null;
  /** `PLACEHOLDER_COMPATIBLE_KEY_INDICES` 에 그 인덱스가 있는가. */
  readonly placeholderCompatible: boolean;
  /** `hoga/api/bundle.py` 의 게이트. `inline` = `include_*` 변수 없이 인라인 조건. */
  readonly backendGate: string | null;
  readonly mergeRule: RangeSliceMergeRule;
  /** `live/buildLiveBundle.ts` 의 `buildChartBundle` 반환 목록에 있는가. */
  readonly inChartBundle: boolean;
  /** `hoga/api/past_indicators_cache.py` 의 `KIND_VERSIONS` 키. */
  readonly cacheKind: string | null;
  /** 비어 있지 않으면 **미해결 비대칭**이다. 축이 빈 이유를 여기에 적는다. */
  readonly note: string;
};

/** `RangeBundle` 의 배열·구조 필드 전부. 스칼라(`code`·`from_date`·`to_date`·`bucket_ms`)는
 *  슬라이스가 아니다. */
export const RANGE_BUNDLE_SLICES: readonly RangeSliceSpec[] = [
  {
    field: 'segments',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'unfiltered',
    inChartBundle: true,
    cacheKind: null,
    note: '',
  },
  {
    field: 'candles',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: 'mode',
    mergeRule: 'segment-filtered',
    inChartBundle: true,
    cacheKind: null,
    note: 'mode 로만 갈린다 — 슬라이스 단위 토글이 없다.',
  },
  {
    field: 'quote_ratio',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: 'mode',
    mergeRule: 'segment-filtered',
    inChartBundle: true,
    cacheKind: 'ratio',
    note: 'mode 로만 갈린다. chartBundle 에는 빈 스텁으로 실리고 라이브가 덮는다.',
  },
  {
    field: 'fill_strength',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: 'mode',
    mergeRule: 'segment-filtered',
    inChartBundle: true,
    cacheKind: 'fill',
    note: 'mode 로만 갈린다. chartBundle 에는 빈 스텁으로 실리고 라이브가 덮는다.',
  },
  {
    field: 'volume_profile_range',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'spread',
    inChartBundle: true,
    cacheKind: null,
    note: '백엔드가 상시 빈 값을 넣는다 — mode=full 퇴역(2026-07-08)의 잔재다.',
  },
  {
    field: 'volume_profile_by_day',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'spread',
    inChartBundle: true,
    cacheKind: null,
    note: '백엔드가 상시 빈 값을 넣는다 — mode=full 퇴역(2026-07-08)의 잔재다.',
  },
  {
    field: 'excluded_dates',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'date-filtered',
    inChartBundle: false,
    cacheKind: null,
    note: '델타 병합 규칙은 있는데 chartBundle 반환 목록에는 없다 — 캔들 경로에서 소실된다.',
  },
  {
    field: 'data_warnings',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'date-filtered',
    inChartBundle: false,
    cacheKind: null,
    note: '델타 병합 규칙은 있는데 chartBundle 반환 목록에는 없다 — 캔들 경로에서 소실된다.',
  },
  {
    field: 'missing_dates',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'date-filtered',
    inChartBundle: true,
    cacheKind: null,
    note: '',
  },
  {
    field: 'ask_peaks',
    httpFlag: 'ask_peaks_enabled',
    requestOption: 'askPeaksEnabled',
    queryKeyIndex: 16,
    placeholderCompatible: true,
    backendGate: 'include_ask_peaks',
    mergeRule: 'date-filtered',
    inChartBundle: true,
    cacheKind: 'ask_peak',
    note: '',
  },
  {
    field: 'bid_peaks',
    httpFlag: 'bid_peaks_enabled',
    requestOption: 'bidPeaksEnabled',
    queryKeyIndex: 17,
    placeholderCompatible: true,
    backendGate: 'include_bid_peaks',
    mergeRule: 'date-filtered',
    inChartBundle: true,
    cacheKind: 'bid_peak',
    note: '',
  },
  {
    field: 'depth_heatmap',
    httpFlag: 'depth_heatmap_enabled',
    requestOption: 'depthHeatmapEnabled',
    queryKeyIndex: 20,
    placeholderCompatible: true,
    backendGate: 'include_depth_heatmap',
    mergeRule: 'unfiltered',
    inChartBundle: true,
    cacheKind: 'depth',
    note: '',
  },
  {
    field: 'depth_delta',
    httpFlag: 'depth_delta_enabled',
    requestOption: 'depthDeltaEnabled',
    queryKeyIndex: 21,
    placeholderCompatible: true,
    backendGate: 'include_depth_delta',
    mergeRule: 'unfiltered',
    inChartBundle: true,
    cacheKind: 'depth_delta',
    note: '',
  },
  {
    field: 'wall_surge',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: 'include_wall_surge',
    mergeRule: 'unfiltered',
    inChartBundle: false,
    cacheKind: 'wall_surge',
    note: '축 4개가 빈다. 빌더는 wall_surge_enabled 파라미터를 받지만 routes.py 가 전달하지 않아 HTTP 로 도달 불가이고, 그래서 프론트에도 요청 옵션·캐시 키 축이 없다. chartBundle 반환 목록에도 없어 useLiveBundle 이 사후 대입한다. 토글을 살릴지 지울지가 미결이다.',
  },
  {
    field: 'broker_late_entries',
    httpFlag: 'broker_late_entries_enabled',
    requestOption: 'brokerLateEntriesEnabled',
    queryKeyIndex: 7,
    placeholderCompatible: true,
    backendGate: 'inline',
    mergeRule: 'segment-filtered',
    inChartBundle: true,
    cacheKind: 'broker_late',
    note: '게이트가 include_* 변수가 아니라 인라인 조건이다.',
  },
  {
    field: 'price_level_hits',
    httpFlag: null,
    requestOption: null,
    queryKeyIndex: null,
    placeholderCompatible: false,
    backendGate: null,
    mergeRule: 'spread',
    inChartBundle: true,
    cacheKind: null,
    note: '백엔드가 상시 빈 값을 넣는다 — mode=full 퇴역(2026-07-08)의 잔재다.',
  },
  {
    field: 'trade_volume_pocs',
    httpFlag: 'trade_volume_poc_enabled',
    requestOption: 'tradeVolumePocEnabled',
    queryKeyIndex: 19,
    placeholderCompatible: true,
    backendGate: 'include_trade_volume_pocs',
    mergeRule: 'date-filtered',
    inChartBundle: true,
    cacheKind: 'poc',
    note: '',
  },
  {
    field: 'volume_distributions',
    httpFlag: 'volume_distribution_bins',
    requestOption: 'volumeDistributionBins',
    queryKeyIndex: 9,
    placeholderCompatible: true,
    backendGate: 'inline',
    mergeRule: 'date-filtered',
    inChartBundle: true,
    cacheKind: 'vdist',
    note: '게이트가 bool 토글이 아니라 bins 의 존재다 — bins 를 null 로 두면 꺼진다. 그래서 같은 자리의 trade_volume_poc_enabled 와 비대칭이다.',
  },
  {
    field: 'program_trade',
    httpFlag: 'program_trade_enabled',
    requestOption: 'programTradeEnabled',
    queryKeyIndex: 18,
    placeholderCompatible: true,
    backendGate: 'include_program_trade',
    mergeRule: 'segment-filtered',
    inChartBundle: true,
    cacheKind: null,
    note: '옵션 슬라이스 중 유일하게 과거일 캐시 kind 가 없다.',
  },
];
