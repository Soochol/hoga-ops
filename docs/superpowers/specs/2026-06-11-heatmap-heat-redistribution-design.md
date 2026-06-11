# 관심맵(히트맵) — 히트 무게중심 재배치 + 그룹 정렬 축 — 설계

- **Date**: 2026-06-11
- **Status**: Draft — 브레인스토밍 설계 승인("진행"). 사장님 스펙 검토 대기.
- **Topic slug**: `heatmap-heat-redistribution`
- **Branch**: `worktree-heatmap-heat-redistribution` (worktree; base = local `main` `1686aaa` "등락률 칩 배경 임계 방식" — origin/main보다 6커밋 앞선 평면-헤더 L1+L3-B 디자인)
- **Scope (코드)**: 변경 `frontend/src/heatmap/{heat.ts, HeatmapRow.tsx, HeatmapFolder.tsx}`, `frontend/src/pages/Heatmap.tsx`, `frontend/src/state/heatmapPrefs.ts`; 규칙 갱신 `DESIGN.md`(§Color L112–127). **기존 테스트 변경 동반**(이전 설계를 못박은 회귀 가드 반전): `heatmap/heat.test.ts`·`heatmap/HeatmapRow.test.tsx`·`heatmap/HeatmapFolder.test.tsx`·`pages/Heatmap.test.tsx`(+ `heat.test.ts`·`heatmapPrefs.test.ts`에 신규 단언). 인벤토리는 §Testing "무효화되는 기존 테스트" 참조. **HeatmapBoard.tsx·SectorTempStrip.tsx는 미변경**(아래 D 참조).
- **관련 ADR**: 0068(히트맵 독립 스토어), 0045(spec invariants), 0052(행 클릭=jump-to-live), 0056(10초 시세 폴).
- **부분 Supersedes**: `2026-..-색 가독성 L1+L3-B` 결정 중 **(L1) 헤더 틴트 제거**와 **"히트색은 행/평균 칩 배경에만"**을 *의도적으로 되돌린다*. 좌측 스파인·`break-inside-avoid`·신문형 패킹·드래그 재정렬은 그대로 유지.

---

## Problem

사장님 요청(원문):

> heat map 개선,
> 그룹내 종목 위치 마우스 드래그로 이동 가능하게 개선,
> 그룹 헤더, 등락률에 따른 그라데이션 추가.
> 등락률에서 화살표 제거,
> 등락률에 +이면빨간색, -이면 파란색 (배경색은 지금처럼 없음)
> 히트맵 상단에 -+8 그라데이션 ui 제[거]
> 히트맵 상단에 등락률, 수동 중에 등락률을 누르면 , 그룹도 내림차순/오름차순 정렬

현재 히트(색)는 **행 등락칩**(`|등락|≥8%`만 채색), **헤더 평균칩**, **섹터 온도 스트립**, **캔들 글리프** 등 여러 곳에 분산돼 있다. 그룹 헤더 밴드 자체는 평면(`bg-input`)이라 섹터 온도를 한눈에 잡으려면 평균칩이나 스트립을 따로 봐야 한다. 행 등락률은 회색 텍스트 + `▲▼` + (8% 이상만) 칩 배경으로, **방향이 색이 아닌 글리프에 의존**한다. 상단 색 범례(`-8% ▭ +8%`)는 폭을 차지하지만 KRX 적/청 관례에 익숙한 단일 사용자에겐 정보량이 낮다. 그룹(폴더) 순서는 `folder.order` 고정이라, **행은 수동 큐레이션을 유지하면서 "지금 뜨거운 섹터 먼저" 보기**가 불가능하다.

핵심은 산만한 7개 변경이 아니라 한 가지 설계 의도다: **히트의 무게중심을 행 → 그룹 헤더로 옮기고, 그룹 정렬 축을 하나 추가**한다.

## Invariants

이 spec이 건드리는, 현재 보존되고 있는 속성들:

