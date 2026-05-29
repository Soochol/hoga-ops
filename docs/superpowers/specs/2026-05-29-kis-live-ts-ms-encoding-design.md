# kis_live promoted parquet의 `ts_ms` 인코딩 정합화 — Design

**Date**: 2026-05-29
**Status**: Draft
**Scope**: `hoga/live/promote.py`, `hoga/api/bundle.py` (테스트만), `frontend/src/live/buildLiveBundle.ts`, `scripts/repromote_kis_live.py` (신규), 회귀 테스트 (backend + frontend)

## Problem

`/live` 페이지의 분봉 차트에서 hoga 인디케이터 패널(Ratio, QuoteTotals, FillStrength)이 오늘 날짜 데이터를 그리지 못한다. /diagnose로 확인한 원인:

- [hoga/live/promote.py:70-93](../../../hoga/live/promote.py)의 `_parse_jsonl_to_records`가 KIS 라이브 JSONL 행의 `t_ms`(**Unix epoch ms**)를 그대로 `ts_ms` 컬럼명으로 저장한다.
- 반면 모든 reader는 `ts_ms`를 hogaplay convention인 **HHMMSSmmm packed-decimal**로 가정한다 ([api/bundle.py:133](../../../hoga/api/bundle.py)·[:317](../../../hoga/api/bundle.py), [api/routes.py:135](../../../hoga/api/routes.py)·[:167](../../../hoga/api/routes.py), [tables/snapshots.py:220](../../../hoga/tables/snapshots.py)).
- 결과: `build_quote_ratio_slice`가 `hhmmssms_to_intra_ms_sql("ts_ms")`로 Unix ms를 HHMMSSmmm처럼 디코딩 → 결정적으로 **2046년 timestamp** 산출.
- 1차 영향: `/api/range` 응답의 `quote_ratio.points` / `fill_strength.points` 중 kis_live source 비율만큼이 2046년 t로 반환됨 (실측: 058610 058 2026-05-29 quote_ratio 401(2026) + 224(2046)).
- 2차 영향: [frontend/src/live/buildLiveBundle.ts:59-68](../../../frontend/src/live/buildLiveBundle.ts)의 dedup 가드
  ```ts
  const pastMaxQrT = pastQRPoints[pastQRPoints.length - 1].t  // = 2046 쓰레기값
  const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT)
  ```
  pastMaxQrT가 2046년이 되면 SSE incremental 포인트(2026년) 전부가 필터에 걸려 **라이브 데이터 머지가 0건**. 백엔드 인코딩 오류 한 군데가 라이브 차트 전체를 사일런트로 무력화한다.

사용자 보고: "live 페이지에서 분봉 차트에서 호가 데이터가 렌더링 되지 않아."

## Invariants

이 spec이 건드리는 시스템이 현재 보존(또는 보존을 의도)하고 있는 속성들.

- **Parquet `ts_ms` 컬럼 = HHMMSSmmm packed-decimal**: `snapshots/trades/brokers.parquet`의 `ts_ms` 컬럼은 hogaplay native HHMMSSmmm 인코딩(`90000000` = 09:00:00.000)을 담는다. 근거: [hoga/tables/snapshots.py:77](../../../hoga/tables/snapshots.py), [hoga/tables/trades.py:121](../../../hoga/tables/trades.py), [hoga/tables/brokers.py:94](../../../hoga/tables/brokers.py), [hoga/api/timeenc.py:52-89](../../../hoga/api/timeenc.py) (`hhmmssms_to_intra_ms_sql`의 docstring이 이 invariant를 명시).
- **모든 reader는 `ts_ms`를 HHMMSSmmm로 디코딩**: 어떤 reader도 `ts_ms`를 Unix ms로 직접 해석하지 않는다. 근거: [hoga/api/bundle.py:133](../../../hoga/api/bundle.py),[:317](../../../hoga/api/bundle.py); [hoga/api/routes.py:135](../../../hoga/api/routes.py),[:167](../../../hoga/api/routes.py); [hoga/tables/snapshots.py:220-234](../../../hoga/tables/snapshots.py)의 `query_at` SQL이 `WHERE ts_ms <= ?`로 HHMMSSmmm 비교.
- **`quote_ratio.points[i].t`는 day-window 안에 있다**: 모든 t에 대해 `KST_midnight(date) ≤ t < KST_midnight(date) + 86_400_000`. 동일하게 `fill_strength.points[i].t`. **현재 kis_live source에서 깨져 있음** — 이 spec이 복원한다. 근거 (의도): [hoga/api/bundle.py:152-163](../../../hoga/api/bundle.py)의 `ms_from_midnight_to_unix_ms(date, r[0])` 결과는 정의상 day-window 안.
- **`buildLiveBundle.pastMaxQrT` 단조성 가드**: SSE incremental 포인트는 `t > pastMaxQrT`만 머지된다 — boundary 중복 방지가 목적. 근거: [frontend/src/live/buildLiveBundle.ts:59-68](../../../frontend/src/live/buildLiveBundle.ts).

