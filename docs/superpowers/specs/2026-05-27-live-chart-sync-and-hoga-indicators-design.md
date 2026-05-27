# /live 차트 동기화 + 과거 lazy fetch + 호가 지표 정상화 설계

날짜: 2026-05-27
대상 페이지: `/live` (frontend) + `hoga/live` (backend)

## 배경

사용자 보고 (2026-05-27):
1. **시간축 분리** — 캔들 차트, 거래량, 호가 지표 3개 패널이 같은 visible range로 움직여야 하는데, 한 패널을 pan/zoom해도 나머지가 따라오지 않는다.
2. **과거 lazy fetch 부재** — 캔들을 과거로 스크롤하면 그 구간의 캔들·호가 지표를 fetch해야 하는데, 처음 로드된 범위 밖에서는 데이터가 채워지지 않는다.
3. **호가 지표 3개 비정상** — Quote Totals, 호가비(ratio), FillStrength 셋 다 "데이터는 있는데 값이 이상하게 나옴".

## 진단

현재 `/live`는 [`LiveCandlePane`](../../frontend/src/live/LiveCandlePane.tsx), [`LiveVolumePane`](../../frontend/src/live/LiveVolumePane.tsx), [`LiveIndicatorPane`](../../frontend/src/live/LiveIndicatorPane.tsx) **각각이 독립된 `createChart()` 인스턴스**를 만든다. 세 chart는 timeScale을 공유하지 않으므로 pan/zoom이 분리된다 — 문제 1의 근원.

`/api/live/candles`는 `code + timeframe`만 받고 KIS에서 고정 구간(intraday=오늘만, D/W/M=고정 lookback)을 가져온다. lazy fetch 인프라가 없다 — 문제 2의 근원.

