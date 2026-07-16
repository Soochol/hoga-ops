"""키움 프로세스-리소스 싱글톤 (토큰 provider) + env 계정 발견.

KIS(kis_runtime) 브로커-대칭. env 관례를 복제한다: account 0 = KIWOOM_APP_KEY/SECRET
(접미 없음), k>0 = 접미 (k+1) → account_id=1 ↔ KIWOOM_APP_KEY_2. 계정마다 토큰
provider 싱글톤 1개(디스크 캐시는 kiwoom-token[-k].json). kis_* 는 import하지 않는다
(ADR-0116 규율 1).

REST 데이터 클라이언트(분봉 백필 ka10080)는 PR-5에서 추가한다 — 이 모듈은 인증·env만.
"""
from __future__ import annotations

import contextlib
import os
import threading
from pathlib import Path

from .kiwoom_token_provider import KiwoomCredentials, KiwoomTokenProvider

_token_providers: dict[int, KiwoomTokenProvider] = {}
_lock = threading.Lock()


def _account_env(account_id: int) -> tuple[str, str]:
    """account_id(0-based) → (KEY 환경변수명, SECRET 환경변수명).

    0 = KIWOOM_APP_KEY/SECRET. k>0 = 접미 (k+1) ('사람이 세는 번호') →
    account_id=1 ↔ KIWOOM_APP_KEY_2 (2번째 키). KIS_APP_KEY 관례 복제.
    """
    if account_id == 0:
        return "KIWOOM_APP_KEY", "KIWOOM_APP_SECRET"
    suffix = account_id + 1
    return f"KIWOOM_APP_KEY_{suffix}", f"KIWOOM_APP_SECRET_{suffix}"


def _token_cache_path(data_dir: Path, account_id: int) -> Path:
    name = "kiwoom-token.json" if account_id == 0 else f"kiwoom-token-{account_id}.json"
    return data_dir / ".local" / name


def _resolve_env_creds(account_id: int) -> KiwoomCredentials | None:
    """env → KiwoomCredentials, 키/시크릿 부재 시 None (boot 시맨틱, reload 없음)."""
    key_name, sec_name = _account_env(account_id)
    app_key = os.environ.get(key_name)
    app_secret = os.environ.get(sec_name)
    if not app_key or not app_secret:
        return None
    return KiwoomCredentials(app_key=app_key, app_secret=app_secret)


def configured_account_ids(data_dir: Path) -> list[int]:
    """env 키+시크릿이 있는 account_id 연속 목록(0부터, 첫 공백에서 정지 — skip 없음).

    [] = 키움 미설정(오프라인). [0,1,2,3] = 4앱키(=호가+체결 800종목, 실측 2026-07-16).
    data_dir는 KIS와 시그니처 대칭용(현재 미사용 — env만 본다).
    """
    ids: list[int] = []
    account_id = 0
    while _resolve_env_creds(account_id) is not None:
        ids.append(account_id)
        account_id += 1
    return ids


def ensure_token_provider(
    token_cache_path: Path, creds: KiwoomCredentials, account_id: int = 0
) -> KiwoomTokenProvider:
    """계정별 KiwoomTokenProvider 싱글톤 — 한 번만 생성. check-then-create는 _lock 원자."""
    with _lock:
        prov = _token_providers.get(account_id)
        if prov is None:
            prov = KiwoomTokenProvider(creds, token_cache_path)
            _token_providers[account_id] = prov
        return prov


def ensure_token_provider_for_account(
    account_id: int, data_dir: Path
) -> KiwoomTokenProvider | None:
    """계정 creds를 env에서 풀어 토큰 provider 싱글톤 반환, 부재 시 None."""
    creds = _resolve_env_creds(account_id)
    if creds is None:
        return None
    return ensure_token_provider(
        _token_cache_path(data_dir, account_id), creds, account_id
    )


def close_all() -> None:
    """모든 계정 토큰 provider 종료 — 프로세스 종료 시에만."""
    for prov in list(_token_providers.values()):
        with contextlib.suppress(Exception):
            prov.close()
    _token_providers.clear()


def reset_for_tests() -> None:
    """테스트 격리 — 싱글톤 드롭(best-effort close)."""
    close_all()
