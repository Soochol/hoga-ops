# KIS REST Bypass Design

## Goal

When KIS REST becomes unreachable, the live chart should stop repeatedly calling KIS and let the user switch to stored-data fallback from either a toast or Settings.

## Architecture

Add a persisted frontend store for `kisRestBypassEnabled`. The live/study candle query layer consumes that store so KIS REST candle queries are disabled when bypass is on, while `useLiveBundle` forces the existing `/api/range` candle fallback path. A toast host observes KIS REST transport/unavailable warnings from the live bundle path and exposes the same toggle used in Settings.

## UX

Copy uses "KIS 연결 불가" rather than "점검중" because transport errors do not prove maintenance. The toast appears at most once per cooldown window and says stored data can be used. The switch label is "KIS API 우회"; ON means KIS REST candle calls are skipped and stored data is used.

## Components

- `frontend/src/state/kisRestMode.ts`: persisted zustand store with bypass flag and failure notification timestamp.
- `frontend/src/live/KisRestUnavailableToastHost.tsx`: global toast with shared toggle.
- `frontend/src/live/LiveSettingsSections.tsx`: Settings > 데이터소스 row for the same toggle.
- `frontend/src/live/useLiveBundle.ts`: disables KIS candle queries via wrappers and forces fallback while bypass is enabled.
- `frontend/src/studyViews/useStudyReferenceBundle.ts`: disables study KIS minute/daily candle queries when bypass is enabled and falls back to `/api/range` where available.

## Error Handling

Initial detection uses `pastDataWarnings` reasons that indicate KIS REST trouble: `kis_transport_error`, `kis_rest_unavailable`, `kis_api_error`, `kis_rate_limit`, and `rate_limit_aborted`. The current backend often emits `kis_api_error` with `TRANSPORT/...` in `msg`; the host treats that as KIS REST unavailable.

## Tests

Add focused unit tests for the store, toast toggle, Settings toggle, and live bundle query gating/fallback. Existing backend warning behavior remains covered by `tests/unit/live/test_api.py`.
