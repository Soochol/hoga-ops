"""deriv-flow 수집기의 런타임 배선 (자격증명 결선).

수집기 본체(`deriv_flow_collector`)는 순수하게 주입만 받는다 — 실제 KIS 클라이언트를
붙이는 **지저분한 자리**를 여기 한 곳에 모아, 테스트가 본체를 자격증명 없이 돌릴 수
있게 한다. `investor_flow_runtime`(키움)과 같은 형이되 **공통 베이스는 두지 않는다**
(ADR-0116: 브로커 대칭은 관측성 shape 을 맞추는 규약이지 추상화가 아니다).

**무자격이면 조용히 휴면한다**(ADR-0134). dev·워크트리는 키를 비워 두는 것이 기본이라
`ensure_kis_client_from_env` 가 None 을 돌려주는 것이 정상 경로다 — 크래시가 아니라
미기동이 옳고, 그래서 스케줄러도 이 경우 태스크를 아예 만들지 않는다(만들면 health 에
영원히 "도는 중인데 아무것도 안 하는" 거짓 행이 남는다).

**이 수집기는 KIS 키가 없으면 전부 빈다** — 옵션 심리 패널과 같은 처지다. 파생은
ADR-0136 이 KIS 담당으로 못 박았고 키움 REST 337개 TR 에 파생 투자자 TR 이 0건이라
대체 벤더가 없다. 그리고 이 TR 은 **모의투자 미지원**이라 실계좌 앱키에서만 돈다.
"""
from __future__ import annotations

import logging
from pathlib import Path

from hoga.live.deriv_flow_collector import DerivFlowCollector, make_kis_fetch

log = logging.getLogger(__name__)


def is_available(data_dir: Path) -> bool:
    """KIS 자격증명이 있어 수집이 가능한가. 스케줄러가 태스크 생성 여부를 결정한다."""
    from hoga.live import kis_runtime  # noqa: PLC0415 — 지연 import(heavy·시임)

    return bool(kis_runtime.configured_account_ids(data_dir))


def make_collector(data_dir: Path) -> DerivFlowCollector | None:
    """실 클라이언트에 결선된 수집기. 무자격이면 None."""
    from hoga.collector.orchestrator import now_kst  # noqa: PLC0415
    from hoga.live import kis_runtime  # noqa: PLC0415

    client = kis_runtime.ensure_kis_client_from_env(data_dir)
    if client is None:
        log.info("deriv_flow: KIS 자격증명 없음 — 수집기 미기동(정상, ADR-0134)")
        return None
    return DerivFlowCollector(
        data_dir=data_dir,
        date_fn=lambda: now_kst().strftime("%Y%m%d"),
        now_ms_fn=lambda: int(now_kst().timestamp() * 1000),
        fetch_fn=make_kis_fetch(client),
    )
