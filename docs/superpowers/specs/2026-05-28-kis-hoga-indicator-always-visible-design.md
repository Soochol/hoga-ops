# KIS 호가 보조지표 — `/replay`·`/live`에서 끊김 없이 보이게

**Status:** draft (2026-05-28)

## 1. Goal

KIS 폴러가 받아온 호가 데이터(총잔량 / ratio / fill_strength)를 사용자가 **언제든지** `/replay`와 `/live` 페이지에서 호가 보조지표 패널로 볼 수 있어야 한다. 사용자가 `/replay > Settings > 기본 데이터 소스`에서 고른 source preference를 엄격히 따르되, 그 source가 디스크에 아예 없는 경우엔 다른 source로 fallback한다.

본 spec은 두 개의 독립된 버그가 함께 만든 증상을 해결한다:

1. **오늘 데이터가 차트에 안 보임** — KIS poller가 jsonl로 디스크에 쓰지만, parquet 변환(`promote`)은 매일 18:00 KST에 1회만 일어남. 결과적으로 18:00 이전 오늘 데이터는 `/api/range`가 못 본다. `/live`의 SSE 경로는 LiveBuffer(휘발성 메모리)만 보므로, 서버 재시작 / 폴링 정지 / 첫 진입 시 모두 빈 차트.
2. **5/27 같은 source 공존일에 손상된 데이터 노출** — 디스크 레이아웃이 ADR-0037 source-aware로 전환되는 과정에서 한 Stock-Date 폴더 안에 `kis_live/` 서브디렉터리와 손상된 hogaplay 잔재(top-level meta + parquet)가 공존하면, 메타는 source-aware로 읽지만 데이터 슬라이스는 source-unaware로 fallback 읽어서 손상 데이터가 차트에 노출된다.

두 fix는 독립적이지만 사용자 요구("언제든지 KIS 데이터 볼 수 있음")를 함께 충족해야 의미가 있어 한 spec으로 묶는다.

## 2. Non-goals

| 항목 | 이유 |
|---|---|
| jsonl direct-read 경로 (`/api/range`가 jsonl을 직접 파싱) | 매 요청마다 변환 비용 + 캐시 레이어 필요. promote 주기 단축이 훨씬 단순 |
| 자동 fallback (source가 sparse하면 다른 source로) | 사용자 정책: settings UI 선택을 엄격히 따름. 존재 여부 기준 fallback만 |
| 손상된 legacy flat layout 파일 자동 정리 | 별도 cleanup 명령(`hoga validate --cleanup-legacy-flat`)으로 follow-up. 본 spec은 코드 fix만 |
| `resolve_source_dir`의 legacy 분기 제거 | 진짜 레거시 flat-only fixture가 깨질 위험. 5/27 케이스는 source 서브디렉터리가 있어서 첫 if에서 잡힘 |
| 호가 데이터 sparse일 때 UI 안내 배너 | 사용자 거절. 빈 영역 자체가 "이 source 데이터 부족" 신호 |
| 5/28 데이터를 SSE buffer로 backfill | promote_today로 parquet 채우면 `/api/range`가 자연스럽게 cover. SSE backfill 불필요 |
| `pastHasToday` 분기와 `kisOnlySegments` 합성 완전 제거 | 안전망으로 유지 (다른 코너 케이스 회귀 방지). dedup 로직만 교체 |

## 3. 합의된 결정

| 항목 | 결정 |
|---|---|
| 오늘 데이터 경로 | **주기적 자동 promote (기본 5분)** — jsonl → parquet 증분 변환을 백엔드 task로 추가 |
| 새 컴포넌트 | `promote_today()` 함수 + `start_today_promoter()` asyncio task |
| Promote 주기 | 환경변수 `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S` 기본 300 (5분) |
| Promote 동작 | jsonl 전체 재읽기 → parquet atomic overwrite. archive 이동 안 함. `meta.json` 매번 갱신 |
| 18:00 promote_pending과 충돌 처리 | promote_pending이 **오늘 날짜 skip** 가드 추가 |
| Source-aware fix 범위 | 4개 슬라이스 빌더에 `source` 키워드 인자 추가, `bundle.py` 메인 루프가 명시 전달 |
| Source 부재 시 fallback | 현재 `_resolve_source` 로직 그대로 (preferred 없으면 다른 source 선택) |
| Source sparse 시 동작 | preferred를 엄격히 따름 — sparse여도 그대로 표시. fallback 안 함 |
| 프런트 머지 로직 | `pastHasToday` binary 분기 → **timestamp-based dedup** (`p.t > pastMaxT` strict greater) |
| UI 변경 | **없음**. Settings 모달의 source 선택은 이미 존재 |
| Kill switch | `HOGA_LIVE_TODAY_PROMOTE_ENABLED=false`로 task 비활성 가능 |

