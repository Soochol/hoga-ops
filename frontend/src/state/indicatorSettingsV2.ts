import type { PaneId } from '../chart/drawing/types';
import { normalizePaneOrder, normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import {
  flattenPaneGroups,
  normalizePaneAxisMode,
  normalizePaneGroups,
  normalizePaneGroupStretch,
  paneGroupsFromOrder,
  type PaneAxisModeMap,
  type PaneGroups,
  type PaneGroupStretchMap,
} from '../chart/paneGroups';
import {
  mergeLiveIndicatorPrefs,
  type LiveMAConfig,
  type PersistedIndicators,
} from './liveIndicatorsPersistence';
import { takeWindowIndicatorsForMigration } from './indicatorsWindowMigration';
import {
  INDICATOR_PANE_PREF_KEYS,
  INDICATOR_PANE_PROFILE_KEYS,
  normalizePanePrefsByTimeframe,
  profileKeyForTimeframe,
  type IndicatorPaneProfileKey,
} from '../live/indicators/indicatorPaneProfiles';
import type { LiveTimeframe } from './livePage';

/**
 * per-timeframe 지표 설정 v2 (지도 #694 / 최종 스펙 #699).
 *
 * 저장 모델: `live.indicators.v2` = { paneOrder·paneStretch(전역 레이아웃)
 * + byTimeframe/studyByTimeframe(페이지 세트) + byWindow(창 세트) }. 각 세트는
 * 분/D/W/M 4버킷 sparse 오버라이드이고, 읽기 = 공장 기본값 ⊕ 그 봉 버킷이다.
 * flat 상속과 `panePrefsByTimeframe` 병합(구 모델)은 폐지 — 기존 pane 토글 7종도
 * 버킷 안으로 흡수된다(#696). sparse 의 정의는 "공장값과의 diff"다: 공장값과 같은
 * 항목은 로드 시 제거되므로, 향후 공장값 개선이 안 만진 필드에 자동 반영된다(#697).
 *
 * **스코프 축은 셋이다: 페이지 × 창 × 봉** (ADR-0146 + ADR-0152).
 * 차트 창은 항상 자기 세트(`byWindow`)를 갖고, 페이지 세트는 그 **시드 뿌리이자
 * Provider 밖 폴백**으로 남는다. 해석은 `bucketsForScope` 한 곳에 모여 있다.
 */

/** MA 마스터 토글 4형제 — v1 에만 있고 v2 버킷에는 없다(`collapseMaMasterFlags`).
 *  `stripContainers` 와 `IndicatorSettings` 가 같은 목록을 봐야 하므로 상수로 둔다. */
export const LEGACY_MA_MASTER_KEYS = [
  'movingAverageEnabled',
  'movingAverageHidden',
  'dailyMovingAverageEnabled',
  'dailyMovingAverageHidden',
] as const;

type LegacyMaMasterKey = (typeof LEGACY_MA_MASTER_KEYS)[number];

/** 버킷 하나가 담는 지표 설정 전체 — v1 `PersistedIndicators` 에서 per-timeframe
 *  컨테이너(panePrefsByTimeframe)와 레이아웃(paneOrder·paneStretch), 그리고 MA 마스터
 *  토글 4형제를 뺀 것.
 *
 *  paneStretch(#703)는 paneOrder 와 함께 v2 레이아웃 슬라이스에 산다(버킷 아님).
 *  마스터 토글이 빠진 이유는 레이아웃과 달라서 **접혔기** 때문이다 — 유효 게이트가
 *  `slot.enabled` 하나로 줄었다(`collapseMaMasterFlags` 도크스트링). */
export type IndicatorSettings =
  Omit<
    PersistedIndicators,
    'panePrefsByTimeframe' | 'paneOrder' | 'paneStretch' | LegacyMaMasterKey
  >;

export type IndicatorSettingsByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorSettings>>>;

export type PersistedIndicatorsV2 = {
  paneOrder: PaneId[];
  /** pane 병합 그룹(순열+분할) — 이제 레이아웃의 **원본**이고 `paneOrder` 는 그
   *  평탄화 투영이다(`chart/paneGroups.ts` 도크스트링). 둘 다 저장하는 이유는
   *  다운그레이드 안전 — paneGroups 를 모르는 구 빌드도 순서는 읽는다. 구 빌드가
   *  블롭을 재조립해 쓰면 이 키가 통째로 사라지고, 읽기가 paneOrder 싱글턴 파생
   *  으로 복귀하므로 스테일 그룹이 남는 경로는 없다. */
  paneGroups: PaneGroups;
  /** 병합 그룹별 y축 모드 오버라이드(`chart/paneGroups.ts` — shared/isolated/left).
   *  키는 구성(정렬 join), 현재 그룹과 매칭 안 되는 키는 로드 시 걷힌다(스테일
   *  소멸). 구 boolean 필드(paneAxisShare, PR #1553)는 읽기 폴백으로만 남고 다음
   *  쓰기에서 자연 소멸한다. */
  paneAxisMode: PaneAxisModeMap;
  /** 병합 그룹별 stretch 오버라이드 — separator 드래그가 그룹 키에 기록(멤버 개별
   *  값 오염 없이, 분리 시 각자의 옛 크기가 살아난다). 같은 스테일 소멸 규칙. */
  paneGroupStretch: PaneGroupStretchMap;
  /** 사용자 소유 Pane 크기 가중치(#703) — paneOrder 와 같은 레이아웃 슬라이스.
   *  전역 1세트, pane 종류별. 없는 키 = 스펙 기본값. */
  paneStretch: PaneStretchMap;
  /**
   * `/live` 의 **페이지 세트** — 이 필드의 저장 형태는 종전 그대로다(ADR-0146).
   *
   * ADR-0152 이후 이 값을 직접 보는 것은 Provider 밖 소비자(단일 차트·테스트
   * 픽스처)뿐이고, 화면의 차트 창은 자기 `byWindow` 엔트리를 본다. 대신 **새 창의
   * 시드 뿌리**라 죽은 키가 되지는 않는다 — 첫 창이 열릴 때마다 여기서 복사된다.
   *
   * 페이지 축을 대칭(`byPage.{live,study}`)으로 만들지 않은 이유: 그러면 이 키가
   * 아무도 안 쓰는 값이 되는데, 이 리포는 그 실패를 이미 겪었다 — 스테일해진
   * `live.indicators.v2` 를 되살리려고 `indicatorsWindowMigration` 을 써야 했다.
   * `/live` 저장 형태를 바이트 단위로 유지하면 마이그레이션도, 스테일 키도 없다.
   */
  byTimeframe: IndicatorSettingsByTimeframe;
  /**
   * `/study` 의 지표 세트. 두 페이지는 **항상 분리**다(ADR-0146) — 창별 분리나
   * 연동 스위치는 없다.
   *
   * **로드 시 즉시 시드된다**(`/live` 세트의 깊은 사본). 게으른 폴백
   * (`study ?? byTimeframe`)이 아닌 이유가 이 기능의 인수 조건이다: 폴백이면
   * `/study` 가 **첫 편집 전까지** `/live` 를 계속 따라다니고, 사용자가 보기엔
   * "분리했다는데 여전히 같이 바뀐다" 다.
   *
   * 키의 **존재**가 "이미 시드했다" 이므로 값이 `{}` 여도 보존한다 — 공장값
   * 사용자는 복사할 diff 가 없어 `{}` 가 정상이고, 이걸 걷어내면 다음 로드에
   * 다시 `/live` 값으로 덮인다.
   */
  /**
   * **창별 지표 세트** (ADR-0152). 키는 `live:<창id>` / `study:<창id>`.
   *
   * 차트 창은 **항상** 자기 엔트리를 갖는다 — 창이 생길 때 시드되고(`/live` 는
   * 포커스 창 복사, 그 밖은 페이지 세트 복사) 창이 사라질 때 회수된다. 그래서
   * 같은 페이지·같은 봉을 보는 두 창이 서로를 따라가지 않는다.
   *
   * **엔트리의 존재가 곧 "이 창은 자기 세트를 갖는다"** 이므로 정규화가
   * `byTimeframe` 과 달리 **빈 엔트리를 걷어내지 않는다**: 걷어내면 공장값 상태의
   * 창(= 복사할 diff 가 없어 `{}`)이 다음 로드에 페이지 세트로 조용히 되붙고,
   * 증상은 한참 뒤 다른 창을 편집한 순간에야 "왜 이 창까지 따라오지" 로 나타난다.
   * 같은 이유로 **창 지표 초기화는 키 삭제가 아니라 `{}` 쓰기**다.
   *
   * 내용물이 여기(전역 localStorage)에 사는 것이 #712 와의 차이다 — 창이 소유한
   * 것은 **키뿐**이라 워크스페이스(탭별 sessionStorage)가 갈려도 설정은 안 갈리고,
   * 크로스탭 동기화가 창별 설정까지 그대로 덮는다.
   */
  byWindow: Record<string, IndicatorSettingsByTimeframe>;
};

/**
 * 지표 읽기·쓰기의 대상 스코프 — 이제 **창 하나**다.
 *
 * `windowKey` 가 null 인 경우는 **화면이 아니다**: Provider 밖(단일 차트·테스트
 * 픽스처)이고, 그때는 앱 세트를 본다. 실제 차트는 모두 창 Provider 안에서 렌더된다.
 *
 * ⚠ 여기 `page: 'live' | 'study'` 축이 있었다(ADR-0146). `/study` 폐지(ADR-0157)로
 * 거주자가 하나가 됐고 이 PR 이 걷었다. **`windowKey` 의 `live:` 접두는 남는다** —
 * 그건 축이 아니라 **영속 키의 화석**이다(사용자 디스크의 `byWindow` 키가 그 모양
 * 이라, 떼면 기존 창 설정이 전부 조회 불가가 된다). 새 접두를 추가하지 말 것:
 * 두 번째 값이 필요해지는 날엔 접두가 아니라 축을 다시 세우는 것이 맞다.
 */
export interface IndicatorScope {
  windowKey: string | null;
}

/** 손상된 스토어의 무한 증식 방어 — 실사용 창 수보다 한참 크다. */
export const INDICATOR_WINDOW_SCOPE_LIMIT = 64;

export const INDICATORS_V2_STORAGE_KEY = 'live.indicators.v2';
const V1_STORAGE_KEY = 'live.indicators.v1';

function stripContainers(v1: PersistedIndicators): IndicatorSettings {
  // paneStretch(#703)도 레이아웃이라 버킷 설정에서 제외 — 그러지 않으면
  // FACTORY_INDICATOR_SETTINGS 가 paneStretch:{} 를 실어, reset/applyPreset 의
  // `...FACTORY`/`...resolveIndicatorSettings` 스프레드가 실제 값을 덮어쓴다.
  // MA 마스터 4형제도 같이 뺀다 — 여기서 빠지면 `INDICATOR_SETTING_KEYS` 에서
  // 자동으로 사라지고, 그 결과 sanitize 가 안 받고 persist 가 안 쓴다(자연 소멸,
  // `studyByTimeframe`·`paneAxisShare` 와 같은 관례).
  const {
    panePrefsByTimeframe: _p,
    paneOrder: _o,
    paneStretch: _s,
    movingAverageEnabled: _me,
    movingAverageHidden: _mh,
    dailyMovingAverageEnabled: _de,
    dailyMovingAverageHidden: _dh,
    ...settings
  } = v1;
  return settings;
}

/** 슬롯 배열 전체의 `enabled` 를 한 값으로 세운다(참조 비교를 위해 새 배열). */
function withAllSlotsEnabled(
  slots: readonly LiveMAConfig[],
  enabled: boolean,
): LiveMAConfig[] {
  return slots.map((slot) => (slot.enabled === enabled ? slot : { ...slot, enabled }));
}

/**
 * MA 마스터 토글 4형제를 **슬롯의 `enabled` 로 접는다** — 레거시 버킷 1회 변환.
 *
 * 종전 모델의 가시성은 삼중이었다: 타입 마스터(`movingAverageEnabled`) × 타입 눈
 * (`movingAverageHidden`) × 슬롯(`slot.enabled`). 레전드 칩이 인스턴스 단위 조작
 * 표면이 되면서 인스턴스마다 켜고 끌 값이 필요해졌고, 남길 수 있는 것은 슬롯의
 * `enabled` 하나뿐이라 위 둘을 여기로 접는다.
 *
 * **판별식은 값이 아니라 키의 존재다.** 마스터 키가 없는 버킷은 이 변환 이후에
 * 쓰인 것(= 이미 접힌 것)이므로 건드리면 안 된다. 값으로 판정하면 —
 * `dailyMovingAverageEnabled !== true` 를 "마스터 OFF" 로 읽으면 — 새 모델에서
 * 사용자가 켜 둔 일봉 슬롯이 **로드마다 다시 꺼진다**(키가 없으니 언제나 OFF 로
 * 읽힌다). 같은 성질이 멱등성의 근거이기도 하다: 접힌 결과에는 마스터 키가 없어
 * 다음 로드가 no-op 이다.
 *
 * 접기 규칙:
 *  - 현재봉: 마스터가 false 이거나 눈이 켜져 있으면 전 슬롯 off. (마스터 기본 true)
 *  - 일봉: 마스터가 true 이고 눈이 꺼져 있을 때만 전 슬롯 on, 그 밖엔 전 슬롯 off.
 *    (마스터 기본 false — opt-in 이라 조건이 뒤집힌다)
 *
 * 슬롯 오버라이드가 없으면 공장 슬롯을 기준으로 만든다 — 마스터만 담긴 레거시
 * 버킷(`{movingAverageEnabled:false}`)이 그 경우이고, 그때 슬롯 배열을 만들지 않으면
 * "MA 를 껐다" 는 사용자의 설정이 통째로 증발한다.
 */
function collapseMaMasterFlags(
  rawBucket: Record<string, unknown>,
  sanitized: Partial<IndicatorSettings>,
): Partial<IndicatorSettings> {
  const has = (key: LegacyMaMasterKey): boolean => Object.hasOwn(rawBucket, key);
  const hasLive = has('movingAverageEnabled') || has('movingAverageHidden');
  const hasDaily = has('dailyMovingAverageEnabled') || has('dailyMovingAverageHidden');
  if (!hasLive && !hasDaily) return sanitized;

  const out = { ...sanitized };
  if (hasLive) {
    const visible = rawBucket.movingAverageEnabled !== false
      && rawBucket.movingAverageHidden !== true;
    const slots = out.movingAverages ?? FACTORY_INDICATOR_SETTINGS.movingAverages;
    out.movingAverages = withAllSlotsEnabled(slots, visible);
  }
  if (hasDaily) {
    const visible = rawBucket.dailyMovingAverageEnabled === true
      && rawBucket.dailyMovingAverageHidden !== true;
    const slots = out.dailyMovingAverages ?? FACTORY_INDICATOR_SETTINGS.dailyMovingAverages;
    out.dailyMovingAverages = withAllSlotsEnabled(slots, visible);
  }
  // 접은 결과가 공장값과 같아지는 경우가 있다(예: 일봉 마스터 OFF → 공장값과 동일한
  // all-disabled). sparse 의 정의가 "공장값과의 diff" 이므로 여기서 걷어낸다.
  for (const key of ['movingAverages', 'dailyMovingAverages'] as const) {
    if (key in out && jsonEqual(out[key], FACTORY_INDICATOR_SETTINGS[key])) delete out[key];
  }
  return out;
}

/** 공장 기본값 (#697 보충 정정): 거래량 + 이동평균선(기본 슬롯)만 on, 그 외 지표
 *  마스터 토글은 전부 off. 하위 파라미터·색 기본값은 v1 기본값 그대로 유지 —
 *  지표를 켜는 순간 기존 기본 구성이 나온다. */
export const FACTORY_INDICATOR_SETTINGS: IndicatorSettings = Object.freeze({
  ...stripContainers(mergeLiveIndicatorPrefs(undefined)),
  // 구 기본값 TRUE에서 off로 바뀌는 마스터 토글들.
  quoteTotalsEnabled: false,
  ratioEnabled: false,
  fillStrengthEnabled: false,
  programTradeEnabled: false,
  tradeVolumePocEnabled: false,
  volumeDistributionEnabled: false,
});

export const INDICATOR_SETTING_KEYS = Object.freeze(
  Object.keys(FACTORY_INDICATOR_SETTINGS),
) as readonly (keyof IndicatorSettings)[];

/** JSON 직렬화 동등성(키 순서 민감) — 이 모듈의 값은 전부 JSON 왕복 가능하고
 *  같은 코드 경로가 만든 객체라 키 순서가 안정적이므로 충분하다. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** 공장값과 다른 필드만 남긴다 — sparse 버킷의 정의. */
export function diffIndicatorSettingsFromFactory(
  settings: IndicatorSettings,
): Partial<IndicatorSettings> {
  const diff: Partial<IndicatorSettings> = {};
  for (const key of INDICATOR_SETTING_KEYS) {
    if (!jsonEqual(settings[key], FACTORY_INDICATOR_SETTINGS[key])) {
      (diff as Record<string, unknown>)[key] = settings[key];
    }
  }
  return diff;
}

/** 임의의 partial 을 필드 단위로 검증한다. 검증기는 v1 코어서를 재사용 — 공장값
 *  위에 partial 을 얹어 full-shape 을 만들고 코어서에 통과시킨 뒤, partial 이
 *  건드린 키만 뽑아 공장값과 diff 한다(무효값은 코어서가 공장값으로 되돌리므로
 *  diff 에서 자연 탈락). */
function sanitizeSettingsPatch(raw: unknown): Partial<IndicatorSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const partial = raw as Record<string, unknown>;
  // 1단계 — 런타임 타입이 공장값과 다른 엔트리를 먼저 버린다. 코어서의 boolean
  // 폴백은 v1 기본값(예: quoteTotalsEnabled → true)이라 새 공장값(false)과 다를
  // 수 있어, 타입 불일치 쓰레기가 영구 오버라이드로 승격되는 것을 여기서 막는다.
  const typed: Record<string, unknown> = {};
  for (const key of INDICATOR_SETTING_KEYS) {
    if (!(key in partial)) continue;
    const factoryValue = FACTORY_INDICATOR_SETTINGS[key];
    const value = partial[key];
    const typeMatches = Array.isArray(factoryValue)
      ? Array.isArray(value)
      : typeof value === typeof factoryValue;
    if (typeMatches) typed[key] = value;
  }
  // 2단계 — 도메인 검증(hex·범위·enum)은 v1 코어서 재사용: 공장값 위에 얹어
  // full-shape 을 만들고 통과시킨 뒤, 건드린 키만 뽑아 공장값과 diff 한다.
  const candidate = {
    ...FACTORY_INDICATOR_SETTINGS,
    ...typed,
    panePrefsByTimeframe: {},
    paneOrder: [],
  };
  const validated = stripContainers(mergeLiveIndicatorPrefs(candidate));
  const touched: IndicatorSettings = { ...FACTORY_INDICATOR_SETTINGS };
  for (const key of INDICATOR_SETTING_KEYS) {
    if (key in typed) {
      (touched as Record<string, unknown>)[key] = validated[key];
    }
  }
  return diffIndicatorSettingsFromFactory(touched);
}

