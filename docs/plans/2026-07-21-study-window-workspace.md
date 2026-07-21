# /study 창 워크스페이스 플랜 — 탭 유지 + 자유 배치 창

ADR-0119 가 명시적으로 보류한 후속 과제("범위 = /live 전용, /study 는 현행 유지")를
연다. /study 본문을 /live 와 같은 자유 배치 창 워크스페이스로 전환하되, **탭(저장뷰
단위)은 유지**한다. 착지 시 ADR-0123 으로 결정 기록.

전제: 실행 순서 PR-1 → PR-2 → PR-3. PR-4 는 보류(별도 가치 검증). /live 에 저장뷰를
렌더하는 역방향 안은 **논외**(데이터 파이프라인 이식 비용 + /live 정체성 훼손으로
기각, 본 플랜 범위 아님).

---

## 결정 — 방안 A: 레이아웃 공유, 탭 = 콘텐츠 선택자

창 배치는 워크스페이스 **하나**를 전 탭이 공유한다. 탭 전환 = 모든 창의 데이터
소스(활성 저장뷰 번들 + 커서)가 통째로 바뀐다. 링크 그룹은 **도입하지 않는다** —
활성 저장뷰가 단일 암묵 그룹이다.

근거: /live 에서 창은 탭의 *대체재*였지만(ADR-0113 §Why — 멀티 종목을 탭 대신
멀티창+링크 그룹으로), /study 탭은 종목이 아니라 **저장뷰**(`studyTabs.ts:13-22`,
`StudyTab{viewId,code,timeframe,viewport,pinned}`) 단위라 창과 직교한다. 탭 =
"무엇을 볼까", 창 = "어떻게 배치할까". 지금도 상세 패널은 "활성 탭 번들 + 커서
시점"을 렌더하므로 방안 A 는 데이터 흐름 무변경으로 배치 자유도만 올린다.

기각안:

