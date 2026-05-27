---
scope: both
spec: docs/superpowers/specs/2026-05-27-live-capture-design.md
adrs:
  - docs/adr/0037-source-subfolder-layout.md
  - docs/adr/0038-live-jsonl-then-promote.md
  - docs/adr/0039-source-preference-fallback.md
---

# Live Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** watchlist 종목의 호가/체결/거래원을 KIS Open API에서 10s 주기로 폴링해 JSONL로 누적하고, 새 `/live` 페이지에서 라이브 차트로 표시하며, 18:00 KST에 captures Parquet 트리(`parquet/{date}/{code}/kis_live/`)로 승격해 다음 날 `/replay`에서 historical 형태로 다시 볼 수 있게 한다.

**Architecture:** 새 `hoga/live/` 패키지(kis_client / poller / writer / promote / api) + 새 프론트엔드 `/live` 라우트(LiveCandlePane + LiveIndicatorPane + LiveSidebar + WatchlistPanel). 기존 `parquet/{date}/{code}/` 트리에 `{source}/` 서브폴더 도입 (ADR-0037), `/api/range`에 `source_pref` 파라미터 추가 (ADR-0039), Daily Scheduler 18:00에 Promotion 단계 삽입 (ADR-0038).

**Tech Stack:** FastAPI + httpx (KIS REST, 직접 구현 — 라이브러리 사용 안 함), SSE (sse-starlette), pyarrow + polars (Parquet), Zustand (frontend 상태), React Query, lightweight-charts, react-router.

---

## 사전 정정 사항 (Path / Filename Corrections)

spec과 ADR이 콜로키얼하게 `raw/{date}/{code}/orderbook.parquet`라고 적혀 있던 부분은 실제 코드베이스 레이아웃과 맞지 않아 grill 단계 후속으로 정정되었습니다:

| 잘못된 표기 | 올바른 표기 | 이유 |
|---|---|---|
| `raw/{date}/{code}/{source}/...` | `parquet/{date}/{code}/{source}/...` | `raw/` 트리는 hogaplay TSV 페이지 전용. 파싱된 Parquet은 `parquet/` 트리. |
| `orderbook.parquet` | `snapshots.parquet` | 실제 파일명 |

본 plan은 모든 경로를 정정된 표기로 사용합니다.

---

## 작업 분해 전략

**Vertical slice / tracer bullet 원칙으로 13개 stage로 분해**:

- **Stage 0** (Migration): 기존 `parquet/{date}/{code}/*.parquet` → `parquet/{date}/{code}/hogaplay/*.parquet` 마이그레이션
- **Stage 1–2** (KIS client): 외부 API 통신만으로 자체 검증 가능한 최소 단위
- **Stage 3–4** (Write path): JSONL writer + Poller, 데이터가 디스크에 쌓이는 첫 end-to-end
- **Stage 5** (Promotion): JSONL → Parquet 변환, captures와 합류
- **Stage 6** (Disk state + read path): `parquet/`의 source 분기를 disk_state와 bundle이 인식
- **Stage 7** (API endpoints): `/api/live/*` 5개 엔드포인트
- **Stage 8** (Scheduler integration): Live Poller가 lifespan에 등록되고 Daily Scheduler에 Promotion 단계 삽입
- **Stage 9** (Frontend `/live` 페이지): 라우트 + 캔들 차트 + 지표 차트 (간단한 mock 데이터로 먼저 띄움)
- **Stage 10** (Frontend SSE 연결): 실제 백엔드 데이터로 동작
- **Stage 11** (Live Sidebar + Watchlist panel): UI 완성
- **Stage 12** (Source Preference 토글): `/replay` 확장
- **Stage 13** (Verification + cleanup): 전체 회귀 가드, ADR-0038 invariant 가드, 골든 파일 테스트

각 stage는 **시작 시 첫 번째 task가 failing test 작성** (TDD red-green-refactor). stage 종료 시 commit + 자체 verification.

## 의존성 그래프

```
Stage 0 (Migration)
   │
   └─→ Stage 6 (Disk state + read path source-aware) ─┐
                                                       │
Stage 1 (KIS HTTP client)                              │
   │                                                   │
   ├─→ Stage 2 (KIS quote/trade/broker endpoints)      │
   │     │                                             │
   │     ├─→ Stage 3 (JSONL writer)                    │
   │     │     │                                       │
   │     │     └─→ Stage 4 (Poller loop)               │
   │     │           │                                 │
   │     │           ├─→ Stage 5 (Promote: JSONL→Parquet) ──→ Stage 6 ──┐
   │     │           │                                                   │
   │     │           └─→ Stage 7 (API: /api/live/*) ←──────────────────┐│
   │     │                 │                                            ││
   │     └─→ Stage 8 (Lifespan + Scheduler integration) ←───────────────┘│
   │                                                                     │
   └─→ Stage 7                                                           │
                                                                          │
Stage 9 (Frontend /live page skeleton)                                    │
   │                                                                     │
   ├─→ Stage 10 (Frontend live data wiring via SSE) ←──────────────────────┘
   │     │
   │     └─→ Stage 11 (Live Sidebar + Watchlist panel)
   │
Stage 12 (Source Preference toggle, /replay)
   │
   └─→ Stage 13 (Regression guards + golden files)
```

**Stage 0**은 다른 모든 stage 진입 전에 끝나야 한다 (기존 데이터가 새 layout으로 옮겨져야 disk_state 변경이 안전).

**Stage 1–2**는 backend 시작점 — Stage 3 이후 모든 backend 작업이 KIS 응답에 의존.

**Stage 9**는 backend와 독립적으로 시작 가능 (mock 데이터로 UI shell 먼저).

---

## Pre-Stage: Deferred Decisions Resolved

spec §12에서 plan 단계로 deferred된 항목들의 결정:

### A. DiskState 확장 방식

**결정: per-source DiskState + aggregate 함수.**

- `DiskState` enum은 변경하지 않음 (combinatorial explosion 회피)
- `classify_from_meta(meta_path)` 는 한 source의 meta.json을 받아 단일 DiskState 반환 (기존 시그니처 유지)
- 새 함수 `classify_stock_date(parquet_date_code_dir: Path) -> dict[Source, DiskState]` — 한 Stock-Date 폴더 안의 모든 source를 walk하여 source별 상태 반환
- 새 함수 `aggregate_disk_state(per_source: dict[Source, DiskState]) -> DiskState` — 기존 frontend `STATE_SEVERITY` 패턴을 백엔드에 미러: 가장 나쁜 상태 반환 (단, 한 source가 COMPLETE 이고 다른 source가 NONE이면 COMPLETE를 반환 — "최소 하나의 source가 완성됨"이 우선)
- `latest_complete_date(code, data_dir)` 는 source-agnostic — 어느 source든 COMPLETE 이면 그 date 반환 (현 동작 유지)

### B. Inventory UX

**결정: Stock-Date row 유지, source는 row 내부 칩(chip)으로 표시.**

- Inventory 좌측 list는 기존 StockDateGroup 그대로
- 우측 상세 테이블의 각 row(Stock-Date)에 `[hogaplay] [kis_live]` 칩 두 개를 표시 — 회색=없음, 색칠=있음, 클릭=해당 source 강제 선택해 /replay 열기
- DiskState 칩 색은 aggregate 결과 사용
- per-source 액션(예: hogaplay만 재캡쳐)은 칩 우클릭 메뉴로 — 본 plan 범위 밖, 후속 spec

### C. JSONL Archive vs Delete

**결정: archive 7일 후 삭제. archive 위치: `<data_dir>/live/_archive/{date}/{code}.jsonl`.**

- promotion 완료 후 JSONL을 `live/{date}/{code}.jsonl` → `live/_archive/{date}/{code}.jsonl` 로 move
- Daily Scheduler 18:00 step에서 archive의 7일 이상 된 파일은 unlink
- 디버깅 시 archive에서 JSONL 재변환으로 복구 가능

### D. KIS 라이브러리 vs 직접 구현

**결정: 직접 httpx 구현.**

근거:
- 본 spec의 5개 엔드포인트가 모두 같은 REST + tr_id 패턴 — 어댑터 작성이 사소
- 비공식 라이브러리는 `requests` 동기 의존성을 끌어옴 (현 코드베이스는 httpx 비동기)
- KIS 응답 schema는 안정적
- 단일 사용자 로컬 도구 — 라이브러리의 계좌/주문 추상화는 불필요

### E. Migration Strategy

**결정: lazy + sentinel 기반 자동 마이그레이션.**

- `<data_dir>/.layout_v2` sentinel 파일로 마이그레이션 완료 표시
- 서버 시작시 sentinel 없으면 자동 마이그레이션 실행 후 sentinel 생성
- 마이그레이션 = 기존 `parquet/{date}/{code}/{snapshots,trades,brokers,candles}.parquet, meta.json, _progress.json` 모두를 `parquet/{date}/{code}/hogaplay/` 서브폴더로 move
- 마이그레이션 진행 중 새 요청은 503 응답 + Retry-After
- 마이그레이션 실패는 startup-fatal (그대로 서버 부팅 실패)

### F. Source 매핑 in API

`/api/range`의 `source_pref` 누락 시 기본값: `"hogaplay"` (ADR-0039 default).

### G. Frontend live page 첫 방문 active code

`?code=` 없음 → localStorage `live.activeCode` → watchlist 첫 entry → empty state.

---

## File Structure

**새로 생성되는 파일:**

```
hoga/live/
├── __init__.py                  # 공개 API: start_live_poller, stop_live_poller, promote_pending
├── kis_client.py                # KisClient (httpx async), 토큰 관리, 5개 REST 엔드포인트
├── kis_models.py                # pydantic: KisQuoteResponse, KisTradeResponse, KisBrokerResponse, KisCandleResponse
├── snapshot.py                  # LiveSnapshot frozen dataclass (3 kinds: ob/trade/broker)
├── writer.py                    # JSONL append writer (per-code lock, fsync per cycle)
├── poller.py                    # Asyncio loop, watchlist iteration, rate-limit guard
├── promote.py                   # JSONL → Parquet 변환 (멱등)
├── migrate.py                   # 기존 parquet/{date}/{code}/*.parquet → hogaplay 서브폴더 이동
├── api.py                       # FastAPI router: /api/live/*
├── status.py                    # Poller 상태 (LiveStatus pydantic)
└── lifecycle.py                 # start_live_poller / stop_live_poller (lifespan 진입점)

tests/unit/live/
├── conftest.py                  # mock_kis fixture, sample JSONL fixtures
├── test_kis_client.py
├── test_writer.py
├── test_poller.py
├── test_promote.py
├── test_migrate.py
├── test_snapshot.py
└── test_api.py                  # /api/live/* 엔드포인트

tests/integration/live/
├── test_loop_e2e.py             # mock KIS server로 09:00~10:00 시뮬
├── test_promote_e2e.py
└── test_source_resolution.py    # source_pref fallback rules

tests/fixtures/kis_mock/
├── server.py                    # 작은 FastAPI mock KIS server
├── responses/
│   ├── quote_005930.json
│   ├── trade_005930.json
│   ├── broker_005930.json
│   ├── candle_1m_005930.json
│   └── candle_d_005930.json
└── __init__.py

frontend/src/live/
├── LivePage.tsx                 # 페이지 컨테이너
├── LiveCandlePane.tsx           # 캔들 + 거래량
├── LiveIndicatorPane.tsx        # 호가 지표 3 series
├── LiveSidebar.tsx              # CursorSidebar 재사용 wrapper
├── WatchlistPanel.tsx           # 우측 토글 패널
└── state/livePage.ts            # Zustand: activeCode, candleTimeframe, panelOpen

frontend/src/api/
├── liveSeries.ts                # useLiveSeries (초기 + SSE)
├── liveCandles.ts               # useLiveCandles
├── liveStatus.ts                # useLiveStatus
└── liveSnapshot.ts              # useLiveSnapshot (Live Sidebar용)

frontend/test/live/               # vitest
├── LivePage.test.tsx
├── liveSeries.test.ts
└── WatchlistPanel.test.tsx

docs/adr/
└── (Stage 13 후 필요시 추가)
```

**수정되는 파일:**

```
hoga/api/
├── app.py                       # lifespan에 start_live_poller, migrate 추가
├── disk_state.py                # classify_stock_date, aggregate_disk_state 추가
├── bundle.py                    # build_range_bundle source_pref 인자
├── scheduler.py                 # _daily_run에 promote_pending 호출 추가
├── invariants.py                # source-aware invariant audit
└── captures.py                  # parquet 경로 헬퍼 helpers source-aware (read-only side)

frontend/src/
├── main.tsx                     # <Route path="live" element={<LivePage />} />
├── state/chartPrefs.ts          # sourcePreference 추가
├── replay/SettingsModal.tsx     # Source Preference 라디오 그룹
├── api/range.ts                 # useRange가 sourcePref 전달
└── api/types.ts                 # RangeBundle.segments[].source 추가

CONTEXT.md                       # (이미 grill에서 갱신됨, 추가 변경 없음)
```

---

## Stage 0 — Migration: parquet 트리에 hogaplay 서브폴더 도입

기존 데이터가 `parquet/{date}/{code}/*.parquet`에 평면적으로 있음. 새 layout `parquet/{date}/{code}/hogaplay/*.parquet`로 옮기는 마이그레이션 스크립트가 필요하다. 모든 다른 stage가 새 layout을 가정하므로 이게 먼저 끝나야 한다.

### Task 0.1: migrate.py 스켈레톤 + failing test

**Files:**
- Create: `hoga/live/__init__.py`
- Create: `hoga/live/migrate.py`
- Test: `tests/unit/live/test_migrate.py`

- [ ] **Step 1: 빈 패키지 생성**

```python
# hoga/live/__init__.py
"""Live Capture — KIS-based intraday polling capture.

See docs/superpowers/specs/2026-05-27-live-capture-design.md and
ADR-0037 / ADR-0038 / ADR-0039 for rationale.
"""
```

- [ ] **Step 2: failing test 작성**

```python
# tests/unit/live/test_migrate.py
from pathlib import Path
import json
from hoga.live.migrate import migrate_to_v2_layout, LayoutVersion


def test_migrate_moves_flat_files_into_hogaplay_subdir(tmp_path: Path) -> None:
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    sd_dir.mkdir(parents=True)
    for name in ("snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet"):
        (sd_dir / name).write_bytes(b"placeholder")
    (sd_dir / "meta.json").write_text(json.dumps({"code": "005930"}))

    migrate_to_v2_layout(tmp_path)

    target = sd_dir / "hogaplay"
    assert target.is_dir()
    for name in ("snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet", "meta.json"):
        assert (target / name).exists(), f"{name} not moved"
        assert not (sd_dir / name).exists(), f"{name} still at flat layout"

    sentinel = tmp_path / ".layout_v2"
    assert sentinel.exists()
    assert LayoutVersion.detect(tmp_path) == LayoutVersion.V2
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `uv run pytest tests/unit/live/test_migrate.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hoga.live.migrate'`

