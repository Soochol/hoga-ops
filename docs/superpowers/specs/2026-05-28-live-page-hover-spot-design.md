# Live Page Hover Spot (10호가 / 거래원 / 체결)

**Date:** 2026-05-28
**Status:** Spec — awaiting plan
**Scope:** frontend + backend (small thread-through)

## Problem

Live 페이지(`/live`)에서 캔들 차트에 마우스를 hover했을 때, 마우스가 가리키는
시점(분봉)의 10호가·거래원·체결 데이터를 sidebar에 spot으로 보여주고 싶다.
replay 페이지는 이미 동일한 패턴이 구현되어 있다(crosshair → cursorMs → REST).
live 페이지는 sidebar(`LiveSidebar`)가 있지만 현재는 "latest live"만 표시한다.

## Goals

- 분봉(1m, 5m, …) timeframe에서 차트 위에 마우스가 있는 동안 sidebar의
  10호가·거래원·체결 카드가 그 시점의 spot 데이터로 바뀐다.
- 마우스가 차트를 벗어나면 즉시 latest live 표시로 복귀한다.
- KIS/hogaplay 데이터가 있는 어떤 날짜에서도 동작한다(오늘 장중 포함, 단 해당
  파케이가 존재해야 함).
- 사용자의 source preference(`useSourcePreferenceStore`)를 hover spot 조회에도
  적용한다.

## Non-goals

- 일/주/월 timeframe에서의 hover spot — non-minute timeframe에서는 crosshair
  구독 자체를 mount하지 않는다.
- 새 단일 spot 엔드포인트(`/api/spot`) — 측정 없이 도입할 만한 최적화 아님.
- LiveBuffer 영속화 파이프라인 신설 — 데이터가 파케이에 있다는 전제로 진행.
- LiveBuffer에 시간 키 인덱스 추가(SSE 기반 hover spot) — 명시적으로 거부, ADR-0044 참조.
- replay 페이지의 hover 동작 변경.

## Decisions

1. **데이터 소스**: 기존 replay용 REST 엔드포인트(`/api/orderbook`,
   `/api/trades`, `/api/brokers/series`)를 재사용. **LiveBuffer / SSE는 hover
   spot 경로에 참여하지 않는다** — `ADR-0044` 가 이 결정과 ADR-0039와의 경계를
   정식화한다. 결과적으로 오늘 자 데이터는 ADR-0043 Today Promotion 사이클
   (기본 5분)만큼의 lag을 가질 수 있다(받아들이는 trade-off).
2. **Source preference**: 위 세 엔드포인트에 `source_pref` 쿼리 파라미터를
   추가하고, 라우트 핸들러에서 `_resolve_source(engine, date, code, source_pref)`
   를 호출한다. `_resolve_source` 는 이미 `hoga/api/bundle.py` 에 존재하므로
   필요시 공통 모듈(`hoga/api/sources.py`)로 추출해 import 가능하게 한다.
3. **Sidebar 분기**: `LiveSidebar` 안의 데이터 어댑터 레이어에서
   `cursorMs == null` 이면 기존 `useLiveSeries` 결과를, `cursorMs != null` 이면
   새 cursor 훅 결과를 동일한 카드 컴포넌트에 prop으로 주입한다. 카드 컴포넌트
   (`OrderbookTable`, `BrokerTrajectoryTable`, `TradesTable`)는 수정하지 않는다.
4. **Cursor store**: live 페이지 전용 단순 store
   (`frontend/src/live/useLiveCursorStore.ts`)를 신설한다.
   `useTabsStore.cursor`(replay용)와 책임은 같지만 단일-탭이라 단순한 형태.
5. **rAF coalescing**: replay와 동일 패턴으로 `LiveChartRoot` 안에서 처리.
6. **Source fallback 가시화**: 세 엔드포인트 응답에 실제 사용된 `source` 필드를
   포함시켜 `LiveStatusBar` 의 source chip이 fallback을 반영하게 한다(이미
   `/api/range` 응답이 source를 포함한다면 동일 패턴).
7. **LiveSidebar 헤더 모드 표시**: 현재 `LiveSidebar` 의 `LIVE●` 펄스 헤더는
   "이 sidebar는 latest tick을 자동 추적한다"는 약속을 시각화한다. cursorMs가
   set인 동안에는 이 약속이 임시로 깨지므로 헤더를 **`SPOT @ HH:MM:SS`**(펄스
   제거, 시각 강조)로 교체한다. cursorMs가 null이면 즉시 펄스 복귀.
