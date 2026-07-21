"""키움 `1h` VI발동/해제 관측 캡처 — legend 미해독 FID 의 실이벤트 채록.

목적: 9068 발동구분·9069 발동방향·9075 장전구분의 **코드값 legend 가 어떤 공식
문서에도 없다**(kiwoom-ws-fid-catalog 실측 조사). 실장 VI 이벤트의 raw 프레임을
그대로 저장해 두면, 발동 시점의 가격 방향(0B 체결·차트)과 대조해 legend 를 확정할
수 있다 — 그 확정이 끝나야 10호가 요약 패널의 상승VI/하강VI 행을 채운다.

저장: `data/research/kiwoom_vi_events/YYYYMMDD.jsonl` (KST 날짜별) — 1행 = REAL
data[] 의 `1h` row 원본 + 수신 시각. 파싱·해석 없이 raw 를 남긴다: 지금 의미를
확정 못 한 필드를 골라 저장하면 legend 해독에 쓸 근거 자체가 사라진다.

VI 는 전 시장 하루 수십~수백 건 규모라 이벤트당 append-close 로 충분하다.
관측 훅은 본 캡처 파이프라인의 보조라 **어떤 실패도 밖으로 던지지 않는다**.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import kiwoom_fields as K

_log = logging.getLogger(__name__)

_KST = timezone(timedelta(hours=9))


class KiwoomViCapture:
    """`1h` raw row → 날짜별 JSONL append. record()는 예외를 삼킨다(관측 전용).

    경로 연산까지 record() 의 try 안에서 한다 — 생성은 완전히 inert 해서
    세션 매니저 테스트가 data_dir 에 무엇을 넣든 관측이 발목 잡지 않는다.
    """

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir

    def record(self, row: dict, now_ms: int) -> None:
        try:
            out_dir = self._data_dir / "research" / "kiwoom_vi_events"
            day = datetime.fromtimestamp(now_ms / 1000, tz=_KST).strftime("%Y%m%d")
            out_dir.mkdir(parents=True, exist_ok=True)
            line = json.dumps(
                {"recv_ms": now_ms, "item": row.get("item"), "values": row.get("values")},
                ensure_ascii=False,
            )
            with (out_dir / f"{day}.jsonl").open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:  # noqa: BLE001 — 관측 실패가 recv 루프를 해치면 안 된다
            _log.warning("live.kiwoom.vi_capture_write_failed", exc_info=True)
            return
        values = row.get("values")
        v = values if isinstance(values, dict) else {}
        # legend 해독 대상 필드를 로그에도 표면화 — 발동 직후 grep 만으로 1차 대조 가능.
        _log.info(
            "live.kiwoom.vi_event code=%s price=%s kind=%s dir_9069=%s raw_9068=%s raw_9075=%s",
            v.get(K.VI_CODE), v.get(K.VI_TRIGGER_PRICE), v.get(K.VI_KIND),
            v.get(K.VI_TRIGGER_DIR), v.get("9068"), v.get("9075"),
        )
