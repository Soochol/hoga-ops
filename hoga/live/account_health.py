"""Account health — "account N을 background REST에 쓸 수 있나"의 단일 권위 (leaf 모듈).

계정 분리(2026-06-10)로 background REST가 account 1을 쓰면서, 그 account를 background로
보내도 되는지를 두 **직교 신호**로 판단한다:
  (1) REST bearer 토큰 발급 실패 latch (FM5 — kis_runtime의 토큰 provider 콜백이 설정),
  (2) WS 연결 저하 (lifecycle가 probe로 push 등록 — _capture_health 기반).
이 모듈이 둘을 한 인터페이스 뒤에 통합해 kis_access(라우팅)와 lifecycle(상태)이 같은 답을
보게 한다.

**leaf**: live 모듈을 import하지 않는다 — 이전엔 kis_runtime이 lifecycle을 *late import*해
degraded를 pull했다(순환 회피 hack). 의존을 역전한다: lifecycle가 WS probe를 **push**하고,
소비자(kis_access·kis_runtime 토큰 콜백)는 이 leaf를 import한다. 순환 0.
"""
from __future__ import annotations

import logging
from collections.abc import Callable

log = logging.getLogger(__name__)

# FM5: REST bearer 토큰 발급이 실패한 account_id 집합 (kis_runtime 토큰 provider 콜백이 설정).
# 프로세스 latch — 재시작 전 영구(의도적 safe over-degradation; 토큰 ~24h 캐시라 발급 실패 드묾).
_rest_auth_degraded: set[int] = set()

# lifecycle가 시작 시 등록하는 WS-health probe — 현재 WS-저하 account_id 집합을 반환.
# 미등록(부팅 극초기·일부 테스트)이면 빈 집합으로 간주(보수적 — 라우팅을 막지 않는다).
_ws_probe: Callable[[], set[int]] | None = None


def register_ws_probe(probe: Callable[[], set[int]]) -> None:
    """lifecycle가 WS-degraded 집합 probe를 push 등록(의존 역전 — leaf가 lifecycle을
    import하지 않게). probe는 호출 시점에 현재 WS-저하 account 집합을 반환해야 한다."""
    global _ws_probe  # noqa: PLW0603
    _ws_probe = probe


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


def _ws_degraded() -> set[int]:
    """등록된 probe의 WS-저하 집합(미등록/probe 실패 시 빈 집합 — 보수적)."""
    if _ws_probe is None:
        return set()
    try:
        return _ws_probe()
    except Exception:  # noqa: BLE001 — probe 실패가 라우팅을 막지 않는다
        return set()


def degraded_account_ids() -> set[int]:
    """background로 보내면 안 되는 account_id 통합 집합 — REST 토큰 latch ∪ WS 저하."""
    return _rest_auth_degraded | _ws_degraded()


def is_degraded(account_id: int) -> bool:
    """account_id가 background REST에 부적합한가 — REST latch(즉시) 또는 WS 저하(probe)."""
    return account_id in _rest_auth_degraded or account_id in _ws_degraded()


def reset_for_tests() -> None:
    """테스트 격리 — REST latch만 초기화한다. WS probe는 lifecycle가 모듈 로드 시 1회
    등록한 stateless 함수(_state를 시점-평가)라, reset가 _state를 비우면 자연히 빈 집합을
    반환한다 → probe를 해제하면 오히려 production 등록이 사라져 재등록이 안 된다. 테스트가
    WS-저하를 위조할 땐 monkeypatch(_ws_probe/is_degraded, auto-revert)를 쓴다."""
    _rest_auth_degraded.clear()
