# Changelog

All notable changes to this project are documented here.
The format follows a 4-digit `MAJOR.MINOR.PATCH.MICRO` scheme.

## [0.4.1.0] - 2026-06-03

### Added
- `/live` 캔들 호버 툴팁의 **시·고·저·종 각 행에 등락률(%)** 을 가격 옆에 함께
  표시합니다. 각 %는 직전 봉(이전 캔들) 종가 대비이며 상승은 빨강·하락은 파랑으로
  색칠됩니다(분/일/주/월 모두 동일 기준). 직전대비 행은 금액(원)만 남기고, 미세
  변동이 반올림으로 `+0.00%`가 되면 색도 중립으로 맞춥니다.

## [0.4.0.0] - 2026-06-03

### Added
- 스크리너 일봉 수정주가가 이제 KIS 정확 계수로 정합화됩니다(ADR-0057). 수정주가 =
  원주가(SSOT, append-only) × KIS 계수 테이블(`factors.parquet`)로 파생되어, 액면분할
  종목의 과거 봉이 today-basis로 정확히 소급 보정됩니다(거래량은 ÷계수로 거래대금 보존).
- `hoga screener-backfill` CLI — 1회성 백필: KIS 수정주가로 `factors.parquet`를 구축하고
  (resumable), 원주가를 KIS와 대조·결측 보충하며(reconcile), 구·신 수정주가 차이를
  `impact-report.json`으로 요약합니다.

### Fixed
- 액면분할 종목의 약 64%가 미보정이던 수정주가 버그(로컬 ±3% 휴리스틱이 카카오·삼성전자우
  등을 통째로 놓침)를 KIS 정확 계수 적용으로 복구. 절대 가격 레벨을 쓰는
  신고가·신고거래량·이동평균·등락률 스크리너 조건이 이제 올바른 값으로 평가됩니다.
- 가격대별 거래량 프로파일에서 상단 경계 빈이 누락되던 off-by-one과 상한가(폭 0) 종목에서
  발생하던 0-나눗셈 500 오류 수정.

### Changed
- 거래량 프로파일·호가비율·체결강도 SQL을 `tables/{candles,trades,snapshots}` 모듈로
  추출(ADR-0001). `bundle`은 경로·결측 가드·시간 재기준만 담당하는 코디네이터로 축소.

## [0.3.10.0] - 2026-06-03

### Added
- `/live` 차트에서 **캔들에 마우스를 올리면 그 봉의 정보를 툴팁으로 표시**합니다 —
  시·고·저·종, 직전 봉 대비 변동(금액·%), 거래량, 직전봉 거래량비(같으면 100%). 캔들(가격)
  페인 위에서만 뜨고 차트를 벗어나면 사라지며, 라이브 갱신 중에도 호버한 봉의 값이 실시간으로
  바뀝니다. 분/일/주/월 전 구간 동작하고, 설정에서 켜고 끌 수 있습니다(기본 켜짐). 등락 기준은
  앱의 등락률(전일 종가)과 달리 **직전 봉 대비**로 통일했습니다(ADR-0059).

## [0.3.9.0] - 2026-06-03

### Internal
- 종목 검색 코드 정리(동작·결과 불변). 프론트 `filterSymbols()` 정렬이 비교마다
  `toLowerCase()`를 재계산하던 것을 종목명당 1회 사전계산으로 바꿔 백엔드 `search()`의
  `key=` 의미와 일치시켰습니다. 백엔드 `search()` docstring의 'code-prefix' 오기재를
  'name-prefix'로 정정(정렬은 종목명 접두사 기준).

## [0.3.8.0] - 2026-06-03

### Changed
- 종목 검색이 **영문 대소문자를 구분하지 않습니다.** 예전엔 `CJ`·`KTcs`·`S-Oil`처럼
  영문이 섞인 종목명을 찾으려면 케이스를 정확히 맞춰야 했지만(`cj`로는 `CJ`가 안 나옴),
  이제 `cj`/`ktcs`/`s-oil` 어떤 케이스로 입력해도 매칭됩니다. 한글 종목명 검색과 숫자
  코드 검색 동작은 그대로이며, 백엔드 `/api/symbols`와 프론트 클라이언트 필터에 동시
  적용됩니다.

