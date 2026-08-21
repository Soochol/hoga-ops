"""시장·업종 투자자 순매수 장중 표본 스토어 (ka10051 적재).

지도 #1094 의 결정 셋을 그대로 옮긴 것이다 — 설계 근거는 티켓에 있고 여기엔
**그 결정이 코드에 거는 제약**만 적는다.

**한 줄 = 벤더 응답 하나** (#1115). 파일은 *벤더가 말한 것의 로그*이고 나머지는 전부
파생이다. 코스닥 콜만 실패하면 그 표본엔 줄이 하나만 붙고, 커버리지가 그 비대칭을
그대로 드러낸다. 그래서 추가 전용(JSONL)이다 — 폴링은 `sampled_at_ms` 가 단조
증가하고 기록된 표본은 절대 수정되지 않으므로 병합(읽기-수정-쓰기)이 필요 없다.

**누적값을 그대로 적재하고 델타는 읽을 때 계산한다** (#1105). ka10051 은 당일 누적을
준다. 누적 저장이면 표본 결손이 **해상도 손실이지 정합성 손상이 아니다** — 다음 표본이
전체 누적을 다시 들고 온다. 델타 저장이면 모든 구멍이 영구 오차가 된다.

**경로에 벤더명을 넣지 않는다.** `kis-program-trade/` 가 소스를 키움으로 옮기고도
동결 식별자로 남은 전례(`program_trade_store.py` 모듈 docstring)를 피한다. 벤더는
본문 `source` 에 적어 옮길 수 있게 둔다.

**단위는 필드가 아니라 요청 파라미터가 정한다** (#1117). `amt_qty_tp="0"` = 금액(억원),
`"1"` = 수량(천주) — TR 마다 코드표가 달라(ka10064 는 1=금액/백만원) 응답만 봐서는
알 수 없다. 그래서 줄마다 `request` 를 통째로 남긴다: 나중에 해석이 갈려도 그 줄이
무엇을 요청해 받은 값인지 증빙이 된다(장중 표본은 소급 백필이 불가능하다).

**잠정/확정은 저장하지 않고 파생한다** (#1115). 확정 파일(`daily/<날짜>.json`)이 있으면
확정, 없으면 잠정 — 상태를 두 곳에 적지 않는다. **최종성도 마찬가지로 파생이다**:
당일에 쓴 확정본은 벤더 최종값이 아니라(실측은 `investor_flow_confirm` 모듈 docstring)
다음 거래일 런이 덮어쓰는데, 그 판정은 본문 `confirmed_at_ms` 에서 나온다
(`investor_flow_confirm.is_final`) — 여기에 플래그를 새로 두지 않는다.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)

# 두 파일의 스키마 버전은 **각각** 둔다. 전역 하나로 묶으면 의미가 안 바뀐 쪽까지
# 무효화된다 — `past_indicators_cache` 가 v5→v6 에서 7종을 날려 `/study` 첫 로드를
# 수십 분으로 만든 뒤 KIND_VERSIONS 로 쪼갠 교훈.
INTRADAY_SCHEMA_VERSION = 1
DAILY_SCHEMA_VERSION = 1

SOURCE = "kiwoom:ka10051"

# 폴 주기의 몇 배까지 벌어져야 "수집 공백" 으로 볼 것인가. 절대 시간이 아니라
# **주기 상대** 임계인 이유: 주기를 바꿔도 판정이 따라오고, 정상 지터를 갭으로 안 센다.
# `program_trade_store.GAP_MIN_JUMP_INTERVALS` 와 같은 문법 — 그리고 같은 이유로
# **쓰기·읽기 경로가 이 술어를 공유**해야 임계를 조였을 때 과거 오염이 소급 정리된다.
#
# ⚠ `disk_state.analyze_gaps` 를 쓰지 않는다: 1분 이상을 갭으로 보고 마감 동시호가
# 창을 제외하는 **호가 스냅샷 도메인 전용** 의미론이라, 분 단위 표본에는 매 간격이
# 갭으로 찍힌다(#1115).
GAP_MIN_JUMP_INTERVALS = 3


class IntradaySample(BaseModel):
    """벤더 응답 하나. `rows` 는 ka10051 의 `inds_netprps` 원본 행을 그대로 담는다.

    행을 파싱하지 않고 보관하는 이유: 단위·필드 해석이 바뀌어도 원본이 남아 있으면
    다시 읽을 수 있지만, 파싱해서 버리면 소급 복구가 불가능하다(장중 표본은
    `base_dt` 스냅샷이라 과거 '시각' 을 다시 부를 수 없다).
    """

    sampled_at_ms: int
    source: str = SOURCE
    request: dict[str, str]
    rows: list[dict[str, Any]]


class IntradayCoverage(BaseModel):
    """표본 커버리지 — 화면이 "09:00–14:21 · 표본 42/78" 을 말하기 위한 것.

    수집이 죽으면 차트는 **짧은 선을 사실처럼** 그린다(ADR-0064 폴러 침묵사망).
    그래서 완결성은 데이터와 동급의 1급 시민이고, 없으면 만들어야 한다.
    """

    first_sample_ms: int | None = None
    last_sample_ms: int | None = None
    sample_count: int = 0
    expected_count: int | None = None
    gap_ranges: list[dict[str, int]] = Field(default_factory=list)


class DailyConfirmedFile(BaseModel):
    """마감 후 `base_dt` 재조회로 확정한 그날의 값.

    이 파일의 **존재는 "표시상 확정"** 이다(화면 배지 · 일별 이력의 원천). 그것이
    **최종값이라는 뜻은 아니다** — 당일에 쓴 확정본을 벤더는 그 뒤에도 고친다.
    다시 물어야 하는지는 `investor_flow_confirm.is_final()` 이 `confirmed_at_ms` 로
    판정하므로, **이 값은 감사 로그가 아니라 계약의 일부**다. 재확정이 덮어쓸 때
    함께 갱신되어야 하며, 그렇지 않으면 재확정이 매일 반복된다.
    """

    schema_version: int = DAILY_SCHEMA_VERSION
    source: str = SOURCE
    date: str
    confirmed_at_ms: int
    request: dict[str, str]
    rows: list[dict[str, Any]]


class InvestorFlowStore:
    """`<data_dir>/investor-flow/` 아래 장중 표본(JSONL)과 확정본(JSON)을 관리한다."""

    def __init__(self, data_dir: Path) -> None:
        self._root = Path(data_dir) / "investor-flow"
        # (date, key) → 마지막으로 append 한 표본. `last_sample` 의 메모리 경로다.
        #
        # **왜 필요한가.** `last_sample` 은 "직전 표본 1개" 를 얻으려고
        # `load_samples`(하루치 JSONL 전체 pydantic 파싱)를 불렀다. 이 파일은 하루
        # 종일 자라는 append 로그라(실측 2026-08-21: investor 16.7MB·1,279표본,
        # deriv 8.1MB·4,239표본) 파싱 비용이 장중 내내 선형으로 커지고, 수집기가
        # 이것을 **이벤트 루프 위에서 매 30초 × 시장/상품 수만큼** 반복했다 —
        # `hoga_perf loop_stall` 스택 상위 단골이었다(최대 2.7s).
        #
        # 이 store 는 해당 파일의 **유일한 writer** 다(수집기가 프로세스당 1개, 같은
        # 인스턴스를 계속 쥔다). 그래서 append 시점에 갱신하는 이 dict 가 곧 진실이고,
        # 디스크 폴백은 프로세스 재시작 후 키당 1회만 발생한다. 항목 수는 날짜×키라
        # 하루 한 자릿수지만, 날짜가 바뀌면 옛 날짜 항목을 지워 영구 프로세스에서도
        # 자라지 않게 한다(append_sample 의 청소).
        self._last_cache: dict[tuple[str, str], IntradaySample] = {}

    def intraday_path(self, date: str) -> Path:
        return self._root / "intraday" / f"{date}.jsonl"

    def daily_path(self, date: str) -> Path:
        return self._root / "daily" / f"{date}.json"

    # ── 장중 표본 (추가 전용) ──────────────────────────────────────────────

    def append_sample(self, date: str, sample: IntradaySample) -> None:
        """표본 한 줄을 덧붙인다. 원자적 교체가 아니라 **append** 인 이유는 이 파일이
        누적 로그이고 기존 줄을 절대 건드리지 않기 때문이다(교체하면 매번 하루치를
        재직렬화한다)."""
        path = self.intraday_path(date)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(sample.model_dump(), ensure_ascii=False, separators=(",", ":"))
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        # 캐시 갱신 + 날짜 롤오버 청소(__init__ docstring). 쓰기 **뒤**에 갱신한다 —
        # 앞이면 디스크에 없는 표본이 "직전" 행세를 해 중복 억제가 오판한다.
        self._last_cache = {k: v for k, v in self._last_cache.items() if k[0] == date}
        self._last_cache[(date, str(sample.request.get("mrkt_tp")))] = sample

    def load_samples(self, date: str) -> list[IntradaySample]:
        """그날 표본 전부. **개행으로 끝나지 않은 마지막 줄은 버린다** — append 중
        크래시하면 반쪽 줄이 남는데, 그것을 파싱하려 들면 하루치가 통째로 죽는다
        (히트맵 그룹플로우 테일 리더와 같은 불변식)."""
        path = self.intraday_path(date)
        if not path.exists():
            return []
        raw = path.read_text(encoding="utf-8")
        lines = raw.split("\n")
        if raw and not raw.endswith("\n"):
            lines = lines[:-1]  # 미완 꼬리 폐기
        out: list[IntradaySample] = []
        for ln in lines:
            if not ln.strip():
                continue
            try:
                out.append(IntradaySample.model_validate_json(ln))
            except ValidationError:
                # 한 줄이 깨져도 나머지는 유효하다 — 로그만 남기고 계속.
                log.warning("investor-flow: 손상된 표본 줄 무시 date=%s", date)
        return out

    def last_sample(self, date: str, request_key: str) -> IntradaySample | None:
        """같은 요청(시장)의 직전 표본. 중복 쓰기 회피(#1099)의 비교 대상."""
        hit = self._last_cache.get((date, request_key))
        if hit is not None:
            return hit
        # 미스 = 프로세스 재시작 후 첫 조회. 키당 1회만 디스크를 읽고 캐시를 채운다.
        for s in reversed(self.load_samples(date)):
            if s.request.get("mrkt_tp") == request_key:
                self._last_cache[(date, request_key)] = s
                return s
        return None

    # ── 확정본 ────────────────────────────────────────────────────────────

    def is_confirmed(self, date: str) -> bool:
        """**화면용** 술어 — 잠정 플래그를 따로 저장하지 않고 파일 존재로 판정한다.

        ⚠ **배치의 스킵 판정에 쓰지 말 것.** "확정본이 있다" 와 "다시 물 필요가 없다"
        는 다른 질문이고, 후자는 `investor_flow_confirm.is_final()` 이다. 둘을 겹치면
        당일에 쓴 비최종 값이 영구히 굳는다 — 그게 이 분리를 만든 사고다.
        """
        return self.daily_path(date).exists()

    def write_confirmed(self, day: DailyConfirmedFile) -> None:
        path = self.daily_path(day.date)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, day.model_dump())

    def load_confirmed(self, date: str) -> DailyConfirmedFile | None:
        path = self.daily_path(date)
        if not path.exists():
            return None
        try:
            return DailyConfirmedFile.model_validate_json(path.read_text(encoding="utf-8"))
        except ValidationError:
            log.warning("investor-flow: 확정본 스키마 불일치 date=%s", date)
            return None


