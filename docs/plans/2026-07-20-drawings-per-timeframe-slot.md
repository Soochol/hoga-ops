# 그리기 도구 타임프레임별(분·일·주·월) 저장 분리

날짜: 2026-07-20
상태: **구현 완료**. 실측 검증 결과는 §7.
선행: 그리기 도구 Tier1~3 #589 · ADR-0107 (undo/redo) · ADR-0119 C2c-2b (변이 op 명시적 code)

## 1. 목표와 비목표

**목표**: 그리기(드로잉)를 지금의 종목 단위에서 **종목 × 타임프레임 슬롯** 단위로
분리 저장한다. 슬롯은 4개 — `minute`(1m~30m 공유) · `D` · `W` · `M`. 같은 종목이라도
분봉 차트에 그린 추세선은 일봉 차트에 나타나지 않고, 그 역도 마찬가지다.

**슬롯 의미론 (확정 가정)**: 사용자 요청이 "분 일 주 월 각각"이므로 분봉 계열
(1m/3m/5m/10m/15m/30m)은 **하나의 슬롯을 공유**한다. 5m에 그린 선은 15m에서도 보인다.
좌표가 실시간축(`realMs`)이라 분봉 간 렌더는 이미 정확하고, 분봉 간 전환은 "같은 데이터의
줌 변경"에 가깝기 때문. 추후 분봉을 더 쪼개고 싶으면 슬롯 매퍼 1곳만 바꾸면 된다 (§3.1).
기존 단축키 슬롯 개념(`LiveTimeframeShortcutSlot = 'minute'|'D'|'W'|'M'`,
`useLiveKeyboard.ts`)과 동일한 분류다.

**비목표**:
- 슬롯 간 드로잉 복사/이동 UI. (JSON 내보내기→다른 슬롯에서 가져오기로 우회 가능.)
- 드로잉 스타일 기본값(`replay.drawingDefaults.v1`) · 자석 · 전체 숨김의 슬롯 분리 —
  이는 사용자 전역 설정이므로 그대로 전역 유지.
- 백엔드 변경 — 드로잉은 전부 localStorage, 백엔드 무관.

## 2. 현재 구조 (조사 결과)

키잉이 **문자열 `code` 하나**로 전 계층을 관통한다. 스토어 내부 자료구조는 이미
"불투명 문자열 키 → 값" 맵이라, 키의 의미를 넓히는 것이 곧 구현의 전부다.

| 계층 | 파일 | 키 사용 |
| --- | --- | --- |
| 영속 | `frontend/src/chart/drawing/persistence.ts` | `replay.drawings.v1.${code}` |
| 스토어 | `frontend/src/state/drawings.ts` | `byCode` · `selectedByCode` · `loadedCodes` · `activeCode` — 전부 `Map<string,…>`/`Set<string>`. undo 히스토리(`histories`)·저장 디바운스 타이머(`pendingTimers`)도 모듈 레벨 `Map<code,…>` |
| 바인딩 | `frontend/src/chart/useDrawingHost.ts:73` | `setActiveCode(code)` — 온디맨드 로드 트리거 |
| 소비 | `DrawingOverlay.tsx` · `DrawingPropertyPanel.tsx` | `code` prop으로 받아 모든 스토어 조회/변이에 전달 |
| 툴바 | `live/LiveDrawingRail.tsx` | `useWindowView()`에서 code를 읽어 clearAll/export/import |
| 토스트 | `chart/DrawingClearToastHost.tsx` | `clearToast.code`로 restore — 표시 텍스트엔 code 미사용 |

마운트 지점은 2곳뿐이고 **둘 다 `(code, timeframe)`을 이미 들고 있다**:

