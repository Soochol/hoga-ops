# 관심맵 리디자인 — 섹터 온도 스트립 + 종목 스파크라인 (Hybrid + Sparkline) — 설계

- **Date**: 2026-06-11
- **Status**: Approved — 사장님 검토 완료(2026-06-11). 데이터=옵션 a, 색 규칙=대안 A(기울기색) 확정. → 구현계획.
- **Topic slug**: `heatmap-hybrid-sparkline`
- **Branch**: `worktree-heatmap-hybrid-sparkline` (worktree)
- **Base spec**: 이 설계는 [`2026-06-10-watchlist-heatmap-design.md`](./2026-06-10-watchlist-heatmap-design.md)(현행 `/heatmap` 보드)의 **레이아웃·행 표현을 진화**시킨다. 데이터 모델·라우팅·정렬 토글·jump-to-live 계약은 그대로 계승한다.
- **Scope (코드)**: 신규 `frontend/src/heatmap/SectorTempStrip.tsx`, `frontend/src/heatmap/Sparkline.tsx`, `frontend/src/heatmap/useSparklineSeries.ts`, `frontend/src/state/sparklineStore.ts`. 변경 `frontend/src/heatmap/HeatmapRow.tsx`, `frontend/src/heatmap/HeatmapBoard.tsx`, `frontend/src/pages/Heatmap.tsx`. **백엔드 무변경.**
- **재사용**: `useWatchlist`/`groupByFolder`, `useLiveQuoteOverlay`(api/liveQuotes), `heat.ts`(`heatBg`/`avgPct`/`sortEntries`), `useJumpToLive`, `visibleFolderGroups`, `heatmapPrefs`.
- **관련 ADR**: 0056(KIS live quote 오버레이·10초 폴링), 0052(jump-to-live SSOT), 0004(미분류 render-only), 0045(spec invariants 필수). **관련(미머지)**: ADR-0068 heatmap↔watchlist 스토어 분리 — 본 설계는 *현행 main 컴포넌트* 기준이며 분리 작업과 독립적으로 적용 가능(§9 참조).
- **승인된 목업**: [`docs/superpowers/designs/2026-06-11-heatmap-hybrid-sparkline.html`](../designs/2026-06-11-heatmap-hybrid-sparkline.html) — 33섹터·236종목 실명 렌더. ⚠️ **스파크라인은 합성 예시 데이터**(목업 한정; 실제 데이터원은 §6).

---

## Problem

현행 `/heatmap`("관심맵")은 섹터 폴더 카드를 신문형 멀티칼럼으로 펼친 **시세 보드**다. 점진적 폴리싱(글자 톤다운·칩 채도·헤더 틴트)을 반복했지만 `heatmap-before ≈ heatmap-after` 로 **"글자 벽" 밀도가 거의 안 바뀌었다** — 칩 미세조정은 소진됐다. 사용자 표현:

> "단순 테이블형 디자인이 아니라 다른 세련된 디자인이면서도 가독성이 좋은 방식, 예: 카드 형식"

두 가지 구조적 결핍:
1. **개요의 부재** — 32개 섹터·236종목을 한 번에 스캔할 "시장 온도 한눈" 층이 없다. 사용자가 카드 벽을 눈으로 훑어야 섹터 온도를 안다.
2. **추세의 부재** — 각 행은 *현재 등락률 한 점*만 보여준다. "지금 오르는 중인가 식는 중인가"(모멘텀)가 안 보인다.

## Invariants

현행 보드/디자인시스템이 **현재 보존하는** 속성 — 본 설계가 지켜야 할 계약:

- **히트색 = 가격방향 카테고리 한정**: 등락 기반 색칠은 `--price-up`/`--price-down`(KRX: 상승 적·하락 청)에서만 파생된다. `heat.ts::heatBg()`가 이를 가변 알파 배경으로 확장. 근거: [DESIGN.md §Color](../../../DESIGN.md), [heat.ts](../../../frontend/src/heatmap/heat.ts).
- **teal `--accent` = UI 상태 전용**: 버튼·포커스·활성 토글에만. 시장 데이터를 teal로 칠하지 않는다. 근거: DESIGN.md 색 규율(3-way 분리).
- **정렬 계약**: `manual`(=`entry.order`, 기본) ↔ `change↓`(옵트인). `change` 모드만 매 폴링 라이브 재정렬 churn 허용. 근거: base spec §2, [heat.ts::sortEntries](../../../frontend/src/heatmap/heat.ts).
- **보드 스크롤 계약**: 바깥 div = 세로 스크롤(높이 한정), 안쪽 div = CSS multi-column(`column-width`, height auto). 같은 요소에 `overflow-y`+`column-width`를 두면 가로 오버플로/단일 칼럼으로 깨진다. 근거: [HeatmapBoard.tsx](../../../frontend/src/heatmap/HeatmapBoard.tsx) eng-review Q6.
- **행 클릭 = jump-to-live**: 행/타일 클릭은 `useJumpToLive(code)` → `/live`. 근거: ADR-0052.
- **숫자 = mono tabular-nums**: 모든 수치는 Geist Mono + `tabular-nums`(칼럼 정렬). 근거: DESIGN.md §Typography.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 히트색 = 가격방향 카테고리 | **preserves (+확장)** | 스파크라인 stroke를 같은 `--price-up`/`--price-down`로 칠한다 — `heatBg`가 배경을 확장한 것과 동일하게 *선*으로 확장. 새 색 0개. |
| teal `--accent` = UI 전용 | preserves | 스파크라인·칩·스트립 모두 가격방향 색만. teal은 정렬/포커스 컨트롤에만. |
| 정렬 계약 | preserves | 상단 스트립 정렬(뜨거운 순)은 **표시 전용**이며 카드 본문 순서·`sortMode`를 바꾸지 않는다(§5). |
| 보드 스크롤 계약 | preserves | 스트립은 스크롤 컨테이너 **바깥**의 `flex-none` 밴드. 기존 outer-scroll+inner-multicol 구조 불변. |
| 행 클릭 = jump-to-live | preserves | 행에 스파크라인 셀만 추가, 클릭 핸들러/계약 동일. |
| 숫자 = mono tabular-nums | preserves | 스파크라인은 SVG(숫자 아님). 가격·등락률 셀 표현 불변. |

> **의도적 미세 분기 — 칩 색 ↔ 스파크라인 색 괴리**: 칩은 *일간 등락*(전일대비), 스파크라인 색은 *연 이후(since-open) 기울기*다. 따라서 한 행이 **빨간 칩 + 파란 선**일 수 있다(일간 +3%지만 보드를 연 뒤로는 약화). 이는 단일-신호 규율 위반이 아니라 **서로 다른 두 시간창의 정보**다 — 둘 다 가격방향 카테고리 안에 있고, 괴리 자체가 모멘텀 신호다. (검토 시 거부권: 원치 않으면 스파크라인을 중립색 `--fg-dim` 단일색으로 내릴 수 있다. §6 대안 B.)

## Goals

- **개요 층**: 화면 상단에서 가시 섹터 전부의 평균 등락(온도)을 히트칩으로 한눈에 — 스크롤 없이 "오늘 어디가 뜨겁나" 스캔.
- **추세 층**: 각 종목 행에서 현재가·일간 등락(칩)에 더해 **연 이후 모멘텀**을 1px 스파크라인으로 — 한 점이 아닌 방향.
- **확장성**: 32+ 섹터에서도 스트립이 breadth를 흡수하고, 카드 본문은 기존 multicol이 depth를 운반(레이아웃 JS 0).
- **디자인시스템 0 위반**: 토큰 + 히트램프 외 색 0, gradient 0, teal-on-data 0.
- **백엔드 무변경, 즉시 출시 가능**: 기존 10초 시세 폴링만으로 동작(§6 옵션 a).

