# KIS REST Policy Centralization and Stored-Data Fallback Design

**Date**: 2026-07-04
**Status**: Draft
**Scope**: `hoga/live/*`, `hoga/api/models.py`, `hoga/api/screener*.py`, `frontend/src/api/liveSettings.ts`, `frontend/src/live/*`, `frontend/src/studyViews/*`, `frontend/src/state/kisRestMode.ts`

## Problem

KIS REST 장애 또는 점검 중에 사용자가 `KIS API 우회`를 켜도 백엔드가 계속 KIS REST를 호출한다.

The first bypass implementation made the setting a frontend localStorage flag. That only affected selected live/study candle hooks. Backend-owned KIS REST producers still run:

- `Rest30sRecorder`: persistent REST 30s orderbook/trade/broker capture.
- `LiveRestPoller`: viewed-code display poller.
- `/api/live/quotes` and `/api/live/tab-metrics`: quote fetches.
- `/api/live/past-candles` and `/api/live/past-daily-candles`: foreground candle backfill.
- program-trade, investor, index, screener, and other KIS REST endpoints.

This creates two user-visible failures:

1. The log keeps printing KIS transport errors after the user turns bypass ON.
2. Some chart paths, especially study views, stop KIS candle queries but do not have an equivalent stored-data fallback, so candles can disappear.

## Current State

KIS candle storage is split:

| Data | Current persistence | Read path |
|------|---------------------|-----------|
| KIS minute candles | disk JSON cache under `<data_dir>/kis-past-candles/...` | `/api/live/past-candles` only |
| KIS daily candles | memory-only cache | `/api/live/past-daily-candles` only |
| hogaplay / kis_live / kis_api source data | parquet under `<data_dir>/parquet/...` | `/api/range` |
| screener daily candles | screener parquet | `/api/live/screener-daily-candles` |

`/api/range` is the stable stored-data read path, but it does not read the KIS minute JSON cache or the KIS daily memory cache. Live has partial fallback logic; study has weaker fallback logic.

## Goals

- Make `KIS API 우회` a backend-authoritative setting, not a browser-only flag.
- When bypass is ON, no KIS REST data request is attempted through KIS REST Access or legacy data-fetch seams.
- Keep already-stored data visible where possible.
- Make live and study fallback behavior consistent enough that bypass does not blank charts unnecessarily.
- Keep the first implementation smaller than full KIS candle parquet integration.
- Preserve existing storage policy semantics: `ws_only`, `ws_plus_rest`, `rest_only`.

## Non-Goals

- Do not migrate KIS minute JSON cache into parquet in this spec.
- Do not persist KIS daily candles to disk in this spec.
- Do not remove `/api/live/past-candles` or `/api/live/past-daily-candles` in this spec.
- Do not redesign source preference UI.
- Do not make screener manual updates bypassable unless they pass through the common KIS REST guard.
- Do not call transport failures "점검중"; the UI copy remains "KIS 연결 불가" unless KIS returns a clear maintenance code.

## Decision

Introduce a backend setting:

```json
{
  "schema_version": 1,
  "storage_policy": "ws_plus_rest",
  "program_trade_storage_enabled": false,
  "kis_rest_bypass_enabled": false
}
```

This field is persisted in `<data_dir>/live_settings.json`. Default is `false`; when the user turns it on from the toast or Settings, it remains on across app restart until the user explicitly turns it off.

All user-visible toggles control this backend setting. The old frontend localStorage store becomes a toast/notification helper only, or is retired after migration.

Add a central KIS REST policy guard at the shared KIS REST access boundary. When `kis_rest_bypass_enabled` is true for the current `data_dir`, `kis_access.run_with_capacity(...)` rejects or skips requests before selecting an account or touching `KisClient`.

Runtime loops stop cleanly when bypass is ON so they do not repeatedly enqueue blocked work:

- `Rest30sRecorder`: stop and clear targets.
- `ProgramTradeCollector`: stop.
- `LiveRestPoller`: stop or do not create.
- Quotes/tab metrics/investor/index endpoints: return empty or cached responses with a bypass warning instead of calling KIS.
- Candle backfill endpoints: return cache-only data plus bypass warnings.

## User Model

`KIS API 우회` ON means:

