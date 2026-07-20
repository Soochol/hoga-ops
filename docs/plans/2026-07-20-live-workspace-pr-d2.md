# /live 멀티창 PR-D2 플랜 — 창별 정밀 드롭 · 크로스헤어 미러 · 동시호가 마스크

ADR-0119 PR-D 잔여분(D1 = #721 크로스헤어 버스·데이터 창 차트 연동 착지 후).
WS venue 전송은 #715 기확정("venue 전역 유지")에 따라 제외.

전제: #721 머지(또는 그 브랜치 위 스택). D1이 만든 `sidebarCursorOrigin`(발행
차트의 창 id·그룹·code·봉)과 `groupChartLinkSource`가 이 플랜의 기반이다.

실행 순서: D2-1 → D2-2 → D2-3. 각각 독립 커밋(리스크 격리 — D2-2가 lwc 이벤트
루프 리스크로 가장 크다). 하나의 PR로 묶되 증분별 검증.

---

## D2-1. 창별 정밀 드롭 — 관심종목/스크리너 행을 특정 창 위에 드롭

**스펙(#711)**: "종목 드래그&드롭: 관심종목·스크리너에서 창 위에 드롭 → **그
창의 그룹** 종목 교체(**포커스 무관**)." 현행은 캔버스 어디에 놓든 활성 그룹
교체([WorkspaceCanvas.tsx:209](../../frontend/src/live/workspace/WorkspaceCanvas.tsx)
주석에 "창별 정밀 드롭은 PR-D" 명시).

### 현행 구조 (2026-07-20 확인)

- `state/entryDrag.ts` — 드롭 타깃 seam. 캔버스가 `registerChartTarget(hitTest)` 로
  boolean 히트테스트 등록, 패널(WatchlistDrawer:483·493, ScreenerDrawer:314·324)이
  `isPointOnChart(dropPoint(ev))` 로 묻고 참이면 `onPick(code, name)`(=활성 그룹
  교체 경로, `activateLiveCode`) 호출.
- 드롭 어포던스: 캔버스 전체에 단일 오버레이("드롭=활성 그룹 종목 교체").

### 변경

1. **`entryDrag.ts` — 드롭 리졸버 seam 추가** (boolean 히트테스트는 어포던스용으로
   존속):
   ```ts
   type ChartDropResolver = (point: {x,y}, entry: {code: string; name?: string}) => boolean;
   registerChartDropResolver(fn) / clearChartDropResolver(fn)  // remount 안전 규율 동일
   resolveDropOnChart(point, entry): boolean  // 등록 리졸버 호출, 미등록이면 false
   ```
   추가로 어포던스용 드래그 좌표 발행: `setDragPoint(x, y)` + `dragPoint` 필드
   (같은 값 skip — onDragMove 프레임당 호출).
2. **WorkspaceCanvas — 리졸버 등록**: 좌표에서 **z-최상위 창**(zOrder 역순 ×
   rect 포함 판정)을 찾아:
   - 창 위: `setGroupSymbol(win.group, {code, name})` 후 `true`. 포커스 변경 없음
     (#711 "포커스 무관"). 활성 그룹과 같은 그룹이면 LivePage 미러 effect가
     livePage 반영을 전담(이중쓰기 불요 — C2c-2d 미러 경로 재사용).
   - 창 밖(캔버스 여백): 기존과 동일하게 `false` 반환 → 패널이 `onPick` 폴백
     (활성 그룹 교체) 유지. 진입점 테스트 20건 무변경.
   - name 부재 시(스크리너 row 등) `code` 를 name 폴백으로(GroupSymbol 계약).
3. **패널 2곳 절단**: `if (isPointOnChart(...)) { resolveDropOnChart(...) || onPick(...) }`
   형태 — 리졸버가 처리하면 종료, 아니면 기존 onPick. StudyViewsDrawer 는 study
   타깃이라 무변경.
4. **창별 어포던스**: 드래그 중(`draggingCode != null`) 캔버스가 `dragPoint` 로
   호버 창을 계산해 그 창에 하이라이트 링 + "그룹 N 종목 교체" 배지, 창 밖이면
   기존 캔버스 오버레이("활성 그룹 교체") 유지. 계산은 캔버스 리프에 격리
   (#706 함정: 셸 구독 금지). WindowFrame memo 를 깨지 않도록 하이라이트는
   창 rect 위 **절대배치 오버레이 1개**로 그린다(창 자체 재렌더 0).

### 검증

- 유닛: 리졸버 z-순서 선택(겹친 창=위 창 승리)·창 밖 false 폴백·remount 등록
  규율. 패널 onDragEnd 분기(리졸버 true→onPick 미호출).
- 도그푸딩: 그룹 1/2 창 배치 → 관심종목 행을 그룹 2 창에 드롭 → 그 창만 교체·
  포커스/활성 그룹 불변·livePage 미러 불변. 여백 드롭 → 활성 그룹 교체(현행).

---

## D2-2. 같은 그룹 차트 창 간 크로스헤어 시간 미러

**스펙(#708)**: "창 간 동기화 = 같은 링크 그룹 차트 창끼리 **크로스헤어 시간만**
(lwc `subscribeCrosshairMove` → `setCrosshairPosition`). 팬/줌·뷰포트는 창별 독립."

### 설계

- **발행**: D1 그대로 — 호버 차트가 `cursorMs`(무스로틀 setCursor)와
  `sidebarCursorMs`(스로틀)를 발행, origin 태깅은 `sidebarCursorOrigin`.
  **`setCursor 에도 origin 을 동반**시킨다(같은 origin 객체 — 미러의 부드러움은
  무스로틀 cursorMs 를 따라야 하므로). 필드는 기존 `sidebarCursorOrigin` 하나를
  공용 origin 으로 승격(이름 유지 or `cursorOrigin` 리네임 — 소비자 2곳 갱신).
- **소비(미러)**: LiveChartRoot 에 effect 1개 — `useLiveCursorStore.subscribe`
  **imperative 구독**(React 재렌더 0, 크로스헤어는 어차피 canvas 직접 조작):
  - 게이트: `origin && origin.group === myGroup && origin.windowId !== myWindowId
    && myWindowId !== null`(Provider 밖 /study·단일 뷰는 미러 불참).
  - 적용: `vt = realMsToVirtualSeconds(myAxis, cursorMs)` — **각 차트가 자기
    축으로 변환**(타임프레임 달라도 자기 그리드에 스냅). 가격 인자는 자기
    캔들에서 cursorMs 이하 최근접 봉의 close(이진탐색, candleMsRef 재사용) —
    lwc 계약상 price+series 필수. `chart.setCrosshairPosition(price, vt, candleSeries)`.
  - 해제: cursorMs null(발행자 leave/clear) 또는 게이트 이탈 시, **직전에
    미러를 그렸던 경우에만** `chart.clearCrosshairPosition()`.
- **루프 차단(핵심 리스크)**: lwc 는 프로그램적 set/clearCrosshairPosition 에도
  `subscribeCrosshairMove` 를 발화한다. 미러 수신 차트의 기존 핸들러
  (LiveChartRoot:1752~)가 이를 사용자 호버로 오인하면:
  - set → 미러 차트가 자기 origin 으로 **재발행** → 발행자 자리 뺏기·상호 미러 루프.
  - clear(point=null) → **leave-clear 타이머** → 발행자의 커서 스토어를 지움(싸움).
  차단: `applyingMirrorRef` 플래그를 set/clear 호출 구간에 동기 세팅, 핸들러
  진입부에서 플래그면 **rAF 스케줄 전에 즉시 return**(lwc 이벤트는 호출 내 동기
  발화 전제 — 검증 항목). 만약 비동기 발화로 판명되면 폴백: 타임스탬프 가드
  (`lastMirrorApplyAtRef` 후 1프레임 내 param 무시).
- **스로틀·성능**: cursorMs 는 crosshair move 마다 갱신되지만 소비가 imperative
  구독이라 재렌더 비용 0. setCrosshairPosition 자체는 lwc 내부 무효화 1회 —
  프로토타입 12창 실증 범위 내. 문제 시 rAF 배칭 추가(계획만, 선구현 안 함).

### 검증

- 유닛: 게이트 판정(같은 그룹·다른 창만)·origin null/그룹 불일치 시 clear·
  "미러를 그린 적 있을 때만 clear" 상태 전이. lwc mock 으로 재발행 루프 없음
  (핸들러 플래그 가드) 고정.
- 도그푸딩(필수, lwc 실 이벤트 의미론): 같은 그룹 차트 2창(1m+5m) — A 호버 →
  B 에 수직선 동기·B 의 데이터 창 스팟 정상·A leave → B 크로스헤어 소멸·
  콘솔 에러 0·재발행 루프 없음(network 스팟 fetch 가 A 의 code/tf 로만 발화).
  다른 그룹 차트는 무반응.

---

## D2-3. 데이터 창 10호가 동시호가 마스크 복원

**현행**: DataWindow `BookWindow` 가 `TotalQtyBar maskRatio={false}` 고정 —
레거시 사이드바는 `useAuctionMaskActive(axis, spotCursorMs)` 로 동시호가 시간대
호버 시 매수/매도 비율을 마스킹했다.

### 설계

전역 `useLiveAxisStore` 는 멀티창에서 **last-writer-wins**(다른 그룹/봉 차트가
덮음)라 쓰지 않는다. 판정을 그룹 링크 번들에서 직접:

- `virtualAxis.inClosingAuctionWindow` 는 이미 `sessionTime.isClosingAuction
  (segments, realMs)` 위임(단일 도메인 소스) — BookWindow 에서 **같은 헬퍼를
  직접 호출**: `link.bundle.segments` 를 `SessionSegment` 로 사상(세그먼트
  스키마 확인: RangeSegment {date, session_open_ms, session_close_ms} →
  isClosingAuction 입력형과 필드명 정합 확인 필요 — 불일치 시 얇은 어댑터).
- 게이트: `useChartPrefsStore.auctionWindowMask` 토글(전역, ADR-0048)은
  `useAuctionMaskActive` 와 동일하게 선행 단락. 스팟 커서가 있고 토글 on 이고
  `isClosingAuction(segments, spotCursorMs)` 참 → `maskRatio=true`.
- BookWindow 에 `useGroupChartLink(win.group)` 추가(현재 미소비 — vdist/program
  만 소비 중). 링크 부재 시 마스크 없음(latest 모드 현행 유지 — 레거시도
  latest 에선 마스크 비활성).

### 검증

- 유닛: 동시호가 구간 커서 → maskRatio true·정규장 커서 → false·토글 off →
  false·링크 부재 → false.
- 도그푸딩: 15:20~15:30 구간 과거 캔들 호버 → 10호가 비율 마스킹 확인.

---

## 공통 마감

- ADR-0119 PR-D 행 갱신(D2 착지 범위 추가, 잔여=venue 전송 항목 제거 사유 명기).
- 전체 vitest·tsc·build·eslint 순증 0(D1 절차 동일: HEAD 대조 파일별 계수).
- 도그푸딩: 워크트리 vite + `/api` 프록시(`config.json api_url:''` 임시 —
  커밋 전 원복). **포트는 로그의 실포트 확인**(5174 선점 사례 있음).
- `/study` 무회귀: 미러 게이트가 `windowId null` 불참이라 구조적으로 무변경 —
  콘솔 에러 0 확인만.

## 리스크 순위

1. **D2-2 lwc 프로그램적 이벤트 의미론**(동기/비동기·param 형태) — 플래그 가드
   설계가 전제와 다르면 폴백(타임스탬프 가드)으로 전환. 도그푸딩 필수.
2. D2-1 패널 onDragEnd 분기 — 진입점 테스트 20건과 재정렬 폴백(차트 밖 드롭)
   보존 확인.
3. D2-3 은 저위험(순수 판정 + prop 1개).
