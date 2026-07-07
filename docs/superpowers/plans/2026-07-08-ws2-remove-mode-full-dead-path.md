# WS2: mode=full dead path 삭제 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프론트엔드가 호출하지 않는 `/api/range?mode=full` 경로와 그 전용 빌더(range-wide volume profile, per-day volume profile, price-level hits, prev_close 워크)를 백엔드에서 제거해, 무캐시 GiB급 멀티파일 스캔 잠재 비용과 bundle 조립기의 분기 복잡성을 없앤다.

**검증 완료된 dead 판정 근거:**
- 프론트 프로덕션 mode 사용: `candles`(useLiveBundle:383) / `hoga`(:584, studyReferenceQueries:34) / `sidecar`(:598, :66, :52)뿐. `mode` 미지정 시 요청 자체가 disabled(rangeRequest.ts:90).
- `price_level_hits`는 프론트가 자체 계산(`buildLivePriceLevelHits`)해 같은 필드에 병합(useLiveBundle:825) — 백엔드 값은 프로덕션에서 항상 빈 배열로 수신 중.
- 사용자 승인: 2026-07-08 "권장순으로 진행" (후보 목록에 승인 필요 명기 후 진행 지시).

**Architecture — 와이어 shape 보존 원칙:** `RangeBundle`의 `volume_profile_range` / `volume_profile_by_day` / `price_level_hits` 필드는 유지하고 항상-빈 값으로 채운다(현재 프로덕션 3개 mode가 실제로 받는 값과 바이트 동일 → 프론트 무접촉, 리스크 0). 삭제 대상은 값을 채우던 백엔드 경로 전체.

**Tech Stack:** `uv run --extra dev pytest`.

---

### Task 1: 백엔드 삭제

**Files:**
- Modify: `hoga/api/routes.py` (mode 패턴)
- Modify: `hoga/api/bundle.py` (full_mode 분기 + 전용 빌더 삭제)
- Modify: `hoga/api/peak_slice_guard.py` (RANGE_PROFILE_GUARD 삭제)
- Modify: `hoga/tables/trades.py` (query_volume_profile, query_volume_profile_range 삭제)

**삭제 인벤토리 (심볼 단위):**

1. `routes.py`: mode Query 패턴 `^(full|hoga|sidecar|candles)$` → `^(hoga|sidecar|candles)$`
2. `bundle.py`:
   - `build_range_bundle` 시그니처: `mode: str = "full"` → `mode: str` 뒤 첫 줄에서 명시 검증:
     ```python
     if mode not in {"hoga", "sidecar", "candles"}:
         raise HTTPException(400, "mode must be one of hoga|sidecar|candles")
     ```
     (route 패턴이 1차 방어, 직접 호출자는 이 검증이 방어 — 기본값 제거로 미갱신 호출자는 시끄럽게 실패)
   - `full_mode = mode == "full"` 및 모든 분기: prev_close_by_date 워크(1378–1389), `vp_d`(1499) + `profiles_by_day` append(1562–1563), price_level_hits 블록(1586–1595), `profile_range` 삼항(1625–1629 → `_empty_volume_profile()` 고정)
   - `include_program_trade = program_trade_enabled and (full_mode or sidecar_only)` → `program_trade_enabled and sidecar_only`
   - 함수 삭제: `build_volume_profile_slice`(391–431), `build_volume_profile_range`(500–563), `build_price_level_hits_slice`(1194–1224) + 전용 헬퍼 `_limit_price_levels`(1090)·`_first_price_level_touch`(1101)·`_append_hit`(1118)·`_append_vi_hits`(1138) (bundle.py 내 다른 참조 없음 — grep 확인)
   - import 정리: `RANGE_PROFILE_GUARD`, 미사용이 된 모델/테이블 심볼
   - `_empty_volume_profile`(91)과 `profiles_by_day`/`price_level_hits` 로컬은 와이어 shape 유지용으로 존치(빈 값)
   - docstring(1313–1317)에서 volume_profile 서술 갱신
3. `peak_slice_guard.py`: `RANGE_PROFILE_GUARD` 인스턴스(118–120) + 모듈 docstring의 호스트 언급(26) 삭제
4. `trades.py`: `query_volume_profile_range`(474–518), `query_volume_profile`(520–563) 삭제. `VolumeProfileBinning`은 `query_continuous_trade_volume_distribution`(565–)가 공유하므로 존치, docstring의 두 함수 참조만 갱신

- [ ] **Step 1: 백엔드 삭제 수행** (위 인벤토리)
- [ ] **Step 2: 컴파일 게이트**

Run: `uv run python -c "import hoga.api.bundle, hoga.api.routes, hoga.tables.trades, hoga.api.peak_slice_guard"`
Expected: 임포트 에러 없음

### Task 2: 테스트 정리 + 회귀 게이트

**Files:**
- Delete: `tests/unit/api/test_vp_range_guard.py` (45줄 — dead path 전용 가드 테스트)
- Modify: `tests/hoga/api/test_bundle.py` (price_level_hits 5개 + volume_profile_range/slice 6개 테스트 삭제, full-mode 의존 어서션 조정)
- Modify: `tests/test_api_range.py` (`mode=full` 25건 → `mode=sidecar`/`hoga`로 치환, mode=full → 422 회귀 테스트 1개 추가)
- Modify: `tests/test_tables_trades.py` (query_volume_profile_range/query_volume_profile 테스트 삭제 — 493행 이후 해당 블록)
- Modify: `tests/unit/api/test_range_volume_distribution_cutoff.py` (mode=full 참조 1건 치환)
- 유지: `tests/test_models.py`, `tests/hoga/api/test_range_models.py` (와이어 필드 존치이므로 무변경 예상 — 실행으로 확인)

- [ ] **Step 1: 테스트 갱신/삭제**
- [ ] **Step 2: mode=full 거부 회귀 테스트 추가** (`tests/test_api_range.py`)

```python
def test_mode_full_removed_returns_422(app_client) -> None:
    """mode=full은 2026-07-08 dead-path 제거로 공개 API에서 퇴역."""
    resp = app_client.get(
        "/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000&mode=full"
    )
    assert resp.status_code == 422
```

(app_client fixture 서명은 기존 test_api_range.py의 픽스처를 그대로 따른다 — 스텁 기반이면 해당 파일의 클라이언트 헬퍼 사용)

- [ ] **Step 3: 전체 백엔드 스위트**

Run: `uv run --extra dev pytest tests/ -q`
Expected: 전부 PASS (사전 실패 0 기준 — WS1에서 910 green 확인)

- [ ] **Step 4: 커밋**

```bash
git add -A hoga/api/bundle.py hoga/api/routes.py hoga/api/peak_slice_guard.py hoga/tables/trades.py tests/
git commit -m "perf(api): mode=full dead path 제거 — vp_range 멀티파일 스캔·price_level_hits 백엔드 경로 퇴역, 와이어 shape 유지 (WS2)"
```