```text
KIS REST 데이터 호출 금지
저장된 데이터만 사용
데이터가 없으면 빈 차트/빈 값 + 경고
```

It does not mean:

```text
WebSocket capture is disabled
hogaplay data is disabled
stored KIS data is deleted
KIS daily/screener corpus is refreshed
```

KIS WebSocket live capture and the approval-key request needed to establish a KIS WS connection are not part of this setting unless a future design explicitly adds `kis_all_bypass_enabled`.

## Detailed Design

### Backend settings

Update:

- `hoga/api/models.py`
- `hoga/live/settings.py`
- `hoga/live/api.py`
- `frontend/src/api/liveSettings.ts`

`LiveSettingsUpdate` allows partial patches so the frontend can toggle one field without resending all fields:

```python
class LiveSettingsUpdate(BaseModel):
    storage_policy: LiveStoragePolicy | None = None
    program_trade_storage_enabled: bool | None = None
    kis_rest_bypass_enabled: bool | None = None
```

`update_live_settings` preserves omitted fields. If `storage_policy == "ws_only"`, `program_trade_storage_enabled` still normalizes to `False`. `kis_rest_bypass_enabled` is independent of `storage_policy`.

Bypass is a runtime execution override, not a storage-policy rewrite. If `storage_policy="rest_only"` and `kis_rest_bypass_enabled=true`, the persisted storage policy remains `rest_only`, but REST storage loops stay stopped until bypass is turned off. This lets the user resume the original storage intent by toggling bypass OFF.

`PATCH /api/live/settings` continues to call `refresh_live_stream(data_dir=...)` so runtime loops react immediately.

### Central KIS REST guard

Add a small policy helper:

```python
def kis_rest_bypass_enabled(data_dir: Path) -> bool:
    return load_live_settings(data_dir).kis_rest_bypass_enabled
```

`kis_access.run_with_capacity(...)` checks this before scheduler submission and before legacy `fetch_for_role(...)`.

The guard covers KIS REST data requests, not KIS WebSocket approval-key issuance. `KisClient.get_approval_key()` remains usable for WS live capture unless a later design introduces a separate all-KIS shutdown setting.

Introduce a typed exception:

```python
class KisRestBypassedError(KisApiError):
    msg_cd = "KIS_REST_BYPASSED"
```

Callers that already convert `KisApiError` to `data_warnings` surface it naturally. Loops that log per-code failures avoid warning spam by stopping at lifecycle/storage-runtime level before reaching the guard.

Transition rule: after `PATCH /api/live/settings` persists `kis_rest_bypass_enabled=true` and refreshes live runtime, no new KIS REST data request may be submitted. In-flight requests that started before the setting flipped are not force-aborted at the socket level; long-running writers re-check the setting before cache/disk writes and skip persistence if bypass is now ON. Stopping supervisor loops remains the primary spam prevention mechanism.

### Runtime loop behavior

`storage_runtime.sync_storage_runtime(...)`:

- If bypass ON, set `kis_api_targets=()`.
- Stop existing `rest30_recorder`.
- Stop existing `program_trade_collector`.
- Return a snapshot showing no active KIS API targets.

`lifecycle._ensure_poller(...)` and `refresh_live_stream(...)`:

- If bypass ON, do not create `LiveRestPoller`.
- If an existing poller exists and settings flip ON, stop it and clear `_state.rest_poller`.
- `on_view_subscribe` remains a no-op when poller is absent.

`get_status()` exposes the bypass setting through `LiveStatus`, so the frontend can show a consistent state without depending only on `/settings`.

`LiveStatus` distinguishes intentional bypass from failure health. Bypass ON should not mark REST supervisors as degraded by itself; status projection renders it as `KIS API 저장 일시중지` / `KIS REST 우회 중`, while real supervisor failures remain `REST Supervisor Degraded`.

### Endpoint behavior

Endpoints do not call KIS REST when bypass is ON:

