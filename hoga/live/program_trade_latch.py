"""키움 0w 틱 → 프로그램 사이드카 사이의 최신값 latch (PR-F4).

0w push 는 종목당 분당 ~8건(F3 실측)인데 사이드카는 per-code-per-day JSON 원자
쓰기라, 틱마다 merge_response 를 부르면 REST 30초 대비 IO 가 수십 배로 뛴다.
그래서 틱은 여기 메모리 latch 에 **최신값만** 남기고, 기존 ProgramTradeCollector
루프가 30초 주기로 drain 해 병합한다 — 저장 해상도(30초)·IO 패턴·이상탐지·소비
경로가 REST 시절과 동일하게 유지된다.

프로그램 수급은 누적 스냅샷이라 최신값만 남기는 게 손실이 아니다(중간 틱은
다음 스냅샷에 포함된 정보). 단일 워커(ADR-0038) + asyncio 단일 루프라 락 불요.
"""
from __future__ import annotations

from typing import Any

# code → 마지막 0w payload (kiwoom_frames._parse_program 이 만든 dict).
_latest: dict[str, dict[str, Any]] = {}


def update(code: str, payload: dict[str, Any]) -> None:
    """stream.on_tick 이 PROGRAM 틱마다 호출 — 최신값 교체(last-wins)."""
    _latest[code] = payload


def drain() -> dict[str, dict[str, Any]]:
    """collector 가 주기마다 호출 — 쌓인 최신값을 비우며 반환.

    비우는 이유: 장외·정지 구간에 같은 스냅샷을 매 주기 재병합하지 않기 위해서다
    (store 병합은 멱등이지만 불필요한 디스크 쓰기·mtime churn 을 만든다).
    """
    global _latest  # noqa: PLW0603
    out = _latest
    _latest = {}
    return out


def reset_for_tests() -> None:
    _latest.clear()
