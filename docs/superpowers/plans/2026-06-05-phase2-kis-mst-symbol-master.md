# Phase 2 — 종목 검색을 KIS .mst로 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 종목 마스터를 pykrx(KRX 로그인)에서 KIS `.mst` 정적 파일(무인증)로 바꿔, 종목 검색이 KRX 자격증명 없이 동작하게 한다(SPEC §7). 검색 universe에 ETF/ETN 포함.

**Architecture:** 새 `kis_master.py`가 `.mst`를 받아 파싱한다(byte-offset, cp949). `symbols.py`의 데이터 취득 함수(`_fetch_from_pykrx`)만 교체하고 캐시 상태머신·검색·디스크 스키마(v1→v2)·single-flight coordinator는 보존한다. 종목 종류(`security_type`)를 `SymbolHit`에 추가한다. `.mst`는 무인증이므로 symbol path의 KRX cred-gate를 제거한다(SPEC §6 일부를 Phase 2로 — symbol path 한정; calendar는 Phase 3까지 creds 유지).

**Tech Stack:** Python 3, urllib + zipfile (stdlib), cp949 디코딩, pytest.

**참조:** SPEC `docs/superpowers/specs/2026-06-05-krx-to-kis-migration-design.md` §4·§6·§7.

---

## probe 실측 (Phase 2 작성 전 검증 완료 — 2026-06-05)

`tmp/mst_probe.py`로 실제 `.mst`를 받아 확인한 사실:
- **반드시 byte 단위로 슬라이싱**한다. cp949 한글명은 글자당 2바이트라, row를 먼저 디코드하고 char로 자르면 고정폭 byte offset이 어긋난다(`' S'`/`' E'` 같은 1바이트 밀림으로 드러남).
- **part2 폭은 시장별로 다르다**: KOSPI 228, KOSDAQ 222 바이트.
- **증권그룹구분코드 = `part2[0:2]`** 실측 분포: `" S"`=보통주(KOSPI 926 + KOSDAQ 1804 = 2,730 ≈ pykrx ~2,600), `" E"`=ETF(1,500), `"BE"`/`"NE"`=ETN, `" R"`=리츠(25), `" F"`=외국주(12), `" B"`=펀드(69), 기타 소수.
- **ELW는 이 파일에 없음**(별도 배포).
- 한글명: `part1[21:]` = `row[21 : len(row)-tail]`. **`row[21:]` 아님**.

---

## File Structure

- **Create** `hoga/api/kis_master.py` — `.mst` 다운로드(`download_master`)와 파싱(`parse_master`) 분리. `fetch_symbol_master()`, `MasterRow(code,name,market,security_type)`, `_classify(group)`, `KisMasterFetchError`.
- **Create** `tests/unit/api/fixtures/mst_sample_kospi.bin` / `mst_sample_kosdaq.bin` — 실제 `.mst`에서 그룹별 1행씩 추출한 fixture.
- **Modify** `hoga/api/models.py:379` — `SymbolHit.security_type`.
- **Modify** `hoga/api/symbols.py` — `_fetch_from_pykrx`→`_fetch_symbol_master`, 스키마 v2, cred-gate 제거, `security_type` 3곳, error 매핑.
- **Modify** `hoga/api/error_codes.py:67` — `KIS_MASTER_FETCH_FAILED`.
- **Modify** `frontend/src/api/types.ts` — `UpstreamCode` 미러에 `kis_master_fetch_failed`(ADR-0004 동일 커밋).
- **Modify** `hoga/api/app.py:127` — 부팅 빈 캐시 백그라운드 자동 받기.

---

## Task 1: kis_master.py — 다운로드/파싱 + 실측 fixture

**Files:** Create `hoga/api/kis_master.py`, `tests/unit/api/fixtures/mst_sample_{kospi,kosdaq}.bin`, `tests/unit/api/test_kis_master.py`

- [ ] **Step 1: 실제 .mst에서 fixture 추출**

다음 스크립트를 한 번 실행해 fixture를 만든다(파서 테스트가 네트워크 없이 돌도록):

