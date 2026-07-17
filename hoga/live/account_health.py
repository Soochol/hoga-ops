"""Account health — "account N을 background REST에 쓸 수 있나"의 단일 권위 (leaf 모듈).

계정 분리(2026-06-10)로 background REST가 account 1을 쓰면서, 그 account를 background로
보내도 되는지를 REST bearer 토큰 발급 실패 latch(FM5 — kis_runtime의 토큰 provider 콜백이
설정)로 판단한다. KIS WS 연결 저하 신호는 ADR-0118 PR-G에서 KIS WebSocket 계층과 함께
삭제됐다(실시간 수집=키움 전담).

**leaf**: live 모듈을 import하지 않는다 — kis_access(라우팅)·kis_runtime 토큰 콜백이 이
leaf를 import한다. 순환 0.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

# FM5: REST bearer 토큰 발급이 실패한 account_id 집합 (kis_runtime 토큰 provider 콜백이 설정).
# 프로세스 latch — 재시작 전 영구(의도적 safe over-degradation; 토큰 ~24h 캐시라 발급 실패 드묾).
_rest_auth_degraded: set[int] = set()


def mark_rest_auth_degraded(account_id: int) -> None:
    """account의 REST 토큰 발급 실패를 latch(FM5). account 0은 폴백 대상 자체라 제외
    (마킹해도 폴백할 곳 없음). 전환(미latch→latch) 시 **1회만** WARNING — 이게 없으면
    오설정 KIS_APP_KEY_N이 잠깐 깜빡인 뒤 시스템이 영구히 account 0(15/s)로 조용히
    강등되며 30/s로 착각한다(silent capacity degradation, ADR-0064가 막으려던 것)."""
    if account_id != 0 and account_id not in _rest_auth_degraded:
        _rest_auth_degraded.add(account_id)
        log.warning(
            "KIS account %d REST token issuance failed — REST-degraded; background now "
            "routes to account 0 until restart (check KIS_APP_KEY_%d/KIS_APP_SECRET_%d)",
            account_id, account_id + 1, account_id + 1,  # env 접미 = account_id+1
        )


def degraded_account_ids() -> set[int]:
    """background로 보내면 안 되는 account_id 집합 — REST 토큰 latch."""
    return set(_rest_auth_degraded)


def is_degraded(account_id: int) -> bool:
    """account_id가 background REST에 부적합한가 — REST 토큰 latch."""
    return account_id in _rest_auth_degraded


def is_rest_degraded(account_id: int) -> bool:
    """REST 토큰 발급 실패만 본다 — background REST 라우팅 전용(is_degraded와 동치)."""
    return account_id in _rest_auth_degraded


def reset_for_tests() -> None:
    """테스트 격리 — REST latch 초기화."""
    _rest_auth_degraded.clear()