## 4. 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                          백엔드                                  │
│                                                                  │
│   [KIS poller] ──publish──▶ [LiveBuffer (메모리)] ─▶ SSE         │
│        │                                                 │       │
│        └──jsonl 기록──▶ [data/live/YYYYMMDD/CODE.jsonl] │       │
│                                  │                        │       │
│                                  ▼                        │       │
│                  ┌──────────────────────────────┐        │       │
│                  │ ★ NEW: start_today_promoter │        │       │
│                  │   • 1~5분 주기 task          │        │       │
│                  │   • 오늘 jsonl만             │        │       │
│                  │   • atomic overwrite         │        │       │
│                  │   • archive 이동 안 함       │        │       │
│                  └──────────────┬───────────────┘        │       │
│                                  ▼                        │       │
│       [data/parquet/{today}/{code}/kis_live/*.parquet]   │       │
│                                  │                        │       │
│            ┌─────────────────────┴───────────────┐      │       │
│            ▼                                      ▼      │       │
│        [/api/range]  ←─ ★ source-aware data slice (5/27 fix)    │
│            │                                             │       │
└────────────┼─────────────────────────────────────────────┼───────┘
             ▼                                              ▼
       [/replay 차트]                              [/live 차트]
                                          (SSE는 마지막 N분 incremental만 보태기)
```

### 데이터 흐름 — 사용자 관점

- **/replay에서 어제(5/27) + KIS source 선택**: `kis_live/`의 sparse 데이터 그대로 표시. 손상된 hogaplay 잔재는 더 이상 노출 안 됨.
- **/replay에서 오늘(5/28) + KIS source 선택**: 1~5분 전까지의 정규장 데이터 표시. 다음 promote 주기 후 갱신.
- **/live에서 오늘**: parquet이 1~5분 전까지 cover + SSE가 마지막 1~2분 incremental 추가.
- **백엔드 reload 직후**: LiveBuffer 비어있지만 parquet은 살아있어서 차트가 즉시 풍부함.

## 5. 백엔드 변경

### 5.1 새 함수 — `promote_today`

**위치**: [hoga/live/promote.py](../../hoga/live/promote.py)에 추가.

```python
async def promote_today(data_dir: Path, *, code: str) -> None:
    """오늘 날짜 jsonl을 parquet으로 overwrite 변환.

    promote_one과 다른 점:
      - idempotent skip 안 함 (meta.json 있어도 다시 처리)
      - archive 이동 안 함 (jsonl 계속 polling 중)
      - parquet 파일들은 atomic_write로 원자 교체
      - 마지막 torn line은 partial_line으로 skip (promote_one 패턴 그대로)
    """
    today = _today_kst_yyyymmdd()
    jsonl_path = data_dir / "live" / today / f"{code}.jsonl"
    parquet_root = data_dir / "parquet"
    target = parquet_root / today / code / "kis_live"

    if not jsonl_path.exists():
        return

    # 파싱 로직은 promote_one에서 추출해 공유 (snapshots / trades / brokers / meta)
    snapshots, trades, broker_rows, meta = _parse_jsonl_to_records(
        jsonl_path, code=code, date=today,
    )

    target.mkdir(parents=True, exist_ok=True)
    _atomic_write_parquet(target / "snapshots.parquet", snapshots)
    _atomic_write_parquet(target / "trades.parquet",    trades)
    _atomic_write_parquet(target / "brokers.parquet",   broker_rows)
    atomic_write_json    (target / "meta.json",         meta)
```

두 개의 새 헬퍼가 필요하다:

1. **`_parse_jsonl_to_records(jsonl_path, *, code, date)`** — 현재 [promote.py:30-130](../../hoga/live/promote.py#L30) `promote_one` 안에 inline으로 있는 jsonl→`(snapshots, trades, broker_rows, meta)` 변환 로직을 모듈 레벨 헬퍼로 추출. `promote_one`도 같은 헬퍼를 호출하도록 리팩터.

2. **`_atomic_write_parquet(path, records)`** — `tempfile.NamedTemporaryFile(dir=path.parent)`에 polars의 `write_parquet`으로 쓰고 `os.replace(tmp, path)`로 원자 교체. `hoga/api/_atomic_write.py`에 `atomic_write_json` 옆에 추가. 빈 리스트면 (스키마가 알려진 경우) 빈 parquet 쓰거나 파일 unlink — 본 spec에선 빈 리스트일 때 unlink 선택 (downstream DuckDB가 빈 parquet 읽기 까다로움).

### 5.2 새 task — `start_today_promoter`

**위치**: [hoga/live/lifecycle.py](../../hoga/live/lifecycle.py)에 추가.

```python
async def start_today_promoter(
    *, data_dir: Path,
    get_active_codes: Callable[[], list[str]],
    interval_s: float = 300.0,
) -> asyncio.Task:
    """오늘 jsonl을 N초마다 parquet으로 overwrite 변환하는 task.

    get_active_codes: 현재 폴링 중인 watchlist code 리스트를 반환.
                      task가 매 사이클 호출.
    """
    async def loop() -> None:
        while True:
            try:
                for code in get_active_codes():
                    try:
                        await promote_today(data_dir, code=code)
                    except Exception:
                        _log.exception(
                            "live.today_promote.code_failed code=%s", code,
                        )
            except Exception:
                _log.exception("live.today_promote.cycle_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="today-promoter")
```

### 5.3 lifespan wire — `app.py`

[hoga/api/app.py](../../hoga/api/app.py) lifespan에서 `start_live_poller` 옆에 `start_today_promoter` 시작 및 shutdown 시 cancel.

```python
# lifespan startup
if os.getenv("HOGA_LIVE_TODAY_PROMOTE_ENABLED", "true").lower() != "false":
    interval = float(os.getenv("HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S", "300"))
    today_promoter_task = await start_today_promoter(
        data_dir=data_dir,
        get_active_codes=lambda: watchlist_codes(),  # 기존 watchlist accessor
        interval_s=interval,
    )

# lifespan shutdown
if today_promoter_task is not None:
    today_promoter_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await today_promoter_task
```

### 5.4 `promote_pending` 가드

[hoga/live/promote.py:163-186](../../hoga/live/promote.py#L163)의 `promote_pending` 루프가 오늘 날짜를 건드리지 않게 1줄 추가.

```python
async def promote_pending(data_dir: Path) -> None:
    today = _today_kst_yyyymmdd()
    live_root = data_dir / "live"
    archive_root = live_root / "_archive"
    parquet_root = data_dir / "parquet"

    for date_dir in sorted(live_root.iterdir()):
        if not date_dir.is_dir() or date_dir.name == "_archive":
            continue
        if date_dir.name == today:    # ← 추가
            continue                   # today_promoter 담당
        for jsonl in date_dir.iterdir():
            ...
```

### 5.5 source-aware 데이터 슬라이스 (5/27 fix)

[hoga/api/bundle.py](../../hoga/api/bundle.py)의 4개 슬라이스 빌더에 `source` 키워드 인자 추가:

```python
def build_candles_slice(
    engine: QueryEngine, *, code: str, date: str,
    source: str = "hogaplay",   # ← 추가
) -> list[ApiCandle]:
    path = engine.parquet_dir(date, code, source) / "candles.parquet"
    ...

def build_quote_ratio_slice(
    engine: QueryEngine, *, code: str, date: str,
    bucket_ms: int = 1000,
    source: str = "hogaplay",   # ← 추가
) -> QuoteRatio:
    path = str(engine.parquet_dir(date, code, source) / "snapshots.parquet")
    ...

def build_fill_strength_slice(...source: str = "hogaplay") -> FillStrength: ...
def build_volume_profile_slice(...source: str = "hogaplay") -> VolumeProfile: ...
```

`build_range_bundle` 메인 루프가 `_resolve_source`의 결과를 명시적으로 전달:

```python
for d in dates:
    source = _resolve_source(engine, d, code, source_pref)
    try:
        meta = engine.get_meta(d, code, source)
    except (FileNotFoundError, StockDateNotFound):
        continue
    c = classify_from_meta(meta)
    if c.state == DiskState.INVALID:
        excluded.append(...)
        continue

    raw_candles = build_candles_slice(engine, code=code, date=d, source=source)
    candles_d   = downsample_candles(raw_candles, bucket_ms=bucket_ms)
    qr_d        = build_quote_ratio_slice(engine, code=code, date=d, bucket_ms=bucket_ms, source=source)
    fs_d        = build_fill_strength_slice(engine, code=code, date=d, bucket_ms=bucket_ms, source=source)
    vp_d        = build_volume_profile_slice(engine, code=code, date=d, source=source)

    segments.append(RangeSegment(
        date=d,
        session_open_ms=hhmmssms_to_unix_ms(d, meta["regular_session_open_ms"]),
        session_close_ms=hhmmssms_to_unix_ms(d, meta["regular_session_close_ms"]),
        source=source,
    ))
    ...
```

`build_volume_profile_range`는 range-wide 집계라 date별로 다른 source가 섞일 수 있다. 시그니처를 다음과 같이 변경:

```python
def build_volume_profile_range(
    engine: QueryEngine,
    *,
    code: str,
    dates_with_sources: list[tuple[str, str]],   # (date, source) 페어
) -> VolumeProfile:
    paths = [
        str(engine.parquet_dir(d, code, src) / "trades.parquet")
        for d, src in dates_with_sources
    ]
    ...
```

호출부([bundle.py:458-459](../../hoga/api/bundle.py#L458))는 `[(s.date, s.source) for s in segments]`를 전달.

[hoga/api/queries.py:81](../../hoga/api/queries.py#L81)의 `resolve_source_dir`은 **변경하지 않음** — legacy flat layout fallback이 진짜 옛날 데이터를 위해 필요. 5/27 케이스는 source 서브디렉터리가 있으므로 첫 if에서 잡혀 fallback 분기를 발동시키지 않는다.

## 6. 프런트엔드 변경

### 6.1 머지 로직 dedup

[frontend/src/live/buildLiveBundle.ts:53-77](../../frontend/src/live/buildLiveBundle.ts#L53)의 `pastHasToday` binary 분기를 timestamp-based dedup으로 교체.

**변경 전**:
```typescript
const pastHasToday = pastSegments.some((s) => s.date === todayDate);
const todayBuckets = pastHasToday
  ? { quoteRatioPoints: [], fillStrengthPoints: [] }
  : bucketHogaSeries(sseOb, sseTrade, bucketMs);
```

**변경 후**:
```typescript
const pastQRPoints = pastBundle?.quote_ratio.points ?? [];
const pastFSPoints = pastBundle?.fill_strength.points ?? [];

const pastMaxQrT = pastQRPoints.length > 0
  ? pastQRPoints[pastQRPoints.length - 1].t
  : 0;
const pastMaxFsT = pastFSPoints.length > 0
  ? pastFSPoints[pastFSPoints.length - 1].t
  : 0;

const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs);
const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);

// 결과 머지
quote_ratio: {
  bucket_ms: bucketMs,
  points: [...pastQRPoints, ...incrementalQR],
},
fill_strength: {
  bucket_ms: bucketMs,
  points: [...pastFSPoints, ...incrementalFS],
},
```

Boundary timestamp(parquet 끝점 = SSE bucket 시작점)는 **parquet이 이김** (`p.t > pastMaxT` strict greater).

`todaySegments` 결정 로직은 약간 정리:
```typescript
const hasTodaySignal =
  pastQRPoints.some((p) => realMsToYyyymmdd(p.t) === todayDate) ||
  incrementalQR.length > 0 ||
  sseOb.length > 0 ||
  kisCandles.some((c) => c.ts_ms >= todaySession.open_ms);
const pastHasTodaySegment = pastSegments.some((s) => s.date === todayDate);
const todaySegments: RangeSegment[] =
  hasTodaySignal && !pastHasTodaySegment
    ? [{ date: todayDate, session_open_ms: ..., session_close_ms: ..., source: 'kis_live' }]
    : [];
```

`kisOnlySegments` 합성 로직([buildLiveBundle.ts:82-103](../../frontend/src/live/buildLiveBundle.ts#L82))은 다른 코너 케이스 안전망이므로 유지.

### 6.2 UI

변경 없음. Source 선택은 이미 [SettingsModal.tsx:149-275](../../frontend/src/replay/SettingsModal.tsx#L149)에 존재하고, `useSourcePreferenceStore` 글로벌이라 `/live`도 자동 적용된다.

## 7. 예외 처리 표

| 시나리오 | 처리 |
|---|---|
| writer가 jsonl append 중 promote_today read | jsonl line-level 원자 append. 마지막 torn line은 `json.JSONDecodeError` → `partial_line` warn 로그 후 skip |
| atomic_write 도중 디스크 가득 / IO 실패 | tempfile + rename 패턴. 실패 시 기존 parquet 그대로. `live.today_promote.write_failed` warn 로그. 다음 사이클이 재시도 |
| 한 종목 promote_today가 예외 | inner try/except로 catch, `live.today_promote.code_failed code=X` 로그. 다음 종목 계속 진행 |
| 전체 사이클이 예외 | outer try/except로 catch, `live.today_promote.cycle_failed` 로그. 다음 사이클 sleep 후 재진입 |
| 폴링이 멈춰 jsonl 정체 | parquet은 마지막 promote 시점까지 그대로. 차트는 정체된 데이터 표시 (정상 동작) |
| watchlist에서 종목 제거 | `get_active_codes()`에서 빠지므로 더 이상 promote 안 됨. 기존 parquet 유지 |
| 자정 경과로 today_kst 변경 | 다음 사이클이 새 today로 promote 시작. 어제는 18:00 `promote_pending` 처리 (가드 덕분에 충돌 없음) |
| 자정 라이브 race (23:59:58 promote_today + 00:00:01 promote_pending) | `shutil.move`가 원자적. promote_today 다음 사이클은 새 today를 읽어 안전 |
| 동일 종목 동시 promote_today | task는 단일 루프(직렬 sleep). 구조적으로 발생 불가 |
| 백엔드 reload | lifespan shutdown 훅이 task `cancel()` + `await`로 정리. atomic_write는 tempfile 단계라 원본 안전 |
| jsonl 자체가 없음 (첫 폴링 전) | `if not jsonl_path.exists(): return` 조기 반환 |
| legacy flat-only layout (top-level meta만 있고 source 서브디렉터리 없음) | `resolve_source_dir`의 legacy fallback이 그대로 살림. `source='hogaplay'` default가 호환성 유지 |

## 8. 새 환경 변수

| 변수 | 기본 | 의미 |
|---|---|---|
| `HOGA_LIVE_TODAY_PROMOTE_ENABLED` | `true` | `false`면 today_promoter task 시작 안 함 (kill switch) |
| `HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S` | `300` (5분) | promote_today 주기. 1분(60)~30분(1800) 권장 범위 |

## 9. 새 로그

| 라인 | 레벨 | 의미 |
|---|---|---|
| `live.today_promote.start code=X date=Y` | INFO | 한 종목 promote 시작 |
| `live.today_promote.done code=X date=Y row_counts={...} elapsed_ms=N` | INFO | 한 종목 promote 완료 |
| `live.today_promote.code_failed code=X` (+ exception) | WARN | 한 종목 promote 예외 (다른 종목 계속) |
| `live.today_promote.cycle_failed` (+ exception) | WARN | 전체 사이클 예외 (다음 사이클 재시도) |
| `live.today_promote.write_failed code=X path=Y reason=...` | WARN | atomic write 실패 |
| `live.today_promote.partial_line code=X date=Y` | WARN | jsonl 마지막 torn line skip |

## 10. 테스트

### 10.1 백엔드 — `promote_today` 단위 테스트

**파일**: `tests/unit/live/test_promote_today.py` (신규)

| 테스트 | 검증 |
|---|---|
| `test_promote_today_creates_parquet_from_jsonl` | jsonl 있고 parquet 없는 상태에서 호출 → 4개 parquet + meta.json 생성 |
| `test_promote_today_overwrites_existing` | 1차 promote 후 jsonl에 새 줄 추가 → 2차 promote → meta.row_counts.snapshots 증가 |
| `test_promote_today_does_not_move_to_archive` | promote_today 후에도 `live/{date}/{code}.jsonl` 살아있고 `live/_archive/...`엔 안 들어감 |
| `test_promote_today_handles_torn_last_line` | 마지막 라인이 incomplete JSON → 나머지 N-1줄 정상 promote, warn 로그 |
| `test_promote_today_returns_when_jsonl_missing` | jsonl 없으면 조용히 반환, parquet 안 만듦 |
| `test_promote_pending_skips_today` | `live/{today}/x.jsonl`이 promote_pending 호출 후에도 살아있음 |

### 10.2 백엔드 — `start_today_promoter` 단위 테스트

**파일**: `tests/unit/live/test_today_promoter.py` (신규)

| 테스트 | 검증 |
|---|---|
| `test_today_promoter_loops` | sleep 0.01s로 monkeypatch, 3 사이클 돌리고 promote_today가 N번 호출되는지 (mock) |
| `test_today_promoter_survives_code_exception` | 한 종목 promote가 raise → 다음 종목 계속 진행 |
| `test_today_promoter_survives_cycle_exception` | get_active_codes가 raise → 다음 사이클로 진행 |
| `test_today_promoter_calls_for_all_active_codes` | watchlist에 3종목 있으면 매 사이클마다 3번 호출 |

### 10.3 백엔드 — source-aware fix

**파일**: `tests/unit/api/test_bundle_source_aware.py` (신규)

| 테스트 | 검증 |
|---|---|
| `test_dual_source_5_27_scenario` | 손상된 top-level hogaplay(close_ms=0) + 정상 kis_live/ → `/api/range`의 quote_ratio.points가 kis_live 데이터만 (top-level snapshots.parquet은 안 읽힘) |
| `test_legacy_flat_layout_still_works` | source 서브디렉터리 없고 top-level meta만 → resolve_source_dir의 legacy fallback로 정상 동작 |
| `test_source_pref_fallback_when_pref_missing` | preferred=hogaplay지만 hogaplay/ 없으면 kis_live로 fallback (sparse여도 그것만 사용) |
| `test_source_pref_strict_when_pref_present_but_sparse` | preferred=kis_live이고 sparse하지만 그것만 사용 (hogaplay가 풍부해도 fallback 안 함) |

### 10.4 프런트엔드 — dedup

**파일**: `frontend/src/live/buildLiveBundle.test.ts` (기존 확장)

| 테스트 | 검증 |
|---|---|
| `dedupes SSE buckets that share timestamp with parquet tail` | parquet 마지막 t=A, SSE에 t=A + t=A+60s → 결과는 t=A는 parquet 거, t=A+60s는 SSE 거 |
| `uses all SSE buckets when past bundle is empty` | pastBundle=null이면 SSE 전부 사용 (fallback) |
| `appends only timestamps strictly greater than past tail` | strict greater 동작 검증 |

### 10.5 E2E (회귀 안전망, optional but recommended)

**파일**: `tests/e2e/test_promote_today_to_chart.py` (신규)

```
1) 003490 폴링 활성화, jsonl에 1분치 데이터 누적
2) promote_today() 수동 호출
3) /api/range → quote_ratio.points 안에 오늘 데이터 보임
4) jsonl에 새 1분치 더 추가
5) promote_today() 다시 호출
6) /api/range → 새 데이터까지 포함 (overwrite)
```

## 11. 마이그레이션 / 배포

기존 데이터 마이그레이션 불필요. 코드 배포만으로 끝.

- 첫 배포 직후: today_promoter가 5분 안에 첫 사이클 도는 동안 차트가 평소처럼 동작 (기존 SSE 경로 fallback)
- 첫 사이클 후: 오늘 parquet 생성됨 → `/api/range`가 즉시 cover
- 18:00 promote_pending이 그날 오는 시점에 이미 오늘 parquet은 promote_today가 만들어 둔 상태. `promote_pending`의 today-skip 가드가 이중 처리 방지
- 다음날 00:00 직후: 어제 jsonl은 promote_pending이 18:00에 처리해서 archive로 이동된 상태 (정상 라이프사이클)

Kill switch (`HOGA_LIVE_TODAY_PROMOTE_ENABLED=false`)로 즉시 비활성 후 18:00 일괄 동작으로 회귀 가능.

## 12. Open questions

- **`get_active_codes` 구체 구현**: 현재 `LiveStatus.watchlist_count`만 있고 codes 리스트는 별도 accessor 필요. 폴러 내부에서 노출하는 게 가장 자연스러움 — 구현 시 [hoga/live/lifecycle.py](../../hoga/live/lifecycle.py)에서 watchlist accessor를 lifespan으로 빼낼지 결정.
- **빈 리스트 → parquet 처리**: `promote_today`가 jsonl 첫 폴링 직후 호출되면 records가 비어있을 수 있음. 빈 parquet 쓰는 게 어려우므로 본 spec은 "unlink" 선택. 만약 downstream(`build_quote_ratio_slice`의 DuckDB read)이 파일 부재를 잘 처리하지 못하면 빈 스키마 parquet 쓰는 쪽으로 변경 필요.
- **디스크 IO 부담**: 5분 주기 × 활성 종목 N개 × 평균 14MB jsonl → parquet 쓰기 ≈ N×170MB/h. N=10이면 1.7GB/h. 현재 워크트리 환경(SSD)은 무난하지만 본 spec은 절대 수치를 측정하지 않았음. 첫 배포 후 1주일 모니터링으로 결정.