/** 버킷 맵 하나(4프로파일)를 정규화한다 — 두 페이지 세트가 같은 규칙을 쓴다.
 *  빈 버킷은 여기서 걷힌다(sparse 의 정의). 맵 **자체**가 비는 것은 정상이며
 *  (= 공장값), 그래서 "비었다" 와 "없다" 는 서로 다른 뜻이다 — 후자만 시드를 부른다. */
/** 버킷 맵 하나를 정규화한다 — 저장소 로드와 **프리셋 payload 적용**이 공유한다
 *  (ADR-0159). payload 는 서버에서 오는 신뢰 불가 값이라 같은 소독을 거쳐야 한다.
 *
 *  ⚠ 여기서 걷어내는 것은 **맵 안의 빈 버킷**이지 엔트리 자체가 아니다. 엔트리의
 *  존재는 멤버십이므로(`byWindow` 주석) 호출자가 관리한다 — 빈 결과 `{}` 도
 *  "자기 세트를 갖는 창" 의 정상 값이다. */
export function normalizeBucketMap(raw: unknown): IndicatorSettingsByTimeframe {
  const rawBuckets = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const out: IndicatorSettingsByTimeframe = {};
  for (const profileKey of INDICATOR_PANE_PROFILE_KEYS) {
    const rawBucket = rawBuckets[profileKey];
    const sanitized = sanitizeSettingsPatch(rawBucket);
    // collapse 는 sanitize **다음**이지만 raw 를 읽는다 — 마스터 키는
    // `INDICATOR_SETTING_KEYS` 에 없어 sanitize 가 이미 버렸기 때문이다.
    const patch = rawBucket && typeof rawBucket === 'object' && !Array.isArray(rawBucket)
      ? collapseMaMasterFlags(rawBucket as Record<string, unknown>, sanitized)
      : sanitized;
    if (Object.keys(patch).length > 0) out[profileKey] = patch;
  }
  return out;
}

