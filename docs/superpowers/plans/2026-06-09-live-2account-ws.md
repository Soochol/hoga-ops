# /live 관심종목 2계좌 WS 26종목 (출시2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/live` 관심종목 실시간 수집을 1계좌 13종목 → 2계좌 26종목으로 확장하고, 빈 watchlist에서도 보는종목 REST 표시가 살아있게 한다.

**Architecture:** ① `kis_runtime` 싱글톤을 `account_id`별 dict로(account 1 = WS approval key 전용). ② `lifecycle._State`를 N-스트림 dict로 — **dynamic-N**(코드 있는 파티션만 연결, 빈 소켓 안 잡음), `_build_conn`/`_teardown_conn` 프리미티브를 refresh·watchdog가 공유, watchdog는 죽은 연결만 격리 복구. ③ rest_poller를 stream 생명주기에서 분리해 빈 watchlist poller-only 상태 허용(C4) + watchdog 구독말살 잠복버그 동반 수정.

**Tech Stack:** Python 3.14 / asyncio / pydantic / pytest(`uv run pytest <경로> -q`) / KIS Open API(WebSocket + REST).

**Spec:** `docs/superpowers/specs/2026-06-09-live-2account-ws-design.md` (커밋 a59ca59). 선결 스모크 통과(GO).

---

## File Structure

| 파일 | 역할 | 변경 |
|---|---|---|
| `hoga/live/kis_runtime.py` | KIS 프로세스 리소스 — account별 client/provider dict | Modify(부품1) |
| `hoga/live/lifecycle.py` | Live Capture 생명주기 — N-스트림 dynamic-N 오케스트레이션 | Modify(부품2+C4) |
| `tests/unit/live/test_kis_singleton.py` | kis_runtime 싱글톤 테스트 | Modify(dict 전환) |
| `tests/unit/live/test_kis_runtime_accounts.py` | 부품1 account dict 신규 테스트 | Create |
| `tests/unit/live/test_partition.py` | `partition_live_set` 신규 테스트 | Create |
| `tests/unit/live/test_lifecycle_start.py` | start/compute_live_set 테스트(C4로 1건 수정) | Modify |
| `tests/unit/live/test_lifecycle_dynamic_n.py` | dynamic-N start/refresh/watchdog 신규 테스트 | Create |
| `tests/unit/live/test_lifecycle_rest_poller.py` | rest_poller 분리 회귀(구독 보존) | Modify(추가) |

**무변경(이미 code-keyed / 단일 주입):** `stream.py`, `writer.py`, `buffer.py`, `ws_client.py`, `rest_poller.py`, `kis_client.py`, `hoga/api/app.py`(lifespan은 `start_live_stream`/`start_live_stream_watchdog` 시그니처 보존), `hoga/api/ws.py`.

**전제(읽어둘 것):**
- `kis_runtime.py` 현재: 프로세스 싱글톤 `_kis_client`/`_kis_token_provider`(2개). `ensure_kis_client(creds, provider)`·`ensure_kis_token_provider(path, creds)`가 저수준, `ensure_kis_client_from_env(data_dir)`가 account 0 진입점.
- `lifecycle.py` 현재: 단일 `_state.stream_obj`/`ws_task`/`stream_task`/`rest_poller`. `_start_live_stream_locked`(390)가 매 시작마다 poller 재생성(437). C4 탈출점 = line 403 `if not codes: return False`.
- `KisClient(credentials, token_provider)` — `get_approval_key()`는 appkey+secret 직접 POST(토큰 무관), `aclose()`로 정리.
- `LiveStream(*, buffer, writer, date_fn, phase_fn=None)` — `set_active_codes(set)`, `on_tick`, `run_flush_loop()`, `.ws` 주입.
- `LiveWriter(live_root)` — `<root>/{date}/{code}.jsonl`. `fsync_all`은 root 전체 순회(2 writer가 같은 root여도 멱등, code-disjoint라 충돌 없음).
- `LiveRestPoller(kis, buffer, *, interval_s=2.0)` — `on_subscribe`/`on_unsubscribe`/`set_excluded_codes`/`start()`/`async stop()`/`alive`.

**커밋 규약:** 각 태스크 끝 커밋. 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

# Phase A — 부품1: 2계좌 인증 (`kis_runtime.py`)

### Task 1: account env/cache-path 순수 헬퍼

스펙 §4. `account_id`(0-based) → env 변수명 + 토큰 캐시 경로. account 0 = 접미 없음(backcompat), account k>0 = 접미 (k+1).

**Files:**
- Modify: `hoga/live/kis_runtime.py` (모듈 상단, `_kis_client` 선언 근처)
- Create: `tests/unit/live/test_kis_runtime_accounts.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/live/test_kis_runtime_accounts.py
"""부품1 — account_id별 KIS client/provider dict (ADR-0067 / spec §4)."""
from pathlib import Path

import pytest

import hoga.live.kis_runtime as kis_runtime


@pytest.fixture(autouse=True)
def _reset():
    kis_runtime.reset_for_tests()
    yield
    kis_runtime.reset_for_tests()


def test_account_env_suffix_convention():
    assert kis_runtime._account_env(0) == ("KIS_APP_KEY", "KIS_APP_SECRET")
    assert kis_runtime._account_env(1) == ("KIS_APP_KEY_2", "KIS_APP_SECRET_2")
    assert kis_runtime._account_env(2) == ("KIS_APP_KEY_3", "KIS_APP_SECRET_3")


def test_token_cache_path_backcompat(tmp_path: Path):
    # account 0 keeps legacy filename; account k>0 gets a per-account file.
    assert kis_runtime._token_cache_path(tmp_path, 0) == tmp_path / ".local" / "kis-token.json"
    assert kis_runtime._token_cache_path(tmp_path, 1) == tmp_path / ".local" / "kis-token-1.json"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/unit/live/test_kis_runtime_accounts.py -q`
Expected: FAIL — `AttributeError: module 'hoga.live.kis_runtime' has no attribute '_account_env'`

- [ ] **Step 3: Add the helpers**

`hoga/live/kis_runtime.py` — `_lock = threading.Lock()` 줄(현재 28) 바로 아래에 추가:

```python
def _account_env(account_id: int) -> tuple[str, str]:
    """account_id(0-based) → (KEY 환경변수명, SECRET 환경변수명).

    0 = KIS_APP_KEY/SECRET(접미 없음, 기존). k>0 = 접미 (k+1) = '사람이 세는
    번호' → account_id=1 ↔ KIS_APP_KEY_2/KIS_APP_SECRET_2 (사장님 '2번째 키').
    스펙 §4 단일 정의 (위험 #6).
    """
    if account_id == 0:
        return "KIS_APP_KEY", "KIS_APP_SECRET"
    suffix = account_id + 1
    return f"KIS_APP_KEY_{suffix}", f"KIS_APP_SECRET_{suffix}"


def _token_cache_path(data_dir: Path, account_id: int) -> Path:
    """토큰 캐시 경로. account 0 = 기존 kis-token.json(backcompat — 기존 배포가
    토큰 재발급 강제당하지 않음), k>0 = kis-token-{k}.json (스펙 §2 결정 B)."""
    name = "kis-token.json" if account_id == 0 else f"kis-token-{account_id}.json"
    return data_dir / ".local" / name
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/unit/live/test_kis_runtime_accounts.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/kis_runtime.py tests/unit/live/test_kis_runtime_accounts.py
git commit -m "feat(live): account_id별 env/토큰경로 헬퍼 (부품1, 스펙 §4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 싱글톤 → account_id별 dict 전환

스펙 §4. `_kis_client`/`_kis_token_provider`(단일) → `_kis_clients`/`_kis_token_providers`(dict). 저수준 ensure_*에 `account_id=0` 추가(backcompat), `configured_account_ids`·`ensure_kis_client_for_account` 신설, `aclose`/`reset`이 전 dict 처리.

**Files:**
- Modify: `hoga/live/kis_runtime.py` (전역 선언 + ensure_*/get/set/aclose/reset)
- Modify: `tests/unit/live/test_kis_singleton.py` (dict 참조로)
- Modify: `tests/unit/live/test_kis_runtime_accounts.py` (추가)

- [ ] **Step 1: Write the failing tests** (append to `test_kis_runtime_accounts.py`)

```python
def test_configured_account_ids_single(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.configured_account_ids(tmp_path) == [0]


def test_configured_account_ids_two(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    assert kis_runtime.configured_account_ids(tmp_path) == [0, 1]


def test_configured_account_ids_stops_at_gap(tmp_path, monkeypatch):
    # account 0 only; account 1 missing → list stops (no [0, 2] skip).
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.setenv("KIS_APP_KEY_3", "k2")
    monkeypatch.setenv("KIS_APP_SECRET_3", "s2")
    assert kis_runtime.configured_account_ids(tmp_path) == [0]


def test_for_account_distinct_clients_per_account(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    c0 = kis_runtime.ensure_kis_client_for_account(0, tmp_path)
    c1 = kis_runtime.ensure_kis_client_for_account(1, tmp_path)
    assert c0 is not None and c1 is not None and c0 is not c1
    assert c0._creds.app_key == "k0"
    assert c1._creds.app_key == "k1"
    # idempotent per account (one bucket each)
    assert kis_runtime.ensure_kis_client_for_account(0, tmp_path) is c0


def test_for_account_missing_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.delenv("KIS_APP_KEY_2", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET_2", raising=False)
    assert kis_runtime.ensure_kis_client_for_account(1, tmp_path) is None
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_kis_runtime_accounts.py -q`
Expected: FAIL — `configured_account_ids` / `ensure_kis_client_for_account` not defined.

- [ ] **Step 3: Refactor `kis_runtime.py` to dicts**

Replace the singleton globals (현재 26-27):

```python
_kis_clients: dict[int, KisClient] = {}
_kis_token_providers: dict[int, KisTokenProvider] = {}
_lock = threading.Lock()
```

Replace `get_kis_client` / `set_kis_client` (현재 31-38):

```python
def get_kis_client(account_id: int = 0) -> KisClient | None:
    return _kis_clients.get(account_id)


def set_kis_client(client: KisClient | None, account_id: int = 0) -> None:
    """Stage 8 hook: inject a KisClient for an account (default 0)."""
    if client is None:
        _kis_clients.pop(account_id, None)
    else:
        _kis_clients[account_id] = client
```

Replace `ensure_kis_token_provider` (현재 41-55) — add `account_id`, key the dict:

```python
def ensure_kis_token_provider(
    token_cache_path: Path, creds: KisCredentials, account_id: int = 0
) -> KisTokenProvider:
    """Return the per-account KisTokenProvider singleton, creating it once.

    One provider per account (ADR-0038/0067). The token cache path is decided
    by the caller (see _token_cache_path) — account 0 keeps the legacy file.
    """
    global _kis_token_providers
    with _lock:
        prov = _kis_token_providers.get(account_id)
        if prov is None:
            prov = KisTokenProvider(creds, token_cache_path)
            _kis_token_providers[account_id] = prov
        return prov
```

Replace `ensure_kis_client` (현재 58-71):

```python
def ensure_kis_client(
    creds: KisCredentials, provider: KisTokenProvider, account_id: int = 0
) -> KisClient:
    """Return the per-account KisClient singleton, creating it once.

    "one app key = one 15/s bucket" holds PER ACCOUNT — each account_id has at
    most one client. account 0 carries the data bucket (REST poller / quotes /
    holiday / screener); account k>0 is used ONLY for WS approval keys (spec §4).
    Closed at process shutdown via aclose_kis_client — a stream/conn stop must NOT
    close it (R1).
    """
    global _kis_clients
    with _lock:
        client = _kis_clients.get(account_id)
        if client is None:
            client = KisClient(credentials=creds, token_provider=provider)
            _kis_clients[account_id] = client
        return client
```

Replace `_resolve_env_creds` (현재 84-101) — parametrize by account_id:

```python
def _resolve_env_creds(
    account_id: int = 0, *, reload_env: bool = False
) -> KisCredentials | None:
    """env → KisCredentials for the account, or None when its key/secret absent.

    ``reload_env`` re-reads .env once on a miss (user-retry paths only; boot
    paths keep boot-time env semantics). account 0 uses KIS_APP_KEY/SECRET;
    account k>0 uses the suffixed names (see _account_env).
    """
    key_name, sec_name = _account_env(account_id)
    app_key = os.environ.get(key_name)
    app_secret = os.environ.get(sec_name)
    if (not app_key or not app_secret) and reload_env:
        _reload_env_for_retry()
        app_key = os.environ.get(key_name)
        app_secret = os.environ.get(sec_name)
    if not app_key or not app_secret:
        return None
    return KisCredentials(app_key=app_key, app_secret=app_secret, env="real")
```

Replace `ensure_kis_token_provider_from_env` (현재 104-125) — account 0 specialization preserved (sync holiday path):

```python
def ensure_kis_token_provider_from_env(
    data_dir: Path | None = None,
    *,
    reload_env: bool = False,
) -> tuple[KisTokenProvider, KisCredentials] | None:
    """Resolve account-0 creds from env and return (provider, creds), or None.
    For consumers that need the token + auth headers but NOT the async data
    client (e.g. the sync holiday path). account-0 only (backcompat)."""
    creds = _resolve_env_creds(0, reload_env=reload_env)
    if creds is None:
        return None
    if data_dir is None:
        from hoga.config import resolve_data_dir

        data_dir = resolve_data_dir()
    provider = ensure_kis_token_provider(_token_cache_path(data_dir, 0), creds, 0)
    return provider, creds
```

Add the account-aware client factory + `configured_account_ids`, and rewrite `ensure_kis_client_from_env` as an alias (replace 현재 128-143):

```python
def ensure_kis_client_for_account(account_id: int, data_dir: Path) -> KisClient | None:
    """Resolve the account's creds from env and return its KisClient singleton,
    or None when that account's key/secret are absent.

    account 0 lands its token cache at the legacy path; k>0 at kis-token-{k}.json.
    Used by lifecycle._build_conn(account_id) for the per-account WS approval key.
    """
    creds = _resolve_env_creds(account_id)  # boot semantics (no reload_env)
    if creds is None:
        return None
    provider = ensure_kis_token_provider(
        _token_cache_path(data_dir, account_id), creds, account_id
    )
    return ensure_kis_client(creds, provider, account_id)


def ensure_kis_client_from_env(data_dir: Path) -> KisClient | None:
    """account-0 KisClient singleton, or None when creds absent.

    Backcompat alias for ensure_kis_client_for_account(0, ...) — the shared
    15/s-bucket client used by REST poller / quotes / holiday / screener.
    """
    return ensure_kis_client_for_account(0, data_dir)


def configured_account_ids(data_dir: Path) -> list[int]:
    """Contiguous list of account_ids whose env key+secret are present, starting
    at 0. [0] when only account 0 is set (→ 13종목·1스트림 폴백); [0, 1] when
    KIS_APP_KEY_2/SECRET_2 also set (→ 26종목). Stops at the first gap (no skips).
    """
    ids: list[int] = []
    account_id = 0
    while _resolve_env_creds(account_id) is not None:
        ids.append(account_id)
        account_id += 1
    return ids
```

Replace `aclose_kis_client` (현재 146-162) — close ALL accounts:

```python
async def aclose_kis_client() -> None:
    """Close and drop ALL per-account KisClient + KisTokenProvider singletons —
    PROCESS shutdown only. A stream/conn stop must not call this (R1)."""
    global _kis_clients, _kis_token_providers
    for client in list(_kis_clients.values()):
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass
    _kis_clients = {}
    for prov in list(_kis_token_providers.values()):
        try:
            prov.close()
        except Exception:  # noqa: BLE001
            pass
    _kis_token_providers = {}
```

Replace `reset_for_tests` (현재 165-176):

```python
def reset_for_tests() -> None:
    """Test helper — drop all per-account singletons (best-effort provider close)."""
    global _kis_clients, _kis_token_providers
    for prov in list(_kis_token_providers.values()):
        try:
            prov.close()
        except Exception:  # noqa: BLE001
            pass
    _kis_clients = {}
    _kis_token_providers = {}
```

- [ ] **Step 4: Update `test_kis_singleton.py` to dict references**

Two assertions read the old singular global. Replace in `tests/unit/live/test_kis_singleton.py`:

`test_aclose_closes_and_nulls_both_singletons` body — change the three `kis_runtime._kis_client` / `_kis_token_provider` references:

```python
@pytest.mark.asyncio
async def test_aclose_closes_and_nulls_both_singletons(tmp_path: Path) -> None:
    creds = KisCredentials(app_key="K", app_secret="S", env="real")
    provider = kis_runtime.ensure_kis_token_provider(tmp_path / ".local" / "kis-token.json", creds)
    client = kis_runtime.ensure_kis_client(creds, provider)
    assert kis_runtime._kis_clients[0] is client
    await kis_runtime.aclose_kis_client()
    assert kis_runtime._kis_clients == {}
    assert kis_runtime._kis_token_providers == {}
```

- [ ] **Step 5: Run to verify pass**

Run: `uv run pytest tests/unit/live/test_kis_runtime_accounts.py tests/unit/live/test_kis_singleton.py -q`
Expected: PASS (all). The `ensure_*(... )` no-account_id calls default to account 0 → existing singleton semantics preserved.

- [ ] **Step 6: Commit**

```bash
git add hoga/live/kis_runtime.py tests/unit/live/test_kis_runtime_accounts.py tests/unit/live/test_kis_singleton.py
git commit -m "feat(live): kis_runtime 싱글톤 → account_id별 dict (부품1, 스펙 §4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 부품1 회귀 — 기존 KIS 소비자 무변경 확인

휴장/스크리너/quotes 호출부가 `ensure_kis_client_from_env`(=account 0 별칭)·`get_kis_client()`(=account 0)로 무변경 동작하는지 전체 live 테스트로 확인.

**Files:**
- Test only (no source change)

- [ ] **Step 1: Run the full live suite**

Run: `uv run pytest tests/unit/live -q`
Expected: PASS. 부품1이 account-0 경로를 바꾸지 않았음을 보장(quotes/holiday/screener 테스트 포함).

- [ ] **Step 2: Grep for any direct singular-global reader left**

Run: `grep -rn "_kis_client\b\|_kis_token_provider\b" hoga/ tests/ | grep -v "_kis_clients\|_kis_token_providers"`
Expected: no production hits (only comments/docstrings). If a `hoga/` hit appears, update it to the dict form (`get_kis_client()` or `_kis_clients[0]`).

- [ ] **Step 3: Commit (only if Step 2 required a fix; else skip)**

```bash
git add -A && git commit -m "fix(live): 잔여 단일-싱글톤 참조를 account dict로 정리 (부품1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase B — 부품2 프리미티브 (`lifecycle.py`)

### Task 4: `partition_live_set` 순수 함수 (Q4 연속 슬라이스)

스펙 §5.3. display-order 연속 배정: account k = `codes[k*13:(k+1)*13]`.

**Files:**
- Modify: `hoga/live/lifecycle.py` (Live Set 상수 근처, `_compute_live_set` 위)
- Create: `tests/unit/live/test_partition.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/live/test_partition.py
"""partition_live_set — 연속 슬라이스 13/13 (스펙 §5.3, Q4)."""
from hoga.live.lifecycle import _PER_ACCOUNT_MAX, partition_live_set


def _codes(n: int) -> list[str]:
    return [f"{i:06d}" for i in range(n)]


def test_partition_26_into_2_is_13_13():
    parts = partition_live_set(_codes(26), 2)
    assert len(parts) == 2
    assert parts[0] == _codes(26)[:13]
    assert parts[1] == _codes(26)[13:26]


def test_partition_13_into_2_leaves_second_empty():
    parts = partition_live_set(_codes(13), 2)
    assert parts[0] == _codes(13)
    assert parts[1] == []


def test_partition_14_into_2_puts_14th_on_account_1():
    parts = partition_live_set(_codes(14), 2)
    assert len(parts[0]) == 13
    assert parts[1] == ["000013"]  # the 14th code (0-based index 13)


def test_partition_13_into_1():
    parts = partition_live_set(_codes(13), 1)
    assert parts == [_codes(13)]


def test_partition_stable_account_0_unchanged_when_appending_14th():
    # Appending a 14th code must NOT move any of account 0's first 13.
    a = partition_live_set(_codes(13), 2)
    b = partition_live_set(_codes(14), 2)
    assert a[0] == b[0]


def test_per_account_max_is_13():
    assert _PER_ACCOUNT_MAX == 13
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_partition.py -q`
Expected: FAIL — `cannot import name '_PER_ACCOUNT_MAX' / 'partition_live_set'`.

- [ ] **Step 3: Add constant + function**

`hoga/live/lifecycle.py` — replace the Live Set constants block (현재 41-43):

```python
KIS_WS_MAX_REGISTRATIONS = 41   # appkey당, (tr_id, code) 쌍 기준 — spec §4 검증 완료
TRS_PER_CODE = 3                # 호가 + 체결 + 회원사(H0STMBC0)
_PER_ACCOUNT_MAX = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # = 13 (계좌당 한도)
# 동적 상한: 13 * n_configured. start에서 n_configured를 곱해 _compute_live_set이 사용.
LIVE_SET_MAX_CODES = _PER_ACCOUNT_MAX  # 1계좌 기본(_compute_live_set이 n_configured로 동적 절단)


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order 연속 배정: account k = codes[k*13:(k+1)*13] (스펙 §5.3, Q4).

    n개 리스트를 항상 반환(후행은 빈 리스트일 수 있음). 연속 슬라이스라
    13-경계를 안 넘는 코드는 계좌 고정 → 재정렬 churn 최소(위험 #4). 해시 배정
    대신 연속을 택한 이유: CONTEXT.md 'top-13=경계' 모델 일치 + explicit>clever.
    """
    return [codes[k * _PER_ACCOUNT_MAX:(k + 1) * _PER_ACCOUNT_MAX] for k in range(n)]
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/live/test_partition.py -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_partition.py
git commit -m "feat(live): partition_live_set 연속 슬라이스 (부품2, 스펙 §5.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `_StreamConn` + `_State` dict 전환

스펙 §5.1. `_State`를 N-스트림 dict로. `_compute_live_set`는 `n_configured` 인자로 동적 절단. `get_active_codes`/`reset_for_tests`는 새 구조에 맞춤. **이 태스크에서 stream을 아직 안 만든다** — 구조만 바꾸고 다음 태스크들이 채운다. `_start_live_stream_locked`/`refresh`/watchdog/`get_status`는 Task 7-10에서 재작성하므로, 본 태스크는 컴파일·기존 테스트 통과까지만 보장(임시로 단일 경로 유지).

> 주의: 본 태스크는 `_State` 필드를 추가하되 기존 단일 필드(`stream_obj`/`ws_task`/`stream_task`)도 **남겨둔다**(Task 10이 제거). 그래야 Task 7 컷오버 적용 전까지 기존 start/stop/get_status가 깨지지 않는다. 점진 전환(make-the-change-easy).

**Files:**
- Modify: `hoga/live/lifecycle.py` (`_StreamConn` 신설, `_State`에 `streams`/`n_configured` 추가, `_compute_live_set` 시그니처, `get_active_codes`, `reset_for_tests`)

- [ ] **Step 1: Add `_StreamConn` + extend `_State`**

`hoga/live/lifecycle.py` — `@dataclass class _State` 위에 추가:

```python
@dataclass
class _StreamConn:
    """한 KIS 계좌의 WS 연결 묶음 (dynamic-N: codes 항상 비어있지 않음)."""
    account_id: int
    stream_obj: object            # LiveStream — 자체 writer 소유, code-disjoint
    ws_task: "asyncio.Task"       # type: ignore[type-arg]
    flush_task: "asyncio.Task"    # type: ignore[type-arg]
    codes: tuple[str, ...]
```

Extend `_State` (현재 138-150) — **add** `streams` + `n_configured`, keep legacy fields for now:

```python
@dataclass
class _State:
    """In-process state of the live stream. Mutated only via this module."""

    started_at_ms: int | None = None
    n_configured: int = 0                          # start에 1회 산출·캐시(Q5)
    watchlist_codes: tuple[str, ...] = field(default_factory=tuple)
    # dynamic-N: account_id 키 연결 dict (Task 7이 채움)
    streams: dict[int, _StreamConn] = field(default_factory=dict)
    live_set: tuple[str, ...] = field(default_factory=tuple)
    rest_poller: "LiveRestPoller | None" = None
    # ── 레거시 단일 경로(Task 10에서 제거) — 컷오버 적용 전까지 컴파일 호환 ──
    stream_task: "asyncio.Task | None" = None      # type: ignore[type-arg]
    stream_obj: object | None = None
    ws_task: "asyncio.Task | None" = None          # type: ignore[type-arg]
```

- [ ] **Step 2: Make `_compute_live_set` take n_configured**

Replace `_compute_live_set` (현재 67-81) — last line uses dynamic cap:

```python
def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    """Live Set 산출 파이프라인(start/refresh 공용):
    load_document → 표시 순서 평탄화 → symbol-master 필터(cold cache 무필터
    폴백) → 상위 (13 * n_configured) 절단."""
    from hoga.api import symbols as _symbols  # noqa: PLC0415
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    ordered = display_ordered_codes(load_document(data_dir))
    known = {h.code for h in _symbols.search("", limit=10_000)}
    if known:
        dropped = [c for c in ordered if c not in known]
        if dropped:
            _log.warning("live.stream.codes_unknown dropped=%r", dropped)
        ordered = [c for c in ordered if c in known]
    return ordered[: _PER_ACCOUNT_MAX * n_configured]
```

> `test_lifecycle_start.py`의 `_compute_live_set(tmp_path)` 호출은 기본값 n_configured=1로 그대로 통과(13 절단 동일).

- [ ] **Step 3: `get_active_codes` unchanged semantics**

`get_active_codes` (현재 177)는 `_state.watchlist_codes`를 읽으므로 **변경 불필요**(Task 7이 watchlist_codes를 계속 채운다). 확인만.

- [ ] **Step 4: Run existing tests (compile + no regression)**

Run: `uv run pytest tests/unit/live/test_lifecycle_start.py tests/unit/live/test_lifecycle.py -q`
Expected: PASS — 구조만 추가했고 레거시 필드를 남겨 기존 경로 무변경.

- [ ] **Step 5: Commit**

```bash
git add hoga/live/lifecycle.py
git commit -m "refactor(live): _StreamConn + _State dynamic-N 구조 추가(레거시 병존) (부품2, 스펙 §5.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `_build_conn` / `_teardown_conn` 프리미티브 (R1·R2)

스펙 §5.2. refresh·watchdog가 공유. **R1: teardown는 KisClient를 닫지 않는다.** `_today_kst`를 모듈 레벨로 hoist.

**Files:**
- Modify: `hoga/live/lifecycle.py` (`_build_conn`/`_teardown_conn`/`_today_kst` 추가)
- Create test in `tests/unit/live/test_lifecycle_dynamic_n.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/live/test_lifecycle_dynamic_n.py
"""dynamic-N 프리미티브 + start/refresh/watchdog (스펙 §5)."""
import asyncio
from pathlib import Path

import pytest

import hoga.live.kis_runtime as kis_runtime
import hoga.live.lifecycle as lifecycle


@pytest.fixture(autouse=True)
def _reset():
    lifecycle.reset_for_tests()
    yield
    lifecycle.reset_for_tests()


class _FakeKis:
    """get_approval_key만 쓰는 _build_conn용 가짜 KIS client."""
    def __init__(self, account_id: int) -> None:
        self._creds = type("C", (), {"app_key": f"k{account_id}"})()
        self.aclose_calls = 0

    async def get_approval_key(self) -> str:
        return "APPROVAL"

    async def aclose(self) -> None:
        self.aclose_calls += 1


@pytest.mark.asyncio
async def test_build_conn_creates_tasks_and_teardown_keeps_client(tmp_path, monkeypatch):
    # _build_conn은 account의 KisClient를 ensure_kis_client_for_account로 얻는다.
    fake = _FakeKis(1)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: fake,
    )
    # WS가 실제 네트워크를 치지 않도록 게이트를 닫아 run()이 sleep하게 한다.
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    conn = lifecycle._build_conn(1, ["005930"], tmp_path)
    assert conn.account_id == 1
    assert conn.codes == ("005930",)
    assert not conn.ws_task.done() and not conn.flush_task.done()

    await lifecycle._teardown_conn(conn)
    assert conn.ws_task.done() and conn.flush_task.done()
    # R1: teardown는 KisClient를 닫지 않는다.
    assert fake.aclose_calls == 0


@pytest.mark.asyncio
async def test_teardown_conn_idempotent(tmp_path, monkeypatch):
    fake = _FakeKis(0)
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: fake,
    )
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    conn = lifecycle._build_conn(0, ["005930"], tmp_path)
    await lifecycle._teardown_conn(conn)
    await lifecycle._teardown_conn(conn)  # 두 번째도 무해(done task cancel = no-op)
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_lifecycle_dynamic_n.py -q`
Expected: FAIL — `_build_conn` not defined.

- [ ] **Step 3: Add `_today_kst` (module level) + primitives**

`hoga/live/lifecycle.py` — add near the other module helpers (after `_now_ms`, 현재 196):

```python
def _today_kst() -> str:
    from datetime import datetime, timedelta, timezone  # noqa: PLC0415

    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


def _build_conn(account_id: int, codes: list[str], data_dir: Path) -> _StreamConn:
    """한 계좌의 WS 연결 묶음 생성 (스펙 §5.2). 호출자(start/refresh/watchdog)는
    account_id ∈ configured_account_ids 임을 보장하므로 client는 non-None.

    각 conn은 자체 LiveStream+LiveWriter(code-disjoint라 (date,code) 충돌 없음).
    공유: 단일 _buffer. KisClient는 kis_runtime의 account별 싱글톤(재사용)."""
    from .stream import LiveStream  # noqa: PLC0415
    from .writer import LiveWriter  # noqa: PLC0415
    from .ws_client import KisWsClient  # noqa: PLC0415
    from .session_gate import ws_capture_window  # noqa: PLC0415

    kis = kis_runtime.ensure_kis_client_for_account(account_id, data_dir)
    if kis is None:  # configured 보장 위반 — 방어적
        raise RuntimeError(f"no KIS client for account {account_id}")

    stream = LiveStream(
        buffer=_buffer,
        writer=LiveWriter(data_dir / "live"),
        date_fn=_today_kst,
    )
    stream.set_active_codes(set(codes))
    ws = KisWsClient(
        approval_key_fn=kis.get_approval_key,
        on_tick=stream.on_tick,
        date_fn=_today_kst,
        gate_fn=lambda: ws_capture_window(_now_ms()),
    )
    stream.ws = ws
    return _StreamConn(
        account_id=account_id,
        stream_obj=stream,
        ws_task=asyncio.create_task(ws.run(codes), name=f"live-ws-{account_id}"),
        flush_task=asyncio.create_task(stream.run_flush_loop(), name=f"live-flush-{account_id}"),
        codes=tuple(codes),
    )


async def _teardown_conn(conn: _StreamConn) -> None:
    """conn의 ws/flush task만 cancel+await. ★ R1: KisClient는 닫지 않는다
    (account 싱글톤은 kis_runtime dict에 남아 다음 _build_conn이 재사용)."""
    for task in (conn.ws_task, conn.flush_task):
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                # M4: 외부에서 우리가 취소된 경우만 전파, 자식 취소는 흡수.
                cur = asyncio.current_task()
                if cur is not None and cur.cancelling():
                    raise
            except Exception:  # noqa: BLE001
                pass
```

- [ ] **Step 4: Run to verify pass**

Run: `uv run pytest tests/unit/live/test_lifecycle_dynamic_n.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle_dynamic_n.py
git commit -m "feat(live): _build_conn/_teardown_conn 프리미티브 (부품2 R1·R2, 스펙 §5.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase C — lifecycle 재작성 (dynamic-N + C4)

> **⚠️ 원자적 컷오버 — Tasks 7·8·9·10은 한 묶음이다.** `start`/`refresh`/`watchdog`/`get_status`가 모두 `_state.streams` dict로 *동시에* 전환된다(start만 바꾸면 나머지가 레거시 필드를 읽어 깨진다). 따라서 **Task 7-10의 소스 변경을 모두 적용한 뒤** Task 10 마지막에서 한 번에 테스트·커밋한다. 중간 태스크의 "run to verify" 스텝은 *작성 의도 확인용*이며, 그린 게이트는 Task 10이다. subagent-driven 실행 시 Task 7-10을 **한 리뷰 묶음**으로 디스패치하라.

### Task 7: `_start_live_stream_locked` 재작성 — dynamic-N + poller 분리 + C4

스펙 §3·§5.4. poller를 stream보다 먼저·독립 생성(재사용), 빈 watchlist도 poller-only로 성공(C4), 코드 있는 파티션만 conn 생성. 레거시 단일 필드 제거. `_stop_live_stream_locked`·`get_status`·watchdog가 새 구조를 읽도록 같이 수정(이 태스크에서 최소한 컴파일+start/stop 테스트 통과).

**Files:**
- Modify: `hoga/live/lifecycle.py` (`_start_live_stream_locked`, `_stop_live_stream_locked`, `_sync_and_live_set` 제거/흡수, `_State`에서 레거시 필드 제거, `get_status`·watchdog는 Task 9-10 전 임시 호환)
- Modify: `tests/unit/live/test_lifecycle_start.py` (빈 watchlist → True로)

- [ ] **Step 1: Update the empty-watchlist test to C4 behavior**

`tests/unit/live/test_lifecycle_start.py` — replace `test_start_live_stream_returns_falsy_when_watchlist_empty` (현재 41-52):

```python
@pytest.mark.asyncio
async def test_start_live_stream_poller_only_when_watchlist_empty(
    tmp_path: Path, monkeypatch,
) -> None:
    """C4: 빈 watchlist여도 creds 있으면 poller-only로 시작(보는종목 표시 살림)."""
    from hoga.live import lifecycle, session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    _write_watchlist(tmp_path, [])
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True
    st = lifecycle.get_status()
    assert st.running is True          # poller alive = 서비스 중
    assert st.live_set == []           # WS 연결 0
    assert lifecycle._state.rest_poller is not None
    await lifecycle.stop_live_stream()
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_lifecycle_start.py::test_start_live_stream_poller_only_when_watchlist_empty -q`
Expected: FAIL — 현재 `start_live_stream` returns False on empty watchlist.

- [ ] **Step 3: Rewrite start/stop**

`hoga/live/lifecycle.py` — remove `_sync_and_live_set` (현재 89-102) entirely (its exclusion-sync moves inline). Then replace `_start_live_stream_locked` (현재 390-451) and `_stop_live_stream_locked` (현재 454-474):

```python
def _ensure_poller(data_dir: Path) -> "LiveRestPoller | None":
    """rest_poller를 1회 생성·재사용(§3 분리). creds(account 0) 없으면 None.
    이미 있으면 그대로 반환 → _subscribed(보는종목) 보존(잠복 버그 수정)."""
    from .rest_poller import LiveRestPoller  # noqa: PLC0415

    if _state.rest_poller is not None:
        return _state.rest_poller
    kis = kis_runtime.ensure_kis_client_from_env(data_dir)  # account 0
    if kis is None:
        return None
    poller = LiveRestPoller(kis, _buffer)
    poller.start()
    return poller


def _sync_exclusion(poller: "LiveRestPoller | None", live_set: tuple[str, ...]) -> None:
    """배타 동기화: WS 수집 종목(live_set)을 poller 배제로(ADR-0067 §5).
    exclude-then-subscribe 순서를 위해 conn build/update 전에 호출(스펙 §5.5)."""
    if poller is not None:
        poller.set_excluded_codes(set(live_set))


async def _start_live_stream_locked(*, data_dir: Path) -> bool:
    """start의 본체(락 보유 중). dynamic-N + poller 분리 + C4 (스펙 §5.4)."""
    # 1. account 0 creds 게이트(완전 오프라인이면 stop만)
    n_configured = len(kis_runtime.configured_account_ids(data_dir))
    if n_configured == 0:
        return False

    # 2. 기존 conn 정지(poller는 보존)
    await _stop_streams_locked()

    # 3. poller 보장(없으면 생성, 있으면 _subscribed 보존)
    poller = _ensure_poller(data_dir)
    if poller is None:
        return False  # account 0 creds 사라짐(레이스) — 오프라인

    # 4. Live Set 산출(동적 절단)
    codes = _compute_live_set(data_dir, n_configured)
    parts = partition_live_set(codes, n_configured)

    # 5. exclude-then-subscribe: 먼저 배제 동기화, 그 다음 conn build
    live_set = tuple(codes)
    _sync_exclusion(poller, live_set)

    # 6. 코드 있는 파티션만 conn 생성(dynamic-N; 빈 part = 연결 없음 → C4)
    streams: dict[int, _StreamConn] = {}
    for account_id, part in enumerate(parts):
        if part:
            streams[account_id] = _build_conn(account_id, part, data_dir)

    global _state  # noqa: PLW0603
    _state = _State(
        started_at_ms=_now_ms(),
        n_configured=n_configured,
        watchlist_codes=live_set,
        streams=streams,
        live_set=live_set,
        rest_poller=poller,
    )
    return True


async def _stop_streams_locked() -> None:
    """현재 conn들만 teardown(poller·_state.rest_poller는 보존)."""
    for conn in list(_state.streams.values()):
        await _teardown_conn(conn)
    _state.streams.clear()


async def _stop_live_stream_locked() -> None:
    """완전 정지 — conn teardown + poller stop + _state 리셋."""
    global _state  # noqa: PLW0603
    poller = _state.rest_poller
    await _stop_streams_locked()
    if poller is not None:
        await poller.stop()
    _state = _State()
```

Then remove the now-unused legacy `_State` fields (`stream_task`/`stream_obj`/`ws_task`) added in Task 5 — replace the `_State` legacy block with nothing (delete those three lines). The dataclass becomes streams-only.

- [ ] **Step 4: (원자 컷오버 — 여기선 테스트·커밋 안 함) 컴파일만 확인하고 Task 8로**

start/stop만 streams dict로 바꾼 이 시점엔 기존 get_status/watchdog가 레거시 필드(이제 start가 안 채움)를 읽어 일시 어긋난다. 그래서 **여기서 그린 테스트·커밋을 하지 않는다**(배너의 원자 컷오버). 레거시 `_State` 필드는 그대로 두고(Task 10이 제거), 구문/이름 오류만 확인 후 Task 8로 진행한다. 그린 게이트·커밋은 Task 10.

Run: `uv run python -c "import hoga.live.lifecycle"`
Expected: no ImportError (구문·이름 오류 없음).

---

### Task 8: `refresh_live_stream` 재작성 — dynamic-N create/teardown

스펙 §5.5. 기존 conn diff(update_codes) + 빈→찬 build + 찬→빈 teardown + exclude-then-subscribe.

**Files:**
- Modify: `hoga/live/lifecycle.py` (`refresh_live_stream` 현재 507-535)
- Modify: `tests/unit/live/test_lifecycle_dynamic_n.py` (refresh 테스트 추가)

- [ ] **Step 1: Write the failing test** (append)

```python
async def _start_two_accounts(tmp_path, monkeypatch, codes):
    """헬퍼: 2계좌 환경 + 가짜 client로 start (WS는 게이트 닫힘이라 무네트워크)."""
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_for_account",
        lambda account_id, data_dir: _FakeKis(account_id),
    )
    monkeypatch.setattr(
        kis_runtime, "ensure_kis_client_from_env",
        lambda data_dir: _FakeKis(0),
    )
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, codes)
    # symbol-master 필터 무력화(모든 코드 통과)
    from hoga.api import symbols
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True


@pytest.mark.asyncio
async def test_refresh_builds_second_conn_when_crossing_13(tmp_path, monkeypatch):
    codes13 = [f"{i:06d}" for i in range(13)]
    await _start_two_accounts(tmp_path, monkeypatch, codes13)
    assert set(lifecycle._state.streams.keys()) == {0}   # conn-1 아직 없음

    # 14번째 추가 → conn-1 신규 생성(연결 생성 분기)
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, codes13 + ["000013"])
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert set(lifecycle._state.streams.keys()) == {0, 1}
    assert lifecycle._state.streams[1].codes == ("000013",)
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_refresh_tears_down_second_conn_when_dropping_to_13(tmp_path, monkeypatch):
    codes14 = [f"{i:06d}" for i in range(14)]
    await _start_two_accounts(tmp_path, monkeypatch, codes14)
    assert set(lifecycle._state.streams.keys()) == {0, 1}

    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, codes14[:13])
    await lifecycle.refresh_live_stream(data_dir=tmp_path)
    assert set(lifecycle._state.streams.keys()) == {0}   # conn-1 해체(빈 소켓 안 남김)
    await lifecycle.stop_live_stream()
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_lifecycle_dynamic_n.py -k refresh -q`
Expected: FAIL — refresh가 아직 dynamic-N 미지원(레거시 단일 경로).

- [ ] **Step 3: Rewrite `refresh_live_stream`**

`hoga/live/lifecycle.py` — replace `refresh_live_stream` (현재 507-535):

```python
async def refresh_live_stream(*, data_dir: Path) -> None:
    """watchlist 변경 후크 — dynamic-N create/teardown (스펙 §5.5).

    streams=={}면(부팅·C4 poller-only) start로 위임. 아니면 account별로:
    part 차면 build, 비면 teardown, 둘 다 있으면 update_codes diff.
    """
    global _state  # noqa: PLW0603

    async with _lifecycle_lock:
        if not _state.streams and _state.rest_poller is None:
            # 한 번도 시작 안 됨 → start가 가드(creds/빈 watchlist) 수행
            await _start_live_stream_locked(data_dir=data_dir)
            return
        if not _state.streams:
            # C4 poller-only 상태에서 watchlist 채워짐 → start로 conn 생성
            await _start_live_stream_locked(data_dir=data_dir)
            return

        n = _state.n_configured
        codes = _compute_live_set(data_dir, n)
        parts = partition_live_set(codes, n)
        live_set = tuple(codes)

        # exclude-then-subscribe: build/update 전에 배제 동기화(스펙 §5.5)
        _sync_exclusion(_state.rest_poller, live_set)

        for account_id, part in enumerate(parts):
            conn = _state.streams.get(account_id)
            if part and conn is not None:
                await conn.stream_obj.ws.update_codes(part)      # type: ignore[union-attr]
                conn.stream_obj.set_active_codes(set(part))      # type: ignore[union-attr]
                _state.streams[account_id] = _StreamConn(
                    account_id=account_id, stream_obj=conn.stream_obj,
                    ws_task=conn.ws_task, flush_task=conn.flush_task,
                    codes=tuple(part),
                )
            elif part and conn is None:
                _state.streams[account_id] = _build_conn(account_id, part, data_dir)
            elif not part and conn is not None:
                await _teardown_conn(conn)
                _state.streams.pop(account_id, None)

        await _buffer.drop_codes_except(set(codes))  # 떠난 코드 ring 해제
        _state = replace(_state, live_set=live_set, watchlist_codes=live_set)
```

- [ ] **Step 4: (원자 컷오버 — 보류) 컴파일만 확인하고 Task 9로**

Run: `uv run python -c "import hoga.live.lifecycle"`
Expected: no ImportError. refresh 테스트(Step 1)는 Task 10에서 watchdog/get_status 완성 후 함께 그린.

---

### Task 9: watchdog 연결별 격리 복구 (`_restart_conn`)

스펙 §5.6, Q6. dead/stale 연결만 재기동. dict 원자 순회(await 금지) → 재시작은 lock 안.

**Files:**
- Modify: `hoga/live/lifecycle.py` (`_ws_watchdog_check` 현재 539-601, `_restart_conn` 신설)
- Modify: `tests/unit/live/test_lifecycle_dynamic_n.py` (watchdog 테스트 추가)

- [ ] **Step 1: Write the failing test** (append)

```python
@pytest.mark.asyncio
async def test_watchdog_restarts_only_dead_conn(tmp_path, monkeypatch):
    codes26 = [f"{i:06d}" for i in range(26)]
    await _start_two_accounts(tmp_path, monkeypatch, codes26)
    s = lifecycle._state.streams
    assert set(s.keys()) == {0, 1}
    conn0_ws_task, conn1 = s[0].ws_task, s[1]

    # conn-1의 ws_task만 죽인다(dead)
    s[1].ws_task.cancel()
    try:
        await s[1].ws_task
    except asyncio.CancelledError:
        pass
    assert s[1].ws_task.done()

    # 게이트를 열어 watchdog가 재시작 판정하도록 + start_live_stream 전체 재시작 금지 확인
    monkeypatch.setattr(lifecycle, "_now_ms", lambda: 0)
    import hoga.live.session_gate as sg
    monkeypatch.setattr(sg, "ws_capture_window", lambda _t: True)

    restarted = await lifecycle._ws_watchdog_check(
        data_dir=tmp_path, now_ms=0, stale_after_ms=120_000,
    )
    assert restarted is True
    # conn-0는 그대로(같은 ws_task 객체), conn-1만 새 task
    assert lifecycle._state.streams[0].ws_task is conn0_ws_task
    assert lifecycle._state.streams[1].ws_task is not conn1.ws_task
    await lifecycle.stop_live_stream()
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_lifecycle_dynamic_n.py -k watchdog -q`
Expected: FAIL — watchdog가 아직 단일 경로.

- [ ] **Step 3: Add `_restart_conn` + rewrite `_ws_watchdog_check`**

`hoga/live/lifecycle.py` — replace `_ws_watchdog_check` (현재 539-601):

```python
async def _restart_conn(account_id: int, *, data_dir: Path) -> None:
    """죽은 conn 하나만 격리 복구(스펙 §5.6, Q6). lock 안 재검증 → teardown+build.
    R1: KisClient는 보존. 현재 파티션으로 재계산해 그 사이 watchlist 변화 흡수."""
    async with _lifecycle_lock:
        conn = _state.streams.get(account_id)
        if conn is None:
            return
        n = _state.n_configured
        parts = partition_live_set(_compute_live_set(data_dir, n), n)
        codes = parts[account_id] if account_id < len(parts) else []
        await _teardown_conn(conn)
        if codes:
            _state.streams[account_id] = _build_conn(account_id, codes, data_dir)
        else:
            _state.streams.pop(account_id, None)   # 그 사이 watchlist 축소됨


async def _ws_watchdog_check(
    *, data_dir: Path, now_ms: int, stale_after_ms: int
) -> bool:
    """One WS watchdog pass — 연결별 격리 복구(결정 C, Q6). Returns True iff
    어떤 conn이라도 재시작했으면.

    dict 원자 순회(advisor): streams 순회 중 await 금지 — 단일 이벤트루프
    (ADR-0038)라 await-free 순회만 원자적. dead/stale 대상을 동기 수집한 뒤
    변이는 _restart_conn(lock 안)에서.
    """
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415
    from .session_gate import ws_capture_window  # noqa: PLC0415

    if not await asyncio.to_thread(ws_capture_window, now_ms):
        return False
    started = _state.started_at_ms
    if started is None:
        return False

    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    session_open_ms = int(
        kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
    )
    ref_ms = max(started, session_open_ms)

    # 동기 수집(await 없음): 재시작 대상 account_id 목록
    to_restart: list[int] = []
    for account_id, conn in _state.streams.items():
        dead = conn.ws_task.done() or conn.flush_task.done()
        ws = getattr(conn.stream_obj, "ws", None)
        _healthy, reason = _capture_health(
            running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
            stale_after_ms=stale_after_ms, market_closed=False,
        )
        if dead or reason == "stale":
            _log.warning("live.stream.watchdog_restart acct=%d dead=%s reason=%s",
                         account_id, dead, reason)
            to_restart.append(account_id)
        elif reason == "sub_failed":
            _log.warning("live.stream.sub_failed acct=%d acked=%s expected=%s — 재시작 안 함",
                         account_id, getattr(ws, "sub_acked", 0),
                         getattr(ws, "sub_expected", 0))

    for account_id in to_restart:
        await _restart_conn(account_id, data_dir=data_dir)
    return bool(to_restart)
```

- [ ] **Step 4: (원자 컷오버 — 보류) 컴파일만 확인하고 Task 10으로**

Run: `uv run python -c "import hoga.live.lifecycle"`
Expected: no ImportError. watchdog 테스트(Step 1)는 Task 10에서 get_status 완성 + 레거시 필드 제거 후 함께 그린.

---

### Task 10: `get_status` 집계 + `degraded_accounts` 필드 (Q10·Q11)

스펙 §5.7. 존재 conn 기준 AND 집계. `capture_reason` 값 불변, 저하 계좌는 신규 `degraded_accounts` 필드(프론트 0줄).

**Files:**
- Modify: `hoga/live/lifecycle.py` (`LiveStatus` 모델 + `get_status` 완전 재작성)
- Modify: `tests/unit/live/test_lifecycle_dynamic_n.py` (집계 테스트 추가)

- [ ] **Step 1: Write the failing test** (append)

```python
@pytest.mark.asyncio
async def test_status_degraded_accounts_lists_unhealthy(tmp_path, monkeypatch):
    codes26 = [f"{i:06d}" for i in range(26)]
    await _start_two_accounts(tmp_path, monkeypatch, codes26)

    # conn-1의 ws를 not-connected로(가짜) → capture_health "reconnecting"
    class _DeadWs:
        connected = False
        sub_expected = 39
        sub_acked = 0
        sub_rejected = 0
        last_recv_ms = None
        last_tick_ms = None
    lifecycle._state.streams[1].stream_obj.ws = _DeadWs()        # type: ignore[union-attr]
    # conn-0는 connected
    class _LiveWs(_DeadWs):
        connected = True
        sub_acked = 39
    lifecycle._state.streams[0].stream_obj.ws = _LiveWs()        # type: ignore[union-attr]

    # 장중 + grace 경과 가정
    monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture", lambda _n: False)
    st = lifecycle.get_status()
    assert st.capture_healthy is False
    assert st.degraded_accounts == [1]
    assert ":" not in st.capture_reason       # Q10: 값 재포맷 금지(prefix 없음)
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_status_market_closed_is_not_per_account_degraded(tmp_path, monkeypatch):
    """야간/주말(market_closed)은 전역 상태 — 계좌별 degraded로 잡지 않는다
    (advisor 버그 회귀: _capture_health의 closed 단락이 모든 conn을 degraded로
    만들면 안 됨)."""
    codes26 = [f"{i:06d}" for i in range(26)]
    await _start_two_accounts(tmp_path, monkeypatch, codes26)
    monkeypatch.setattr(lifecycle, "_market_clock_closed_for_capture", lambda _n: True)
    st = lifecycle.get_status()
    assert st.capture_reason == "closed"
    assert st.degraded_accounts == []
    assert st.capture_healthy is False
    await lifecycle.stop_live_stream()


@pytest.mark.asyncio
async def test_status_idle_when_poller_only(tmp_path, monkeypatch):
    from hoga.live import session_gate
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda d: _FakeKis(0))
    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, [])
    await lifecycle.start_live_stream(data_dir=tmp_path)
    st = lifecycle.get_status()
    assert st.running is True              # poller alive
    assert st.capture_healthy is True
    assert st.capture_reason == "idle"
    assert st.degraded_accounts == []
    await lifecycle.stop_live_stream()
```

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/unit/live/test_lifecycle_dynamic_n.py -k status -q`
Expected: FAIL — `degraded_accounts` not on LiveStatus.

- [ ] **Step 3: Add field + rewrite get_status**

`hoga/live/lifecycle.py` — add to `LiveStatus` (after `live_set` field, 현재 130):

```python
    # Q10 (출시2) — 저하 계좌 id 목록(additive; capture_reason 값은 불변).
    # 프론트는 미소비(C3가 per-code 배지로 소비) — unknown 필드라 무시 안전.
    degraded_accounts: list[int] = Field(default_factory=list)
```

Replace `get_status` (현재 253-308) entirely:

```python
def get_status() -> LiveStatus:
    """Read the current live status. Always safe to call. dynamic-N 집계(스펙 §5.7)."""
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415

    streams = _state.streams
    poller = _state.rest_poller
    now_ms = _now_ms()
    started = _state.started_at_ms

    running = any(not c.ws_task.done() for c in streams.values()) or (
        poller is not None and poller.alive
    )
    ws_connected = bool(streams) and all(
        getattr(getattr(c.stream_obj, "ws", None), "connected", False)
        for c in streams.values()
    )
    last_tick_ms: int | None = None
    ticks = [
        t for c in streams.values()
        if (t := getattr(getattr(c.stream_obj, "ws", None), "last_tick_ms", None)) is not None
    ]
    if ticks:
        last_tick_ms = max(ticks)

    # 캡처 헬스 — 존재 conn 기준 AND(Q11). conn 0(C4 poller-only)이면 idle.
    if started is None or not streams:
        cap_healthy = bool(running)        # poller-only면 서비스 중 → healthy/idle
        cap_reason = "idle" if running else "offline"
        degraded: list[int] = []
    else:
        kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
        session_open_ms = int(
            kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
        )
        ref_ms = max(started, session_open_ms)
        # market_closed는 전역 상태(계좌별 결함 아님) → per-conn 루프 밖에서 단락.
        # ★ advisor 버그: _capture_health는 market_closed면 소켓을 보기 전에
        # (False,"closed")를 반환 → 루프 안에서 쓰면 밤/주말마다 모든 conn이
        # degraded로 잡혀 degraded_accounts=[0,1] 거짓 신호(Q10 목적과 정반대).
        if _market_clock_closed_for_capture(now_ms):
            cap_healthy, cap_reason, degraded = False, "closed", []
        else:
            cap_healthy, cap_reason, degraded = True, "healthy", []
            for account_id, conn in streams.items():
                ws = getattr(conn.stream_obj, "ws", None)
                healthy, reason = _capture_health(
                    running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
                    stale_after_ms=_WATCHDOG_STALE_AFTER_MS, market_closed=False,
                )
                if not healthy:
                    cap_healthy = False
                    cap_reason = reason     # worst(마지막 비정상). 값 불변(Q10).
                    degraded.append(account_id)
            degraded.sort()

    return LiveStatus(
        running=running,
        started_at_ms=started,
        last_tick_ms=last_tick_ms,
        cycle_lag_ms=0,
        watchlist_count=len(_state.watchlist_codes),
        kis_calls_today=0,
        kis_rate_limit_remaining=None,
        today_promote_last_ms=get_today_promote_last_ms(),
        transport="ws",
        ws_connected=ws_connected,
        live_set=list(_state.live_set),
        degraded_accounts=degraded,
        capture_healthy=cap_healthy,
        capture_reason=cap_reason,
    )
```

- [ ] **Step 4: 레거시 `_State` 필드 제거 (컷오버 마무리)**

이제 start/refresh/watchdog/get_status가 모두 `_state.streams`를 쓰므로 Task 5에서 임시로 남긴 레거시 단일 필드를 제거한다. `_State`에서 다음 주석+세 줄을 삭제:

```python
    # ── 레거시 단일 경로(Task 10에서 제거) — 컷오버 적용 전까지 컴파일 호환 ──
    stream_task: "asyncio.Task | None" = None      # type: ignore[type-arg]
    stream_obj: object | None = None
    ws_task: "asyncio.Task | None" = None          # type: ignore[type-arg]
```

`reset_for_tests`(현재 311-321)가 레거시 task를 cancel하던 루프도 streams 기준으로:

```python
def reset_for_tests() -> None:
    """Test-only hook. Resets module state without raising."""
    global _state, _buffer  # noqa: PLW0603
    for conn in list(_state.streams.values()):
        for task in (conn.ws_task, conn.flush_task):
            if task is not None and not task.done():
                task.cancel()
    _state = _State()
    _buffer = LiveBuffer()
    kis_runtime.reset_for_tests()
    _today_promote_last_ms.clear()
```

Run: `grep -nE "_state\.(stream_obj|stream_task|ws_task)\b" hoga/live/lifecycle.py`
Expected: no hits (모두 `_state.streams[...]`로 전환).

- [ ] **Step 5: Run Phase C tests (그린 게이트 — Tasks 7-10 합산)**

Run: `uv run pytest tests/unit/live/test_partition.py tests/unit/live/test_lifecycle_start.py tests/unit/live/test_lifecycle_dynamic_n.py -q`
Expected: PASS — partition / start(C4 poller-only) / build·teardown / refresh create·teardown / watchdog 격리복구 / get_status 집계+degraded_accounts.

- [ ] **Step 6: Run the whole live suite (full regression)**

Run: `uv run pytest tests/unit/live -q`
Expected: PASS. test_lifecycle.py의 기존 refresh/status 테스트가 새 구조와 충돌하면 같이 수정 — 대개 `_state.stream_obj` 직접 참조를 `_state.streams[0].stream_obj`로, 또는 단일-스트림 가정을 dynamic-N으로. (충돌 수정도 본 커밋에 포함.)

- [ ] **Step 7: Commit (Phase C 원자 컷오버 — 한 커밋)**

Tasks 7-10의 모든 소스·테스트 변경이 이 커밋에 담긴다.

```bash
git add hoga/live/lifecycle.py tests/unit/live/test_lifecycle_start.py tests/unit/live/test_lifecycle_dynamic_n.py tests/unit/live/test_lifecycle.py
git commit -m "feat(live): lifecycle dynamic-N 컷오버 — start/refresh/watchdog/get_status N-스트림 + C4 (부품2/C4, 스펙 §5)

start dynamic-N + poller 분리(§5.4) / refresh create-teardown(§5.5) /
watchdog _restart_conn 격리복구(§5.6) / get_status 집계 + degraded_accounts(§5.7)
+ C4 빈 watchlist poller-only. 레거시 단일-스트림 _State 필드 제거.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase D — 통합 검증

### Task 11: rest_poller 분리 회귀 + C4 보는종목 + 2계좌 lifespan

스펙 §3(잠복 버그)·C4·§9. watchdog/refresh 재시작이 보는종목 `_subscribed`를 보존하는지, 빈 watchlist에서 보는종목이 표시되는지, 2계좌 lifespan이 정상 기동/정지하는지.

**Files:**
- Modify: `tests/unit/live/test_lifecycle_rest_poller.py` (구독 보존 회귀 추가)
- Modify: `tests/unit/live/test_lifecycle_dynamic_n.py` (lifespan 2계좌)

- [ ] **Step 1: Write the regression test** — poller subscription survives a restart

```python
# tests/unit/live/test_lifecycle_rest_poller.py 에 추가
@pytest.mark.asyncio
async def test_view_subscription_survives_stream_restart(tmp_path, monkeypatch):
    """잠복 버그 회귀(§3): conn 재시작이 보는종목 구독을 날리면 안 된다."""
    import hoga.live.kis_runtime as kis_runtime
    import hoga.live.lifecycle as lifecycle
    from hoga.live import session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    class _FakeKis:
        _creds = type("C", (), {"app_key": "k0"})()
        async def get_approval_key(self): return "A"
        async def aclose(self): pass
        async def fetch_orderbook(self, code): raise RuntimeError("offline")
        async def fetch_trades(self, code): return []
        async def fetch_brokers(self, code): raise RuntimeError("offline")
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda d: _FakeKis())
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_for_account", lambda a, d: _FakeKis())

    from tests.unit.live.test_lifecycle_start import _write_watchlist
    from hoga.api import symbols
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    _write_watchlist(tmp_path, ["005930"])
    await lifecycle.start_live_stream(data_dir=tmp_path)

    # 보는종목(관심 밖) 구독
    lifecycle.on_view_subscribe("999999")
    assert "999999" in lifecycle._state.rest_poller._subscribed

    # 전체 재시작(start 재호출 = watchdog 전체 재시작 경로와 동일 poller 보존)
    await lifecycle.start_live_stream(data_dir=tmp_path)
    # ★ poller가 재생성되지 않아 구독 보존
    assert lifecycle._state.rest_poller is not None
    assert "999999" in lifecycle._state.rest_poller._subscribed
    await lifecycle.stop_live_stream()
```

- [ ] **Step 2: Write the C4 view test** (append to same file)

```python
@pytest.mark.asyncio
async def test_empty_watchlist_view_subscribe_polls(tmp_path, monkeypatch):
    """C4: 빈 watchlist여도 보는종목 on_view_subscribe가 폴링 대상에 들어간다."""
    import hoga.live.kis_runtime as kis_runtime
    import hoga.live.lifecycle as lifecycle
    from hoga.live import session_gate

    lifecycle.reset_for_tests()
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    class _FakeKis:
        _creds = type("C", (), {"app_key": "k0"})()
        async def get_approval_key(self): return "A"
        async def aclose(self): pass
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda d: _FakeKis())

    from tests.unit.live.test_lifecycle_start import _write_watchlist
    _write_watchlist(tmp_path, [])
    assert await lifecycle.start_live_stream(data_dir=tmp_path) is True
    assert lifecycle._state.streams == {}            # WS 0
    lifecycle.on_view_subscribe("005930")
    assert "005930" in lifecycle._state.rest_poller._subscribed   # 폴링 대상
    await lifecycle.stop_live_stream()
```

- [ ] **Step 3: Run to verify (these should PASS already if Task 7 is correct)**

Run: `uv run pytest tests/unit/live/test_lifecycle_rest_poller.py -q`
Expected: PASS — Task 7의 poller 분리(`_ensure_poller` 재사용)가 이 두 회귀를 만족시킨다. FAIL이면 `_start_live_stream_locked`가 poller를 재생성하는지 점검(반드시 `_ensure_poller`로 재사용).

- [ ] **Step 4: Full suite + lint**

Run: `uv run pytest tests/unit/live -q`
Expected: PASS (whole live suite).

Run: `uv run ruff check hoga/live/kis_runtime.py hoga/live/lifecycle.py`
Expected: clean (or auto-fixable — run `uv run ruff check --fix` then re-run pytest).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/live/test_lifecycle_rest_poller.py tests/unit/live/test_lifecycle_dynamic_n.py
git commit -m "test(live): poller 구독 보존 회귀 + C4 보는종목 폴링 (부품2/C4, 스펙 §3·C4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 통합 후 수동 검증 (enable 전)

1. **1계좌 회귀(KIS_APP_KEY_2 미설정)**: 서버 기동 → `/api/live/status` `live_set` ≤13, `running` True. 출시1과 바이트 동일 체감.
2. **2계좌 enable**: `.env`에 이미 `KIS_APP_KEY_2`/`KIS_APP_SECRET_2` 있음(§0). 서버 재시작 → `live_set` ≤26, `degraded_accounts` []。
3. **장중 스모크 재확인**: `uv run python scripts/smoke_2account_ws.py` (장중엔 ticks>0).
4. **빈 watchlist 보는종목**: watchlist 비운 채 검색종목 열기 → 호가 표시(빈 화면 아님).

## 문서 갱신 (구현 완료 후, 별도 커밋)

ADR-0067이 지시한 CONTEXT.md 갱신을 enable 후 반영:
- **Live Set**(CONTEXT.md:337-338, 423): "top-13" → "≤26 (13 × n_configured), 2계좌 WS, dynamic-N".
- **KisClient**(CONTEXT.md:379): "프로세스 단일 싱글턴" → "account별 싱글턴 dict (한 앱키=한 버킷은 account별 보존; account k>0=WS approval 전용)".
- 신설 용어 후보: **Viewed-Code Poll**(이미 ADR-0067 예고), **degraded_accounts**(LiveStatus 필드).
- ADR-0067 Status를 "accepted → 구현 완료(출시2)"로, 위험 #1/#3 해소 반영.

---

## Self-Review (작성자 체크)

- **Spec coverage**: 부품1(T1-3)·부품2(T4-10)·C4(T7,T11)·R1(T6)·R2(T6)·Q4(T4)·Q5(T5 n_configured 캐시)·Q6(T9)·Q10/Q11(T10)·exclude-then-subscribe(T8)·dict 원자순회(T9)·잠복버그(T11) — 전 스펙 항목 태스크 매핑됨.
- **Placeholder scan**: "적절히 처리"류 없음 — 모든 스텝에 실제 코드/명령/기대출력.
- **Type consistency**: `_StreamConn(account_id, stream_obj, ws_task, flush_task, codes)` 전 태스크 동일. `_build_conn(account_id, codes, data_dir)`·`_teardown_conn(conn)`·`_restart_conn(account_id, *, data_dir)`·`ensure_kis_client_for_account(account_id, data_dir)`·`configured_account_ids(data_dir)`·`partition_live_set(codes, n)`·`_compute_live_set(data_dir, n_configured=1)` 시그니처 T4-T10 일관. `degraded_accounts: list[int]` 모델·get_status·테스트 일치.
- **알려진 종속(★ 원자 컷오버)**: Phase C의 Task 7-10은 `_state.streams` dict로 동시 전환하는 **한 커밋**이다(start만 바꾸면 get_status/watchdog/refresh가 레거시 필드를 읽어 깨짐). 중간 태스크는 컴파일만 확인, 그린 게이트·커밋은 Task 10. subagent-driven 실행 시 **Task 7-10을 한 subagent/한 리뷰 묶음**으로 디스패치(Phase A·B·D는 개별 태스크 커밋).