`LiveIndicatorPane`은 SSE 이벤트의 t_ms를 **초 단위 그대로** plot한다 ([LiveIndicatorPane.tsx:152-187](../../frontend/src/live/LiveIndicatorPane.tsx#L152-L187)). 캔들은 분봉으로 bucket되어 있으므로 같은 차트에 올리면 x좌표 의미가 다르고, 분봉 단위로 보고 싶은 사용자에게 "초고밀도 잡음 띠"로 보인다 — 문제 3의 강력한 후보 원인.

코드베이스에는 이미 `/replay`가 사용하는 `PANE_SPECS` 레지스트리, `RangeSeriesPane`, projector(`QUOTE_TOTALS_SPEC` / `RATIO_SPEC` / `FILL_STRENGTH_SPEC`)가 있다. `/live`는 이 인프라를 우회해서 자체 구현을 갖고 있고, 이게 문제 1·3의 구조적 원인.

## Goals & Non-goals

**Goals**
- 캔들/거래량/호가 지표 3개 패널이 단일 timeScale을 공유한다. 한 곳에서 pan/zoom하면 모두 같이 움직인다.
- 사용자가 과거로 스크롤하면 캔들과 호가 지표(분봉에서만)의 과거 데이터가 lazy fetch된다.
- 호가 지표 3개가 timeframe에 맞게 bucket된 정상 값을 보여준다.
- `/live`가 `/replay`의 projector + 렌더 인프라(`RangeSeriesPane`, `PANE_SPECS`)를 그대로 재사용한다.

**Non-goals**
- `/replay` 페이지 코드 변경. ADR-0013 재검토는 별도 후속 spec(이번 spec의 마지막 섹션 참조).
- 신규 호가 지표 추가, 시각화 디자인 변경.
- 디스크에 캡쳐가 없는 stock-date의 과거 호가 데이터 복원 — 그런 구간은 차트에서 자연스럽게 비어 있음.
- D/W/M timeframe에서 호가 지표를 그리는 것 — Addendum 9.4 정책 유지.
- `/live`에서 Drawing(hline / trendline / pencil) 지원. ADR-0028 인프라가 `PANE_SPECS` 채택으로 잠재적으로 활성화될 수 있으나, `LiveChartRoot`는 `DrawingOverlay`를 mount하지 않는다. 필요해지면 별도 spec.

## 설계

### 1. Single chart + paneIndex 레이아웃

`LiveWorkarea` 내부의 세 분리된 pane 컴포넌트를 단일 `LiveChartRoot`로 합친다. 하나의 `createChart()` 인스턴스, 하나의 timeScale, 5개의 paneIndex.

```
LiveWorkarea
  └── LiveChartRoot
       (단일 createChart, 1개 timeScale)
       ├── paneIndex 0: candle (CANDLE_SPEC, stretch 3)
       ├── paneIndex 1: volume (VOLUME_SPEC, stretch 1)
       ├── paneIndex 2: Quote Totals (QUOTE_TOTALS_SPEC)
       ├── paneIndex 3: 호가비 (RATIO_SPEC)
       └── paneIndex 4: FillStrength (FILL_STRENGTH_SPEC)
```

`PANE_SPECS`는 그대로 사용. `RangeSeriesPane`도 그대로. projector도 그대로 — 단 입력 데이터를 `/live`가 만들어 넣어줘야 한다 (다음 절).

### 2. Wire 모델: RangeBundle 그대로 사용 (ADR-0013)

`/live`가 `RangeSeriesPane`에 넘기는 데이터 객체는 `/replay`와 정확히 같은 `RangeBundle`이다. 그래야 projector를 수정 없이 재사용할 수 있다.

필요 필드:
- `bundle.candles` — 캔들·거래량 원시 (volume은 캔들 row의 필드)
- `bundle.quote_ratio.points` — Quote Totals + 호가비 원시 (각 point에 `t`, `bid_total`, `ask_total`)
- `bundle.fill_strength.points` — 매수·매도 체결량 (각 point에 `t`, `buy_qty`, `sell_qty`)
- `bundle.bucket_ms` — 현재 timeframe에 해당하는 bucket 너비
- `bundle.segments[]` — `session_open_ms`, `session_close_ms`, `source` 등 세션 메타

`/live`는 두 종류의 RangeBundle을 머지해서 화면을 채운다:

1. **과거 RangeBundle** — 기존 `/api/range` 엔드포인트 그대로 호출. backend가 ADR-0013대로 bucket된 series를 반환. `sourcePreference` 토글이 `source_pref` 쿼리 파라미터로 전달됨 (ADR-0039).
2. **라이브 RangeBundle** — 오늘 자 SSE buffer + `/api/live/series` hydrate 결과를 **frontend에서** RangeBundle 모양으로 빌드 (신규 모듈 `frontend/src/live/buildLiveBundle.ts`). SSE는 raw event를 push하므로 매 push마다 frontend가 현재 timeframe의 bucket_ms로 재집계.

머지는 stock-date(=segment) 단위로 한다: 과거 RangeBundle의 segments + 라이브 RangeBundle의 today segment를 시간순 concat. projector는 머지된 RangeBundle 하나만 받는다.

**Today / Historical 경계 invariant** — `/api/range`는 promoted Parquet만 읽으므로 오늘 자는 18:00 promote 전엔 존재하지 않는다. 일관성을 위해 `/live`는 `/api/range`를 호출할 때 항상 `to_date = today - 1day`로 제한한다. 오늘 자는 항상 라이브 SSE에서만 온다. (이는 ADR-0038의 "/replay에서 오늘 날짜는 16:00~18:00 사이엔 못 본다 — 그 시간엔 /live에서 본다"와 정합.)

**VirtualAxis** — 머지된 segments에서 `createVirtualAxis(segments)`로 VirtualAxis 인스턴스를 만들어 `RangeSeriesPane`에 전달한다. `/replay`의 projector들이 모두 `axis.toVirtual()`를 호출하므로 필수. 라이브 today segment의 `session_close_ms`는 plan에서 결정 (default = 정규 15:30 KST; KRX Half-Day Session 감지는 별도 작업으로 보류).

### 3. Bucketing — 라이브는 frontend, 과거는 backend (같은 의미)

호가 지표의 bucket 의미는 `/replay`와 동일하다 — 차이는 *어디서* bucket하는가뿐. 이번 spec은 **혼합 모델**을 채택한다:

- **과거 데이터**(`/api/range` 응답): backend가 이미 bucket한 `quote_ratio.points` / `fill_strength.points`를 그대로 사용. ADR-0013 그대로.
- **라이브 데이터**(SSE buffer): frontend가 raw events를 받아서 매 push마다 timeframe의 `bucket_ms`로 재집계 (`buildLiveBundle`). SSE는 ~10초 cadence로 새 이벤트를 push하므로 매번 backend에 재bucket을 요청하는 건 비효율.

두 위치에서 같은 집계 규칙을 적용한다:

| 지표 | 데이터 성질 | bucket 집계 | 비고 |
|---|---|---|---|
| Quote Totals (ask_total, bid_total) | state | bucket의 마지막 snapshot | 캔들의 `close`와 같은 의미 |
| 호가비 (ratio) | state derived | Quote Totals close에서 `(ask−bid)/(ask+bid)` | projector가 자체 계산 (`RATIO_SPEC`의 기존 동작) |
| FillStrength (buy_qty, sell_qty) | flow | bucket 내 sum | 캔들의 `volume`과 같은 의미 |

**Bucket 라벨링**: `floor(t_ms / bucket_ms) * bucket_ms` (bucket 시작 시각). 캔들 `aggregateCandles.ts`와 동일 컨벤션. 같은 분봉의 candle/volume/호가가 x축에서 정확히 정렬.

**Empty bucket**: 그 t에 데이터가 없으면 `bundle.quote_ratio.points` 또는 `bundle.fill_strength.points`에서 해당 t를 생략. projector는 그 t를 자연스럽게 whitespace로 처리한다. **0으로 padding하지 않는다** (0과 "데이터 없음"은 의미가 다르다, ADR-0029와 같은 원칙).

**Timeframe 전환**:
- 라이브 데이터: 같은 SSE buffer에 새 `bucket_ms`로 재집계. 즉시 반영, 재요청 없음. 이 패턴은 `useLiveCandles`의 client-side 분봉 집계와 일관 ([liveCandles.ts:53-62](../../frontend/src/api/liveCandles.ts#L53-L62)).
- 과거 데이터: 새 `bucket_ms`를 query parameter로 `/api/range` 재요청. React Query 캐시 키에 `bucket_ms` 포함되므로 이전에 본 timeframe은 캐시 hit.

### 4. Historical lazy fetch

#### 4.1 Trigger

`chart.timeScale().subscribeVisibleTimeRangeChange((range) => …)`로 사용자의 visible range를 감시한다. visible range의 `from`이 현재 로드된 데이터의 가장 이른 t보다 prefetch margin 이상 앞으로 가면 historical fetch를 발사한다.

#### 4.2 데이터 소스

**데이터 소스 (모든 timeframe·모든 지표 공통, ADR-0039):**
- 오늘 자 라이브 데이터: KIS SSE / `/api/live/series` — source 토글 무관 (오늘 자는 정의상 `kis_live`만 존재).
- 과거 lazy fetch 데이터: `useSourcePreferenceStore`의 `sourcePreference` 토글을 따른다 (Settings의 "기본 데이터 소스" 옵션 — `'hogaplay'` 우선 vs `'kis_live'` 우선). 토글에 따라 `<data_dir>/parquet/{date}/{code}/{source}/`에서 promoted Parquet을 읽고, 선택된 source가 그 stock-date에 없으면 ADR-0039의 fallback 의미론대로 다른 source로 폴백.

**캔들 (모든 timeframe):**
- 분봉(`1m`–`30m`): 오늘 = KIS 1m + 클라이언트 분봉 집계 (기존 그대로). 과거 = 위의 source 토글에 따른 promoted capture에서 derive.
- `D` / `W` / `M`: KIS API lookback(90일 / 365일 / 5년) 내. 그 이상 과거는 lazy fetch하지 않음.

**호가 지표 (분봉에서만, Addendum 9.4):**
- 오늘: 기존 `/api/live/series` + SSE.
- 과거: 위의 source 토글에 따른 promoted capture에서 derive.
- `D` / `W` / `M`: 기존 정책 유지 — 패널 mount, 빈 series, `"라이브 지표는 분봉에서 표시됩니다"` 안내. lazy fetch 없음.

#### 4.3 백엔드 엔드포인트 — 기존 `/api/range` 재사용 (신규 엔드포인트 없음)

```
GET /api/range?code=<code>&from=<YYYYMMDD>&to=<YYYYMMDD>&bucket_ms=<ms>&source_pref=<pref>
```

- ADR-0013이 정한 기존 엔드포인트. 추가 백엔드 작업 없음.
- `source_pref`는 `useSourcePreferenceStore`의 `sourcePreference`를 그대로 전달 (ADR-0039 preference + fallback 의미론). `/live`도 같은 store를 구독한다.
- `bucket_ms`는 현재 timeframe의 ms (`TIMEFRAME_TO_MS[timeframe]`).
- 캡쳐가 없는 stock-date는 `excluded_dates`에 담겨 돌아온다 (ADR-0013). frontend는 그 구간을 자연스럽게 비운다.
- 분봉 timeframe에서만 호출 (D/W/M에서는 호출 안 함 — 기존 정책 유지).

#### 4.4 머지 정책

`buildLiveBundle`이 두 RangeBundle을 합칠 때:
- segment 단위로 concat: 과거 RangeBundle의 `segments[]` + 라이브 today segment.
- 라이브 today segment의 `candles` / `quote_ratio.points` / `fill_strength.points`는 SSE buffer를 현재 timeframe의 `bucket_ms`로 frontend bucket한 결과로 채운다.
- 같은 t의 bucket이 두 bundle에 모두 있는 경우는 실무상 발생하지 않는다 (오늘 자 promoted Parquet은 18:00 promote 후에야 존재하고, 그 시점엔 라이브 SSE 세션이 이미 종료된 다음 trading day의 영역). 다만 방어적으로 같은 t 중복 시 라이브 우선 (가장 최근에 본 진실).

### 5. 호가 지표 정상화 (문제 3)

이번 spec은 정상 동작 정의만 한다. root cause 확정은 plan/execute 단계에서.

**정상 동작 정의:**
- Quote Totals = bucket의 마지막 ob snapshot의 `ask_total` / `bid_total`. 단위: 주식수(int).
- 호가비 = bucket close의 `(ask_total − bid_total) / (ask_total + bid_total)`. 단위: 무차원, `[-1, +1]`. projector(`RATIO_SPEC`)가 이미 같은 계산을 수행한다.
- FillStrength = bucket 내 매수 체결량 sum / 매도 체결량 sum. 단위: 주식수. projector(`FILL_STRENGTH_SPEC`)가 이미 같은 모양으로 그린다.
- Auction Window(15:20–15:30): ADR-0029대로 whitespace.
- 데이터 없는 bucket: whitespace (0으로 padding 금지).

**디버깅 후보 (plan에서 검증):**
- (H1) 백엔드 SSE 페이로드의 필드명이 변경됐는데 frontend가 옛 이름(`total_ask_qty` 등)을 읽어 `numOr0`이 0 fallback. SSE event 1건 캡쳐해서 실제 키 확인.
- (H2) 현재 코드가 bucket 없이 초 단위 plot이라 분봉 차트에서 미세 잡음으로 보임 — 이번 spec의 bucket 도입으로 자동 해결.
- (H3) FillStrength의 `side === 1/-1` 매칭이 백엔드 데이터의 실제 enum(예: `'B'`/`'S'`, 또는 0/1)과 다름.

## 구현 단계 (Migration Strategy)

각 단계는 독립적으로 mergeable. step 1만 끝나도 문제 1이 해결된다.

**Step 1 — Single chart + projector 재사용 (문제 1 해결):**
- `LiveChartRoot.tsx` 신설. `PANE_SPECS` 기반 단일 chart, paneIndex 0~4에 series 부착.
- `buildLiveBundle.ts` 신설. 현재 SSE/REST 데이터를 `RangeBundle` 호환 모양으로 빌드 (bucketing 포함).
- `LiveCandlePane.tsx` / `LiveVolumePane.tsx` / `LiveIndicatorPane.tsx` 삭제. `LiveWorkarea`는 `LiveChartRoot` 하나만 렌더.
- 기존 test 파일들은 `LiveChartRoot.test.tsx`로 흡수 또는 재작성.

**Step 2 — Hoga indicator 디버깅 (문제 3 finalize):**
- step 1 후 차트가 분봉 bucket으로 렌더되므로 H2는 자동 해결.
- SSE 페이로드 실제 캡쳐 → H1·H3 검증, 매핑 정정.
- `buildLiveBundle.ts` 또는 그 helper에 unit test.

**Step 3 — Frontend historical lazy fetch wiring (문제 2):**
- 백엔드 작업 **없음** — `/api/range`가 이미 존재.
- `frontend/src/api/range.ts`의 `useRange` hook을 `/live`에서도 호출. `sourcePreference`는 같은 store에서 자동으로 옴.
- `LiveChartRoot`에서 `subscribeVisibleTimeRangeChange` 핸들러 — visible range가 과거로 확장되면 `useRange`의 `from`/`to`를 갱신.
- `buildLiveBundle`이 `useRange`의 RangeBundle + 라이브 buffer를 segment-concat 머지.

## 후속 작업 (별도 spec)

`/replay`까지 frontend bucket으로 통일하는 작업은 별도 spec에서 다룬다.

- ADR-0013 ("RangeBundle single read path")이 백엔드 bucket을 architectural 결정으로 명문화하고 있으므로 그 ADR 재검토부터 시작.
- 이번 spec의 `buildLiveBundle` + bucket 함수가 `/replay`에서도 입력 데이터만 다르고 같은 모양으로 동작하도록 설계되어 있어서, 통일 작업은 주로 *백엔드의 bucket 코드를 제거하고 wire payload에 raw events를 싣는* 변경 + `/replay` 쪽 fetch hook을 `buildLiveBundle` 호출로 교체하는 작업이 된다.
- 통일이 끝나면 `/live`와 `/replay`가 동일한 frontend 데이터 빌드 코드와 동일한 projector를 공유.

## 테스트

- 단위 테스트: `buildLiveBundle.test.ts` (bucketing 정확성, 머지 정책, empty bucket 처리), `LiveChartRoot.test.tsx` (paneIndex 부착·timeframe 전환).
- 백엔드 테스트: 신규 백엔드 코드 없음 — 기존 `/api/range` 테스트 그대로 유효.
- 회귀 테스트: 기존 `LiveCandlePane.test.tsx`, `LiveVolumePane`(파일 없음), `LiveIndicatorPane.test.tsx`는 삭제 또는 `LiveChartRoot.test.tsx`로 흡수.
- 수동 QA (`localhost:5173/live`):
  1. 페이지 로드 → 캔들/거래량/호가 3개 패널 함께 표시.
  2. timeframe 1m → 5m → 30m 전환 → 호가 3개 패널이 분봉 단위로 bucket된 값으로 즉시 변경.
  3. 캔들 차트를 왼쪽으로 드래그 → 모든 패널이 함께 이동, 과거 구간에 데이터가 채워짐.
  4. D/W/M 전환 → 호가 3개 패널이 비고 안내 문구 표시.
  5. 캡쳐 없는 과거 stock-date로 스크롤 → 캔들·호가 모두 자연스럽게 비어 있음.

## 도메인 용어 점검

이 문서는 다음 CONTEXT.md 용어를 사용한다 (다른 표현 사용 금지):
- **Stock-Date** (capture 단위)
- **Regular Session** (09:00–15:30)
- **Auction Window** (15:20–15:30)
- **Quote Totals**, **호가비**, **FillStrength** (CONTEXT.md "Hoga Indicators")
- **Auction Mask** — ADR-0029 정책. 이번 spec은 그 정책을 깨지 않는다.