/** 버킷 맵의 깊은 사본 — **버킷 객체까지** 새로 만든다. 얕게 복사하면 두 페이지가
 *  같은 버킷 참조를 공유해, 한쪽 편집이 다른 쪽으로 샌다. */
function cloneBucketMap(source: IndicatorSettingsByTimeframe): IndicatorSettingsByTimeframe {
  const out: IndicatorSettingsByTimeframe = {};
  for (const [profileKey, bucket] of Object.entries(source)) {
    out[profileKey as IndicatorPaneProfileKey] = { ...bucket };
  }
  return out;
}

/**
 * 창 스코프 맵 — **빈 엔트리를 보존한다**(`byWindow` 필드 주석의 멤버십 규약).
 *
 * `normalizeBucketMap` 은 빈 버킷을 걷지만 그건 **맵 안**의 이야기다. 여기서
 * 걷어내는 것은 **엔트리 자체**이고, 그건 "이 창이 자기 세트를 갖는다" 는 사실을
 * 지우는 일이라 다른 뜻이 된다.
 */
function normalizeByWindow(raw: unknown): Record<string, IndicatorSettingsByTimeframe> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, IndicatorSettingsByTimeframe> = {};
  for (const [scopeKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= INDICATOR_WINDOW_SCOPE_LIMIT) break;
    if (!scopeKey) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    out[scopeKey] = normalizeBucketMap(value);
  }
  return out;
}