```python
# scratch: run once to build fixtures
import io, urllib.request, zipfile, pathlib
M = {"kospi": ("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", 228),
     "kosdaq": ("https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip", 222)}
out = pathlib.Path("tests/unit/api/fixtures"); out.mkdir(parents=True, exist_ok=True)
for mkt, (url, tail) in M.items():
    blob = urllib.request.urlopen(url, timeout=60).read()
    z = zipfile.ZipFile(io.BytesIO(blob))
    raw = z.read(z.namelist()[0])
    seen, keep = set(), []
    for row in raw.split(b"\n"):
        r = row.rstrip(b"\r")
        if len(r) <= tail: continue
        g = r[len(r)-tail:][0:2]
        if g not in seen:
            seen.add(g); keep.append(r)
    (out / f"mst_sample_{mkt}.bin").write_bytes(b"\n".join(keep) + b"\n")
    print(mkt, "groups:", sorted(s.decode("cp949","replace") for s in seen))
```

Run it; verify the fixtures contain at least one ` S`(stock), ` E`(ETF), and a `BE`/`NE`(ETN) row each. Commit the `.bin` files.

- [ ] **Step 2: Write the failing test**

`tests/unit/api/test_kis_master.py`:

```python
"""KIS .mst parser tests (Phase 2). Uses committed real-.mst fixtures."""
from pathlib import Path

import pytest

from hoga.api.kis_master import KisMasterFetchError, parse_master

FIX = Path(__file__).parent / "fixtures"


def test_parse_kospi_classifies_and_filters() -> None:
    rows = parse_master((FIX / "mst_sample_kospi.bin").read_bytes(), "KOSPI")
    types = {r.security_type for r in rows}
    assert "stock" in types
    assert "etf" in types
    assert types <= {"stock", "etf", "etn"}  # 리츠/외국주/펀드 dropped
    for r in rows:
        assert r.code and r.name and r.market == "KOSPI"


def test_parse_kosdaq_uses_222_tail() -> None:
    rows = parse_master((FIX / "mst_sample_kosdaq.bin").read_bytes(), "KOSDAQ")
    assert rows and all(r.market == "KOSDAQ" for r in rows)
    assert any(r.security_type == "stock" for r in rows)


def test_korean_name_not_truncated_or_overrun() -> None:
    rows = parse_master((FIX / "mst_sample_kospi.bin").read_bytes(), "KOSPI")
    assert any("KODEX" in r.name for r in rows)
    assert all("�" not in r.name for r in rows)


def test_parse_empty_raises() -> None:
    with pytest.raises(KisMasterFetchError):
        parse_master(b"", "KOSPI")


def test_parse_html_error_response_raises() -> None:
    with pytest.raises(KisMasterFetchError):
        parse_master(b"<html><body>error</body></html>\n", "KOSPI")
```

- [ ] **Step 3: Run to verify it fails**

Run: `uv run --extra dev pytest tests/unit/api/test_kis_master.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.api.kis_master'`

- [ ] **Step 4: Write the module**

`hoga/api/kis_master.py`:

