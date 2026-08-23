# `/study`(복기) 페이지 삭제 검토

**작성일:** 2026-08-23 · **상태:** **실행 완료**(PR #1509) · **결정 주체:** 사용자

> **결정 (2026-08-23)** — §2.2 「저장뷰 여럿을 나란히」는 **유지하지 않는다.** 따라서
> 삭제는 이식이 아니라 삭제이고, ADR-0155 의 링크 그룹은 `/study` 와 함께 사문화된다.
> 소킹(§6 2단계)도 건너뛰고 한 PR 로 간다는 것이 같은 결정의 일부다.
>
> **실측 결과** — PR #1509 전체 101 파일 · **+1,008 / −10,400 라인**(삭제 커밋 단독은
> 83 파일 +442/−10,207). 추정(≈9,359)과의 차이는 §9 가 설명한다. 초기 로드는 **−8.1 KB** 로, CLAUDE.md 가 인용하는 「study-views 72KB」와
> 자릿수가 다르다(그 숫자는 **청크 크기**이지 초기 로드 몫이 아니다).

## 0. 한 줄 권고

**삭제에 찬성한다. 단계적으로 — 그리고 §5 의 선행 작업을 먼저.**
`/study` 는 2026-08-21 에 이미 주 진입로를 잃었고, 남은 값은 **워크플로 하나**로 좁혀진다:
**저장뷰 여럿을 한 화면에 나란히**. 그 하나의 처분이 이 결정의 전부이고 나머지는 기계적이다.

기능 델타를 1차 출처로 세어 본 결과 **차트에서 보이는 것의 차이는 사실상 없다**(§2).
문서(CONTEXT.md)가 기록한 최대 차이 — "`/study` 만 캘린더 봉에서 호가 지표를 본다" — 는
**코드에서 이미 사라진 stale 서술**이었다.

## 1. 왜 지금인가 — 궤적은 이미 삭제를 향한다

