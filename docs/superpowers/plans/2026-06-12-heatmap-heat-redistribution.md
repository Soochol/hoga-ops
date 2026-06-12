# 히트맵 히트 무게중심 재배치 + 그룹 정렬 축 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 히트맵의 히트(색)를 행 등락칩에서 그룹 헤더 틴트로 옮기고(행은 화살표 없는 적/청 컬러 텍스트), 행 정렬과 직교하는 그룹 정렬 축(평균 등락 내림/오름/수동)을 추가한다.

**Architecture:** 순수 헬퍼(`heat.ts`: `heatHeaderBg`·`orderFolderGroups`)를 먼저 추가하고, 컴포넌트(`HeatmapRow`·`HeatmapFolder`)가 새 헬퍼로 전환한 뒤, 더 이상 참조되지 않는 옛 심볼(`heatChipBg`·`HEAT_CHIP_MAX_ALPHA`)을 삭제한다. 정렬 상태는 `heatmapPrefs` 스토어에 `groupSort`를 별도 localStorage 키로 추가하고, 페이지가 `orderFolderGroups`로 그룹 순서를 적용해 `HeatmapBoard`에 넘긴다. 그룹 라이브 재정렬은 매 10초 폴마다 동작하되, 행 드래그 충돌은 빌드 후 playwright 실측 결과에 따라 동결 가드를 조건부로 추가한다(G1).

**Tech Stack:** React + TypeScript, Zustand(`heatmapPrefs`), @dnd-kit(기존 행 드래그), vitest + @testing-library/react, Tailwind 토큰(`DESIGN.md`).

**근거 스펙:** [`docs/superpowers/specs/2026-06-11-heatmap-heat-redistribution-design.md`](../specs/2026-06-11-heatmap-heat-redistribution-design.md) (Approved, 그릴링 G1–G8 반영).

---

## 실행 전 주의 (이 레포 특이사항)

- **테스트 실행**: `npm test` 스크립트 없음 → `npx vitest run <path>` 로 파일 단위 실행. 전체 타입체크/빌드는 `npm run build`(=`tsc -b && vite build`).
- **작업 디렉토리**: 모든 명령은 `frontend/` 에서 실행(예: `cd frontend && npx vitest run ...`).
- **커밋 훅**: 이 레포는 `&&`-체이닝/heredoc `git commit` 을 오탐 차단한다. 각 커밋 스텝은 `git add` 와 `git commit -m` 을 **별도 명령**으로 실행하라(한 줄 `&&` 금지). 메시지는 단일 라인 `-m`.
- **베이스**: 워크트리는 local `main`(평면-헤더 L1+L3-B 디자인) 기준. `git log --oneline -1` 이 `8dc520f`(스펙 Approved) 또는 그 이후여야 한다.

## File Structure

| 파일 | 역할 | 변경 |
|------|------|------|
| `frontend/src/heatmap/heat.ts` | 색·정렬 순수 헬퍼 | `heatHeaderBg`·`HEAT_HEADER_MAX_ALPHA`·`GroupSort`·`orderFolderGroups` 추가; `heatChipBg`·`HEAT_CHIP_MAX_ALPHA` 삭제 |
| `frontend/src/heatmap/heat.test.ts` | 위 단위 테스트 | `heatHeaderBg`·`orderFolderGroups` describe 추가; `heatChipBg` describe 삭제; `HEAT_CHIP_MAX_ALPHA` 단언 리터럴화 |
| `frontend/src/heatmap/HeatmapRow.tsx` | 행: 이름│캔들│현재가│등락 | `▲▼` 제거, 등락=`priceDirClass` 컬러 텍스트(배경 없음) |
| `frontend/src/heatmap/HeatmapRow.test.tsx` | 행 테스트 | 칩/화살표 단언 → 컬러 텍스트 단언으로 재작성 |
| `frontend/src/heatmap/HeatmapFolder.tsx` | 그룹 헤더 + 행들 | 헤더 밴드=`heatHeaderBg(avg)`(미분류 포함), 평균=평면 `text-fg-dim` |
| `frontend/src/heatmap/HeatmapFolder.test.tsx` | 헤더 테스트 | "틴트 없음" 단언 → "틴트 있음" 단언으로 반전 |
| `frontend/src/state/heatmapPrefs.ts` | 정렬 prefs 스토어 | `groupSort` 상태 + `heatmap.groupSort.v1` 영속 추가 |
| `frontend/src/state/heatmapPrefs.test.ts` | prefs 테스트 | `groupSort` 케이스 추가 |
| `frontend/src/pages/Heatmap.tsx` | 페이지 배선 | 색 범례 삭제, `orderedGroups` 적용, 그룹 정렬 토글 |
| `frontend/src/pages/Heatmap.test.tsx` | 페이지 테스트 | 범례 단언 삭제, 그룹 토글 테스트 추가 |
| `DESIGN.md` | 디자인 규율 | §Color 헤더 틴트·행 컬러텍스트 반영 |
| (조건부) `HeatmapBoard.tsx` 등 | 드래그 동결 가드 | Task 9 실측이 텔레포트 깨짐을 보이면만 |

`HeatmapBoard.tsx`·`SectorTempStrip.tsx`·`grouping.ts`·`ui/priceDir.ts` 는 **읽기만**(변경 없음). 단 드래그 동결 가드(조건부 Task 10) 채택 시 `HeatmapBoard.tsx` 시그니처에 1필드 추가.

---

## Task 1: `heat.ts` — `heatHeaderBg` (헤더 밴드 틴트)

