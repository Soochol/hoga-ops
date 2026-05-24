# Replay tab persistence — design

**Status:** Draft
**Date:** 2026-05-24
**Owner:** frontend

## Problem

`/replay` 탭(종목·기간·분봉·차트 prefs)은 현재 **URL 쿼리스트링에만** 살아있다.

- F5 또는 URL이 보존된 진입(북마크/히스토리): 탭 selection 복원 ✅
- `/replay`로 깨끗하게 진입(쿼리 없음), 다른 nav에서 클릭: **빈 탭 1개로 리셋** ❌
- 모든 경로: 차트 prefs(MA, 토글, volume profile mode)는 **항상** 기본값으로 리셋 ❌

사용자 요구: **명시적으로 탭 X 버튼을 누르기 전까지** 모든 탭과 prefs를 유지하고 싶다.

## Goal

다음 시나리오 모두에서 마지막 세션이 복원된다:

| 진입 경로 | 복원 소스 | 결과 |
|---|---|---|
| F5 / URL 보존 진입 | URL (`?tabs=…`) | URL이 진실 |
| `/replay` 깨끗 진입 | localStorage | 마지막 세션 |
| 좌측 nav 통한 진입 | localStorage | 마지막 세션 |
| 시크릿 창 | (없음) | 빈 탭 1개 |
| 여러 브라우저 탭 동시 사용 | 각자 자기 URL | 충돌 없음, localStorage는 "마지막 write" |

## Non-goals

- **bundles 영속화 금지** — 데이터 자체는 백엔드/디스크 캐시가 진실. 복원 후 자연스럽게 다시 fetch.
- **cursorMs 영속화 금지** — "마지막에 보던 자리"를 저장하지 않는다. 사용자가 옵션 1을 명시적으로 선택.
- **toolbarDraft 영속화 금지** — 미커밋 입력값은 세션 간에 의미 없음.
- **여러 브라우저 탭 실시간 동기화 금지** — `storage` 이벤트 구독 없음. 충돌 모델만 복잡해진다.
- **sessionStorage 분기 없음** — "브라우저 탭마다 따로 마지막 상태 기억" 요구는 없음. localStorage 단일 슬롯.

## Architecture

기존 [`replayLayout.ts`](../../../frontend/src/state/replayLayout.ts) 패턴을 그대로 차용한다:

1. **로드**: 모듈 로드 시 `loadPersisted()` 호출 → 검증 → 기본값 fallback
2. **저장**: 스토어에 `subscribe()` 한 번 걸고 매 변경마다 `savePersisted()` (디바운스 250ms)
3. **버전 키**: 스토리지 키 자체에 버전 포함(`replay.tabs.v1`). 스키마 깨지면 키 바꿔서 자연스럽게 폐기.

> **용어 주의 (G1)**: `replay.session.v1` 같은 키는 CONTEXT.md의 "Regular Session" / "Half-Day Session"과 의미 충돌. 키는 `replay.tabs.v1`로 — "Replay Tab"이라는 도메인 용어와 일치.

### Storage schema

**Key:** `replay.tabs.v1`

**Payload:**
```ts
type PersistedTab = {
  selection: TabSelection | null;
  // Partial — 알려진 키만 채택, 누락 키는 DEFAULT_PREFS에서 보강. (G2)
  prefs: Partial<ChartViewPrefs>;
};

type ReplayTabsSnapshot = {
  version: 1;
  savedAt: number;            // unix ms, 디버깅/관찰용
  activeIndex: number;        // tabs 내 인덱스 (id가 아닌 인덱스); 범위 밖이면 0으로 clamp (G3)
  tabs: PersistedTab[];       // 빈 배열 가능 → fallback 시 fresh 1개
};
```

**저장 항목 명시:**

| 필드 | 저장? | 이유 |
|---|---|---|
| `Tab.selection` | ✅ | 사용자 요구 핵심 |
| `Tab.prefs` (전체) | ✅ | 사용자 요구 |
| `activeTabId` → `activeIndex` | ✅ | 어느 탭에서 멈췄는지 |
| `Tab.bundles` | ❌ | 백엔드가 진실, 다시 fetch |
| `Tab.cursorMs` | ❌ | non-goal |
| `Tab.status`, `Tab.errorMessage` | ❌ | 런타임 derived |
| `Tab.id` | ❌ | 새 세션에서 새로 발급 (nanoid) |
| toolbarDraft | ❌ | non-goal |

### Load 흐름 (ReplayViewer mount)

```
mount
  ├─ URL에 ?tabs=... 있나?
  │   ├─ YES → 기존 parseReplayUrl 흐름 (현재 동작 유지)
  │   └─ NO  ↓
  ├─ localStorage["replay.session.v1"] 있나?
  │   ├─ YES + 유효 → 스냅샷에서 탭 복원 (selection + prefs + active)
  │   └─ NO / 무효 → 현재 동작 (빈 탭 1개)
```

