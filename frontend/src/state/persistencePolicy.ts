/**
 * 영속 정책 선언 — **아무것도 import 하지 않는 leaf**.
 *
 * 43개 storage 키 중 **33개(77%)가 같은 관례**를 쓴다: localStorage 에 쓰고, 런타임은
 * 탭마다 자기 메모리를 그리고, 저장소는 **다음 로드의 시드**일 뿐이다. 그게 기본이므로
 * 여기 적지 않는다 — 이 파일은 **기본에서 벗어난 키만** 담는다(현재 10개).
 *
 * 전수 표를 만들지 않은 것은 게으름이 아니라 강제할 수 없어서다. 키 상수의 다수가
 * 비-export 이고, 인라인 리터럴이 2건(`watchlist.collapsed` · `hoga.perf.debug`),
 * 동적 키가 1건(`replay.drawings.v2.<code>|<slot>`)이다. 키 리터럴을 파싱하는 가드는
 * 조용히 틀리고, **한 번도 빨개진 적 없는 가드는 아무것도 증명하지 못한다.**
 *
 * ## 이 선언이 막는 것
 *
 * `persistencePolicy.test.ts` 가 두 방향으로 잠근다:
 *   - **선언 → 소스**: 여기 적힌 키가 소스에서 사라지면 빨강(죽은 선언).
 *   - **소스 → 선언**: 크로스탭 구독(`addEventListener('storage'`)이 늘거나 줄면 빨강.
 *     `hydrate*FromStorage` 를 **정의했는데** 여기에도 `INTENTIONALLY_UNSYNCED` 에도
 *     없으면 빨강.
 *
 * 두 번째가 핵심이다. `live.investorEstimateUnit.v1` 이 정확히 그 모양으로 조용히
 * 깨져 있었다 — `hydrateFromStorage` 는 만들어져 있는데 아무도 부르지 않아, 저장은
 * 공유(localStorage)인데 읽는 시점이 모듈 로드 한 번뿐이었다. 먼저 띄워 둔 탭만 옛
 * 단위로 남았고, 화면은 정상으로 보였다. 그 버그를 실제로 잡은 판별식이
 * **「기계는 정의됐는데 배선이 없다」** 였으므로 요구로 승격한다.
 *
 * ## 이 선언이 **못 보는 것** (읽는 사람이 알아야 한다)
 *
 * - **이름 규칙을 벗어난 새 하이드레이션.** 가드는 `hydrate*FromStorage` 라는 이름으로
 *   발견한다. 다른 이름을 쓰면 스캔이 못 본다 — 자동 발견의 한계이고, 이름 매칭을
 *   전수 발견으로 확장하지 않는 것은 의도적이다(오탐과 누락이 둘 다 조용하다).
 * - **기본 관례를 쓰는 33키.** 여기 없다고 "검토됐다" 는 뜻이 아니라 "기본이다" 는
 *   뜻이다. 새 키가 기본과 다르면 **여기 추가하는 것이 등록 의무**다.
 * - **저장 포맷·마이그레이션.** 정책만 담는다. 페이로드 검증은 각 스토어의 몫이다.
 */

/**
 * 기본(localStorage · 탭 로컬 런타임 · 저장소는 다음 로드의 시드)에서 벗어난 방식.
 *
 * - `shared-synced`: localStorage + `storage` 이벤트 구독. 한 탭에서 바꾸면 열려 있는
 *   다른 탭이 **리로드 없이** 따라온다. 사용자가 "앱 설정" 으로 이해하는 값들이며,
 *   대가로 **탭을 나눠 두 값을 비교하는 사용법이 죽는다**(명시적으로 받아들인 것).
 * - `tab`: sessionStorage. "이 탭에서 지금 무엇을 보는가" 에 해당하는 뷰 상태.
 * - `tab-authoritative-shared-seed`: 권위는 sessionStorage 이고 localStorage 에도 함께
 *   써서(write-through) **다음에 열리는 새 탭의 시드**로 남긴다. 전체 스냅샷을 쓰는
 *   스토어가 여러 탭에서 서로를 덮어쓰는 것을 막으면서 "처음 여는 탭이 빈 화면" 을
 *   피하는 조합이다.
 * - `signal`: 값을 나르지 않는다. 진실이 서버에 있어 "다시 읽어라" 만 알린다.
 */
export type PersistencePolicy =
  | 'shared-synced'
  | 'tab'
  | 'tab-authoritative-shared-seed'
  | 'signal';

export interface PersistenceDecl {
  /** storage 키 문자열. 가드가 소스에 실재하는지 대조한다. */
  readonly key: string;
  /** 키를 소유한 모듈(`src/` 기준 경로). 사람이 찾아가기 위한 것. */
  readonly module: string;
  readonly policy: PersistencePolicy;
  /**
   * 이 키를 재수화하는 스토어 메서드 — **키 소유 모듈과 다를 수 있다.**
   * `live.indicators.v2` 가 그 경우다(키는 `indicatorSettingsV2`, 하이드레이터는
   * `livePage`). 그래서 이 필드가 `module` 과 별도로 있다: 둘을 같다고 가정한
   * join 은 조용히 틀린다.
   *
   * 없는 경우 두 가지 — 하이드레이터가 스토어 메서드가 아니거나
   * (`chartPrefsPersistence` 의 자유 함수 `hydrateChartPrefs`), 애초에 재수화가
   * 없는 정책(`tab` · `signal`)이다.
   */
  readonly hydrator?: { readonly module: string; readonly method: string };
  /** 왜 기본이 아닌가. 한 줄로 — 이유 없는 이탈은 다음 사람이 되돌린다. */
  readonly note: string;
}

