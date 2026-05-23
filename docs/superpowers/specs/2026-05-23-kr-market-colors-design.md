# KRX 색상 컨벤션 + 마지막값 라인 제거 — Design

**Created:** 2026-05-23
**Page in scope:** `http://localhost:5173/replay`
**Trigger:** 사용자가 한국 시장 컨벤션(상승=빨강, 하락=파랑)으로 차트 및 보조지표 색상을 통일하고, 모든 차트 시리즈의 마지막값 라인/우측축 칩을 제거 요청.

## 목표

1. **KRX 컨벤션 적용** — 차트 시장 데이터 색상을 상승=빨강(`#DC2626`), 하락=파랑(`#2563EB`)로 전환.
2. **토큰 의미 분리** — `--up`/`--down`(현재 데이터/상태 양쪽에서 재사용 중)을 `--success`/`--error`(상태)와 `--price-up`/`--price-down`(시장 데이터)로 명확히 분리.
3. **마지막값 노이즈 제거** — 5개 차트 페인 모든 series에서 `priceLineVisible: false` + `lastValueVisible: false`.
4. **레퍼런스 일관성** — DESIGN.md, mockup HTML, tokens.css, Tailwind config, 차트 페인, UI 호출처를 한 PR에서 동시 갱신.

## Non-goals

- 라이트 모드 도입.
- Density dial(`:root font-size`) 변경.
- `--accent`(teal), `--heat-*`, `--warn` hex 변경.
- 상태 토큰의 hex 변경 — 이름만 `--success`/`--error`로 리네이밍, 색상은 기존 `#22C55E`/`#F43F5E` 유지.
- `RatioPane`의 0-baseline reference line 제거 (마지막값 라인이 아니므로 스코프 외).
- KRX/Western 색상 토글 기능 추가.

## 토큰 아키텍처

### `frontend/src/styles/tokens.css`

```diff
- --up: #22C55E;
- --down: #F43F5E;
- --ratio-ask: #3B82F6;
+ --success: #22C55E;      /* 상태 — 완료/성공 */
+ --error:   #F43F5E;      /* 상태 — 실패/에러 */
+ --price-up:   #DC2626;   /* KRX 시장 데이터 — 상승/매수 */
+ --price-down: #2563EB;   /* KRX 시장 데이터 — 하락/매도 */
  --warn: #F59E0B;

- --tint-up:   rgba(34, 197, 94, 0.10);
- --tint-down: rgba(244, 63, 94, 0.10);
+ --tint-success:    rgba(34, 197, 94, 0.10);
+ --tint-error:      rgba(244, 63, 94, 0.10);
+ --tint-price-up:   rgba(220, 38, 38, 0.10);   /* DC2626 @ 10% */
+ --tint-price-down: rgba(37, 99, 235, 0.10);   /* 2563EB @ 10% */
```

`--ratio-ask`는 완전 제거. `RatioPane`이 `--price-down`을 직접 참조.

### `frontend/tailwind.config.ts`

```diff
- up: 'var(--up)',
- down: 'var(--down)',
+ success: 'var(--success)',
+ error: 'var(--error)',
+ 'price-up':   'var(--price-up)',
+ 'price-down': 'var(--price-down)',
- 'tint-up':   'var(--tint-up)',
- 'tint-down': 'var(--tint-down)',
+ 'tint-success':    'var(--tint-success)',
+ 'tint-error':      'var(--tint-error)',
+ 'tint-price-up':   'var(--tint-price-up)',
+ 'tint-price-down': 'var(--tint-price-down)',
```

### Discipline rule (DESIGN.md 갱신)

세 카테고리, 상호 배타:

| 토큰군 | 사용처 | 금지 |
|---|---|---|
| `--success`, `--error`, `--tint-success`, `--tint-error` | UI 상태 피드백: 캡처 완료/실패, 에러 메시지, 캘린더 셀, 캡처 큐 상태, 시스템 헬스 dot, 탭 로드 dot, 체크리스트 완료 | 차트 시장 데이터 |
| `--price-up`, `--price-down`, `--tint-price-*` | 시장 데이터: 캔들, 거래량, 호가 라인, 체결 강도, 호가비, broker 순매수, 가격 delta, 호가창 행 depth bar | UI 상태 |
| `--accent`(teal) | UI 상태: 버튼/포커스/탭/크로스헤어 | 시장 데이터 |

색상 토큰은 `design-tokens.ts`에 없고 `tokens.css`에 직접 정의되어 있다 (design-tokens.ts:8-13 주석에 명시). 따라서 `npm run gen:tokens` 재실행 **불필요**.