- **히트색 = 가격방향 카테고리**: 등락 기반 색은 `--price-up`(KRX 상승 적)·`--price-down`(하락 청)에서만. 근거: DESIGN.md §Color.
- **색약 이중 인코딩**: 등락 신호가 색 단독에 의존하지 않고 ≥2중으로 표현된다. *현 baseline 정정*: 방향 **색**은 `|등락|≥8%` 칩 배경([HeatmapRow.tsx:75](../../../frontend/src/heatmap/HeatmapRow.tsx))에만 있고 숫자 텍스트는 `text-fg-dim` 중립([:74]), 보조 표식 = `▲▼`([:38]) + 부호. ⚠️ DESIGN.md L114–115는 "숫자는 priceDirClass 색 유지 → 배경+숫자+부호 삼중"이라 서술하나 이는 연속 램프 시절 문구로 현 임계-칩 코드와 이미 어긋난 stale 서술이다.
- **teal `--accent` = UI 상태 전용**: 시장 데이터에 teal 금지. 근거: DESIGN.md 색 규율.
- **헤더 밴드 히트 틴트 미사용 (L1)**: 헤더 밴드는 평균 등락 배경 워시 없이 평면 `bg-input`. 근거: DESIGN.md L126, [HeatmapFolder.tsx:80](../../../frontend/src/heatmap/HeatmapFolder.tsx).
- **행 등락칩 임계**: `|등락|≥HEAT_SAT(8%)`일 때만 칩 배경, 그 미만/결측 투명. 근거: [heat.ts `heatChipBg`](../../../frontend/src/heatmap/heat.ts).
- **보드 그룹 순서 = `folder.order`, 미분류 맨 끝**: 그룹은 폴더 order 고정, 미분류(`folder=null`)는 항상 마지막. 근거: [grouping.ts `groupByFolder`](../../../frontend/src/watchlist/grouping.ts).
- **미분류 = 정렬/점프 비대상**: 미분류는 섹터 정렬·점프 대상이 아니다(catch-all). 근거: ADR-0068, [SectorTempStrip.tsx](../../../frontend/src/heatmap/SectorTempStrip.tsx).
- **그룹 내 드래그 재정렬 = manual 모드 전용**: change 모드는 매 폴 라이브 재정렬이라 드래그 비활성. 근거: [HeatmapFolder.tsx:47](../../../frontend/src/heatmap/HeatmapFolder.tsx).
- **행 클릭 = jump-to-live**: 근거: ADR-0052.
- **숫자 = mono tabular-nums**: 근거: DESIGN.md §Typography.
- **정렬 prefs localStorage 영속**: `sortMode`가 `heatmap.sortMode.v1`에 영속. 근거: [heatmapPrefs.ts](../../../frontend/src/state/heatmapPrefs.ts).
- **SectorTempStrip = 표시 전용 정렬**: 스트립의 hot→cold 정렬은 보드의 `sortMode`/entry `order`를 바꾸지 않는다. 근거: SectorTempStrip 주석(spec invariant).

## Invariant impact