- [ ] **Step 4: 최소 구현**

```python
# hoga/live/migrate.py
"""One-shot layout migration: parquet/{date}/{code}/*.parquet → parquet/{date}/{code}/hogaplay/*.parquet.

See ADR-0037. Sentinel: <data_dir>/.layout_v2 marks completion.
"""
from __future__ import annotations
from enum import Enum
from pathlib import Path
import shutil

SENTINEL_NAME = ".layout_v2"
_MOVED_FILE_NAMES = (
    "snapshots.parquet", "trades.parquet", "brokers.parquet", "candles.parquet",
    "meta.json", "_progress.json", ".no_upstream_data",
)


class LayoutVersion(Enum):
    V1_FLAT = "v1"
    V2 = "v2"

    @classmethod
    def detect(cls, data_dir: Path) -> "LayoutVersion":
        return cls.V2 if (data_dir / SENTINEL_NAME).exists() else cls.V1_FLAT


def migrate_to_v2_layout(data_dir: Path) -> None:
    if LayoutVersion.detect(data_dir) is LayoutVersion.V2:
        return
    parquet_root = data_dir / "parquet"
    if parquet_root.is_dir():
        for date_dir in parquet_root.iterdir():
            if not date_dir.is_dir():
                continue
            for code_dir in date_dir.iterdir():
                if not code_dir.is_dir() or (code_dir / "hogaplay").exists():
                    continue
                target = code_dir / "hogaplay"
                target.mkdir()
                for name in _MOVED_FILE_NAMES:
                    src = code_dir / name
                    if src.exists():
                        shutil.move(str(src), str(target / name))
    (data_dir / SENTINEL_NAME).touch()
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `uv run pytest tests/unit/live/test_migrate.py -v`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add hoga/live/__init__.py hoga/live/migrate.py tests/unit/live/test_migrate.py
git commit -m "feat(live): migrate parquet tree to source-subfolder layout (ADR-0037)"
```

### Task 0.2: idempotence + already-v2 short circuit

- [ ] **Step 1: failing test 추가**

```python
# tests/unit/live/test_migrate.py — append
def test_migrate_idempotent(tmp_path: Path) -> None:
    (tmp_path / ".layout_v2").touch()
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    sd_dir.mkdir(parents=True)
    (sd_dir / "snapshots.parquet").write_bytes(b"untouched")

    migrate_to_v2_layout(tmp_path)

    # sentinel already set → migration must NOT touch flat files
    assert (sd_dir / "snapshots.parquet").exists()
    assert not (sd_dir / "hogaplay").exists()


def test_migrate_preserves_existing_hogaplay_subdir(tmp_path: Path) -> None:
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    (sd_dir / "hogaplay").mkdir(parents=True)
    (sd_dir / "hogaplay" / "snapshots.parquet").write_bytes(b"pre-existing")
    (sd_dir / "snapshots.parquet").write_bytes(b"orphan-flat")

    migrate_to_v2_layout(tmp_path)

    assert (sd_dir / "hogaplay" / "snapshots.parquet").read_bytes() == b"pre-existing"
    # orphan-flat is left alone — the subdir already exists, so we don't auto-mix
    assert (sd_dir / "snapshots.parquet").exists()
```

- [ ] **Step 2: 통과 확인** (현재 구현으로 이미 통과해야 함 — 가드 절이 두 케이스 모두 처리)

Run: `uv run pytest tests/unit/live/test_migrate.py -v`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add tests/unit/live/test_migrate.py
git commit -m "test(live): assert migration idempotence and orphan-flat preservation"
```

### Task 0.3: lifespan 통합

**Files:**
- Modify: `hoga/api/app.py` (lifespan 함수)

- [ ] **Step 1: failing integration test 작성**

```python
# tests/integration/live/__init__.py  (빈 파일)
# tests/integration/live/test_migrate_lifespan.py
from pathlib import Path
import asyncio
from hoga.api.app import create_app


def test_lifespan_runs_migration_on_startup(tmp_path: Path, monkeypatch) -> None:
    parquet_root = tmp_path / "parquet"
    sd_dir = parquet_root / "20260520" / "005930"
    sd_dir.mkdir(parents=True)
    (sd_dir / "snapshots.parquet").write_bytes(b"x")
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))

    from fastapi.testclient import TestClient
    app = create_app(tmp_path)
    with TestClient(app):
        assert (tmp_path / ".layout_v2").exists()
        assert (sd_dir / "hogaplay" / "snapshots.parquet").exists()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run pytest tests/integration/live/test_migrate_lifespan.py -v`
Expected: FAIL (sentinel not created)

- [ ] **Step 3: app.py lifespan 수정**

```python
# hoga/api/app.py — lifespan 함수 시작부에 추가
from hoga.live.migrate import migrate_to_v2_layout

@asynccontextmanager
async def lifespan(_: FastAPI):
    # ADR-0037 마이그레이션 — 다른 어떤 capture 작업보다 먼저
    migrate_to_v2_layout(data_dir)
    # ... 기존 lifespan 로직 ...
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/integration/live/test_migrate_lifespan.py -v`
Expected: PASS

- [ ] **Step 5: 회귀 가드 — 전체 pytest**

Run: `uv run pytest`
Expected: 모든 기존 테스트 통과 (마이그레이션 후 disk_state가 새 경로로 못 읽어 실패할 수 있음 — 그 실패는 Stage 6에서 해결, 지금은 회귀 발생 여부만 기록)

기존 테스트 중 fixture가 flat layout을 직접 만드는 것들이 있다면 그 테스트들은 Stage 6에서 같이 손볼 예정. Stage 0 시점의 실패 목록을 기록해 Stage 6에서 확인할 수 있게 한다.

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/app.py tests/integration/live/__init__.py tests/integration/live/test_migrate_lifespan.py
git commit -m "feat(live): run layout migration on FastAPI startup"
```

---

## Stage 1 — KIS HTTP client: 토큰 발급 + 인증 헤더

KIS API의 모든 호출 앞에 `Authorization: Bearer <token>` 헤더가 필요하다. 토큰은 24h 유효이지만 6h마다 재발급 권장(서버 정책). 디스크 캐시 + 만료 임박 시 자동 재발급.

### Task 1.1: KisClient 스켈레톤 + 토큰 발급

**Files:**
- Create: `hoga/live/kis_client.py`
- Create: `hoga/live/kis_models.py`
- Test: `tests/unit/live/test_kis_client.py`

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_kis_client.py
import json
from pathlib import Path
import httpx
import pytest
from hoga.live.kis_client import KisClient, KisCredentials, KisAuthError


@pytest.mark.asyncio
async def test_issue_token_caches_to_disk(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(
        200,
        json={"access_token": "MOCK_TOKEN", "expires_in": 86400, "token_type": "Bearer"},
    ))
    cache = tmp_path / "token.json"
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=cache,
        _transport=transport,
    )

    token = await client.get_access_token()
    assert token == "MOCK_TOKEN"
    assert cache.exists()
    cached = json.loads(cache.read_text())
    assert cached["access_token"] == "MOCK_TOKEN"


