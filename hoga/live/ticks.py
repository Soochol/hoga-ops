"""Live Tick 도메인 모델 — 브로커 중립 포트 계약 타입.

`WsTick`은 WS 1메시지에서 나온 1개 도메인 이벤트다(CONTEXT.md 'Live Tick').
KIS·키움 파서(ws_frames·kiwoom_frames)와 REST 합성(broker_rest_poller)이 모두
같은 shape로 생성하고, stream·downsampler가 소비한다. 파서 모듈(ws_frames)의
KIS 전용 로직과 수명을 분리해, PR-G에서 KIS WS 계층을 삭제해도 이 모델은 잔존한다
(ADR-0118 브로커 완전 특화).

I/O 없음 — fixture로 완전 테스트 가능.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .snapshot import SnapshotKind


@dataclass(frozen=True)
class WsTick:
    """Live Tick — WS 1메시지에서 나온 1개 도메인 이벤트 (CONTEXT.md 'Live Tick').

    venue: 이 틱을 실어온 TR의 시장(KRX/NXT). #524 통합 venue 시분할에서 stream이
    저장(KRX만)·표시 분기에 쓴다. 기본 "KRX"라 기존 생성부·구경로는 무변경으로
    KRX 의미를 유지(하위호환).
    """

    code: str
    t_ms: int
    kind: SnapshotKind
    payload: dict[str, Any]
    venue: str = "KRX"