| Endpoint / component | Bypass ON behavior |
|----------------------|-------------------|
| `/api/live/past-candles` | Read only `PastCandlesCache`; do not fetch misses; return warning per missing date. |
| `/api/live/past-daily-candles` | Read only `PastDailyCandlesCache`; do not fetch gaps; return warning per missing batch. |
| `/api/live/quotes` | Return process-memory last-good quotes marked stale when available; otherwise return empty quotes; include no transport log. |
| `/api/live/tab-metrics` | Use buffer-derived hoga metrics; quote-derived fields are null while bypass is ON. |
| `/api/live/investor-trend-estimate` | Return an error response with reason `kis_rest_bypassed`. |
| index/investor/screener scheduled KIS calls | Block at `kis_access.run_with_capacity`; caller handles as skipped/error according to its existing contract. |

Candle warnings:

```json
{
  "reason": "kis_rest_bypassed",
  "msg": "KIS REST bypass is enabled; served cache-only data"
}
```

For minute candles, include `date` when the missing unit is a date. For daily candles, include `batch` when the missing unit is a batch.

Cache misses while bypass is ON are not new failure events. If the user pans left and a requested date is absent from `PastCandlesCache`, the endpoint returns the dates it can serve and emits one `kis_rest_bypassed` warning for the missing date. It does not call KIS and does not trigger another toast. The chart keeps rendering available stored data and the UI-level state remains `저장 데이터만 표시 중`.

Quote responses while bypass is ON reuse `LiveQuoteFetcher`'s existing process-memory `_last_quotes` cache. Add a wire flag to stale rows:

```python
class LiveQuote(BaseModel):
    ...
    stale: bool = False
    stale_reason: str | None = None
```

If a last-good quote exists, `/api/live/quotes` returns it with `stale=true` and `stale_reason="kis_rest_bypassed"`. If no last-good quote exists, it returns `quotes=[]` with no KIS call. Frontend row renderers label stale quotes as `이전값` or `저장값`, and tooltip copy says `KIS REST 우회 중이라 마지막 수신값입니다.` Browser tab title and other compact surfaces must not present stale quote values as current truth.

Stale Live Quote values are display-only. `/api/live/tab-metrics` must not use stale quote rows for ranking, tab status, or decision-like summary fields. While bypass is ON it keeps LiveBuffer-derived hoga fields where available and sets quote-derived fields such as `change_pct` to `null`.

Screener `basis="intraday"` also treats stale quotes as unavailable for condition evaluation. When bypass is ON, intraday overlay construction is skipped, the scan evaluates against the EOD corpus, and the response includes `kis_rest_bypassed_intraday_overlay_skipped`. This keeps display fallback separate from filter correctness.

Representative Index surfaces are cache-only while bypass is ON. `/api/live/index-candles` reads existing index candle caches and does not fetch missing windows. `/api/live/index-investor-net` returns an empty/error response with reason `kis_rest_bypassed`. Index sector intraday overlays skip KIS quote overlay construction and fall back to the daily corpus. If no cached index candles exist, the chart shows an empty stored-data state rather than attempting KIS.

### Candle cache-only serving

`LiveMinuteCandleBackfill.collect_minute(...)` supports a cache-only mode:

- Past dates: read `PastCandlesCache.get_past(...)`.
- Today: read `PastCandlesCache.get_today_tri(...)`.
- Do not call `_fetch_past_shared(...)` or `kis_access.run_with_capacity(...)`.
- Return cached candles and warnings for misses.

`LiveDailyCandleBackfill.collect_daily(...)` supports a cache-only mode:

- Reuse `PastDailyCandlesCache.list_batches(...)` and `get_today(...)`.
- Compute gaps with the existing batch/gap logic.
- Return cached candles and warnings for uncovered gaps.
- Do not call `fetch_batch`.

This preserves cached KIS candles while obeying the no-external-call rule.

### Frontend settings and toast

The Settings toggle and toast switch call `patchLiveSettings({ kis_rest_bypass_enabled: next })`.

Frontend store changes:

- `useKisRestModeStore` keeps failure notification timestamps.
- Bypass truth comes from `useLiveSettings()` or hydrated query data.
- Legacy localStorage migration is explicit: if `chart.kisRestMode.v1` contains `true` and the backend setting is still `false`, the app patches the backend to `true` once and then treats the backend as the source of truth. If the backend is already `true`, nothing changes. If localStorage is `false`, it does not force the backend off.

Settings copy:

- Label: `KIS API 우회`
- Description: `KIS REST 연결이 불안정할 때 외부 호출을 멈추고 저장 데이터만 사용합니다.`