def rows_equal(a: IntradaySample | None, b_rows: list[dict[str, Any]]) -> bool:
    """직전 표본과 값이 같은가 — 같으면 쓰지 않는다(#1099).

    주기를 촘촘히 두어 **놓침을 줄이면서** 저장량은 실제 변화 횟수로 묶는 것이 목적이다.

    ⚠ **이 억제는 생각보다 훨씬 덜 걸린다.** 비교 대상이 종합 3주체가 아니라 응답
    **전체 행**(업종 28~33개 포함)이라, 업종 하나만 움직여도 새 표본이 된다.
    2026-08-10 실측 스킵률: 코스피 41/103 · 코스닥 9/103 · 파생 0/89. 즉 저장량은
    "실제 변화 횟수" 가 아니라 사실상 **폴 횟수**를 따라간다 — 주기를 조일 때 디스크
    비용을 그 가정으로 계산할 것.
    """
    if a is None:
        return False
    return a.rows == b_rows


def compute_coverage(
    samples: list[IntradaySample], *, poll_interval_ms: int
) -> IntradayCoverage:
    """표본 목록 → 커버리지. 갭은 **주기 상대 임계**로 판정한다.

    재시작 공백이 선행 갭으로 드러나야 하지만(#1105 — 표시만 가능, 메울 수 없음),
    세션 개장 앵커는 호출부가 `expected_count` 와 함께 넘기는 편이 낫다: 이 함수는
    표본만 보고 판단하는 순수 함수로 둔다.
    """
    if not samples:
        return IntradayCoverage()
    ts = sorted(s.sampled_at_ms for s in samples)
    threshold = poll_interval_ms * GAP_MIN_JUMP_INTERVALS
    gaps: list[dict[str, int]] = []
    for prev, cur in zip(ts, ts[1:], strict=False):
        if cur - prev > threshold:
            gaps.append({"start_ms": prev, "end_ms": cur})
    return IntradayCoverage(
        first_sample_ms=ts[0],
        last_sample_ms=ts[-1],
        sample_count=len(ts),
        gap_ranges=gaps,
    )
