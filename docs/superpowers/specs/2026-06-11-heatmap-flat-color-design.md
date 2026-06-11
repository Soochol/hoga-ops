# 관심맵 색 가독성 — 평면 보드 + 색 정돈 — 설계

- **Date**: 2026-06-11
- **Status**: **Approved (2026-06-11)** — 사장님 확정: **L1(헤더 틴트 제거) + L3-B(폴더 투명·평면 + `--border-strong` 좌측 스파인 + `--bg-input` 헤더)**. **L2(캔들 회색화)는 미채택 — 캔들 적/청 색 유지.** → writing-plans 진행.
- **Topic slug**: `heatmap-flat-calm`
- **Branch**: `worktree-heatmap-flat-calm` (worktree)
- **Scope (확정 — 코드)**: `frontend/src/heatmap/HeatmapFolder.tsx`(L1 헤더 틴트 제거 + L3 폴더 평면화·스파인·`bg-input` 헤더), `frontend/src/heatmap/heat.ts`(`HEAT_HEADER_MAX_ALPHA` 정리 — 소비자 grep 후), `DESIGN.md`(히트맵 폴더 surface 예외 1줄). **불변: `CandleGlyph.tsx`(L2 미채택), `HeatmapRow.tsx`, `heat.ts::heatBg`/`HEAT_CHIP_MAX_ALPHA`, 섹터 스트립.**
- **관련 ADR**: 0068(히트맵 watchlist 분리), 0045(spec invariants), DESIGN.md §Color.
- **Supersedes**: 없음. (L2 미채택으로 [`2026-06-11-heatmap-candle-glyph-design.md`](./2026-06-11-heatmap-candle-glyph-design.md)의 캔들 색 규칙은 **그대로 유지** — 캔들은 계속 종가 vs 시가 적/청.)

---

## Problem

사장님: **"색상이 너무 많아서 가독성이 안 좋아."** 이어서 **"그룹 테이블의 배경색을 투명으로 하면 어떨까?"**

진단(코드·실화면 확인): hue 자체는 빨강(`--price-up`)·파랑(`--price-down`)·회색 **3개뿐**이라 색 종류는 적다. 문제는 **같은 빨강·파랑이 4개 표면에 동시에**, 5가지 알파로 깔려 "잉크 밀도"가 높은 것:

| 표면 | 인코딩 | 알파 | 파일 |
|---|---|---|---|
| 섹터 온도 스트립 | 섹터 평균 등락(전일대비) | 0.55 | `SectorTempStrip.tsx` |
| 폴더 헤더 밴드 틴트 | 섹터 평균 등락(전일대비) | 0.20 | `HeatmapFolder.tsx:82` |
| 캔들 글리프 | **당일 종가 vs 시가** | 고정 | `CandleGlyph.tsx:30` |
| 등락칩 | **전일대비** change_pct | 0.72 | `HeatmapRow.tsx:75` |

추가로 **같은 빨강/파랑이 두 시간기준을 표현**한다 — 등락칩은 *전일대비*, 캔들은 *당일 시가대비*(DESIGN.md:120 명시) → "이 칩은 파랑인데 옆 캔들은 빨강"인 의미 충돌(예: +8.9% 빨강칩 + 당일 음봉 파랑캔들). 최근 두 릴리스(v0.7.15 섹터 스트립, v0.7.16 캔들)가 빨강/파랑 레이어를 더 얹은 직후 이 불만이 나왔다.