export function normalizeIndicatorsV2(raw: unknown): PersistedIndicatorsV2 {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  // 저장된 `studyByTimeframe` 은 **읽지 않는다**(ADR-0157). 기존 사용자의 블롭엔
  // 남아 있지만 다음 쓰기에서 사라진다 — `persistIndicators` 가 스토어에서 필드를
  // 명시로 조립하므로, 여기서 안 읽고 거기서 안 쓰면 키가 자연 소멸한다.
  //
  // 레이아웃은 paneGroups 가 원본이다: 키가 **있으면** 그것을 정규화해 쓰고
  // paneOrder 는 그 평탄화로 파생한다(저장된 paneOrder 무시 — 둘이 어긋난 블롭은
  // 구 빌드가 groups 키를 떨군 경우뿐이고, 그때는 아래 파생 분기라 어긋날 수 없다).
  // 키가 **없으면**(구 블롭·구 빌드가 재조립한 블롭) paneOrder 싱글턴으로 파생한다.
  const paneGroups = Array.isArray(obj.paneGroups)
    ? normalizePaneGroups(obj.paneGroups)
    : paneGroupsFromOrder(normalizePaneOrder(obj.paneOrder));
  // v2 boolean 공유 맵(paneAxisShare, PR #1553)의 1회성 읽기 폴백 — 모드 맵이
  // 없을 때만 변환해 읽는다(true→shared, false→isolated). 다음 persist 는
  // paneAxisMode 만 쓰므로 구 키는 자연 소멸한다(studyByTimeframe 패턴).
  const legacyShare = obj.paneAxisMode === undefined
    && obj.paneAxisShare && typeof obj.paneAxisShare === 'object'
    ? Object.fromEntries(
      Object.entries(obj.paneAxisShare as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'boolean')
        .map(([k, v]) => [k, v ? 'shared' : 'isolated']),
    )
    : undefined;
  return {
    paneOrder: flattenPaneGroups(paneGroups),
    paneGroups,
    paneAxisMode: normalizePaneAxisMode(obj.paneAxisMode ?? legacyShare, paneGroups),
    paneGroupStretch: normalizePaneGroupStretch(obj.paneGroupStretch, paneGroups),
    paneStretch: normalizePaneStretch(obj.paneStretch),
    byTimeframe: normalizeBucketMap(obj.byTimeframe),
    byWindow: normalizeByWindow(obj.byWindow),
  };
}