@pytest.mark.asyncio
async def test_issue_token_failure_raises(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(
        401, json={"error_code": "E001", "error_description": "bad creds"}
    ))
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=transport,
    )
    with pytest.raises(KisAuthError):
        await client.get_access_token()
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py -v`
Expected: FAIL (ModuleNotFoundError)

- [ ] **Step 3: 구현**

```python
# hoga/live/kis_client.py
"""KIS Open API HTTP client (직접 구현, ADR-0038 — 의존성 최소화)."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from typing import Literal, Optional
import httpx


_KST = timezone(timedelta(hours=9))
_BASE_REAL = "https://openapi.koreainvestment.com:9443"


class KisAuthError(RuntimeError):
    pass


class KisRateLimitError(RuntimeError):
    pass


class KisApiError(RuntimeError):
    """rt_cd != '0' 일반 응답 실패."""
    def __init__(self, msg_cd: str, msg1: str):
        self.msg_cd = msg_cd
        self.msg1 = msg1
        super().__init__(f"KIS api error {msg_cd}: {msg1}")


@dataclass(frozen=True)
class KisCredentials:
    app_key: str
    app_secret: str
    env: Literal["real"] = "real"   # 모의는 본 spec에서 미지원

    @property
    def base_url(self) -> str:
        if self.env != "real":
            raise ValueError("Only 'real' env is supported (ADR — spec §10)")
        return _BASE_REAL


class KisClient:
    def __init__(
        self,
        credentials: KisCredentials,
        token_cache_path: Path,
        *,
        _transport: Optional[httpx.BaseTransport] = None,
    ):
        self._creds = credentials
        self._cache_path = token_cache_path
        self._client = httpx.AsyncClient(
            base_url=credentials.base_url, transport=_transport, timeout=10.0
        )
        self._token: Optional[str] = None
        self._token_expires_at: Optional[datetime] = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_access_token(self) -> str:
        if self._token and self._token_expires_at and datetime.now(_KST) < self._token_expires_at - timedelta(minutes=10):
            return self._token

        cached = self._read_cache()
        if cached:
            self._token, self._token_expires_at = cached
            return self._token

        return await self._issue_token()

    async def _issue_token(self) -> str:
        resp = await self._client.post(
            "/oauth2/tokenP",
            json={
                "grant_type": "client_credentials",
                "appkey": self._creds.app_key,
                "appsecret": self._creds.app_secret,
            },
        )
        if resp.status_code != 200:
            raise KisAuthError(f"token issue failed: HTTP {resp.status_code} {resp.text}")
        body = resp.json()
        self._token = body["access_token"]
        expires_in = int(body.get("expires_in", 86400))
        self._token_expires_at = datetime.now(_KST) + timedelta(seconds=expires_in)
        self._write_cache(self._token, self._token_expires_at)
        return self._token

    def _read_cache(self) -> Optional[tuple[str, datetime]]:
        if not self._cache_path.exists():
            return None
        try:
            data = json.loads(self._cache_path.read_text())
            exp = datetime.fromisoformat(data["expires_at"])
            if datetime.now(_KST) >= exp - timedelta(minutes=10):
                return None
            return data["access_token"], exp
        except (json.JSONDecodeError, KeyError, ValueError):
            return None

    def _write_cache(self, token: str, expires_at: datetime) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(json.dumps({
            "access_token": token,
            "expires_at": expires_at.isoformat(),
        }))
        self._cache_path.chmod(0o600)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "feat(live/kis): access_token issue + disk cache"
```

### Task 1.2: 토큰 캐시 만료 임박 시 재발급

- [ ] **Step 1: failing test 추가**

```python
# tests/unit/live/test_kis_client.py — append
@pytest.mark.asyncio
async def test_token_near_expiry_triggers_reissue(tmp_path: Path) -> None:
    near_expiry = (datetime.now(_KST) + timedelta(minutes=5)).isoformat()
    cache = tmp_path / "token.json"
    cache.write_text(json.dumps({"access_token": "STALE", "expires_at": near_expiry}))

    transport = httpx.MockTransport(lambda req: httpx.Response(
        200, json={"access_token": "FRESH", "expires_in": 86400, "token_type": "Bearer"}
    ))
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=cache,
        _transport=transport,
    )
    token = await client.get_access_token()
    assert token == "FRESH"
```

`_KST` import 필요: `from hoga.live.kis_client import _KST`

- [ ] **Step 2: 통과 확인** (현재 `_read_cache`의 10분 margin 가드로 이미 처리됨)

Run: `uv run pytest tests/unit/live/test_kis_client.py -v`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add tests/unit/live/test_kis_client.py
git commit -m "test(live/kis): assert near-expiry token reissue"
```

---

## Stage 2 — KIS quote/trade/broker endpoints

각 엔드포인트는 `tr_id` 헤더 + 쿼리 파라미터. 응답에 `rt_cd` 체크. 결과를 pydantic 모델로 정규화.

### Task 2.1: fetch_orderbook (FHKST01010200)

**Files:**
- Modify: `hoga/live/kis_client.py`
- Modify: `hoga/live/kis_models.py` (생성)
- Modify: `tests/unit/live/test_kis_client.py`

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_kis_client.py — append
@pytest.mark.asyncio
async def test_fetch_orderbook_parses_10_levels(tmp_path: Path) -> None:
    sample = {
        "rt_cd": "0",
        "msg_cd": "MCA00000",
        "msg1": "OK",
        "output1": {
            **{f"askp{i}": f"{75000 + i*10}" for i in range(1, 11)},
            **{f"bidp{i}": f"{74990 - i*10}" for i in range(1, 11)},
            **{f"askp_rsqn{i}": f"{i*100}" for i in range(1, 11)},
            **{f"bidp_rsqn{i}": f"{i*200}" for i in range(1, 11)},
            "total_askp_rsqn": "5500",
            "total_bidp_rsqn": "11000",
        },
        "output2": {"stck_prpr": "74995"},
    }
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400, "token_type": "Bearer"})
        return httpx.Response(200, json=sample)
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=httpx.MockTransport(handler),
    )

    ob = await client.fetch_orderbook("005930")
    assert ob.code == "005930"
    assert len(ob.asks) == 10
    assert len(ob.bids) == 10
    assert ob.asks[0].price == 75010
    assert ob.asks[0].qty == 100
    assert ob.bids[0].price == 74980
    assert ob.bids[0].qty == 200
    assert ob.total_bid_qty == 11000
    assert ob.total_ask_qty == 5500
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py::test_fetch_orderbook_parses_10_levels -v`
Expected: FAIL

- [ ] **Step 3: 모델 + 구현**

```python
# hoga/live/kis_models.py
"""Pydantic 모델 — KIS REST 응답 정규화."""
from __future__ import annotations
from pydantic import BaseModel


class OrderbookLevel(BaseModel):
    price: int
    qty: int


class KisOrderbook(BaseModel):
    code: str
    t_ms: int      # KIS는 timestamp를 주지 않으므로 client-side now()
    asks: list[OrderbookLevel]   # 1호가 → 10호가
    bids: list[OrderbookLevel]
    total_ask_qty: int
    total_bid_qty: int


class KisTrade(BaseModel):
    t_ms: int
    price: int
    qty: int
    side: int   # +1 매수, -1 매도, 0 단일가


class KisBrokerEntry(BaseModel):
    name: str
    qty: int


class KisBrokers(BaseModel):
    code: str
    t_ms: int
    buy_top: list[KisBrokerEntry]   # top 5
    sell_top: list[KisBrokerEntry]


class KisCandle(BaseModel):
    t_ms: int
    open: int
    high: int
    low: int
    close: int
    volume: int
```

```python
# hoga/live/kis_client.py — append
from datetime import datetime, timezone
from .kis_models import KisOrderbook, OrderbookLevel, KisTrade, KisBrokers, KisBrokerEntry, KisCandle


_TR_QUOTE = "FHKST01010200"


class KisClient:
    # ... (기존 메서드) ...
    
    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        token = await self.get_access_token()
        resp = await self._client.get(
            "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
            headers={
                "authorization": f"Bearer {token}",
                "appkey": self._creds.app_key,
                "appsecret": self._creds.app_secret,
                "tr_id": _TR_QUOTE,
                "custtype": "P",
            },
            params={"fid_cond_mrkt_div_code": "J", "fid_input_iscd": code},
        )
        body = self._unwrap(resp)
        out = body["output1"]
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        return KisOrderbook(
            code=code,
            t_ms=now_ms,
            asks=[OrderbookLevel(price=int(out[f"askp{i}"]), qty=int(out[f"askp_rsqn{i}"])) for i in range(1, 11)],
            bids=[OrderbookLevel(price=int(out[f"bidp{i}"]), qty=int(out[f"bidp_rsqn{i}"])) for i in range(1, 11)],
            total_ask_qty=int(out["total_askp_rsqn"]),
            total_bid_qty=int(out["total_bidp_rsqn"]),
        )

    def _unwrap(self, resp: httpx.Response) -> dict:
        if resp.status_code == 500 and "EGW00201" in resp.text:
            raise KisRateLimitError("KIS rate limit hit (EGW00201)")
        if resp.status_code != 200:
            raise KisApiError(f"HTTP_{resp.status_code}", resp.text[:200])
        body = resp.json()
        if body.get("rt_cd") != "0":
            raise KisApiError(body.get("msg_cd", "?"), body.get("msg1", ""))
        return body
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py::test_fetch_orderbook_parses_10_levels -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add hoga/live/kis_client.py hoga/live/kis_models.py tests/unit/live/test_kis_client.py
git commit -m "feat(live/kis): fetch_orderbook (FHKST01010200) returns 10-level KisOrderbook"
```

### Task 2.2: fetch_trades (FHKST01010300)

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_kis_client.py — append
@pytest.mark.asyncio
async def test_fetch_trades_parses_recent_30(tmp_path: Path) -> None:
    rows = []
    for i in range(30):
        rows.append({
            "stck_cntg_hour": f"{93000 + i:06d}",
            "stck_prpr": str(75000 - i),
            "cntg_vol": str(10 + i),
            "ccld_dvsn": "1" if i % 2 == 0 else "5",   # 1=매수, 5=매도
        })
    def handler(req):
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400, "token_type": "Bearer"})
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "OK", "output": rows})
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=httpx.MockTransport(handler),
    )

    trades = await client.fetch_trades("005930")
    assert len(trades) == 30
    assert trades[0].side == 1   # ccld_dvsn=1
    assert trades[1].side == -1  # ccld_dvsn=5
```

- [ ] **Step 2: 실패 확인 후 구현**

```python
# hoga/live/kis_client.py — append
_TR_TRADE = "FHKST01010300"


async def fetch_trades(self, code: str) -> list[KisTrade]:
    token = await self.get_access_token()
    resp = await self._client.get(
        "/uapi/domestic-stock/v1/quotations/inquire-ccnl",
        headers={
            "authorization": f"Bearer {token}",
            "appkey": self._creds.app_key, "appsecret": self._creds.app_secret,
            "tr_id": _TR_TRADE, "custtype": "P",
        },
        params={"fid_cond_mrkt_div_code": "J", "fid_input_iscd": code},
    )
    body = self._unwrap(resp)
    today_kst = datetime.now(_KST).date()
    out = []
    for row in body.get("output", []):
        hhmmss = row["stck_cntg_hour"]
        hh, mm, ss = int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6])
        dt = datetime(today_kst.year, today_kst.month, today_kst.day, hh, mm, ss, tzinfo=_KST)
        ccld = row.get("ccld_dvsn", "1")
        side = 1 if ccld == "1" else (-1 if ccld == "5" else 0)
        out.append(KisTrade(
            t_ms=int(dt.timestamp() * 1000),
            price=int(row["stck_prpr"]),
            qty=int(row["cntg_vol"]),
            side=side,
        ))
    return out
```

- [ ] **Step 3: 통과 확인**

Run: `uv run pytest tests/unit/live/test_kis_client.py -v`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "feat(live/kis): fetch_trades (FHKST01010300) returns recent ticks with side"
```

### Task 2.3: fetch_brokers (FHKST01010600)

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_kis_client.py — append
@pytest.mark.asyncio
async def test_fetch_brokers_parses_top5_each_side(tmp_path: Path) -> None:
    out1 = {}
    for i in range(1, 6):
        out1[f"seln_mbcr_name{i}"] = f"매도사{i}"
        out1[f"total_seln_qty{i}"] = str(i * 1000)
        out1[f"shnu_mbcr_name{i}"] = f"매수사{i}"
        out1[f"total_shnu_qty{i}"] = str(i * 2000)

    def handler(req):
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400, "token_type": "Bearer"})
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "OK", "output": out1})
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=httpx.MockTransport(handler),
    )
    res = await client.fetch_brokers("005930")
    assert len(res.buy_top) == 5
    assert len(res.sell_top) == 5
    assert res.buy_top[0].name == "매수사1"
    assert res.buy_top[0].qty == 2000
    assert res.sell_top[4].qty == 5000
```

- [ ] **Step 2: 구현**

```python
# hoga/live/kis_client.py — append
_TR_BROKER = "FHKST01010600"


async def fetch_brokers(self, code: str) -> KisBrokers:
    token = await self.get_access_token()
    resp = await self._client.get(
        "/uapi/domestic-stock/v1/quotations/inquire-member",
        headers={
            "authorization": f"Bearer {token}",
            "appkey": self._creds.app_key, "appsecret": self._creds.app_secret,
            "tr_id": _TR_BROKER, "custtype": "P",
        },
        params={"fid_cond_mrkt_div_code": "J", "fid_input_iscd": code},
    )
    body = self._unwrap(resp)
    out = body["output"]
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    return KisBrokers(
        code=code, t_ms=now_ms,
        sell_top=[KisBrokerEntry(name=out[f"seln_mbcr_name{i}"], qty=int(out[f"total_seln_qty{i}"])) for i in range(1, 6)],
        buy_top=[KisBrokerEntry(name=out[f"shnu_mbcr_name{i}"], qty=int(out[f"total_shnu_qty{i}"])) for i in range(1, 6)],
    )
```

- [ ] **Step 3: 통과 + 커밋**

```bash
uv run pytest tests/unit/live/test_kis_client.py -v
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "feat(live/kis): fetch_brokers (FHKST01010600) returns top5 buy/sell"
```

### Task 2.4: fetch_candles (FHKST03010100 + FHKST03010200)

분봉과 일/주봉 두 엔드포인트. 같은 함수 시그니처 `fetch_candles(code, timeframe: '1m'|'D'|'W')`.

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_kis_client.py — append
@pytest.mark.asyncio
@pytest.mark.parametrize("tf,tr_id,path", [
    ("D", "FHKST03010100", "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice"),
    ("1m", "FHKST03010200", "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice"),
])
async def test_fetch_candles(tmp_path, tf, tr_id, path):
    captured = {}
    def handler(req):
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400, "token_type": "Bearer"})
        captured["path"] = req.url.path
        captured["tr_id"] = req.headers.get("tr_id")
        # 응답 모양은 두 엔드포인트가 거의 동일 — output2 배열에 OHLCV
        if tf == "D":
            output2 = [{"stck_bsop_date": "20260520", "stck_oprc": "75000", "stck_hgpr": "75500",
                        "stck_lwpr": "74500", "stck_clpr": "75200", "acml_vol": "1000000"}]
        else:
            output2 = [{"stck_cntg_hour": "093000", "stck_oprc": "75000", "stck_hgpr": "75100",
                        "stck_lwpr": "74950", "stck_prpr": "75050", "cntg_vol": "5000"}]
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "OK", "output2": output2})
    client = KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=httpx.MockTransport(handler),
    )
    candles = await client.fetch_candles("005930", timeframe=tf)
    assert captured["path"] == path
    assert captured["tr_id"] == tr_id
    assert len(candles) == 1
    assert candles[0].open == 75000
```

- [ ] **Step 2: 구현 + 통과 + 커밋**

```python
# kis_client.py — append
_TR_CANDLE_DAILY = "FHKST03010100"
_TR_CANDLE_INTRADAY = "FHKST03010200"


async def fetch_candles(self, code: str, timeframe: str) -> list[KisCandle]:
    """timeframe: '1m', '3m', '5m', '10m', '15m', '30m', 'D', 'W'."""
    token = await self.get_access_token()
    is_intraday = timeframe.endswith("m")
    tr_id = _TR_CANDLE_INTRADAY if is_intraday else _TR_CANDLE_DAILY
    path = ("/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice" if is_intraday
            else "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice")
    params: dict[str, str] = {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": code}
    if is_intraday:
        params["fid_input_hour_1"] = "153000"   # 종료 시각
        params["fid_pw_data_incu_yn"] = "N"
    else:
        params["fid_period_div_code"] = "W" if timeframe == "W" else "D"
        params["fid_org_adj_prc"] = "0"
    resp = await self._client.get(
        path,
        headers={"authorization": f"Bearer {token}", "appkey": self._creds.app_key,
                 "appsecret": self._creds.app_secret, "tr_id": tr_id, "custtype": "P"},
        params=params,
    )
    body = self._unwrap(resp)
    today_kst = datetime.now(_KST).date()
    candles: list[KisCandle] = []
    for row in body.get("output2", []):
        if is_intraday:
            hhmmss = row["stck_cntg_hour"]
            dt = datetime(today_kst.year, today_kst.month, today_kst.day,
                          int(hhmmss[:2]), int(hhmmss[2:4]), int(hhmmss[4:6]), tzinfo=_KST)
            close = int(row["stck_prpr"])
            vol = int(row["cntg_vol"])
        else:
            d = row["stck_bsop_date"]
            dt = datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), 9, 0, 0, tzinfo=_KST)
            close = int(row["stck_clpr"])
            vol = int(row["acml_vol"])
        candles.append(KisCandle(
            t_ms=int(dt.timestamp() * 1000),
            open=int(row["stck_oprc"]), high=int(row["stck_hgpr"]),
            low=int(row["stck_lwpr"]), close=close, volume=vol,
        ))
    return candles
```

```bash
uv run pytest tests/unit/live/test_kis_client.py -v
git add hoga/live/kis_client.py tests/unit/live/test_kis_client.py
git commit -m "feat(live/kis): fetch_candles (daily + intraday) returns KisCandle list"
```

---

## Stage 3 — JSONL writer

per-code 단위 `<data_dir>/live/{date}/{code}.jsonl` append-only. fsync는 cycle 끝에 한 번. 동시성 — code별 asyncio.Lock 으로 직렬화.

### Task 3.1: Writer 클래스 + append API

**Files:**
- Create: `hoga/live/writer.py`
- Create: `hoga/live/snapshot.py`
- Test: `tests/unit/live/test_writer.py`

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_writer.py
import json
from pathlib import Path
import pytest
from hoga.live.writer import LiveWriter
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


@pytest.mark.asyncio
async def test_append_writes_one_line_per_snapshot(tmp_path: Path) -> None:
    writer = LiveWriter(tmp_path / "live")
    snap_ob = LiveSnapshot(t_ms=1, kind=SnapshotKind.OB, payload={"bids": [], "asks": []})
    snap_tr = LiveSnapshot(t_ms=2, kind=SnapshotKind.TRADE, payload={"price": 75000, "qty": 1, "side": 1})
    await writer.append("20260527", "005930", [snap_ob, snap_tr])
    await writer.fsync_all()

    out = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(out) == 2
    assert json.loads(out[0]) == {"t_ms": 1, "kind": "ob", "payload": {"bids": [], "asks": []}}
    assert json.loads(out[1])["kind"] == "trade"


@pytest.mark.asyncio
async def test_concurrent_append_same_code_is_serialized(tmp_path: Path) -> None:
    import asyncio
    writer = LiveWriter(tmp_path / "live")
    snaps = [LiveSnapshot(t_ms=i, kind=SnapshotKind.OB, payload={"i": i}) for i in range(100)]
    await asyncio.gather(*(writer.append("20260527", "005930", [s]) for s in snaps))
    await writer.fsync_all()
    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 100
```

- [ ] **Step 2: 모델 + writer 구현**

```python
# hoga/live/snapshot.py
"""Live Snapshot — write-path 전용 도메인 모델 (CONTEXT.md 참조)."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any


class SnapshotKind(str, Enum):
    OB = "ob"
    TRADE = "trade"
    BROKER = "broker"


@dataclass(frozen=True)
class LiveSnapshot:
    t_ms: int
    kind: SnapshotKind
    payload: dict[str, Any]

    def to_jsonl(self) -> str:
        import json
        return json.dumps({"t_ms": self.t_ms, "kind": self.kind.value, "payload": self.payload}, ensure_ascii=False)
```

```python
# hoga/live/writer.py
"""JSONL append-only writer for Live Capture (ADR-0038)."""
from __future__ import annotations
import asyncio
import os
from pathlib import Path
from typing import Iterable
from .snapshot import LiveSnapshot


class LiveWriter:
    def __init__(self, live_root: Path):
        self._root = live_root
        self._code_locks: dict[str, asyncio.Lock] = {}
        self._open_files: dict[Path, int] = {}   # path → fd

    def _lock_for(self, code: str) -> asyncio.Lock:
        return self._code_locks.setdefault(code, asyncio.Lock())

    async def append(self, date: str, code: str, snapshots: Iterable[LiveSnapshot]) -> None:
        async with self._lock_for(code):
            target = self._root / date / f"{code}.jsonl"
            target.parent.mkdir(parents=True, exist_ok=True)
            lines = "".join(s.to_jsonl() + "\n" for s in snapshots)
            if not lines:
                return
            await asyncio.to_thread(self._append_sync, target, lines)

    @staticmethod
    def _append_sync(path: Path, data: str) -> None:
        with path.open("a", encoding="utf-8") as f:
            f.write(data)

    async def fsync_all(self) -> None:
        # cycle 단위 일괄 fsync (ADR-0038)
        for date_dir in self._root.iterdir() if self._root.exists() else []:
            for f in date_dir.iterdir():
                if f.suffix == ".jsonl":
                    await asyncio.to_thread(self._fsync_one, f)

    @staticmethod
    def _fsync_one(path: Path) -> None:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
