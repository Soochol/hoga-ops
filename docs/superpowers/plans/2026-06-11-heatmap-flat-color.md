# 관심맵 색 가독성 — 평면 보드 + 헤더 틴트 제거 (L1 + L3-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관심맵(/heatmap) 폴더 헤더의 히트 틴트를 제거(L1)하고, 폴더 카드를 투명·평면으로 바꿔 `--border-strong` 좌측 스파인 + `--bg-input` 밝은 헤더로 그룹 경계를 잡는다(L3-B). 캔들 색은 유지(L2 미채택).

**Architecture:** 순수 프론트엔드(React + Tailwind) 표현 변경. 단일 컴포넌트 `HeatmapFolder.tsx`의 className/inline-style만 바꾸고, 그로 인해 죽는 상수(`HEAT_HEADER_MAX_ALPHA`)를 정리하며, DESIGN.md에 히트맵 폴더 surface 예외를 1줄 명시한다. `CandleGlyph`·`HeatmapRow`·`heatBg`·섹터 스트립은 불변(회귀 가드).

**Tech Stack:** React 18, TypeScript, Tailwind CSS(토큰→CSS 변수), Vitest 4 + jsdom + @testing-library/react.

**Spec:** [`docs/superpowers/specs/2026-06-11-heatmap-flat-color-design.md`](../specs/2026-06-11-heatmap-flat-color-design.md) (Approved).

**Branch:** `worktree-heatmap-flat-calm` (worktree `/home/dev/code/hoga-ops/.claude/worktrees/heatmap-flat-calm`).

> **커밋 훅 주의(이 repo):** `block-no-verify` 훅이 `&&`-체이닝/heredoc `git commit`을 오탐 차단한다. **`git add`와 `git commit`을 절대 `&&`로 잇지 말고 각각 단독 명령으로** 실행한다. 멀티라인 메시지는 메시지 파일 + `git commit -F <file>` 사용. 아래 커밋 스텝은 이 규칙을 따른다.

> **작업 디렉터리:** 모든 명령은 워크트리 루트 `/home/dev/code/hoga-ops/.claude/worktrees/heatmap-flat-calm` 기준. 프론트 명령은 그 아래 `frontend/`에서.

---

## File Structure

| 파일 | 역할 | 이 계획에서 |
|---|---|---|
| `frontend/src/heatmap/HeatmapFolder.tsx` | 그룹 블록(헤더 + 행들) | **수정** — 폴더 루트 className, 헤더 className, 헤더 틴트 style 제거, 죽은 import 제거 |
| `frontend/src/heatmap/heat.ts` | 히트 색·정렬 헬퍼 | **수정** — `HEAT_HEADER_MAX_ALPHA` 상수 삭제 |
| `frontend/src/heatmap/HeatmapFolder.test.tsx` | HeatmapFolder 단위 테스트 | **수정** — L1/L3-B DOM 검증 테스트 추가 |
| `DESIGN.md` | 디자인 시스템 | **수정** — 히트맵 폴더 surface 예외 1줄 |
| `frontend/src/heatmap/CandleGlyph.tsx` | 캔들 글리프 | **불변**(L2 미채택) |
| `frontend/src/heatmap/HeatmapRow.tsx` | 칼럼형 행 | **불변** |

---

## Task 0: Setup — 워크트리 의존성 설치 + 기준선 그린

**Files:** 없음(환경 준비)

- [ ] **Step 1: 워크트리 프론트 의존성 설치**

새 워크트리는 `node_modules`가 비어 있다(`vite: not found` 방지).

Run:
```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/heatmap-flat-calm/frontend
npm install
```
Expected: 설치 완료(이미 설치돼 있으면 "up to date").

- [ ] **Step 2: 변경 전 히트맵 테스트가 전부 그린인지 확인(기준선)**

Run:
```bash
npx vitest run src/heatmap/
```
Expected: PASS (HeatmapFolder/HeatmapRow/CandleGlyph/heat 등 전부 통과). 여기서 실패하면 변경 전에 원인부터 해결.

---

## Task 1: HeatmapFolder — 헤더 틴트 제거(L1) + 투명·평면 + 스파인·밝은 헤더(L3-B)

**Files:**
- Modify: `frontend/src/heatmap/HeatmapFolder.tsx` (import 9, 폴더 루트 76, 헤더 div 77-83)
- Test: `frontend/src/heatmap/HeatmapFolder.test.tsx`

- [ ] **Step 1: 실패하는 테스트 추가**