/**
 * 같은 버킷에 **같은 객체 참조**를 돌려주기 위한 캐시.
 *
 * 지표가 앱 전역 1세트로 돌아오면서 이 함수는 뜨거운 경로가 됐다 — 창마다,
 * 오버레이 selector 마다 스토어 변경 때 다시 불린다. 매번 새 객체를 만들면 값이
 * 그대로여도 참조가 달라 구독이 전부 깨어난다.
 *
 * **키는 버킷이지 버킷 맵이 아니다.** 세터는 편집마다 맵을 새로 만들되 손대지 않은
 * 프로파일의 버킷 **참조는 보존**한다(`{...byTimeframe, [key]: bucket}`). 맵을 키로
 * 잡으면 어떤 편집이든 전량 미스라, 다른 봉을 보는 창까지 매번 재렌더된다.
 */
const RESOLVE_CACHE = new WeakMap<
  Partial<IndicatorSettings>,
  IndicatorSettings
>();

/** 현재 봉의 유효 설정 = 공장 기본값 ⊕ 해당 버킷. 반환값은 **읽기 전용**으로
 *  다뤄야 한다(캐시 공유 — 호출자가 변형하면 다른 소비자가 함께 오염된다). */
export function resolveIndicatorSettings(
  byTimeframe: IndicatorSettingsByTimeframe,
  timeframe: LiveTimeframe,
): IndicatorSettings {
  const bucket = byTimeframe[profileKeyForTimeframe(timeframe)];
  // 버킷 없음 = 공장값 그대로 — 사본을 만들 이유가 없다(가장 흔한 경우).
  if (!bucket) return FACTORY_INDICATOR_SETTINGS;
  let resolved = RESOLVE_CACHE.get(bucket);
  if (!resolved) {
    resolved = { ...FACTORY_INDICATOR_SETTINGS, ...bucket };
    RESOLVE_CACHE.set(bucket, resolved);
  }
  return resolved;
}

