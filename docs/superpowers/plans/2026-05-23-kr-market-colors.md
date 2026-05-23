# KRX 색상 컨벤션 + 마지막값 라인 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DESIGN.md 색상 시스템을 한국 시장 컨벤션(상승=빨강, 하락=파랑)으로 전환하고, 시장 데이터 토큰과 UI 상태 토큰을 의미적으로 분리하며, 모든 차트 시리즈의 마지막값 라인/우측 축 칩을 제거한다.

**Architecture:** 토큰을 먼저 **추가 only** 모드로 신설(`--success`/`--error`/`--price-up`/`--price-down`)하여 기존 `--up`/`--down`/`--ratio-ask`와 공존시킨 뒤, 사용처를 의미별(시장 데이터 vs UI 상태)로 분류해 한 파일씩 이전한다. 마지막에 deprecated 토큰을 일괄 삭제하고 grep 검증으로 잔재를 0으로 보장한다.

**Tech Stack:** Vite + TypeScript + React 18, lightweight-charts v5, Tailwind v3 (JIT), CSS custom properties, vitest.

**Spec:** `docs/superpowers/specs/2026-05-23-kr-market-colors-design.md`

**중요 명령어** (frontend 디렉토리에서 실행):
- 타입체크: `npx tsc -b --noEmit`
- 테스트: `npx vitest run`
- 린트: `npm run lint`
- 시각 검증: `npm run dev` 후 `http://localhost:5173/replay`

---

## File Structure

**신규 토큰 정의**
- 수정: `frontend/src/styles/tokens.css` — CSS 변수 추가/삭제
- 수정: `frontend/tailwind.config.ts` — Tailwind colors 매핑 추가/삭제

**차트 페인** (5개 — 모두 시장 데이터 토큰 사용)
- 수정: `frontend/src/chart/CandlePane.tsx`
- 수정: `frontend/src/chart/VolumePane.tsx`
- 수정: `frontend/src/chart/QuoteTotalsPane.tsx`
- 수정: `frontend/src/chart/FillStrengthPane.tsx`
- 수정: `frontend/src/chart/RatioPane.tsx`

**UI 상태 호출처** (CSS 변수 직접 참조)
- 수정: `frontend/src/capture/CalendarCell.tsx`
- 수정: `frontend/src/capture/SymbolSearch.tsx`
- 수정: `frontend/src/capture/CaptureForm.tsx` (`var(--down)` 한 줄)
- 수정: `frontend/src/capture/CaptureQueue.tsx`
- 수정: `frontend/src/nav/StatusDot.tsx`

**UI 호출처** (Tailwind 클래스 — 시장 데이터)
- 수정: `frontend/src/replay/PriceStrip.tsx`
- 수정: `frontend/src/sidebar/OrderbookTable.tsx`
- 수정: `frontend/src/sidebar/BrokerNetTable.tsx`
- 수정: `frontend/src/sidebar/FillTape.tsx`

**UI 호출처** (Tailwind 클래스 — 상태)
- 수정: `frontend/src/replay/Tab.tsx`
- 수정: `frontend/src/replay/OnboardingCard.tsx`
- 수정: `frontend/src/replay/Workarea.tsx`
- 수정: `frontend/src/replay/Toolbar.tsx`
- 수정: `frontend/src/capture/CaptureForm.tsx` (`text-down` 한 줄)
- 수정: `frontend/src/capture/CaptureRowDetail.tsx`
- 수정: `frontend/src/pages/Settings.tsx`

**문서**
- 수정: `DESIGN.md` (저장소 루트)
- 수정: `docs/superpowers/designs/2026-05-20-replay-viewer.html`

---

## Task 1: 베이스라인 확인

기존 코드가 클린 상태인지 먼저 검증해서, 이후 작업의 회귀를 추적 가능하게 한다.

**Files:** 없음 (read-only)

- [ ] **Step 1-1: 타입체크 베이스라인**

```bash
cd frontend && npx tsc -b --noEmit
```

Expected: 0 errors. 만약 에러가 있으면 본 plan 시작 전에 fix 해야 함.

- [ ] **Step 1-2: 테스트 베이스라인**

```bash
cd frontend && npx vitest run
```

Expected: 전 테스트 통과. 만약 실패가 있으면 본 plan 시작 전 fix.

- [ ] **Step 1-3: 사용처 grep 인벤토리 출력**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -rn "var(--up)\|var(--down)\|--ratio-ask" frontend/src/ | wc -l
grep -rn "text-up\b\|text-down\b\|bg-up\b\|bg-down\b\|bg-tint-up\|bg-tint-down" frontend/src/ | wc -l
```

Expected: 첫 번째 grep 결과 = 약 10 hits, 두 번째 = 약 13 hits. (정확한 숫자는 스펙의 callsite 표 참조). 이 숫자는 Task 12 후 0이 되어야 함.

---

## Task 2: 새 색상 토큰 추가 (additive only)

기존 토큰을 건드리지 않고 새 토큰만 추가한다. 이 시점에선 앱 동작 변화 없음 — 새 토큰은 아무도 참조하지 않음.

**Files:**
- Modify: `frontend/src/styles/tokens.css`
- Modify: `frontend/tailwind.config.ts`

- [ ] **Step 2-1: tokens.css에 새 색상 토큰 추가**

`frontend/src/styles/tokens.css` 의 색상 섹션을 다음과 같이 편집. 기존 `--up`, `--down`, `--ratio-ask`는 일단 **유지**.

```diff
   --accent: #14B8A6;
   --accent-fg: #0A0A12;
   --accent-shade: #0D7A6F;
   --up: #22C55E;
   --down: #F43F5E;
+  /* New: status semantic (hex unchanged, names disambiguate from price-direction). */
+  --success: #22C55E;
+  --error:   #F43F5E;
+  /* New: KRX market convention — buy/up = red, sell/down = blue. */
+  --price-up:   #DC2626;
+  --price-down: #2563EB;
   --warn: #F59E0B;