## 차트 페인 변경

5개 페인 모두에 `priceLineVisible: false`와 `lastValueVisible: false`를 추가하고 TOKEN_SPEC을 새 토큰으로 교체.

### `frontend/src/chart/CandlePane.tsx`

```diff
 const TOKEN_SPEC = {
-  up: ['--up', '#22C55E'],
-  down: ['--down', '#F43F5E'],
+  up: ['--price-up',   '#DC2626'],
+  down: ['--price-down', '#2563EB'],
   muted: ['--fg-dim', '#94A3B8'],
 } as const;
```

CandlestickSeries 옵션에 `priceLineVisible: false, lastValueVisible: false` 추가 (현재 둘 다 누락).

### `frontend/src/chart/VolumePane.tsx`

TOKEN_SPEC 위와 동일하게 교체. 기존 `priceLineVisible: false`에 `lastValueVisible: false` 추가. 인라인 주석("The right-axis chip still shows the latest total volume.") 제거.

### `frontend/src/chart/QuoteTotalsPane.tsx`

```diff
- up: ['--up', '#22C55E'],     // 매수 호가 총합
- down: ['--down', '#F43F5E'], // 매도 호가 총합
+ bid: ['--price-up',   '#DC2626'],
+ ask: ['--price-down', '#2563EB'],
```

TOKEN_SPEC 변수명을 `up/down` → `bid/ask`로 변경 (시장 사이드 표현). 두 LineSeries 모두 `priceLineVisible: false, lastValueVisible: false`.

### `frontend/src/chart/FillStrengthPane.tsx`

```diff
- up: ['--up', '#22C55E'],
- down: ['--down', '#F43F5E'],
+ buy:  ['--price-up',   '#DC2626'],
+ sell: ['--price-down', '#2563EB'],
```

두 HistogramSeries 모두 `priceLineVisible: false, lastValueVisible: false`.

### `frontend/src/chart/RatioPane.tsx`

```diff
 const TOKEN_SPEC = {
-  ratioAsk: ['--ratio-ask', '#3B82F6'],
-  // Reused: same hex as price-direction --down, but here it encodes
-  // bid-heavy order-book pressure (below 0). Inline comment marks the
-  // semantic distinction so future maintainers don't refactor it away.
-  ratioBid: ['--down', '#F43F5E'],
+  // KRX 컨벤션: 매수=상승=빨강, 매도=하락=파랑.
+  // RatioPane은 가격 방향 토큰을 직접 차용 — 의미 충돌 없음.
+  ratioBid: ['--price-up',   '#DC2626'],
+  ratioAsk: ['--price-down', '#2563EB'],
   baseline: ['--fg-dimmer', '#64748B'],
 } as const;
```

BaselineSeries에 `lastValueVisible: false` 추가 (`priceLineVisible: false`는 이미 있음).
`series.createPriceLine({ price: 0, ... })` — 0-baseline reference line은 **유지**.

## UI 상태 호출처 마이그레이션

### CSS 변수 직접 참조

| 파일:줄 | 현재 | 분류 | 변경 |
|---|---|---|---|
| `capture/CalendarCell.tsx:10` | `complete: 'var(--up)'` | 상태 | `var(--success)` |
| `capture/CalendarCell.tsx:12` | `client_incomplete: 'var(--down)'` | 상태 | `var(--error)` |
| `capture/SymbolSearch.tsx:30` | `fresh: 'var(--up)'` | 상태 | `var(--success)` |
| `capture/SymbolSearch.tsx:32` | `unavailable: 'var(--down)'` | 상태 | `var(--error)` |
| `capture/CaptureForm.tsx:113` | `color: 'var(--down)'` | 상태 | `var(--error)` |
| `capture/CaptureQueue.tsx:111` | `ghostButton('var(--down)', 'var(--down)')` | 상태 | `var(--error)` |
| `nav/StatusDot.tsx:20` | `green→'var(--up)' ... red→'var(--down)'` | 상태 | `var(--success)` / `var(--error)` |

### Tailwind 클래스