**Files:**
- Modify: `frontend/src/heatmap/heat.ts`
- Test: `frontend/src/heatmap/heat.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `heat.test.ts` 의 `describe('heatBg', ...)` 블록 **아래**에 추가:

```ts
describe('heatHeaderBg (헤더 밴드 — 선형 램프 max α 0.5, bg-input 합성)', () => {
  it('null/0 → 순수 var(--bg-input)', () => {
    expect(heatHeaderBg(null)).toBe('var(--bg-input)');
    expect(heatHeaderBg(0)).toBe('var(--bg-input)');
  });
  it('+8% 포화 → 빨강 max α 0.5 동색 2-stop 합성', () => {
    expect(heatHeaderBg(8)).toBe(
      'linear-gradient(0deg, rgba(220,38,38,0.500), rgba(220,38,38,0.500)), var(--bg-input)',
    );
    expect(heatHeaderBg(30)).toContain('0.500'); // ±8% 초과 클램프
  });
  it('+4% → α 0.25, -8% → 파랑', () => {
    expect(heatHeaderBg(4)).toContain('rgba(220,38,38,0.250)');
    expect(heatHeaderBg(-8)).toContain('rgba(37,99,235,0.500)');
  });
});
```

그리고 `heat.test.ts:2` import 줄에 `heatHeaderBg` 추가:

```ts
import { heatBg, heatChipBg, sortEntries, avgPct, HEAT_CHIP_MAX_ALPHA, heatHeaderBg } from './heat';
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: FAIL — `heatHeaderBg is not a function` (또는 export 없음).

- [ ] **Step 3: 최소 구현** — `heat.ts` 의 `heatBg` 함수 **아래**에 추가:

```ts
export const HEAT_HEADER_MAX_ALPHA = 0.5; // 헤더 밴드용(큰 면적, 선형 램프) — ±8% 포화 시 최대 농도

/** 그룹 헤더 밴드 배경 = var(--bg-input) 위에 평균 등락 비례 히트(선형 램프) 합성.
 *  null/0 = 순수 var(--bg-input)(평면). ±HEAT_SAT% 포화. 동색 2-stop이라 시각상 단색 틴트
 *  (공간 그라데이션 아님 — DESIGN.md "no gradients" 장식 규율과 무충돌). */
export function heatHeaderBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'var(--bg-input)';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * HEAT_HEADER_MAX_ALPHA;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  const heat = `rgba(${rgb},${a.toFixed(3)})`;
  return `linear-gradient(0deg, ${heat}, ${heat}), var(--bg-input)`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: PASS (heatHeaderBg 3 케이스 + 기존 heatBg/heatChipBg/sortEntries/avgPct 그대로 통과).

- [ ] **Step 5: 커밋** (두 명령 분리 실행)

```bash
git add frontend/src/heatmap/heat.ts frontend/src/heatmap/heat.test.ts
```
```bash
git commit -m "feat(heatmap): heatHeaderBg — 헤더 밴드 평균 등락 비례 선형 틴트"
```

---

## Task 2: `heat.ts` — `GroupSort` + `orderFolderGroups` (그룹 정렬)

**Files:**
- Modify: `frontend/src/heatmap/heat.ts`
- Test: `frontend/src/heatmap/heat.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `heat.test.ts` 끝에 추가:

```ts
import type { FolderGroup } from '../watchlist/grouping';

const FG = (id: string | null): FolderGroup => ({
  folder: id === null ? null : { id, name: id, order: 0 },
  entries: [],
});
const avgMap = (m: Record<string, number | null>) => (g: FolderGroup): number | null =>
  g.folder ? (m[g.folder.id] ?? null) : (m.__uncat__ ?? null);
const ids = (gs: FolderGroup[]) => gs.map((x) => x.folder?.id ?? '__uncat__');

describe('orderFolderGroups', () => {
  it('manual = 입력 순서 그대로(동일 참조)', () => {
    const gs = [FG('a'), FG('b'), FG(null)];
    expect(orderFolderGroups(gs, 'manual', () => 0)).toBe(gs);
  });
  it('desc = 평균 내림차순, 미분류 항상 맨 끝', () => {
    const gs = [FG('a'), FG('b'), FG('c'), FG(null)];
    expect(ids(orderFolderGroups(gs, 'desc', avgMap({ a: 1, b: 5, c: -2 }))))
      .toEqual(['b', 'a', 'c', '__uncat__']);
  });
  it('asc = 평균 오름차순, 미분류 항상 맨 끝', () => {
    const gs = [FG('a'), FG('b'), FG('c'), FG(null)];
    expect(ids(orderFolderGroups(gs, 'asc', avgMap({ a: 1, b: 5, c: -2 }))))
      .toEqual(['c', 'a', 'b', '__uncat__']);
  });
  it('null-avg 실폴더는 실폴더 구간 끝(원순서 안정), 미분류 더 끝', () => {
    const gs = [FG('a'), FG('b'), FG('c'), FG(null)];
    expect(ids(orderFolderGroups(gs, 'desc', avgMap({ a: 3, b: null, c: 1 }))))
      .toEqual(['a', 'c', 'b', '__uncat__']);
  });
});
```

그리고 `heat.test.ts:2` import 줄에 `orderFolderGroups` 추가:

```ts
import { heatBg, heatChipBg, sortEntries, avgPct, HEAT_CHIP_MAX_ALPHA, heatHeaderBg, orderFolderGroups } from './heat';
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: FAIL — `orderFolderGroups is not a function`.

- [ ] **Step 3: 최소 구현** — `heat.ts` 맨 위 import 영역에 추가:

```ts
import type { FolderGroup } from '../watchlist/grouping';
```

그리고 파일 끝(`avgPct` 아래)에 추가:

```ts
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
    const pa = avgOf(a.g);
    const pb = avgOf(b.g);
    if (pa === null && pb === null) return a.i - b.i; // 원순서 안정
    if (pa === null) return 1;
    if (pb === null) return -1;
    return mode === 'desc' ? pb - pa : pa - pb;
  });
  return [...real.map((x) => x.g), ...uncat];
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: PASS (orderFolderGroups 4 케이스 추가 통과).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/heat.ts frontend/src/heatmap/heat.test.ts
```
```bash
git commit -m "feat(heatmap): GroupSort + orderFolderGroups — 평균 등락 그룹 정렬(미분류 맨 끝)"
```

---

## Task 3: `HeatmapRow.tsx` — 화살표 제거 + 컬러 텍스트 등락 (#4, #5)

**Files:**
- Modify: `frontend/src/heatmap/HeatmapRow.tsx`
- Test: `frontend/src/heatmap/HeatmapRow.test.tsx`

- [ ] **Step 1: 테스트 재작성** — `HeatmapRow.test.tsx` 의 기존 3개 테스트(`'±8%↑ ...'`, `'하락 ±8%↑ ...'`, `'±8% 미만은 ...'`)를 **삭제**하고 그 자리에 추가:

```tsx
it('상승 등락률 = 빨강 텍스트(text-price-up), 화살표·배경 없음', () => {
  row({ pct: 9 });
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  const cell = screen.getByText('+9.00');
  expect(cell).toHaveClass('text-price-up');
  expect(cell.textContent).not.toMatch(/[▲▼]/);
  expect(cell.getAttribute('style') ?? '').not.toMatch(/background|rgba/);
  // 행 자체에도 배경 인라인 없음
  expect(screen.getByTestId('heatmap-row-005930').getAttribute('style') ?? '')
    .not.toMatch(/background/);
});