- `/live` 멀티창: `live/workspace/ChartWindow.tsx` — `d.workareaCode` + `view.timeframe`
  (timeframe은 창 소유, #708)
- `/study`: `studyViews/StudyPage.tsx:573` — `activeViewModel.save.code` +
  `activeViewModel.save.timeframe`

`LiveChartRoot`도 `code`·`timeframe`을 props로 받으므로(`LiveChartRoot.tsx:348`),
합성 키 계산의 초크포인트가 자연스럽게 존재한다.

**덤으로 고쳐지는 기존 결함**: `LiveDrawingRail`은 `useWindowView()`를 쓰는데 `/study`는
WindowView Provider 밖이라 **전역 활성 종목/1m 폴백**으로 떨어진다
(`workspace/windowView.ts:66-67`). study에서 열람 중인 종목과 전역 활성 종목이 다르면
레일의 "모두 지우기"/내보내기가 엉뚱한 종목을 대상으로 한다. 이번 작업에서
`ChartDrawingShell`이 `(code, timeframe)`을 props로 받아 레일에 내리면 함께 해소된다 (§3.4).

## 3. 설계

### 3.1 스코프 키

```
scope = `${code}|${slot}`        slot ∈ 'minute' | 'D' | 'W' | 'M'
```

- `chart/drawing/persistence.ts`에 정의 (키 포맷의 SSOT):
  - `export type DrawingSlot = 'minute' | 'D' | 'W' | 'M'`
  - `export function drawingScope(code: string, slot: DrawingSlot): string`
  - 내부용 `parseScope(scope): { code, slot }` — v1 폴백 키 유도에 사용 (§3.2)
- `state/drawings.ts`에 타임프레임 매퍼 (livePage 타입을 아는 계층):
  - `export function drawingScopeFor(code: string, tf: LiveTimeframe): string` =
    `drawingScope(code, isMinuteTimeframe(tf) ? 'minute' : tf)`
  - chart/ 계층이 `LiveTimeframe`을 임포트하지 않도록 매퍼만 state 쪽에 둔다.
- 구분자 `|`: 종목 code(6자리)·지수 id에 등장하지 않고, 리포 관례
  (`LiveChartRoot`의 viewKey `${code}|${timeframe}|…`)와 일치.

### 3.2 영속 키와 마이그레이션 (lazy 팬아웃 시드)

- 새 키: `replay.drawings.v2.${code}|${slot}` (PREFIX만 v2로 교체, wrapper `{v, items}`
  포맷은 유지 — `VERSION`은 1 그대로. 키 네임스페이스가 버전이므로 wrapper 버전 범프 불요).
- `loadDrawings(scope)`:
  1. v2 키가 **존재하면** (빈 배열 포함) 그것이 정답 — 반환.
  2. 없으면 legacy `replay.drawings.v1.${code}`를 `normalizeItems`로 읽어 시드로 반환.
- 저장은 항상 v2 키. 따라서 각 슬롯은 **처음 변이가 일어나는 순간** v1 스냅샷에서
  분기(fork)한다. 업그레이드 직후엔 4개 슬롯 모두 기존 드로잉이 그대로 보인다 —
  **아무것도 사라지지 않는 것**이 마이그레이션 불변식.
- 슬롯에서 "모두 지우기" → v2에 `{v:1, items:[]}`가 써지므로 재시드 안 됨 (1번 규칙).
- v1 키는 **삭제하지 않는다**: 다른 슬롯이 아직 시드 전일 수 있고, 용량이 미미하다
  (드로잉 JSON 수 KB). 롤백 안전판 역할도 겸한다.

기각한 대안 — (a) 업프론트 일괄 팬아웃 복사: localStorage 전체 키 스캔 필요, lazy 시드가
동일 결과를 더 싸게 달성. (b) v1을 minute 슬롯에만 귀속: 일봉에 그려둔 지지/저항
수평선이 업그레이드 순간 일봉 화면에서 사라진다 — 불변식 위반.

### 3.3 스토어 (`state/drawings.ts`)

**로직 변경 없음, 의미 변경만**: 모든 API의 `code: string` 파라미터가 `scope: string`이
된다. `byCode→byScope`, `selectedByCode→selectedByScope`, `loadedCodes→loadedScopes`,
`activeCode→activeScope`, `setActiveCode→setActiveScope`로 일괄 리네임해 "이 문자열은
code가 아니다"를 타입 이름으로 못박는다 (유지하면 반드시 code를 넣는 회귀가 생긴다).

공짜로 따라오는 것들:
- **undo/redo 슬롯 격리**: `histories`가 scope 키로 자동 분리 — 분봉에서 Ctrl+Z 해도
  일봉 히스토리는 무사.
- **디바운스 저장 안전**: `pendingTimers`가 per-scope라 타임프레임 전환이 code 전환과
  동일하게 처리됨 — 전환 직전 그린 도형의 저장이 유실되지 않는다 (기존 per-code 타이머
  설계의 주석 근거가 그대로 확장 적용). `flushPending`도 무변경.
- **선택 격리**: 타임프레임 전환 시 선택 해제(다른 scope), 같은 code+같은 슬롯 창끼리는
  선택 공유 — ADR-0119 C2c-2b의 멀티창 정합 논리가 슬롯 차원으로 그대로 확장.
- `clearToast.code` → `clearToast.scope` 리네임 (restore 인자로만 쓰이고 표시 텍스트엔
  미사용이라 UI 무변경).

### 3.4 배선

- `LiveChartRoot.tsx`: `const drawingScope = code == null ? null : drawingScopeFor(code, timeframe)`
  (useMemo) → `useDrawingHost(chart, axis, drawingScope, containerRef)` ·
  `<DrawingOverlay scope={drawingScope}>` · `<DrawingPropertyPanel scope={drawingScope}>`.
- `useDrawingHost`: 파라미터 `code`→`scope`, effect가 `setActiveScope(scope)` 호출.
- `DrawingOverlay` · `DrawingPropertyPanel`: prop `code`→`scope` 리네임만 — 내부의 모든
  조회/변이가 그 문자열을 그대로 전달하므로 로직 무변경.
- `ChartDrawingShell`: `{ code, timeframe }` props 추가 → `LiveDrawingRail`에 전달.
  - `ChartWindow.tsx`: `<ChartDrawingShell code={d.workareaCode} timeframe={view.timeframe}>`
  - `StudyPage.tsx`: `<ChartDrawingShell code={activeViewModel.save.code} timeframe={activeViewModel.save.timeframe}>`
- `LiveDrawingRail`: `useWindowView()` 제거, props 사용. 스토어 호출(clearAll/drawingsFor/
  importDrawings)은 `drawingScopeFor(code, timeframe)`, 내보내기 파일명은 슬롯 포함
  `drawings-${code}-${slot}.json`. 내보내기 payload는 `{v:1, code, items}` 유지 +
  `slot` 필드 추가(정보성) — 가져오기는 payload의 code/slot과 무관하게 **현재 scope**에
  귀속 (기존 "현재 종목에 귀속" 의미의 자연 확장이자, 슬롯 간 복사 우회로).

## 4. 함정 체크리스트

- **`hiddenAll`·`magnet`·스타일 defaults는 건드리지 않는다** — 전역 설정 (§1 비목표).
- **v2 존재 판정은 "키 존재"**이지 "items 비어있지 않음"이 아니다 — 빈 배열로 지운
  슬롯이 v1에서 되살아나면 안 된다 (§3.2 테스트 필수).
- **`beforeunload` flush** (`drawings.ts:347`): scope 키로 자동 동작, 확인만.
- **DrawingOverlay의 `codeRef`** (`DrawingOverlay.tsx:129`): scope로 리네임 —
  키다운(undo/redo/삭제/복제)이 ref 경유라 stale scope로 다른 슬롯을 변이하지 않는지
  타임프레임 전환 직후 키 입력으로 확인.
- **테스트 픽스처**: `drawings.test.ts` · `persistence.test.ts` · `DrawingOverlay` 계열
  테스트들이 `'005930'` 같은 생 code를 키로 쓰고 있다면 scope 문자열로 일괄 치환.
  `LiveDrawingRail.test.tsx`는 `useWindowView` 목이 있다면 props 주입으로 전환.
- **지수 차트**: `ChartWindow`의 `d.workareaCode`는 지수 뷰에서도 드로잉 대상이 될 수
  있다 — scope 빌더는 code 내용을 해석하지 않으므로 무영향, 단 `|` 미포함만 전제.

## 5. 테스트 계획

- `persistence.test.ts`:
  - v2 키 round-trip · scope별 키 분리.
  - v1 폴백 시드: v1만 있을 때 4개 슬롯 모두 v1 내용 반환.
  - fork-후-격리: minute 슬롯 저장 후 D 슬롯 로드는 여전히 v1 시드.
  - 빈 v2 존중: `saveDrawings(scope, [])` 후 재로드 = `[]` (v1 재시드 금지).
- `drawings.test.ts`: 같은 code 다른 슬롯 간 변이/undo/선택 격리.
- `LiveChartRoot.test.tsx` 또는 신규 통합 테스트: 분봉에서 add → D 전환 시 오버레이에
  미표시 → 분봉 복귀 시 표시.
- `LiveDrawingRail.test.tsx`: clearAll이 현재 슬롯만 비움 · export 파일명/payload.
- 실행: `cd frontend && npx vitest run src/state/drawings.test.ts src/chart/drawing/persistence.test.ts src/live/LiveDrawingRail.test.tsx src/live/LiveChartRoot.test.tsx` → 통과 후 전체 `npx vitest run` · `npm run build`.
- 도그푸딩 (`/browse`): 삼성전자 1m에 추세선 → 5m 표시 확인(슬롯 공유) → D 미표시 →
  D에 수평선 → W/M 미표시 → 새로고침 후 전 슬롯 유지 → 기존 v1 데이터 보유 상태에서
  업그레이드 시 4개 슬롯 모두 표시(시드) 확인.

## 6. 구현 결과

- 영속: `chart/drawing/persistence.ts` — `DrawingSlot` · `drawingScope` · `parseScope` ·
  `legacyStorageKey` 신설, `readKey`가 **키 부재(null) ↔ 빈 배열([])** 을 구분해
  lazy 시드를 성립시킨다.
- 스토어: `state/drawings.ts` — `byScope`/`selectedByScope`/`loadedScopes`/`activeScope`
  로 리네임, `slotForTimeframe`·`drawingScopeFor` 매퍼 추가. undo 히스토리·디바운스
  타이머·선택 격리는 키 확장만으로 따라왔다(로직 무변경).
- 배선: `LiveChartRoot`가 `drawingScope`를 memo 로 산출해 `useDrawingHost`·
  `DrawingOverlay`·`DrawingPropertyPanel` 에 공급. `ChartDrawingShell`이
  `(code, timeframe)`을 받아 레일에 전달.
- **덤 수정**: `LiveDrawingRail` 이 `useWindowView()` 대신 props 를 쓰면서, `/study`
  가 Provider 밖이라 전역 활성 종목으로 폴백하던 오귀속(§2)이 해소됐다.

## 7. 검증 결과

- 유닛: 전체 393파일 / 4059테스트 통과, `tsc -b` 오류 0, `npm run build` 성공.
  신규 케이스 — 슬롯 매퍼, 슬롯별 변이/undo/선택/영속 격리, v1 팬아웃 시드,
  fork-후-격리, 빈 v2 존중, 타 종목 v1 미소비.
- 도그푸딩 (`/browse`, `/live`): v1 키만 심고 새로고침 →
  - 분봉·일봉·주봉 슬롯이 **각각 독립적으로** v1 시드를 봄(모두 "1개") = 업그레이드
    시 아무것도 사라지지 않음.
  - 한 슬롯을 비워도 다른 슬롯 무영향, 각자 자기 v2 키에 기록.
  - **새로고침 후에도 비운 슬롯이 부활하지 않음** (핵심 회귀 가드).
  - 슬롯별로 3/1/0 을 심고 재로드 → 각 봉에서 정확히 3/1/0 로 읽힘.
  - 주의: 이 워크트리 vite 는 5176 이라 백엔드 CORS(:5173 전용)에 막혀 캔들 데이터가
    없다. 드로잉 경로는 전부 localStorage 라 검증에 영향 없으나, 오버레이 렌더까지
    보려면 5173 에서 재확인이 필요하다.

## 8. PR 구성

단일 PR. 스토어 리네임과 소비자 배선이 타입으로 강결합(파라미터 시그니처 변경)이라
분리하면 중간 상태가 컴파일되지 않는다. diff는 리네임이 대부분이고 신규 로직은
persistence의 v1 폴백 ~20줄 + scope 빌더 ~10줄.