```

같은 파일의 tint 섹션:

```diff
   --tint-selection: rgba(20, 184, 166, 0.12);
   --tint-up: rgba(34, 197, 94, 0.10);
   --tint-down: rgba(244, 63, 94, 0.10);
+  --tint-success:    rgba(34, 197, 94, 0.10);
+  --tint-error:      rgba(244, 63, 94, 0.10);
+  --tint-price-up:   rgba(220, 38, 38, 0.10);  /* DC2626 @ 10% */
+  --tint-price-down: rgba(37, 99, 235, 0.10);  /* 2563EB @ 10% */
```

`--ratio-ask` 줄은 **이번 task에서는 유지** (Task 7 RatioPane 이전 후에 Task 12에서 삭제).

- [ ] **Step 2-2: tailwind.config.ts에 새 클래스 매핑 추가**

`frontend/tailwind.config.ts` 의 `colors` 블록을 편집. 기존 `up`/`down`/`tint-up`/`tint-down`은 유지.

```diff
         accent: 'var(--accent)',
         'accent-fg': 'var(--accent-fg)',
         'accent-shade': 'var(--accent-shade)',
         up: 'var(--up)',
         down: 'var(--down)',
+        success: 'var(--success)',
+        error:   'var(--error)',
+        'price-up':   'var(--price-up)',
+        'price-down': 'var(--price-down)',
         grid: 'var(--grid)',
         'heat-lo': 'var(--heat-lo)',
         'heat-hi': 'var(--heat-hi)',
         'tint-selection': 'var(--tint-selection)',
         'tint-up': 'var(--tint-up)',
         'tint-down': 'var(--tint-down)',
+        'tint-success':    'var(--tint-success)',
+        'tint-error':      'var(--tint-error)',
+        'tint-price-up':   'var(--tint-price-up)',
+        'tint-price-down': 'var(--tint-price-down)',
       },
```

- [ ] **Step 2-3: 타입체크 + 테스트 + 린트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run && npm run lint
```

Expected: 0 errors, 모든 테스트 통과. 동작 변화 없음.

- [ ] **Step 2-4: 신규 토큰 존재 grep 확인**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -c "^  --success:\|^  --error:\|^  --price-up:\|^  --price-down:\|^  --tint-success:\|^  --tint-error:\|^  --tint-price-up:\|^  --tint-price-down:" frontend/src/styles/tokens.css
```

Expected: `8`.

- [ ] **Step 2-5: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/tailwind.config.ts
git commit -m "feat(tokens): add KRX price-direction + status-semantic color tokens

Additive only — existing --up/--down/--ratio-ask remain. Callsites
migrate file-by-file in subsequent commits; deprecated tokens removed
last.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: CandlePane — 시장 데이터 토큰 + 마지막값 라인 제거

**Files:**
- Modify: `frontend/src/chart/CandlePane.tsx`
- Test: `frontend/src/chart/CandlePane.test.tsx` (수정 없음 — 기존 테스트가 회귀 가드)

- [ ] **Step 3-1: TOKEN_SPEC 교체 + series 옵션 추가**

`frontend/src/chart/CandlePane.tsx` 의 TOKEN_SPEC (8-11줄)을 편집:

```diff
 const TOKEN_SPEC = {
-  up: ['--up', '#22C55E'],
-  down: ['--down', '#F43F5E'],
+  up: ['--price-up',   '#DC2626'],
+  down: ['--price-down', '#2563EB'],
   muted: ['--fg-dim', '#94A3B8'],
 } as const;
```

같은 파일 `chart.addSeries(CandlestickSeries, {...}, paneIndex)` 호출(36-56줄)의 옵션 객체에 두 줄 추가:

```diff
     const series = chart.addSeries(
       CandlestickSeries,
       {
         upColor: up,
         downColor: down,
         wickUpColor: up,
         wickDownColor: down,
         borderVisible: false,
+        // 우측 축 마지막값 라인/칩 제거 — crosshair로만 값 확인.
+        priceLineVisible: false,
+        lastValueVisible: false,
         priceFormat: {
           type: 'custom',
           formatter: (p: number) => Math.round(p).toLocaleString('ko-KR'),
           minMove: 1,
         },
       },
       paneIndex,
     );
```

- [ ] **Step 3-2: 타입체크 + 테스트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run src/chart/CandlePane.test.tsx
```

Expected: 0 errors, CandlePane 테스트 통과 (테스트는 색이 *다른지*만 검사하므로 hex 변경에 영향 없음).

- [ ] **Step 3-3: Commit**

```bash
git add frontend/src/chart/CandlePane.tsx
git commit -m "feat(chart/CandlePane): migrate to --price-up/--price-down + hide last-value chip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: VolumePane

**Files:**
- Modify: `frontend/src/chart/VolumePane.tsx`

- [ ] **Step 4-1: TOKEN_SPEC + lastValueVisible 추가**

```diff
 const TOKEN_SPEC = {
-  up: ['--up', '#22C55E'],
-  down: ['--down', '#F43F5E'],
+  up: ['--price-up',   '#DC2626'],
+  down: ['--price-down', '#2563EB'],
 } as const;
```

같은 파일에서 `chart.addSeries(HistogramSeries, {...}, paneIndex)`의 옵션 객체(33-48줄)를 편집:

```diff
         priceFormat: {
           type: 'custom',
           formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
           minMove: 1,
         },
         priceScaleId: 'right',
-        // Suppress the library-default horizontal line at the latest bar.
-        // The right-axis chip still shows the latest total volume.
         priceLineVisible: false,
+        // 우측 축 마지막값 라인/칩 모두 제거 — crosshair로만 값 확인.
+        lastValueVisible: false,
```

- [ ] **Step 4-2: 타입체크 + 테스트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run src/chart/
```