## Invariant impact

| Invariant | 영향 | 비고 |
|---|---|---|
| 1. `ts_ms` = HHMMSSmmm | preserves | writer가 Unix ms → HHMMSSmmm 변환을 추가, 컬럼 schema 불변 |
| 2. reader 디코딩 가정 | preserves | reader 코드 변경 없음 — writer 측에서 invariant 회복 |
| 3. day-window 안의 `t` | **restores** | 회귀 테스트로 lock-down |
| 4. pastMaxQrT 단조성 | preserves + sane bound 추가 | clip 후에도 정상 데이터의 dedup 의미는 동일 (정상 t는 항상 close_ms ≤). corrupt 데이터에 대해서만 가드 무력화 차단 |

## Goals

- `/api/range` 응답이 kis_live source에서도 day-window 안의 timestamp만 반환한다 (회귀 테스트로 lock).
- 17개 corrupted kis_live 디렉토리(20260527/28/29)가 회복된다.
- backend 인코딩 오류가 다시 발생하더라도 SSE 라이브 머지가 차단되지 않는다 (프런트 sanity clip이 보호막).
- 같은 종류의 인코딩 실수가 build_quote_ratio_slice / build_fill_strength_slice에서 다시 발생하면 즉시 테스트가 잡는다.

## Non-Goals

- Reader 측 source 분기 추가 (옵션 B) — 6+ 군데에 분기 부채를 누적하는 길은 명시적으로 거부.
- `ts_ms` 컬럼 rename → `t_ms` (옵션 C) — schema 변경 회피.
- `/api/orderbook`, `/api/brokers/series`에 대한 **신규** 회귀 테스트 — 옵션 A로 자동 회복되나 가드는 Out of Scope.
- replay viewer가 kis_live source를 쓰는 시나리오 검증.
- hogaplay parser나 인코딩 변경.
- `promote_one()`에 `force=True` 파라미터 추가 — 스크립트가 디렉토리 삭제로 우회.

## Design

### 1. Writer 정규화 ([hoga/live/promote.py](../../../hoga/live/promote.py))

`_parse_jsonl_to_records` 안에서 `t_ms`를 HHMMSSmmm로 변환해 `ts_ms` 컬럼에 저장한다.

```python
# Before — line 81
snap: dict = {"ts_ms": t_ms, "phase": phase}

# After
from hoga.api.timeenc import unix_ms_to_hhmmssms
try:
    encoded_ts = unix_ms_to_hhmmssms(date, t_ms)
except ValueError:
    # Midnight race: t_ms 가 date의 KST 하루 범위를 벗어남.
    # promote.py:172의 today_kst 고정 + market-hours 가드가 1차 방어이고
    # 여기는 2차 방어. 해당 row만 skip + log.
    _log.warning("live.promote.midnight_race_skip code=%s date=%s t_ms=%d", code, date, t_ms)
    continue
snap: dict = {"ts_ms": encoded_ts, "phase": phase}
```

Trades(line 93)도 동일 변환. Brokers는 이미 BrokerRow dataclass가 HHMMSSmmm로 변환된 값을 들고 있는지 확인 (line 107·117의 `ts_ms=int(t_ms)`가 동일 문제일 수 있음 — 구현 단계에서 확인).

[promote.py:78-81](../../../hoga/live/promote.py)의 주석을 갱신: "Column name aligns with hogaplay" → "Convert Unix ms → HHMMSSmmm to honor schema invariant (tables/snapshots.py:77, timeenc.py:52-57)".

### 2. 데이터 복구 — `scripts/repromote_kis_live.py`

일회성 스크립트로 corrupted 디렉토리를 삭제 + 재-promote.

```python
# scripts/repromote_kis_live.py
"""One-shot: delete kis_live/ parquet dirs and re-promote from preserved JSONL.

Use after deploying the encoding fix in hoga/live/promote.py to restore
historical dates the today_promoter won't touch (it only handles today).
"""
import argparse, asyncio, shutil
from pathlib import Path
from hoga.api.disk_state import resolve_data_dir
from hoga.live.promote import promote_one

async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--date", required=True, help="YYYYMMDD")
    p.add_argument("--code", help="If omitted, all codes with JSONL on that date")
    args = p.parse_args()

    data_dir = Path(resolve_data_dir())
    live_dir = data_dir / "live" / args.date
    parquet_root = data_dir / "parquet"

    codes = [args.code] if args.code else [
        p.stem for p in live_dir.glob("*.jsonl")
    ]
    for code in codes:
        jsonl = live_dir / f"{code}.jsonl"
        if not jsonl.exists():
            print(f"skip {code}: no JSONL")
            continue
        target = parquet_root / args.date / code / "kis_live"
        if target.exists():
            print(f"delete {target}")
            shutil.rmtree(target)
        print(f"promote {args.date}/{code}")
        await promote_one(jsonl, parquet_root, code=code, date=args.date)

if __name__ == "__main__":
    asyncio.run(main())
```