## Non-Goals

- 밀도 토글(Compact/Comfortable), 좌측 섹터 인덱스 레일, 카드 접기/펼치기 — §10 백로그.
- **개장 이후 전체 인트라데이 스파크라인**(옵션 b) — 신규 배치 서버 엔드포인트 필요. §10 업그레이드 경로.
- 미분류/빈 폴더 표시 정책 변경 — 현행 `visibleFolderGroups` 그대로 계승(§9 note).
- 백엔드·데이터 모델·라우팅 변경.

## Design

### 1. 레이아웃 (목업 기준)

```
┌ pages/Heatmap (flex col, h-full) ─────────────────────────────┐
│ header  관심맵 · HH:MM 갱신 · N종목 · [정렬 토글] · [범례]      │ flex-none
│ caption 스파크라인 = 장중(개장 이후) 추세                        │ flex-none, fg-dim/xs
│ ┌ SectorTempStrip ────────────────────────────────────────┐   │ flex-none
│ │ [반도체+4.3%][로봇+2.5%]…[통신-3.0%]  (히트칩, 뜨거운 순)  │   │  (wrap)
│ └──────────────────────────────────────────────────────────┘   │
│ ┌ HeatmapBoard (flex-1, overflow-y-auto) ──────────────────┐   │ scroll
│ │  CSS multi-column(column-width) — 섹터 카드 패킹           │   │
│ │   ┌ HeatmapFolder ──────┐  ┌ HeatmapFolder ─┐ …            │   │
│ │   │ 섹터명  평균칩  ＋    │  │ …               │              │   │
│ │   │ 종목·▁▂▃·가격·칩    │  │ …               │              │   │
│ └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

스트립은 스크롤 컨테이너 **바깥**(`flex-none`)에 둬 **보드 스크롤 계약**(invariant)을 건드리지 않는다.

### 2. 컴포넌트 구조 (작고 단일 책임)

| 파일 | 책임 | 의존 |
|---|---|---|
| `pages/Heatmap.tsx` *(변경)* | 셸 + **스파크라인 누적 트리거**(§4) + 정직 캡션. 기존 헤더/배너/상태 유지 | useWatchlist, useLiveQuoteOverlay, sparklineStore |
| `heatmap/SectorTempStrip.tsx` *(신규)* | 가시 섹터의 평균 등락칩을 **뜨거운 순(표시 전용)** 으로. 칩 클릭 → 해당 섹터 카드로 스크롤 | `avgPct`, `heatBg`, FolderGroup |
| `heatmap/HeatmapBoard.tsx` *(변경)* | 기존 multicol 패킹 + 각 폴더에 `id`(스크롤 앵커) 부여 + series 접근자 주입 | HeatmapFolder |
| `heatmap/HeatmapFolder.tsx` *(미변경 또는 소변경)* | 폴더 카드(헤더+행). 행에 series 전달 | HeatmapRow |
| `heatmap/HeatmapRow.tsx` *(변경)* | 행 그리드에 **스파크라인 셀** 추가: `[name · spark · price · chip]` | Sparkline |
| `heatmap/Sparkline.tsx` *(신규)* | `number[]` → 1px SVG path. 색 = 기울기 부호. memoized | heat 토큰 |
| `heatmap/useSparklineSeries.ts` *(신규)* | `(code) => number[]` 셀렉터 훅(store 구독). 행 단위 안정 참조 | sparklineStore |
| `state/sparklineStore.ts` *(신규)* | 코드→시계열 인메모리 누적(§4) | (Zustand, 기존 패턴) |

### 3. 데이터 흐름

```
useLiveQuoteOverlay(codes) → { quoteByCode, phase, dataUpdatedAt }   // 기존, 10초 폴링
        │ (dataUpdatedAt 변경 시 effect)
        ▼
