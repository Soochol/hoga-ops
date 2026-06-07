# 관심종목 패널 — 그룹 헤더/종목 행 시각 위계 개선

**날짜:** 2026-06-08
**상태:** 디자인 승인 완료 (디자인 컴패니언으로 A안 선택 + sticky/적용범위 확정)
**대상:** `frontend/src/watchlist/WatchlistDrawer.tsx` (GroupHeader), `frontend/src/rightrail/QuoteRow.tsx`

## 문제

관심종목 사이드패널에서 그룹 헤더와 종목 행이 거의 구분되지 않는다. 원인 3가지:

1. **개수↔가격 컬럼 정렬 충돌** — 그룹 헤더의 종목 개수가 우측 정렬 `font-mono tabular-nums`
   숫자라, 종목 행의 가격과 같은 x 위치·같은 서체로 떨어진다. "좌측 텍스트 + 우측 mono 숫자"
   패턴이 동일해 같은 종류의 행으로 읽힌다.
2. **배경 동일** — 그룹·종목 모두 투명 배경. 13.1px(`text-xs`) vs 14.4px(`text-sm`)의 크기
   차이와 `fg-dim` 색만으로는 스캔 시 구분 불가.
3. **chevron이 우측 끝** — 접기 affordance가 행 내용처럼 보이고 "컨테이너" 신호를 주지 못한다.

## 결정 (디자인 컴패니언 비교로 선택)

4개 색상/크기 변형 중 **A안 — 크기 교환만**:

- **그룹명**: `text-xs`(13.1px) → `text-sm`(14.4px) + `font-semibold`(600).
  색상 `--fg-dim`, hover `--bg-input-hover` **유지** — 크기·굵기로만 위계. 배경은 시각적으로
  현행(투명)과 동일하되, sticky를 위해 패널과 같은 색의 `--bg-card`를 깐다(변경 상세 §1).
- **종목명**: `text-sm`(14.4px) → `text-xs`(13.1px). 가격(14.4px mono)·등락(13.1px mono)은
  불변 — 시세 가독성 보호. 종목명은 식별자, 가격이 1차 콘텐츠.
- 탈락안: 밝은 라벨(`--fg`), `--bg-subtle` 섹션 밴드, 틸 라벨(DESIGN.md 색상 규율 이탈).

추가 결정:

- **sticky 그룹 헤더 적용** — 스크롤 시 현재 그룹명이 패널 상단에 고정.
- **종목명 축소는 QuoteRow 전역** — 관심종목 + 스크리너 드로어 모두. 두 우측 패널의 행
  모양이 동일하게 유지된다. prop 분기 불필요 → 클래스 1곳 변경.

## 변경 상세

### 1. GroupHeader (`WatchlistDrawer.tsx`)

배치를 `[chevron] [그룹명 + 개수] ··· [⋯ 메뉴]`로 재구성:

- **chevron 좌측 이동** — 폴더 관용구(VS Code, TradingView). 모양도 펼침 `∧`/접힘 `∨`에서
  **펼침 `▼`/접힘 `▶`**로 변경 (`ChevronIcon`을 down/right로). aria-label(펼치기/접기) 불변.
  chevron은 독립 토글 버튼으로 유지.
- **개수 인라인 이동** — 우측 정렬 mono → 그룹명 바로 옆 `text-xs text-fg-dimmer`
  (mono/tabular 제거 — 가격 컬럼과의 시각 충돌 해소의 핵심). 라벨 버튼(flex-1) 내부에
  `[truncate 라벨][flex-none 개수]`로 배치해 클릭 타깃도 확대.
- **타이포** — 컨테이너 `text-xs` → `text-sm font-semibold`.
- **sticky** — `sticky top-0 z-10` + `bg-bg-card`. 패널 배경(`--bg-card`)과 동일색이라
  평시엔 투명과 구분 불가, 스크롤 시엔 불투명하게 행을 가린다. 각 그룹 div가 컨테이닝
  블록이므로 헤더는 자기 그룹 범위에서만 고정되고 다음 그룹에 자연스럽게 밀려난다.
  z-10은 AnchoredMenu(z-30)보다 아래. hover `bg-input-hover`는 bg-card 위에 그대로 동작.
- ⋯ hover 메뉴(이름 변경/이동/삭제), 미분류 그룹 처리(메뉴 없음), 접기 localStorage 영속은
  모두 기존 그대로.

### 2. QuoteRow (`QuoteRow.tsx`)

- 종목명 span: `text-sm` → `text-xs`. 단일 클래스 변경, 다른 셀 불변.
- 사용처 2곳(관심종목·스크리너) 모두 적용 — 의도된 전역 변경.

### 3. DESIGN.md

- Components 절에 "Watchlist group header" 패턴 추가: 크기/굵기 위계, 인라인 개수,
  chevron-left, sticky+bg-card 트릭을 기록해 향후 드리프트 방지.

## 영향 / 리스크

- **스크리너 행 변화**: 종목명만 1.3px 축소. 그룹이 없어 위계 이득은 없지만 패널 간 일관성
  확보(사용자 명시 선택).
- **테스트**: `WatchlistDrawer.test.tsx`, `WatchlistRowMenu.test.tsx` 등은 aria-label·역할
  기반이라 깨질 가능성 낮음. 개수 텍스트의 DOM 위치가 바뀌므로 구조 의존 단언이 있으면 수정.
- **색상 규율**: 새 색 없음 — 기존 토큰(`--fg-dim`, `--fg-dimmer`, `--bg-card`)만 사용.
- **Tab 순서**: 헤더 내 포커스 순서가 라벨→⋯→chevron에서 chevron→라벨→⋯로 변경. 시각
  순서와 일치하게 되므로 개선.

## 검증

1. `cd frontend && npx vitest run` — 기존 테스트 통과.
2. `/browse`로 실화면 확인: 그룹/종목 구분, 개수 인라인, chevron 방향, sticky 동작
   (스크롤 시 헤더 고정 + 행 비침 없음), 접기/펼치기, ⋯ 메뉴, 우클릭 메뉴.
   worktree 검증 시 CORS 주의 — backend는 :5173만 허용하므로 프록시 필요.