운영 순서:
1. backend fix 배포 (uvicorn 재시작 — `--reload` 켜져 있으면 자동).
2. 오늘 20260529: `rm -rf data/parquet/20260529/*/kis_live` — `today_promoter`(5분 주기)가 다음 사이클에 재구축.
3. 과거: `python scripts/repromote_kis_live.py --date 20260527` 및 `--date 20260528`.

### 3. 프런트엔드 sanity clip ([frontend/src/live/buildLiveBundle.ts](../../../frontend/src/live/buildLiveBundle.ts))

`pastMaxQrT` / `pastMaxFsT`를 today의 정상 상한으로 clip.

```ts
// Before — buildLiveBundle.ts:59-68
const pastMaxQrT = pastQRPoints.length > 0
  ? pastQRPoints[pastQRPoints.length - 1].t
  : 0;
const pastMaxFsT = pastFSPoints.length > 0
  ? pastFSPoints[pastFSPoints.length - 1].t
  : 0;

const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs);
const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);

// After — clip dedup 가드를 today close에서 잘라서 backend corruption으로부터 SSE 라이브 보호.
// 정상 past 데이터의 마지막 포인트는 항상 today close_ms 이하이므로 dedup 의미는 동일.
// 2046년 같은 corruption 값이 들어와도 SSE incremental은 정상 통과.
const rawPastMaxQrT = pastQRPoints.length > 0
  ? pastQRPoints[pastQRPoints.length - 1].t
  : 0;
const rawPastMaxFsT = pastFSPoints.length > 0
  ? pastFSPoints[pastFSPoints.length - 1].t
  : 0;
const pastMaxQrT = Math.min(rawPastMaxQrT, todaySession.close_ms);
const pastMaxFsT = Math.min(rawPastMaxFsT, todaySession.close_ms);

const sseBuckets = bucketHogaSeries(sseOb, sseTrade, bucketMs);
const incrementalQR = sseBuckets.quoteRatioPoints.filter((p) => p.t > pastMaxQrT);
const incrementalFS = sseBuckets.fillStrengthPoints.filter((p) => p.t > pastMaxFsT);
```

`todaySession.close_ms`는 같은 함수의 인자로 이미 들어와 있다 ([buildLiveBundle.ts:25](../../../frontend/src/live/buildLiveBundle.ts), [buildLiveBundle.ts:42](../../../frontend/src/live/buildLiveBundle.ts) 시그니처 참조).

### 4. 회귀 테스트

**Backend** — `tests/unit/api/test_bundle_quote_ratio.py` (이미 있으면 추가, 없으면 신규):

```python
def test_build_quote_ratio_slice_t_is_within_day_window(tmp_path, query_engine):
    """ts_ms 인코딩 회귀 가드. 어떤 source이든 결과 t는 day-window 안에 있어야 한다."""
    date = "20260529"
    code = "058610"
    # Fixture: kis_live snapshots.parquet를 unix ms(잘못된 인코딩)로 한 번,
    # HHMMSSmmm(올바른 인코딩)로 한 번 쓰고 두 케이스 모두 회귀 검증.
    # ...
    qr = build_quote_ratio_slice(query_engine, code=code, date=date, source="kis_live")
    day_start = _date_unix_ms_at_kst_midnight(date)
    day_end = day_start + 86_400_000
    for p in qr.points:
        assert day_start <= p.t < day_end, \
            f"point {p.t} outside {date} day window — ts_ms encoding regression"
```

같은 패턴을 `build_fill_strength_slice`에도 적용.

**Frontend** — `frontend/src/live/buildLiveBundle.test.ts`에 케이스 추가:

```ts
it('clips pastMaxQrT to todaySession.close_ms when past has future timestamps', () => {
  const future = todaySession.close_ms + 1_000_000_000_000; // 2046년 시뮬레이션
  const pastBundle = makePastBundle({ quoteRatioTail: [{ t: future, bid_total: 1, ask_total: 1 }] });
  const sseT = todaySession.open_ms + 60_000;
  const sseOb = [{ t_ms: sseT, total_ask_qty: 10, total_bid_qty: 10 }];
  const bundle = buildLiveBundle({ ..., pastBundle, sseOb, sseTrade: [], ... });
  expect(bundle.quote_ratio.points.some(p => p.t === sseT)).toBe(true);
});
```