"배경 투명" 검증 결과(헤드리스 렌더): `--bg-card`(#13131C)와 페이지 `--bg`(#0E0E14)의 명도차가 ~5pt로 거의 같아 **투명화 단독으로는 화면이 거의 안 바뀐다.** 투명의 실제 가치는 색조가 아니라 **카드 박스·테두리 격자(잡chrome)의 소멸**이며, 색 문제는 별도로 표면 수를 줄여야 풀린다.

## Invariants

- **히트색 = 가격방향 카테고리**: 등락 기반 색은 `--price-up`(상승 적)·`--price-down`(하락 청)에서만. 근거: DESIGN.md §Color 규율.
- **새 hue 도입 금지**: UI는 teal accent / success·error 상태 / price-up·down 가격방향 3카테고리로 고정. 회색(`--fg-dim`/`--fg-dimmer`)은 *색의 부재*이지 새 카테고리 아님. 근거: DESIGN.md §Color, 2026-06-08 컴패니언 선례(틸 라벨 색 규율 이탈로 기각).
- **색약 보조 다중 인코딩**: 등락칩 = 배경 농도 + `▲▼` + 부호 + 숫자(4중). 근거: `HeatmapRow.tsx:38,77`.
- **bg-card = 패널·카드 정규 surface**: "Panes, cards, toolbars"는 `--bg-card`. 근거: DESIGN.md §Color 토큰표.
- **그룹 = 보드의 1차 앵커**: 폴더(섹터)명이 보드 정렬·스캔의 기준이며 시각적으로 구분돼야 함. 근거: `HeatmapFolder.tsx:84`, DESIGN.md:237.
- **캔들 글리프 모양 계약**: 고-저 심지 + 시-종 몸통, 결측/모순(null·high<low) → 미렌더. 근거: `CandleGlyph.tsx:28-41`.
- **heatBg 칩 계약**: `heatBg(pct, maxAlpha)`로 등락칩·평균칩·스트립 배경 산출(±8% 포화). 근거: `heat.ts:11`.

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 히트색 = 가격방향 카테고리 | **preserves** | 색은 여전히 `--price-up`/`--price-down`만. 칩·스트립·평균칩·캔들에 집중(헤더 밴드 워시만 제거). |
| 새 hue 도입 금지 | **preserves** | 스파인 = `--border-strong`(기존 중립). 헤더 = `--bg-input`(기존 중립 surface). 새 색 0. |
| 색약 보조 다중 인코딩 | **preserves** | 칩의 `▲▼`+부호+숫자 유지. 캔들 색·모양 유지(L2 미채택). |
| bg-card = 카드 surface | **intentionally breaks (히트맵 폴더 한정)** | L3 채택 → 폴더 `bg-bg-card`+테두리 → 투명·평면. 정당화 아래. |
| 그룹 = 1차 앵커 | **preserves (수단 교체)** | 카드 박스 대신 `--bg-input` 헤더 밴드 + `--border-strong` 좌측 스파인 + 여백으로 경계 복원. 멀티칼럼 밀도 검증서 A(헤더만)보다 또렷(앵커 B 채택). |
| 캔들 모양·색 계약 | **preserves (불변)** | L2 미채택 — `CandleGlyph.tsx` 변경 없음(심지·몸통·결측·종가vs시가 색 전부 유지). |
| heatBg 칩 계약 | **preserves** | `heatBg` 시그니처·사용처(칩·평균칩·스트립) 불변. 헤더 밴드 틴트 호출만 제거 → `HEAT_HEADER_MAX_ALPHA` 미사용 상수 정리. |

**`bg-card` 예외 정당화**: 관심맵은 신문형 멀티칼럼 고밀도 보드다. 카드 박스(채움+테두리+라운드)는 여기서 종목당 정보가 아니라 *그릇*을 그려 잡chrome가 된다(Bloomberg 밀도 지향 — DESIGN.md:37). `--bg-card`/`--bg`의 명도차가 미미해 박스의 정보 가치도 낮다. 그룹 경계라는 카드의 유일한 기능은 헤더 밴드(밝게)+스파인(중립선)+여백이라는 더 가벼운 중립 수단으로 대체한다. 이 예외는 **히트맵 폴더 한정**이며 DESIGN.md에 1줄 명시한다. 드로어·차트·툴바 등 다른 카드는 불변.

## Goals

- 색이 칠해지는 표면을 **4개 → 3개**로 축소 (L1: 폴더 헤더 밴드 워시 제거; 캔들·칩·스트립 색은 유지).
- 폴더 카드 박스 격자를 없애 **평면 보드**로(L3: 투명·테두리 제거) 구조적 잡chrome 감소.
- 신문형 멀티칼럼 밀도에서 **그룹 경계는 또렷 유지**(L3-B: `--bg-input` 헤더 + `--border-strong` 스파인).
- 새 hue 0, 색약 단서·캔들 장중 색 신호 유지.

## Non-Goals

- **섹터 스트립 유지** — 전용 "시장 온도 스캔" 존이라 채색이 본분. 제거/재설계는 범위 밖(사장님이 "스트립 안 본다" 하면 별도 검토).
- **등락칩 알파 곡선(0.72/±8%) 변경 없음** — 채도 진정(컴패니언 D안)은 이번 레버 아님. 표면 수·구조가 레버.
- **임계 기반 회색화(컴패니언 B안) 미채택** — 잔잔한 종목 회색화는 별도 옵션으로 추후.
- 라이트 모드(v1 범위 밖).

## Design — 분리 가능한 3개 레버

이 변경은 **독립 채택 가능한 3개 레버**로 쪼개진다. 비용·되돌릴 수 없음의 정도가 매우 달라 묶지 않고 각각 결정한다. **헤드리스 검증으로 확인된 사실**: 실제 "차분함"은 대부분 **L1(헤더 틴트 제거) + L2(캔들 회색화)**에서 오고, **L3(투명화) 단독 효과는 `--bg-card`(#13131C)≈`--bg`(#0E0E14)라 거의 cosmetic** — 대신 L3가 `--bg-card` 카드 규율 이탈을 유발한다. 즉 L1+L2만으로도 색은 정돈되며, L3는 "박스 격자 제거"라는 별개 구조 취향 + 사장님 원래 아이디어("배경 투명")다. **(↓ §결정: 확정은 `L1+L3-B`, L2 미채택 — 사장님은 캔들 장중 색을 지키고 색 정돈은 L1 + 구조 정돈 L3로 가는 선택.)**

| 레버 | 효과 | 위험·비용 | 구현 |
|---|---|---|---|
| **L1 헤더 틴트 제거** | 색 표면 −1 (헤더 밴드 워시 제거) | **저위험** — DESIGN.md 이탈 없음, 되돌리기 쉬움 | §2-b |
| **L2 캔들 회색화** | 색 표면 −1 (캔들 적/청 → 회색) | **고-regret** — v0.7.16(당일) 추가 기능의 *장중 방향 색 신호* 되돌림 | §1 |
| **L3 폴더 투명·평면화 + 중립 앵커** | 카드 박스 격자 제거(구조) | **DESIGN.md `--bg-card` 이탈** — 이득 작음(투명≈cosmetic) | §2-a |

**1. `CandleGlyph.tsx` — [L2 · ❌ 미채택 · 불변]**
- 사장님 결정: **캔들 색 유지**(종가 vs 시가 → `--price-up`/`--price-down`/도지 `--fg-dim`). `CandleGlyph.tsx`·`DESIGN.md` 캔들 규칙 **변경 없음**. 캔들의 장중 방향 색 신호 보존.
- (참고: 회색화 옵션은 색을 칩에 더 집중시키고 시간기준 충돌을 없앴겠으나, 장중 색 신호 상실 trade-off로 이번엔 미채택. 추후 색이 과하다고 느끼면 재검토 레버.)

**2-a. `HeatmapFolder.tsx` — 폴더 평면화 + 그룹 앵커 [L3 · DESIGN.md 이탈]**
- 폴더 루트 `div`: `bg-bg-card border border-border rounded` → `border-l-2 border-border-strong`(좌측 중립 스파인만; 배경 투명, 외곽 테두리·라운드 제거). `break-inside-avoid`·`mb-2`·`overflow-hidden` 유지.
- 헤더 밴드 배경: `bg-bg-subtle` → `bg-bg-input`(한 단계 밝게 = 그룹 앵커).
- 멀티칼럼 검증: L3 채택 시 그룹 경계는 **B(스파인+`bg-input`)가 A(헤더 밴드만)보다 또렷** — A는 경계가 섹터명 텍스트에만 의존. http://localhost:63340 에서 직접 비교.
- **L3 미채택 시**: 폴더는 현 `bg-card`+테두리 그대로. (L1/L2와 무관하게 색은 정돈됨.)

**2-b. `HeatmapFolder.tsx` — 헤더 틴트 제거 [L1 · 저위험]**
- 헤더 밴드의 히트 틴트 삭제 — `style={... boxShadow: inset 0 0 0 9999px heatBg(avg, HEAT_HEADER_MAX_ALPHA)}` 제거.
- 평균 등락칩(작은 칩)은 **유지** — `heatBg(avg, HEAT_CHIP_MAX_ALPHA)`. 섹터 온도를 밴드 전체 워시 대신 칩으로만 표현.
- 그룹명 위계(`folder ? text-fg : text-fg-dim`) 유지.

**3. `heat.ts` — 미사용 상수 정리 [L1 동반]**
- L1로 `HEAT_HEADER_MAX_ALPHA`(헤더 틴트 전용)가 더 이상 호출되지 않음 → 상수·주석 삭제. **단 삭제 전 다른 소비자 grep 확인**(writing-plans). `heatBg`·`HEAT_CHIP_MAX_ALPHA`·`HEAT_SAT`·`HEAT_MAX_ALPHA`는 불변.

**4. `HeatmapRow.tsx`·`CandleGlyph.tsx` — 불변**
- 등락칩(`heatBg(pct, HEAT_CHIP_MAX_ALPHA)` + `▲▼`+부호+숫자) 그대로. 캔들(`CandleGlyph`)도 L2 미채택으로 변경 없음 — 행 코드 변경 없음.

**5. `DESIGN.md` — 규칙 추가 (L3)**
- §Color: "**히트맵 폴더 surface 예외**: 신문형 밀도 보드라 폴더는 `--bg-card` 카드 대신 투명·평면 — 그룹 경계는 `--bg-input` 헤더 + `--border-strong` 좌측 스파인 + 여백. 헤더 밴드 히트 틴트 없음(섹터 온도는 평균칩으로). 다른 카드(드로어·차트·툴바)는 불변." 1줄. (캔들 색 규칙은 L2 미채택으로 변경 없음.)

## Verification

- **헤드리스 사전검증(완료)**: `/browse`로 동일 데이터 5안(현재/A/B/C/D) + 투명 3단계 + 멀티칼럼 A/B를 렌더·스크린샷 대조. 앵커 B가 평면+헤더 틴트 제거 상태에서 그룹 또렷 확인.
- **구현 후**: 워크트리 dev 서버를 :5173 백엔드로 프록시(메모리: CORS는 :5173만 허용)해 `/heatmap` 실데이터로 헤드리스 스크린샷 → 사장님 육안 확인. 빽빽한 멀티칼럼에서 스파인+헤더로 그룹 경계가 충분한지, 평면 보드에서 캔들·칩 색이 과하지 않은지 점검.
- **단위 테스트**: `HeatmapFolder` 스냅샷(헤더 틴트 box-shadow 부재·`bg-input` 헤더·`border-l-2` 스파인·`bg-card` 부재) 확인. `HeatmapRow`·`CandleGlyph`는 불변이라 기존 테스트 그대로 통과해야 함(회귀 가드).

## 결정 (확정 — 2026-06-11)

1. **L1 헤더 틴트 제거** — **채택 ○**.
2. **L2 캔들** — **미채택**. 캔들 적/청(종가 vs 시가) **색 유지** — 사장님이 장중 방향 색 신호를 의식적으로 지킴. (구현 후에도 색이 많게 느껴지면 차후 재검토 가능한 레버로 남김.)
3. **L3 폴더 투명·평면화** — **채택 ○, 앵커 B**(좌측 `--border-strong` 스파인 + `--bg-input` 헤더). `--bg-card` 이탈은 §Invariant impact 정당화대로 의식적 채택.
4. **섹터 스트립** — **유지**.

> 확정 = **L1 + L3-B**. 효과: 색 칠 표면 4→3(헤더 틴트 제거; 캔들·칩·스트립은 색 유지) + 카드 박스 격자 제거(평면). 색 최소화가 아니라 "헤더 색 제거 + 구조 정돈"임을 명확히 한다.