Toast copy:

- Title: `KIS 연결 불가`
- Body: `저장된 데이터로 볼 수 있습니다. 우회를 켜면 KIS REST 호출을 멈춥니다.`

After the user turns bypass ON, the UI treats bypass as an intentional paused state rather than an ongoing error:

- Settings/status label: `KIS REST 우회 중`
- Live-storage status: `KIS API 저장 일시중지`
- Chart warning: `저장 데이터만 표시 중`

The connection-failure toast is for detection and action. Once bypass is ON, repeated KIS transport errors should not continue to surface as fresh failure toasts.

When the user turns bypass OFF, the frontend invalidates the currently visible live/study queries. Normal endpoints may then fetch only the misses needed for the current view and write those caches as before. The app does not bulk-refill every date that produced a bypass warning while bypass was ON.

### Live/study fallback alignment

Live:

- Do not tie screener daily query enablement to KIS REST bypass. Screener daily is local parquet read.
- Continue using `/api/range` full-mode fallback for minute and D where available.
- When bypass ON and cache-only past-candle endpoints return warnings, show the existing loading/warning UI as stored-data fallback, not as indefinite loading.

Study:

- Add a `rangeCandles` query using `/api/range?mode=full` for minute views.
- Use `rangeCandles.candles` as fallback when KIS minute candles are unavailable or bypassed.
- For D/W/M, add screener daily fallback where available.
- Avoid disabling the whole candle query layer just because bypass is ON. Prefer cache-only endpoint responses plus local fallback.

This makes study behave closer to live: KIS fresh fetch can be blocked, but existing data remains usable.

For stock D/W/M candles, KIS daily memory cache is allowed when present, but it is not reliable across restart. If KIS daily cache misses while bypass is ON, live and study use screener daily candles as the stored-data fallback. This fallback applies only to stock **Code** charts; **Representative Index** charts use their own index caches and do not borrow screener daily candles.

Minute fallback through `/api/range?mode=full` preserves the current **Source Preference**. Bypass does not hide already-written `kis_api` parquet. For example, with `hogaplay 우선` and bypass ON, range fallback still tries `hogaplay → kis_live → kis_api`; a Stock-Date is empty only when none of those stored Sources exists.

Study fallback uses the same rule. It must not treat bypass as a strict source filter, and it must not disable local `/api/range` or screener-daily reads merely because those stored artifacts originally came from KIS.

### Toast and Migration Rules

KIS failure detection remains evidence-based:

- Transport/auth/rate-limit failures can trigger `KIS 연결 불가`.
- Do not label a failure as `점검중` unless KIS returns an explicit maintenance code/message.
- Once bypass is ON, suppress repeated failure toasts for blocked KIS REST paths.
- Cache misses under bypass are not toast-worthy failures.

Legacy frontend localStorage migration is one-way and bounded. If the old local flag is `true`, patch the backend to `true` once for the current data_dir, then mark migration complete or remove the local ownership key. The legacy key must not repeatedly force future data_dirs or future sessions back to ON after the user has turned backend bypass OFF.

## Invariants

- `kis_rest_bypass_enabled=true` means no backend KIS REST data call is attempted through KIS REST Access or legacy data-fetch seams.
- `kis_rest_bypass_enabled` does not mutate `storage_policy`; it only suppresses REST data-call execution while ON.
- `/api/range` remains a no-KIS read path.
- `LiveRestPoller` remains display-only and never persists data.
- `Rest30sRecorder` remains the only persistent REST 30s orderbook/trade/broker recorder.
- Source preference remains read policy, not KIS call policy.
- Stored `kis_api` Source artifacts remain displayable while bypass is ON.
- Cached data may be served while bypass is ON.
- Missing cached data produces warnings, not retries.
- Bypass is an intentional paused state, not a degraded-health state.

## Options Considered

### Option A: Keep frontend-only bypass and add more fallbacks

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low |
| User correctness | Low |
| Backend safety | Low |

Pros:

- Small frontend patch.
- Can improve study blank-chart behavior quickly.

Cons:

- Backend KIS REST producers still call KIS.
- The toggle remains misleading.
- New KIS REST callers can bypass the UI flag.