/**
 * 이 스코프가 읽고 쓰는 버킷 맵 — 창 엔트리가 있으면 그것, 없으면 페이지 세트.
 *
 * 폴백이 "엔트리 없음 → 페이지 세트" 라, `byWindow` 가 통째로 없는 저장값(이 기능
 * 이전에 쓰인 것 포함)은 전 창이 페이지 세트를 보는 **종전 동작**이 된다. 되돌리기도
 * 대칭이다 — 정규화에서 `byWindow` 를 버리면 전부 페이지 공유로 돌아온다.
 *
 * `??` 여야 한다(`||` 아님) — 공장값 상태의 창은 엔트리가 `{}` 이고, 그건 **유효한
 * 자기 세트**다. truthiness 로 판정하면 그 창만 조용히 페이지 세트로 되붙는다.
 */
export function bucketsForScope(
  appSet: IndicatorSettingsByTimeframe,
  byWindow: Record<string, IndicatorSettingsByTimeframe>,
  scope: IndicatorScope,
): IndicatorSettingsByTimeframe {
  return scope.windowKey ? byWindow[scope.windowKey] ?? appSet : appSet;
}

/** 이 창이 자기 세트를 갖는가 — 값이 아니라 **키의 존재**로 판정한다. */
export function hasWindowIndicatorScope(
  byWindow: Record<string, IndicatorSettingsByTimeframe>,
  scopeKey: string | null,
): boolean {
  return scopeKey !== null && Object.hasOwn(byWindow, scopeKey);
}