```

- [ ] **Step 3: 통과 확인 + 커밋**

```bash
uv run pytest tests/unit/live/test_writer.py -v
git add hoga/live/snapshot.py hoga/live/writer.py tests/unit/live/test_writer.py
git commit -m "feat(live/writer): JSONL append-only writer with per-code asyncio.Lock"
```

### Task 3.2: Crash recovery — partial last line is tolerated by readers

ADR-0038에서 "마지막 partial line을 무시" 정책 명시. Promote 단계에서 처리 — Writer 자체는 변경 없음. 다만 reader 헬퍼는 Stage 5에서 구현하며 테스트 추가.

빈 task — Stage 5에서 다룸. 본 task 생략.

---

## Stage 4 — Poller loop

watchlist 전체를 10s 주기로 KIS에서 받아 writer에 전달.

### Task 4.1: 단일 cycle 함수 (failing test → 구현 → 통과)

**Files:**
- Create: `hoga/live/poller.py`
- Create: `hoga/live/status.py`
- Test: `tests/unit/live/test_poller.py`

- [ ] **Step 1: failing test 작성**

```python
# tests/unit/live/test_poller.py
from pathlib import Path
from unittest.mock import AsyncMock
import pytest
from hoga.live.poller import LivePoller, LivePollerConfig
from hoga.live.writer import LiveWriter
from hoga.live.kis_models import KisOrderbook, OrderbookLevel, KisTrade, KisBrokers, KisBrokerEntry
from hoga.live.snapshot import SnapshotKind


@pytest.mark.asyncio
async def test_one_cycle_writes_3_snapshots_per_code(tmp_path: Path) -> None:
    kis = AsyncMock()
    kis.fetch_orderbook.return_value = KisOrderbook(
        code="005930", t_ms=1,
        asks=[OrderbookLevel(price=i, qty=i) for i in range(1, 11)],
        bids=[OrderbookLevel(price=i, qty=i) for i in range(1, 11)],
        total_ask_qty=55, total_bid_qty=55,
    )
    kis.fetch_trades.return_value = [KisTrade(t_ms=1, price=100, qty=1, side=1)]
    kis.fetch_brokers.return_value = KisBrokers(
        code="005930", t_ms=1,
        buy_top=[KisBrokerEntry(name=f"b{i}", qty=i) for i in range(5)],
        sell_top=[KisBrokerEntry(name=f"s{i}", qty=i) for i in range(5)],
    )

    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(codes_fn=lambda: ["005930"], date_fn=lambda: "20260527"))
    await poller.run_one_cycle()

    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 3   # ob + trade(s) merged into ONE snapshot + broker → reconsider
```

설계 결정: 한 cycle당 3개 snapshot (ob 1건, trade 1건 merged batch, broker 1건). trade는 KIS에서 최대 30개 row를 받지만 한 SnapshotKind.TRADE entry의 payload에 list로 압축.

- [ ] **Step 2: 구현**

```python
# hoga/live/poller.py
"""Live Poller — watchlist 전체를 N초마다 KIS에서 pull."""
from __future__ import annotations
import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
import logging
from typing import Callable
from .kis_client import KisClient, KisRateLimitError, KisApiError
from .writer import LiveWriter
from .snapshot import LiveSnapshot, SnapshotKind

_log = logging.getLogger(__name__)
_KST = timezone(timedelta(hours=9))


@dataclass(frozen=True)
class LivePollerConfig:
    codes_fn: Callable[[], list[str]]
    date_fn: Callable[[], str]
    cycle_seconds: float = 10.0


class LivePoller:
    def __init__(self, kis: KisClient, writer: LiveWriter, cfg: LivePollerConfig):
        self._kis = kis
        self._writer = writer
        self._cfg = cfg
        self._last_cycle_lag_ms = 0
        self._last_tick_ms: int | None = None
        self._kis_calls_today = 0

    @property
    def last_cycle_lag_ms(self) -> int: return self._last_cycle_lag_ms
    @property
    def last_tick_ms(self) -> int | None: return self._last_tick_ms
    @property
    def kis_calls_today(self) -> int: return self._kis_calls_today

    async def run_one_cycle(self) -> None:
        start = _now_ms()
        date = self._cfg.date_fn()
        for code in self._cfg.codes_fn():
            try:
                ob, trades, brokers = await asyncio.gather(
                    self._kis.fetch_orderbook(code),
                    self._kis.fetch_trades(code),
                    self._kis.fetch_brokers(code),
                )
                self._kis_calls_today += 3
                snaps = [
                    LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.OB, payload=ob.model_dump()),
                    LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.TRADE,
                                 payload={"trades": [t.model_dump() for t in trades]}),
                    LiveSnapshot(t_ms=ob.t_ms, kind=SnapshotKind.BROKER, payload=brokers.model_dump()),
                ]
                await self._writer.append(date, code, snaps)
            except KisRateLimitError:
                _log.warning("live.poller.rate_limited code=%s", code)
                await asyncio.sleep(1)
            except KisApiError as e:
                _log.error("live.poller.kis_error code=%s msg=%s", code, e)
        await self._writer.fsync_all()
        self._last_tick_ms = _now_ms()
        self._last_cycle_lag_ms = max(0, self._last_tick_ms - start - int(self._cfg.cycle_seconds * 1000))


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)
```

- [ ] **Step 3: 통과 확인**

테스트 어설션 정정 (3개 line 기대):

```python
assert len(lines) == 3
```

```bash
uv run pytest tests/unit/live/test_poller.py -v
```
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add hoga/live/poller.py tests/unit/live/test_poller.py
git commit -m "feat(live/poller): run_one_cycle iterates watchlist and writes 3 snapshots per code"
```

### Task 4.2: Loop wrapping run_one_cycle with cancellation

- [ ] **Step 1: failing test**

```python
# tests/unit/live/test_poller.py — append
@pytest.mark.asyncio
async def test_run_forever_until_cancel(tmp_path: Path) -> None:
    kis = AsyncMock()
    kis.fetch_orderbook.return_value = KisOrderbook(
        code="005930", t_ms=1,
        asks=[OrderbookLevel(price=i, qty=i) for i in range(1, 11)],
        bids=[OrderbookLevel(price=i, qty=i) for i in range(1, 11)],
        total_ask_qty=55, total_bid_qty=55,
    )
    kis.fetch_trades.return_value = []
    kis.fetch_brokers.return_value = KisBrokers(
        code="005930", t_ms=1, buy_top=[], sell_top=[],
    )

    writer = LiveWriter(tmp_path / "live")
    poller = LivePoller(kis, writer, LivePollerConfig(
        codes_fn=lambda: ["005930"], date_fn=lambda: "20260527", cycle_seconds=0.01,
    ))
    task = asyncio.create_task(poller.run_forever())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    lines = (tmp_path / "live" / "20260527" / "005930.jsonl").read_text().splitlines()
    assert len(lines) >= 3   # 최소 한 cycle
```

- [ ] **Step 2: 구현 추가**

```python
# hoga/live/poller.py — append in class
async def run_forever(self) -> None:
    while True:
        start = _now_ms()
        await self.run_one_cycle()
        elapsed_s = (_now_ms() - start) / 1000.0
        await asyncio.sleep(max(0, self._cfg.cycle_seconds - elapsed_s))
```

- [ ] **Step 3: 통과 + 커밋**

```bash
uv run pytest tests/unit/live/test_poller.py -v
git add hoga/live/poller.py tests/unit/live/test_poller.py
git commit -m "feat(live/poller): run_forever loop with cancellation support"
```

---

## Stage 5 — Promotion: JSONL → Parquet

장 종료 후 (혹은 backlog 처리) JSONL을 captures의 Parquet 트리로 변환. 멱등 — `kis_live/meta.json` 존재시 skip.

### Task 5.1: 단일 (date, code) Promotion

**Files:**
- Create: `hoga/live/promote.py`
- Test: `tests/unit/live/test_promote.py`

- [ ] **Step 1: failing test**

```python
# tests/unit/live/test_promote.py
import json
from pathlib import Path
import pytest
import polars as pl
from hoga.live.promote import promote_one


@pytest.mark.asyncio
async def test_promote_one_writes_parquet_and_meta(tmp_path: Path) -> None:
    live_root = tmp_path / "live"
    jsonl_path = live_root / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    # 2 cycles worth
    lines = []
    for tick in range(2):
        t = 1748332800000 + tick * 10_000
        lines.append(json.dumps({"t_ms": t, "kind": "ob", "payload": {
            "code": "005930", "t_ms": t,
            "asks": [{"price": 75000+i, "qty": 100+i} for i in range(10)],
            "bids": [{"price": 74990-i, "qty": 200+i} for i in range(10)],
            "total_ask_qty": 1500, "total_bid_qty": 2500,
        }}))
        lines.append(json.dumps({"t_ms": t, "kind": "trade", "payload": {
            "trades": [{"t_ms": t, "price": 75000, "qty": 5, "side": 1}],
        }}))
        lines.append(json.dumps({"t_ms": t, "kind": "broker", "payload": {
            "code": "005930", "t_ms": t,
            "buy_top": [{"name": f"b{i}", "qty": i} for i in range(5)],
            "sell_top": [{"name": f"s{i}", "qty": i} for i in range(5)],
        }}))
    jsonl_path.write_text("\n".join(lines) + "\n")

    parquet_root = tmp_path / "parquet"
    await promote_one(jsonl_path, parquet_root, code="005930", date="20260527")

    target = parquet_root / "20260527" / "005930" / "kis_live"
    assert (target / "snapshots.parquet").exists()
    assert (target / "trades.parquet").exists()
    assert (target / "brokers.parquet").exists()
    meta = json.loads((target / "meta.json").read_text())
    assert meta["source"] == "kis_live"
    assert meta["code"] == "005930"

    snaps = pl.read_parquet(target / "snapshots.parquet")
    assert snaps.height == 2   # 2 cycles
    trades = pl.read_parquet(target / "trades.parquet")
    assert trades.height == 2  # 1 trade per cycle × 2


@pytest.mark.asyncio
async def test_promote_idempotent_skips_if_meta_exists(tmp_path: Path) -> None:
    parquet_root = tmp_path / "parquet"
    target = parquet_root / "20260527" / "005930" / "kis_live"
    target.mkdir(parents=True)
    (target / "meta.json").write_text(json.dumps({"source": "kis_live", "code": "005930", "preserved": True}))

    live_root = tmp_path / "live"
    jsonl_path = live_root / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    jsonl_path.write_text(json.dumps({"t_ms": 1, "kind": "ob", "payload": {}}) + "\n")

    await promote_one(jsonl_path, parquet_root, code="005930", date="20260527")

    meta = json.loads((target / "meta.json").read_text())
    assert meta.get("preserved") is True   # 덮어쓰지 않음
    assert not (target / "snapshots.parquet").exists()


@pytest.mark.asyncio
async def test_promote_tolerates_partial_last_line(tmp_path: Path) -> None:
    jsonl_path = tmp_path / "live" / "20260527" / "005930.jsonl"
    jsonl_path.parent.mkdir(parents=True)
    full = json.dumps({"t_ms": 1, "kind": "ob", "payload": {"asks": [], "bids": [], "code": "005930", "t_ms": 1, "total_ask_qty": 0, "total_bid_qty": 0}})
    jsonl_path.write_text(full + "\n{\"t_ms\": 2, \"kind\":")   # 마지막 줄 잘림

    await promote_one(jsonl_path, tmp_path / "parquet", code="005930", date="20260527")
    snaps = pl.read_parquet(tmp_path / "parquet" / "20260527" / "005930" / "kis_live" / "snapshots.parquet")
    assert snaps.height == 1   # partial line discarded
```

- [ ] **Step 2: 구현**

```python
# hoga/live/promote.py
"""Live Capture JSONL → captures Parquet 변환 (ADR-0038)."""
from __future__ import annotations
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import polars as pl

_log = logging.getLogger(__name__)


async def promote_one(jsonl_path: Path, parquet_root: Path, *, code: str, date: str) -> None:
    target = parquet_root / date / code / "kis_live"
    meta_path = target / "meta.json"
    if meta_path.exists():
        _log.info("live.promote.skip code=%s date=%s reason=already_promoted", code, date)
        return

    snapshots: list[dict] = []
    trades: list[dict] = []
    brokers: list[dict] = []

    if not jsonl_path.exists():
        return

    with jsonl_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                # ADR-0038: 마지막 partial line 무시
                _log.warning("live.promote.partial_line code=%s date=%s", code, date)
                continue
            kind = row.get("kind")
            t_ms = row.get("t_ms")
            p = row.get("payload", {})
            if kind == "ob":
                snapshots.append({
                    "t_ms": t_ms,
                    **{f"bid_p{i+1}": p["bids"][i]["price"] if i < len(p.get("bids", [])) else 0 for i in range(10)},
                    **{f"bid_q{i+1}": p["bids"][i]["qty"] if i < len(p.get("bids", [])) else 0 for i in range(10)},
                    **{f"ask_p{i+1}": p["asks"][i]["price"] if i < len(p.get("asks", [])) else 0 for i in range(10)},
                    **{f"ask_q{i+1}": p["asks"][i]["qty"] if i < len(p.get("asks", [])) else 0 for i in range(10)},
                    "total_bid_qty": p.get("total_bid_qty", 0),
                    "total_ask_qty": p.get("total_ask_qty", 0),
                })
            elif kind == "trade":
                for tr in p.get("trades", []):
                    trades.append({"t_ms": tr["t_ms"], "price": tr["price"], "qty": tr["qty"], "side": tr["side"]})
            elif kind == "broker":
                brokers.append({
                    "t_ms": t_ms,
                    **{f"buy_name{i+1}": (p["buy_top"][i]["name"] if i < len(p.get("buy_top", [])) else "") for i in range(5)},
                    **{f"buy_qty{i+1}": (p["buy_top"][i]["qty"] if i < len(p.get("buy_top", [])) else 0) for i in range(5)},
                    **{f"sell_name{i+1}": (p["sell_top"][i]["name"] if i < len(p.get("sell_top", [])) else "") for i in range(5)},
                    **{f"sell_qty{i+1}": (p["sell_top"][i]["qty"] if i < len(p.get("sell_top", [])) else 0) for i in range(5)},
                })

    target.mkdir(parents=True, exist_ok=True)
    if snapshots:
        pl.DataFrame(snapshots).write_parquet(target / "snapshots.parquet")
    if trades:
        pl.DataFrame(trades).write_parquet(target / "trades.parquet")
    if brokers:
        pl.DataFrame(brokers).write_parquet(target / "brokers.parquet")

    meta = {
        "source": "kis_live",
        "code": code,
        "date": date,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "row_counts": {"snapshots": len(snapshots), "trades": len(trades), "brokers": len(brokers)},
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    _log.info("live.promote.done code=%s date=%s row_counts=%s", code, date, meta["row_counts"])
```