| 안 | 내용 | 기각 사유 |
|---|---|---|
| B. 탭별 창 배치 | 탭마다 배치 별도 기억 | 영속이 탭 수만큼 증식. "복기 도구 배치"는 탭이 바뀌어도 같은 게 자연스러움 |
| C. 링크 그룹 이식 | 그룹별로 다른 저장뷰 동시 표시 | 탭과 정면 충돌(탭 무의미화). range 번들이 무거워 캐시 축출(#689~691)까지 있는 /study 에서 동시 멀티뷰는 메모리 부담 |

---

## 현황 (2026-07-21 실측)

- **/study 본문 = 고정 2열 grid**(`StudyPage.tsx:535-630`): 좌 차트 카드
  `minmax(0,1fr)` + 우 상세 aside `var(--sidebar-w)`(20rem). aside 안에 4카드
  (orderbook/brokers/volumeDistribution/program, `STUDY_CARD_KEYS`
  `studyLayout.ts:13`)가 dnd-kit 세로 재배열 + 숨김 + rail 접기. 메모는 aside 에
  동거(`StudyMemoPanel`, 열면 패널 강제 펼침 `openMemo`).
- **카드 → props 변환은 이미 resolver 로 분리돼 있다**:
  `resolveOrderbookCardSnapshot`/`resolveBrokerCardProps` 등
  (`StudyReferenceDetailPanel.tsx:35-44`)이 번들+`sidebarCursorMs` 를 각 카드
  props 로 만든다. 창 전환은 재배선에 가깝다.
- **/live 창 프레임워크의 페이지 중립성**(이식 판단):
  - 무비용 재사용: `snapEngine.ts`·`tidy.ts`·`rectSpace.ts` — React/스토어 무의존
    순수 함수. 비율 좌표계·스냅·Tidy·줌 대응(ADR-0122)이 그대로 따라온다.
  - 이미 공유 중: `ui/WorkspaceShell.tsx`(StudyPage.tsx:33 에서 사용).
  - 파라미터화 필요: `WorkspaceCanvas.tsx`(502줄)·`WindowFrame.tsx`(167줄) —
    포인터/렌더 로직은 중립이나 `useWorkspaceStore` 직결 + kind별 렌더 분기
    (`WorkspaceWindowItem`:462-502)가 live 하드코딩.
  - 재작성 필요: `state/workspace.ts` 통째(키 `live.workspace.v1`·live kind 세트·
    live 시드), `ChartWindow`/`DataWindow`(live 데이터 파이프라인 직결).
- **windowView 폴백 계약**: `windowView.ts:47-60` — Provider 밖이면 전역
  `useLivePageStore` 폴백. /study 는 현재 이 폴백 경로로 동작(지표 전역).
- **영속 현황**: `study.tabs.v1`(탭)·`study.layout.v1`(cardOrder/cardHidden/
  detailPanelCollapsed)·`studyView.openPrefs.v1`. 워크스페이스 스토어 없음.
- **키보드**(`useStudyKeyboard.ts:23`): `1~4`=탭 선택, `[`/`]`=탭 순환, `d`=상세
  패널 접기. /live 는 `[`/`]`=창 포커스 순환, `t`=Tidy, `n`=차트 추가 — `[`/`]`
  충돌 있음.

---

## PR-1. 캔버스/프레임 일반화 — /live 무변경 리팩터

창 프레임워크를 페이지 중립 코어로 깎는다. **합격 기준 = /live 동작·영속 완전
무변경.**

- `WorkspaceCanvas` 를 주입형으로: 스토어 어댑터(`windows·zOrder·setWindowRect(s)·
  focusWindow·closeWindow·normalizeLegacyRects` 서브셋 인터페이스)와
  `renderWindow(win) => ReactNode` 를 props/context 로 받는다. `snapEngine`·
  `tidy`·`rectSpace` 는 무변경(px 순수 함수 계약 유지, ADR-0122 §구현 형태).
- `WindowFrame` 은 이미 프레젠테이션 껍데기 — 링크 그룹 팔레트를 옵션화(스터디는
  그룹 없음 → 미표시).
- 관심종목 드롭(`useEntryDragStore` 연동)은 페이지별 핸들러 주입으로 분리
  (/live=종목 교체, /study=기존 `study-drop-target` 동작 유지).
- 배치 위치: `src/workspace/`(신규, 페이지 중립) 로 이동하고 `src/live/workspace/`
  는 live 어댑터+창 콘텐츠만 남긴다. 이동 diff 가 크면 re-export 로 완충.
- 검증: 기존 `snapEngine.test.ts`(367줄)·`workspace.*.test.ts` 전부 그린,
  `npx vitest run src/live/LiveChartRoot.test.tsx`, `npm run build`. /browse 로
  /live 창 드래그·리사이즈·스냅·Tidy·프리셋 저장/적용 스팟 체크.

## PR-2. `studyWorkspace` 스토어 + 시드 마이그레이션

- `state/studyWorkspace.ts` 신설. 키 `study.workspace.v1`, `schema_version: 1` —
  **처음부터 비율 rect** 라 /live 의 레거시 px 지연 마이그레이션
  (`pendingNormalize`) 경로가 통째로 불필요.
- kind 세트: `['chart','book','broker','vdist','program','memo']`.
  - live 의 `trade`/`investor`/`sector-ranking` 은 /study 데이터에 없어 제외.
  - **메모를 창 kind 로 승격** — aside 동거로 인한 "메모 열면 패널 강제 펼침"
    어색함 해소.
  - 그룹 필드 없음(단일 암묵 그룹). `groupSymbols` 없음 — 종목은 탭이 SSOT.
  - v1 은 **차트 창 1개 고정**(추가 메뉴에서 chart 제외). `chart` config 없음 —
    timeframe 은 탭(`tab.timeframe`)이 계속 SSOT.
- 스토어 액션: `addWindow·closeWindow·focusWindow·setWindowRect(s)·tidyAll` +
  `applySnapshot`(프리셋은 후속, 스냅샷 왕복만 준비). live 의 차트 지표 액션
  8종은 도입하지 않음(지표 전역 유지, PR-4 참조).
- **시드**: 첫 하이드레이션에서 `study.layout.v1` 을 1회 읽어(`workspaceMigration.ts`
  의 `buildWorkspaceSeed` 패턴) 기본 배치 생성 — 차트 창(좌측 대면적) + `cardOrder`
  순서대로 우측 세로 스택(숨긴 카드는 창 미생성) + 메모 창(기본 숨김 여부는
  현행 메모 상태 없음 → 미생성). `detailPanelCollapsed` 는 창 모델에서 개념
  소멸 — collapsed 였다면 데이터 창 미생성이 아니라 **생성하되 기본 배치**(정보
  손실 최소, rail 은 "잠깐 접기"였지 "숨김"이 아님). 시드 즉시 persist 로 창 id
  고정(store line 340-343 패턴).
- `study.layout.v1` 은 시드 후 읽지 않음(삭제하지 않고 방치 — live 레거시 3키와
  동일 정책).
- 검증: 스토어 유닛(add/close/focus/rect 클램프/tidy), 시드(cardOrder 반영·
  cardHidden 미생성·재하이드레이션 시 재시드 안 함), 스냅샷 왕복 동형.

## PR-3. StudyPage 본문 교체

- `StudyPage.tsx` 3행 grid 의 행3(`study-drop-target`)을 일반화 캔버스로 교체.
  행1 탭바·행2 헤더 툴바·URL↔탭 sync(3 effect)·viewport 복원 우선순위
  (`StudyPage.tsx:450-476`)·탭 워밍·캐시 축출은 **무변경**.
- 창 콘텐츠:
  - `StudyChartWindow`: 기존 차트 카드 내용물(`ChartDrawingShell`+`LiveChartRoot`,
    study props: `forceHogaPanes`·`dailyCandleKisEnabled:false`·clamp류 false·
    `viewIdentity`·`restoreViewport`) 이관. **WindowViewContext Provider 로 감싸지
    않는다** — 전역 폴백(현행 지표 동작) 유지.
  - `StudyDataWindow`: kind별 분기. `StudyReferenceDetailPanel` 의 카드 resolver +
    카드 렌더를 창 단위로 이관(orderbook/brokers/vdist/program). 커서는 기존
    `sidebarCursorMs` 그대로 — 전 창이 암묵 단일 그룹이므로 live 의
    `useGroupCursor` 게이트(origin.group 비교) 불필요, origin 무시하고 소비.
  - `StudyMemoWindow`: `StudyMemoPanel` 이관. 헤더 메모 버튼 = 메모 창
    열기/포커스로 재배선.
  - 창 추가 메뉴: `WindowAddMenu` study 변형(book/broker/vdist/program/memo).
    라벨은 `windowKindLabels` 확장.
- 제거: 상세 aside·rail(`study-detail-rail`)·`CardRestoreMenu`·dnd-kit 세로
  재배열(`SortableStudyCard`)·Alt+wheel 패널 스크롤(`onWheelCapture`) — 창이 각자
  스크롤. `studyLayout` 스토어는 시드 리더만 남기고 소비자 제거.
- 키보드(`useStudyKeyboard`): `[`/`]` = **탭 순환 유지**(스터디 정체성, /live 와
  의도적 상이 — 창 포커스 순환 키는 v1 미도입, 클릭 포커스로 충분). `d` 제거
  (개념 소멸). `t`=Tidy 추가. `1~4` 탭 선택 유지.
- 상태 셸(뷰 미선택/로딩/에러, `StudyPage.tsx:366-418`)은 무변경 — 캔버스는 정상
  렌더에만.
- 검증: `npx vitest run src/live/LiveChartRoot.test.tsx`, studyWorkspace·
  StudyPage 갱신 테스트, `npm run build`. /browse 도그푸딩: 저장뷰 열기 → 창
  드래그/리사이즈/스냅 → 탭 전환 시 전 창 콘텐츠 일괄 교체 → 커서 이동 시
  10호가/거래원 스팟 → 메모 창 → 새로고침 배치 복원 → 탭 `[`/`]`·`t` 동작 →
  줌 150% 배치 보존(ADR-0122 상속 확인).

## PR-4 (보류). 탭 하나에 차트 창 여러 개

같은 저장뷰를 3m+D 나란히 — 창별 timeframe. `tab.timeframe` 이 창 config 로
내려가는 **모델 변경**(탭 라벨 timeframe 표기·`updateTabTimeframe`·viewport
무효화·`viewIdentity` 전부 파급)이라 PR-1~3 과 분리해 가치부터 검증한다. 이때
비로소 WindowViewContext Provider + 창별 지표(live #712 패턴) 도입을 함께 판단.

---

## 리스크 / 열린 질문

- **PR-1 리팩터 회귀**: /live 는 프로덕션 표면. 어댑터 경계에서 re-render 루프
  (#706 함정 — 발행 구독은 리프에 격리) 재발 주의. 기존 테스트 스위트가 1차
  방어선, /browse 스팟 체크가 2차.
- **탭 전환 비용**: 창 수만큼 resolver 가 동시 재평가된다. 현행 aside 도 4카드
  동시 교체라 등가지만, 창을 늘리면(동종 창 중복 허용 시) 커진다 — v1 은 동종
  데이터 창 중복 허용하되 도그푸딩에서 체감 확인.
- **`--sidebar-w`·`STUDY_DETAIL_PANEL_RAIL_WIDTH_PX` 등 잔재 토큰**: PR-3 에서
  소비자가 사라지면 함께 정리(죽은 토큰 방치 금지).
- 열린 질문: 스터디 전용 레이아웃 프리셋(백엔드 v3 패턴 재사용)은 수요 확인
  후 — 본 플랜 범위 밖.