| Invariant | 영향 | 비고 |
|-----------|------|------|
| 히트색 = 가격방향 카테고리 | **preserves** | 헤더 틴트·행 텍스트 모두 `--price-up`/`--price-down`만. 새 색 0. |
| 색약 이중 인코딩 | **preserves (인코딩 변경)** | 행: `▲▼` 제거하지만 **방향 색(`priceDirClass` 텍스트) + 부호** 2중 — 색을 칩 배경(현)→텍스트(신)로 옮겨 오히려 DESIGN L114–115 "숫자 색 + 부호" 의도에 더 부합. 헤더: 색(밴드) + 부호 포함 평균 숫자 2중. |
| teal UI 전용 | preserves | 정렬 토글 active 상태만 teal — UI 상태라 규율 일치. 데이터엔 teal 없음. |
| 헤더 밴드 히트 틴트 미사용 (L1) | **intentionally breaks** | 헤더 밴드에 평균 등락 비례 틴트 도입(#3). 정당화 ↓. |
| 행 등락칩 임계 | **intentionally removes** | 행 칩 배경(`heatChipBg`) 폐지 → 방향은 컬러 텍스트로(#4/#5). ⚠️ 칩이 지던 **개별 종목 강도(`|≥8%|` 강조)**는 텍스트 색으론 보전 안 됨(Risks 참조). 정당화 ↓. |
| 보드 그룹 순서 = folder.order | **intentionally extends** | 직교 opt-in 축 `groupSort` 추가. 기본 `'manual'` = 현행 보존. 정당화 ↓. |
| 미분류 = 비대상 | preserves | `orderFolderGroups`가 미분류를 모든 모드에서 맨 끝 고정. |
| 드래그 = manual 전용 | preserves | 손대지 않음(#2 범위 밖). |
| 행 클릭 = jump-to-live | preserves | 시각만 변경, 핸들러 불변. |
| 숫자 = mono tabular-nums | preserves | 등락 텍스트·평균 모두 mono tabular-nums 유지. |
| prefs localStorage 영속 | **preserves (additive)** | `groupSort` 별도 키(`heatmap.groupSort.v1`) 추가, `sortMode` 키 불변. |
| SectorTempStrip 표시 전용 | preserves | 스트립 미변경. `groupSort`는 **보드 그룹 순서**만 바꾸고 `sortMode`/entry `order`는 불변. |

**의도적 변경 — 헤더 틴트 도입 + 행 칩 제거 (히트 무게중심 이동, #3/#4/#5)**: L1에서 헤더 틴트를 제거하고 히트색을 칩 배경에만 모은 것은 "행 워시로 인한 가독성 저하"를 피하기 위함이었다. 이번 설계는 그 의도를 **반전이 아니라 재배치**로 해결한다 — 행에서는 색을 **텍스트로만**(배경 워시 없음) 써 가독성을 지키고, 섹터 온도(평균 등락)는 **헤더 밴드 한 곳**으로 모은다. 결과적으로 "한 행/헤더 맥락당 색을 지는 요소는 하나"라는 규율이 생긴다(행=등락 텍스트, 헤더=밴드). 색약 보조는 행 부호와 헤더 평균 숫자가 유지하므로 손상되지 않는다. 사장님이 명시적으로 요청한 변경이며 DESIGN.md를 이에 맞춰 갱신한다(§F).

**의도적 확장 — 직교 `groupSort` 축 (#7)**: 기존 `sortMode`('change'|'manual')는 **그룹 내 행 순서**만 제어했고 그룹 순서는 `folder.order` 고정이었다. 신규 `groupSort`('manual'|'desc'|'asc')는 **그룹(폴더) 순서**를 평균 등락률로 제어하는 **직교 축**이다. 기본값 `'manual'`은 현행 `folder.order`와 동일하므로 **기본 groupSort에선 그룹 순서가 불변**이다(#3/#4/#5의 시각 변경은 groupSort와 무관하게 적용 — "보드 픽셀 불변"은 그룹 *순서*에 한정). desc/asc는 opt-in. 이로써 "행은 수동 순서 유지·그룹만 뜨거운 순"이 가능 — 사장님 표현 "수동 중에 등락률을 누르면 그룹도 정렬"의 *기능적* 요구를 충족한다. **컨트롤 표면 주의**: 원문은 (a) 기존 등락률 토글이 그룹 정렬까지 겸하는 *맥락형 단일 컨트롤*로도 읽힐 수 있으나, 브레인스토밍 Q1에서 사장님이 **(b) 행과 분리된 독립 그룹 토글**(추천안)을 명시 선택했다 — 본 설계는 (b)다.

## Goals

- **그룹 헤더 밴드 = 평균 등락률 비례 히트 틴트** — 섹터 온도를 헤더에서 직접 읽는다(`heatHeaderBg`).
- **행 등락률 = 화살표 없는 `+`적/`−`청 컬러 텍스트, 배경 없음** — 방향이 색+부호로 또렷, 워시 없음.
- **상단 색 범례 제거** — KRX 적/청 관례로 충분.
- **그룹 정렬 축 추가** — 평균 등락 내림/오름/수동, 행 정렬과 직교, localStorage 영속.
- **기본 동작 보존** — 행 클릭=차트, 드래그=manual 재정렬, 미분류 맨 끝, 기본 상태=현행과 동일.

## Non-Goals

- **#2 그룹 내 드래그**: 이미 manual 모드에 구현·동작(@dnd-kit) → **변경 없음**(사장님 "이건 넘기자").
- **그룹 간 드래그 이동**: 우클릭 메뉴(`HeatmapRowMenu`) 유지.
- **SectorTempStrip 제거/재설계**: 유지(헤더 틴트와 정보 일부 중복 — backlog 재검토).
- **그룹 정렬 키 확장**(이름·시총 등): 등락률만(YAGNI).
- **헤더 틴트 부재 보완 범례**: 도입 안 함.

## Design

### A. `heat.ts` — 색·정렬 헬퍼

추가:

```ts
export const HEAT_HEADER_MAX_ALPHA = 0.5; // 헤더 밴드용(큰 면적) — ±8% 포화 시 최대 농도

/** 그룹 헤더 밴드 배경 = bg-input 위에 평균 등락 비례 히트 합성.
 *  null/0 = 순수 var(--bg-input)(현행 평면 그대로). ±HEAT_SAT% 포화. */
export function heatHeaderBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'var(--bg-input)';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * HEAT_HEADER_MAX_ALPHA;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  const heat = `rgba(${rgb},${a.toFixed(3)})`;
  return `linear-gradient(0deg, ${heat}, ${heat}), var(--bg-input)`;
}

export type GroupSort = 'manual' | 'desc' | 'asc';

/** 그룹(폴더) 순서. 'manual'=입력 순서 그대로(folder.order, 미분류 맨 끝).
 *  'desc'/'asc'=실폴더를 평균 등락(avgOf)으로 정렬, avg=null인 실폴더는 실폴더 구간
 *  끝에(원순서 안정), 미분류(folder=null)는 **항상 맨 끝** 고정. 비파괴(복사). */
export function orderFolderGroups(
  groups: FolderGroup[],
  mode: GroupSort,
  avgOf: (g: FolderGroup) => number | null,
): FolderGroup[] {
  if (mode === 'manual') return groups;
  const real = groups.map((g, i) => ({ g, i })).filter((x) => x.g.folder !== null);
  const uncat = groups.filter((g) => g.folder === null);
  real.sort((a, b) => {
    const pa = avgOf(a.g); const pb = avgOf(b.g);
    if (pa === null && pb === null) return a.i - b.i; // 안정
    if (pa === null) return 1;
    if (pb === null) return -1;
    return mode === 'desc' ? pb - pa : pa - pb;
  });
  return [...real.map((x) => x.g), ...uncat];
}
```

- **행 텍스트 색은 기존 `ui/priceDir.ts::priceDirClass(n)`를 재사용**(`>0 text-price-up` / `<0 text-price-down` / `0 text-fg-dim`) — 새 헬퍼 불필요, DESIGN 토큰 클래스 그대로.
- **삭제**: `heatChipBg`(소비처 = HeatmapRow.tsx 행 칩) 및 `HEAT_CHIP_MAX_ALPHA`(소비처 = HeatmapFolder.tsx:92 평균칩 **+ heat.ts:23 `heatChipBg` 본체**). 이번 변경으로 두 심볼의 앱 소비처가 모두 사라지므로 제거하되, **동반 테스트도 함께 제거**: `heat.test.ts:2`(import)·`:25–26`(heatBg+`HEAT_CHIP_MAX_ALPHA` 단언)·`:30–42`(`heatChipBg` describe 블록). `heatBg`는 **유지**(SectorTempStrip이 `STRIP_ALPHA`로 사용) — 그 단언은 알파 인자를 `HEAT_MAX_ALPHA` 등으로 바꿔 보존. *구현 시 grep 재확인.*
- `FolderGroup` 타입은 `../watchlist/grouping`에서 import(이미 heatmap이 의존).

### B. `HeatmapRow.tsx` — 행 (#4, #5)

- `▲▼` 글리프 제거(`const glyph` 줄·사용처 삭제).
- 등락 셀: `heatChipBg` 배경 **제거**, 텍스트에 `priceDirClass(pct)` 적용, `{sign(pct)}{pct.toFixed(2)}` 유지. 결측(null)은 `—`·`text-fg-dim`.
- mono tabular-nums·우측 정렬·grid 유지. 등락 칼럼 폭 `4.25rem`는 화살표 제거 후에도 `+12.34`(6자)에 충분 → **유지**(정렬 안정; 폭 축소는 backlog).
- **0/보합·결측은 방향 없음** → `priceDirClass(0)`=`text-fg-dim` 중립(부호 없음), null=`—` — 색·부호 부재가 정상(인코딩할 방향 자체가 없음).

### C. `HeatmapFolder.tsx` — 헤더 (#3)

- 헤더 밴드: `bg-bg-input` 클래스 제거하고 `style={{ background: heatHeaderBg(avg) }}` 적용(나머지 `border-b border-border-strong px-2 py-1 flex...` 유지). avg=null/0이면 `var(--bg-input)`라 현행 평면과 동일. *("그라데이션" 해석: 면 내 공간 그라데이션이 아니라 평균 등락 비례 **단색 틴트** — 섹터 간 농도 차로 온도를 표현. `heatHeaderBg`는 동색 2-stop이라 시각상 단색.)*
- 평균 표시: 칩 배경(`heatBg`) **제거** → 평면 텍스트. 색은 **중립 `text-fg`**(틴트 밴드 위 가독성 — 동색 적/청 텍스트는 대비 저하라 색 안 입힘). mono tabular-nums·`{avg>0?'+':''}{avg.toFixed(1)}%` 유지.
- `import`에서 `heatBg`·`HEAT_CHIP_MAX_ALPHA` 제거, `heatHeaderBg` 추가.

### D. 페이지 배선 — `Heatmap.tsx` (#6, #7)

- **범례 삭제**: 색 범례 블록(현 77–86줄) 제거. `HEAT_SAT` import가 무참조가 되면 함께 제거.
- **그룹 정렬 상태**: `groupSort`/`setGroupSort`를 `heatmapPrefs`에서 가져옴.
- **그룹 순서 적용**:
  ```ts
  const pctOf = (code) => quoteByCode.get(code)?.change_pct ?? null;
  const avgOf = (g: FolderGroup) => avgPct(g.entries, pctOf);
  const orderedGroups = useMemo(
    () => orderFolderGroups(groups, groupSort, avgOf),
    [groups, groupSort, quoteByCode],
  );
  ```
  `HeatmapBoard`에 **`orderedGroups`** 전달. `SectorTempStrip`·`visibleCount`는 기존 `groups` 유지(스트립은 자체 정렬, 카운트는 순서 무관). → **HeatmapBoard.tsx 시그니처 변경 불필요**(이미 `visibleFolderGroups(groups)`로 빈 그룹만 필터, 순서 보존).
- **그룹 정렬 컨트롤**(범례 자리): 행 토글 옆 3-state 세그먼트. 라벨 시안:
  ```
  히트맵  ● 장중  11:15 갱신·236종목   [＋ 새 그룹]   행 [등락률↓│수동]   그룹 [등락↓│등락↑│수동]
  ```
  - `등락↓`=desc(뜨거운 섹터 먼저)·`등락↑`=asc·`수동`=folder.order. active = `bg-tint-selection text-accent`(행 토글과 동일 스타일·UI 상태 색). 각 버튼 `aria-label`로 의미 명시("그룹을 평균 등락률 높은 순으로").

### E. `state/heatmapPrefs.ts` — 영속

- `GROUP_SORTS = ['manual','desc','asc'] as const`, `STORAGE_KEY_GROUP = 'heatmap.groupSort.v1'`(별도 키 — `sortMode` 키 불변, 마이그레이션 리스크 0).
- `groupSort: GroupSort` 상태 기본 `'manual'`(현행 보드 순서 보존), `setGroupSort`가 검증 후 set+persist. 기존 `sortMode` 로직 불변.

### F. `DESIGN.md` — 규칙 갱신

§Color L112–127를 이번 결정에 맞춰 갱신(미갱신 시 코드리뷰가 신규 코드를 off-system으로 표시):

- **Heatmap 폴더 surface 예외**(L123–127): "헤더 밴드 히트 틴트는 쓰지 않는다" → **헤더 밴드는 평균 등락 비례 히트 틴트(`heatHeaderBg`, max α 0.5)를 진다; 평균값은 평면 `text-fg` 숫자**로 표기. 좌측 스파인·투명 폴더 본문은 유지.
- **Price-direction heat ramp**(L112–115): (1) "배경+숫자+부호 삼중" → **이중(배경 워시 없는 `priceDirClass` 텍스트 색 + 부호)**으로 정정 — 행 등락은 칩 배경이 아니라 컬러 텍스트, `▲▼` 폐지. (2) 신규 `heatHeaderBg`(헤더 밴드 전용, max α 0.5, **평균** 등락 기준)를 ramp 항목에 추가 문서화. `heatChipBg` 임계 칩 서술 삭제.
- 색 범례(spec §8 코멘트가 참조하던 UI) 제거 반영.
- 한 줄 근거 기록: 이는 L1/L3-B "헤더 틴트 제거·칩 전용 색" 결정을 *히트 무게중심 재배치*로 의도적으로 갱신한 것(사장님 승인 2026-06-11).

## Testing

### Unit tests

| Case | Setup | Expected |
|------|-------|----------|
| `heatHeaderBg(null)` / `(0)` | — | `'var(--bg-input)'` |
| `heatHeaderBg(+8)` | 포화 | `linear-gradient(...rgba(220,38,38,0.500)...), var(--bg-input)` |
| `heatHeaderBg(+4)` | 절반 | α `0.250`, rgb `220,38,38` |
| `heatHeaderBg(-8)` / `(-12)` | 청·클램프 | rgb `37,99,235`, α `0.500`(>8 클램프) |
| `orderFolderGroups(manual)` | 임의 | 입력과 동일 참조 순서(identity) |
| `orderFolderGroups(desc)` | 실폴더 avg [+1,+5,−2] + 미분류 | `[+5,+1,−2, 미분류]` |
| `orderFolderGroups(asc)` | 위와 동일 | `[−2,+1,+5, 미분류]` |
| `orderFolderGroups(desc)` null-avg | 실폴더 avg [+3, null, +1] | `[+3,+1, null폴더, 미분류]`(null은 실폴더 끝, 미분류 더 끝; asc면 `[+1,+3,null,미분류]`) |
| `orderFolderGroups` 전부 null | avg 모두 null | 원순서 보존 + 미분류 맨 끝 |
| HeatmapRow 화살표 제거 | pct=+2.59 | 출력에 `▲`/`▼` 없음; 텍스트 `+2.59` |
| HeatmapRow 색 | +/−/0/null | span class `text-price-up`/`text-price-down`/`text-fg-dim`/`—`; **inline background 없음** |
| HeatmapFolder 헤더 틴트 | avg=+4 | 헤더 `style.background === heatHeaderBg(4)`; 평균 텍스트 `+4.0%` 칩 배경 없음 |
| heatmapPrefs groupSort | 기본 | `'manual'`; `setGroupSort('desc')` → `heatmap.groupSort.v1` 영속; 잘못된 값 무시; `sortMode` 불변 |
| Heatmap 범례 제거 | 렌더 | `aria-label^=색 범례` 요소 없음 |
| Heatmap 그룹 토글 | 클릭 | 3옵션 렌더; 클릭 시 store/`orderedGroups` 순서 반영 |

### 무효화되는 기존 테스트 (갱신/삭제 대상)

이번 변경은 이전 설계(L1 평면 헤더·"방향색 텍스트 금지"·임계 칩·색 범례)를 못박은 **회귀 가드를 의도적으로 반전**한다. 미반영 시 통과하던 테스트가 깨지므로 함께 갱신한다:

| 파일:라인 | 현재 단언 | 조치 |
|------|------|------|
| `heat.test.ts:2,25–26,30–42` | `heatChipBg`·`HEAT_CHIP_MAX_ALPHA` import·단언·describe 블록 | **삭제**(심볼 폐지). heatBg 단언은 알파 인자 교체 후 보존 |
| `HeatmapRow.test.tsx:20–23,33,38–41` | `▲+9.00`/`▼-8.00` 글리프·칩 배경색(`220,38,38`/`37,99,235`) inline style·**`text-price-up` 금지**(`.not.toHaveClass`) | **재작성**: `▲▼` 없음·등락 텍스트가 `text-price-up`/`text-price-down` **보유**·배경 inline style 없음 |
| `HeatmapFolder.test.tsx:52` | "L1: 헤더 히트 틴트(box-shadow) 없음 — 평균 +5%여도 배경 워시 없음" | **반전**: 헤더 `style.background === heatHeaderBg(avg)` 보유 단언 |
| `Heatmap.test.tsx:78,84` | `getByLabelText(/색 범례/)` 존재 단언 | **삭제**: 범례 부재(`queryByLabelText(/색 범례/)` = null); 그룹 토글 단언 추가 |

**Invariant 회귀 테스트**:

- **미분류 맨 끝**: `orderFolderGroups`의 manual/desc/asc 모든 모드에서 미분류가 마지막.
- **색 카테고리**: 행·헤더 색이 `price-up`/`price-down`/`fg-dim`·`--bg-input`만(데이터에 teal 없음) — 스냅샷/클래스 단언.
- **색약 이중 인코딩**: 화살표 없이도 등락 텍스트가 부호(`+`/`−`) 유지.
- **`groupSort`가 `sortMode`/entry order 불변**: groupSort 변경 후에도 그룹 내 행 순서·`sortMode`·드래그 재정렬 동작 불변(manual 행 순서 보존).

### Manual verification (`/heatmap`)

- 헤더 틴트가 평균 등락에 비례(중립 섹터 옅음·급등락 진함); 행 등락=화살표 없는 적/청 텍스트·배경 없음; 상단 범례 사라짐.
- 그룹 토글 `등락↓` → 폴더가 뜨거운 순 재배치, **행은 수동 순서 유지**, 미분류 맨 끝; `등락↑` 역순; `수동` 복귀.
- 새로고침 후 `groupSort` 유지(localStorage). 수동 모드에서 그룹 내 드래그 재정렬 여전히 동작.
- 고알파(±8%↑) 밴드 위 평균 `text-fg` 대비 확인. teal은 토글 active에만.

## Risks / Open questions

- **groupSort≠manual 시 매 폴(~10s) 그룹 라이브 재배치** — 점프감 발생, manual 행 드래그 중 그룹이 움직일 수 있음. 큐레이션 시 사용자가 `수동`으로 둠. 행 `change` 모드와 동일 성격의 수용된 트레이드오프.
- **헤더 틴트 α=0.5** 시작값 — 작은 avg(±1~2%)는 매우 옅음(의도: 중립=옅게). 검토에서 미세조정 가능.
- **개별 종목 등락 강도 시각 강조 상실** — `heatChipBg`(`|≥8%|` 칩)가 지던 "급등락 강조"가 사라진다. 대체 `priceDirClass`는 *방향 전용*이라 +1%와 +15%가 동일 색이고, 헤더 틴트는 *평균*이라 단일 급등락이 희석되며(예: 10종목 중 1종목 +15% → avg≈+1.5% → α≈0.09 거의 안 보임), `CandleGlyph`는 종가-시가 기준이라 무관 — 즉 변경 후 보드에서 *개별 change_pct 강도*를 보이는 요소가 0이 된다. 사장님이 "배경색은 지금처럼 없음"을 명시 요청했으므로 **의도된 트레이드오프**. 보전이 필요하면 행 텍스트 굵기/톤을 `|등락|` 비례 변조(backlog).
- **SectorTempStrip 정보 중복**(헤더 틴트와) — 유지하되 backlog 재검토.

## Out of Scope (Backlog)

- SectorTempStrip vs 헤더 틴트 중복 재검토(스트립 제거 또는 축약).
- 그룹 정렬 키 다양화(이름·시총).
- 헤더 틴트 α 사용자 설정.
- **행 등락 텍스트 굵기/톤을 `|등락|` 비례 변조** — 칩 제거로 잃은 개별 강도 신호 보전(Risks 참조).
- **등락 칼럼 폭 축소**(4.25rem → ~3.75rem) — 화살표 제거로 여유 생김(정렬 안정성 재검증 필요).
- 운영 메모: `EnterWorktree` 기본 baseRef(`fresh`=origin/main)가 local main보다 뒤처질 때 워크트리 베이스 스테일 — 작업 전 `git reset --hard main` 확인.