**유효성 기준 (G2, G3):**

1. JSON 파싱 성공 + `version === 1` + `tabs`가 배열 → 통과
2. **selection 검증**: `null`이거나 (code `^\d{6}$`, fromDate/toDate `^\d{8}$`, timeframe ∈ `TIMEFRAME_LABELS`) 모두 valid. 하나라도 어긋나면 그 entry의 selection을 `null`로 보정 (탭은 살리고 빈 상태로).
3. **prefs 병합**: `Partial<ChartViewPrefs>` → `{...DEFAULT_PREFS, ...persisted}`. 알려진 키만 유효 타입일 때 채택, 알 수 없는 키는 무시. `movingAverages`는 길이/원소 타입이 어긋나면 통째로 default 사용.
4. **activeIndex clamp**: `tabs.length === 0` → fresh 탭 1개 시드 + `activeIndex = 0`. 0 ≤ activeIndex < tabs.length 보장.

### Save 흐름

모듈 로드 시점에 `useTabsStore.subscribe()` 한 번:

```ts
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useTabsStore.subscribe((state) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePersisted(toSnapshot(state));
  }, 250);
});
```

디바운스 250ms — slider drag 같은 고빈도 변경에서 localStorage 쓰기 폭주 방지. `replayLayout`은 디바운스 없는데, 그쪽은 slider 두 개만 영향이라 트래픽이 적다. tabs/prefs는 MA period spinner 등 더 자주 변한다.

### URL과 localStorage의 관계

- **동시 저장**: 모든 변경은 URL과 localStorage **둘 다** 업데이트
- **로드 시 우선순위**: URL > localStorage > default
- **충돌 시나리오 없음**: URL이 있으면 URL 우선이므로, "localStorage가 URL을 덮어쓰는" 케이스가 원천 차단
- **Hydration 방향 (G4, G7)**: URL hydration이 일어나면 `setSelection` 호출이 즉시 발생하고 디바운스 저장기가 250ms 뒤 그 상태를 localStorage에 기록. 즉 **URL → localStorage 단방향 동기화**가 정상 동작이다. 결과:
  - URL을 받은 사용자의 localStorage는 그 URL 상태로 덮어쓰여진다 (의도된 동작 — 공유 받은 링크가 새 "마지막 세션"이 된다).
  - 클린 진입 시에도 직전에 URL로 봤던 상태가 살아남는다.

### prefs Map 시드 (G5)

`useTabsStore`는 `tabs: Tab[]`과 `prefs: Map<string, ChartViewPrefs>`를 **별개로** 유지. 둘은 `tab.id`로 연결됨. 따라서 `fromSnapshot(snapshot)`은 한 트랜잭션에서 **둘 다** 빌드해 반환해야 한다:

```ts
function fromSnapshot(s: ReplayTabsSnapshot): {
  tabs: Tab[];
  prefs: Map<string, ChartViewPrefs>;
  activeTabId: string;
} {
  // 각 PersistedTab마다 새 nanoid를 발급하면서 Map<id, prefs>를 동시 빌드.
  // tabs.length === 0 이면 fresh() 1개 시드.
}
```

스토어 초기화 시 두 슬롯을 동시에 채워 일관성 보장.

## Files

### 신규
- `frontend/src/state/tabsPersistence.ts` — `loadPersisted`, `savePersisted`, `toSnapshot`, `fromSnapshot`, `STORAGE_KEY` 상수
- `frontend/src/state/tabsPersistence.test.ts` — 직렬화/역직렬화/검증/fallback 단위 테스트

### 수정
- `frontend/src/state/tabs.ts` — 모듈 끝에 `useTabsStore.subscribe(...)` 추가 (디바운스 저장). 초기 `tabs: [initial]` 대신 `loadPersisted()` 결과로 시드.
- `frontend/src/pages/ReplayViewer.tsx` — `useUrlSync` 안의 hydrate 로직 수정: URL 비어있으면 localStorage 시드를 그대로 두고(이미 store에 들어있음) early return. URL 있으면 기존대로 reset 후 URL에서 hydrate.

### 수정 안 함
- `frontend/src/state/url.ts` — URL 포맷 그대로
- `frontend/src/state/toolbarDraft.ts` — 영속화 대상 아님
- `frontend/src/state/replayLayout.ts` — 이미 localStorage. 건드릴 이유 없음

## Edge cases