### Option B: Backend KIS REST policy centralization

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium |
| User correctness | High |
| Backend safety | High |

Pros:

- The user-facing toggle matches backend behavior.
- Central guard protects current and future KIS REST callers.
- Runtime loops can stop cleanly and avoid log spam.

Cons:

- Requires backend model/settings/runtime changes.
- Existing callers need consistent bypass handling.

### Option C: Full KIS candle parquet integration now

| Dimension | Assessment |
|-----------|------------|
| Complexity | High |
| User correctness | High after completion |
| Backend safety | Medium unless paired with Option B |

Pros:

- Long-term read path becomes cleaner.
- KIS candles become reusable through `/api/range`.

Cons:

- Does not automatically stop quotes, pollers, recorder, program-trade, or screener KIS REST calls.
- Requires source resolution and partial-source semantics changes.
- Larger migration and regression surface.

Decision: implement Option B first. Option C remains a follow-up architecture project.

## Rollout Plan

1. Add backend settings field and frontend API type.
2. Move Settings/toast toggle to backend setting.
3. Add central `kis_access` guard and typed bypass error.
4. Stop runtime KIS REST loops when bypass is ON.
5. Add cache-only behavior for minute/daily candle endpoints.
6. Align live/study fallback behavior.
7. Remove or deprecate frontend localStorage bypass ownership.
8. Write a follow-up spec for KIS candle parquet integration.

## Test Plan

Backend:

- `tests/unit/live/test_settings.py`
  - default includes `kis_rest_bypass_enabled=False`.
  - patch preserves omitted fields.
  - corrupt settings still fall back safely.
- `tests/unit/live/test_storage_runtime.py`
  - bypass ON stops REST 30s recorder.
  - bypass ON stops program-trade collector.
  - bypass OFF preserves current storage policy behavior.
- `tests/unit/live/test_lifecycle_rest_poller.py`
  - bypass ON does not create `LiveRestPoller`.
  - toggling ON stops an existing poller.
- `tests/unit/live/test_kis_access.py`
  - `run_with_capacity` does not call scheduler or client when bypass ON.
  - legacy `fetch_for_role` path is blocked when bypass ON.
- `tests/unit/live/test_api.py`
  - `/past-candles` cache-only response does not call KIS on cache miss.
  - `/past-daily-candles` cache-only response does not call KIS on cache miss.
  - `/quotes` returns stale last-good quotes without calling KIS when available.
  - `/quotes` returns empty quotes without calling KIS when no last-good quote exists.
  - `/screener/scan?basis=intraday` falls back to EOD with `kis_rest_bypassed_intraday_overlay_skipped`.
  - `/index-candles` is cache-only while bypass ON.

Frontend:

- `frontend/src/api/liveSettings.test.ts`
  - patch supports `kis_rest_bypass_enabled`.
- `frontend/src/live/LiveSettingsSections.test.tsx`
  - toggle calls `patchLiveSettings`.
  - bypass status is rendered as paused, not failed.
- `frontend/src/live/KisRestUnavailableToastHost.test.tsx`
  - toast switch controls backend setting.
  - bypass ON suppresses repeated transport-failure toasts.
  - legacy localStorage migration does not re-enable bypass after backend OFF.
- `frontend/src/live/useLiveBundle.test.tsx`
  - screener daily remains enabled during bypass.
  - range fallback is used when KIS candle endpoint returns bypass warning.
  - range fallback preserves Source Preference and can use stored `kis_api` Source.
- `frontend/src/studyViews/useStudyReferenceBundle.test.tsx`
  - minute study uses range full-mode fallback.
  - D/W/M study uses screener daily fallback where available.

## Follow-Up: KIS Candle Parquet Integration

A later spec will decide how to write KIS candles into the regular parquet source model. That work will answer:

- Does `kis_api/candles.parquet` allow missing `snapshots.parquet`, `trades.parquet`, and `brokers.parquet`?
- Does `/api/range` resolve candle source separately from hoga source?
- How do we migrate or retire `<data_dir>/kis-past-candles/*.json`?
- Should KIS daily candles be persisted per date, per batch, or derived from screener daily corpus?

That follow-up improves architecture, but it is not required to make `KIS API 우회` truthful.