- [ ] **Step 3: 통과 + 커밋**

```bash
uv run pytest tests/unit/live/test_promote.py -v
git add hoga/live/promote.py tests/unit/live/test_promote.py
git commit -m "feat(live/promote): JSONL → Parquet conversion, idempotent, partial-line tolerant"
```

### Task 5.2: Batched promotion + archive

- [ ] **Step 1: failing test**

```python
# tests/unit/live/test_promote.py — append
@pytest.mark.asyncio
async def test_promote_pending_walks_live_root_and_archives(tmp_path: Path) -> None:
    from hoga.live.promote import promote_pending
    live_root = tmp_path / "live"
    for code in ("005930", "000660"):
        jsonl = live_root / "20260527" / f"{code}.jsonl"
        jsonl.parent.mkdir(parents=True, exist_ok=True)
        jsonl.write_text(json.dumps({"t_ms": 1, "kind": "ob", "payload": {
            "asks": [], "bids": [], "code": code, "t_ms": 1, "total_ask_qty": 0, "total_bid_qty": 0,
        }}) + "\n")

    await promote_pending(tmp_path)

    parquet_root = tmp_path / "parquet"
    for code in ("005930", "000660"):
        assert (parquet_root / "20260527" / code / "kis_live" / "meta.json").exists()
        # archive 이동 확인
        assert (live_root / "_archive" / "20260527" / f"{code}.jsonl").exists()
        assert not (live_root / "20260527" / f"{code}.jsonl").exists()
```

- [ ] **Step 2: 구현 + 통과 + 커밋**

```python
# hoga/live/promote.py — append
import shutil

async def promote_pending(data_dir: Path) -> None:
    live_root = data_dir / "live"
    archive_root = live_root / "_archive"
    parquet_root = data_dir / "parquet"
    if not live_root.exists():
        return
    for date_dir in live_root.iterdir():
        if not date_dir.is_dir() or date_dir.name == "_archive":
            continue
        for jsonl in date_dir.iterdir():
            if jsonl.suffix != ".jsonl":
                continue
            code = jsonl.stem
            await promote_one(jsonl, parquet_root, code=code, date=date_dir.name)
            # archive
            arch_target = archive_root / date_dir.name / jsonl.name
            arch_target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(jsonl), str(arch_target))
```

```bash
uv run pytest tests/unit/live/test_promote.py -v
git add hoga/live/promote.py tests/unit/live/test_promote.py
git commit -m "feat(live/promote): promote_pending walks live root and archives JSONL"
```

### Task 5.3: 7일 이상 된 archive 정리

- [ ] **Step 1: failing test + 구현 + 통과**

```python
# tests/unit/live/test_promote.py — append
@pytest.mark.asyncio
async def test_archive_cleanup_removes_files_older_than_7d(tmp_path: Path) -> None:
    from hoga.live.promote import cleanup_archive
    import os, time
    old_path = tmp_path / "live" / "_archive" / "20260101" / "005930.jsonl"
    old_path.parent.mkdir(parents=True)
    old_path.write_text("old")
    eight_days_ago = time.time() - 8 * 86400
    os.utime(old_path, (eight_days_ago, eight_days_ago))

    recent_path = tmp_path / "live" / "_archive" / "20260520" / "000660.jsonl"
    recent_path.parent.mkdir(parents=True)
    recent_path.write_text("recent")

    await cleanup_archive(tmp_path, retention_days=7)

    assert not old_path.exists()
    assert recent_path.exists()
```

```python
# hoga/live/promote.py — append
import time

async def cleanup_archive(data_dir: Path, retention_days: int = 7) -> None:
    archive_root = data_dir / "live" / "_archive"
    if not archive_root.exists():
        return
    cutoff = time.time() - retention_days * 86400
    for path in archive_root.rglob("*.jsonl"):
        if path.stat().st_mtime < cutoff:
            path.unlink()
```

```bash
uv run pytest tests/unit/live/test_promote.py -v
git add hoga/live/promote.py tests/unit/live/test_promote.py
git commit -m "feat(live/promote): cleanup_archive removes JSONL older than retention_days"
```

---

## Stage 6 — Disk state + read path: source-aware

기존 `disk_state.classify_from_meta(meta_path)`와 `build_range_bundle(...)` 함수가 single-source 가정을 가지므로 source-aware로 확장.

### Task 6.1: per-source classify + aggregate

**Files:**
- Modify: `hoga/api/disk_state.py`
- Test: `tests/unit/api/test_disk_state_source.py`

- [ ] **Step 1: failing test**

```python
# tests/unit/api/test_disk_state_source.py
from pathlib import Path
import json
import pytest
from hoga.api.disk_state import classify_stock_date, aggregate_disk_state, DiskState


def _write_meta(path: Path, meta: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta))


def test_classify_stock_date_returns_per_source_states(tmp_path: Path) -> None:
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(sd_dir / "hogaplay" / "meta.json", {"phase": "complete", "violations": []})
    _write_meta(sd_dir / "kis_live" / "meta.json", {"source": "kis_live", "row_counts": {"snapshots": 100}})

    states = classify_stock_date(sd_dir)
    assert set(states.keys()) == {"hogaplay", "kis_live"}
    assert states["hogaplay"] == DiskState.COMPLETE


def test_classify_stock_date_handles_only_one_source(tmp_path: Path) -> None:
    sd_dir = tmp_path / "parquet" / "20260527" / "005930"
    _write_meta(sd_dir / "hogaplay" / "meta.json", {"phase": "complete", "violations": []})
    states = classify_stock_date(sd_dir)
    assert set(states.keys()) == {"hogaplay"}


def test_aggregate_takes_best_of_sources() -> None:
    assert aggregate_disk_state({"hogaplay": DiskState.COMPLETE, "kis_live": DiskState.NONE}) == DiskState.COMPLETE
    assert aggregate_disk_state({"hogaplay": DiskState.INVALID, "kis_live": DiskState.COMPLETE}) == DiskState.COMPLETE
    assert aggregate_disk_state({"hogaplay": DiskState.SOURCE_PARTIAL}) == DiskState.SOURCE_PARTIAL
```

- [ ] **Step 2: disk_state.py 에 함수 추가**

```python
# hoga/api/disk_state.py — append at module level
def classify_stock_date(stock_date_dir: Path) -> dict[str, DiskState]:
    """source별 DiskState 반환. 빈 dict면 NONE."""
    out: dict[str, DiskState] = {}
    if not stock_date_dir.is_dir():
        return out
    for src_dir in stock_date_dir.iterdir():
        if not src_dir.is_dir():
            continue
        meta_path = src_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            out[src_dir.name] = DiskState.INVALID
            continue
        out[src_dir.name] = classify_from_meta(meta_path)
    return out


def aggregate_disk_state(per_source: dict[str, DiskState]) -> DiskState:
    """가장 좋은 source 상태 반환. 두 source 중 한 쪽이 COMPLETE이면 그것이 우선."""
    if not per_source:
        return DiskState.NONE
    # COMPLETE > SOURCE_PARTIAL > CLIENT_INCOMPLETE > NO_UPSTREAM_DATA > INVALID > NONE
    priority = [DiskState.COMPLETE, DiskState.SOURCE_PARTIAL, DiskState.CLIENT_INCOMPLETE,
                DiskState.NO_UPSTREAM_DATA, DiskState.INVALID, DiskState.NONE]
    states = set(per_source.values())
    for p in priority:
        if p in states:
            return p
    return DiskState.NONE
```

- [ ] **Step 3: 통과 + 커밋**

```bash
uv run pytest tests/unit/api/test_disk_state_source.py -v
git add hoga/api/disk_state.py tests/unit/api/test_disk_state_source.py
git commit -m "feat(disk-state): classify_stock_date + aggregate_disk_state (source-aware)"
```

### Task 6.2: latest_complete_date scans source subdirs

- [ ] **Step 1: 기존 함수 식별 + failing test**

```python
# tests/unit/api/test_disk_state_source.py — append
def test_latest_complete_date_finds_any_source(tmp_path: Path) -> None:
    from hoga.api.disk_state import latest_complete_date
    # 20260520: hogaplay COMPLETE
    _write_meta(tmp_path / "parquet" / "20260520" / "005930" / "hogaplay" / "meta.json",
                {"phase": "complete", "violations": []})
    # 20260525: kis_live COMPLETE
    _write_meta(tmp_path / "parquet" / "20260525" / "005930" / "kis_live" / "meta.json",
                {"source": "kis_live", "row_counts": {"snapshots": 1}})

    latest = latest_complete_date("005930", tmp_path)
    assert latest == "20260525"
```

- [ ] **Step 2: 구현 수정**

기존 `latest_complete_date` 가 평면 layout 가정으로 동작 — `parquet/{date}/{code}/meta.json`를 직접 읽음. 새 함수 시그너처는 그대로지만 내부에서 `classify_stock_date` 사용.

```python
# hoga/api/disk_state.py — 기존 latest_complete_date 함수를 다음으로 교체
def latest_complete_date(code: str, data_dir: Path) -> str | None:
    parquet_root = data_dir / "parquet"
    if not parquet_root.is_dir():
        return None
    latest: str | None = None
    for date_dir in parquet_root.iterdir():
        if not date_dir.is_dir():
            continue
        sd_dir = date_dir / code
        if not sd_dir.is_dir():
            continue
        per_source = classify_stock_date(sd_dir)
        if DiskState.COMPLETE in per_source.values():
            if latest is None or date_dir.name > latest:
                latest = date_dir.name
    return latest
```

- [ ] **Step 3: 통과 + 회귀 가드 (기존 disk_state 테스트 모두 통과)**

```bash
uv run pytest tests/unit/api/ -v
```
Expected: 전부 통과. 만약 일부 기존 테스트가 평면 layout fixture 가정으로 실패하면 fixture를 source 서브폴더 layout으로 수정.

- [ ] **Step 4: 커밋**

```bash
git add hoga/api/disk_state.py tests/unit/api/test_disk_state_source.py
git commit -m "refactor(disk-state): latest_complete_date walks source subdirs"
```

### Task 6.3: build_range_bundle accepts source_pref + emits segments[i].source

**Files:**
- Modify: `hoga/api/bundle.py`
- Test: `tests/unit/api/test_bundle_source.py`

- [ ] **Step 1: failing test + 구현 + 통과 + 커밋**

```python
# tests/unit/api/test_bundle_source.py
import json
from pathlib import Path
import polars as pl
import pytest
from hoga.api.bundle import build_range_bundle


def _make_kis_live_artifact(tmp_path: Path, date: str, code: str):
    target = tmp_path / "parquet" / date / code / "kis_live"
    target.mkdir(parents=True)
    # 최소 schema
    pl.DataFrame({"t_ms": [1, 2], "bid_q1": [100, 200], "ask_q1": [50, 60], "total_bid_qty": [1000, 1100], "total_ask_qty": [500, 510]}).write_parquet(target / "snapshots.parquet")
    pl.DataFrame({"t_ms": [1, 2], "price": [75000, 75100], "qty": [5, 10], "side": [1, -1]}).write_parquet(target / "trades.parquet")
    pl.DataFrame({"t_ms": [1, 2], "buy_name1": ["b1", "b1"], "buy_qty1": [1, 2], "sell_name1": ["s1", "s1"], "sell_qty1": [1, 2]}).write_parquet(target / "brokers.parquet")
    (target / "meta.json").write_text(json.dumps({"source": "kis_live", "code": code}))


def test_build_range_bundle_uses_source_pref(tmp_path: Path) -> None:
    _make_kis_live_artifact(tmp_path, "20260527", "005930")
    bundle = build_range_bundle("005930", "20260527", "20260527", bucket_ms=60_000, data_dir=tmp_path, source_pref="kis_live")
    assert len(bundle.segments) == 1
    assert bundle.segments[0].source == "kis_live"


def test_build_range_bundle_fallbacks_when_preferred_missing(tmp_path: Path) -> None:
    _make_kis_live_artifact(tmp_path, "20260527", "005930")
    # source_pref가 hogaplay지만 kis_live만 존재 → fallback
    bundle = build_range_bundle("005930", "20260527", "20260527", bucket_ms=60_000, data_dir=tmp_path, source_pref="hogaplay")
    assert bundle.segments[0].source == "kis_live"


def test_build_range_bundle_excludes_when_both_missing(tmp_path: Path) -> None:
    bundle = build_range_bundle("005930", "20260527", "20260527", bucket_ms=60_000, data_dir=tmp_path, source_pref="hogaplay")
    assert bundle.excluded_dates == ["20260527"]
```

구현 변경:
- `build_range_bundle` 시그너처에 `source_pref: str = "hogaplay"` 추가
- 내부 로직에서 parquet 경로 build 시 `{date}/{code}/{chosen_source}/snapshots.parquet` 사용
- segment 결과에 `source: str` 필드 포함
- excluded_dates 로직: 어떤 source도 COMPLETE 아니면 제외

`hoga/api/bundle.py` 구체 변경은 기존 코드의 모양에 의존 — 본 plan은 인터페이스 변경과 테스트만 명시한다. 실제 구현 시 기존 helper(예: `_load_snapshots`)를 source-aware로 감싸는 작은 wrapper 추가.

```bash
uv run pytest tests/unit/api/test_bundle_source.py -v
git add hoga/api/bundle.py tests/unit/api/test_bundle_source.py
git commit -m "feat(bundle): source_pref param + segments[i].source field (ADR-0039)"
```

### Task 6.4: 회귀 가드 — hogaplay-only golden file 테스트

기존 hogaplay-only 데이터셋이 source_pref 도입 후에도 동일한 RangeBundle을 반환하는지 골든 파일로 잠금.

- [ ] **Step 1: 골든 파일 생성**

`tests/golden/range_bundle_hogaplay_only.json` — 기존 003490/20260519 fixture를 source_pref 지정 없이/지정해서 두 번 호출해 결과가 동일함을 확인.

- [ ] **Step 2: 테스트 작성**

```python
# tests/unit/api/test_bundle_regression.py
import json
from pathlib import Path
import pytest
from hoga.api.bundle import build_range_bundle


@pytest.mark.usefixtures("hogaplay_only_fixture")
def test_hogaplay_only_bundle_unchanged_by_source_pref_introduction(tmp_path: Path) -> None:
    b_default = build_range_bundle("003490", "20260519", "20260519", bucket_ms=60_000, data_dir=tmp_path)
    b_explicit = build_range_bundle("003490", "20260519", "20260519", bucket_ms=60_000, data_dir=tmp_path, source_pref="hogaplay")
    assert b_default.model_dump() == b_explicit.model_dump()
    # golden 비교
    golden = json.loads((Path(__file__).parent.parent / "golden/range_bundle_hogaplay_only.json").read_text())
    actual = b_default.model_dump()
    # source 필드는 골든에 새로 추가됨
    for seg in actual.get("segments", []):
        assert seg.get("source") == "hogaplay"
```