sparklineStore.appendTick(code, value)  // §4, 폴마다 종목별 1점 누적
        │
        ▼
useSparklineSeries(code) → number[]  →  <Sparkline series={...} />
```

가격(`price`)·등락률(`change_pct`)은 인트라데이에서 선형 관계라 **시계열 모양이 동일** — 저장값은 `change_pct`(없으면 `price`)로 통일하고 의미는 "연 이후 상대 추세"로 단일화.

### 4. 스파크라인 누적 store (옵션 a — since-open) ★유일한 신규 상태 단위

- **저장**: `Map<code, number[]>` 모듈 레벨(Zustand). 컴포넌트 state가 **아니다** — `/heatmap`↔다른 탭 인앱 네비게이션에 살아남아야 한다.
- **append**: `pages/Heatmap`의 effect가 `dataUpdatedAt` 변경마다 현재 `quoteByCode`를 순회, 코드별로 마지막 점과 다르면(또는 새 폴이면) push. cap = 최근 **40점**(≈10초×40 = 6.7분 창; plan에서 조정 가능).
- **리셋(since-open의 올바른 동작, 버그 아님)**:
  - **풀 페이지 리로드** → 인메모리라 자연 초기화("이번에 연 이후").
  - **KST 날짜 롤오버** → append 시 직전 점의 KST 날짜와 다르면 해당 코드 시계열 clear.
- **정리**: 관심종목 집합에서 빠진 코드는 다음 append 사이클에 prune(메모리는 watchlist 크기에 bound).
- **빈 상태**: 점 <2 → 선 없음(또는 baseline 점 1개). 갓 열었을 때 첫 폴까지 선이 없음 — 정직 캡션으로 명시.

### 5. SectorTempStrip — 정렬·상호작용

- **칩 내용**: 섹터명 + 평균 등락률(`avgPct`). 배경 = `heatBg(avg, STRIP_ALPHA)`. 크기는 종목 수에 가벼운 4단계 비례(목업).
- **정렬**: **뜨거운 순(avg 내림차순) — 표시 전용**. 카드 본문의 `sortMode`(manual/change)·폴더 order를 **바꾸지 않는다**(invariant: 정렬 계약 보존). 스트립은 개요, 카드는 큐레이션 순서.
- **클릭**: 칩 클릭 → 해당 폴더 카드(`id=heatmap-folder-{folderId}`)로 `scrollIntoView({behavior:'smooth', block:'start'})`. (필터링·하이라이트는 백로그.)
- 결측(avg=null)·빈 섹터는 스트립에서도 제외(`visibleFolderGroups`와 일관).

### 6. 스파크라인 색 규칙 (결정)

- **채택(대안 A) — 확정(2026-06-11 사장님 승인)**: stroke 색 = `sign(series[last] − series[first])` — 연 이후 기울기 부호. 상승→`--price-up`, 하락→`--price-down`, 평탄(|Δ|<ε)→`--fg-dim`. 1px, fill 없음, 끝점 1.2r 점(목업과 동일). 각 선이 *자기일관적*이고 칩과의 괴리는 정보(Invariant impact 참조).
- **대안 B(거부권)**: 중립 단일색(`--fg-dim`) — 칩이 유일 방향신호. 단일-신호 규율 최우선이지만 사용자가 방금 승인한 "색 있는 선" 룩을 잃음.
- **DESIGN.md 추가(1줄)**: "Price-direction sparkline — `heat.ts`가 가격방향을 *배경*으로 확장하듯, `Sparkline`은 *1px stroke*로 확장한다. 색 = since-open 기울기 부호(상승 적·하락 청·평탄 dim); 일간 등락칩과 다를 수 있다(다른 시간창 = 의도)."

### 7. 행 그리드 변경

현행: `grid-cols-[minmax(4rem,1fr)_3.2rem_4.25rem]` (name·price·chip).
신규: `grid-cols-[minmax(4rem,1fr)_3.5rem_3.2rem_4.25rem]` (name·**spark**·price·chip). 스파크라인 56×16 안에 들어가는 폭. drawer/manual 드래그 표면·`distance:5` 계약 불변.

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| store append/cap | 45점 push | 길이 40, 가장 오래된 5점 evict |
| store day-rollover | 직전 점 KST=어제, 새 점 오늘 | 해당 코드 시계열 clear 후 새 점만 |
| store prune | watchlist에서 코드 제거 후 append | 제거 코드 키 사라짐 |
| Sparkline 색=상승 | series 우상향 | stroke = var(--price-up) |
| Sparkline 색=하락 | series 우하향 | stroke = var(--price-down) |
| Sparkline 색=평탄 | |Δ|<ε | stroke = var(--fg-dim) |
| Sparkline 빈 | 점 0~1개 | path 없음(렌더 무) |
| SectorTempStrip 정렬 | 섹터 avg [+1,−2,+4] | 칩 순서 [+4,+1,−2] |
| SectorTempStrip 제외 | avg=null 섹터 | 스트립에서 제외 |
| HeatmapRow 그리드 | series 유·무 | spark 셀 렌더/미렌더, 클릭 핸들러 동일 |

**Invariant 회귀**: (1) 스트립 정렬이 `sortMode`·`entry.order`를 불변으로 둠을 검증(보드 행 순서 스냅샷 비교). (2) 칩 색은 일간(change_pct) 부호, 선 색은 series 기울기 부호 — 둘이 독립임을 한 테스트로 못박는다.

### 기존 테스트 업데이트
`HeatmapRow.test.tsx`(그리드 4칼럼), `HeatmapBoard.test.tsx`(스트립 마운트·폴더 앵커 id), `Heatmap.test.tsx`(누적 effect) — **신규 작성이 아니라 수정** 필요.

### Manual verification (`/heatmap`)
- 장중(open): 수 분 두면 선이 채워지고 모멘텀이 보인다. 빨간 칩+파란 선(괴리) 케이스 1건 확인.
- closed: 마지막 시세로 선 정지(서빙 마지막 시세, 신규 점 없음).
- 갓 로드: 첫 폴까지 선 없음 → 캡션과 일치.
- 섹터 칩 클릭 → 카드 스크롤. 행 클릭 → `/live`.

## Risks / Open questions

- **since-open 초기 공백**: 새로 열면 선이 비어 보임 — 캡션으로 완화. (Open: 첫 점을 즉시 찍어 1점 dot이라도 보일지 → plan에서 결정.)
- **칩↔선 색 괴리**: §6 — 사용자 거부권 항목. 검토에서 확정.
- **cap 창 길이(40점≈6.7분)**: 너무 짧으면 추세가 평탄해 보임. plan에서 보존창 튜닝(시간 기반 vs 개수 기반).
- **재렌더 비용**: 236행×SVG를 10초마다 — `Sparkline`을 (마지막점+길이) 시그니처로 `memo`. 가상화 불필요(YAGNI).

## Out of Scope (Backlog)

- **옵션 b — 개장 이후 전체 인트라데이**: 배치 `/api/heatmap/series?codes=…`(Parquet 1분/캐시, 종목당 ~20–30 다운샘플 점) 신규 엔드포인트. 로드 즉시 완성 추세선. (이 설계의 자연스러운 업그레이드 — store 인터페이스는 a/b 동일하게 `number[]` 반환이라 소비자 불변.)
- 밀도 토글(Compact/Comfortable, DESIGN.md density dial 연동).
- 좌측 섹터 인덱스 레일(목업 E안) — 섹터가 더 늘면 항법용.
- 카드 접기/펼치기, 스트립 클릭 시 필터링/하이라이트.
- 시계열 reload 영속화(localStorage) — since-open 의미상 기본은 비영속.
