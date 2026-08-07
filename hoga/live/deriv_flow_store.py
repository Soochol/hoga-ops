"""파생 투자자 순매수 장중 표본 스토어 (KIS `FHPTJ04030000` 적재).

`investor_flow_store`(키움 ka10051 · 주식)와 **같은 계약을 따르되 별도 파일이다.**
합치지 않은 이유 셋:

1. **확정본이 없다.** 주식은 마감 뒤 `base_dt` 랜덤 액세스로 그날을 확정할 수 있지만
   (`FHPTJ04040000`), 그 일별 TR 의 시장구분에는 **파생이 없다**(KSP/KSQ 뿐, 2026-08-07
   조사). 파생은 소급 백필 경로가 아예 없어서 "잠정/확정" 이라는 축 자체가 성립하지
   않는다 — 세션 마지막 표본이 곧 그날의 최종 누적이다.
2. **키잉 축이 다르다.** 주식은 `mrkt_tp`, 파생은 `fid_input_iscd_2`(상품).
3. 기존 스토어의 docstring 계약이 ka10051 전용으로 촘촘히 쓰여 있어(단위 코드표,
   `amt_qty_tp` 함정) 일반화하면 그 문서가 거짓이 된다.

**그 밖의 계약은 그대로 물려받는다** — 그것들은 벤더가 아니라 "장중 표본" 이라는 성질에서
나온 규칙이라 파생에도 똑같이 걸린다:

- **한 줄 = 벤더 응답 하나.** 상품 7개 중 콜옵션만 실패하면 그 표본엔 6줄만 붙고,
  커버리지가 그 비대칭을 그대로 드러낸다. 그래서 추가 전용(JSONL)이다.
- **누적값을 그대로 적재하고 델타는 읽을 때 계산한다.** 표본 결손이 해상도 손실이지
  정합성 손상이 아니게 된다 — 다음 표본이 전체 누적을 다시 들고 온다.
- **행을 파싱하지 않고 원본을 보관한다.** 이 도메인에선 이게 특히 중요하다: 응답
  단위가 문서로 확정되지 않아 해석이 바뀔 수 있는데(`deriv_flow_units`), 원본이 남아
  있으면 다시 읽을 수 있지만 파싱해서 버리면 소급 복구가 불가능하다.
- **경로에 벤더명을 넣지 않는다.** 벤더는 본문 `source` 에 적어 옮길 수 있게 둔다.
- **줄마다 `request` 를 통째로 남긴다.** 나중에 해석이 갈려도 그 줄이 무엇을 요청해
  받은 값인지 증빙이 된다.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from hoga.live.session_gate import DERIV_CLOSE_MIN, DERIV_OPEN_MIN

log = logging.getLogger(__name__)

INTRADAY_SCHEMA_VERSION = 1

SOURCE = "kis:FHPTJ04030000"

#: 파생 정규장 09:00–15:45 = 405분. 커버리지 분모의 근거다.
#: **게이트에서 파생시킨다** — 숫자를 여기 다시 적으면 창을 조정할 때 분모만 옛 값으로
#: 남아 커버리지가 조용히 틀린다(`session_gate` 가 SSOT).
SESSION_MINUTES = DERIV_CLOSE_MIN - DERIV_OPEN_MIN

#: 폴 주기의 몇 배까지 벌어져야 "수집 공백" 으로 볼 것인가 — `investor_flow_store` 와
#: 같은 문법(절대 시간이 아니라 주기 상대 임계라 주기를 바꿔도 판정이 따라온다).
GAP_MIN_JUMP_INTERVALS = 3


class DerivSample(BaseModel):
    """벤더 응답 하나. `row` 는 `FHPTJ04030000` 의 `output` 원본 행을 그대로 담는다.

    주식 스토어가 `rows`(업종 배열)인 것과 달리 **단수**다 — 이 TR 은 요청 하나가
    시장 하나를 답하므로 상품별로 줄이 하나씩 생긴다.
    """

    sampled_at_ms: int
    source: str = SOURCE
    #: 상품 키 = `fid_input_iscd_2`. 줄을 상품으로 가르는 축이라 `request` 안에만
    #: 두지 않고 최상위로 올린다(읽기 경로가 매 줄 dict 를 파고들지 않게).
    product: str
    request: dict[str, str]
    row: dict[str, Any]


class DerivFlowStore:
    """`<data_dir>/deriv-flow/intraday/<날짜>.jsonl` 을 관리한다."""

    def __init__(self, data_dir: Path) -> None:
        self._root = Path(data_dir) / "deriv-flow"

    def intraday_path(self, date: str) -> Path:
        return self._root / "intraday" / f"{date}.jsonl"

    def append_sample(self, date: str, sample: DerivSample) -> None:
        """표본 한 줄을 덧붙인다. 원자적 교체가 아니라 **append** — 누적 로그이고
        기존 줄을 절대 건드리지 않는다(교체하면 매번 하루치를 재직렬화한다)."""
        path = self.intraday_path(date)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(sample.model_dump(), ensure_ascii=False, separators=(",", ":"))
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")

    def load_samples(self, date: str) -> list[DerivSample]:
        """그날 표본 전부. **개행으로 끝나지 않은 마지막 줄은 버린다** — append 중
        크래시하면 반쪽 줄이 남는데, 그것을 파싱하려 들면 하루치가 통째로 죽는다.

        **파일 부재는 정상 상태다**(writer 계약, #1176) — 장 시작 전이거나 그날
        수집이 아직 아무것도 못 쓴 것이고, 리더가 빈 목록으로 막는다.
        """
        path = self.intraday_path(date)
        if not path.exists():
            return []
        raw = path.read_text(encoding="utf-8")
        lines = raw.split("\n")
        if raw and not raw.endswith("\n"):
            lines = lines[:-1]  # 미완 꼬리 폐기
        out: list[DerivSample] = []
        for ln in lines:
            if not ln.strip():
                continue
            try:
                out.append(DerivSample.model_validate_json(ln))
            except ValidationError:
                # 한 줄이 깨져도 나머지는 유효하다 — 로그만 남기고 계속.
                log.warning("deriv-flow: 손상된 표본 줄 무시 date=%s", date)
        return out

    def last_sample(self, date: str, product: str) -> DerivSample | None:
        """같은 상품의 직전 표본. 중복 쓰기 회피의 비교 대상이다."""
        for s in reversed(self.load_samples(date)):
            if s.product == product:
                return s
        return None


def rows_equal(prev: DerivSample | None, row: dict[str, Any]) -> bool:
    """직전 표본과 값이 같은가 — 같으면 쓰지 않는다.

    주식 수집기(#1099)와 같은 이유다: 벤더 갱신 주기보다 촘촘히 폴링해 **놓침을
    줄이면서** 저장량은 실제 변화 횟수로 묶는다.
    """
    if prev is None:
        return False
    return prev.row == row


def expected_sample_count(*, poll_interval_ms: int) -> int | None:
    """세션 전체를 다 찍었다면 상품당 몇 줄이어야 하는가 — 커버리지 분모."""
    if poll_interval_ms <= 0:
        return None
    return (SESSION_MINUTES * 60_000) // poll_interval_ms