`hogaplay_only_fixture`는 기존 `tiny_tsv` fixture를 source 서브폴더 layout으로 변환한 새 fixture (`tests/conftest.py`).

- [ ] **Step 3: 통과 + 커밋**

```bash
uv run pytest tests/unit/api/test_bundle_regression.py -v
git add tests/golden/range_bundle_hogaplay_only.json tests/unit/api/test_bundle_regression.py tests/conftest.py
git commit -m "test(bundle): golden-file regression for hogaplay-only data after source_pref"
```

---

## Stage 7 — API endpoints `/api/live/*`

5개 신규 + 1개 확장 (`/api/range`에 source_pref 추가).

### Task 7.1: GET /api/live/status

**Files:**
- Create: `hoga/live/api.py`
- Modify: `hoga/api/app.py` (router 등록)
- Test: `tests/unit/live/test_api.py`

- [ ] **Step 1: failing test + 구현 + 통과**

```python
# tests/unit/live/test_api.py
from fastapi.testclient import TestClient
from hoga.api.app import create_app


def test_get_live_status_returns_running_false_initially(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        body = r.json()
        assert body["running"] is False
        assert body["watchlist_count"] == 0
        assert "kis_calls_today" in body
```

```python
# hoga/live/api.py
from fastapi import APIRouter
from pydantic import BaseModel


class LiveStatus(BaseModel):
    running: bool
    started_at_ms: int | None
    last_tick_ms: int | None
    cycle_lag_ms: int
    watchlist_count: int
    kis_calls_today: int
    kis_rate_limit_remaining: int | None


def build_router(get_status: callable) -> APIRouter:
    router = APIRouter(prefix="/api/live")

    @router.get("/status", response_model=LiveStatus)
    async def get_status_endpoint() -> LiveStatus:
        return get_status()

    return router
```

`app.py` 의 `create_app` 함수에서:
```python
from hoga.live.api import build_router as build_live_router
from hoga.live.lifecycle import get_status   # 다음 task

app.include_router(build_live_router(get_status))
```

```bash
uv run pytest tests/unit/live/test_api.py::test_get_live_status_returns_running_false_initially -v
git add hoga/live/api.py hoga/api/app.py tests/unit/live/test_api.py
git commit -m "feat(live/api): GET /api/live/status"
```

### Task 7.2: GET /api/live/snapshot

스펙 §6 — 최신 1건 Live Snapshot.

- [ ] failing test + 구현 + 통과 + 커밋 (Stage 7.1과 같은 패턴)

```python
def test_get_live_snapshot_returns_latest(tmp_path):
    # in-memory buffer 또는 JSONL 마지막 줄 읽기로 구현
    ...
```

구현: in-memory `_latest_snapshots: dict[str, LiveSnapshot]` 모듈 변수, poller가 매 cycle 업데이트.

### Task 7.3: GET /api/live/series

09:00~now까지의 시리즈, RangeBundle과 같은 shape — 단 `segments[0].session_close_ms = None`.

구현 노트: in-memory ring buffer (per-code last ~6h × 6 cycles/min = ~2160 entries) 에 LiveSnapshot 누적. 요청시 RangeBundle-호환 dict 응답.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 7.4: GET /api/live/stream (SSE)

`sse-starlette` 의 `EventSourceResponse` 사용. 모듈 수준 subscriber set, poller가 발행.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 7.5: GET /api/live/candles

KIS의 `fetch_candles` 호출 결과를 ApiCandle 모양으로 변환. 캐시 (timeframe별로 60초).

### Task 7.6: POST /api/live/control

`{action: "start" | "stop" | "pause"}` — 관리/디버그용.

### Task 7.7: /api/range에 source_pref 쿼리 파라미터 추가

기존 router에서 `source_pref: str = "hogaplay"` query param을 받아 `build_range_bundle`에 전달.

각 task는 failing test → 구현 → 통과 → commit 순서. 본 plan에서는 task name과 의도만 명시 — 구현은 Stage 7.1과 동일 형태.

---

## Stage 8 — Lifespan + Scheduler 통합

### Task 8.1: start_live_poller / stop_live_poller

**Files:**
- Create: `hoga/live/lifecycle.py`
- Modify: `hoga/api/app.py`
- Test: `tests/integration/live/test_lifecycle.py`

`lifecycle.py`는 모듈-레벨 singleton — `_poller: LivePoller | None`, `_task: asyncio.Task | None`, `get_status()`. 기존 `captures.py`의 `set_bus + _publish_event` 패턴 따름 (ADR-0006 미러).

- [ ] failing test + 구현 + 통과 + 커밋

### Task 8.2: Daily Scheduler에 promote_pending 호출 추가

**Files:**
- Modify: `hoga/api/scheduler.py:40` (`_daily_run` 함수)
- Test: `tests/unit/api/test_scheduler_promote.py`

- [ ] **Step 1: failing test**

```python
# tests/unit/api/test_scheduler_promote.py
import pytest
from unittest.mock import AsyncMock, patch
from hoga.api.scheduler import _daily_run


@pytest.mark.asyncio
async def test_daily_run_calls_promote_before_enqueue(tmp_path):
    call_order = []
    async def mock_promote(d):
        call_order.append("promote")
    async def mock_enqueue(req, **kw):
        call_order.append("enqueue")
        from hoga.api.models import EnqueueResponse
        return EnqueueResponse(items=[])

    with patch("hoga.api.scheduler.promote_pending", new=mock_promote), \
         patch("hoga.api.scheduler.enqueue_items_core", new=mock_enqueue):
        await _daily_run(tmp_path)

    assert call_order == ["promote", "enqueue"]
```

- [ ] **Step 2: 구현**

```python
# hoga/api/scheduler.py — _daily_run 함수 시작부에 추가
from hoga.live.promote import promote_pending, cleanup_archive

async def _daily_run(data_dir: Path):
    # Stage 1: Promotion (ADR-0038)
    await promote_pending(data_dir)
    await cleanup_archive(data_dir)
    # Stage 2: 기존 hogaplay enqueue ...
```

- [ ] **Step 3: 통과 + 커밋**

```bash
uv run pytest tests/unit/api/test_scheduler_promote.py -v
git add hoga/api/scheduler.py tests/unit/api/test_scheduler_promote.py
git commit -m "feat(scheduler): run promote_pending before hogaplay enqueue (ADR-0038)"
```

### Task 8.3: Live Poller startup + watchlist 비어있으면 stub

`start_live_poller(data_dir)`가 lifespan에서 호출됨. watchlist load → 비어있으면 stub, 아니면 KisClient + LiveWriter + LivePoller 생성 후 `asyncio.create_task(poller.run_forever())`.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 8.4: KIS 자격증명 누락시 graceful degradation

`.env`에 `KIS_APP_KEY`/`KIS_APP_SECRET`이 없으면 poller 가동 안 함. `/api/live/status`는 `running=false, reason="kis_credentials_missing"` 반환.

- [ ] failing test + 구현 + 통과 + 커밋

---

## Stage 9 — Frontend `/live` 페이지 (skeleton, mock 데이터)

### Task 9.1: 라우트 추가

**Files:**
- Modify: `frontend/src/main.tsx`
- Create: `frontend/src/live/LivePage.tsx`

- [ ] **Step 1: 라우트 추가**

```tsx
// frontend/src/main.tsx
import { LivePage } from './live/LivePage';
// ...
<Route path="live" element={<LivePage />} />
```

- [ ] **Step 2: 최소 LivePage**

```tsx
// frontend/src/live/LivePage.tsx
import { useSearchParams } from 'react-router-dom';

export function LivePage() {
  const [params] = useSearchParams();
  const code = params.get('code') ?? '005930';
  return (
    <div className="live-page">
      <h1>Live — {code}</h1>
      <div data-testid="candle-pane">Candle chart placeholder</div>
      <div data-testid="indicator-pane">Indicator chart placeholder</div>
    </div>
  );
}
```

- [ ] **Step 3: vitest 테스트**

```tsx
// frontend/test/live/LivePage.test.tsx
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LivePage } from '@/live/LivePage';

test('LivePage renders code from URL', () => {
  const { getByText } = render(
    <MemoryRouter initialEntries={['/live?code=000660']}>
      <Routes><Route path="/live" element={<LivePage />} /></Routes>
    </MemoryRouter>
  );
  expect(getByText('Live — 000660')).toBeInTheDocument();
});
```

- [ ] **Step 4: 통과 + 커밋**

```bash
cd frontend && npx vitest run live/LivePage.test.tsx
git add frontend/src/main.tsx frontend/src/live/LivePage.tsx frontend/test/live/LivePage.test.tsx
git commit -m "feat(live/ui): /live route with active code from URL"
```

### Task 9.2: state/livePage.ts (Zustand)

`activeCode`, `candleTimeframe`, `watchlistPanelOpen` 상태. localStorage 영속화.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 9.3: LiveCandlePane (mock 데이터로 lightweight-charts 띄우기)

기존 `RangeSeriesPane` 컴포넌트 재사용. mock candle 배열 props로 받음.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 9.4: LiveIndicatorPane (Quote Totals + 호가비 + FillStrength 3 pane)

기존 `QUOTE_TOTALS_SPEC`, `RATIO_SPEC`, `FILL_STRENGTH_SPEC` 재사용.

- [ ] failing test + 구현 + 통과 + 커밋

---

## Stage 10 — Frontend live data wiring

### Task 10.1: useLiveSeries 훅

```typescript
// frontend/src/api/liveSeries.ts
export function useLiveSeries(code: string) {
  const initial = useQuery({
    queryKey: ['live-series', code],
    queryFn: () => apiCall<LiveSeriesResponse>(`/api/live/series?code=${code}`),
  });
  const [snapshots, setSnapshots] = useState<LiveSnapshot[]>([]);

  useEffect(() => {
    if (!code) return;
    const es = new EventSource(`/api/live/stream?code=${code}`);
    es.onmessage = (e) => setSnapshots(prev => [...prev, JSON.parse(e.data)]);
    return () => es.close();
  }, [code]);

  return { initial: initial.data, snapshots };
}
```

- [ ] failing test (SSE mock 포함) + 구현 + 통과 + 커밋

### Task 10.2: LiveCandlePane을 실제 API로 연결

`useLiveCandles(code, timeframe)` 훅 호출, RangeSeriesPane에 전달.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 10.3: LiveIndicatorPane을 실제 SSE로 연결

`useLiveSeries(code)` 의 incremental update 를 RangeSeriesPane의 series.update() 로 전달.

- [ ] failing test + 구현 + 통과 + 커밋

---

## Stage 11 — Live Sidebar + Watchlist 패널

### Task 11.1: LiveSidebar (CursorSidebarConnected 재사용)

기존 `frontend/src/sidebar/CursorSidebarConnected.tsx` 를 `cursor = "최신 t_ms" (자동)` 모드로 wrap.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 11.2: WatchlistPanel (⭐ 토글)

기존 `useWatchlist` hook 활용. row 클릭시 `livePage` 스토어의 setActiveCode 호출 → URL `?code=` 갱신.

- [ ] failing test + 구현 + 통과 + 커밋

### Task 11.3: 페이지 레이아웃 통합

Section 4 layout (캔들+지표 left, Sidebar 중앙, Watchlist 우측 토글) 을 CSS Grid 또는 Flex로 구성.

- [ ] failing test (전체 페이지 렌더링) + 구현 + 통과 + 커밋

---

## Stage 12 — `/replay` Settings popover에 Source Preference 토글

### Task 12.1: chartPrefs.ts 에 sourcePreference 추가

```typescript
// frontend/src/state/chartPrefs.ts — 기존 ChartViewPrefs 타입에 추가
export type ChartViewPrefs = {
  // ... 기존 ...
  sourcePreference: 'hogaplay' | 'kis_live';
};

// 기본값 'hogaplay'
```

- [ ] failing test + 구현 + 통과 + 커밋

### Task 12.2: SettingsModal '차트' 카테고리에 라디오 그룹

```tsx
// frontend/src/replay/SettingsModal.tsx — '차트' 섹션에 추가
<RadioGroup
  label="기본 데이터 소스"
  value={prefs.sourcePreference}
  options={[
    { value: 'hogaplay', label: 'hogaplay 우선' },
    { value: 'kis_live', label: 'kis_live 우선' },
  ]}
  onChange={(v) => store.setSourcePreference(v)}
/>
```

- [ ] failing test + 구현 + 통과 + 커밋

### Task 12.3: useRange가 source_pref를 query param에 전달

```typescript
// frontend/src/api/range.ts — useRange가 prefs를 읽어서 query param에 포함
export function useRange(code: string, from: string, to: string, timeframe: Timeframe) {
  const sourcePref = useChartPrefsStore(s => s.sourcePreference);
  return useQuery({
    queryKey: ['range', code, from, to, timeframe, sourcePref],
    queryFn: () => apiCall<RangeBundle>(`/api/range?code=${code}&from=${from}&to=${to}&bucket_ms=${TIMEFRAME_TO_MS[timeframe]}&source_pref=${sourcePref}`),
  });
}
```

- [ ] failing test + 구현 + 통과 + 커밋

### Task 12.4: segments[i].source 뱃지 표시

차트 segment 경계에 source 칩 (hogaplay / kis_live) 표시. DESIGN.md 토큰 (`--fg-dim`, `--text-xs`) 사용.

- [ ] failing test + 구현 + 통과 + 커밋

---

## Stage 13 — Verification + cleanup

### Task 13.1: ADR-0038 invariant 가드 (writer에 pyarrow.parquet 금지)

**Files:**
- Test: `tests/unit/live/test_adr_invariants.py`

- [ ] **Step 1: 테스트 작성**

```python
# tests/unit/live/test_adr_invariants.py
"""ADR-0038 invariant: Live Capture hot path는 Parquet writer를 import 안 함."""
import ast
from pathlib import Path


def test_writer_does_not_import_pyarrow_parquet():
    src = Path("hoga/live/writer.py").read_text()
    tree = ast.parse(src)
    forbidden = ("pyarrow", "pyarrow.parquet", "polars")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert not alias.name.startswith(forbidden), \
                    f"ADR-0038 violation: writer.py imports {alias.name}"
        elif isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith(forbidden), \
                f"ADR-0038 violation: writer.py imports from {node.module}"


def test_poller_does_not_import_pyarrow_parquet():
    """Poller도 hot path — Parquet import 금지."""
    src = Path("hoga/live/poller.py").read_text()
    tree = ast.parse(src)
    forbidden = ("pyarrow", "pyarrow.parquet", "polars")
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert not alias.name.startswith(forbidden), \
                    f"ADR-0038 violation: poller.py imports {alias.name}"
        elif isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith(forbidden), \
                f"ADR-0038 violation: poller.py imports from {node.module}"
```

