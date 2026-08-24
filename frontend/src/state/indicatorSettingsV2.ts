import type { PaneId } from '../chart/drawing/types';
import { normalizePaneOrder, normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import {
  mergeLiveIndicatorPrefs,
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

/** 버킷 하나가 담는 지표 설정 전체 — v1 `PersistedIndicators` 에서 per-timeframe
 *  컨테이너(panePrefsByTimeframe)와 레이아웃(paneOrder·paneStretch)만 뺀 것.
 *  paneStretch(#703)는 paneOrder 와 함께 v2 레이아웃 슬라이스에 산다(버킷 아님). */
export type IndicatorSettings =
  Omit<PersistedIndicators, 'panePrefsByTimeframe' | 'paneOrder' | 'paneStretch'>;

export type IndicatorSettingsByTimeframe =
  Partial<Record<IndicatorPaneProfileKey, Partial<IndicatorSettings>>>;

export type PersistedIndicatorsV2 = {
  paneOrder: PaneId[];
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
  const { panePrefsByTimeframe: _p, paneOrder: _o, paneStretch: _s, ...settings } = v1;
  return settings;
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
    const patch = sanitizeSettingsPatch(rawBuckets[profileKey]);
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
  return {
    paneOrder: normalizePaneOrder(obj.paneOrder),
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
  const minutePanePrefs = normalizePanePrefsByTimeframe(v1.panePrefsByTimeframe).minute ?? {};
  for (const key of INDICATOR_PANE_PREF_KEYS) {
    const override = minutePanePrefs[key];
    if (typeof override === 'boolean') minuteView[key] = override;
  }
  const minuteDiff = diffIndicatorSettingsFromFactory(minuteView);
  return {
    paneOrder: normalizePaneOrder(v1.paneOrder),
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