| 파일:줄 | 현재 | 분류 | 변경 |
|---|---|---|---|
| `replay/PriceStrip.tsx:72` | `delta>0?'text-up':'text-down'` | 시장 데이터 | `text-price-up`/`text-price-down` |
| `sidebar/BrokerNetTable.tsx:25` | `r.net>0?'text-up':'text-down'` | 시장 데이터 | `text-price-up`/`text-price-down` |
| `sidebar/OrderbookTable.tsx:67` | `ask?'bg-tint-down':'bg-tint-up'` | 시장 데이터 | `bg-tint-price-down`/`bg-tint-price-up` |
| `sidebar/OrderbookTable.tsx:68` | `ask?'text-down':'text-up'` | 시장 데이터 | `text-price-down`/`text-price-up` |
| `sidebar/FillTape.tsx:35` | `side>0?'text-up':'text-down'` | 시장 데이터 | `text-price-up`/`text-price-down` |
| `replay/Tab.tsx:45` | `'bg-up'` (loaded 상태 dot) | 상태 | `bg-success` |
| `replay/OnboardingCard.tsx:29` | `done?'text-up'` | 상태 | `text-success` |
| `replay/Workarea.tsx:55` | `text-down` (에러 placeholder) | 상태 | `text-error` |
| `replay/Toolbar.tsx:87` | `'text-down'` (rangeError) | 상태 | `text-error` |
| `capture/CaptureForm.tsx:101` | `'text-down'` (alert) | 상태 | `text-error` |
| `capture/CaptureRowDetail.tsx:49,50` | `'text-down'` (error 라벨) | 상태 | `text-error` |
| `pages/Settings.tsx:72` | `'text-down'` (symbol master hint) | 상태 | `text-error` |

총 5개가 시장 데이터, 9개가 상태로 분류됨.

## Mockup HTML 갱신

`docs/superpowers/designs/2026-05-20-replay-viewer.html` line-by-line 치환 (sed 일괄 치환 금지).

| 현재 hex | 컨텍스트 | 새 hex |
|---|---|---|
| `#22C55E` (`.tab-status.loaded` 배경 + box-shadow `rgba(34,197,94,0.5)`) | 상태 dot — **유지** | `#22C55E` (변경 없음) |
| `#22C55E` (그 외 모든 사용처: bid 호가 색, buy 가격, 양수 delta, broker net pos, candle up, depth bar bid, tape buy 등) | 시장 데이터 | `#DC2626` |
| `#F43F5E` (전 사용처: ask 호가 색, sell 가격, 음수 delta, broker net neg, candle down, depth bar ask, tape sell) | 시장 데이터 | `#2563EB` |
| `rgba(34,197,94,0.10)` 및 `rgba(34,197,94,0.85)` (시장 데이터 컨텍스트) | 시장 데이터 alpha | `rgba(220,38,38,...)` |
| `rgba(244,63,94,0.10)` 및 `rgba(244,63,94,0.85)` | 시장 데이터 alpha | `rgba(37,99,235,...)` |

**예외**: `.tab-status.loaded`의 `#22C55E` 및 `rgba(34,197,94,0.5)`는 상태 의미라 유지.

## DESIGN.md 갱신 섹션