```python
"""KIS .mst symbol master — download + parse (Phase 2).

Replaces the pykrx symbol fetch. The .mst files are STATIC downloads (no auth),
so symbol search works without KIS credentials (SPEC §7).

Parsing is BYTE-based: cp949 한글명 is 2 bytes/char, so decoding the whole row
before slicing misaligns the fixed-width byte offsets. Slice raw bytes, decode
the pieces. part2 width differs by market: KOSPI 228, KOSDAQ 222. The
증권그룹구분코드 (part2[0:2]) classifies the row; values were discovered
empirically (Task 1 probe), not assumed.
"""
from __future__ import annotations

import io
import urllib.request
import zipfile
from typing import Literal, NamedTuple

SecurityType = Literal["stock", "etf", "etn"]
Market = Literal["KOSPI", "KOSDAQ"]


class MasterRow(NamedTuple):
    code: str
    name: str
    market: Market
    security_type: SecurityType


class KisMasterFetchError(Exception):
    """download/unzip/parse failure. Maps to UpstreamCode.KIS_MASTER_FETCH_FAILED."""


_MARKETS: dict[str, tuple[str, int]] = {
    "KOSPI": ("https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip", 228),
    "KOSDAQ": ("https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip", 222),
}


def _classify(group: str) -> SecurityType | None:
    """증권그룹구분코드 → security_type, or None to drop the row.

    Probe-discovered values (2026-06-05): ' S'=보통주, ' E'=ETF, 'BE'/'NE'=ETN.
    리츠(' R')/외국주(' F')/펀드(' B')/기타는 SPEC scope(보통주+ETF+ETN) 밖이라
    제외. ELW is absent from these files entirely.
    """
    if group == " S":
        return "stock"
    if group == " E":
        return "etf"
    if group in ("BE", "NE"):
        return "etn"
    return None


def download_master(market: str) -> bytes:
    """Download + unzip a .mst (no auth). Raises KisMasterFetchError on failure."""
    url, _ = _MARKETS[market]
    try:
        data = urllib.request.urlopen(url, timeout=60).read()
        z = zipfile.ZipFile(io.BytesIO(data))
        return z.read(z.namelist()[0])
    except Exception as e:  # noqa: BLE001 — network/zip errors are all fetch failures
        raise KisMasterFetchError(f"{market} .mst download/unzip failed: {e}") from e


def parse_master(raw: bytes, market: str) -> list[MasterRow]:
    """Parse raw .mst bytes into classified rows. Raises on empty/HTML/malformed
    (so the caller persists disk only on a real catalog, never an empty one)."""
    _, tail = _MARKETS[market]
    out: list[MasterRow] = []
    for row in raw.split(b"\n"):
        row = row.rstrip(b"\r")
        if len(row) <= tail:
            continue
        part1 = row[: len(row) - tail]
        part2 = row[len(row) - tail :]
        st = _classify(part2[0:2].decode("cp949", errors="replace"))
        if st is None:
            continue
        code = part1[0:9].decode("cp949", errors="replace").strip()
        name = part1[21:].decode("cp949", errors="replace").strip()
        if code and name:
            out.append(MasterRow(code, name, market, st))  # type: ignore[arg-type]
    if not out:
        raise KisMasterFetchError(
            f"{market} .mst parsed 0 rows — empty/HTML/malformed response"
        )
    return out


def fetch_symbol_master() -> list[MasterRow]:
    """Download + parse both markets. Blocking I/O — callers offload to a
    threadpool (see symbols._fetch_symbol_master)."""
    rows: list[MasterRow] = []
    for market in ("KOSPI", "KOSDAQ"):
        rows.extend(parse_master(download_master(market), market))
    return rows
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run --extra dev pytest tests/unit/api/test_kis_master.py -v`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add hoga/api/kis_master.py tests/unit/api/test_kis_master.py tests/unit/api/fixtures/mst_sample_kospi.bin tests/unit/api/fixtures/mst_sample_kosdaq.bin
git commit -m "feat(symbols): KIS .mst parser (byte-offset, security_type classify)"
```

---

## Task 2: SymbolHit.security_type — 모델 + symbols 디스크 (한 커밋)

`security_type`를 추가하는 곳이 여러 군데다(모델 + `_write_to_disk` + `_load_from_disk`). **한 커밋** — 나누면 빌드/테스트 red(exhaustive-coupling).

**Files:** Modify `hoga/api/models.py:379`, `hoga/api/symbols.py`, Test `tests/unit/api/test_symbols_disk.py`

- [ ] **Step 1: Write the failing test**

`tests/unit/api/test_symbols_disk.py`:

```python
"""Symbol Master disk round-trip with security_type (Phase 2)."""
from pathlib import Path

from hoga.api import symbols
from hoga.api.models import SymbolHit


def _hit(code: str, name: str, market: str, st: str) -> SymbolHit:
    return SymbolHit(
        code=code, name=name, market=market, security_type=st,  # type: ignore[arg-type]
        captured_count=0,
        captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
    )