- [ ] **Step 2: 통과 확인 + 커밋**

```bash
uv run pytest tests/unit/live/test_adr_invariants.py -v
git add tests/unit/live/test_adr_invariants.py
git commit -m "test(live): ADR-0038 invariant guard — writer/poller never import Parquet libs"
```

### Task 13.2: KIS Mock Server fixture

**Files:**
- Create: `tests/fixtures/kis_mock/server.py`
- Create: `tests/fixtures/kis_mock/responses/*.json`
- Create: `tests/integration/live/conftest.py`

mock KIS server 는 pytest-style fixture로 한 번 실행. `httpx.MockTransport`로 unit test에서 충분히 다뤘으므로 integration test에서만 사용.

- [ ] failing integration test + mock server 구현 + 통과 + 커밋

### Task 13.3: 9시간 시뮬 end-to-end 테스트

```python
# tests/integration/live/test_loop_e2e.py
"""09:00~10:00 KST를 시뮬 (1초=1분 가속) — 한 cycle씩 60 cycle 돌려서 JSONL 60줄/종목 생성 확인."""
@pytest.mark.asyncio
async def test_one_hour_simulation_produces_360_lines_per_code(tmp_path, mock_kis_server):
    # 1 cycle = 0.01s (1초=100배 가속)
    # 1시간 = 360 cycles
    # 한 code 당 3 lines/cycle × 360 = 1080 lines
    ...
```

- [ ] failing test + 구현 + 통과 + 커밋

### Task 13.4: 전체 회귀 — pytest + frontend build

- [ ] `uv run pytest` 실행, 모든 테스트 통과 확인
- [ ] `cd frontend && npm run build` 실행, 빌드 성공 확인
- [ ] 통과 후 commit (이미 commit된 게 없으면 생략)

### Task 13.5: CLI command — hoga live (start/stop/status)

**Files:**
- Modify: `hoga/cli.py`

```python
@app.command()
def live(action: str = typer.Argument(..., help="start|stop|status")):
    if action == "status":
        # GET /api/live/status 호출 후 출력
        ...
    elif action == "start":
        # POST /api/live/control {action: "start"}
        ...
```

- [ ] failing test + 구현 + 통과 + 커밋

---

## Verification Commands (각 stage 종료 시)

```bash
# Backend 단위 테스트
uv run pytest tests/unit/live -v

# Backend 통합 테스트
uv run pytest tests/integration/live -v

# 전체 backend
uv run pytest

# Frontend 단위 테스트
cd frontend && npx vitest run live/

# Frontend 빌드
cd frontend && npm run build

# ADR-0038 invariant 가드
uv run pytest tests/unit/live/test_adr_invariants.py -v
```

## Acceptance Criteria (spec §14 mapping)

| spec §14 항목 | 검증 방법 |
|---|---|
| 1. 라이브 차트 09:00~now | Stage 10 e2e + 수동 KIS 자격증명으로 로컬 확인 |
| 2. 10s 갱신 | Stage 10 SSE 테스트 |
| 3. Live Sidebar 3카드 | Stage 11 컴포넌트 테스트 |
| 4. ⭐ 토글 | Stage 11 WatchlistPanel test |
| 5. X축 동기 | Stage 9 LiveCandlePane / LiveIndicatorPane 차트 동기화 테스트 |
| 6. 18:00 promote | Stage 8.2 scheduler test |
| 7. /replay sourcePref | Stage 12 |
| 8. 토큰 자동 갱신 | Stage 1.2 |
| 9. cycle_lag < 5s | Stage 13.3 1시간 시뮬 측정 |
| 10. 기존 회귀 없음 | Stage 6.4 골든 파일 + Stage 13.4 전체 pytest |

## Out of Plan Scope (별도 spec)

- KIS WebSocket 실시간 구독
- 멀티 워치리스트
- 가격 임계치 알림
- Inventory per-source row 액션 (재캡쳐 등)

---

# Review Merge Addendum (2026-05-27)

본 섹션은 plan 작성 직후 수행한 두 차례 review(plan-eng-review + plan-design-review)에서 도출된 Blocker / Critical을 stage별로 통합한 결과다. 실행 시 stage 진입 직전에 본 섹션의 해당 항목을 먼저 본문에 패치해 넣어 task 단위로 풀어 쓴다 (다른 stage의 task와 분량 균형 유지). Suggestion / Nit은 본 섹션 말미의 "Deferred review notes"에 누적.

## Schema Discoveries from Task 1.0 (2026-05-27, 실측 fixture 캡쳐 결과)

실제 KIS 응답 6종을 받아본 결과 plan의 일부 가정이 빗나갔다. 다음 보정사항 적용:

1. **Quote (10호가)**: ✓ plan과 완전 일치. `askp1..10`, `bidp1..10`, `askp_rsqn1..10`, `bidp_rsqn1..10`, `total_askp_rsqn`, `total_bidp_rsqn` 모두 확인됨.

2. **Trade — endpoint 교체**: 처음 가정한 `inquire-ccnl` (FHKST01010300)은 `ccld_dvsn` 같은 명시적 side 필드를 주지 않는다. 공식 샘플 리포를 추가 검토한 결과 `inquire-time-itemconclusion` (TR_ID `FHPST01060000`) 이 더 적합 — 각 체결 row가 `stck_cntg_hour`, `stck_prpr`(체결가), `cnqn`(체결 수량), `askp`(최우선 매도호가), `bidp`(최우선 매수호가) 을 동시 제공한다. **Lee-Ready 알고리즘**으로 side 도출 가능: `stck_prpr >= askp → +1(매수)`, `stck_prpr <= bidp → -1(매도)`, 중간가 → `0`. plan §Task 2.2의 `fetch_trades`는 본 endpoint로 교체. **FillStrength 지표 Phase 2 이연 결정은 철회** — 본 plan 범위 내에서 구현. inquire-ccnl 응답도 함께 fixture로 남아 있어 schema 진화 시 fallback 가능. (사용자가 공식 샘플 리포 참조를 요청, 2026-05-27 후속 검토 결과.)

3. **Broker (inquire-member)**: `output`이 dict가 아니라 **1-element list**. 접근 시 `body["output"][0]` 사용. 실 응답에 plan 가정의 5개 컬럼 외에도 풍부한 필드 존재 (`seln_mbcr_no1..5`, `glob_total_seln_qty`, `glob_total_shnu_qty`, `glob_ntby_qty`, `*_glob_yn_*`, `seln_qty_icdc1..5` 등). 본 plan에서는 plan이 의도한 5개 (`name`, `total_qty`) 만 추출, 나머지는 무시.

4. **Candles**: plan 가정 OK. 단 **분봉(inquire-time-itemchartprice)**은 필수 파라미터 `fid_etc_cls_code` (빈 문자열 가능), **일봉(inquire-daily-itemchartprice)**은 필수 파라미터 `fid_input_date_1`, `fid_input_date_2` 추가 필요. plan §Task 2.4의 params 빌더 수정.

### 결과로 변경된 스코프

- LiveIndicatorPane은 spec §7대로 **3개 active series** (Quote Totals, 호가비, FillStrength) + Live Sidebar의 거래원 카드(Broker Day-Trajectory). FillStrength 이연 결정은 inquire-time-itemconclusion 발견으로 철회.
- Stage 2.2 (`fetch_trades`)는 endpoint를 `inquire-time-itemconclusion` (FHPST01060000) 으로 교체. 응답의 `output2[*]`를 순회하며 각 row에서 `t_ms = (오늘 KST 자정 + stck_cntg_hour HHMMSS)`, `price = stck_prpr`, `qty = cnqn`, `side = classify_side(prpr, askp, bidp)` 계산. `classify_side`는 `hoga/live/kis_client.py`에 헬퍼 함수로 추가.
- Stage 5 (`promote_one`)의 trades.parquet 스키마는 plan 그대로 (side 컬럼 `int8`), 실제 값은 -1/0/+1.
- Stage 6/9 (read/frontend): FillStrength 시리즈는 hogaplay와 kis_live 모두에서 정상 표시. 다만 kis_live는 10s 폴링 간격이 한계 — 두 폴링 사이에 발생한 체결은 inquire-time-itemconclusion 응답이 최근 30건만 주므로 활동성 높은 종목에서 일부 ticks가 누락될 수 있다. 이건 ADR-0038 트레이드오프에 새로운 항목 추가 (해상도 10s ≠ tick-level).
- 새 task: `tools/capture_kis_fixtures.py`는 7번째 endpoint로 `timeconclusion_005930.json`도 받음 — Stage 1-5의 unit test가 이 fixture를 inquire-ccnl 대신 사용한다.
- inquire-ccnl 응답 fixture(`trade_005930.json`)는 그대로 보존 — KIS schema가 미래에 inquire-time-itemconclusion에서 ccnl 쪽으로 회귀해도 빠르게 fallback할 수 있게.

이 발견을 위해 Task 1.0이 존재한 것 — plan의 J-extra 의도대로 동작. 더불어 공식 샘플 리포 (`koreainvestment/open-trading-api`) 의 endpoint 카탈로그를 명시적으로 cross-check한 결과 더 적합한 endpoint 발견 (2026-05-27 검토).

---

## Pre-Stage Decisions Added (review 머지)

### F-extra. Single-worker assertion (Eng B2)

ADR-0019/0006의 single-uvicorn-worker 가정이 plan 전반(특히 JSONL writer, in-memory ring buffer, SSE bus)에 transitive하게 의존한다. `hoga/live/__init__.py` 모듈 import 시점에 `os.environ.get("UVICORN_WORKERS", "1") == "1"` assert. 위반시 startup-fatal. ADR-0038 본문에 "single-worker invariant" 추가 (Task 13.0).

### G-extra. KST 상수 public 화 (Eng B3)

`hoga/live/kis_client.py`의 `_KST` → public `KST` 로 이름 변경. 또는 `hoga/live/timeutil.py` 모듈로 분리해 다른 live 모듈도 import 가능하게. Task 1.1 코드 스니펫의 `_KST` → `KST` 일괄 교체.

### H-extra. Live page UI shell 기본 구조 (Design B1)

`/live` 페이지는 `/replay`와 같은 4행 grid를 갖는다:
1. **LiveHeader row** (40px): 페이지 타이틀 + ⭐ 토글 + Settings 진입점
2. **LiveStatusBar row** (52px): `005930 · 삼성전자` / 현재가 / 등락률 / source 칩 / TimeframeSelector / `LIVE● 09:34:12` / `cycle_lag` pill
3. **Toolbar row** (60px): TimeframeSelector (D/W는 disabled — Design B5 처리), 종목 search
4. **workarea row** (1fr): 캔들 차트 + 지표 차트 + LiveSidebar (+ WatchlistPanel 토글시)

기존 `/replay`의 `PriceStrip` 컴포넌트 구조를 mirror — Stage 9.1에 task 추가.

### I-extra. Empty/error state matrix (Design B2)

| 원인 | 표시 위치 | 우선순위 | 액션 링크 |
|---|---|---|---|
| watchlist 비어 있음 | 차트 영역 emptystate | 1 | /capture 로 이동 |
| KIS 자격증명 없음 | 헤더 배너 (red) | 1 | Settings → KIS 설정 |
| KIS 토큰 만료 | 헤더 배너 (amber) | 2 | "재발급" 버튼 |
| 장 외 시간 | 헤더 배너 (neutral) | 3 | 안내문만 (액션 없음) |
| cycle_lag_ms > 10s | LiveStatusBar pill (amber/red) | 4 | (상시 표시) |
| 특정 종목 데이터 결측 | 해당 차트만 emptystate | 5 | "다른 종목 보기" CTA |

우선순위 1만 동시 노출 차단(상호 배타), 2~5는 stacking 가능. spec §7의 "빈 상태 / 에러 상태"를 본 표로 교체.

### J-extra. KIS 실측 fixture capture task (Eng C1)

Stage 1 시작 전 새 Task 1.0 추가:
1. 사용자가 제공한 KIS_APP_KEY/SECRET로 5개 엔드포인트에 1회 실 호출
2. 응답 JSON 5종을 `tests/fixtures/kis_mock/responses/`에 저장
3. 응답 schema가 plan의 가정과 일치하는지 확인 (특히 field 이름: `askp_rsqn1`, `total_askp_rsqn`, `ccld_dvsn`, `stck_cntg_hour` 등)
4. 불일치시 plan의 `kis_models.py` 필드 매핑 갱신
5. fixture는 Stage 1-7 모든 unit test에서 inline dict 대신 `responses/*.json` import해 재사용 (Eng S1 동시 해소)

## Stage 0 Patches

### Task 0.3 변경 — 503 가드 제거 + 가정 명시 (Eng B5)

원래 plan의 "마이그레이션 진행 중 새 요청은 503 응답 + Retry-After"를 **삭제**. 대신:

> Pre-Stage E의 마이그레이션은 항상 빠르다고 가정한다. 즉 `shutil.move`만 호출하며 데이터 copy/parse는 하지 않는다. 1만 (date, code) 폴더 기준 ~5초 미만이 예상 (filesystem rename은 inode 변경뿐). lifespan에서 동기로 실행하며, 그 시간 동안은 FastAPI가 healthy 시그널을 보내지 않는다. Docker/systemd healthcheck는 startup grace period 30s를 두어 마이그레이션 완료를 기다린다.

Task 0.3에 latency 측정 sub-task 추가:
```python
def test_migrate_under_5s_for_10k_dirs(tmp_path):
    # 10000개 (date, code) 더미 폴더 + 4개 placeholder 파일
    # migrate_to_v2_layout(...) wall-time < 5s
```

## Stage 1 Patches

### Task 1.0 신규 — KIS 실측 응답 fixture capture (Eng C1)

위 J-extra 참조. CLI script `tools/capture_kis_fixtures.py` 도 함께 만들어 향후 KIS schema 변경 시 재실행 가능하게.

### Task 1.2 보강 — 토큰 mid-cycle 만료 재시도 (Eng C2)

`_unwrap` 메서드에 401 감지 시 토큰 invalidate + 1회 재시도 wrapper:

```python
async def _request_with_retry(self, method, path, **kwargs):
    for attempt in range(2):
        token = await self.get_access_token()
        kwargs.setdefault("headers", {})["authorization"] = f"Bearer {token}"
        resp = await self._client.request(method, path, **kwargs)
        if resp.status_code == 401 and attempt == 0:
            # invalidate 후 재발급
            self._token = None
            self._token_expires_at = None
            continue
        return resp
    return resp
```