Expected: 0 errors, 모든 차트 테스트 통과.

- [ ] **Step 4-3: Commit**

```bash
git add frontend/src/chart/VolumePane.tsx
git commit -m "feat(chart/VolumePane): KRX colors + hide last-value chip

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: QuoteTotalsPane — bid/ask 의미 명확화

`up`/`down` 변수명은 가격 방향을 떠올리게 해 오해의 소지가 있음 — 이 페인은 시장 사이드(매수/매도) 표현이므로 `bid`/`ask`로 리네임.

**Files:**
- Modify: `frontend/src/chart/QuoteTotalsPane.tsx`

- [ ] **Step 5-1: TOKEN_SPEC을 bid/ask로 리네임 + KRX 색상**

```diff
 const TOKEN_SPEC = {
-  up: ['--up', '#22C55E'],
-  down: ['--down', '#F43F5E'],
+  bid: ['--price-up',   '#DC2626'],  // 매수 호가 총합 (KRX 빨강)
+  ask: ['--price-down', '#2563EB'],  // 매도 호가 총합 (KRX 파랑)
 } as const;
```

- [ ] **Step 5-2: addSeries 호출 시 새 변수명 + lastValueVisible/priceLineVisible**

```diff
   useEffect(() => {
-    const { up, down } = resolveTokens(TOKEN_SPEC);
+    const { bid, ask } = resolveTokens(TOKEN_SPEC);
     const priceFormat = {
       type: 'custom' as const,
       formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
       minMove: 1,
     };
     const bidSeries = chart.addSeries(
       LineSeries,
-      { color: up, lineWidth: 1, priceFormat } as any,
+      { color: bid, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false } as any,
       paneIndex,
     );
     const askSeries = chart.addSeries(
       LineSeries,
-      { color: down, lineWidth: 1, priceFormat } as any,
+      { color: ask, lineWidth: 1, priceFormat, priceLineVisible: false, lastValueVisible: false } as any,
       paneIndex,
     );
```

- [ ] **Step 5-3: 타입체크 + 테스트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run src/chart/
```

Expected: 0 errors, 통과.

- [ ] **Step 5-4: Commit**

```bash
git add frontend/src/chart/QuoteTotalsPane.tsx
git commit -m "feat(chart/QuoteTotalsPane): rename up/down→bid/ask + KRX colors + hide last-value

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: FillStrengthPane — buy/sell 의미 명확화

**Files:**
- Modify: `frontend/src/chart/FillStrengthPane.tsx`

- [ ] **Step 6-1: TOKEN_SPEC을 buy/sell로 리네임 + KRX 색상**

```diff
 const TOKEN_SPEC = {
-  up: ['--up', '#22C55E'],
-  down: ['--down', '#F43F5E'],
+  buy:  ['--price-up',   '#DC2626'],  // 체결 매수 (KRX 빨강)
+  sell: ['--price-down', '#2563EB'],  // 체결 매도 (KRX 파랑)
 } as const;
```

- [ ] **Step 6-2: addSeries 호출 시 새 변수명 + 옵션 추가**

```diff
   useEffect(() => {
-    const { up, down } = resolveTokens(TOKEN_SPEC);
+    const { buy: buyColor, sell: sellColor } = resolveTokens(TOKEN_SPEC);
     const histOpts = {
       base: 0,
       priceFormat: {
         type: 'custom' as const,
         formatter: (v: number) => Math.round(Math.abs(v)).toLocaleString('ko-KR'),
         minMove: 1,
       },
+      priceLineVisible: false,
+      lastValueVisible: false,
     };
-    const buy = chart.addSeries(HistogramSeries, { color: up, ...histOpts } as any, paneIndex);
-    const sell = chart.addSeries(HistogramSeries, { color: down, ...histOpts } as any, paneIndex);
+    const buy = chart.addSeries(HistogramSeries, { color: buyColor, ...histOpts } as any, paneIndex);
+    const sell = chart.addSeries(HistogramSeries, { color: sellColor, ...histOpts } as any, paneIndex);
```

⚠️ `buy`/`sell`은 시리즈 핸들 변수명으로 이미 사용 중이라 색상 변수는 `buyColor`/`sellColor`로 받아야 충돌 없음.

- [ ] **Step 6-3: 타입체크 + 테스트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run src/chart/
```

Expected: 0 errors, 통과.

- [ ] **Step 6-4: Commit**

```bash
git add frontend/src/chart/FillStrengthPane.tsx
git commit -m "feat(chart/FillStrengthPane): rename up/down→buy/sell + KRX colors + hide last-value

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: RatioPane — `--ratio-ask` 제거, `--price-*` 직접 차용

**Files:**
- Modify: `frontend/src/chart/RatioPane.tsx`

- [ ] **Step 7-1: TOKEN_SPEC 재정의 + 인라인 주석 갱신**

```diff
 const TOKEN_SPEC = {
-  ratioAsk: ['--ratio-ask', '#3B82F6'],
-  // Reused: same hex as price-direction --down, but here it encodes
-  // bid-heavy order-book pressure (below 0). Inline comment marks the
-  // semantic distinction so future maintainers don't refactor it away.
-  ratioBid: ['--down', '#F43F5E'],
+  // KRX 컨벤션: 매수=상승=빨강, 매도=하락=파랑. RatioPane은 price-direction
+  // 토큰을 직접 차용해 의미 충돌 없음 (도서 압력 부호와 가격 방향이 정렬됨).
+  ratioBid: ['--price-up',   '#DC2626'],
+  ratioAsk: ['--price-down', '#2563EB'],
   baseline: ['--fg-dimmer', '#64748B'],
 } as const;
```

- [ ] **Step 7-2: BaselineSeries 옵션에 `lastValueVisible: false` 추가**

같은 파일 `chart.addSeries(BaselineSeries, {...})` 호출(52-88줄). `priceLineVisible: false`는 이미 있으니 그 옆에 추가:

```diff
         // Suppress the library-default horizontal line at the latest value.
-        // The right-axis chip still shows the latest value via lastValueVisible.
         priceLineVisible: false,
+        lastValueVisible: false,
         priceFormat: {
```

⚠️ `series.createPriceLine({ price: 0, ... })`(110-117줄)는 **그대로 유지** — 0-baseline reference line은 마지막값 라인이 아니라 별도 참조선.

- [ ] **Step 7-3: 타입체크 + 테스트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run src/chart/
```

Expected: 0 errors, 통과.

- [ ] **Step 7-4: Commit**

```bash
git add frontend/src/chart/RatioPane.tsx
git commit -m "feat(chart/RatioPane): adopt --price-up/--price-down + hide last-value chip

ratioBid takes --price-up (red=상승=매수), ratioAsk takes --price-down
(blue=하락=매도). KRX semantics align order-book pressure sign with
price direction, so the cross-token-reuse comment becomes unnecessary.
The 0-baseline createPriceLine is retained.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 상태 의미 CSS 변수 callsite 이전

`var(--up)` → `var(--success)`, `var(--down)` → `var(--error)`. 모두 UI 상태(완료/에러) 의미.

**Files:**
- Modify: `frontend/src/capture/CalendarCell.tsx`
- Modify: `frontend/src/capture/SymbolSearch.tsx`
- Modify: `frontend/src/capture/CaptureForm.tsx` (113줄 `var(--down)`만)
- Modify: `frontend/src/capture/CaptureQueue.tsx`
- Modify: `frontend/src/nav/StatusDot.tsx`

- [ ] **Step 8-1: CalendarCell.tsx**

10번째 줄 근처:

```diff
-  complete: 'var(--up)',
+  complete: 'var(--success)',
   ...
-  client_incomplete: 'var(--down)',
+  client_incomplete: 'var(--error)',
```

- [ ] **Step 8-2: SymbolSearch.tsx**

30번째 줄 근처:

```diff
-  fresh: 'var(--up)',
+  fresh: 'var(--success)',
   ...
-  unavailable: 'var(--down)',
+  unavailable: 'var(--error)',
```

- [ ] **Step 8-3: CaptureForm.tsx (113줄)**

```diff
             color: 'var(--down)',
+            color: 'var(--error)',
```

⚠️ 같은 파일 101줄 `text-down`은 Task 10에서 처리.

- [ ] **Step 8-4: CaptureQueue.tsx (111줄)**

```diff
-            ? ghostButton('var(--down)', 'var(--down)')
+            ? ghostButton('var(--error)', 'var(--error)')
```

- [ ] **Step 8-5: StatusDot.tsx (20줄)**

```diff
-    status === 'green' ? 'var(--up)' : status === 'yellow' ? 'var(--accent)' : 'var(--down)';
+    status === 'green' ? 'var(--success)' : status === 'yellow' ? 'var(--accent)' : 'var(--error)';
```

- [ ] **Step 8-6: 타입체크 + 테스트 + 린트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run && npm run lint
```

Expected: 0 errors, 통과.

- [ ] **Step 8-7: 잔존 `var(--up)`/`var(--down)` grep**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -rn "var(--up)\|var(--down)" frontend/src/
```

Expected: 0 hits (모든 CSS 변수 callsite 이전됨).

- [ ] **Step 8-8: Commit**

```bash
git add frontend/src/capture/CalendarCell.tsx frontend/src/capture/SymbolSearch.tsx frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureQueue.tsx frontend/src/nav/StatusDot.tsx
git commit -m "refactor: var(--up)/(--down) → var(--success)/(--error) for status callsites

Capture state, calendar cell, symbol master status, status dot — all
encode UI state (success/error) rather than market direction. Renames
disambiguate from price-direction tokens introduced for KRX convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 시장 데이터 Tailwind 클래스 callsite 이전

`text-up`/`text-down`/`bg-tint-up`/`bg-tint-down` 중 **시장 데이터** 의미만 `text-price-*` / `bg-tint-price-*` 로 변경.

**Files:**
- Modify: `frontend/src/replay/PriceStrip.tsx`
- Modify: `frontend/src/sidebar/OrderbookTable.tsx`
- Modify: `frontend/src/sidebar/BrokerNetTable.tsx`
- Modify: `frontend/src/sidebar/FillTape.tsx`

- [ ] **Step 9-1: PriceStrip.tsx (72줄)**

```diff
-            delta > 0 ? 'text-up' : delta < 0 ? 'text-down' : 'text-fg-dim'
+            delta > 0 ? 'text-price-up' : delta < 0 ? 'text-price-down' : 'text-fg-dim'
```

- [ ] **Step 9-2: OrderbookTable.tsx (67-68줄)**

```diff
-  const barClass = side === 'ask' ? 'bg-tint-down' : 'bg-tint-up';
-  const priceColor = side === 'ask' ? 'text-down' : 'text-up';
+  const barClass   = side === 'ask' ? 'bg-tint-price-down' : 'bg-tint-price-up';
+  const priceColor = side === 'ask' ? 'text-price-down'    : 'text-price-up';
```

- [ ] **Step 9-3: BrokerNetTable.tsx (25줄)**

```diff
-          <span className={r.net > 0 ? 'text-up' : r.net < 0 ? 'text-down' : 'text-fg-dim'}>
+          <span className={r.net > 0 ? 'text-price-up' : r.net < 0 ? 'text-price-down' : 'text-fg-dim'}>
```

- [ ] **Step 9-4: FillTape.tsx (35줄)**

```diff
-  const iconCls = trade.side > 0 ? 'text-up' : trade.side < 0 ? 'text-down' : 'text-fg-dim';
+  const iconCls = trade.side > 0 ? 'text-price-up' : trade.side < 0 ? 'text-price-down' : 'text-fg-dim';
```

- [ ] **Step 9-5: 타입체크 + 테스트 + 린트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run && npm run lint
```

Expected: 0 errors, 통과.

- [ ] **Step 9-6: Commit**

```bash
git add frontend/src/replay/PriceStrip.tsx frontend/src/sidebar/OrderbookTable.tsx frontend/src/sidebar/BrokerNetTable.tsx frontend/src/sidebar/FillTape.tsx
git commit -m "refactor: market-data Tailwind classes → text-price-*/bg-tint-price-*

PriceStrip delta, orderbook bid/ask, broker net position, fill tape
side — all encode price direction. Switches to KRX-convention tokens
(red=up/buy, blue=down/sell).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 상태 의미 Tailwind 클래스 callsite 이전

`text-up`/`text-down`/`bg-up` 중 **상태** 의미를 `text-success`/`text-error`/`bg-success` 로 변경.

**Files:**
- Modify: `frontend/src/replay/Tab.tsx`
- Modify: `frontend/src/replay/OnboardingCard.tsx`
- Modify: `frontend/src/replay/Workarea.tsx`
- Modify: `frontend/src/replay/Toolbar.tsx`
- Modify: `frontend/src/capture/CaptureForm.tsx` (101줄)
- Modify: `frontend/src/capture/CaptureRowDetail.tsx`
- Modify: `frontend/src/pages/Settings.tsx`

- [ ] **Step 10-1: Tab.tsx (45줄)**

```diff
-      ? 'bg-up'
+      ? 'bg-success'
```

- [ ] **Step 10-2: OnboardingCard.tsx (29줄)**

```diff
-    <div className={`flex gap-3 items-center ${done ? 'text-up' : active ? 'text-fg' : 'text-fg-dim'}`}>
+    <div className={`flex gap-3 items-center ${done ? 'text-success' : active ? 'text-fg' : 'text-fg-dim'}`}>
```

- [ ] **Step 10-3: Workarea.tsx (55줄)**

```diff
-      <div className="grid place-items-center h-full text-down">
+      <div className="grid place-items-center h-full text-error">
```

- [ ] **Step 10-4: Toolbar.tsx (87줄)**

```diff
-      {rangeError && <span className="text-down text-sm ml-2">{rangeError}</span>}
+      {rangeError && <span className="text-error text-sm ml-2">{rangeError}</span>}
```

- [ ] **Step 10-5: CaptureForm.tsx (101줄)**

```diff
-        <div role="alert" className="text-xs text-down">{error}</div>
+        <div role="alert" className="text-xs text-error">{error}</div>
```

- [ ] **Step 10-6: CaptureRowDetail.tsx (49-50줄)**

```diff
-          <span className="text-down">error</span>
-          <span className="text-down">
+          <span className="text-error">error</span>
+          <span className="text-error">
```

- [ ] **Step 10-7: Settings.tsx (72줄)**

```diff
-        <div className="text-xs text-down">{symbolMasterSettingsHints[data.reason]}</div>
+        <div className="text-xs text-error">{symbolMasterSettingsHints[data.reason]}</div>
```

- [ ] **Step 10-8: 타입체크 + 테스트 + 린트**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run && npm run lint
```

Expected: 0 errors, 통과.

- [ ] **Step 10-9: 잔존 Tailwind 클래스 grep**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -rn "text-up\b\|text-down\b\|bg-up\b\|bg-down\b\|bg-tint-up\b\|bg-tint-down\b" frontend/src/
```

Expected: 0 hits.

- [ ] **Step 10-10: Commit**

```bash
git add frontend/src/replay/Tab.tsx frontend/src/replay/OnboardingCard.tsx frontend/src/replay/Workarea.tsx frontend/src/replay/Toolbar.tsx frontend/src/capture/CaptureForm.tsx frontend/src/capture/CaptureRowDetail.tsx frontend/src/pages/Settings.tsx
git commit -m "refactor: status Tailwind classes text-up/text-down → text-success/text-error

Tab loaded dot, onboarding checklist, replay/capture error labels,
settings hints — all encode UI state. Renames disambiguate from
price-direction tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Mockup HTML 색상 line-by-line 치환

`docs/superpowers/designs/2026-05-20-replay-viewer.html`의 hex 리터럴을 의미별로 분류해 시장 데이터만 KRX 색상으로 치환. `.tab-status.loaded`의 `#22C55E`와 `rgba(34,197,94,0.5)` 은 상태 의미라 **유지**.

**Files:**
- Modify: `docs/superpowers/designs/2026-05-20-replay-viewer.html`

- [ ] **Step 11-1: 변경 대상 라인 인벤토리**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -n "#22C55E\|#F43F5E\|rgba(34,197,94\|rgba(244,63,94" docs/superpowers/designs/2026-05-20-replay-viewer.html
```

Expected: 약 20+ 라인. 각 줄을 보고 "상태 dot인가 시장 데이터인가" 분류 후 다음 step 적용.

- [ ] **Step 11-2: 상태 의미 라인 식별 (변경 금지)**

다음 라인은 **건드리지 말 것** (상태 dot):
- `.tab-status.loaded { background: #22C55E; box-shadow: 0 0 4px rgba(34,197,94,0.5); }` (148줄 부근)
- 만약 grep으로 추가 상태 의미 행이 발견되면 (예: nav status indicator) 동일하게 보존.

- [ ] **Step 11-3: 시장 데이터 hex 치환**

각 라인을 Edit으로 line-by-line 치환 (sed 일괄 치환 **금지**). 매핑:

| 컨텍스트 패턴 | 현재 | 새 hex |
|---|---|---|
| `bg`, `color`, `fill`, gradient stop, `.ps-delta.pos`, `.ob .px-bid`, `.brokers .net-pos`, `.tape .px-buy`, `.tape .icon-buy`, hot price strip H color, candle `cd.c >= cd.o ? '#22C55E'`, depth bar bid fill | `#22C55E` | `#DC2626` |
| `.ps-delta.neg`, `.ob .px-ask`, `.brokers .net-neg`, `.tape .px-sell`, `.tape .icon-sell`, hot price strip L color, candle else branch `'#F43F5E'`, depth bar ask fill | `#F43F5E` | `#2563EB` |
| `rgba(34,197,94,0.10)` (`.ps-delta.pos` background) | rgba green tint | `rgba(220,38,38,0.10)` |
| `rgba(244,63,94,0.10)` (`.ps-delta.neg` background) | rgba red tint | `rgba(37,99,235,0.10)` |
| `rgba(34,197,94,0.85)` (depth bar buy `fill-opacity` rgba 형태로 표현될 경우) | rgba green | `rgba(220,38,38,0.85)` |
| `rgba(244,63,94,0.85)` (depth bar sell) | rgba red | `rgba(37,99,235,0.85)` |

JS 변수 식별자도 함께 갱신해 코드 가독성 유지:
- `let color = cd.c >= cd.o ? '#22C55E' : '#F43F5E';` → `let color = cd.c >= cd.o ? '#DC2626' : '#2563EB';`
- `const askColor = hex2rgb('#F43F5E');` → `const askColor = hex2rgb('#2563EB');`
- `const bidColor = hex2rgb('#22C55E');` → `const bidColor = hex2rgb('#DC2626');`

주변 주석 (`// ask cells use rose`, `// bid cells use green`)이 있으면 문맥 맞게 갱신 (`// ask cells use blue (KRX)`, `// bid cells use red (KRX)`).

- [ ] **Step 11-4: 검증 grep**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -n "#22C55E\|rgba(34,197,94" docs/superpowers/designs/2026-05-20-replay-viewer.html
```

Expected: 단 두 줄만 남음 — `.tab-status.loaded`의 `background: #22C55E` 그리고 같은 줄의 `box-shadow: 0 0 4px rgba(34,197,94,0.5)`.

```bash
grep -n "#F43F5E\|rgba(244,63,94" docs/superpowers/designs/2026-05-20-replay-viewer.html
```

Expected: 0 hits.

- [ ] **Step 11-5: 브라우저 시각 확인**

`file:///<repo>/docs/superpowers/designs/2026-05-20-replay-viewer.html` 열어서:
- 캔들 양봉 빨강, 음봉 파랑
- 호가창 매수 빨강, 매도 파랑
- 가격 strip delta, broker net pos/neg, fill tape 매수/매도 색상 일치
- 탭 상태 dot (loaded) 녹색 유지

- [ ] **Step 11-6: Commit**

```bash
git add docs/superpowers/designs/2026-05-20-replay-viewer.html
git commit -m "docs(design): mockup HTML adopts KRX colors; preserve tab-status green

Market-data hex literals (#22C55E → #DC2626, #F43F5E → #2563EB) and
rgba tints swapped line-by-line. .tab-status.loaded retains the green
#22C55E (status semantic, not market direction).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: DESIGN.md 갱신

색상 토큰 표, Discipline rule, Tint 표, Semantic 미니 섹션, Status dot 컴포넌트 행, Orderbook row 행, Decisions Log 신규 엔트리.

**Files:**
- Modify: `DESIGN.md` (저장소 루트)

- [ ] **Step 12-1: Color 토큰 표 재작성**

`DESIGN.md`의 Color 섹션 토큰 표(테이블)에서:
- `--up`, `--down`, `--ratio-ask` 행 **삭제**
- 다음 행 **추가** (Color 토큰 표 알파벳/카테고리 순서에 맞춰 배치):

```markdown
  | `--success` | `#22C55E` | UI 상태 semantic — 캡처 완료, 양호 상태, 체크리스트 done |
  | `--error` | `#F43F5E` | UI 상태 semantic — 실패, 에러 메시지, 비정상 상태 |
  | `--price-up` | `#DC2626` | 시장 데이터 — 상승, 매수, KRX 빨강 컨벤션 |
  | `--price-down` | `#2563EB` | 시장 데이터 — 하락, 매도, KRX 파랑 컨벤션 |
```

- [ ] **Step 12-2: Discipline rule 문단 갱신**

기존 문장:

```markdown
- **Discipline rule:** Teal is for UI state, never for data. Up/down semantic colors are for data values, never for UI chrome. This separation prevents confusion ("is this teal cell up? down? selected?").
```

다음으로 교체:

```markdown
- **Discipline rule:** Three mutually-exclusive color categories.
  - **UI state** (teal `--accent`): buttons, focus rings, active tabs, crosshair, primary CTAs. Never for data.
  - **Status semantic** (`--success`/`--error`): system feedback — capture complete/failed, error banners, calendar cell state, status dots. Never for market data.
  - **Price direction** (`--price-up`/`--price-down`): KRX convention — red = up/buy/positive delta, blue = down/sell/negative delta. Never for UI state or status.
  - This three-way separation prevents the "is this red because it failed, or because it's up?" ambiguity.
```

- [ ] **Step 12-3: Tint backgrounds 섹션 재작성**

기존 tint backgrounds 항목들을 다음으로 교체:

```markdown
- **Tint backgrounds (alpha-tinted chip / hover):**
  - Selection tint: `rgba(20,184,166,0.12)` — active nav, active tab, primary hover
  - Success tint: `rgba(34,197,94,0.10)` — completion chip background
  - Error tint: `rgba(244,63,94,0.10)` — error chip background
  - Price-up tint: `rgba(220,38,38,0.10)` — buy depth bar, positive market chip
  - Price-down tint: `rgba(37,99,235,0.10)` — sell depth bar, negative market chip
```

- [ ] **Step 12-4: Semantic 미니 섹션 갱신**

기존:

```markdown
- **Semantic (for future banners / toasts):**
  - Success: reuse `--up`
  - Error: reuse `--down`
  - Warning: `#F59E0B` (amber — not yet used)
  - Info: reuse `--accent`
```

교체:

```markdown
- **Semantic (banners / toasts):**
  - Success: `--success` (#22C55E)
  - Error: `--error` (#F43F5E)
  - Warning: `--warn` (#F59E0B, amber)
  - Info: `--accent` (teal)
```

- [ ] **Step 12-5: Status dot 컴포넌트 행 갱신**

Components — Tabs 또는 Status dot 항목에서 색상 참조를 갱신:

```diff
- - Status dot: 6px circle, `--up` solid (loaded), `--accent` pulsing (loading), `--fg-dimmer` outline (empty)
+ - Status dot: 6px circle, `--success` solid (loaded), `--accent` pulsing (loading), `--fg-dimmer` outline (empty)
```

- [ ] **Step 12-6: Orderbook row 컴포넌트 행 갱신**

Components — Orderbook table row 항목에서:

```diff
- - Right side bar gradient (depth visualization): 18% alpha of side color
+ - Right side bar gradient (depth visualization): `--tint-price-up` for bid side, `--tint-price-down` for ask side (both 10% alpha; rendered slightly stronger by overlap)
```

(또는 기존 표현이 더 정확하다면 토큰 이름만 합쳐서 명시.)

- [ ] **Step 12-7: Decisions Log 신규 엔트리**

Decisions Log 표 맨 아래에 추가 (2026-05-20 엔트리는 **삭제 금지** — 원칙은 강화이지 반전이 아님):

```markdown
| 2026-05-23 | Adopted KRX market convention (up=red `#DC2626`, down=blue `#2563EB`) | Single-user Korean analyst — Western up=green is counter-intuitive. Renamed `--up`/`--down` → `--success`/`--error` to disambiguate status semantic from price direction; introduced `--price-up`/`--price-down`. Removed `--ratio-ask` (folded into `--price-down`). All chart series now hide both `priceLineVisible` and `lastValueVisible` — analysts read latest values via crosshair. |
```

- [ ] **Step 12-8: 타입체크 + 테스트 (DESIGN.md는 코드 영향 없지만 회귀 가드)**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run
```

Expected: 0 errors, 통과.

- [ ] **Step 12-9: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): DESIGN.md adopts KRX colors + three-category discipline rule

Adds Decisions Log entry for 2026-05-23. Three mutually-exclusive
color categories (UI state / status semantic / price direction)
replace the prior two-way data-vs-UI split.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: deprecated 토큰 일괄 제거

이 시점에서 grep로 `--up`/`--down`/`--ratio-ask`/`--tint-up`/`--tint-down` 참조가 0인지 확인 후 정의 자체를 tokens.css와 tailwind.config.ts에서 삭제.

**Files:**
- Modify: `frontend/src/styles/tokens.css`
- Modify: `frontend/tailwind.config.ts`

- [ ] **Step 13-1: 전체 잔존 grep**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -rn "var(--up)\|var(--down)\|--ratio-ask\|text-up\b\|text-down\b\|bg-up\b\|bg-down\b\|bg-tint-up\|bg-tint-down" frontend/src/
```

Expected: 0 hits. 만약 hits가 있으면 해당 callsite를 먼저 적절한 토큰으로 이전 (Task 8-10 누락분).

- [ ] **Step 13-2: tokens.css에서 deprecated 토큰 정의 삭제**

```diff
-  --up: #22C55E;
-  --down: #F43F5E;
   --warn: #F59E0B;

   --grid: #1A1A26;
   --heat-lo: #0E1A1A;
   --heat-hi: #14B8A6;
-  --ratio-ask: #3B82F6;  /* Bid/ask ratio — ask-heavy (above 0), KRX-style sell blue */

   --tint-selection: rgba(20, 184, 166, 0.12);
-  --tint-up: rgba(34, 197, 94, 0.10);
-  --tint-down: rgba(244, 63, 94, 0.10);
```

- [ ] **Step 13-3: tailwind.config.ts에서 deprecated 매핑 삭제**

```diff
         accent: 'var(--accent)',
         'accent-fg': 'var(--accent-fg)',
         'accent-shade': 'var(--accent-shade)',
-        up: 'var(--up)',
-        down: 'var(--down)',
         success: 'var(--success)',
         error:   'var(--error)',
         'price-up':   'var(--price-up)',
         'price-down': 'var(--price-down)',
         grid: 'var(--grid)',
         'heat-lo': 'var(--heat-lo)',
         'heat-hi': 'var(--heat-hi)',
         'tint-selection': 'var(--tint-selection)',
-        'tint-up': 'var(--tint-up)',
-        'tint-down': 'var(--tint-down)',
         'tint-success':    'var(--tint-success)',
         'tint-error':      'var(--tint-error)',
         'tint-price-up':   'var(--tint-price-up)',
         'tint-price-down': 'var(--tint-price-down)',
```

- [ ] **Step 13-4: tokens.css 정의 grep 검증**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -nE "^\s*--(up|down|ratio-ask|tint-up|tint-down):" frontend/src/styles/tokens.css
```

Expected: 0 hits.

- [ ] **Step 13-5: 타입체크 + 테스트 + 린트 + 빌드**

```bash
cd frontend && npx tsc -b --noEmit && npx vitest run && npm run lint && npm run build
```

Expected: 0 errors, 빌드 성공. (Tailwind JIT가 deprecated 클래스 hit 0임을 빌드 시점에 검증.)

- [ ] **Step 13-6: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/tailwind.config.ts
git commit -m "chore(tokens): remove deprecated --up/--down/--ratio-ask/--tint-up/--tint-down

All callsites migrated to --success/--error (status) and
--price-up/--price-down (market data). Final grep+build confirms zero
residual references.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: 시각 검증 (수동 — 사용자 또는 dev 환경 실행자가 수행)

자동 검증으로 잡히지 않는 시각적 회귀를 사람 눈으로 확인.

**Files:** 없음

- [ ] **Step 14-1: dev 서버 기동**

```bash
cd frontend && npm run dev
```

브라우저에서 `http://localhost:5173/replay` 열기.

- [ ] **Step 14-2: 차트 페인 검증 체크리스트**

각 항목을 눈으로 확인:

- [ ] CandlePane: 양봉(close ≥ open)이 빨강 `#DC2626`, 음봉이 파랑 `#2563EB`. 마감 auction window 캔들은 muted(`--fg-dim`) 유지.
- [ ] VolumePane: 상승봉 거래량 빨강, 하락봉 거래량 파랑.
- [ ] RatioPane: 양수 영역(매도 우세) 파랑 fill, 음수 영역(매수 우세) 빨강 fill, 0-baseline 점선 회색 유지.
- [ ] FillStrengthPane: 0 baseline 위(매수) 빨강 히스토그램, 아래(매도) 파랑 히스토그램.
- [ ] QuoteTotalsPane: bid 라인 빨강, ask 라인 파랑.
- [ ] **모든 페인 우측 축**: 마지막값 horizontal 라인 **없음**, 우측 축 위 값 칩 **없음**.
- [ ] Crosshair hover 시 각 페인에서 값이 정상 표시.

- [ ] **Step 14-3: 사이드바 검증 체크리스트**

- [ ] OrderbookTable: 매수(bid) 행 빨강 텍스트 + 빨강 tint depth bar, 매도(ask) 행 파랑 텍스트 + 파랑 tint depth bar.
- [ ] BrokerNetTable: 순매수 양수 빨강, 음수 파랑.
- [ ] FillTape: 매수 체결 아이콘 빨강, 매도 체결 아이콘 파랑.
- [ ] PriceStrip: 가격 delta 양수 빨강, 음수 파랑.

- [ ] **Step 14-4: 상태 의미 색상 회귀 없음 확인**

- [ ] 캘린더 셀(완료): 녹색 `#22C55E` 유지.
- [ ] 캘린더 셀(client_incomplete): 분홍 `#F43F5E` 유지.
- [ ] SymbolSearch (fresh): 녹색 유지.
- [ ] SymbolSearch (unavailable): 분홍 유지.
- [ ] Tab status dot (loaded): 녹색 유지.
- [ ] Tab status dot (loading): teal pulsing 유지.
- [ ] CaptureForm 에러 메시지: 분홍 유지.
- [ ] Workarea 에러 placeholder: 분홍 유지.
- [ ] Toolbar rangeError: 분홍 유지.
- [ ] Settings symbol-master hint: 분홍 유지.
- [ ] OnboardingCard done: 녹색 유지.

- [ ] **Step 14-5: Mockup HTML 시각 확인**

`docs/superpowers/designs/2026-05-20-replay-viewer.html`을 브라우저(file://)로 열어 위 라이브 앱과 동일한 색 일관성 확인.

- [ ] **Step 14-6: 가시성 점검**

다크 배경(`--bg: #0E0E14`)에서 `#2563EB` 파랑이 캔들/히스토그램/라인 모두에서 충분히 보이는지 확인. 만약 너무 어둡다면 **이 plan 외 별도 후속 PR**에서 `#3B82F6`로 톤업 검토.

- [ ] **Step 14-7: 최종 grep 0 hits 보증**

```bash
cd /home/dev/code/hoga-ops/.claude/worktrees/feat+frontend3
grep -rn "var(--up)\|var(--down)\|--ratio-ask\|text-up\b\|text-down\b\|bg-up\b\|bg-down\b\|bg-tint-up\|bg-tint-down" frontend/src/ docs/superpowers/designs/
```

Expected: 0 hits 또는 `.tab-status.loaded` 관련 라인만 (mockup HTML의 의도된 예외).

- [ ] **Step 14-8: 시각 검증 완료를 PR 본문에 기록**

`gh pr create` 시 본문에 시각 검증 체크리스트 결과 첨부.

---

## Self-Review Notes

본 plan 작성 후 자가 점검:

1. **Spec coverage**: 스펙의 모든 섹션이 task에 1:1 매핑되는가?
   - 토큰 아키텍처 → Task 2, 13
   - 차트 페인 변경 → Task 3-7
   - UI 상태 호출처 (CSS 변수) → Task 8
   - UI 호출처 (Tailwind 시장 데이터) → Task 9
   - UI 호출처 (Tailwind 상태) → Task 10
   - Mockup HTML → Task 11
   - DESIGN.md → Task 12
   - 검증 → Task 14
   - ✅ 모든 스펙 섹션 커버.

2. **Placeholder scan**: 없음 (모든 step에 실제 코드/명령 포함).

3. **Type consistency**:
   - `bid`/`ask`(QuoteTotalsPane)와 `buy`/`sell`(FillStrengthPane) 변수명이 spec과 일관.
   - FillStrengthPane에서 시리즈 핸들 `buy`/`sell`이 이미 사용 중이라 색상 변수는 `buyColor`/`sellColor`로 명시.
   - 모든 task가 `--success`/`--error`/`--price-up`/`--price-down`/`--tint-success`/`--tint-error`/`--tint-price-up`/`--tint-price-down` 8개 토큰 이름을 동일하게 사용.

4. **Risk surfaces**:
   - Mockup HTML의 `.tab-status.loaded` 예외는 Task 11-2에서 명시적으로 보존 처리.
   - `RatioPane`의 0-baseline `createPriceLine`은 Task 7-2 ⚠️ 박스에서 보존 명시.