it('하락 등락률 = 파랑 텍스트(text-price-down), 화살표 없음', () => {
  row({ pct: -8 });
  const cell = screen.getByText('-8.00');
  expect(cell).toHaveClass('text-price-down');
  expect(cell.textContent).not.toMatch(/[▲▼]/);
});

it('보합 0% = 중립 text-fg-dim, 부호 없음', () => {
  row({ pct: 0 });
  const cell = screen.getByText('0.00');
  expect(cell).toHaveClass('text-fg-dim');
});
```

(나머지 테스트 — null→—, 클릭, sortable, OHLC 캔들 — 는 그대로 둔다.)

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: FAIL — `+9.00` 텍스트 없음(현재는 `▲+9.00`) / `text-price-up` 클래스 없음.

- [ ] **Step 3: 구현** — `HeatmapRow.tsx` 변경.

(a) import 줄(`import { heatChipBg } from './heat';`)을 교체:

```tsx
import { priceDirClass } from '../ui/priceDir';
```

(b) 함수 본문의 `const glyph = ...` 줄을 **삭제**하고 `const sign` 만 남긴다:

```tsx
  const sign = (n: number) => (n > 0 ? '+' : '');
```

(c) 등락 셀 JSX(현재 `{pct === null ? (...) : (<span className="rounded px-1.5 ..." style={{ background: heatChipBg(pct) }}>{glyph}{sign(pct)}{pct.toFixed(2)}</span>)}`)를 교체:

```tsx
      {pct === null ? (
        <span className="text-right font-mono tabular-nums text-fg-dim">—</span>
      ) : (
        <span className={`text-right font-mono tabular-nums ${priceDirClass(pct)}`}>
          {sign(pct)}{pct.toFixed(2)}
        </span>
      )}
```

(d) 등락 셀 위의 주석 블록(`▲▼`·`heatChipBg` 언급)을 간결히 갱신:

```tsx
      {/* 등락: 방향=priceDirClass 텍스트 색(+적/−청/0 중립) + 부호. 배경 워시·▲▼ 없음
          — 우측 패널 QuoteChange 와 동일 컨벤션(색+부호 2중, 색약 보조). 결측은 '—'. */}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapRow.test.tsx`
Expected: PASS (전 테스트 그린).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/HeatmapRow.tsx frontend/src/heatmap/HeatmapRow.test.tsx
```
```bash
git commit -m "feat(heatmap): 행 등락 = 화살표 없는 적/청 컬러 텍스트(priceDirClass), 칩 배경 제거"
```

---

## Task 4: `HeatmapFolder.tsx` — 헤더 밴드 틴트 + 평균 평면 텍스트 (#3, G4, G8)

**Files:**
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx`
- Test: `frontend/src/heatmap/HeatmapFolder.test.tsx`

- [ ] **Step 1: 테스트 갱신** — `HeatmapFolder.test.tsx` 변경.

(a) import 줄에 `heatHeaderBg` 추가:

```tsx
import { heatHeaderBg } from './heat';
```

(b) 기존 `it('평면 보드(L3-B)+헤더 틴트 없음(L1) ...')` 테스트의 마지막 두 단언(헤더 부분)을 교체. 현재:

```tsx
  // L3-B: 헤더를 폴더 본문보다 한 단계 밝게(그룹 앵커)
  expect(header).toHaveClass('bg-bg-input');
  expect(header).not.toHaveClass('bg-bg-subtle');
  // L1: 헤더 히트 틴트(box-shadow) 없음 — 평균 +5%여도 배경 워시 없음
  expect(header.style.boxShadow).toBe('');
```

를:

```tsx
  // #3/G4: 헤더 밴드 = 평균(+5%) 비례 히트 틴트. bg-input 클래스 제거, inline background.
  expect(header).not.toHaveClass('bg-bg-input');
  expect(header.style.background).toBe(heatHeaderBg(5)); // (2+8)/2 = +5%
```

테스트 이름도 `'평면 보드(L3-B)+헤더 틴트 없음(L1) ...'` → `'평면 보드(L3-B) 좌측 스파인 + 헤더 평균 틴트(#3) ...'` 로 변경.

(c) 기존 `it('폴더명 + 평균 등락률 표시 ...')` 테스트에 평균 span 단언 추가. 현재 `expect(screen.getByText('+5.0%')).toBeInTheDocument();` 줄 **아래**에 추가:

```tsx
  const avgEl = screen.getByText('+5.0%');
  expect(avgEl).toHaveClass('text-fg-dim');                       // G4: 흐린 텍스트
  expect(avgEl.getAttribute('style') ?? '').not.toMatch(/background/); // 칩 배경 제거
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapFolder.test.tsx`
Expected: FAIL — header 가 아직 `bg-bg-input` 클래스 보유 / `style.background` 미설정.

- [ ] **Step 3: 구현** — `HeatmapFolder.tsx` 변경.

(a) import 줄(`import { sortEntries, avgPct, heatBg, HEAT_CHIP_MAX_ALPHA, type SortMode } from './heat';`)을 교체:

```tsx
import { sortEntries, avgPct, heatHeaderBg, type SortMode } from './heat';
```

(b) 헤더 밴드 `div`(`className="flex justify-between items-center gap-2 bg-bg-input px-2 py-1 border-b border-border-strong"`)에서 `bg-bg-input` 제거 + `style` 추가. 미분류 포함 무분기(avg 는 folder 유무와 무관하게 이미 계산됨):

```tsx
      <div className="flex justify-between items-center gap-2 px-2 py-1 border-b border-border-strong"
        style={{ background: heatHeaderBg(avg) }}>