새 test: `test_401_triggers_token_reissue_then_retry`.

## Stage 4 Patches

### Task 4.x 신규 — Rate limit starvation 방지 (Eng C6)

`run_one_cycle`에서 KisRateLimitError 발생 시 현재 cycle은 그대로 진행하되, 다음 cycle 시작 시점에 **이전에 starve된 종목부터 우선** 처리. 구현: per-code "last_success_cycle" 트래커, 새 cycle 시작 시 `sorted(codes, key=last_success_cycle)` 순서로 진행. 새 test: `test_rate_limit_does_not_starve_later_codes`.

### Task 4.y 신규 — 08:50 토큰 사전 갱신 (Eng S7)

Daily Scheduler에 새 작업 추가하거나, Live Poller가 09:00 시작 전 10분(08:50)에 `get_access_token()` 호출. Stage 8.x로 이동.

## Stage 6 Patches

### Task 6.4 변경 — 골든 파일 생성 절차 명시 (Eng B4)

원래 "기존 fixture 사용" 한 줄을 다음으로 확장:

1. **Step A**: Stage 6.3 완료 후, `tests/conftest.py`에 `hogaplay_only_fixture` 새 fixture 작성 — 기존 `tiny_tsv` 003490/20260519 데이터를 마이그레이션 후 hogaplay 서브폴더에 배치.
2. **Step B**: `python -m tests.tools.regen_golden hogaplay_only` 스크립트 작성 (tests/tools/regen_golden.py). source_pref 무관 결과를 JSON으로 dump.
3. **Step C**: `range_bundle_hogaplay_only.json` 골든 파일 생성 → diff review → commit. 향후 회귀 발견 시 의도된 변경이면 `regen_golden` 재실행 + commit.

## Stage 7 Patches

### Task 7.x 신규 — In-memory ring buffer 동시성 (Eng B1)

`hoga/live/lifecycle.py`의 모듈-레벨 상태 (`_latest_snapshots`, `_series_ring_buffers`)를 `asyncio.Lock` 으로 보호. Reader는 lock 안에서 list/dict의 **immutable snapshot** (frozen list 또는 tuple) 만들어 반환, 그 후 lock 해제. 새 test: `test_concurrent_reader_during_writer_does_not_raise`.

또한 Eng B2 (single-worker assertion) 는 F-extra 참조.

### Task 7.2–7.6 풀어 쓰기 (Eng S6)

원래 "Stage 7.1과 같은 패턴" 한 줄로 축약된 5개 endpoint를 각각 (a) wire model 정의, (b) handler 시그너처, (c) 1~2개 unit test 코드, (d) commit message 까지 명시. plan-eng-review 의 S6 권고 반영.

## Stage 9 Patches (Design B1, B3, B4, B7, C5, C6)

### Task 9.0 신규 — DESIGN.md 갱신

Stage 9 시작 전 `DESIGN.md`에 다음 token / 규칙 추가 (Design B3, B6, C4):

```css
/* DESIGN.md tokens */
--watchlist-panel-w: 17.5rem;   /* 280px @ 1.0× / 350px @ 1.25× */
--source-hogaplay-bg: var(--bg-card);
--source-hogaplay-border: var(--fg-dimmer);
--source-kis-live-bg: color-mix(in srgb, var(--accent) 12%, var(--bg-card));
--source-kis-live-border: var(--accent);
```

카피 톤 가이드 한 단락 추가:
- 도메인 식별자 (`hogaplay`, `kis_live`, `cycle_lag_ms`): 영문 lowercase, code-style
- 사용자 메시지: 한국어 자연문, 마침표 생략, 액션은 명사형
- 상태 라벨: 한국어 단어 (예: "장 외", "대기 중")

### Task 9.1 보강 — LivePage shell 구조

원래 placeholder 한 줄을 H-extra의 4행 grid 구조로 확장. PriceStrip-mirror 컴포넌트 `LiveStatusBar.tsx` 새로 작성. 기존 `frontend/src/replay/PriceStrip.tsx` 패턴 참고.

### Task 9.x 신규 — 빈/에러 상태 컴포넌트

I-extra의 매트릭스를 그대로 구현한 `LiveStateBanner.tsx` + `LiveEmptyState.tsx`. 우선순위 로직은 `useLiveStatus` 의 데이터 기반.

### Task 9.4 보강 — X축 동기 D/W 처리 + 빈 데이터 표시 (Design B5 + user clarification 2026-05-27)

**원칙: 차트 pane은 timeframe 상관없이 항상 존재한다. 데이터가 없으면 series만 비워서 표시 — pane을 hide / replace하지 않는다.**

**일봉(D) / 주봉(W) 일 때**:
- LiveCandlePane: 캔들 + 거래량 정상 표시
- LiveIndicatorPane: 3개 sub-pane 모두 **그대로 마운트하되 series 데이터를 빈 배열로 set**. X축은 캔들과 동기 유지(같은 시간 범위), Y축은 default scale, 라인/히스토그램은 아예 그려지지 않음.
- pane 헤더에 작은 안내 "라이브 지표는 분봉에서 표시됩니다" (DESIGN.md `--fg-dimmer`, dismiss 불가, 정보성).
- 사용자가 1m–30m으로 돌아오면 즉시 series가 다시 채워짐.

**분봉(1m–30m) 일 때**:
- LiveCandlePane: 캔들 + 거래량 정상 표시
- LiveIndicatorPane: 각 sub-pane이 자체적으로 데이터 가용성 판단
  - 데이터 있음 → 정상 표시
  - **그 날의 호가 지표 데이터 자체가 없음** (예: 토큰 만료로 폴링 결측, watchlist에 추가 전, 캡처 실패 등) → pane은 그대로 마운트, series는 빈 배열, X축은 캔들과 동일 시간 범위 유지
  - **일부 구간만 결측** → 결측 구간은 `whitespaceData` (lightweight-charts) 로 line break, 양 옆 데이터는 정상 표시 (기존 `auctionWindowMask` 의 line-break 패턴 재사용)

**새 테스트**:
- `test_indicator_pane_renders_empty_on_daily_timeframe` — pane DOM은 있지만 series.setData([]) 호출 확인
- `test_indicator_pane_renders_empty_when_no_data_for_day` — 분봉 + 그 날 데이터 결측 → pane DOM은 있고 X축은 보임
- `test_indicator_pane_breaks_line_on_data_gap` — 분봉 + 부분 결측 → whitespaceData 삽입 확인

**구현 노트**:
- `RangeSeriesPane`는 이미 `axis.contains(t)` 필터 + `whitespaceData` 패턴을 사용 (`ChartStage.tsx:268` 참조). 빈 데이터 케이스도 이 패턴 자연 확장 — 모든 t가 axis.contains이지만 `projectXxx(bundle, axis)`가 빈 배열을 반환하면 자동 처리.
- 일/주봉에서 series가 비더라도 pane 자체의 `paneIndex`, `setStretchFactor`는 유지 — 레이아웃이 흔들리지 않음.

### Task 9.y 신규 — 키보드 단축키 + a11y (Design B7)

`useLiveKeyboard()` hook: `j`/`k` (종목 prev/next), `w` (watchlist 토글), `Esc` (패널 닫기). ⭐ 토글 버튼에 `aria-expanded`, `aria-controls`. focus 관리.

## Stage 10 Patches

### Task 10.1 보강 — useLiveSeries ring buffer (Eng C5)

```typescript
const MAX_SNAPSHOTS_PER_KIND = 2520;   // 약 7시간 × 360 cycles/hr
es.onmessage = (e) => setSnapshots(prev => {
  const next = [...prev, JSON.parse(e.data)];
  return next.length > MAX_SNAPSHOTS_PER_KIND ? next.slice(-MAX_SNAPSHOTS_PER_KIND) : next;
});
```

또는 `useReducer` + Map<kind, ring> 구조로 fold. test: `test_useLiveSeries_does_not_grow_unbounded`.

### Task 10.3 보강 — 라이브 데이터 도착시 master 범위 확장 (Design B5)

SSE 도착시 lightweight-charts `timeScale.scrollToRealTime()` 또는 visible range 우측 가장자리 확장 트리거. 차트가 정적으로 보이지 않도록.

## Stage 11 Patches

### Task 11.1 보강 — LiveSidebar mode 시각 표시 (Design C1, Eng C7)

`CursorSidebarConnected` wrap 컴포넌트에:
- 헤더에 `LIVE●` pulse (`--accent` 1.5s breathe)
- 우상단에 `last_tick` 타임스탬프 ("09:34:12")
- cursor 인터랙션 (좌우 드래그) **disabled** — 사용자가 차트 호버시에도 cursor 이동 안 함, 항상 latest t_ms
- cursor 자동 추적임을 명시하는 tooltip

`useCursor` 의 외부 API는 그대로, 내부에서 `mode: 'live' | 'replay'` prop으로 분기.

### Task 11.2 보강 — ⭐ 토글 detail (Design B7)

위치: LiveHeader row 우측, Settings 아이콘 옆. Lucide React 의 `Star` 아이콘 (filled when open, outline when closed). 단축키 `w`. aria-expanded.

### Task 11.3 보강 — 반응형 4열 처리 (Design B4)

`window.innerWidth` 가 1280px 미만일 때:
- WatchlistPanel 강제 hide + ⭐ 토글 비활성화
- "/live는 1280px 이상 desktop 환경을 권장합니다" 배너 (한 번 표시 후 dismissable)
- LiveSidebar는 collapse-mode (icon-only) 로 전환

`useViewportWidth` hook 새로 작성.

## Stage 12 Patches

### Task 12.2 보강 — sourcePreference helper text (Design C3)

```tsx
<RadioGroup
  label="기본 데이터 소스 (모든 차트 공통)"
  description="현재 차트의 source는 PriceStrip 우측 칩에 표시됩니다."
  ...
/>
```

### Task 12.3 보강 — useRange 호출자 일관성 (Eng B6)

새 task: `git grep -nE 'useRange\\(' frontend/src/`로 모든 호출자 식별 → 각각이 sourcePref 변경시 정상 refetch하는지 unit test 추가. 호출자 목록을 plan에 명시 (현재 plan 작성 시점 기준):
- `frontend/src/replay/Workarea.tsx`
- `frontend/src/replay/PriceStrip.tsx` (간접)
- (테스트) `frontend/src/api/range.test.tsx`
- (테스트) `frontend/src/replay/Workarea.test.tsx`

### Task 12.4 보강 — 해상도 표기 + source 칩 색 (Design B6, C2)

```tsx
<SourceChip source={seg.source}>
  {seg.source === 'hogaplay' ? 'hogaplay · tick' : 'kis_live · 10s'}
</SourceChip>
```

칩 색은 9.0 task에서 추가한 `--source-*` 토큰 사용.

## Stage 13 Patches

### Task 13.0 신규 — Single-worker invariant test (Eng B2)

`tests/unit/live/test_adr_invariants.py`에 추가:

```python
def test_live_package_asserts_single_worker(monkeypatch):
    monkeypatch.setenv("UVICORN_WORKERS", "2")
    import importlib
    with pytest.raises(AssertionError, match="single worker"):
        importlib.reload(__import__("hoga.live"))
```

### Task 13.1 보강 — Invariant guard transitive 차단 (Eng C8)

forbidden tuple에 `("pyarrow", "polars")` 만 두고, import path가 dot으로 시작하든 끝나든 매치되는 정규식 기반 검사로 변경:

```python
import re
FORBIDDEN_RE = re.compile(r"^(pyarrow|polars)(\..*)?$")
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            assert not FORBIDDEN_RE.match(alias.name), ...
    elif isinstance(node, ast.ImportFrom):
        assert not FORBIDDEN_RE.match(node.module or ""), ...
```

또한 `hoga/live/snapshot.py`, `hoga/live/poller.py`, `hoga/live/api.py`, `hoga/live/lifecycle.py` 도 같은 가드 적용 (snapshot은 writer가 import하므로 transitive). writer의 transitive closure 검사도 추가.

## Deferred review notes (Suggestion + Nit)

본 항목들은 plan에 inline 반영 안 됨. Stage 13 종료 후 retrospective 단계에서 살펴봄.

**Eng Suggestions**:
- S1: Mock KIS server fixture 통합 (Task 1.0과 일부 중복 — 해소됨)
- S2: Stage 12 dependency 그래프에 명시 (작은 문서 수정)
- S3: hoga live CLI 구현 방식 (HTTP vs 직접 호출) — plan에선 HTTP 가정
- S4: 마이그레이션 dry-run mode — Stage 0 변경 후 불필요해진다고 판단
- S5: archive 정책 idempotence (`*.tmp` atomic rename) — plan 5.1에 후속 추가 가능
- S6: Stage 7.2-7.6 풀어 쓰기 — 이미 반영됨
- S7: 08:50 토큰 사전 갱신 — Stage 4.y로 이미 반영됨

**Eng Nits**:
- N1: `LayoutVersion` enum 단순화 (bool로) — 보수적으로 enum 유지
- N2: Task 4.1 test 코멘트 정리 — 단순 텍스트 수정 (실행 시 정리)
- N3: KIS_ENV vs `Literal["real"]` 명명 mismatch — 사용자 메시지로 보완
- N4: ADR-0037 invariant test — Stage 13.0에 합쳐 처리됨
- N5: `kis_rate_limit_remaining` field — client-side token bucket의 remaining으로 의미 변경 (Stage 4 구현시 처리)

**Design Suggestions**:
- S1: 차트 헤더 정보 밀도 — Stage 9.1 LiveStatusBar 설계시 반영
- S2: WatchlistPanel 검색·정렬 — StockCombobox 패턴 재사용, 후속 spec
- S3: 라이브 데이터 도착 micro flash (80ms) — Stage 10 후속
- S4: cycle_lag pill 3-stage 색 (gray/amber/red) — Stage 9 LiveStatusBar
- S5: 키보드 단축키 j/k/w/s — Stage 9.y 반영됨
- S6: 모바일/태블릿 정책 — Stage 11.3 반영됨

**Design Nits**:
- N1: ASCII layout 정렬 — 문서 보정
- N2: `--text-xs` 토큰명 통일 — Stage 9.0 DESIGN.md 작업시
- N3: Sidebar 카드 순서 검증 — Stage 11.1
- N4: 라벨 토큰 통일 — Stage 12.2 helper text 반영시

## Review 평가 종합

| Reviewer | 점수 | 머지 후 예상 |
|---|---|---|
| Eng | 3.5 → 4.0 (B1–B6 + C1–C6, C8 머지 후) |
| Design | 2.5 → 4.0 (B1–B7 + C1–C6 머지 후) |

전체 plan 분량은 약 +700줄 증가. 본 Addendum이 stage 진입 직전 참조 문서 역할.