## [0.3.7.0] - 2026-06-03

### Changed
- `/live` 분봉 차트를 **왼쪽으로 끌어 과거 데이터를 부를 때** 빠르고 부드러워졌습니다.
  예전엔 줌과 무관하게 항상 42일치(~28거래일)를 한 번에 새로 받아 **한 번 끌 때마다
  ~32초** 멈췄습니다. 이제 **고정 3거래일씩 점진적으로** 받아 화면이 찰 때까지 채웁니다:
  어떤 줌이든 **첫 그림이 ~3.4초 안에** 보이고(latency cap), 넓은 구간은 3거래일씩
  여러 번에 걸쳐 채워집니다. 한 번 본 범위 재방문은 디스크 캐시로 즉시. 일/주/월봉은
  기존 one-shot 유지. (ADR-0059)

### Internal
- `/live` 좌측 팬 backfill + viewport 보존(prepend-restore shift, 진행 settle-loop,
  lazy-fetch trigger)을 `LiveChartRoot`에서 headless `useViewportBackfill` 훅으로 추출.
  동작 불변, locality 향상. 종료 판정·스텝 크기는 순수 함수(`planFillStep`/`stepChunkDays`)로
  격리 단위 테스트.

## [0.3.6.0] - 2026-06-03

### Fixed
- 차트 데이터 무결성: parser가 archive한 **series-level invariant 위반**(예
  `series.candles_ts_monotonic` — 캔들 `ts_ms` 중복으로 lightweight-charts `setData`가
  터지는 직접 원인)이 read-path에서 무시되던 결함을 고쳤습니다. 이제
  `classify_from_meta`가 `meta.json`의 archived `series.*` error를 INVALID 판정에
  반영해, 해당 Stock-Date를 `build_range_bundle`이 차트에 내보내지 않습니다. meta
  invariant는 여전히 live 재평가, series는 archived만 union(double-count 방지),
  parquet 재로드 없음(ADR-0020 §4.6 amendment). 수정 이전 archive의 false-positive는
  `hoga validate --fix` 1회로 정리.

## [0.3.5.0] - 2026-06-03

### Changed
- (내부 리팩터, 동작 변화 없음) `/api/live/past-daily-candles`(일봉)와
  `/api/live/past-investor-net`(투자자 순매수)의 near-verbatim 중복 핸들러를
  `batched_daily_walkback` 공유 orchestrator로 통합했습니다. 두 핸들러는 fetch
  클로저 + output key만 제공하는 얇은 adapter가 되고, gap/cache/today/dedupe 조립은
  한 곳에서 격리 단위 테스트됩니다. KIS 일별 walk-back의 커서 감산은
  `_prev_day_yyyymmdd` 공유 헬퍼로 추출(ADR-0060).

### Notes
- ADR-0061: source resolver 4개는 서로 다른 질문(데이터 읽기·inventory 표시·완성도
  state·존재 여부)에 답하므로 통합 거부 — 통합은 shallow abstraction이 된다는 근거 기록.

## [0.3.4.0] - 2026-06-03

### Fixed
- `/live` 보조지표 중 **호가비·호가총합·체결강도**가 마감 직전 종가 동시호가
  (15:20~15:30) 데이터를 계산에 끌어들이던 문제를 고쳤습니다. 15:20이 버킷 경계가
  아닌 타임프레임(3·15·30분봉)에서, 15:20을 가로지르는 버킷(예: 3분봉 15:18 봉)이
  대표값으로 15:20 동시호가 호가창을 집어 마감 직전 값이 튀었습니다. 이제 그런
  버킷은 **15:20 직전 마지막 호가 스냅샷**으로 계산되어 정확한 값으로 표시됩니다.
  과거 날짜(`/api/range`)와 당일 실시간(SSE) 양쪽 모두 적용되며, 반장일은 백엔드가
  그날의 실제 마감 시각을 기준으로 처리합니다. (ADR-0029 개정)

## [0.3.3.0] - 2026-06-03