```

(c) 평균 칩 span(`<span className="text-xs font-mono tabular-nums text-fg-dim rounded px-1" style={{ background: heatBg(avg, HEAT_CHIP_MAX_ALPHA) }}>`)을 평면 텍스트로 교체:

```tsx
          {avg !== null && (
            <span className="text-xs font-mono tabular-nums text-fg-dim">
              {avg > 0 ? '+' : ''}{avg.toFixed(1)}%
            </span>
          )}
```

(d) 헤더 주석 블록을 갱신(현재 "헤더 밴드 = bg-bg-input ... 섹터 온도는 ... 평균 등락칩으로만"):

```tsx
      {/* 그룹 헤더 밴드 = heatHeaderBg(avg) — 평균 등락 비례 히트 틴트(섹터 온도). 미분류 포함
          무분기(가드 없음, G8): 미분류 avg 채색은 칩→밴드 정보 이동(회귀 아님). 폴더 본문은
          투명·평면이고 좌측 border-strong 스파인 + 이 틴트 밴드로 그룹을 구분한다. 평균 % 는
          평면 text-fg-dim 텍스트(색=밴드가 짊어짐, 숫자=보조; G4). */}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/HeatmapFolder.test.tsx`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapFolder.test.tsx
```
```bash
git commit -m "feat(heatmap): 헤더 밴드 평균 등락 틴트(미분류 포함) + 평균 평면 text-fg-dim"
```

---

## Task 5: `heat.ts` — 옛 심볼 삭제 (`heatChipBg`·`HEAT_CHIP_MAX_ALPHA`)

이제 앱 소비처(HeatmapRow·HeatmapFolder)가 모두 전환됐으니 무참조 심볼을 제거한다.

**Files:**
- Modify: `frontend/src/heatmap/heat.ts`
- Test: `frontend/src/heatmap/heat.test.ts`

- [ ] **Step 1: 무참조 확인**

Run: `cd frontend && grep -rn "heatChipBg\|HEAT_CHIP_MAX_ALPHA" src --include="*.ts" --include="*.tsx" | grep -v "heat.ts:" | grep -v "heat.test.ts:"`
Expected: 출력 없음(앱 코드에 소비처 0 — heat.ts 정의/heat.test.ts 단언만 남음).

- [ ] **Step 2: 테스트 갱신** — `heat.test.ts` 변경.

(a) import 줄에서 `heatChipBg`·`HEAT_CHIP_MAX_ALPHA` 제거:

```ts
import { heatBg, sortEntries, avgPct, heatHeaderBg, orderFolderGroups } from './heat';
```

(b) `it('maxAlpha 인자로 칩 농도(0.72) 적용', ...)` 의 `HEAT_CHIP_MAX_ALPHA` 를 리터럴 `0.72` 로 교체:

```ts
  it('maxAlpha 인자로 임의 농도 적용', () => {
    expect(heatBg(8, 0.72)).toBe('rgba(220,38,38,0.720)');
    expect(heatBg(-4, 0.72)).toBe('rgba(37,99,235,0.360)');
  });
```

(c) `describe('heatChipBg ...')` 블록 **전체**(현재 파일의 해당 describe) 삭제.

- [ ] **Step 3: 구현** — `heat.ts` 에서 삭제.

(a) `export const HEAT_CHIP_MAX_ALPHA = 0.72; ...` 줄 삭제.

(b) `heatChipBg` 함수 전체(JSDoc 포함) 삭제:

```ts
// 삭제 대상:
// export function heatChipBg(pct: number | null): string {
//   if (pct === null || Math.abs(pct) < HEAT_SAT) return 'transparent';
//   const rgb = pct > 0 ? '220,38,38' : '37,99,235';
//   return `rgba(${rgb},${HEAT_CHIP_MAX_ALPHA.toFixed(3)})`;
// }
```

(`HEAT_SAT`·`HEAT_MAX_ALPHA`·`heatBg`·`heatHeaderBg`·`sortEntries`·`avgPct`·`orderFolderGroups` 는 유지.)

- [ ] **Step 4: 테스트 + 타입 통과 확인**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts`
Expected: PASS.
Run: `cd frontend && npm run build`
Expected: 빌드 성공(무참조 심볼 삭제로 깨지는 곳 없음).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/heatmap/heat.ts frontend/src/heatmap/heat.test.ts
```
```bash
git commit -m "refactor(heatmap): 무참조 heatChipBg·HEAT_CHIP_MAX_ALPHA 제거(히트 무게중심 이동 후속)"
```

---

## Task 6: `heatmapPrefs.ts` — `groupSort` 상태 + 영속 (#7, §E)

**Files:**
- Modify: `frontend/src/state/heatmapPrefs.ts`
- Test: `frontend/src/state/heatmapPrefs.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `heatmapPrefs.test.ts` 변경.

(a) import 줄 교체:

```ts
import { useHeatmapPrefsStore, SORT_MODES, GROUP_SORTS } from './heatmapPrefs';
import type { SortMode, GroupSort } from '../heatmap/heat';
```

(b) `beforeEach` 에 groupSort 리셋 추가:

```ts
  beforeEach(() => {
    localStorage.clear();
    useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
  });