8. **Hover 시점 Auction Mask 활성**: 현재 `LiveSidebar` 는 `TotalQtyBar` 의
   `maskRatio={false}` 를 하드코딩한다(live 모드에 virtualAxis 미연결). cursorMs가
   set이고 그 시점이 closing auction window(15:20–15:30) 안이면
   `maskRatio = VirtualAxis.inClosingAuctionWindow(cursorMs)` 결과를 사용한다.
   `LiveChartRoot` 가 이미 VirtualAxis 인스턴스를 보유하므로 동일 인스턴스를
   `LiveSidebar` 가 참조 가능하도록 store 공유 또는 prop drilling으로 전달.
   cursorMs가 null이면 기존 동작(`maskRatio={false}`)을 유지 — live 모드의 latest
   tick에는 axis-기반 mask가 의미를 가지지 않음.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Live page                                                   │
│  ┌────────────────────────────┐  ┌──────────────────────┐   │
│  │ LiveChartRoot              │  │ LiveSidebar          │   │
│  │  ├─ lightweight-charts     │  │  ├─ OrderbookTable   │   │
│  │  └─ subscribeCrosshairMove │  │  ├─ BrokerTrajectory │   │
│  │        │ (rAF coalesced)   │  │  └─ TradesTable      │   │
│  │        ▼                   │  │      ▲               │   │
│  └────────────────────────────┘  └──────│───────────────┘   │
│                │ setCursor                │                  │
│                ▼                          │ select data      │
│    ┌────────────────────────┐             │                  │
│    │ useLiveCursorStore     │─────────────┤                  │
│    │  { cursorMs | null }   │             │                  │
│    └────────────────────────┘             │                  │
│                                           │                  │
│    cursorMs == null ──► useLiveSeries (existing, latest)     │
│    cursorMs != null ──► useLiveOrderbookAtCursor /           │
│                          useLiveTradesAroundCursor /         │
│                          useLiveBrokersAtCursor (new)        │
└─────────────────────────────│───────────────────────────────┘
                              │ REST + source_pref
                              ▼
              ┌──────────────────────────────┐
              │ /api/orderbook   ?source_pref│  ◄── extend
              │ /api/trades      ?source_pref│  ◄── extend
              │ /api/brokers/... ?source_pref│  ◄── extend
              │     _resolve_source(...)     │      (reuse existing)
              └──────────────────────────────┘