`frontend/src/heatmap/HeatmapFolder.test.tsx` 끝(마지막 `});` 다음 줄)에 아래 테스트를 추가한다. (파일 상단에 `render, screen` 이미 import됨 — 추가 import 불필요.)

```tsx
it('평면 보드(L3-B)+헤더 틴트 없음(L1): 폴더는 카드 대신 좌측 스파인, 헤더는 bg-input·틴트 없음', () => {
  const { container } = render(
    <HeatmapFolder folder={folder} entries={entries} quoteByCode={quotes}
      sortMode="change" onPick={() => {}} />,
  );
  // L3-B: 폴더 루트 — 카드 배경·외곽 테두리 제거, 좌측 중립 스파인
  const root = container.querySelector('#heatmap-folder-f1') as HTMLElement;
  expect(root).toBeInTheDocument();
  expect(root).toHaveClass('border-l-2', 'border-border-strong');
  expect(root).not.toHaveClass('bg-bg-card');
  expect(root).not.toHaveClass('border-border'); // 외곽 박스 테두리 제거
  // 헤더 밴드 = 폴더명 span 의 부모 div
  const header = screen.getByText('반도체').parentElement as HTMLElement;
  // L3-B: 헤더를 폴더 본문보다 한 단계 밝게(그룹 앵커)
  expect(header).toHaveClass('bg-bg-input');
  expect(header).not.toHaveClass('bg-bg-subtle');
  // L1: 헤더 히트 틴트(box-shadow) 없음 — 평균 +5%여도 배경 워시 없음
  expect(header.style.boxShadow).toBe('');
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run:
```bash
npx vitest run src/heatmap/HeatmapFolder.test.tsx
```
Expected: FAIL — 새 테스트가 `border-l-2`/`border-border-strong` 미보유, `bg-bg-card` 보유, `bg-bg-subtle` 보유, `boxShadow`가 비어있지 않음(현재 avg +5% 틴트)으로 깨진다. 기존 2개 테스트는 PASS.

- [ ] **Step 3: HeatmapFolder.tsx 구현 — import 정리**

9번째 줄을 아래로 교체(죽는 `HEAT_HEADER_MAX_ALPHA` 제거; `heatBg`는 평균칩에 계속 사용하므로 유지):

```tsx
import { sortEntries, avgPct, heatBg, HEAT_CHIP_MAX_ALPHA, type SortMode } from './heat';
```

- [ ] **Step 4: HeatmapFolder.tsx 구현 — 폴더 루트 평면화(L3-B)**

76번째 줄 폴더 루트 `<div>`의 className을 교체한다.

변경 전:
```tsx
    <div id={folderId ? `heatmap-folder-${folderId}` : undefined} className="break-inside-avoid bg-bg-card border border-border rounded mb-2 overflow-hidden">
```
변경 후:
```tsx
    <div id={folderId ? `heatmap-folder-${folderId}` : undefined} className="break-inside-avoid border-l-2 border-border-strong mb-2 overflow-hidden">
```
(제거: `bg-bg-card`, `border border-border`, `rounded` / 추가: `border-l-2 border-border-strong` / 유지: `break-inside-avoid`, `mb-2`, `overflow-hidden`.)

- [ ] **Step 5: HeatmapFolder.tsx 구현 — 헤더 밴드(L1 틴트 제거 + L3-B 밝은 헤더)**

77-83번째 줄(헤더 주석 + 헤더 `<div>` 오프닝 태그 + inline style)을 아래로 교체한다.

변경 전:
```tsx
      {/* 그룹 헤더 밴드 = bg-bg-subtle 위에 섹터 평균 등락률 기반 아주 옅은 히트 틴트를
          inset box-shadow 로 레이어(배경색을 약하게 더한다 — 카드 본문 대비 밴드를
          구분하고 섹터 온도를 일별). 결측/0% 면 틴트 없이 bg-bg-subtle 그대로. */}
      <div className="flex justify-between items-center gap-2 bg-bg-subtle px-2 py-1 border-b border-border-strong"
        style={avg !== null && avg !== 0
          ? { boxShadow: `inset 0 0 0 9999px ${heatBg(avg, HEAT_HEADER_MAX_ALPHA)}` }
          : undefined}>