### Changed
- 인벤토리 상세 테이블의 `Captures`(평생 누적 캡처 횟수 `×N`) 컬럼을 `재시도`
  (`fail_streak`) 컬럼으로 교체했습니다. 이제 각 종목·날짜가 차단(5회 연속 실패)까지
  얼마나 남았는지 한눈에 보입니다 — 정상은 `—`, 1~4회는 `N/5`, 차단되면 `차단됨`.
  평생 누적 `×N` 표시는 캡처 큐 화면에 그대로 유지됩니다.

## [0.3.2.0] - 2026-06-03

### Changed
- 스크리너 결과의 현재가·등락률을 전 종목 실시간(라이브)으로 표시합니다. 이전에는
  우측 패널이 상위 30종목만 라이브였고 `/screener` 전체 페이지는 전부 어제 종가
  기준이었는데, 이제 관심종목과 동일하게 모든 행이 현재가 기준으로 갱신됩니다.

### Fixed
- 장 시작 전·시세 파싱 실패 시 스크리너 등락률이 "어제 종가 기준값"으로 잘못
  표시되던 문제를 고쳤습니다. 이제 관심종목과 동일하게 "—"로 표시됩니다.

## [0.3.1.0] - 2026-06-03

### Fixed
- 완성 불가능한 종목-날짜의 무한 재캡처를 차단합니다. hogaplay 데이터가 장중에
  끊겨 매번 불완전하게 끝나는 (종목, 날짜)는 이제 5회 연속 실패로 집계되어 차단되고,
  인벤토리에 "차단됨 (5/5)" 배지와 "잠금 해제" 버튼이 표시됩니다. 이전에는 이런
  캡처가 매번 "성공(done)"으로 처리돼 재시도 카운터(fail_streak)가 리셋됐고,
  "모두 재캡처" 버튼을 누를 때마다 외부 서버에 무한히 요청이 나갔습니다
  (한진칼 2026-06-01에서 ×16 관측). 판정 기준은 인벤토리의 ✓(완전) 여부와 동일합니다.
- 데일리/캐치업 스케줄러가 차단된 관심종목 날짜를 조용히 건너뛰지 않고 경고 로그로
  알립니다 — 무인 캡처에서 빠진 날짜를 운영자가 바로 인지할 수 있습니다.

## [0.3.0.0] - 2026-06-02

### Added
- 관심종목 패널 드래그 재정렬. 우측 레일의 관심종목을 마우스로 끌어 순서를 바꿀 수 있습니다.
  행을 8px 이상 끌면 재정렬, 그 미만은 기존처럼 클릭(차트 점프)으로 처리돼 두 동작이
  충돌하지 않습니다. 드롭 즉시 화면이 새 순서로 바뀌고(낙관적 갱신, 실패 시 롤백)
  `PUT /api/watchlist/order`로 서버에 영속됩니다 — 순서는 전역이라 전체 페이지 목록과
  `catchup_all` 순회에도 반영됩니다. 서버 재정렬은 stale 코드에 관용적입니다(모르는 코드는
  무시, 언급 안 된 항목은 기존 순서로 뒤에 보존). 공유 `QuoteRow`는 선택적 drag props만
  받아 스크리너 패널은 영향이 없으며, 실제 포인터 드래그는 Playwright e2e로 검증합니다
  (ADR-0057 · ADR-0058).

## [0.2.0.0] - 2026-05-31

### Added
- 외국인·기관 순매수량 일봉 지표. `/live`의 일봉(D) 차트에 외국인/기관 순매수 수량을
  별도 패널로 그립니다 — 순매수(양수)·순매도(음수)를 부호 색으로 구분하고, 장기 구간은
  KIS 종목별 일별동향(FHPTJ04160001)의 date-cursor walk-back으로 채웁니다 (ADR-0055).
- Pane Legend 오버레이. 각 패널(캔들 이동평균, 거래량, 투자자 순매수) 위에 커서 시점의
  값을 실시간으로 표시합니다. 행의 ✕ 버튼으로 해당 지표를 끄고, eye 버튼으로 선을 숨길
  수 있으며, 지표 팝오버에서 각 지표의 상세 패널로 바로 이동합니다.
- 거래량 패널 on/off 토글과 이동평균 숨김(hide) 기능. 끈 패널은 차트에서 제거되어
  세로 공간을 돌려줍니다.