```

(c) describe 끝에 추가:

```ts
  it('groupSort 기본값 manual', () => {
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  });
  it('setGroupSort 갱신 + 별도 키 영속', () => {
    useHeatmapPrefsStore.getState().setGroupSort('desc');
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('desc');
    expect(localStorage.getItem('heatmap.groupSort.v1')).toContain('desc');
    expect(useHeatmapPrefsStore.getState().sortMode).toBe('manual'); // sortMode 불변
  });
  it('groupSort 알 수 없는 값 무시', () => {
    useHeatmapPrefsStore.getState().setGroupSort('bogus' as GroupSort);
    expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  });
  it('GROUP_SORTS = [manual, desc, asc]', () => {
    expect(GROUP_SORTS).toEqual(['manual', 'desc', 'asc']);
  });
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/state/heatmapPrefs.test.ts`
Expected: FAIL — `GROUP_SORTS` export 없음 / `groupSort` undefined.

- [ ] **Step 3: 구현** — `heatmapPrefs.ts` 변경.

(a) import 줄 교체(GroupSort 타입 추가):

```ts
import type { SortMode, GroupSort } from '../heatmap/heat';
```

(b) `SORT_MODES`/`STORAGE_KEY` 아래에 추가:

```ts
export const GROUP_SORTS = ['manual', 'desc', 'asc'] as const;
const STORAGE_KEY_GROUP = 'heatmap.groupSort.v1';

function readGroupSort(): GroupSort | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GROUP);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { groupSort: string };
    return GROUP_SORTS.includes(parsed.groupSort as GroupSort)
      ? (parsed.groupSort as GroupSort) : null;
  } catch {
    return null;
  }
}