```

원칙:
- 단일 분기점은 `LiveSidebar` 안의 어댑터 — 카드는 손대지 않음.
- non-minute timeframe에서는 crosshair 구독 자체를 mount하지 않음.
- 백엔드는 `_resolve_source` 라는 기존 로직을 세 엔드포인트에 노출만 함.

## Components

### Frontend — 신규

**`frontend/src/live/useLiveCursorStore.ts`**
- Zustand store: `{ cursorMs: number | null, setCursor, clearCursor }`.
- store 자체에는 종목 reset 로직을 두지 않는다. `LiveChartRoot` 의 effect
  cleanup에서 종목/timeframe 의존성이 바뀔 때 `clearCursor()` 를 호출한다
  (cross-module 의존 최소화).

**`frontend/src/api/useLiveCursor.ts`**
- `useLiveOrderbookAtCursor(code, date, timeframe)`
- `useLiveTradesAroundCursor(code, date)`
- `useLiveBrokersAtCursor(code, date)`
- 기존 `frontend/src/api/useSpot.ts`(LRU 100 + 30ms debounce + 모노토닉 토큰) 위에
  쌓는다. replay의 `useCursor.ts` 와 동일한 패턴.
- `cursorMs == null` → `key = null` 로 fetch 비활성.
- **Client-side bucket alignment 필수**: replay와 동일하게
  `alignedT = Math.floor(cursorMs / bucketMs) * bucketMs` 로 floor한 뒤
  URL과 키 양쪽에 같은 값을 쓴다. 이게 빠져 있으면 hover 픽셀마다 새 fetch가
  나가서 `/api/trades` 가 ~60 req/s로 두들겨 맞는다(replay에서 관측된 사례,
  `useCursor.ts` 코멘트 참조).
- 키 포맷: `live|{kind}|{code}|{date}|{alignedT}|{bucketMs}|{sourcePref}`.

### Frontend — 수정

**`frontend/src/live/LiveChartRoot.tsx`**
- `subscribeCrosshairMove(param)` 핸들러 추가 (`ChartStage.tsx` 패턴 그대로 사용).
- timeframe이 분봉일 때만 구독, 비분봉이면 구독 자체를 mount 안 함.
- mouseleave 시 `clearCursor()`.
- timeframe/종목 변경 시 cursor reset.

**`frontend/src/live/LiveSidebar.tsx`**
- `useLiveCursorStore(s => s.cursorMs)` 구독.
- 어댑터 레이어에서 cursorMs로 데이터 소스 분기 후 동일 카드에 prop 주입.
- 헤더 모드 표시:
  - `cursorMs == null` → 기존 `LIVE● + HH:MM:SS` 펄스 유지.
  - `cursorMs != null` → `SPOT @ HH:MM:SS` (펄스 제거, cursorMs를 KST로 포맷).
- `TotalQtyBar` 의 `maskRatio`:
  - `cursorMs == null` → 기존 `false` 유지.
  - `cursorMs != null` → `axis.inClosingAuctionWindow(cursorMs)` 결과 사용.
  - 이를 위해 `LiveChartRoot` 가 보유한 `VirtualAxis` 인스턴스를 `LiveSidebar`
    가 참조해야 함 — store에 axis ref를 두거나(권장: `useLiveAxisStore`)
    `LiveWorkarea` 에서 axis를 prop drilling. 실제 선택은 plan 단계.

### Backend — 수정

**`hoga/api/routes.py`**
- `/api/orderbook`, `/api/trades`, `/api/brokers/series` 세 라우트에
  `source_pref: Literal["hogaplay", "kis_live"] = "hogaplay"` 추가.
- 핸들러에서 `_resolve_source(engine, date, code, source_pref)` 결과를
  기존 parquet 읽기 함수에 전달.
- 응답 모델 세 개에 `source: SourceName` 필드 **확정 추가**
  (확인 결과 셋 다 현재 미존재):
  - `OrderbookResponse` (models.py:66)
  - `TradesResponse` (models.py:71)
  - `BrokerSeriesResponse` (models.py:536)
- ADR-0039 invariant("`/api/range` 응답 shape 불변")는 `/api/range`에만 적용 —
  본 변경과 충돌 없음.

**`hoga/api/bundle.py` / `hoga/api/sources.py`**
- `_resolve_source` 가 `bundle.py` 안에 private이면 `hoga/api/sources.py` 로
  옮겨 import 가능하게 함. 외부 동작 변화 없음.

### 비-수정 (의도)

- `OrderbookTable`, `BrokerTrajectoryTable`, `TradesTable`.
- `useLiveSeries`.
- replay 측 모든 코드 (`useCursor.ts` 공통화 여부는 simplify 단계에서 판단).

## Data flow

### Hover → spot

```
mousemove
  → onCrosshairMove (lightweight-charts)
  → rAF coalesce
  → virtualAxis.virtualToRealMs(time)
  → useLiveCursorStore.setCursor(realMs)
  → LiveSidebar 어댑터: cursorMs != null
  → useLiveOrderbookAtCursor / useLiveTradesAroundCursor / useLiveBrokersAtCursor
  → GET /api/orderbook?...&source_pref=
       /api/trades?...&source_pref=
       /api/brokers/series?...&source_pref=
  → 세 카드 spot 데이터로 리렌더
```

### Mouse leave

```
onCrosshairMove (param.point == null)
  → useLiveCursorStore.clearCursor()
  → LiveSidebar 어댑터: cursorMs == null
  → useLiveSeries (latest) 분기 복귀
  → 카드가 latest로 즉시 리렌더
```

### Timeframe 변경

- 분봉 → 분봉: 구독 유지, bucket_ms 갱신.
- 분봉 → 비분봉: 구독 해제 + `clearCursor()` 1회 호출.

### Backend source 해석

```
GET /api/orderbook?...&source_pref=kis_live
  → source = _resolve_source(engine, date, code, "kis_live")
    - data/parquet/YYYYMMDD/{code}/kis_live/meta.json 있음 → "kis_live"
    - 없음 → fallback (ADR-0039 의미론)
  → read_snapshot(parquet_dir(date, code, source), t, bucket_ms)
  → OrderbookResponse { snapshot | available_from, source }