### Fixed
- 일/주/월봉에서 캔들을 호버할 때 `/api/brokers/series`로 불필요한 조회가 나가던 문제.
  커서 기반 브로커 조회를 분봉에서만 동작하도록 게이트했습니다 (ADR-0044 — 분봉 외에는
  per-cursor parquet가 없음). 사이드바의 spot 표시 게이트는 화면 표시만 막았을 뿐
  조회 자체는 막지 못했습니다.
- 거래량을 끄면 패널 자체가 사라지도록 수정 (투자자 패널과 동작 일치).
- 패널 인덱스가 밀려 series가 재생성될 때 데이터가 다시 채워지지 않던 문제.

## [0.1.1.0] - 2026-05-31

### Removed
- The off-hours `/live` banner ("장 외 시간 — 09:00 KST에 폴링이 시작됩니다"). Live
  polling is gated server-side by the trading-hours window (`poller.py:_should_poll_now`),
  so the banner never affected capture — it was only an always-on row outside market
  hours. The chart reclaims that vertical space when the market is closed. The status
  bar `LIVE●` reflects socket liveness, not market phase, so it stays green off-hours.

### Fixed
- Capture queue detail rows rendered an invalid clock (e.g. "31:13:21") for timestamps
  in the KST 00:00–08:59 window. The detail formatter now reuses the shared
  `unixMsToKSTClock` helper, which wraps the hour correctly.

### Changed
- Retired the now-dead minute-tick machinery behind the live banner state (the
  per-minute re-render timer and the KST-hour computation); no remaining banner cause
  depends on the wall clock.

## [0.1.0.0] - 2026-05-31

First versioned release. Captures the `feat+frontend5` work since the previous
merge to `main` (120 commits): the real-time `/live` experience, the watchlist
and Right Rail shell, and a pass of architecture-review refactors.

### Added
- **Single multiplexed WebSocket** for the frontend (ADR-0053): one `/api/ws`
  endpoint fans out both events and live snapshots, code-filtered, with
  automatic reconnect and a liveness watchdog that force-reconnects a silently
  dead socket. Honest connection-state surface (LIVE / stale chip + status dot).
- **Live chart**: adaptive KST x-axis via `createChartEx`, and viewport scale +
  position preserved across historical-prepend (no jump when older bars load).
- **Watchlist + Right Rail**: global rail chrome and Watchlist Panel mounted in
  the shell grid; active-symbol heart toggle; the live poller re-syncs to the
  watchlist immediately on add/remove (stops on empty, preserves the buffer).
- **Symbol search**: header inline search (`/` to focus) and a headless
  `useSymbolCombobox` hook (keyboard nav, highlight, dismiss-on-outside-click).
- **Page shell**: thin `PageContainer` frame with tokenized page padding;
  `--tint-success-border` / `--tint-error-border` design tokens.

### Changed
- Typed the live SSE/WebSocket payload contract end-to-end and the poller's
  `LiveSnapshot` builders; narrowed chart `SeriesSpec`/projector return types off
  `any` to the lightweight-charts vocabulary.
- Single-sourced duplicated domain rules: the Unix-ms → YYYYMMDD KST calendar-day
  conversion (`util/time`), the `first_*.tsv` page-layout contract
  (`collector/orchestrator`), and the Closing Auction Window length.
- Lifted inventory grouping + default-to-first policy to the page (`selectGroup`);
  extracted a single `FullCaptureCountBadge`; replaced the Optional timing
  collector with a `NullTimingCollector`.
- Adopted `PageContainer` across the capture, inventory, and watchlist pages;
  consolidated the capture-queue push subscription to a single owner.

### Fixed
- `candles.write_parquet` now writes atomically like its sibling tables (closes a
  torn-write window on the hot read-path parquet).
- `disk_state.classify_stock_date` returns the full `Classification`, dropping a
  second `meta.json` read on the hot decide-capture path.
- Corrected the Daily Scheduler fire-time docs (18:00 → 17:00 KST) and the false
  "drift caught by TypeScript" claim on the by-hand BE↔FE wire mirror (added a
  schema-diff guard test instead).