def test_disk_roundtrip_preserves_security_type(tmp_path: Path) -> None:
    path = tmp_path / "symbol-master.json"
    entries = [_hit("005930", "삼성전자", "KOSPI", "stock"),
               _hit("069500", "KODEX 200", "KOSPI", "etf")]
    symbols._write_to_disk(path, entries, fetched_at_ms=123)
    loaded = symbols._load_from_disk(path)
    assert loaded is not None
    got, _ = loaded
    by_code = {h.code: h for h in got}
    assert by_code["005930"].security_type == "stock"
    assert by_code["069500"].security_type == "etf"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run --extra dev pytest tests/unit/api/test_symbols_disk.py -v`
Expected: FAIL — `SymbolHit` has no `security_type`, or `_write_to_disk` drops it.

- [ ] **Step 3: Add security_type to the model**

In `hoga/api/models.py`, the `SymbolHit` class (line 379) — add the field after `market`:

```python
class SymbolHit(BaseModel):
    code: str
    name: str
    market: Literal["KOSPI", "KOSDAQ"]
    security_type: Literal["stock", "etf", "etn"] = "stock"
    captured_count: int                 # complete only — headline number (spec §11 Q18)
    captured_breakdown: dict[str, int]  # {"complete": N, "source_partial": M, "client_incomplete": K, "invalid": J}
```

(Default `"stock"` keeps internal construction that omits it valid; real data always sets it.)

- [ ] **Step 4: Persist + load security_type in symbols.py**

(a) `_write_to_disk` entries (line 294-297):

```python
        "entries": [
            {"code": e.code, "name": e.name, "market": e.market, "security_type": e.security_type}
            for e in entries
        ],
```

(b) `_load_from_disk` construction (line 264-272):

```python
        entries = [
            SymbolHit(
                code=e["code"],
                name=e["name"],
                market=e["market"],
                security_type=e.get("security_type", "stock"),
                captured_count=0,
                captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
            )
            for e in raw_entries
        ]
```

- [ ] **Step 5: Run tests**

Run: `uv run --extra dev pytest tests/unit/api/test_symbols_disk.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add hoga/api/models.py hoga/api/symbols.py tests/unit/api/test_symbols_disk.py
git commit -m "feat(symbols): add security_type to SymbolHit + disk round-trip"
```

---

## Task 3: symbols.py — .mst 취득 교체 + 스키마 v2 + cred-gate 제거 + error code

**Files:** Modify `hoga/api/symbols.py`, `hoga/api/error_codes.py:67`, `frontend/src/api/types.ts`, Test `tests/test_api_symbols.py`

- [ ] **Step 1: Add the error code (backend + frontend mirror)**

In `hoga/api/error_codes.py`, add to `UpstreamCode` (after `DISK_WRITE_FAILED`, line 67):

```python
    # KIS .mst symbol-master download/unzip/parse failure (Phase 2). The .mst is
    # a static no-auth file, so there is no credentials failure mode here.
    KIS_MASTER_FETCH_FAILED = "kis_master_fetch_failed"
```

In `frontend/src/api/types.ts`, find the `UpstreamCode` literal union and add `"kis_master_fetch_failed"` (ADR-0004 mirror — same commit as backend).

- [ ] **Step 2: Replace the fetch function and drop the cred-gate**

In `hoga/api/symbols.py`:

(a) Add module-level import near the top: `from hoga.api.kis_master import KisMasterFetchError, fetch_symbol_master as _fetch_mst`.

(b) Replace `_fetch_from_pykrx` (line 320-371) with:

```python
async def _fetch_symbol_master() -> list[SymbolHit]:
    """Sole upstream entry point — downloads + parses the KIS .mst (no auth).

    Blocking download+parse runs in a threadpool so the event loop isn't
    stalled. Any download/unzip/parse failure surfaces as KisMasterFetchError →
    UpstreamCode.KIS_MASTER_FETCH_FAILED (see _do_refresh). No credentials
    needed — the .mst is a static file (SPEC §7).
    """
    loop = asyncio.get_running_loop()
    try:
        rows = await loop.run_in_executor(None, _fetch_mst)
    except KisMasterFetchError:
        raise
    except Exception as e:  # noqa: BLE001 — unexpected → same failure class
        raise KisMasterFetchError(str(e)) from e
    return [
        SymbolHit(
            code=r.code,
            name=r.name,
            market=r.market,  # type: ignore[arg-type]
            security_type=r.security_type,
            captured_count=0,
            captured_breakdown={"complete": 0, "source_partial": 0, "client_incomplete": 0, "invalid": 0},
        )
        for r in rows
    ]