/** 버킷 맵의 깊은 사본 — 시드용 공개 판(`cloneBucketMap` 과 같은 규율). */
export function cloneIndicatorBuckets(
  source: IndicatorSettingsByTimeframe,
): IndicatorSettingsByTimeframe {
  return cloneBucketMap(source);
}

/** 전환 시드 (#697 결정 변경): v1 의 분봉 관점 유효 설정(flat ⊕ 구
 *  panePrefsByTimeframe.minute)을 새 공장값과 diff 해 minute 버킷에 심는다.
 *  D/W/M 버킷은 시드 없음 — 구 D/W/M pane 오버라이드는 폐기. paneOrder 는 이관. */
export function seedV2FromV1(v1raw: unknown): PersistedIndicatorsV2 {
  const v1 = mergeLiveIndicatorPrefs(v1raw);
  const minuteView: IndicatorSettings = { ...stripContainers(v1) };
  // v1 blob 은 **정의상 레거시**라 마스터 4형제가 언제나 실려 있다(코어서가 기본값을
  // 채운다). 그래서 v2 버킷과 달리 키 존재를 물을 필요 없이 무조건 접는다.
  minuteView.movingAverages = withAllSlotsEnabled(
    minuteView.movingAverages,
    v1.movingAverageEnabled && !v1.movingAverageHidden,
  );
  minuteView.dailyMovingAverages = withAllSlotsEnabled(
    minuteView.dailyMovingAverages,
    v1.dailyMovingAverageEnabled && !v1.dailyMovingAverageHidden,
  );
  const minutePanePrefs = normalizePanePrefsByTimeframe(v1.panePrefsByTimeframe).minute ?? {};
  for (const key of INDICATOR_PANE_PREF_KEYS) {
    const override = minutePanePrefs[key];
    if (typeof override === 'boolean') minuteView[key] = override;
  }
  const minuteDiff = diffIndicatorSettingsFromFactory(minuteView);
  const seededPaneOrder = normalizePaneOrder(v1.paneOrder);
  return {
    paneOrder: seededPaneOrder,
    // v1 엔 그룹 개념이 없다 — 순서의 싱글턴 파생. 그룹 단위 오버라이드도 없다.
    paneGroups: paneGroupsFromOrder(seededPaneOrder),
    paneAxisMode: {},
    paneGroupStretch: {},
    // v1 블롭에 paneStretch 가 있으면 이관(구 프로덕션 v1 엔 없어 대개 {}).
    paneStretch: normalizePaneStretch((v1raw as { paneStretch?: unknown } | null)?.paneStretch),
    byTimeframe: Object.keys(minuteDiff).length > 0 ? { minute: minuteDiff } : {},
    // 창 축도 없었다. 빈 맵이면 마운트 시드가 각 창에 이 값을 복사한다(ADR-0152).
    byWindow: {},
  };
}