```
변경 후:
```tsx
      {/* 그룹 헤더 밴드 = bg-bg-input(폴더 본문보다 한 단계 밝게 = 그룹 앵커). 폴더는 투명·평면
          (카드 배경/테두리 없음)이고 좌측 border-strong 스파인 + 이 헤더로 그룹을 구분한다.
          섹터 온도는 밴드 전체 틴트 대신 헤더의 평균 등락칩으로만 표현(L1: 헤더 워시 제거). */}
      <div className="flex justify-between items-center gap-2 bg-bg-input px-2 py-1 border-b border-border-strong">
```
(제거: `bg-bg-subtle` → `bg-bg-input`, `style={...}` inline 틴트 전체 삭제.)

> 주의: 평균 등락칩(94-96줄 `style={{ background: heatBg(avg, HEAT_CHIP_MAX_ALPHA) }}`)은 **그대로 둔다** — 섹터 온도 신호. `avg`/`avgPct`도 이 칩에 계속 쓰이므로 유지.

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run:
```bash
npx vitest run src/heatmap/HeatmapFolder.test.tsx
```
Expected: PASS (새 테스트 + 기존 2개 모두).

- [ ] **Step 7: 커밋** (`&&` 금지 — 두 명령 각각 단독 실행)

```bash
git add frontend/src/heatmap/HeatmapFolder.tsx frontend/src/heatmap/HeatmapFolder.test.tsx
```
```bash
git commit -m "feat(heatmap): 폴더 평면화+스파인 헤더(L3-B)·헤더 틴트 제거(L1)"
```

---

## Task 2: heat.ts — 죽은 상수 `HEAT_HEADER_MAX_ALPHA` 삭제

**Files:**
- Modify: `frontend/src/heatmap/heat.ts:7`

> Task 1에서 유일 소비자(HeatmapFolder의 import·사용)를 제거했으므로 이 상수는 죽은 export다. (확인됨: `grep -rn HEAT_HEADER_MAX_ALPHA src/` 결과 정의·HeatmapFolder뿐, 테스트 미참조.)

- [ ] **Step 1: 잔존 소비자 재확인**

Run:
```bash
grep -rn "HEAT_HEADER_MAX_ALPHA" src/
```
Expected: `heat.ts:7`(정의)만 남음. (HeatmapFolder 참조는 Task 1에서 제거됨.) 다른 매치가 있으면 멈추고 그 소비자부터 처리.

- [ ] **Step 2: 상수 삭제**

`frontend/src/heatmap/heat.ts`에서 7번째 줄을 삭제한다.

삭제할 줄:
```ts
export const HEAT_HEADER_MAX_ALPHA = 0.2; // 그룹 헤더 밴드용 — 섹터 온도를 아주 옅게(배경 워시)
```
(`HEAT_SAT`·`HEAT_MAX_ALPHA`·`HEAT_CHIP_MAX_ALPHA`·`heatBg`·`sortEntries`·`avgPct`는 모두 유지.)

- [ ] **Step 3: 타입체크 + 히트맵 테스트로 회귀 없음 확인**

Run:
```bash
npx tsc -p tsconfig.app.json --noEmit
```
Expected: 에러 없음(0 출력). 이어서:
```bash
npx vitest run src/heatmap/
```
Expected: 전부 PASS.

- [ ] **Step 4: 커밋** (`&&` 금지)

```bash
git add frontend/src/heatmap/heat.ts
```
```bash
git commit -m "refactor(heatmap): 미사용 HEAT_HEADER_MAX_ALPHA 제거(헤더 틴트 폐지 후속)"
```

---

## Task 3: DESIGN.md — 히트맵 폴더 surface 예외 1줄 명시

**Files:**
- Modify: `DESIGN.md` (§Color, "Price-direction candle glyph" 불릿 다음)

> CLAUDE.md: 프론트 시각 변경은 DESIGN.md와 일치해야 한다. `--bg-card` 카드 규율을 히트맵 폴더에서 의도적으로 이탈하므로 예외를 문서에 박는다.

- [ ] **Step 1: 캔들 글리프 불릿 다음에 새 불릿 추가**

`DESIGN.md`에서 아래 줄(캔들 글리프 불릿의 마지막 줄)을 찾는다:
```
  방향 카테고리 준수(새 색 없음) — `heat.ts` 배경 확장의 캔들 버전.