| 케이스 | 동작 |
|---|---|
| localStorage 비활성(시크릿/quota) | `loadPersisted` → fallback, `savePersisted` → silent no-op (replayLayout 패턴 동일) |
| JSON 손상 | `JSON.parse` throw → catch → fallback |
| `version` 불일치 (예: v2 도입 후 다운그레이드) | version 체크 실패 → fallback. 키를 `v2`로 바꿨다면 v1 키는 그대로 남지만 절대 읽지 않음 (스토리지 청소는 별도 일감) |
| 저장된 종목 코드가 symbol master에서 사라짐 | selection은 그대로 복원 → 일반 fetch 에러 경로가 처리 (기존 `status: 'error'` 흐름) |
| 저장된 timeframe이 유효하지 않음(스키마 진화) | G2 규칙 따름 — entry의 selection만 `null`로 보정, 탭 자체는 살리고 prefs 유지. 사용자는 onboarding 카드로 다시 종목 선택 가능 |
| 빈 탭 목록 저장 (G6) | `closeTab` invariant: `tabs.length >= 1` 항상 유지 (현재 코드의 `length <= 1` no-op 가드). 따라서 발생 불가. 방어적으로 빈 배열도 받아 fallback으로 fresh 1개 시드 |
| URL 공유 받은 사용자의 localStorage 오염 (G7) | 의도된 동작. URL이 적용되는 순간 디바운스 저장기가 localStorage를 새 상태로 갱신. 이후 클린 진입 시 공유받은 상태가 복원됨 |
| 두 브라우저 탭에서 동시 변경 | 마지막 write가 localStorage 차지. 각자 자기 URL이 진실이라 운영 중에는 영향 없음. 클린 진입 시 "마지막 만진 것" 복원 |
| HMR로 모듈 재로드 | Vite HMR이 모듈을 재실행하면 새 콜백으로 `subscribe()`가 다시 걸려 누적된다. 디바운스 타이머가 있는 만큼 누적되면 dev 환경에서 매번 N회 저장이 발생. `import.meta.hot?.dispose(unsub)` 로 이전 subscription을 해제 (production 빌드에는 `import.meta.hot` 없으므로 영향 없음). `replayLayout`은 디바운스 없고 트래픽이 적어 dispose 가드 없이도 무해했지만, 본 spec은 추가한다 |

## Testing

### 단위 (`tabsPersistence.test.ts`)
1. `toSnapshot` — Tab[] → 직렬화 가능한 형태로, bundles/cursorMs/status/id 제외 확인
2. `fromSnapshot` — 스냅샷 → Tab[] 복원, 새 id 발급, status='empty', bundles=빈 Map
3. `loadPersisted` — 정상 페이로드 → 원본 복원
4. `loadPersisted` — 손상 JSON → fallback
5. `loadPersisted` — version 불일치 → fallback
6. `loadPersisted` — 일부 entry invalid (잘못된 timeframe) → 해당 entry drop, 나머지 유지
7. `loadPersisted` — localStorage undefined → fallback
8. `savePersisted` — localStorage throw → silent

### 단위 — prefs 병합 / clamp (G2, G3 신규)
9. `loadPersisted` — prefs에 알 수 없는 키 포함 → 무시
10. `loadPersisted` — `movingAverages` 길이가 4 (정상 5) → 통째로 default
11. `loadPersisted` — `volumeProfileMode`가 알 수 없는 값 → default로 보강
12. `loadPersisted` — `activeIndex`가 tabs.length 이상 → 0으로 clamp
13. `loadPersisted` — 일부 selection invalid (잘못된 timeframe) → 해당 entry의 selection만 null로 보정, 탭은 유지
14. `loadPersisted` — `tabs: []` (빈 배열) → fresh 1개 시드, activeIndex=0

### 통합 (`ReplayViewer` 또는 `tabs.test.ts` 확장)
15. URL 있음 + localStorage 있음 → URL이 이김 (그리고 250ms 뒤 localStorage가 URL 상태로 갱신)
16. URL 없음 + localStorage 있음 → localStorage 복원
17. URL 없음 + localStorage 없음 → 빈 탭 1개
18. 탭 추가 → 250ms 뒤 localStorage 반영
19. 탭 닫기 → 250ms 뒤 localStorage에서도 제거
20. prefs 변경(MA period) → 250ms 뒤 반영

### 수동 검증
21. 브라우저 종료 후 `/replay` 깨끗 진입 → 마지막 세션 복원
22. 좌측 nav `/inventory` → `/replay` → 마지막 세션 복원
23. 시크릿 창 → 빈 탭 1개
24. DevTools에서 v1 키 손상 → 새로고침 시 fallback, console warn

## Open questions

없음. 진행 가능.

## Out of scope / 후속

- 스토리지 스키마 마이그레이션 유틸리티(v1→v2). 지금은 폐기 + 시드.
- 탭/세션 export-import (json 파일). 사용자가 명시적으로 요구하면 추가.
- 여러 브라우저 탭 간 실시간 동기화(`storage` 이벤트). 의도적으로 안 함.