```

## Error handling

### 데이터 없음 (정상)

- `/api/orderbook` 이 200 + `snapshot: null` + `available_from` → 카드는 빈 상태,
  "다음 가용: HH:MM" 힌트(가능한 경우).
- 거래원/체결도 동일 — 빈 series는 빈 카드.

### 파케이 자체 없음

- 라우트가 404 `parquet_not_found` → 카드는 `"이 날짜의 데이터가 없습니다"` 빈 상태.
- 토스트는 띄우지 않음(hover는 고빈도 트리거).

### 네트워크 에러

- `useSpot` 는 retry를 제공하지 않으며 실패 시 `console.error` + `data` 는
  `undefined` 유지. 카드는 로딩 인디케이터를 거두고 빈 상태를 보여준다.
- 별도 토스트 없음(hover는 고빈도 트리거).

### Source fallback

- 응답 `source` 필드가 실제 사용된 source를 반영 → `LiveStatusBar` source chip이
  fallback을 시각화.

### 동시성

- 종목/timeframe 변경 시 cursor reset.
- React Query가 query key 변경으로 이전 fetch 자동 stale 처리.

### LiveBuffer 충돌

- cursor 분기일 때 `useLiveSeries` 의 SSE 업데이트가 카드에 영향 주지 않도록
  어댑터에서 결과를 참조하지 않음(조건부 hook 호출은 금지이므로 결과는 받되 미사용).
- mouseleave 시 LiveBuffer 최신 상태가 즉시 반영됨(추가 fetch 없음).

## Testing

### Backend (`tests/unit/api/`)

`test_orderbook_endpoint.py`, `test_trades_endpoint.py`, `test_brokers_endpoint.py`
각각에 동일 4개 패턴:

- `*_source_pref_prefers_kis_live`
- `*_source_pref_falls_back_to_hogaplay` (응답 `source` 필드가 실제 사용된
  source = "hogaplay" 임을 검증; 응답 shape 회귀 방지도 겸함)
- `*_source_pref_default_is_hogaplay` (회귀 방지)
- `*_source_pref_invalid_returns_422`

`test_resolve_source.py`: `_resolve_source` 가 별도 모듈로 추출되면 단위 테스트.

### Frontend — store/hook

`frontend/src/live/useLiveCursorStore.test.ts`:
- `setCursor` / `clearCursor` 기본 동작.
- 종목 reset은 store 자체에 내장하지 않는다 — `LiveChartRoot` 의 effect
  cleanup(종목/timeframe 의존)에서 `clearCursor()` 호출로 처리(cross-module
  의존을 store 안에 두지 않기 위함). 이 동작은 `LiveChartRoot.test.tsx` 가
  검증한다.

`frontend/src/api/useLiveCursor.test.ts`:
- `cursorMs == null` → `key = null` (fetch 발생 안 함).
- `cursorMs != null` → 올바른 키 + URL.
- `source_pref` 가 store에서 읽혀 키와 query string에 포함.
- **Bucket alignment**: 동일 분 안에서 cursorMs를 흔들어도 키가 같고
  `useSpot` 의 LRU가 히트해서 추가 fetch가 발생하지 않는다(=
  `apiGet` mock 호출 횟수 1회).
- trades/brokers 훅 동일 패턴.

### Frontend — 통합

`frontend/src/live/LiveSidebar.test.tsx`:
- cursorMs == null → `useLiveSeries` 결과 사용 + `LIVE●` 헤더 + `maskRatio=false`.
- cursorMs != null → cursor 훅 결과 사용 + `SPOT @ HH:MM:SS` 헤더(펄스 없음).
- cursorMs가 closing auction window 안(예: 15:25) → `maskRatio=true` 가
  `TotalQtyBar` 에 전달됨(`axis.inClosingAuctionWindow` mock으로 검증).
- cursorMs가 window 밖 → `maskRatio=false`.
- 토글 시 카드가 latest로 즉시 복귀하며 헤더도 펄스로 복귀.

`frontend/src/live/LiveChartRoot.test.tsx`:
- 분봉 timeframe: crosshair move → `setCursor` 호출.
- 비분봉 timeframe: 구독 mount 안 됨.
- mouseleave → `clearCursor`.
- 종목/timeframe 변경 시 reset.

### E2E (선택, plan 단계에서 우선순위 결정)

- `/browse` 로 `/live` 진입 → 분봉 → 차트 hover → sidebar 카드 텍스트 검증.

### 우선순위

1. **Must**: backend source_pref 테스트 12개 (4 × 3 엔드포인트),
   useLiveCursorStore, useLiveCursor 훅.
2. **Should**: LiveSidebar 분기, LiveChartRoot crosshair.
3. **Nice**: E2E.

## Open questions for plan stage

- `_resolve_source` 가시성 결정: `bundle.py` 안에서 `resolve_source` 로 rename
  + export vs 새 `hoga/api/sources.py` 모듈로 추출. 첫 번째가 단순 — simplify
  단계(8단계)에서 자연스럽게 결정.
- `VirtualAxis` 인스턴스를 `LiveSidebar` 에 전달하는 방식: 신규
  `useLiveAxisStore` (권장) vs `LiveWorkarea` 의 prop drilling.
- `available_from` 힌트 표시 UX(replay 패턴 확인 후 결정 — replay에 이미 있다면 차용).
- E2E 도입 여부(must/should/nice 우선순위는 정해짐; plan에서 actual task로 승격할지만 결정).