export const NON_DEFAULT_PERSISTENCE: readonly PersistenceDecl[] = [
  {
    key: 'ui.themePreference.v1',
    module: 'state/themePrefs.ts',
    policy: 'shared-synced',
    hydrator: { module: 'state/themePrefs.ts', method: 'hydrateFromStorage' },
    note: '테마는 앱 전체의 외관 — 한 탭만 어두운 것은 설정이 아니라 고장으로 보인다.',
  },
  {
    key: 'live.venue.v1',
    module: 'state/liveVenue.ts',
    policy: 'shared-synced',
    hydrator: { module: 'state/liveVenue.ts', method: 'hydrateFromStorage' },
    note: '거래소는 탭 전역(2026-08-07 결정). 탭을 나눠 KRX·NXT 를 비교하는 사용법은 포기하고 툴바 선택기(#1179)로 대체했다.',
  },
  {
    key: 'live.investorEstimateUnit.v1',
    module: 'state/investorEstimateUnit.ts',
    policy: 'shared-synced',
    hydrator: { module: 'state/investorEstimateUnit.ts', method: 'hydrateFromStorage' },
    note: '단위(주/억)가 갈리면 나란히 놓고 비교하는 일 자체가 불가능하다 — 거래소와 같은 축(2026-08-17).',
  },
  {
    key: 'live.investorDailySpan.v1',
    module: 'state/investorDailySpan.ts',
    policy: 'shared-synced',
    hydrator: { module: 'state/investorDailySpan.ts', method: 'hydrateFromStorage' },
    note: '일별 투자자 창의 표시 기간. 단위(위 항목)와 같은 축 — 기간이 갈리면 두 창을 나란히 놓고 비교하는 일 자체가 불가능하다.',
  },
  {
    key: 'live.indicators.v2',
    module: 'state/indicatorSettingsV2.ts',
    policy: 'shared-synced',
    hydrator: { module: 'state/livePage.ts', method: 'hydrateIndicatorsFromStorage' },
    note: '「지표」 드로어라는 한 표면. 구독은 state/livePage.ts 에 산다 — 재수화가 버킷·레이아웃·ambient 투영을 함께 갱신해야 하기 때문(ADR-0072·ADR-0146).',
  },
  {
    key: 'hoga.chart.prefs.v1',
    module: 'state/chartPrefsPersistence.ts',
    policy: 'shared-synced',
    note: '같은 「지표」 드로어의 나머지 절반. 둘 다 동기화하지 않으면 한 드로어 안에서 일부 행만 따라온다.',
  },
  {
    key: 'live.settings.ping.v1',
    module: 'api/liveSettings.ts',
    policy: 'signal',
    note: '진실이 서버라 값을 복제하지 않는다. 서버에 필드가 늘어도 프론트는 그대로다.',
  },
  {
    key: 'live.activePreset.v1',
    module: 'state/liveLayout.ts',
    policy: 'tab',
    note: '"이 탭이 마지막에 적용한 프리셋" 은 본질적으로 탭의 것. 공유였을 때 다른 탭의 선택이 이 탭을 이겼다.',
  },
  {
    key: 'live.workspace.v1',
    module: 'state/workspaceKeys.ts',
    policy: 'tab-authoritative-shared-seed',
    note: '창 배치 전체 스냅샷이라 공유면 두 탭이 서로를 덮어쓴다. 딥링크 탭은 shared 쓰기를 건너뛴다(그 탭의 배치는 남길 것이 아니다).',
  },
];

/**
 * `hydrate*FromStorage` 를 **정의했지만 의도적으로 크로스탭에 배선하지 않은** 스토어.
 *
 * 여기 있다는 것은 "검토했고 안 하기로 했다" 는 뜻이다. 비어 있는 채로 두는 것이
 * 목표가 아니다 — **사유 없이 배선만 빠진 상태와 구별하는 것**이 목표다. 그 구별이
 * 없던 동안 `investorEstimateUnit` 이 조용히 깨져 있었다.
 */
export interface UnsyncedHydrateDecl {
  /** `hydrate*FromStorage` 를 정의한 모듈(`src/` 기준). */
  readonly module: string;
  /** 그 메서드 이름 — 한 모듈이 둘을 가질 수 있다(livePage 가 그렇다). */
  readonly method: string;
  /** 왜 배선하지 않는가. */
  readonly reason: string;
}

export const INTENTIONALLY_UNSYNCED: readonly UnsyncedHydrateDecl[] = [
  {
    module: 'state/livePage.ts',
    method: 'hydrateFromStorage',
    reason:
      '`live.page.v1` 은 활성 종목·봉이다. 두 탭이 다른 종목을 보는 것이 딥링크의 목적이므로 크로스탭은 기능을 죽인다. 같은 모듈의 `hydrateIndicatorsFromStorage` 는 다른 키(`live.indicators.v2`)이고 배선돼 있다.',
  },
];