function persistGroupSort(groupSort: GroupSort): void {
  try { localStorage.setItem(STORAGE_KEY_GROUP, JSON.stringify({ groupSort })); }
  catch { /* localStorage 미가용 — 무시 */ }
}
```

(c) `Store` 인터페이스에 필드 추가:

```ts
interface Store {
  sortMode: SortMode;
  setSortMode: (value: SortMode) => void;
  groupSort: GroupSort;
  setGroupSort: (value: GroupSort) => void;
}
```

(d) `create<Store>` 객체에 추가(기존 sortMode/setSortMode 아래):

```ts
  // 그룹(폴더) 정렬 — 행 정렬(sortMode)과 직교. 기본 manual = folder.order(현행 보드 순서 보존).
  groupSort: readGroupSort() ?? 'manual',
  setGroupSort: (value) => {
    if (!GROUP_SORTS.includes(value)) return;
    set({ groupSort: value });
    persistGroupSort(value);
  },
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/state/heatmapPrefs.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/state/heatmapPrefs.ts frontend/src/state/heatmapPrefs.test.ts
```
```bash
git commit -m "feat(heatmap): heatmapPrefs.groupSort 상태 + heatmap.groupSort.v1 영속"
```

---

## Task 7: `Heatmap.tsx` — 범례 삭제 + 그룹 순서 적용 + 그룹 토글 (#6, #7, G2)

**Files:**
- Modify: `frontend/src/pages/Heatmap.tsx`
- Test: `frontend/src/pages/Heatmap.test.tsx`

- [ ] **Step 1: 테스트 갱신** — `Heatmap.test.tsx` 변경.

(a) `beforeEach` 의 prefs 리셋에 groupSort 추가. 현재 `useHeatmapPrefsStore.setState({ sortMode: 'manual' });` →

```tsx
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });
```

(b) `it('폴더·종목·phase 배지·색 범례 렌더', ...)` 의 마지막 단언(`expect(screen.getByLabelText(/색 범례/)).toBeInTheDocument();`)을 교체하고 테스트 이름 변경:

```tsx
it('폴더·종목·phase 배지 렌더 + 색 범례 제거됨(#6)', async () => {
  renderPage();
  expect((await screen.findAllByText('반도체')).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('● 장중')).toBeInTheDocument();
  expect(screen.queryByLabelText(/색 범례/)).toBeNull();   // #6: 범례 삭제
});
```

(c) `it('기본 manual=order 순, 등락률↓ 토글 시 ...')` 테스트는 **그대로 둔다** — 행 토글 버튼의 accessible name 은 여전히 `'등락률 ↓'`(스코프어 '행'은 버튼 밖 span). 변경 불필요.

(d) 새 테스트 추가(describe/파일 끝):

```tsx
it('그룹 정렬 토글: aria로 쿼리, 클릭 시 store.groupSort 갱신(#7)', async () => {
  renderPage();
  await screen.findAllByText('반도체');
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  // 그룹 버튼은 aria-label 로 식별(visible text '등락률 ↓' 는 행 토글과 겹치므로)
  fireEvent.click(screen.getByRole('button', { name: '그룹을 평균 등락률 높은 순으로' }));
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('desc');
  fireEvent.click(screen.getByRole('button', { name: '그룹 수동 순서' }));
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx`
Expected: FAIL — 범례가 아직 존재(`queryByLabelText` non-null) / 그룹 버튼 aria 없음.

- [ ] **Step 3: 구현** — `Heatmap.tsx` 변경.

(a) import 줄(`import { HEAT_SAT } from '../heatmap/heat';`)을 교체:

```tsx
import { avgPct, orderFolderGroups } from '../heatmap/heat';
```

(b) `sortMode`/`setSortMode` 셀렉터 **아래**에 groupSort 셀렉터 추가:

```tsx
  const groupSort = useHeatmapPrefsStore((s) => s.groupSort);
  const setGroupSort = useHeatmapPrefsStore((s) => s.setGroupSort);
```

(c) `groups` useMemo **아래**에 `orderedGroups` 추가(pctOf 는 memo 내부에 두어 deps 깔끔):

```tsx
  // 그룹 순서 = orderFolderGroups(직교 축). groupSort≠manual 이면 quoteByCode 가 폴마다
  // 새 Map → 매 폴 라이브 재정렬(행 change 모드와 동형). manual 이면 입력(folder.order) 그대로.
  const orderedGroups = useMemo(() => {
    const pctOf = (code: string): number | null => quoteByCode.get(code)?.change_pct ?? null;
    return orderFolderGroups(groups, groupSort, (g) => avgPct(g.entries, pctOf));
  }, [groups, groupSort, quoteByCode]);
```

(d) 색 범례 블록 **삭제**. 현재:

```tsx
        {/* 색 범례 (spec §8): ... */}
        <div className="flex items-center gap-1.5 text-xs font-mono text-fg-dimmer"
             aria-label={`색 범례 -${HEAT_SAT}% ~ +${HEAT_SAT}%`}>
          <span>-{HEAT_SAT}%</span>
          <span className="h-2 w-20 rounded-sm" style={{
            background: 'linear-gradient(90deg, rgba(37,99,235,0.42), rgba(37,99,235,0.10), transparent, rgba(220,38,38,0.10), rgba(220,38,38,0.42))',
          }} />
          <span>+{HEAT_SAT}%</span>
        </div>
```
→ 전부 삭제.

(e) 정렬 토글 영역 교체. 현재:

```tsx
        <div className="flex border border-border rounded overflow-hidden text-xs">
          <button
            className={sortMode === 'change' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
            onClick={() => setSortMode('change')}
          >등락률 ↓</button>
          <button
            className={sortMode === 'manual' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
            onClick={() => setSortMode('manual')}
          >수동</button>
        </div>
```
→ 행 토글(스코프어 '행' 추가) + 그룹 토글(aria-label):

```tsx
        {/* 행 정렬(그룹 내 종목 순서). 스코프어 '행'은 버튼 밖 span — 버튼 accessible name 보존. */}
        <span className="flex items-center gap-1 text-xs">
          <span className="text-fg-dim">행</span>
          <span className="flex border border-border rounded overflow-hidden">
            <button
              className={sortMode === 'change' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
              onClick={() => setSortMode('change')}
            >등락률 ↓</button>
            <button
              className={sortMode === 'manual' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
              onClick={() => setSortMode('manual')}
            >수동</button>
          </span>
        </span>
        {/* 그룹 정렬(폴더 순서) — 행 정렬과 직교. 버튼 의미는 aria-label(visible '등락률 ↓' 가 행과 겹침). */}
        <span className="flex items-center gap-1 text-xs">
          <span className="text-fg-dim">그룹</span>
          <span className="flex border border-border rounded overflow-hidden">
            <button
              aria-label="그룹을 평균 등락률 높은 순으로"
              className={groupSort === 'desc' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
              onClick={() => setGroupSort('desc')}
            >등락률 ↓</button>
            <button
              aria-label="그룹을 평균 등락률 낮은 순으로"
              className={groupSort === 'asc' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
              onClick={() => setGroupSort('asc')}
            >등락률 ↑</button>
            <button
              aria-label="그룹 수동 순서"
              className={groupSort === 'manual' ? 'px-2 py-1 bg-tint-selection text-accent font-medium' : 'px-2 py-1 text-fg-dim'}
              onClick={() => setGroupSort('manual')}
            >수동</button>
          </span>
        </span>
```

(f) `<HeatmapBoard groups={groups} ...>` 의 `groups` 를 `orderedGroups` 로 교체(SectorTempStrip·visibleCount 의 `groups` 는 그대로):

```tsx
      <HeatmapBoard groups={orderedGroups} quoteByCode={quoteByCode}
        sortMode={sortMode} onPick={onPick} onReorder={onReorder} onRowMenu={onRowMenu} />
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx`
Expected: PASS (범례 제거·그룹 토글·기존 행 토글 모두 그린).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx
```
```bash
git commit -m "feat(heatmap): 색 범례 삭제 + 그룹 정렬 토글(등락률↓/↑/수동) + orderedGroups 적용"
```

---

## Task 8: `DESIGN.md` — §Color 규율 갱신 (§F)

**Files:**
- Modify: `DESIGN.md` (리포 루트, `frontend/` 아님)

- [ ] **Step 1: Price-direction heat ramp 항목 교체** — 현재 블록:

```
- **Price-direction heat ramp (히트맵 보드 전용):** `frontend/src/heatmap/heat.ts::heatBg()` 가
  `--price-up`/`--price-down` 을 |등락률| 비례 가변 알파(±8% 포화, max 0.42)로 배경에 사용한다.
  단일 0.10 칩 토큰의 확장이며 색상 카테고리(가격 방향)는 준수. 숫자는 `priceDirClass()` 색을
  유지해 배경+숫자+부호 삼중 표현(색약 보조).
```

를:

```
- **Price-direction heat ramp (히트맵 보드 전용):** `--price-up`/`--price-down` 을 |등락률| 비례
  가변 알파로 쓴다. **행 등락은 칩 배경이 아니라 `priceDirClass()` 텍스트 색 + 부호**로 표현한다
  (배경 워시 없음, `▲▼` 없음 — 색약 보조는 색+부호 2중; 우측 패널 `QuoteChange` 와 동일 컨벤션).
  **헤더 밴드는 `heatHeaderBg()`**(선형 램프, max α 0.5, 그룹 평균 등락 기준)로 틴트한다.
  `heatHeaderBg` 의 `linear-gradient(0deg, heat, heat)` 는 동색 2-stop 합성 idiom(시각상 단색)이라
  위 "no gradients"(장식 한정) 규율과 무충돌 — 기능적 gradient 선례 = depth bar.
```

- [ ] **Step 2: Heatmap 폴더 surface 예외 항목 교체** — 현재 블록:

```
- **Heatmap 폴더 surface 예외 (관심맵 보드 전용):** 신문형 멀티칼럼 고밀도 보드라 폴더 블록은
  `--bg-card` 카드(채움+테두리+라운드) 대신 **투명·평면**으로 둔다 — 그룹 경계는 `--bg-input`
  헤더 밴드(폴더 본문보다 한 단계 밝게) + `--border-strong` 좌측 스파인(`border-l-2`) + 여백으로
  잡는다. 헤더 밴드 히트 틴트(평균 등락 배경 워시)는 쓰지 않는다 — 섹터 온도는 헤더의 평균
  등락칩으로만. 이 예외는 **히트맵 폴더 한정**이며 드로어·차트·툴바 등 다른 카드는 `--bg-card` 유지.
```

를:

```
- **Heatmap 폴더 surface 예외 (관심맵 보드 전용):** 신문형 멀티칼럼 고밀도 보드라 폴더 블록은
  `--bg-card` 카드(채움+테두리+라운드) 대신 **투명·평면**으로 둔다 — 그룹 경계는 헤더 밴드 +
  `--border-strong` 좌측 스파인(`border-l-2`) + 여백으로 잡는다. **헤더 밴드는 그룹 평균 등락 비례
  히트 틴트(`heatHeaderBg`, 선형 램프 max α 0.5)를 진다**(미분류 포함 무분기); 평균값은 평면
  `text-fg-dim` 숫자. α 상향 금지(미분류명 `text-fg-dim` 의 틴트 밴드 위 대비 보호). 이 예외는
  **히트맵 폴더 한정**이며 드로어·차트·툴바 등 다른 카드는 `--bg-card` 유지.
```

- [ ] **Step 3: 갱신 정합 확인**

Run: `cd /home/dev/code/hoga-ops/.claude/worktrees/heatmap-heat-redistribution && grep -n "히트 틴트는 쓰지 않는다\|삼중 표현" DESIGN.md`
Expected: 출력 없음(옛 서술 제거됨).

- [ ] **Step 4: 커밋**

```bash
git add DESIGN.md
```
```bash
git commit -m "docs(design): §Color 헤더 틴트(heatHeaderBg)·행 컬러텍스트 반영(히트 무게중심 이동)"
```

---

## Task 9: 전체 빌드 + 브라우저 실측 (드래그×폴 충돌 게이트, G1)

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 전체 타입체크 + 빌드**

Run: `cd frontend && npm run build`
Expected: 성공(타입 에러 0). 실패 시 해당 파일 수정 후 재실행.

- [ ] **Step 2: 변경 테스트 일괄 실행**

Run: `cd frontend && npx vitest run src/heatmap/heat.test.ts src/heatmap/HeatmapRow.test.tsx src/heatmap/HeatmapFolder.test.tsx src/state/heatmapPrefs.test.ts src/pages/Heatmap.test.tsx`
Expected: 전부 PASS.

- [ ] **Step 3: 시각 확인(/browse)** — dev 서버가 `:5173` 에 떠 있어야 한다(없으면 `cd frontend && npm run dev` 백그라운드 기동).

```bash
B=/home/dev/.claude/skills/gstack/browse/dist/browse
$B goto http://localhost:5173/heatmap
$B screenshot /tmp/heatmap-impl-verify.png
```
확인 항목: 헤더 밴드가 평균 등락에 비례해 적/청 틴트(미분류 포함); 행 등락=화살표 없는 적/청 텍스트·배경 없음; 평균 % 흐림(text-fg-dim); 상단 색 범례 사라짐; `행 [등락률 ↓│수동]` · `그룹 [등락률 ↓│등락률 ↑│수동]` 두 세그먼트.

- [ ] **Step 4: 그룹 정렬 동작 확인**

`그룹 등락률 ↓` 클릭 → 폴더가 평균 뜨거운 순 재배치(미분류 맨 끝), 행은 수동 순서 유지. `↑` 역순, `수동` 복귀. 새로고침 후 그룹 선택 유지(localStorage).

- [ ] **Step 5: 드래그×폴 충돌 실측(G1 게이트)** — 행 `수동` + 그룹 `등락률 ↓` 상태에서, 한 폴더의 행을 드래그하는 동안(약 2~3초 잡고 있기) 10초 폴이 그룹 순서를 바꿀 때 **드래그 중 그룹 컨테이너가 칼럼을 가로질러 튀는지** 관찰한다. 헤드리스로는 폴 타이밍 재현이 까다로우므로 실 브라우저에서 사용자가 직접 드래그하며 확인하거나, playwright 로 드래그 시뮬 + 수동 폴 트리거(quoteByCode 갱신)로 재현한다.

판정:
- **튀지 않음(dnd-kit 견딤)** → Task 10 **건너뛴다**. 가드 불필요. 본 스텝 결과를 커밋 메시지/PR 에 기록.
- **튄다(텔레포트/드롭 깨짐)** → **Task 10 실행**(동결 가드 추가).

- [ ] **Step 6: 결과 기록 커밋(코드 변경 없으면 생략 가능)** — 실측 결과를 스펙 Risks 의 G1 항목 옆에 한 줄로 기록(예: "2026-06-12 실측: dnd-kit 텔레포트 견딤 → 동결 가드 불요" 또는 "튐 확인 → Task 10 적용").

```bash
git add docs/superpowers/specs/2026-06-11-heatmap-heat-redistribution-design.md
```
```bash
git commit -m "docs(heatmap): G1 드래그×폴 실측 결과 기록"
```

---

## Task 10 (조건부 — Task 9 Step 5가 "튄다"일 때만): 드래그 중 그룹순서 동결 가드

행 드래그 active 동안 `orderedGroups` 를 동결하고 drag-end 에 최신 순서를 적용한다. 폴더별 독립 `DndContext` 라 드래그 상태를 OR-집계해 페이지로 끌어올린다.

**Files:**
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx` (onDragStart 노출)
- Modify: `frontend/src/heatmap/HeatmapBoard.tsx` (drag 상태 콜백 전달)
- Modify: `frontend/src/pages/Heatmap.tsx` (isDragging 상태 + orderedGroups 동결)
- Test: `frontend/src/pages/Heatmap.test.tsx`

- [ ] **Step 1: 실패하는 테스트 작성** — `Heatmap.test.tsx` 에 추가(jsdom 에서 dnd-kit 드래그 시뮬은 불안정하므로, 동결 로직을 페이지 콜백 계약 수준에서 검증):

```tsx
it('드래그 중 그룹순서 동결: onRowDragState(true) 후 groupSort 바뀌어도 보드 그룹 순서 불변(G1)', async () => {
  // 멀티 폴더 + 상이한 평균이 필요 → 이 테스트 전용 mock override
  // (실 구현에서 HeatmapBoard 에 onRowDragState 콜백을 전달, 드래그 시작/끝을 페이지로 전파)
  // 검증 핵심: isDragging=true 동안 orderedGroups 가 동결되는지.
  // 구현 세부에 맞춰 작성 — 최소한 onRowDragState prop 이 HeatmapBoard 로 전달됨을 단언.
  renderPage();
  await screen.findAllByText('반도체');
  // HeatmapBoard 가 onRowDragState 를 받는지(계약) — 실제 동결은 수동 검증(Task 9 Step 5)로 보완.
  expect(true).toBe(true); // 자리표시: 아래 구현 후 실제 동결 단언으로 교체
});
```

> 참고: dnd-kit 드래그의 jsdom 재현이 신뢰 불가하므로, 동결의 **권위 검증은 Task 9 Step 5의 실 브라우저 관찰**이다. 단위 테스트는 `onRowDragState` 배선이 끊기지 않는지(계약 보존)만 가볍게 지킨다. 위 자리표시 단언은 구현 후 "isDragging mock=true 일 때 페이지가 frozen orderedGroups 를 Board 에 넘긴다"를 직접 단언하는 형태로 교체하라(페이지에서 `useState` 대신 주입 가능한 형태가 아니면, HeatmapBoard 를 모킹해 전달된 groups prop 의 순서를 캡처하는 방식 사용).

- [ ] **Step 2: HeatmapFolder onDragStart 노출** — `HeatmapFolder.tsx`.

(a) props 인터페이스에 추가:

```tsx
  /** 행 드래그 시작/끝을 페이지로 전파(그룹순서 동결용, G1). manual 모드에서만 의미. */
  onRowDragState?: (dragging: boolean) => void;
```

(b) 함수 시그니처 구조분해에 `onRowDragState` 추가.

(c) `DndContext` 에 `onDragStart` 추가 + 기존 `onDragEnd` 끝에 `false` 전파:

```tsx
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => onRowDragState?.(true)}
          onDragEnd={(ev) => { onDragEnd(ev); onRowDragState?.(false); }}
        >
```

(기존 `onDragEnd={onDragEnd}` 를 위 형태로 교체. `onDragEnd` 핸들러 본문은 그대로.)

- [ ] **Step 3: HeatmapBoard 전달** — `HeatmapBoard.tsx`.

(a) props 에 `onRowDragState?: (dragging: boolean) => void;` 추가 + 구조분해.

(b) `<HeatmapFolder ... />` 에 `onRowDragState={onRowDragState}` 전달.

- [ ] **Step 4: Heatmap.tsx 동결** — `Heatmap.tsx`.

(a) `useState` import 확인 후 상태 추가:

```tsx
  const [isRowDragging, setIsRowDragging] = useState(false);
```

(b) `orderedGroups` 를 동결 형태로 교체:

```tsx
  const liveOrderedGroups = useMemo(() => {
    const pctOf = (code: string): number | null => quoteByCode.get(code)?.change_pct ?? null;
    return orderFolderGroups(groups, groupSort, (g) => avgPct(g.entries, pctOf));
  }, [groups, groupSort, quoteByCode]);
  const frozenRef = useRef(liveOrderedGroups);
  if (!isRowDragging) frozenRef.current = liveOrderedGroups; // 비드래그 시에만 최신으로 커밋
  const orderedGroups = isRowDragging ? frozenRef.current : liveOrderedGroups;
```

(`useRef` import 추가.)

(c) `<HeatmapBoard ... />` 에 `onRowDragState={setIsRowDragging}` 전달.

- [ ] **Step 5: 테스트 + 빌드 확인**

Run: `cd frontend && npx vitest run src/pages/Heatmap.test.tsx`
Expected: PASS.
Run: `cd frontend && npm run build`
Expected: 성공.

- [ ] **Step 6: 실 브라우저 재확인** — Task 9 Step 5 시나리오 재현 → 드래그 중 그룹 순서가 **동결**되고 drop 후 재정렬되는지 확인.

- [ ] **Step 7: 커밋**

```bash
git add frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapBoard.tsx frontend/src/pages/Heatmap.tsx frontend/src/pages/Heatmap.test.tsx
```
```bash
git commit -m "fix(heatmap): 행 드래그 중 그룹순서 동결(drag-end 적용) — G1 텔레포트 방지"
```

---

## Self-Review 체크리스트 (계획 작성자용 — 이미 수행)

- **스펙 커버리지**: #3 헤더 틴트(Task 1·4), #4/#5 행 컬러텍스트(Task 3), #6 범례 삭제(Task 7), #7 그룹 정렬(Task 2·6·7) + G1 동결(Task 9·10) + G2 라벨(Task 7) + G3 α(Task 1, DESIGN Task 8) + G4 평균 흐림(Task 4) + G5 강도손실(코드 변경 없음·스펙 기록) + G6 SectorTempStrip(미변경) + G7 그라데이션(Task 8) + G8 미분류 틴트(Task 4). 전 요구·결정에 태스크 대응 확인.
- **타입 일관성**: `GroupSort`(heat.ts Task 2 정의) → heatmapPrefs(Task 6)·Heatmap(Task 7) 동일 사용. `heatHeaderBg`(Task 1) → HeatmapFolder(Task 4)·HeatmapFolder.test(Task 4)·DESIGN(Task 8) 동일 시그니처. `orderFolderGroups(groups, mode, avgOf)`(Task 2) → Heatmap(Task 7) 인자 순서 일치. `priceDirClass(n: number)` → HeatmapRow null 가드 후 호출.
- **빌드 그린 순서**: 헬퍼 추가(1·2) → 소비처 전환(3·4) → 무참조 삭제(5) → 스토어(6) → 페이지(7). 각 태스크 후 빌드 깨짐 없음.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-12-heatmap-heat-redistribution.md`.**