```
그 줄 **바로 다음에** 빈 줄 + 아래 불릿을 삽입한다:
```
- **Heatmap 폴더 surface 예외 (관심맵 보드 전용):** 신문형 멀티칼럼 고밀도 보드라 폴더 블록은
  `--bg-card` 카드(채움+테두리+라운드) 대신 **투명·평면**으로 둔다 — 그룹 경계는 `--bg-input`
  헤더 밴드(폴더 본문보다 한 단계 밝게) + `--border-strong` 좌측 스파인(`border-l-2`) + 여백으로
  잡는다. 헤더 밴드 히트 틴트(평균 등락 배경 워시)는 쓰지 않는다 — 섹터 온도는 헤더의 평균
  등락칩으로만. 이 예외는 **히트맵 폴더 한정**이며 드로어·차트·툴바 등 다른 카드는 `--bg-card` 유지.
```

- [ ] **Step 2: 삽입 위치 확인**

Run:
```bash
grep -n "Heatmap 폴더 surface 예외\|배경 확장의 캔들 버전" DESIGN.md
```
Expected: 두 매치가 인접 줄 번호(캔들 버전 줄 바로 아래에 새 불릿)로 나온다.

- [ ] **Step 3: 커밋** (`&&` 금지)

```bash
git add DESIGN.md
```
```bash
git commit -m "docs(design): 히트맵 폴더 surface 예외(투명·평면+스파인·bg-input 헤더) 명시"
```

---

## Task 4: 최종 검증 — 타입체크 · 빌드 · 전체 히트맵 테스트 · 육안

**Files:** 없음(검증)

- [ ] **Step 1: 권위 타입체크**

Run:
```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/heatmap-flat-calm/frontend
npx tsc -p tsconfig.app.json --noEmit
```
Expected: 에러 0.

- [ ] **Step 2: 프로덕션 빌드**

Run:
```bash
npm run build
```
Expected: `tsc -b` + `vite build` 성공(에러 없이 dist 생성).

- [ ] **Step 3: 히트맵 단위 테스트 전체**

Run:
```bash
npx vitest run src/heatmap/
```
Expected: 전부 PASS. (불변 컴포넌트 `CandleGlyph`/`HeatmapRow` 테스트가 그대로 통과 = 회귀 가드.)

- [ ] **Step 4: (선택) 헤드리스 육안 확인**

워크트리 dev 서버를 띄워 `/heatmap`을 스크린샷한다. 단 백엔드 CORS는 `:5173`만 허용하므로(메모리: hoga-ops-worktree-browser-verify-cors) 실데이터가 필요하면 워크트리 vite를 `:5173` 백엔드로 프록시하거나, 메인 체크아웃에 머지 후 `:5173`에서 확인한다. 색·밀도는 이미 디자인 컴패니언 목업으로 사전 검증됨 — 이 스텝은 실데이터 최종 확인용(필수 아님).

확인 포인트: ① 폴더 헤더에 빨강/파랑 워시 없음(L1) ② 폴더가 카드 박스 대신 좌측 스파인 + 밝은 헤더(L3-B) ③ 빽빽한 멀티칼럼에서 그룹 경계가 또렷 ④ 캔들 적/청 색은 그대로(L2 미채택).

---

## Self-Review

**1. Spec coverage (스펙 §결정 L1+L3-B 대조):**
- L1 헤더 틴트 제거 → Task 1 Step 5(style 삭제) + Task 2(상수 정리). ✅
- L3-B 폴더 투명·평면 → Task 1 Step 4(`bg-bg-card`·`border` 제거). ✅
- L3-B 좌측 스파인 → Task 1 Step 4(`border-l-2 border-border-strong`). ✅
- L3-B 밝은 헤더 → Task 1 Step 5(`bg-bg-subtle`→`bg-bg-input`). ✅
- 평균 등락칩 유지 → Task 1 Step 5 주의 박스. ✅
- L2 미채택(캔들 불변) → File Structure 표 + Task 4 Step 3 회귀 가드. ✅
- DESIGN.md 예외 → Task 3. ✅
- `HeatmapRow`/`heatBg`/스트립 불변 → 어느 Task도 건드리지 않음. ✅

**2. Placeholder scan:** "TBD"/"적절히"/"등 처리" 없음. 모든 코드·명령·기대출력 명시. ✅

**3. Type/이름 일관성:** Tailwind 클래스 `bg-bg-input`·`border-border-strong`·`border-l-2`는 `tailwind.config.ts`(`'bg-input'`,`'border-strong'`) 매핑·표준 유틸과 일치. 테스트 쿼리 `#heatmap-folder-f1`는 컴포넌트의 `id={heatmap-folder-${folderId}}`(folderId='f1')와 일치. 삭제 상수 `HEAT_HEADER_MAX_ALPHA` 철자 일관. ✅

**4. Scope:** 단일 표현 변경 — 분해 불필요. ✅