## Testing

### Unit tests

| Case | Setup | Expected |
|---|---|---|
| build_quote_ratio_slice / kis_live source / HHMMSSmmm fixture | `unix_ms_to_hhmmssms`로 인코딩한 ts_ms를 가진 parquet | 모든 t가 day-window 안 |
| build_quote_ratio_slice / 회귀 가드 | 위 case의 day-window 검증 | t < midnight or t ≥ midnight+24h이면 실패 |
| build_fill_strength_slice / 동일 | (same) | (same) |
| promote `_parse_jsonl_to_records` / 자정 race | t_ms가 date의 다음날에 해당 | 해당 row skip + warning 로그, 나머지 정상 인코딩 |
| buildLiveBundle / past에 future timestamp | quote_ratio.points 마지막이 close_ms 초과 | SSE incremental 포인트가 통과 |
| buildLiveBundle / 정상 past (회귀 방지) | quote_ratio.points 마지막이 close_ms 이하 | dedup 가드가 기존대로 동작, boundary 중복 없음 |

**Invariant 회귀 테스트** (보존 invariant 마다):
- Invariant 1 (`ts_ms` = HHMMSSmmm): writer 테스트로 — 생성된 parquet의 ts_ms를 `hhmmssms_to_unix_ms`로 디코딩 후 원래 Unix ms를 복원할 수 있어야 함.
- Invariant 3 (`t`는 day-window): 위 unit tests에서 lock.
- Invariant 4 (pastMaxQrT 단조성): 정상 past 케이스 테스트로 dedup이 boundary 중복을 막는지 확인.

### Manual verification

1. `/live` 페이지에서 058610 (또는 watchlist 어떤 코드든) 선택 → 1m timeframe → hoga panes (Ratio, QuoteTotals, FillStrength)에 오늘 데이터 라인이 그려진다.
2. 10초 이상 기다리며 SSE 새 포인트가 들어와도 panes가 라이브 업데이트된다.
3. `curl 'http://127.0.0.1:8000/api/range?code=058610&from=20260527&to=20260529&bucket_ms=60000&source_pref=hogaplay'` — quote_ratio / fill_strength의 t 분포가 전부 2026년만.
4. `/replay` 페이지에서 같은 코드/날짜 열어서 hoga 인디케이터가 정상 표시(replay는 hogaplay source라 영향 없어야 하지만 회귀 가드).

## Risks / Open questions

- **자정 race**: KIS poller가 자정 직전에 받아 JSONL에 쓴 row가 자정 직후 promote될 때 `t_ms`의 KST 일자가 `date` 인자와 어긋날 수 있음. [promote.py:172](../../../hoga/live/promote.py)의 `today = _today_kst_yyyymmdd()` 고정 + `cycle_seconds=10` 작동 시간이 market-hours로 제한되는 것이 1차 방어. `unix_ms_to_hhmmssms`의 `ValueError`가 2차 방어로 작동, 해당 row skip + warning. 정상 운영에서는 발생하지 않아야 함.
- **운영 미스 (구버전 backend로 디렉토리 삭제)**: backend fix 미배포 상태로 `rm -rf` 하면 다음 promote 사이클이 또 corrupt 데이터를 씀. 스크립트가 backend 버전을 검증할 수 있다면 안전 — 다만 옵션 A 본 스코프에서는 "운영 순서를 docstring으로 명시"하는 것까지가 적정선. 향후 promote.py에 invariant assertion(`assert ts_ms < 86_400_000`)을 추가하는 follow-up도 가능.
- **JSONL 보존 가정**: `data/live/{date}/{code}.jsonl`이 모두 존재한다는 가정. 실측으로 20260527/28/29 모두 보존 확인됨. 만약 누락 일자가 있다면 그 date는 데이터 손실 — 사용자에게 상태 보고 후 결정.

## Out of Scope (Backlog)

- `/api/orderbook` (sidebar hover spot)과 `/api/brokers/series`의 kis_live source 회귀 테스트. 옵션 A 한 번에 회복은 되지만, 동종 인코딩 실수 재발 시 잡을 가드는 별도 issue로 분리.
- `promote_one()`에 `force=True` 파라미터 추가 (현재 스크립트는 디렉토리 삭제 우회로 충분).
- replay viewer가 kis_live source를 명시적으로 쓰는 시나리오의 동작 검증.
- promote.py에 "ts_ms < 86_400_000" 같은 sanity assertion 추가 (writer-side 인코딩 가드).
- `hoga/api/queries.py:159-165`의 Inventory가 kis_live source를 제외하는 우회로를 제거하고 invariant 회복 후 통합하는 작업.