| 날짜 | 사건 | 방향 |
| --- | --- | --- |
| 2026-08-17 | ADR-0149 — 저장뷰 탭 스트립 제거, 단일 활성 뷰 | `/study` 축소 |
| 2026-08-21 | ADR-0155 — 링크 그룹 도입(`/live` 의 #711 모델을 이식) | `/live` 로 수렴 |
| 2026-08-21 | PR #1452 — **저장뷰 행 클릭·Enter·행 메뉴 「열기」의 목적지를 `/live` 로 이전** | `/study` 진입로 상실 |

세 번째가 결정적이다. `StudyViewsDrawer.tsx:260-305` 의 주석이 현재 상태를 직접
기록한다 — `openStudyView`(→`/study`)의 **소비자가 하나만 남았다**(캔버스 그룹 드롭),
그리고 같은 파일 302-303 행:

> `ctrl/⌘+클릭은 이 경로를 타지 않는다. 그쪽은 아직 /study 새 탭이다`
> `(/live?view= 딥링크는 /study 제거 시 함께 만든다).`

즉 **삭제는 이미 코드에 예정된 것으로 적혀 있다.** 이 문서는 그 예정을 검증하고 델타를
세는 것이지 새로 제안하는 것이 아니다.

### 유지 비용의 실측 — 쌍둥이 세금

최근 60일(2026-06-24~08-23) `frontend/src/studyViews/` 를 건드린 커밋 **243건** 중
**133건(55%)이 `frontend/src/live/` 를 함께 건드렸다.** 커밋 제목이 그 성격을 말한다:

- `refactor(chart): 창 간 크로스헤어 동기화에서 Study 접두를 걷어낸다 — /live 도 쓴다 (#1289)`
- `fix(workspace): /live·/study 창 영역 일치 — 여백 소유자를 한 곳으로`
- `feat(indicators): 지표 세트를 페이지별로 — /live ↔ /study 분리, 창별 분리는 제거`
- `refactor(settings): /live·/study 툴바의 설정 버튼 제거 — 진입점을 상단 하나로`

두 페이지가 **같은 차트 창·같은 워크스페이스·같은 지표 스토어**를 쓰면서 소유권 축만
갈라져 있어, 기능 하나가 들어올 때마다 "이 축은 페이지별인가 창별인가" 를 두 번 결정하고
두 번 배선한다. ADR-0145·0152 가 그 결정의 화석이다. 페이지가 하나면 그 질문이 사라진다.

## 2. 기능 델타 — 실측

### 2.1 캘린더 봉(D/W/M)의 호가 지표는 **델타가 아니다** (문서가 stale)

CONTEXT.md:387 은 이렇게 적고 있다:

> **저장 학습뷰** is the deliberate exception: `/study` reads hogaplay 1-minute parquet
> via `/api/range` and calendar-aggregates both candles and hoga indicators for D/W/M.

**코드는 그렇지 않다.** 추적 결과:

1. `useStudyReferenceBundle.ts:134` — `displayedSave = { ...win.save, timeframe: win.timeframe }`.
   즉 쿼리 입력의 봉은 저장된 봉이 아니라 **창이 표시 중인 봉**이다.
2. `studyReferenceBundleModel.ts:113-129` — `range`·`candles` 슬롯 전부
   `save && isMinute ? … : null`. 캘린더 봉이면 **`code: null`**.
3. `api/rangeRequest.ts:128` — `enabled = !!(input.code && …)`. → 호가 번들도 sidecar 도
   **요청되지 않는다**.
4. 같은 파일 122-129 의 ⚠ 주석이 경위를 남겼다 — "D/W/M 은 **예전에** 1분봉을 받아
   프론트에서 접었다… 두 소스의 주가 기준이 달라 섞으면 안 되고(액면분할 종목에서 봉
   하나가 1/5 로 튀었다) 섞어서 얻던 것도 없었다(5종목 실측)". 그 경로는 제거됐다.

결론: **`/study` 의 D/W/M 도 `/live` 와 똑같이 캔들 + 거래량뿐이다.** 캘린더 봉 손실 = 0.

부수 발견 두 가지(삭제와 무관하게 별도 정정 대상):
- **CONTEXT.md:387 을 고쳐야 한다.** 지금 서술은 존재하지 않는 능력을 약속한다.
- `StudyPage.tsx:686` 의 `forceHogaPanes: true` 는 캘린더 경로에서 **사실상 사문**이다
  (`LiveChartRoot.tsx:462` 의 술어가 `tradeVolumePocCount > 0` 을 함께 요구하는데 번들이
  비어 있다). 리포 전체에서 이 플래그를 켜는 곳은 여기 하나다.

### 2.2 저장뷰 여럿을 나란히 — **유일한 실질 손실이자 사용자 결정 지점**

ADR-0155(2026-08-21, **이틀 전**)의 링크 그룹이 정확히 이 워크플로를 위해 들어왔다:
한 페이지에서 창을 그룹 번호로 묶어 저장뷰 여럿을 동시에 편다.

`/live` 는 이걸 못 한다. `/live` 의 링크 그룹은 **종목**에 묶이고(`groupSymbols`),
저장 구간 슬롯 `savedRangeFocus` 는 **페이지 전역 하나**다(`state/livePage.ts:274`,
`focusSavedRange` 가 통째로 교체). 즉 `/live` 는 저장뷰를 **한 번에 하나만** 띄운다.

**"저장뷰 A 와 B 를 나란히 비교한다" 를 유지할 것인가가 이 삭제의 유일한 제품 질문이다.**

- 유지하지 않는다 → 삭제는 거의 순손실 없음. ADR-0155 는 이틀 만에 사문화된다.
- 유지한다 → `savedRangeFocus` 를 **창(또는 그룹)별 슬롯**으로 승격해야 한다. 그건
  `/study` 의 `studyWorkspace` 그룹 모델을 `/live` 로 옮기는 일이고, 작업 성격이
  **삭제가 아니라 이식**으로 바뀐다(규모 한 단계 위).

### 2.3 델타가 아닌 것들 (확인 완료)

| 항목 | 상태 |
| --- | --- |
| **메모 편집** | `StudyMemoPanel` 은 `/study` 전용이지만 **드로어가 이미 인라인 메모 편집을 갖는다**(`StudyViewsDrawer.tsx:163-355`, textarea + PATCH metadata). 전역 우측 레일이라 생존. |
| **v1 레거시 스냅샷 학습뷰** | **이미 존재하지 않는다.** `models.py:2116` `schema_version: Literal[2] = 2`, 프론트 `api/studyViews.ts:21` 도 2, `studyViewVariant()` 는 상수 `'reference'`. → **ADR-0077 의 v1 절도 stale**. |
| **KRX 고정 재현** | 보존. `savedRangeFocus.ts` 의 `SAVED_RANGE_VENUE = STUDY_VENUE` 를 `/live` 창이 이미 쓴다(ADR-0144 근거 공유). |
| **저장 구간 밴드·착석** | 보존. `StudySavedRangeBandHost` + `savedRangeAnchor.ts` 를 `LiveChartRoot` 가 소비 중. |
| **미캡처 안내** | **옮겼다.** `showNotCapturedNotice` 를 `ChartWindow` 가 `savedRange !== null` 로 켠다 — 근거가 페이지가 아니라 **구간의 성격**이었기 때문이다(`hogaMissingNotice` 의 `IGNORED_REASONS` 주석). 옮기지 않았으면 «델타가 아니다» 가 거짓이 될 뻔했다: 프롭은 남고 `true` 를 주는 곳이 사라져 기능이 **조용히** 죽는다. ⚠ **이 배선에는 테스트가 없다**(§9-6). |
| **분봉 저장 구간 재현** | 방식만 다르다 — `/study` 는 번들을 구간으로 **클립**하고 `/live` 는 **뷰포트를 옮긴다**(`savedRangeAnchor.ts` 도크스트링: "같은 차트가 실시간 스트림을 받고 있어 클립할 수 없다"). 보이는 결과는 같고, 현행 계약은 "데려다주되 가두지 않는다". |
| **e2e** | `/study` 를 타는 스펙 **0건**(`frontend/tests/e2e/` 전수 — README 언급 1줄뿐). |

## 3. 남는 것 — 저장뷰 **도메인**은 삭제 대상이 아니다

삭제되는 것은 **페이지(라우트)** 이지 저장뷰가 아니다. 다음은 전부 생존한다:

- 백엔드 `study_views.py`(158) + `study_view_routes.py`(106) + `test_study_views.py`(259)
  — `/api/study-views/saves*` 전체, 저장 파일 `<data_dir>/study_views/saves.json`,
  이벤트 `study_views_changed`.
- 우측 레일 **저장뷰 드로어**와 그 트리·검색·이름변경·메모·드래그.
- `/live` 차트 창의 **저장 버튼**(`LiveStudyViewSaveButton`)과 저장 다이얼로그.
- 저장 구간 밴드·착석·칩(`SavedRangeChip`)·안내(`savedRangeNotice`).

## 4. 삭제 목록과 정직한 수치

`studyViews/` 전체는 **11,142 라인**이지만 그 숫자를 삭제량으로 쓰면 과대계상이다.
드로어와 `/live` 소비 모듈을 시드로 한 **정적 import 폐쇄**로 갈랐다(동적 `import()`
간선은 추적하지 않았다 — 이 디렉터리엔 라우트/드로어 lazy 진입 외에 없다):

| 구분 | 소스 | 테스트 | 합 |
| --- | --- | --- | --- |
| `studyViews/` **잔존**(17 파일) | 2,215 | 1,961 | 4,176 |
| `studyViews/` **삭제**(22 파일) | 3,382 | 3,584 | 6,966 |
| `state/study*`(4 스토어 + 테스트, 전부 삭제) | — | — | 2,072 |
| 백엔드 레이아웃 프리셋(2 모듈 + 1 테스트) | — | — | 321 |
| **삭제 합계** | | | **≈ 9,359** |

삭제되는 주요 모듈: `StudyPage`(792) · `StudyChartWindow` · `StudyWorkspaceCanvas` ·
`StudyIndicatorDrawer` · `StudyWindowListMenu` · `StudyMemoPanel` · `studyWindow*` ·
`useStudyChartIndicators` · `useStudyRangeCacheEviction` · `useStudyReferenceBundle` ·
`studyReferenceQueries` · `studyReferenceBundleModel` · `studyActiveViewModel` ·
`studyDocumentTitle` · `studyTimeframeResolution` · `studyViewVariant` · `presets/*`(4) ·
`state/studyWorkspace`(947) · `state/studyLayout` · `state/studyActivePreset` ·
`state/studyLastMinuteTimeframe` · `hoga/api/study_layout_presets.py` ·
`hoga/api/study_layout_preset_routes.py`.

### ⚠ 잔존 파일도 무결하지 않다 — 잔존 쪽 수술 목록

폐쇄는 `studyViews/` **내부 간선만** 셌다. 잔존 드로어가 삭제 대상을 직접 참조한다:

- `StudyViewsDrawer.tsx:21` — `state/studyWorkspace` import(삭제 대상). 그룹 드롭
  경로(`openStudyView`)와 함께 제거해야 한다.
- `StudyViewsDrawer.tsx:376` — 활성 뷰 삭제 시 `navigate('/study')` 가드.
- `StudyViewsDrawer.tsx:482` — ctrl/⌘+클릭 → `openStudyViewInNewTab`(현재 `/study` 딥링크).
  §5-1 의 `/live?view=` 로 갈아탄다.

### 배선에서 함께 지울 곳

- `main.tsx:28-29, 91` — lazy import + `<Route path="study">`(→ `/live` 리다이렉트로 대체)
- `nav/items.ts` — `{ to: '/study', label: '복기', panel: 'savedViews' }` 1줄
  (`WorkspaceNavLabel` 타입 결속이 `studyDocumentTitle` 과 함께 풀린다)
- `App.tsx` — `PAGE_OWNED_TITLE_ROUTES` 에서 `/study` 제거,
  `settingsVariant = pathname.startsWith('/study') ? 'study' : 'live'` → `'live'` 고정
- `live/SettingsSections.tsx` · `live/settings/DataSourceDetail.tsx` — `variant='study'` 축
- `api/eventStream.ts:9, 74` — `study_layout_presets_changed` 축 + 키 import
- `routeSplitting.test.ts:29` — `./studyViews/StudyPage` 기대 제거
- **백엔드**: `hoga/api/app.py:48-50`(import — 51행 `study_view_routes` 는 **잔존**) ·
  `:490`(`include_router` — 488행 저장뷰 라우터는 **잔존**) ·
  `models.py:2200-2244`(`StudyLayoutPreset*` 4개 클래스) ·
  `tests/test_api_mutation_broadcast.py:66-67, 120-121`(`study-layout-presets` 케이스)
- localStorage 승계 처리: `study.workspace.v1` · `study.layout.v1` ·
  `study.activePreset.v1` · `study.lastMinuteTimeframe.v1` · `study.memoPanel.height.v1`
  (+ 이미 승계 전용인 `study.activeView.v1` · `study.tabs.v1`)
- 디스크: `<data_dir>/study_layout_presets/` 가 고아가 된다
  (`layout_preset_store.PresetStore(root_name=…)`). 저장뷰 본체
  `<data_dir>/study_views/saves.json` 은 **그대로 살아 있다 — 지우지 말 것.**

**번들 이득은 재측정이 필요하다.** `vite.config.ts:88-95` 와 CLAUDE.md 의
`study-views 72KB` 는 2026-07-30 실측이고 그 뒤 페이지가 커졌다. 잔존 17 파일은 드로어
경로로 초기 그래프에 계속 남으므로 **72KB 전부가 이득이 아니다** — 삭제 후
`npx vite build` 로 다시 잰다.

**REST wire 계약은 건드리지 않는다** — `test_rest_wire_schema_contract.py` 에
`StudyLayoutPreset*` 항목이 없다(2층에 `StudyViewReference.timeframe` 만 등록돼 있고
그건 잔존 대상). `EXPECTED_REST_WIRE_FIELDS` 축소 불필요.

## 5. 선행 작업 (삭제 PR 전에 끝나야 하는 것)

1. **`/live?view=` 딥링크** — 코드가 이미 약속한 항목(`StudyViewsDrawer.tsx:303`).
   ctrl/⌘+클릭의 목적지이자 기존 `/study?view=` 북마크의 착지점.
2. **§2.2 판정** — 나란히 비교를 유지한다면 이 작업은 삭제가 아니라 **이식**이 된다.
   여기서 갈린다.
3. (선택) CONTEXT.md:387 · ADR-0077 v1 절 정정 — 삭제와 독립이지만 같은 영역이라
   함께 처리하는 편이 싸다.

## 6. 실행 단계

### ⚠ 초안의 단계 구분이 틀렸다 (2026-08-23 실측)

초안은 1단계를 "`/live?view=` 딥링크 + 리다이렉트 + **nav 항목 제거**, 코드는 남긴다
(되돌리기 비용 0)" 로 잡았다. **nav 항목 제거만으로 타입체크가 깨진다:**

```
src/studyViews/studyDocumentTitle.ts(11,7): error TS2322: Type '"복기"' is not assignable to type 'never'.
src/studyViews/studyDocumentTitle.ts(11,40): error TS2344: Type '"/study"' does not satisfy the constraint …
```

`nav/items.ts` 의 `WorkspaceNavLabel<'/study'>` 결속(그 파일 주석이 "폴백을 손으로
복사하지 않고 타입으로 묶는다" 고 적은 바로 그것)이 살아 있는 StudyPage 코드를 붙잡기
때문이다. 즉 **"라우트만 끊고 코드는 그대로"** 라는 중간 상태는 존재하지 않는다 —
죽은 코드를 굳이 손봐야 타입이 통과한다. 그러면 중간 상태는 이득 없이 비용만 남는다.

### 고친 단계

- **1단계 (완료)** — `/live?view=` 딥링크. `/study` 는 **그대로 둔다.** nav 도 라우트도
  건드리지 않으므로 타입 결속이 걸리지 않고, 사용자는 `/live` 와 `/study` 를 **나란히
  두고 며칠 비교**할 수 있다. §8-1 의 소킹이 실제로 의미를 갖는 유일한 형태다.
- **2단계** — 소킹. `/live` 의 저장 구간 경험이 굳는지 본다.
- **3단계** — 삭제 한 PR: 라우트 → 리다이렉트 · nav 항목 · §4 전량 · `studyViews/` →
  `savedViews/` 개명. 되돌리기는 그 PR 의 revert 한 번이다.
- **4단계** — 문서: ADR 신규(0077·0123·0144·0149·0155 부분 supersede, 0149/0155 의
  「무효/유지」 형식) + CONTEXT.md 의 `/study` 항목 정리 + §2.1 의 stale 서술 정정.

## 7. 검증

```bash
cd frontend && npm run typecheck && npx vitest run && npx vite build
```

```bash
uv run --extra dev ruff check . && uv run --extra dev pytest -q -m 'not wallclock'
```

```bash
cd frontend && node_modules/.bin/playwright test
```

라우트 제거 특유의 확인:

- `routeSplitting.test.ts` · `App.test.tsx` — 라우트/제목 표 기대치
- `tests/test_api_mutation_broadcast.py` — 프리셋 축 제거 후 나머지 축 온전한가
- `api/eventStream` 축 테이블도 같은 확인
- `/study` 북마크·기존 브라우저 탭이 `/live` 로 착지하는가(딥링크 포함)
- 삭제 후 `npx vite build` 로 초기 로드 재측정(§4)

## 8. 리스크

1. **대체재가 아직 굳지 않았다.** 저장 구간 착석/벽은 2026-08-21 하루에 도입 →
   revert(#1457) → 재도입(#1461) 을 겪었다. 현행 계약("데려다주되 가두지 않는다")은
   **이틀 됐다.** 1단계(도달 불가)와 3단계(코드 삭제) 사이에 며칠을 두는 이유가 이것이다.
2. **ADR-0155 의 이틀 된 투자가 사라진다**(§2.2). 링크 그룹 원본은 `/live` 에 있으므로
   버려지는 것은 `/study` 쪽 이식분이다.
3. ~~**`studyViews/` 개명**~~ — **실행하지 않았다.** 착수했다가 되돌렸다(§9-2).
4. **문서가 코드보다 앞서 있었다**(§2.1). CONTEXT.md 를 근거로 델타를 세면 존재하지 않는
   손실을 지키느라 삭제가 막힌다 — 이 검토가 실제로 그럴 뻔했다.


## 9. 실행이 계획과 갈린 지점 (2026-08-23, 실측)

계획서를 그대로 따르지 않은 곳만 적는다. 셋 다 **작업 중 확인한 사실** 때문이다.

### 9-1. 단계 구분이 틀렸다 → 2단계(소킹)를 없앴다

§6 에 이미 적었다. 요약: nav 항목 한 줄만 지워도 `WorkspaceNavLabel<'/study'>` 결속이
타입체크를 깨서(TS2322·TS2344) **"라우트만 끊고 코드는 그대로"** 라는 중간 상태가 존재하지
않는다. 사용자가 소킹 대신 한 PR 을 택하면서 이 문제도 함께 사라졌다.

### 9-2. `studyViews/` → `savedViews/` 개명을 되돌렸다

계획서와 사용자 승인 항목에 있었고 실제로 `git mv` 까지 했다가 **되돌렸다.**

근거: 삭제된 것은 **페이지**(`StudyPage`)이지 도메인이 아니다. 그 도메인의 이름은
백엔드에서도 `hoga/api/study_views.py` · `/api/study-views/saves` 이고 CONTEXT.md 의
용어도 「저장 학습뷰」다. 프론트 디렉터리만 `savedViews/` 로 바꾸면 **ADR-0004 가 계약
표면으로 삼는 BE↔FE 손 미러가 이름에서부터 갈린다** — 그 리포에서 가장 비싸게 지키는
성질을 개명 하나로 흠집 내는 셈이다.

바꾸려면 백엔드 모듈·REST 경로·프론트를 한 번에. 그건 이 삭제와 독립된 작업이라 여기
넣지 않았다. 판단 근거는 `studyViews/studyDeepLink.ts` 도크스트링에도 남겼다.

**함수 이름은 바꿨다** — `studyViewDeepLinkPath` → `savedViewDeepLinkPath`. 그건 도메인이
아니라 **목적지**를 가리키던 이름이고, 목적지가 `/live` 로 바뀌었다.

### 9-3. 삭제량이 추정보다 컸다 (≈9,359 → 10,207)

차이는 전부 **테스트 정리**다. 추정은 "`/study` 만 쓰는 파일" 을 셌는데, 실제로는
`/live` 테스트들이 `/study` 를 **두 번째 워크스페이스(대조군)로** 쓰고 있었다:

| 파일 | 처분 | 근거 |
| --- | --- | --- |
| `windowView.handle.test.tsx` | 삭제 | 파일 자신의 설계 원칙이 "가짜 스토어를 만들면 #906 전제를 우회한다" 였다. 실제 두 번째 스토어가 사라진 이상 그 원칙을 지킬 방법이 없다. |
| `windowView.scope.test.tsx` | 유지(지역 픽스처) | 지키는 것이 페이지 격리가 아니라 **영속 데이터**(`studyByTimeframe`)로 바뀌었다. 그 축은 아직 살아 있다. |
| `indicatorScopeGc.test.ts` | 접두사 `'live'` 로 | GC 함수는 접두사에 대해 일반적이라 축이 바뀌어도 같은 코드를 탄다. `/study` 창 닫기 게이트 케이스만 삭제(그 불변식이 `/study` 전용이었고, `/live` `closeWindow` 엔 애초에 없다 — 확인 완료). |
| `entryDrag.test.ts` | 케이스 2건 삭제 | 등록 가능한 드롭 타깃이 `liveChart` 하나가 됐다. **그 케이스들은 `as unknown as` 캐스트로 스토어에 닿아 타입체크가 조용했다** — 런타임에서야 깨졌다. |
| `topnav-clock.spec.ts`(e2e) | 폭 1280 → 1100 | nav 가 한 항목 짧아져 1280 에서 **경합이 사라졌다**(실측 오프셋 1280:0.0 · 1180:42.1 · 1100:82.1). 그대로 뒀다면 "잘리는 대신 밀렸다" 단언이 0 을 검사하는 무력한 가드가 됐다. |

프로덕션 코드에서도 죽은 분기 둘을 함께 걷었다 — `QuoteLevelLines` · `QuoteTotalsConfig`
의 「최고 수평선은 `/live` 전용」 게이트(`useWindowIndicatorPage() !== 'study'`).

### 9-4. 남긴 것 — **한 페이지짜리 일반화** (별도 PR 에서 완료)

> **후속 결과 (2026-08-23)**: ①②④ 는 걷었고 **③ 은 걷지 않았다 — 분류가 틀렸다**.
> 상세와 근거는 ADR-0157 §잔여. 아래 원문은 그 판단 시점의 기록으로 남긴다.

`/study` 를 위해 만들어진 추상이 셋 남았다. 전부 **거주자가 하나**가 됐지만 걷지 않았다.
지금 함께 걷으면 이 PR 이 영속 데이터 마이그레이션까지 떠안는다.

1. **`IndicatorPageScope`(`'live' | 'study'`)** — `livePage`·`chartPrefs`·
   `chartPrefsPersistence`·`indicatorScopeGc` 를 관통한다. 두 번째 값을 **쓰는** 코드는
   없지만 기존 사용자의 `live.indicators.v2` 에 `studyByTimeframe` 블롭이 남아 있어
   하이드레이션이 그 경로를 탄다. 걷으려면 마이그레이션 결정이 필요하다.
2. **`WindowWorkspaceAdapter` 주입 seam**(#907) — 구현체가 `LIVE_WINDOW_WORKSPACE` 하나.
3. **`workspace/zOrder.ts` · `groupId.ts`** — 두 워크스페이스가 공유하려고 뽑은 헬퍼.

`state/indicatorsWindowMigration.ts` 는 **일부러 `'study.workspace.v1'` 을 계속 읽는다** —
1회성 승격 사다리를 아직 안 거친 사용자가 있고, 거기서 빼면 그 사용자의 지표가 공장값으로
회귀한다. 상수는 그 모듈 지역 리터럴로 내렸다(`workspaceKeys.ts` 는 살아 있는 키 목록이다).

### 9-6. 삭제가 조용히 죽일 뻔한 것 둘 (막판에 잡음)

전수 grep 을 한 번 더 돌려 **"사라진 것을 현재형으로 가리키는 산문"** 을 찾다가 나왔다.
둘 다 타입체크·테스트가 통과하는 상태였다 — 그래서 산문 점검이 가치를 냈다.

1. **미캡처 안내** — `showNotCapturedNotice` 에 `true` 를 주던 유일한 곳이 `StudyPage`
   였다. 프롭·파생·순수 함수·그 테스트는 전부 멀쩡히 남고 **켜는 사람만 사라지는**
   모양이라 아무 가드도 빨개지지 않는다. `ChartWindow` 가 `savedRange !== null` 로
   켜도록 옮겼다.
   ✅ **후속에서 고쳤다** — 축이 틀렸었고(`savedRange !== null` → `savedRangeFrozen`
   에서 파생), 양방향 가드가 붙었다. 아래 원문은 그 시점의 기록이다.
   ⚠ ~~이 한 줄 배선에는 테스트가 없다.~~ 순수 함수(`deriveHogaMissingNotice`)는 촘촘히
   덮여 있고 `LiveChartRoot` 의 소비도 덮여 있지만, "저장 구간 창이면 켠다" 라는 **새 조건**
   자체는 `ChartWindow` 렌더 하네스가 없어 못 걸었다. 정직하게 적어 둔다.
2. **`ui/WorkspaceShell` 의 프리미티브 4개** — `WorkspaceRoot` · `WorkspaceHeader` ·
   `DropOverlay` · `WorkspaceState`. 전부 `/study` 만 쓰던 것이고(`WorkspaceState` 는
   문구가 「여기에 놓아 학습뷰 열기」였다) 소비처가 0 이 됐다. 컴포넌트와 그 테스트
   케이스를 함께 삭제. 남은 둘(`WorkspaceToolbar` · `IconToolbarButton`)은 `/live` 가 쓴다.
   - `h-live-header` **토큰**은 이제 소비처가 0 이지만 **지우지 않았다** — 토큰 제거는
     DESIGN.md 소관이라 코드 삭제와 함께 처리할 일이 아니다. `usage` 문자열에 그 사실을
     적어 뒀다.

### 9-5. 문서 부채 — **완료** (별도 PR)

- **ADR-0157** 신규 — `/study` 라우트 폐지. 0123·0155 supersede, 0077·0144·0149 부분
  supersede. 능력 이전 지도를 포함한다.
- **ADR Status 줄** 다섯 — 본문은 당시 기록이므로 고치지 않고 머리에만 달았다
  (0149/0155 가 이미 쓰던 방식). 0144 는 「정책은 살고 무대만 옮겼다」가 요점이라
  생존자로 명시했다.
- **CONTEXT.md** — 저장 학습뷰·복기뷰·공용 지표 셋업·Pane 가중치·Cursor Sidebar·히트맵
  설정 variant·LiveTimeframe(§2.1 의 그 문장) 정정. **스냅샷 학습뷰(v1) 항목은 삭제** —
  스키마에서 사라진 용어다(다른 living doc 참조처 0 을 확인하고 지웠다).
- **DESIGN.md** — `### Tabs (/study — ChartTabBar)` 스펙 **삭제**(그 컴포넌트는 ADR-0149
  로 이미 없었다 — 문서가 존재하지 않는 컴포넌트의 스펙을 들고 있었다) · 워크스페이스
  캔버스/부유 카드/중앙 모달/라우트 그리드의 현재형 서술 정정 · `--h-live-header` 행을
  「소비처 0」으로 · 결정 로그에 폐지 행 추가.
- **CHANGELOG.md** — 손대지 않았다. 최신 항목이 `[0.12.33.0] - 2026-07-07` 이고
  `Unreleased` 절이 없다 = 릴리스 시점에 끊어 쓰는 방식이라, PR 이 덧붙일 자리가 없다.
