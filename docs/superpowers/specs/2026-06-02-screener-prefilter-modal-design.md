# Screener — 전역 사전필터를 센터 모달로 (빌더 카드 정리) — Design

**Date**: 2026-06-02 (via `/superpowers:brainstorming`)
**Status**: Approved (비주얼 컴패니언 미리보기 v1→v3 + 협의로 사용자 승인 2026-06-02)
**Scope**: `frontend/src/screener/ConditionBuilder.tsx`, `frontend/src/screener/UniverseFilterButton.tsx` (신규), `frontend/src/screener/UniverseFilterModal.tsx` (신규), `frontend/src/pages/Screener.test.tsx`

## Problem

`/screener` 빌더 카드 하단에 **전역 사전필터**(시장·ETF제외·거래정지제외) 컨트롤이 인라인으로 항상 펼쳐져 세로 공간을 차지하고 조건 영역을 밀어낸다([ConditionBuilder.tsx:66-83](../../../frontend/src/screener/ConditionBuilder.tsx#L66-L83)). 사용자 요청: *"필터기능을 ui popover로 하고 싶고, 이를 저장한 조건검색과 같이 묶어서… 조건검색에 따라서 다른 필터를 가져가게."* 협의 결과 표면은 **앵커드 popover가 아니라 라이브 보조지표와 같은 센터 모달**(`ModalShell`)로 확정.

**선행 검토 (이미 동작하는 것 — 새로 만들지 않음):**
- **조건검색별 다른 필터**는 *이미* 동작한다. `SavedScreener`가 `{conditions, universe}`를 함께 영속하고([models.py:799-802](../../../hoga/api/models.py#L799-L802)), 편집·저장([useSavedScreenerEditor.ts:35](../../../frontend/src/screener/useSavedScreenerEditor.ts#L35))과 우측 레일 조회([ScreenerDrawer.tsx:57](../../../frontend/src/screener/ScreenerDrawer.tsx#L57)) 모두 그 universe를 사용한다. → **백엔드·저장 모델 변경 0**, 순수 프론트엔드 표면 재배치.
- **ETF 제외 / 거래정지 제외는 실제로 동작한다.** 스캔 SQL이 `NOT stk.is_etf` / `NOT stk.is_halted`를 WHERE에 붙이고([screener_scan.py:120-123](../../../hoga/api/screener_scan.py#L120-L123)), 시드된 `stocks.parquet`에 실값이 있다(검사 결과: is_etf=true **745**개[KODEX 200 등], is_halted=true **9**개). 다만 `is_halted`는 시드 시점 정적 스냅샷이라 **신선도**는 별개 이슈(이 spec 범위 밖).

## Invariants

이 spec이 건드리는 시스템이 현재 보존하는 속성들:

- **조건검색별 universe 영속**: 각 `SavedScreener`는 `{conditions, universe}`를 한 덩어리로 저장/로드/조회한다. 근거: [models.py:799-802](../../../hoga/api/models.py#L799-L802), [useSavedScreenerEditor.ts:35,43](../../../frontend/src/screener/useSavedScreenerEditor.ts#L35), [ScreenerDrawer.tsx:57](../../../frontend/src/screener/ScreenerDrawer.tsx#L57).
- **즉시 적용 편집(no draft buffer)**: 빌더의 모든 편집(universe 토글 포함)은 `editConditions`/`editUniverse`를 **동기 호출**하고, dirty(수정됨) 마커가 그 즉시 반영된다. 초안→확정 버퍼가 없다. 근거: [Screener.tsx:56-57](../../../frontend/src/pages/Screener.tsx#L56-L57), [Screener.test.tsx:81,99](../../../frontend/src/pages/Screener.test.tsx#L81).
- **스캔 무상태**: 조회 = 현재 빌더 `{conditions, universe}`를 `/api/screener/scan`에 POST. `/saves/{id}/run` 없음. 근거: [Screener.tsx:31](../../../frontend/src/pages/Screener.tsx#L31), CONTEXT.md SavedScreener.
- **ModalShell dismiss 계약**: Esc · 배경 클릭 · ✕ · footer 닫기가 모두 닫고, 카드 내부 클릭은 전파 차단된다. 근거: [ModalShell.tsx](../../../frontend/src/ui/ModalShell.tsx).
- **용어**: 시장·ETF·정지 필터는 "조건"이 아니라 코퍼스를 좁히는 **전역 사전필터**다(별도 축). 근거: CONTEXT.md L347-348.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 조건검색별 universe 영속 | preserves | 편집 표면만 이동. 동일 `onUniverseChange`/`editUniverse` 경로 유지. |
| 즉시 적용 편집 | preserves | **모달 토글은 `onChange`를 즉시 호출**. `닫기`는 순수 dismiss(적용 아님). 초안 버퍼 도입 금지. |
| 스캔 무상태 | preserves | 변경 없음. |
| ModalShell dismiss 계약 | preserves | `ModalShell` 그대로 재사용(새 dismiss 로직 없음). |
| 전역 사전필터 용어 | preserves | 라벨·구조 모두 "전역 사전필터" 유지. |

intentionally breaks: **없음.**

## Goals

- 전역 사전필터 컨트롤을 빌더 카드 하단 인라인에서 **헤더 버튼이 여는 센터 모달**로 이동 → 빌더 카드 세로 공간을 조건 영역에 회수.
- 트리거 버튼이 **활성 필터 상태**를 전달: 카운트 배지 + (활성 시) accent 테두리.
- 영속·백엔드·스캔·우측 레일 **무변경**.
- 새 dismiss/패턴 발명 없이 `ModalShell` 재사용으로 보조지표·설정 모달과 일관.

## Non-Goals (YAGNI)

- 추가 필터 그룹(재무·수급·테마·섹터) — 좌측 nav는 **"전역 사전필터" 1개만**. 플레이스홀더 행 없음.
- 우측 레일 `ScreenerDrawer`를 필터 편집 가능하게(읽기전용 유지).
- `is_halted` 데이터 신선도 개선(데이터 파이프라인 이슈, 별도).
- 시장 양쪽(KOSPI+KOSDAQ) 동시 선택을 "제한 없음=0"으로 정규화(아래 §배지 카운트 참조 — 단순 규칙 채택).
- 백엔드·`ScreenerUniverse` 모델·`/scan` 변경.
- 모달 포커스 트랩(기존 모달들도 트랩 없음 — 패턴 일관).

## Design

### 트리거 버튼 — `UniverseFilterButton`

`ConditionBuilder` 헤더에 `＋ 조건 추가` 옆에 놓이는 버튼. props `{ universe, onChange }`. 로컬 `open` 상태를 들고, `open && <UniverseFilterModal …/>` 렌더.

- 라벨 **"사전필터"** + 활성 시 카운트 배지(예: `2`) + (count>0이면) accent 테두리.
- **아이콘은 이모지(`⚙`) 금지.** 코드베이스 관습은 인라인 SVG/텍스트 글리프다([LiveToolbar.tsx:55-58](../../../frontend/src/live/LiveToolbar.tsx#L55-L58)의 보조지표 버튼 = 12×12 stroke SVG + `bg-input`/`border`/`text-xs`). 기본안: **작은 인라인 SVG 깔때기**(funnel, `stroke="currentColor"`) 또는 텍스트-온리. 최종 시각은 DESIGN.md를 따르고, 버튼 스타일(`bg-input`·`border`·`text-xs`·`gap`)은 보조지표 버튼과 맞춘다.
- a11y: `aria-haspopup="dialog"`, `aria-expanded={open}`, `aria-label`은 활성 개수 포함(예: `사전필터, 2개 적용`).

### 배지 카운트

```
countActiveUniverse(u) =
  (u.markets?.length ? 1 : 0) + (u.exclude_etf ? 1 : 0) + (u.exclude_halted ? 1 : 0)   // 0~3
```
- `0` → 배지 없이 라벨만, 테두리 기본.
- `>0` → 배지 + accent 테두리.
- **엣지(승인된 결정)**: 시장은 KOSPI/KOSDAQ 2개뿐이라 둘 다 선택하면 실질 제한이 없는데도 `markets`가 비어있지 않아 **활성 1로 센다**. 단순 규칙을 의도적으로 채택 — 사용자가 토글을 명시적으로 켰으니 "활성" 표시가 직관적. 정규화는 Non-Goal.
- 헬퍼는 `UniverseFilterButton.tsx`에 co-locate(또는 `screener/catalog`).

### 모달 — `UniverseFilterModal`

props `{ universe, onChange, onClose }`. `ModalShell`(ariaLabel/title **"사전필터"**) 사용. 라이브 보조지표(`IndicatorPanel`)와 동일 골격:

```
ModalShell title="사전필터"  (width ≈ w-[480px], 토큰 따라 조정)
└ body: flex (body-split)
   ├ nav  (w-160, border-r)   필터 그룹
   │   └ [전역 사전필터]  ← 단일 활성 행 + 활성 체크 표시(count>0이면 accent 채움, 아니면 hollow)
   └ pane (flex-1)            제목 "전역 사전필터"
        ├ 시장   [KOSPI][KOSDAQ]   (segmented, on=accent — 기존 마크업 이식)
        ├ ☐ ETF 제외
        └ ☐ 거래정지 제외
└ footer: [닫기]
```

- **즉시 적용**: 세 컨트롤(시장 토글/ETF/거래정지)은 변경 즉시 `onChange(nextUniverse)` 호출(현행 인라인과 동일, 보조지표 MA 토글과 동일). `닫기`/Esc/배경/✕는 **순수 dismiss** — 적용/취소 버퍼 아님.
- 좌측 nav 활성 체크: count>0이면 채운 원+체크(accent), 아니면 hollow ring — `IndicatorPanel`의 `CheckIcon` 모양. 작은 로컬 컴포넌트로 복제(라이브 코드 손대지 않음); 공유 `ui/CheckIcon` 추출은 선택(현 spec 범위 밖).
- 시장 토글의 `MARKETS` 상수 + `toggleMarket` 로직은 `ConditionBuilder`에서 이 모달로 **이동**.

### 단일 행 nav를 남기는 이유 (기록)

미리보기에서 "그룹이 1개면 nav가 비어 보인다"는 단점을 명시했고, 사용자가 보고도 옵션 B(센터 모달 + 좌측 nav) + "플레이스홀더 삭제"를 선택했다. **의도된 선택** — 향후 "사전필터" 우산 아래 그룹(재무·수급 등)을 추가할 때 행만 늘리면 되도록 구조를 먼저 잡아두는 것. 우발적 미완성이 아니다.

### `ConditionBuilder` 변경

- 헤더: 현재 full-width `＋ 조건 추가` 버튼 → `flex` 행 `[＋ 조건 추가 ▾ (flex-1)] [<UniverseFilterButton universe={universe} onChange={onUniverseChange}/>]`.
- 하단 `전역 사전필터` 섹션([66-83](../../../frontend/src/screener/ConditionBuilder.tsx#L66-L83)) **삭제** + `MARKETS`/`toggleMarket`/`markets` 제거(모달로 이동).
- `universe`/`onUniverseChange` props·시그니처 유지. `＋ 조건 추가` 자체 popover(`useDismissablePopover`)는 **그대로** — 사전필터는 별개 모달이라 ConditionBuilder는 자기 메뉴 popover 하나만 관리하게 되어 오히려 단순해진다.

## Testing

### Unit tests (신규 `UniverseFilterButton.test.tsx` / `UniverseFilterModal.test.tsx`)

| Case | Setup | Expected |
|------|-------|----------|
| 배지 없음 | `universe={}` | 배지 미표시, 테두리 기본 |
| 배지 카운트 | `{markets:['KOSPI'], exclude_etf:true}` | 배지 `2`, accent 테두리 |
| 양쪽 시장 = 활성 | `{markets:['KOSPI','KOSDAQ']}` | 배지 `1` (단순 규칙) |
| 열기 | 버튼 클릭 | `role=dialog` 표시, 컨트롤 보임 |
| 닫기 | Esc / 배경 클릭 / 닫기 / ✕ | `onClose` 호출, dialog 사라짐 |
| 토글 즉시 적용 | 모달에서 `ETF 제외` 클릭 | `onChange({…, exclude_etf:true})` 즉시 호출 |
| 시장 토글 | `KOSDAQ` 클릭 | `onChange`에 markets 갱신 |
| nav 활성 체크 | count>0 vs 0 | 채운 체크 vs hollow |

### 마이그레이션 (`Screener.test.tsx` — 2건)

`ETF 제외` 체크박스가 이제 **모달이 열렸을 때만 DOM에 존재**한다. 즉시-적용 의미가 보존되므로 dirty/race 로직은 그대로고, "모달 열기" 스텝만 추가:

- **L73-83 (dirty 마킹, C4)**: `getByLabelText('ETF 제외')` 앞에 사전필터 버튼 클릭(모달 열기) 추가 → 토글 → `수정됨` 단언 유지.
- **L85-106 (in-flight create race, C4)**: ① L94의 "페이지 로드" await를 `findByLabelText('ETF 제외')` → 항상 존재하는 요소(예: `findByText('조회')` 또는 사전필터 버튼)로 교체. ② create in-flight 상태(L98 blur 후)에서 **사전필터 모달을 열고** `ETF 제외` 토글(L99). 모달(fixed 오버레이)이 열린 채여도 `수정됨`/행 className 단언은 DOM 조회라 오버레이와 무관하게 통과. **주의**: 모달은 fixed backdrop이라 `SavedScreenerList`의 `새 조건검색` 버튼과 동시 클릭 불가 — create 흐름(L95-98)을 먼저, 모달 열기는 L99 직전에.

### Manual verification (`/screener`)

1. 사전필터 버튼 클릭 → 모달 → 시장/ETF/거래정지 토글 시 배지·`수정됨`이 즉시 갱신.
2. 저장 → 다른 조건검색 로드 → 다시 로드 시 universe 복원(조건검색별 다른 필터 확인).
3. 우측 레일에서 그 저장 조회 → 같은 universe로 스캔.
4. `거래정지 제외`/`ETF 제외` 켜고 조회 → 결과에서 해당 종목 빠지는지 실제 확인.

## Risks / Open questions

- **race 테스트 안무**: 모달 오버레이 ↔ `SavedScreenerList` 버튼 클릭 순서(위 §마이그레이션 주의). 잘못하면 fixed backdrop이 클릭을 가로챔.
- **단일 nav 희소성**: 의도된 선택(위 기록). 추후 그룹 추가 시 자연 해소.
- **`is_halted` 신선도**: 데이터 스냅샷 노후 가능(이 spec 무관, 별도 추적 권장).

## Out of Scope (Backlog)

- 추가 사전필터 그룹(재무·수급·테마/섹터)과 그에 따른 nav 다행화.
- `ui/CheckIcon` 공유 컴포넌트 추출(현재 로컬 복제).
- `ScreenerDrawer`(우측 레일) 필터 편집 가능화.
- `is_halted` 갱신 주기 개선.