```

(c) DELETE `_ensure_krx_credentials` (line 302-317), `KrxCredentialsMissing` (line 43-48), `KrxFetchFailed` (line 51-57), `PykrxFetchError` (line 33-40), and the `from hoga.env import krx_creds_present, load_env` import if now unused on the symbol path.

(d) `refresh()` (line 476-509) — remove the cred-gate fast-path:

```python
async def refresh(*, path: Path, data_dir: Path) -> SymbolsAllResponse:
    """POST /api/symbols/refresh — the only .mst fetch entry point.

    No credentials gate — the .mst is a static no-auth download (SPEC §7).
    Concurrency: _refresh_coordinator dedupes simultaneous clicks.
    """
    def _start_refresh_task() -> asyncio.Task[SymbolsAllResponse]:
        global _state  # noqa: PLW0603
        _state = SymbolCacheState.loading()
        return asyncio.create_task(_do_refresh(path=path, data_dir=data_dir))

    return await _refresh_coordinator.coalesce(_start_refresh_task)
```

(e) `_do_refresh` (line 538-590) — replace the pykrx exception mapping (line 549-557):

```python
        try:
            entries = await _fetch_symbol_master()
        except KisMasterFetchError:
            _set_stale_or_unavailable(UpstreamCode.KIS_MASTER_FETCH_FAILED)
            return _build_response()
```

And the bottom safety-net (line 587-590) maps to `UpstreamCode.KIS_MASTER_FETCH_FAILED`.

(f) Bump `SCHEMA_VERSION = 1` → `2` (line 213), and `_write_to_disk` `"source": "pykrx"` → `"source": "kis_mst"` (line 293).

- [ ] **Step 3: Update/trim symbol tests**

Run: `grep -rln "_fetch_from_pykrx\|KrxCredentialsMissing\|_ensure_krx_credentials\|KRX_FETCH_FAILED\|KRX_CREDENTIALS_MISSING" tests/ | xargs grep -l -i symbol 2>/dev/null`

For each hit, replace pykrx-mocking with `monkeypatch.setattr("hoga.api.symbols._fetch_mst", fake)` and delete cred-missing-path assertions (that path is gone for symbols). The single-flight/coordinator and stale-on-failure tests STAY — only the fetch source + credentials path change. Add a test: refresh succeeds with NO KRX env vars set (proves SPEC §7).

- [ ] **Step 4: Run symbol + api suite**

Run: `uv run --extra dev pytest tests/test_api_symbols.py tests/unit/api/ -v`
Expected: PASS. Then `grep -rn "_fetch_from_pykrx\|_ensure_krx_credentials\|KrxCredentialsMissing\|pykrx" hoga/api/symbols.py` → 0.

- [ ] **Step 5: Commit**

```bash
git add hoga/api/symbols.py hoga/api/error_codes.py frontend/src/api/types.ts tests/
git commit -m "feat(symbols): fetch master from KIS .mst, drop KRX cred-gate (SPEC §7), schema v2"
```

---

## Task 4: 부팅 시 빈 캐시면 백그라운드 자동 받기 (§4.4)

`.mst`는 빠르고 무인증이라, 스키마 v2 업그레이드로 캐시가 비어도 부팅 직후 자동으로 받아 검색이 빈 채로 남지 않게 한다. **부팅은 막지 않는다** — `load_disk_state`(동기)는 그대로, 자동 받기는 백그라운드 태스크로 `refresh()`(coordinator 경유, single-flight) 호출.

**Files:** Modify `hoga/api/app.py:127`, `hoga/api/symbols.py`, Test `tests/test_api_app_boot.py`

- [ ] **Step 1: Add a status accessor to symbols.py**

```python
def current_status() -> str:
    """Boot helper — current cache status without building a full response."""
    return _state.status
```

- [ ] **Step 2: Wire background auto-fetch after the synchronous disk load**

In `hoga/api/app.py`, after the existing synchronous `load_disk_state(...)` (line 127-128):

```python
        # §4.4: .mst is fast + no-auth, so an empty/old cache auto-refreshes in
        # the background (does NOT block startup; load_disk_state already ran).
        # Routed through refresh()/coordinator → single-flight, so a concurrent
        # manual click won't double-download.
        if _symbols_module.current_status() == "unavailable":
            import asyncio as _asyncio
            _asyncio.create_task(
                _symbols_module.refresh(
                    path=resolve_symbol_master_path(), data_dir=data_dir
                )
            )