export function persistIndicatorsV2(state: PersistedIndicatorsV2): void {
  try {
    localStorage.setItem(INDICATORS_V2_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — silent fallback.
  }
}

/** 저장된 v2 를 그대로 읽는다 — 시드도 마이그레이션도 하지 않는다.
 *  다른 탭의 쓰기를 storage 이벤트로 받아 재수화하는 경로(`crossTabSync`)가 쓴다.
 *  없거나 손상이면 공장 기본. */
export function readIndicatorsV2Storage(): PersistedIndicatorsV2 {
  try {
    const raw = localStorage.getItem(INDICATORS_V2_STORAGE_KEY);
    return normalizeIndicatorsV2(raw ? JSON.parse(raw) : undefined);
  } catch {
    return normalizeIndicatorsV2(undefined);
  }
}

/** v2 로드. 우선순위는 ① 창 소유 시절 설정 1회 승격 → ② v2 → ③ v1 1회 시드 →
 *  ④ 공장 클린 스타트. ①이 ②보다 먼저인 것이 요점이다 — 창 사본이 있으면 그게
 *  사용자의 현재 구성이고, 그 기간 동안 v2 는 아무도 갱신하지 않았다
 *  (`indicatorsWindowMigration` 도크스트링). */
export function loadIndicatorsV2Storage(): PersistedIndicatorsV2 {
  try {
    const fromWindows = takeWindowIndicatorsForMigration();
    if (fromWindows) {
      const migrated = normalizeIndicatorsV2(fromWindows);
      persistIndicatorsV2(migrated);
      return migrated;
    }
    const rawV2 = localStorage.getItem(INDICATORS_V2_STORAGE_KEY);
    if (rawV2) return normalizeIndicatorsV2(JSON.parse(rawV2));
    const rawV1 = localStorage.getItem(V1_STORAGE_KEY);
    if (rawV1) {
      const seeded = seedV2FromV1(JSON.parse(rawV1));
      persistIndicatorsV2(seeded);
      return seeded;
    }
    return normalizeIndicatorsV2(undefined);
  } catch {
    return normalizeIndicatorsV2(undefined);
  }
}