- **Color 섹션**: 토큰 표 재작성 — `--up`/`--down`/`--ratio-ask` 행 제거, `--success`/`--error`/`--price-up`/`--price-down` 행 추가. "Use" 컬럼에 새 Discipline rule 반영.
- **Tint backgrounds**: 4종 신규(`--tint-success`/`--tint-error`/`--tint-price-up`/`--tint-price-down`)로 재작성.
- **Discipline rule** 문단: 세 카테고리(status semantic / price direction / UI state) 명시.
- **Semantic** 미니 섹션: `Success: --success; Error: --error; Warning: --warn; Info: --accent`로 재정의(재사용 표현 제거).
- **Components — Status dot**: "loaded → `--success`, loading → `--accent` pulsing, empty → `--fg-dimmer`".
- **Components — Orderbook table row**: depth bar 색상을 `--tint-price-up`/`--tint-price-down`로 명시.
- **Decisions Log**: 2026-05-20 엔트리 유지(원칙 강화이지 반전이 아님), 2026-05-23 엔트리 추가:
  > Adopted KRX market convention (up=red #DC2626, down=blue #2563EB). Renamed `--up`/`--down` to `--success`/`--error` to disambiguate status semantic from price direction; introduced `--price-up`/`--price-down`. Removed `--ratio-ask` token (folded into `--price-down`). All chart series now hide both `priceLineVisible` and `lastValueVisible` — analysts read latest values via crosshair.

## 검증

### 자동 검증

```bash
# 0 hits 확인
grep -rn "var(--up)\|var(--down)\|--ratio-ask\|text-up\b\|text-down\b\|bg-up\b\|bg-down\b\|bg-tint-up\|bg-tint-down" frontend/src/

# tokens.css의 --success/--error 정의 2줄 외에 0 hits
grep -n "#22C55E\|#F43F5E\|#3B82F6" frontend/src/styles/tokens.css frontend/src/chart/*.tsx

# 타입 + 테스트
npm run typecheck
npm test
```

`npm run gen:tokens` 실행 불필요 (색상 토큰은 generator 대상 아님).

### 시각 검증 (수동, `http://localhost:5173/replay`)

- 캔들 페인: 양봉=빨강(#DC2626), 음봉=파랑(#2563EB).
- 거래량 페인: 상승봉 거래량=빨강, 하락봉=파랑.
- 호가비 페인: 양수 영역(매도 우세)=파랑 fill, 음수(매수 우세)=빨강 fill, 0-baseline 라인 유지.
- 체결 강도 페인: 매수 히스토그램=빨강, 매도=파랑.
- **모든 페인의 우측 축에 마지막값 칩/라인 없음**. crosshair hover 시 값 정상 표시.
- 사이드바 호가창: 매수=빨강, 매도=파랑, depth bar 동일 색 18% alpha.
- 캘린더 셀: 완료=녹색 유지, 실패=분홍 유지.
- 탭 status dot: loaded=녹색 유지, loading=teal pulsing.
- 캡처 폼 에러 메시지: 분홍 유지.
- Mockup HTML(`docs/superpowers/designs/2026-05-20-replay-viewer.html`)을 브라우저에서 열어 라이브 앱과 동일하게 보이는지 확인.

## 위험 & 대응

| 위험 | 대응 |
|---|---|
| callsite 의미 분류 실수 | 구현 시 각 callsite의 surrounding 코드 재확인. PR에 분류표 첨부. |
| Mockup HTML `tab-status.loaded` 예외 누락 | sed 일괄 치환 금지, line-by-line 치환. PR review 시 모든 hex 변경 라인 컨텍스트 확인. |
| 다크 배경에서 `#2563EB` 가시성 부족 | 구현 후 시각 검증. 필요 시 후속 PR에서 `#3B82F6`(500대)로 톤업 — 본 스펙 스코프 외. |
| `RatioPane` 0-baseline `createPriceLine` 실수 제거 | 검증 시 RatioPane의 0선 가시성 확인. |

## 변경 파일 요약

| 파일 | 변경 유형 |
|---|---|
| `DESIGN.md` | Color / Tint / Semantic / Components / Decisions Log 갱신 |
| `frontend/src/styles/tokens.css` | 6 추가, 2 리네이밍, 1 제거 |
| `frontend/tailwind.config.ts` | colors 매핑 6 추가, 2 리네이밍, 2 제거 |
| `frontend/src/chart/CandlePane.tsx` | TOKEN_SPEC, `priceLineVisible`/`lastValueVisible` |
| `frontend/src/chart/VolumePane.tsx` | TOKEN_SPEC, `lastValueVisible` |
| `frontend/src/chart/QuoteTotalsPane.tsx` | TOKEN_SPEC (bid/ask), `priceLineVisible`/`lastValueVisible` |
| `frontend/src/chart/FillStrengthPane.tsx` | TOKEN_SPEC (buy/sell), `priceLineVisible`/`lastValueVisible` |
| `frontend/src/chart/RatioPane.tsx` | TOKEN_SPEC (ratio-ask 제거), `lastValueVisible` |
| `frontend/src/capture/CalendarCell.tsx` | `var(--up/--down)` 리네이밍 |
| `frontend/src/capture/SymbolSearch.tsx` | 동일 |
| `frontend/src/capture/CaptureForm.tsx` | 동일 + Tailwind 클래스 |
| `frontend/src/capture/CaptureQueue.tsx` | 동일 |
| `frontend/src/capture/CaptureRowDetail.tsx` | Tailwind 클래스 |
| `frontend/src/nav/StatusDot.tsx` | 토큰 리네이밍 |
| `frontend/src/replay/PriceStrip.tsx` | `text-price-*` |
| `frontend/src/replay/Tab.tsx` | `bg-success` |
| `frontend/src/replay/OnboardingCard.tsx` | `text-success` |
| `frontend/src/replay/Toolbar.tsx` | `text-error` |
| `frontend/src/replay/Workarea.tsx` | `text-error` |
| `frontend/src/sidebar/OrderbookTable.tsx` | `text-price-*`, `bg-tint-price-*` |
| `frontend/src/sidebar/BrokerNetTable.tsx` | `text-price-*` |
| `frontend/src/sidebar/FillTape.tsx` | `text-price-*` |
| `frontend/src/pages/Settings.tsx` | `text-error` |
| `docs/superpowers/designs/2026-05-20-replay-viewer.html` | 시장 데이터 hex 치환, `tab-status.loaded` 예외 유지 |

총 약 22개 파일.