```

- [ ] **Step 3: Test auto-fetch fires only on empty cache, non-blocking**

Add a test (match existing app-boot test style) that monkeypatches `symbols.refresh` to a sentinel-recording coroutine and asserts the lifespan schedules it when `current_status()=="unavailable"`, and does NOT when status is `fresh`. Keep it minimal.

- [ ] **Step 4: Run**

Run: `uv run --extra dev pytest tests/test_api_app_boot.py tests/test_api_symbols.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hoga/api/app.py hoga/api/symbols.py tests/
git commit -m "feat(symbols): boot auto-fetches .mst on empty cache (background, non-blocking)"
```

---

## Task 5: SPEC §6 갱신 + 전체 회귀

- [ ] **Step 1: Update SPEC §6**

In `docs/superpowers/specs/2026-06-05-krx-to-kis-migration-design.md` §6 table, note that the **symbol-path** KRX cleanup (`_ensure_krx_credentials`, `KrxCredentialsMissing`, `PykrxFetchError`, symbol-path `KRX_CREDENTIALS_MISSING`/`KRX_FETCH_FAILED`) landed in **Phase 2** (not Phase 4), because `.mst` is no-auth and SPEC §7 requires symbol search to work without creds. The calendar path keeps `krx_creds_present`/`KRX_CREDENTIALS_MISSING` until Phase 3.

- [ ] **Step 2: Full backend suite**

Run: `uv run --extra dev pytest tests/ -q`
Expected: ALL PASS. Symbol path no longer references pykrx; calendar still does (Phase 3).

- [ ] **Step 3: Stale-reference grep (symbol path)**

Run: `grep -rn "pykrx\|KrxCredentialsMissing\|_fetch_from_pykrx" hoga/api/symbols.py`
Expected: 0. (calendar.py still has pykrx — Phase 3.)

- [ ] **Step 4: Frontend type-check**

Run: `cd frontend && npx tsc -b`
Expected: no new errors from the `kis_master_fetch_failed` union addition.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-05-krx-to-kis-migration-design.md
git commit -m "docs(spec): §6 — symbol-path KRX cleanup landed in Phase 2 (no-auth .mst)"
```

---

## Out of scope (thin follow / later phase)
- **Frontend `security_type` 배지**(검색 결과 ETF/ETN 구분 표시): 데이터 필드가 이번 deliverable. UI 배지는 별도 thin follow.
- **calendar/거래일** → Phase 3 (+ `kis_runtime` 추출, SPEC §10).
- **pykrx·KRX_ID/PW 완전 제거** → Phase 4.

---

## Self-Review

**Spec coverage (§4):**
- §4.1 `download_master`/`parse_master` 분리 + byte-offset + cp949 → Task 1. ✓
- §4.1 `security_type`를 증권그룹구분코드에서 도출(probe 실측) → Task 1 `_classify`. ✓
- §4.2 `_fetch` 본문·이름 교체, 캐시/검색 보존 → Task 3. ✓
- §4.3 스키마 v2 + `source="kis_mst"` → Task 3 (f). ✓
- §4.4 부팅 빈 캐시 백그라운드 자동 → Task 4. ✓
- §4.5 `SymbolHit.security_type` → Task 2. ✓
- §7 종목 검색 토큰 불필요 + cred-gate 제거 → Task 3 (d). ✓
- §6 symbol-path KRX 정리를 Phase 2로 → Task 5. ✓

**advisor 피드백 반영:** probe-Task-1(실측 매핑·fixture), byte-offset(`row[21:len-tail]`), cred-gate 제거, `KIS_MASTER_FETCH_FAILED`, async+executor, `parse_master` raise(empty/HTML), security_type 한 커밋, 부팅 자동(coordinator·non-blocking), 프론트 배지 out-of-scope. ✓

**Type consistency:** `MasterRow(code,name,market,security_type)`(T1) → `SymbolHit(...security_type=r.security_type)`(T3); `SymbolHit.security_type: Literal["stock","etf","etn"]`(T2) ↔ `MasterRow.security_type` 동일; `KisMasterFetchError`(T1) → `_do_refresh` catch(T3); `UpstreamCode.KIS_MASTER_FETCH_FAILED`(T3) ↔ 프론트 미러. ✓
