# Changelog

All notable changes to this project are documented here.
The format follows a 4-digit `MAJOR.MINOR.PATCH.MICRO` scheme.

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
